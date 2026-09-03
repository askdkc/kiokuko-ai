import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, lstat, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { startFakeOpenAiServer } from '../tests/e2e/fake-openai-server.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const maxOutputBytes = 96 * 1024;
const timeoutMs = 180_000;

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function quoteWindowsCommandArg(value) {
  if (!/[\s"&|<>^]/u.test(value)) return value;
  const escaped = value
    .replace(/(\\*)"/gu, '$1$1\\"')
    .replace(/(\\+)$/u, '$1$1');
  return `"${escaped}"`;
}

function spawnCommand(command, args, options) {
  if (process.platform !== 'win32' || !command.toLowerCase().endsWith('.cmd')) {
    return spawn(command, args, { ...options, shell: false });
  }
  // Node cannot launch .cmd files with shell:false on Windows (it reports
  // EINVAL). Keep shell parsing limited to this fixed npm command and quote
  // every generated argument so paths with spaces remain one argument.
  const commandLine = [command, ...args].map(quoteWindowsCommandArg).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label}_invalid`);
  }
}

function append(current, chunk) {
  if (current.byteLength >= maxOutputBytes) return current;
  return Buffer.concat([current, Buffer.from(chunk).subarray(0, maxOutputBytes - current.byteLength)]);
}

function execute(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawnCommand(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, options.timeoutMs ?? timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, stdout, stderr, spawnCode: error?.code ?? 'spawn_failed' });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr, spawnCode: null });
    });
  });
}

async function requireSuccess(command, args, options = {}) {
  const { label, ...executionOptions } = options;
  const result = await execute(command, args, executionOptions);
  if (result.code !== 0) {
    const failure = result.timedOut ? 'timeout' : result.spawnCode ?? result.code ?? result.signal ?? 'failed';
    throw new Error(`host command failed:${label ?? path.basename(command)}:${failure}:${digest(result.stderr)}`);
  }
  return result;
}

async function waitFor(predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label}_timeout`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function installedPackagePath(prefix) {
  const candidates = process.platform === 'win32'
    ? [path.join(prefix, 'node_modules', 'kiokuko-ai')]
    : [path.join(prefix, 'lib', 'node_modules', 'kiokuko-ai'), path.join(prefix, 'node_modules', 'kiokuko-ai')];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      // Try the platform's alternate npm prefix layout.
    }
  }
  throw new Error('installed package is missing');
}

async function resolveOpenCodeBinary(value) {
  if (!path.isAbsolute(value)) throw new Error('OPENCODE_BIN must be an absolute path');
  const status = await lstat(value).catch(() => undefined);
  if (status?.isFile()) return value;
  if (!status?.isDirectory()) throw new Error('OPENCODE_BIN does not exist');
  const expected = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const queue = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.name === expected) return target;
    }
  }
  throw new Error('OPENCODE_BIN directory has no OpenCode executable');
}

async function startOpenCode(command, environment, cwd) {
  const child = spawn(command, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let settled = false;
  const startup = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('opencode serve startup timeout')), 60_000);
    const inspect = (chunk) => {
      stdout = append(stdout, chunk);
      const match = Buffer.concat([stdout, stderr]).toString('utf8').match(/http:\/\/127\.0\.0\.1:(\d+)/u);
      if (!settled && match !== null) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); inspect(Buffer.alloc(0)); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve spawn failed:${error?.code ?? 'spawn_failed'}`));
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve exited:${code ?? 'signal'}`));
    });
  });
  const port = await startup;
  return {
    child,
    url: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

async function jsonRequest(baseURL, pathname) {
  const response = await fetch(`${baseURL}${pathname}`);
  if (!response.ok) throw new Error(`OpenCode API request failed:${response.status}`);
  return response.json();
}

async function mcpTools(cliScript, environment, cwd) {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opencode', version: 'host-e2e' },
    } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ].join('\n') + '\n';
  const child = spawn(process.execPath, [cliScript, 'mcp'], { cwd, env: environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let result;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP tools/list timeout')), 45_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.id === 2) {
            result = value;
            clearTimeout(timer);
            resolve(value);
            child.kill('SIGTERM');
          }
        } catch {
          // The bounded probe ignores non-JSON diagnostic lines.
        }
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`MCP spawn failed:${error?.code ?? 'spawn_failed'}`)); });
  });
  child.stdin.end(input);
  await response;
  if (result?.error !== undefined) throw new Error('MCP tools/list returned an error');
  return result?.result?.tools ?? [];
}

