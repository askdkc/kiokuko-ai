import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { startFakeOpenAiServer } from '../tests/e2e/fake-openai-server.mjs';
import { requireSuccess, resolveOpenCodeBinary } from './run-opencode-host-e2e.mjs';

const executable = process.env.KIOKUKO_TEST_AGENTICREPLAY;
if (!executable || !path.isAbsolute(executable)) throw new Error('KIOKUKO_TEST_AGENTICREPLAY must be an absolute AgenticReplay executable path');
if (!process.env.OPENCODE_BIN) throw new Error('OPENCODE_BIN must be set');
const opencode = await resolveOpenCodeBinary(process.env.OPENCODE_BIN);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-v2-agenticreplay-')));
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
if (!/\bv?2\.0\.18\b/u.test(version.stdout.toString('utf8'))) throw new Error('OpenCode 2.0.18 is required');
const fixture = await startFakeOpenAiServer({ emitTaskPrepare: false });
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
  const cli = path.resolve(import.meta.dirname, '../dist/bin/kiokuko.js');
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
  if (exit !== 0) throw new Error(`record failed:${exit}:${output.slice(-1500)}`);
  if (fixture.stats.chatCompletions < 1) throw new Error('AgenticReplay-wrapped OpenCode did not reach the provider fixture');
  const runs = path.join(project, '.agenticreplay', 'runs');
  const ids = (await readdir(runs)).filter(value => /^run_[0-9a-f]+$/u.test(value));
  if (ids.length !== 1) throw new Error(`expected one AgenticReplay run, found ${ids.length}`);
  const run = path.join(runs, ids[0]);
  const manifest = JSON.parse(await readFile(path.join(run, 'manifest.json'), 'utf8'));
  const events = (await readFile(path.join(run, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const requests = events.filter(event => event.type === 'model.request');
  const responses = events.filter(event => event.type === 'model.response' && Number(event.attrs?.status) === 200);
  const { openConnection } = await import('../dist/db/connection.js');
  const { readTraceCursor } = await import('../dist/trace/ingest.js');
  const database = openConnection(path.join(data, 'kiokuko-ai.sqlite'), { readOnly: true });
  let cursor;
  try { cursor = readTraceCursor(database, runs, ids[0]); }
  finally { database.close(); }
  if (!manifest.ended_at || requests.length < 1 || responses.length !== requests.length
    || cursor?.finalization !== 'finalized' || cursor.integrity !== 'verified') {
    throw new Error(`OpenCode provider exchange was not sealed in the trace: ${JSON.stringify({
      sealed: Boolean(manifest.ended_at), requests: requests.length, responses: responses.length,
      finalization: cursor?.finalization, integrity: cursor?.integrity,
    })}`);
  }
  process.stdout.write(`${JSON.stringify({ status: 'passed', opencode: '2.0.18', providerRequests: fixture.stats.chatCompletions,
    traceEvents: events.length, sealed: true })}\n`);
} finally {
  await fixture.close();
}
