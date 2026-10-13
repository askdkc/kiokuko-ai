import { completeVerification } from './verification-completion.mjs';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { startPackedRegistry } from './lib/packed-registry.mjs';
import { startFakeOpenAiServer } from '../tests/e2e/fake-openai-server.mjs';
import { requireSuccess, resolveOpenCodeBinary } from './run-opencode-host-e2e.mjs';

const executable = process.env.KIOKUKO_TEST_AGENTICREPLAY;
if (!executable || !path.isAbsolute(executable)) throw new Error('KIOKUKO_TEST_AGENTICREPLAY must be an absolute AgenticReplay executable path');
if (!process.env.OPENCODE_BIN) throw new Error('OPENCODE_BIN must be set');
const opencode = await resolveOpenCodeBinary(process.env.OPENCODE_BIN);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-agenticreplay-')));
const project = path.join(root, 'project');
const bin = path.join(root, 'bin');
const home = path.join(root, 'home');
const config = path.join(root, 'config');
const data = path.join(root, 'data');
await Promise.all([project, bin, home, config, data].map(directory => mkdir(directory, { recursive: true })));
await mkdir(path.join(config, 'opencode'), { recursive: true });
await symlink(opencode, path.join(bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode'));
const environment = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data,
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
  KIOKUKO_DATA_DIR: data, OPENCODE_CONFIG_CONTENT: '{}',
  OPENCODE_CONFIG_DIR: path.join(config, 'opencode'),
  OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  PATH: `${bin}${path.delimiter}${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ''}`,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};
// AgenticReplay owns a run-local OpenCode 2 plugin overlay. An explicit config
// override is unsupported upstream; the fixture uses normal config discovery.
delete environment.OPENCODE_CONFIG;
await requireSuccess('git', ['init', '-q'], { cwd: project, env: environment, label: 'git_init' });
const version = await requireSuccess(opencode, ['--version'], { cwd: project, env: environment, label: 'opencode_version' });
const observedVersion = version.stdout.toString('utf8').trim();
let registry;
let issued = false;
let prepareSucceeded = false;
const fixture = await startFakeOpenAiServer({ emitTaskPrepare: false, failFirstStream: true, respond(body) {
  const tools = body.tools ?? [];
  if (!issued) {
    const execute = tools.find(tool => (tool.function?.name ?? tool.name) === 'execute');
    if (!execute) throw new Error(`OpenCode execute capability is unavailable: ${JSON.stringify(tools.map(tool => tool.function ?? tool))}`);
    issued = true;
    const input = { soulRead: true, requestId: 'wrapped-fixture', task: 'Verify the wrapped MCP connection',
      profileHints: { taskType: 'research', target: 'fixture', expected: 'MCP preparation succeeds' },
      capabilities: [{kind:'skill',name:'kiokuko-soul'}, {kind:'skill',name:'kiokuko-enno-oduno'},
        ...tools.map(tool => ({kind:'mcp_tool',name:tool.function?.name ?? tool.name}))] };
    return { toolCalls: [{ id: 'wrapped-prepare', type: 'function', function: { name: 'execute',
      arguments: JSON.stringify({ code: `const result = await tools.kiokuko.task_prepare(${JSON.stringify(input)}); console.log(JSON.stringify(result));` }) } }] };
  }
  const results = (body.messages ?? []).filter(message => message.role === 'tool');
  prepareSucceeded ||= results.some(message => /runId/.test(JSON.stringify(message.content)) && !/UNSUPPORTED_CLIENT/.test(JSON.stringify(message.content)));
  return { text: 'fixture complete' };
} });
try {
  const openCodeConfig = {
    '$schema': 'https://opencode.ai/config.json', model: 'fixture/fixture-model',
    providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', name: 'Kiokuko fixture',
      env: ['OPENAI_API_KEY'], settings: { baseURL: '{env:OPENAI_BASE_URL}' },
      models: { 'fixture-model': { name: 'Kiokuko fixture' } } } },
  };
  environment.OPENAI_API_KEY = 'fixture-key';
  environment.OPENAI_BASE_URL = fixture.baseURL;
  environment.AGENTICREPLAY_UPSTREAM_OPENAI = new URL(fixture.baseURL).origin;
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(openCodeConfig);
  await writeFile(path.join(config, 'opencode', 'opencode.jsonc'), `${JSON.stringify(openCodeConfig, null, 2)}\n`);
  await writeFile(path.join(project, 'opencode.json'), `${JSON.stringify(openCodeConfig, null, 2)}\n`);
  const packed = process.env.KIOKUKO_VERIFY_TARBALL ? {stdout: Buffer.from(await readFile(process.env.KIOKUKO_VERIFY_PACK_METADATA, 'utf8'))} : await requireSuccess('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: path.resolve(import.meta.dirname, '..'), label: 'pack', maxOutputBytes: 4 * 1024 * 1024 });
  const tarball = process.env.KIOKUKO_VERIFY_TARBALL ?? path.join(root, JSON.parse(packed.stdout.toString('utf8'))[0].filename);
  registry = await startPackedRegistry(tarball, JSON.parse(await readFile(path.resolve(import.meta.dirname, '../package.json'), 'utf8')));
  environment.NPM_CONFIG_REGISTRY = registry.url;
  environment.npm_config_registry = registry.url;
  const prefix = path.join(root, 'installed');
  await requireSuccess('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--omit=optional', tarball], { env: environment, label: 'install' });
  const installedRoot = path.join(prefix, 'node_modules', 'kiokuko-ai');
  const cli = path.join(installedRoot, 'dist', 'bin', 'kiokuko.js');
  await requireSuccess(process.execPath, [cli, 'setup', '--no-embeddings', '--skill-discovery', 'off', '--json'], { cwd: project, env: environment, label: 'setup' });
  await access(cli);
  const child = spawn(process.execPath, [cli, 'trace', 'record', '--', 'run', '--model', 'fixture/fixture-model', 'Reply with the fixture answer.'], {
    cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8').slice(0, 16_384); });
  child.stderr.on('data', chunk => { output += chunk.toString('utf8').slice(0, 16_384); });
  const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2_000).unref(); }, 120_000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  clearTimeout(timer);
  // AgenticReplay returns 2 for an incomplete capture even when OpenCode exits 0.
  if (exit !== 2) throw new Error(`expected incomplete capture exit 2, received ${exit}:${output.slice(-1500)}`);
  if (!prepareSucceeded) throw new Error(`Wrapped task_prepare did not succeed:${output.slice(-1500)}`);
  if (fixture.stats.chatCompletions < 1) throw new Error('AgenticReplay-wrapped OpenCode did not reach the provider fixture');
  const runs = path.join(project, '.agenticreplay', 'runs');
  const ids = (await readdir(runs)).filter(value => /^run_[0-9a-f]+$/u.test(value) || /^\d{14}-[a-z0-9-]+-[0-9a-f]{6,32}$/u.test(value));
  if (ids.length !== 1) throw new Error(`expected one AgenticReplay run, found ${ids.length}`);
  const run = path.join(runs, ids[0]);
  const manifest = JSON.parse(await readFile(path.join(run, 'manifest.json'), 'utf8'));
  if (manifest.exit_code !== 0 || manifest.capture?.status !== 'incomplete'
    || !manifest.capture.issues.includes('incomplete_transport_body')) {
    throw new Error(`Interrupted recording did not retain the successful child exit: ${JSON.stringify({ exit: manifest.exit_code, capture: manifest.capture })}`);
  }
  const events = (await readFile(path.join(run, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const requests = events.filter(event => event.type === 'model.request');
  const responses = events.filter(event => event.type === 'model.response' && Number(event.attrs?.status) === 200);
  const incomplete = events.find(event => event.type === 'net.response' && event.attrs?.response_complete === false);
  if (!incomplete || incomplete.attrs.transport_outcome !== 'origin_error'
    || incomplete.attrs.bytes <= 0 || !incomplete.attrs.error) {
    throw new Error(`Interrupted response evidence is missing: ${JSON.stringify(events.filter(event => event.type === 'net.response'))}`);
  }
  if (!events.some(event => event.type === 'net.response' && event.seq > incomplete.seq && event.attrs?.response_complete === true)) {
    throw new Error('The same recording did not serve a successful response after interruption');
  }
  const { openConnection } = await import(path.join(installedRoot, 'dist/db/connection.js'));
  const { readTraceCursor } = await import(path.join(installedRoot, 'dist/trace/ingest.js'));
  const database = openConnection(path.join(data, 'kiokuko-ai.sqlite'), { readOnly: true });
  let cursor;
  let preparedRun;
  try {
    cursor = readTraceCursor(database, runs, ids[0]);
    preparedRun = database.prepare('SELECT run_id, client_kind, client_version, source_session_id FROM ledger_runs WHERE title = ?').get('Verify the wrapped MCP connection');
  }
  finally { database.close(); }
  if (!preparedRun || preparedRun.client_kind !== 'opencode'
    || !observedVersion.includes(preparedRun.client_version) || !preparedRun.source_session_id) {
    throw new Error(`Wrapped MCP preparation did not persist its OpenCode identity: ${JSON.stringify(preparedRun)}`);
  }
  if (!manifest.ended_at || requests.length < 1 || responses.length < 1
    || cursor?.finalization !== 'finalized' || cursor.integrity !== 'verified') {
    throw new Error(`OpenCode provider exchange was not sealed in the trace: ${JSON.stringify({
      sealed: Boolean(manifest.ended_at), requests: requests.length, responses: responses.length,
      finalization: cursor?.finalization, integrity: cursor?.integrity,
    })}`);
  }
  process.stdout.write(`${JSON.stringify({ status: 'passed', opencode: observedVersion, root, artifact: JSON.parse(packed.stdout.toString('utf8'))[0].integrity, interruptedBytes: incomplete.attrs.bytes, providerRequests: fixture.stats.chatCompletions,
    mcpPrepared: preparedRun.run_id, childExit: manifest.exit_code, recorderExit: exit, traceEvents: events.length, sealed: true })}\n`);
} finally {
  await fixture.close();
  await registry?.close();
}

completeVerification({});