async function mcpToolCall(cliScript, environment, cwd, name, argumentsValue) {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opencode', version: 'host-e2e' },
    } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: argumentsValue } }),
  ].join('\n') + '\n';
  const child = spawn(process.execPath, [cliScript, 'mcp'], { cwd, env: environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let result;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP ${name} timeout`)), 45_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.id === 2) {
            result = value;
            clearTimeout(timer);
            resolve(value);
            child.kill('SIGTERM');
          }
        } catch {
          // The bounded call ignores non-JSON diagnostic lines.
        }
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`MCP spawn failed:${error?.code ?? 'spawn_failed'}`)); });
  });
  child.stdin.end(input);
  await response;
  if (result?.error !== undefined || result?.result?.isError === true) {
    throw new Error(`MCP ${name} returned an error`);
  }
  return result?.result?.structuredContent ?? result?.result;
}

async function main() {
  const opencodeValue = process.env.OPENCODE_BIN;
  if (typeof opencodeValue !== 'string') throw new Error('OPENCODE_BIN must be set');
  const opencode = await resolveOpenCodeBinary(opencodeValue);
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-opencode-host-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const prefix = path.join(root, 'prefix');
  const project = path.join(root, 'project with spaces', '日本語');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true }), mkdir(prefix, { recursive: true }), mkdir(project, { recursive: true })]);
  const projectRoot = await realpath(project);
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    KIOKUKO_DATA_DIR: data,
    KIOKUKO_SKILL_DISCOVERY: 'off',
    NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  await requireSuccess('git', ['init', '-q'], { cwd: project, env: environment, timeoutMs: 20_000, label: 'git_init' });
  await requireSuccess(npmExecutable(), ['pack', '--pack-destination', root], { cwd: repositoryRoot, env: environment, timeoutMs: 120_000, label: 'npm_pack' });
  const tarballName = (await readdir(root)).find((entry) => entry.endsWith('.tgz'));
  if (tarballName === undefined) throw new Error('packed tarball is missing');
  const tarball = path.join(root, tarballName);
  await requireSuccess(npmExecutable(), ['install', '--global', '--prefix', prefix, tarball, '--omit=optional', '--ignore-scripts'], { cwd: project, env: environment, timeoutMs: 180_000, label: 'npm_install' });
  const installedRoot = await installedPackagePath(prefix);
  const cliScript = path.join(installedRoot, 'dist', 'bin', 'kiokuko.js');
  const installedPackage = path.join(installedRoot, 'package.json');
  const packageJson = parseJson(await readFile(installedPackage, 'utf8'), 'installed_package');
  if (packageJson.name !== 'kiokuko-ai') throw new Error('installed package identity mismatch');
  await requireSuccess(process.execPath, [cliScript, 'setup', '--skill-discovery', 'off', '--enno-oduno', 'on', '--json'], { cwd: project, env: environment, timeoutMs: 120_000, label: 'setup' });
  const configPath = path.join(config, 'opencode', 'opencode.json');
  const openCodeConfig = parseJson(await readFile(configPath, 'utf8'), 'opencode_config');
  const pluginIndex = openCodeConfig.plugin.findIndex((entry) => Array.isArray(entry) && String(entry[0]).startsWith('kiokuko-ai@'));
  if (pluginIndex < 0) throw new Error('managed OpenCode plugin entry is missing');
  await access(path.join(config, 'opencode', 'AGENTS.md'));
  await access(path.join(config, 'opencode', 'skills', 'kiokuko-soul', 'SKILL.md'));
  openCodeConfig.plugin[pluginIndex] = [pathToFileURL(path.join(installedRoot, 'dist', 'opencode', 'plugin.js')).href, openCodeConfig.plugin[pluginIndex][1]];
  await writeFile(configPath, `${JSON.stringify(openCodeConfig, null, 2)}\n`);
  let continuationHandler = async () => undefined;
  let continuationFinished = Promise.resolve();
  const fixture = await startFakeOpenAiServer({
    emitTaskPrepare: false,
    onContinuation: (payload) => {
      continuationFinished = Promise.resolve().then(() => continuationHandler(payload));
      return continuationFinished;
    },
  });
  const projectConfig = {
    '$schema': 'https://opencode.ai/config.json',
    model: 'fixture/fixture-model',
    provider: { fixture: {
      npm: '@ai-sdk/openai-compatible', name: 'Kiokuko fixture',
      options: { baseURL: fixture.baseURL, apiKey: 'fixture-key' },
      models: { 'fixture-model': { name: 'Kiokuko fixture' } },
  } },
  };
  await writeFile(path.join(project, 'opencode.json'), `${JSON.stringify(projectConfig, null, 2)}\n`);
  const server = await startOpenCode(opencode, environment, project);
  try {
    const health = await jsonRequest(server.url, '/global/health');
    if (health.healthy !== true || typeof health.version !== 'string') throw new Error('OpenCode health contract failed');
    const mcp = await jsonRequest(server.url, '/mcp');
    if (mcp.kiokuko?.status !== 'connected') throw new Error('OpenCode Kiokuko MCP is not connected');
    const tools = await mcpTools(cliScript, environment, project);
    const toolNames = tools.map((tool) => tool.name).filter((name) => typeof name === 'string');
    if (!toolNames.includes('task_prepare')) throw new Error('Kiokuko task_prepare is missing from MCP tool catalog');
    const hook = await requireSuccess(process.execPath, [cliScript, 'enno', 'hook', '--input-json', '-'], {
      cwd: project, env: environment, input: `${JSON.stringify({ protocolVersion: 1, packageVersion: packageJson.version, sessionId: 'fixture-session', terminalMessageId: 'fixture-terminal', cwd: project })}\n`, timeoutMs: 45_000, label: 'hook',
    });
    const hookResponse = parseJson(hook.stdout.toString('utf8'), 'hook_output');
    if (hookResponse.disposition !== 'stop' || hookResponse.code !== 'no_active_run') throw new Error(`hook_stop_contract:${String(hookResponse.disposition)}:${String(hookResponse.code)}`);

    const capabilities = [
      'kiokuko-soul',
      'kiokuko-simple-work',
      'kiokuko-single-purpose-functions',
      'kiokuko-ui-design-soul',
      'memory-reasoning',
      'kiokuko-enno-oduno',
    ].map((name) => ({ kind: 'skill', name }));
    capabilities.push(...toolNames.map((name) => ({ kind: 'mcp_tool', name })));
    const taskPrepare = await mcpToolCall(cliScript, environment, project, 'task_prepare', {
      soulRead: true,
      requestId: 'host-active-continuation',
      task: 'Run the deterministic OpenCode host continuation contract check.',
      cwd: project,
      profileHints: { taskType: 'build', target: 'host continuation', expected: 'one continuation receipt' },
      capabilities,
      client: { kind: 'opencode', version: health.version },
      maxContextChars: 12_000,
    });
    if (taskPrepare?.ennoOduno?.status !== 'oduno_ideal') throw new Error('active Enno preparation did not reach ideal phase');
    const identity = {
      runId: taskPrepare.run?.runId,
      workspace: taskPrepare.project?.workspace,
      orchestrationId: taskPrepare.intake?.sessionId,
    };
    if (Object.values(identity).some((value) => typeof value !== 'string')) throw new Error('active Enno preparation identity is incomplete');
    const idealTool = toolNames.find((name) => /(?:^|_)enno_ideal_submit$/u.test(name));
    const answerTool = toolNames.find((name) => /(?:^|_)enno_answer$/u.test(name));
    if (idealTool === undefined || answerTool === undefined) throw new Error('required Enno MCP tools are missing');
    const ideal = await mcpToolCall(cliScript, environment, project, idealTool, {
      ...identity,
      expectedRevision: taskPrepare.ennoOduno.contractRevision ?? 1,
      idempotencyKey: 'host-active-ideal',
      ideal: {
        objective: 'Run the deterministic OpenCode host continuation contract check',
        principles: ['Use only existing public MCP operations'],
        skillContributions: [],
        successSignals: ['One continuation request and one durable receipt'],
      },
    });
    if (ideal?.ennoOduno?.status !== 'zenki_planning') throw new Error('active Enno preparation did not reach planning phase');
    continuationHandler = async (payload) => {
      const directive = payload?.directive;
      if (typeof payload?.resumeToken !== 'string' || typeof directive?.runId !== 'string' || typeof directive?.contractRevision !== 'number') {
        throw new Error('continuation payload identity is incomplete');
      }
      const cancelled = await mcpToolCall(cliScript, environment, project, answerTool, {
        runId: directive.runId,
        resumeToken: payload.resumeToken,
        expectedRevision: directive.contractRevision,
        idempotencyKey: 'host-continuation-cancel',
        action: 'cancel',
      });
      if (cancelled?.ennoOduno?.status !== 'cancelled') throw new Error('active Enno continuation did not terminate the fixture run');
    };
    const run = await requireSuccess(opencode, ['run', '--attach', server.url, '--dir', project, '--model', 'fixture/fixture-model', 'Return the fixture completion.'], { cwd: project, env: environment, timeoutMs: 120_000, label: 'opencode_run' });
    if (run.code !== 0) throw new Error('OpenCode fixture run failed');
    if (fixture.stats.chatCompletions < 1) throw new Error('fixture provider was not called');
    await waitFor(() => fixture.stats.continuationRequests >= 1, 'active_continuation');
    await continuationFinished;
    if (fixture.stats.continuationRequests !== 1) {
      throw new Error(`active continuation request count mismatch:${fixture.stats.continuationRequests}`);
    }
    const { openConnection } = await import('../dist/db/connection.js');
    const database = openConnection(path.join(data, 'kiokuko-ai.sqlite'), { readOnly: true });
    try {
      const activeRun = database.prepare(`
        SELECT run_id AS runId, status
        FROM enno_contracts
        WHERE repository_root = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(projectRoot);
      if (activeRun?.runId === undefined) throw new Error('active Enno run was not created');
      if (activeRun.status !== 'cancelled') throw new Error(`active Enno run was not terminated:${String(activeRun.status)}`);
      const receiptCount = Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM enno_opencode_continuation_receipts
        WHERE run_id = ?
      `).get(activeRun.runId)?.count ?? 0);
      if (receiptCount !== 1) throw new Error(`durable continuation receipt count mismatch:${receiptCount}`);
    } finally {
      database.close();
    }
    process.stdout.write(`${JSON.stringify({ protocolVersion: 1, status: 'passed', opencodeVersion: health.version, mcp: 'connected', toolCatalog: toolNames.length, hook: hookResponse.code, fixtureRequests: fixture.stats.chatCompletions, taskPrepareResponses: fixture.stats.taskPrepareResponses, preparedEnnoStatus: ideal.ennoOduno.status, continuationRequests: fixture.stats.continuationRequests, durableReceipts: 1, fixtureDigests: fixture.stats.requestDigests.map((value) => value.slice(0, 16)) })}\n`);
  } finally {
    await server.close();
    await fixture.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ protocolVersion: 1, status: 'failed', reason: error instanceof Error ? error.message : 'host_contract_failed' })}\n`);
  process.exitCode = 1;
}
