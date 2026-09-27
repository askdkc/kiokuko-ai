import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { access, lstat, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { OpenCode } from '@opencode/client';
import { startFakeOpenAiServer } from '../tests/e2e/fake-openai-server.mjs';
import { agentDefinition, buildExecutionCatalog, EXECUTION_ROLES, orchestrationOptionsSchema } from '../dist/execution/catalog.js';
import { probeMcpTools, callMcpTool } from './lib/mcp-probe.mjs';
import { startPackedRegistry } from './lib/packed-registry.mjs';
import { waitForPackedPlugin } from './lib/plugin-readiness.mjs';

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

export async function requireSuccess(command, args, options = {}) {
  const { label, ...executionOptions } = options;
  const result = await execute(command, args, executionOptions);
  if (result.code !== 0) {
    const failure = result.timedOut ? 'timeout' : result.spawnCode ?? result.code ?? result.signal ?? 'failed';
    throw new Error(`host command failed:${label ?? path.basename(command)}:${failure}:${digest(result.stderr)}:${result.stderr.toString('utf8').slice(-500)}`);
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

export async function resolveOpenCodeBinary(value) {
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

export async function startOpenCode(command, environment, cwd) {
  const reservation = createNetServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(command, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let settled = false;
  const startup = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('opencode serve startup timeout')), 60_000);
    const inspect = (chunk) => {
      stdout = append(stdout, chunk);
      const text = Buffer.concat([stdout, stderr]).toString('utf8');
      const match = text.match(/server listening on http:\/\/127\.0\.0\.1:(\d+)/u);
      const password = text.match(/server password ([^\s]+)/u);
      if (!settled && match !== null && password !== null) {
        settled = true;
        clearTimeout(timer);
        resolve({ port: Number(match[1]), password: password[1] });
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
  const ready = await startup;
  return {
    child,
    url: `http://127.0.0.1:${ready.port}`,
    password: ready.password,
    client: OpenCode.make({ baseUrl: `http://127.0.0.1:${ready.port}`, headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${ready.password}`).toString('base64')}`,
    } }),
    diagnostics() { return Buffer.concat([stdout, stderr]).toString('utf8').replace(/server password \S+/gu, 'server password [redacted]').slice(-4000); },
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

async function mcpTools(cliScript, environment, cwd) {
  return probeMcpTools({ cliScript, environment, cwd });
}

async function mcpToolCall(cliScript, environment, cwd, name, argumentsValue) {
  return callMcpTool({ cliScript, environment, cwd }, name, argumentsValue);
}

export async function runHostContract(options = {}) {
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
    OPENCODE_CONFIG: path.join(config, 'opencode/opencode.jsonc'),
    OPENCODE_CONFIG_DIR: path.join(config, 'opencode'),
    OPENCODE_CONFIG_CONTENT: '{}',
    XDG_DATA_HOME: data,
    KIOKUKO_DATA_DIR: data,
    KIOKUKO_SKILL_DISCOVERY: 'off',
    NPM_CONFIG_CACHE: process.env.KIOKUKO_TEST_NPM_CACHE ?? path.join(tmpdir(), 'kiokuko-opencode-npm-cache'),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    KIOKUKO_FIXTURE_API_KEY: 'fixture-key',
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
  const registry = await startPackedRegistry(tarball, packageJson);
  environment.NPM_CONFIG_REGISTRY = registry.url;
  environment.npm_config_registry = registry.url;
  try {
  await requireSuccess(process.execPath, [cliScript, 'setup', '--no-embeddings', '--skill-discovery', 'off', '--enno-oduno', 'on', '--json'], { cwd: project, env: environment, timeoutMs: 120_000, label: 'setup' });
  const configPath = path.join(config, 'opencode', 'opencode.jsonc');
  const openCodeConfig = parseJson(await readFile(configPath, 'utf8'), 'opencode_config');
  const pluginIndex = openCodeConfig.plugins.findIndex((entry) => String(entry.package).startsWith('kiokuko-ai@'));
  if (pluginIndex < 0) throw new Error('managed OpenCode plugin entry is missing');
  await access(path.join(config, 'opencode', 'AGENTS.md'));
  await access(path.join(config, 'opencode', 'skills', 'kiokuko-soul', 'SKILL.md'));
  const hostAgents = Object.fromEntries(EXECUTION_ROLES.map(role => [role, `host-${role}`]));
  for (const role of EXECUTION_ROLES) openCodeConfig.agents[hostAgents[role]] = agentDefinition(role, 'fixture/fixture-model');
  const orchestration = { mode: 'on', customAgents: Object.fromEntries(EXECUTION_ROLES.map(role => [role, [hostAgents[role]]])) };
  openCodeConfig.plugins[pluginIndex].options.orchestration = orchestration;
  await writeFile(configPath, `${JSON.stringify(openCodeConfig, null, 2)}\n`);
  let continuationHandler = async () => undefined;
  let continuationFinished = Promise.resolve();
  let roleAction;
  let roleIssued = false;
  const fixture = await startFakeOpenAiServer({
    emitTaskPrepare: false,
    onContinuation: (payload) => {
      continuationFinished = Promise.resolve().then(() => continuationHandler(payload));
      return continuationFinished;
    },
    respond: async body => {
      if ((body.messages ?? []).some(message => JSON.stringify(message.content ?? '').includes('Return only the structured summary in the requested format'))) {
        return { text: '## Objective\n- Verify the installed Kiokuko OpenCode v2 plugin.\n\n## Work State\n### Active\n- Continue the role execution check.' };
      }
      if (roleAction && !roleIssued && (body.tools ?? []).some(item => (item.function?.name ?? item.name) === 'subagent')) {
        roleIssued = true;
        return { toolCalls: [{ id: 'fixture-subagent-dispatch', type: 'function', function: { name: 'subagent', arguments: JSON.stringify(roleAction) } }] };
      }
      return undefined;
    },
  });
  const projectConfig = {
    '$schema': 'https://opencode.ai/config.json',
    model: 'fixture/fixture-model',
    providers: { fixture: {
      package: '@opencode/ai/providers/openai-compatible', name: 'Kiokuko fixture',
      env: ['KIOKUKO_FIXTURE_API_KEY'], settings: { baseURL: fixture.baseURL },
      models: { 'fixture-model': { name: 'Kiokuko fixture' } },
  } },
  };
  await writeFile(path.join(project, 'opencode.json'), `${JSON.stringify(projectConfig, null, 2)}\n`);
  const server = await startOpenCode(opencode, environment, project);
  try {
    const health = await server.client.server.info();
    if (health.version !== '2.0.18') throw new Error('OpenCode version contract failed');
    const location = { directory: projectRoot };
    const session = await server.client.session.create({ location, model: { providerID: 'fixture', id: 'fixture-model' } });
    // A cold npm cache makes package installation substantially slower on the
    // macOS x64 runner. Keep polling the actual plugin state, not a fixed 20s
    // number of attempts, and fail immediately if the host reports a failure.
    const plugin = await waitForPackedPlugin(server.client, location);
    const agentCatalog = await server.client.agent.list({ location });
    if (plugin?.state.status !== 'active' || plugin.source.type !== 'package'
      || !plugin.source.target.startsWith('kiokuko-ai@')) {
      const configured = await server.client.config.get({ location });
      const sources = configured.map(item => ({ type: item.type, path: item.path, pluginPackages: item.info?.plugins?.map(entry => entry.package) }));
      throw new Error(`packed_plugin_not_active:${plugin?.state.status ?? 'missing'}:source=${JSON.stringify(plugin?.source)}:configured=${JSON.stringify(sources)}:registry=${JSON.stringify(registry.diagnostics())}:${server.diagnostics()}`);
    }
    const mcp = await server.client.mcp.list({ location });
    if (mcp.data.find(item => item.name === 'kiokuko')?.status.status !== 'connected') throw new Error('OpenCode Kiokuko MCP is not connected');
    const doctorRun = await requireSuccess(process.execPath, [cliScript, 'doctor', '--opencode-url', server.url, '--json'], {
      cwd: project, env: { ...environment, OPENCODE_PASSWORD: server.password }, timeoutMs: 45_000, label: 'doctor',
    });
    const doctor = parseJson(doctorRun.stdout.toString('utf8'), 'doctor');
    if (doctor.data?.checks?.openCodeHost?.ok !== true) {
      throw new Error(`doctor_runtime_not_verified:${JSON.stringify(doctor.data?.checks?.openCodeHost)}`);
    }
    const tools = await mcpTools(cliScript, environment, project);
    const toolNames = tools.map((tool) => tool.name).filter((name) => typeof name === 'string');
    if (!toolNames.includes('task_prepare')) throw new Error('Kiokuko task_prepare is missing from MCP tool catalog');
    const hook = await requireSuccess(process.execPath, [cliScript, 'enno', 'hook', '--input-json', '-'], {
      cwd: project, env: environment, input: `${JSON.stringify({ protocolVersion: 1, packageVersion: packageJson.version, sessionId: 'fixture-session', terminalMessageId: 'fixture-terminal', cwd: project })}\n`, timeoutMs: 45_000, label: 'hook',
    });
    const hookResponse = parseJson(hook.stdout.toString('utf8'), 'hook_output');
    if (hookResponse.disposition !== 'stop' || hookResponse.code !== 'no_active_run') throw new Error(`hook_stop_contract:${String(hookResponse.disposition)}:${String(hookResponse.code)}`);

    const ordinarySession = await server.client.session.create({ location, model: { providerID: 'fixture', id: 'fixture-model' } });
    await server.client.session.prompt({ sessionID: ordinarySession.id, text: 'Complete one ordinary fixture request.' });
    await server.client.session.wait({ sessionID: ordinarySession.id });
    const ordinaryContext = await server.client.session.context({ sessionID: ordinarySession.id });
    if (!ordinaryContext.some(item => item.type === 'assistant' && item.time.completed !== undefined)) {
      throw new Error('ordinary_untracked_session_did_not_complete');
    }

    const capabilities = [
      'kiokuko-soul',
      'kiokuko-simple-work',
      'kiokuko-single-purpose-functions',
      'kiokuko-ui-design-soul',
      'memory-reasoning',
      'kiokuko-enno-oduno',
    ].map((name) => ({ kind: 'skill', name }));
    capabilities.push(...toolNames.map((name) => ({ kind: 'mcp_tool', name })));
    let taskPrepare = await mcpToolCall(cliScript, environment, project, 'task_prepare', {
      soulRead: true,
      requestId: 'host-active-continuation',
      executionCatalog: buildExecutionCatalog({
        agents: agentCatalog.data,
        models: (await server.client.model.list({ location })).data,
        providers: (await server.client.provider.list({ location })).data,
        subagentDepth: 2,
      }, orchestrationOptionsSchema.parse(orchestration)),
      task: 'Run the deterministic OpenCode host continuation contract check.',
      cwd: project,
      profileHints: { taskType: 'build', target: 'host continuation', expected: 'one continuation receipt' },
      capabilities,
      client: { kind: 'opencode', version: health.version, sessionId: session.id },
      maxContextChars: 12_000,
    });
    const selection = await mcpToolCall(cliScript, environment, project, 'task_execution_select', {
      runId: taskPrepare.run.runId, expectedRevision: 0, idempotencyKey: 'host-execution', choice: 'enno', agents: hostAgents, cwd: project,
    });
    taskPrepare = { ...taskPrepare, ...selection };
    if (taskPrepare?.ennoOduno?.status !== 'oduno_ideal') throw new Error(`active Enno preparation did not reach ideal phase:${JSON.stringify({ reason: selection.reason, candidate: selection.execution?.candidates?.find(item => item.agent === 'host-ideal'), actual: agentCatalog.data.find(item => item.id === 'host-ideal'), expected: agentDefinition('ideal', 'fixture/fixture-model') })}`);
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
    await server.client.session.prompt({ sessionID: session.id, text: 'Return the fixture completion.' });
    await server.client.session.wait({ sessionID: session.id });
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
    let executionVerified = false;
    let compactionVerified = false;
    if (options.execution) {
      const roleSession = await server.client.session.create({ location, model: { providerID: 'fixture', id: 'fixture-model' } });
      const rolePrepare = await mcpToolCall(cliScript, environment, project, 'task_prepare', {
        soulRead: true, requestId: 'host-role-execution',
        task: 'Verify native subagent role dispatch through OpenCode 2.0.18.', cwd: project,
        profileHints: { taskType: 'build', target: 'native subagent', expected: 'one verified dispatch' },
        capabilities, client: { kind: 'opencode', version: health.version, sessionId: roleSession.id },
        executionCatalog: buildExecutionCatalog({ agents: agentCatalog.data,
          models: (await server.client.model.list({ location })).data,
          providers: (await server.client.provider.list({ location })).data, subagentDepth: 2 },
          orchestrationOptionsSchema.parse(orchestration)), maxContextChars: 12_000,
      });
      const roleSelection = await mcpToolCall(cliScript, environment, project, 'task_execution_select', {
        runId: rolePrepare.run.runId, expectedRevision: 0, idempotencyKey: 'host-role-selection',
        choice: 'enno', agents: hostAgents, cwd: project,
      });
      if (!roleSelection.selectionAccepted || !roleSelection.execution?.dispatch?.ideal?.agent) {
        throw new Error(`role_selection_failed:${roleSelection.reason ?? 'unknown'}`);
      }
      roleAction = { agent: roleSelection.execution.dispatch.ideal.agent,
        prompt: `${roleSelection.execution.dispatch.ideal.promptPrefix}Return the fixture ideal report.`,
        description: 'Verify selected Kiokuko ideal role', background: false };
      await server.client.session.prompt({ sessionID: roleSession.id, text: 'Execute the selected ideal role now.' });
      await server.client.session.wait({ sessionID: roleSession.id });
      roleAction = undefined;
      if (!roleIssued) throw new Error('native_subagent_tool_not_offered');
      const roleDb = openConnection(path.join(data, 'kiokuko-ai.sqlite'), { readOnly: true });
      try {
        const dispatch = roleDb.prepare('SELECT status FROM task_execution_dispatches WHERE run_id = ? AND role = ? LIMIT 1').get(rolePrepare.run.runId, 'ideal');
        if (dispatch?.status !== 'completed') throw new Error(`native_dispatch_not_verified:${dispatch?.status ?? 'missing'}`);
      } finally { roleDb.close(); }
      executionVerified = true;
      await server.client.session.compact({ sessionID: roleSession.id });
      await server.client.session.wait({ sessionID: roleSession.id });
      const compactionDb = openConnection(path.join(data, 'kiokuko-ai.sqlite'), { readOnly: true });
      try {
        const latestCycle = () => compactionDb.prepare('SELECT state, summary_message_id AS summaryMessageId FROM compaction_cycles WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').get(rolePrepare.run.runId);
        await waitFor(() => Boolean(latestCycle()?.summaryMessageId), 'native_compaction_summary', 10_000).catch(() => undefined);
        const cycle = latestCycle();
        if (!cycle) throw new Error('native_compaction_boundary_missing');
        compactionVerified = Boolean(cycle.summaryMessageId);
        if (!compactionVerified) {
          const context = await server.client.session.context({ sessionID: roleSession.id });
          throw new Error(`native_compaction_summary_missing:${JSON.stringify({ cycle, messages: context.filter(item => item.type === 'compaction') })}`);
        }
      } finally { compactionDb.close(); }
      const requestsBeforeReload = fixture.stats.continuationRequests;
      await server.client.location.reload();
      let reloaded;
      for (let attempt = 0; attempt < 100; attempt++) {
        reloaded = (await server.client.plugin.list({ location })).data.find(item => item.id === 'kiokuko-ai');
        if (reloaded?.state.status === 'active') break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (reloaded?.state.status !== 'active') throw new Error('packed_plugin_reload_failed');
      await new Promise(resolve => setTimeout(resolve, 1_200));
      if (fixture.stats.continuationRequests !== requestsBeforeReload) throw new Error('reload_duplicated_continuation');
    }
    process.stdout.write(`${JSON.stringify({ protocolVersion: 2, status: 'passed', opencodeVersion: health.version, plugin: 'active', mcp: 'connected', toolCatalog: toolNames.length, hook: hookResponse.code, fixtureRequests: fixture.stats.chatCompletions, ordinaryVerified: true, preparedEnnoStatus: ideal.ennoOduno.status, continuationRequests: fixture.stats.continuationRequests, durableReceipts: 1, executionVerified, compactionVerified, reloadVerified: Boolean(options.execution), fixtureDigests: fixture.stats.requestDigests.map((value) => value.slice(0, 16)) })}\n`);
  } finally {
    await server.close();
    await fixture.close();
  }
  } finally { await registry.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) try {
  await runHostContract();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ protocolVersion: 2, status: 'failed', reason: error instanceof Error ? error.message : 'host_contract_failed' })}\n`);
  process.exitCode = 1;
}
