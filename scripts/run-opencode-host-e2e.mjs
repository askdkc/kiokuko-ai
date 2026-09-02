import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, lstat, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
    const child = spawn(command, args, { ...options, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
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
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kiokuko-host-contract', version: '1' },
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
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    KIOKUKO_DATABASE: path.join(data, 'kiokuko-ai.sqlite'),
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
  await requireSuccess(process.execPath, [cliScript, 'setup', '--skill-discovery', 'off', '--enno-oduno', 'off', '--json'], { cwd: project, env: environment, timeoutMs: 120_000, label: 'setup' });
  const configPath = path.join(config, 'opencode', 'opencode.json');
  const openCodeConfig = parseJson(await readFile(configPath, 'utf8'), 'opencode_config');
  const pluginIndex = openCodeConfig.plugin.findIndex((entry) => Array.isArray(entry) && String(entry[0]).startsWith('kiokuko-ai@'));
  if (pluginIndex < 0) throw new Error('managed OpenCode plugin entry is missing');
  await access(path.join(config, 'opencode', 'AGENTS.md'));
  await access(path.join(config, 'opencode', 'skills', 'kiokuko-soul', 'SKILL.md'));
  openCodeConfig.plugin[pluginIndex] = [pathToFileURL(path.join(installedRoot, 'dist', 'opencode', 'plugin.js')).href, openCodeConfig.plugin[pluginIndex][1]];
  await writeFile(configPath, `${JSON.stringify(openCodeConfig, null, 2)}\n`);
  const fixture = await startFakeOpenAiServer();
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
    const hook = await requireSuccess(process.execPath, [cliScript, 'enno', 'hook', '--client', 'opencode', '--input-json', '-'], {
      cwd: project, env: environment, input: `${JSON.stringify({ protocolVersion: 1, packageVersion: packageJson.version, sessionId: 'fixture-session', terminalMessageId: 'fixture-terminal', cwd: project })}\n`, timeoutMs: 45_000, label: 'hook',
    });
    const hookResponse = parseJson(hook.stdout.toString('utf8'), 'hook_output');
    if (hookResponse.disposition !== 'stop' || hookResponse.code !== 'no_active_run') throw new Error(`hook_stop_contract:${String(hookResponse.disposition)}:${String(hookResponse.code)}`);
    const run = await requireSuccess(opencode, ['run', '--attach', server.url, '--dir', project, '--model', 'fixture/fixture-model', 'Return the fixture completion.'], { cwd: project, env: environment, timeoutMs: 120_000, label: 'opencode_run' });
    if (run.code !== 0) throw new Error('OpenCode fixture run failed');
    if (fixture.stats.chatCompletions < 1) throw new Error('fixture provider was not called');
    if (fixture.stats.taskPrepareResponses < 1) throw new Error('fixture provider did not exercise task_prepare');
    process.stdout.write(`${JSON.stringify({ protocolVersion: 1, status: 'passed', opencodeVersion: health.version, mcp: 'connected', toolCatalog: toolNames.length, hook: hookResponse.code, fixtureRequests: fixture.stats.chatCompletions, taskPrepareResponses: fixture.stats.taskPrepareResponses, fixtureDigests: fixture.stats.requestDigests.map((value) => value.slice(0, 16)) })}\n`);
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
