import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { requireSuccess, startOpenCode, resolveOpenCodeBinary } from './run-opencode-host-e2e.mjs';
import { callMcpTool } from './lib/mcp-probe.mjs';
import { startFakeOpenAiServer } from '../tests/e2e/fake-openai-server.mjs';
import { agentDefinition, buildExecutionCatalog, orchestrationOptionsSchema, EXECUTION_ROLES } from '../dist/execution/catalog.js';

const repo = path.resolve(import.meta.dirname, '..');
const cliScript = path.join(repo, 'dist/bin/kiokuko.js');
const opencodeValue = process.env.OPENCODE_BIN;
assert.ok(opencodeValue && path.isAbsolute(opencodeValue), 'Set OPENCODE_BIN to an isolated OpenCode executable');
const opencode = await resolveOpenCodeBinary(opencodeValue);
const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-execution-host-'));
const project = path.join(root, 'project');
const environment = { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'opencode-data'), XDG_CACHE_HOME: path.join(root, 'cache'), KIOKUKO_DATA_DIR: path.join(root, 'kiokuko-data'),
  OPENCODE_CONFIG: path.join(root, 'config/opencode/opencode.jsonc'), OPENCODE_CONFIG_DIR: path.join(root, 'config/opencode'), OPENCODE_CONFIG_CONTENT: '{}',
  KIOKUKO_SKILL_DISCOVERY: 'off', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
for (const dir of [project, environment.HOME, environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.KIOKUKO_DATA_DIR]) await mkdir(dir, { recursive: true });
await requireSuccess('git', ['init', '-q'], { cwd: project, env: environment });
await writeFile(path.join(project, 'README.md'), 'Fixture work.\n');
await requireSuccess(process.execPath, [cliScript, 'setup', '--enno-oduno', 'ask', '--skill-discovery', 'off', '--json'], { cwd: project, env: environment });
const configPath = path.join(environment.XDG_CONFIG_HOME, 'opencode/opencode.jsonc');
let config = parse(await readFile(configPath, 'utf8'));
const index = config.plugin.findIndex(entry => Array.isArray(entry) && entry[0].startsWith('kiokuko-ai@'));
assert.ok(index >= 0);
const options = config.plugin[index][1];
const readme = await readFile(path.join(repo, 'README.md'), 'utf8');
function example(marker) {
  const block = readme.split(`<!-- ${marker} -->`)[1]?.split('```jsonc')[1]?.split('```')[0];
  assert.ok(block, `README example ${marker}`); return parse(block);
}
const custom = example('kiokuko-custom-worker-example');
const registration = example('kiokuko-custom-registration-example');
custom.agent['my-orchestration-worker'].model = 'fixture/worker';
Object.assign(config.agent, custom.agent);
for (const role of EXECUTION_ROLES.filter(role => role !== 'gokiWorker')) config.agent[`fixture-${role}`] = agentDefinition(role, `fixture/${role}`);
options.orchestration = { mode: 'ask', customAgents: { ...registration.orchestration.customAgents,
  ...Object.fromEntries(EXECUTION_ROLES.filter(role => role !== 'gokiWorker').map(role => [role, [`fixture-${role}`]])) } };
// Test setup preserves the actual README custom definition and registrations.
await writeFile(configPath, JSON.stringify(config, null, 2));
await requireSuccess(process.execPath, [cliScript, 'setup', '--skill-discovery', 'off', '--json'], { cwd: project, env: environment });
config = parse(await readFile(configPath, 'utf8'));
assert.deepEqual(config.agent['my-orchestration-worker'], custom.agent['my-orchestration-worker']);
assert.deepEqual(config.plugin[index][1].orchestration, options.orchestration);
config.plugin[index][0] = pathToFileURL(path.join(repo, 'dist/opencode/plugin.js')).href;
let action;
let childAction;
let completeAction;
let attackModel;
let failureStatus;
let intakeMode = false;
let intakeRunId;
const tool = (name, args, n) => ({ toolCalls: [{ id: `fixture-call-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const fixture = await startFakeOpenAiServer({ emitTaskPrepare: false, respond: async (body, sequence) => {
  if (failureStatus && body.model === 'ideal') return { status: failureStatus };
  const messages = body.messages ?? [];
  const userIndex = messages.findLastIndex(item => item.role === 'user');
  const toolDone = messages.slice(userIndex + 1).some(item => item.role === 'tool');
  if (intakeMode && body.model === 'parent') {
    const names = (body.tools ?? []).map(item => item.function?.name);
    const results = messages.slice(userIndex + 1).filter(item => item.role === 'tool');
    if (results.length === 0) return tool(names.find(name => /(?:^|_)task_prepare$/u.test(name)), {
      soulRead: true, requestId: 'wire-ordinary', task: 'Fix a bounded README wording issue using ordinary work', cwd: project,
      profileHints: { taskType: 'build', target: 'README.md', expected: 'clear wording' },
    }, sequence);
    const content = typeof results[0].content === 'string' ? results[0].content : results[0].content.map(part => part.text ?? '').join('');
    intakeRunId = /"runId"\s*:\s*"([^"]+)"/u.exec(content)?.[1];
    if (!intakeRunId) { console.error('Intake output:', content.slice(0, 2000)); return { text: 'Intake did not return an identity.' }; }
    if (results.length === 1) return tool(names.find(name => /(?:^|_)task_execution_select$/u.test(name)), {
      runId: intakeRunId, expectedRevision: 0, idempotencyKey: 'wire-ordinary-select', choice: 'ordinary',
    }, sequence);
    return { text: 'Ordinary work selected without child agents.' };
  }
  if (attackModel === body.model && !toolDone) return tool(attackModel === 'worker' ? 'task' : 'write', attackModel === 'worker'
    ? { description: 'Forbidden delegation', subagent_type: 'general', prompt: 'Do not run' }
    : { filePath: path.join(project, 'forbidden-write.txt'), content: 'must not be written' }, sequence);
  if (body.model === 'parent' && action && !toolDone && JSON.stringify(messages[userIndex]?.content).includes('Execute ')) return tool('task', action, sequence);
  if (body.model === 'gokiHead' && childAction && !toolDone) return tool('task', childAction, sequence);
  if (body.model === 'parent' && toolDone && completeAction) { const complete = completeAction; completeAction = undefined; await complete(); }
  return { text: `${body.model} completed fixture role` };
} });
config.model = 'fixture/parent';
config.small_model = 'fixture/parent';
config.provider = { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture', options: { baseURL: fixture.baseURL, apiKey: 'fixture-key' },
  models: Object.fromEntries(['parent','ideal','zenki','gokiHead','worker','check'].map(id => [id, { name: id, tool_call: true, limit: { context: 128000, output: 4096 } }])) } };
await writeFile(configPath, JSON.stringify(config, null, 2));
let server = await startOpenCode(opencode, environment, project);
const request = async (route, body) => {
  const res = await fetch(server.url + route, { ...(body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}), signal: AbortSignal.timeout(90_000) });
  assert.ok(res.ok, `HTTP ${res.status} ${route}`); return res.json();
};
const mcp = (name, args) => callMcpTool({ cliScript, environment, cwd: project, onToolError: content => console.error(name, JSON.stringify(content)) }, name, args);
const capabilities = ['kiokuko-soul','kiokuko-enno-oduno','kiokuko-single-purpose-functions'].map(name => ({ kind: 'skill', name }));
try {
  const health = await request('/global/health');
  const providers = await request('/provider');
  await writeFile(path.join(root, 'provider-fixture.json'), JSON.stringify(providers.all?.find(p => p.id === 'fixture'), null, 2));
  const catalog = buildExecutionCatalog(config, providers, orchestrationOptionsSchema.parse(options.orchestration));
  const agents = Object.fromEntries(EXECUTION_ROLES.map(role => [role, role === 'gokiWorker' ? 'my-orchestration-worker' : `fixture-${role}`]));
  for (const [role, agent] of Object.entries(agents)) assert.equal(catalog.candidates.find(c => c.role === role && c.agent === agent)?.unavailable, null, `candidate ${role}`);
  console.error('Verifying native MCP intake and ordinary selection');
  const ordinarySession = await request('/session', { title: 'Ordinary request' });
  intakeMode = true;
  await request(`/session/${ordinarySession.id}/message`, { model: { providerID: 'fixture', modelID: 'parent' }, parts: [{ type: 'text', text: 'Use ordinary execution for this README wording request.' }] });
  intakeMode = false;
  const ordinaryHistory = await request(`/session/${ordinarySession.id}/message`);
  const intakeCalls = ordinaryHistory.flatMap(message => message.parts ?? []).filter(part => part.type === 'tool' && /(?:^|_)(task_prepare|task_execution_select)$/u.test(part.tool));
  assert.equal(intakeCalls.length, 2, 'prepare exactly once and select exactly once');
  assert.ok(intakeCalls.every(part => part.state.status === 'completed'), JSON.stringify(intakeCalls.map(part => ({ tool: part.tool, status: part.state.status, error: part.state.error }))));
  const restoredOrdinary = await mcp('task_context_read', { runId: intakeRunId, afterContextRevision: 0 });
  assert.equal(restoredOrdinary.execution.choice, 'ordinary');
  assert.ok(restoredOrdinary.execution.candidates.some(candidate => candidate.agent === 'my-orchestration-worker' && candidate.unavailable === null), 'plugin injected real provider catalog');
  assert.deepEqual(await request(`/session/${ordinarySession.id}/children`), [], 'ordinary selection spawned no children');
  await fetch(server.url + `/session/${ordinarySession.id}`, { method: 'DELETE' });
  const session = await request('/session', { title: 'Execution selection fixture' });
  const prepared = await mcp('task_prepare', { soulRead: true, requestId: 'execution-model-wire', task: 'Verify the README fixture through role dispatch', cwd: project,
    profileHints: { taskType: 'build', target: 'README.md', expected: 'fixture verification passes' }, capabilities,
    client: { kind: 'opencode', version: health.version, sessionId: session.id }, executionCatalog: catalog });
  assert.equal(prepared.execution.choice, 'pending');
  assert.equal(prepared.ennoOduno.applicable, false);
  const selectInput = { runId: prepared.run.runId, expectedRevision: 0, idempotencyKey: 'select-models', choice: 'enno', agents, cwd: project };
  const selected = await mcp('task_execution_select', selectInput);
  const replay = await mcp('task_execution_select', selectInput);
  assert.deepEqual(replay.execution.selected, selected.execution.selected);
  const dispatch = selected.execution.dispatch;
  const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
  const invoke = async role => {
    console.error(`Verifying ${role}`);
    action = { description: `Check ${role} fixture`, subagent_type: dispatch[role].subagent_type, prompt: dispatch[role].promptPrefix + `Return the ${role} fixture report.` };
    childAction = role === 'gokiHead' ? { description: 'Run approved worker fixture', subagent_type: dispatch.gokiWorker.subagent_type, prompt: dispatch.gokiWorker.promptPrefix + 'Verify the approved README fixture. Return evidence without changing files.' } : undefined;
    const before = fixture.stats.sentModels.length;
    const result = await request(`/session/${session.id}/message`, { model: { providerID: 'fixture', modelID: 'parent' }, parts: [{ type: 'text', text: `Execute ${role} now.` }] });
    const part = result.parts?.find(item => item.type === 'tool' && item.tool === 'task');
    // The final assistant response may omit earlier tool parts; read the full stored sequence.
    const history = await request(`/session/${session.id}/message`);
    const calls = history.flatMap(item => item.parts ?? []).filter(item => item.type === 'tool' && item.tool === 'task');
    const latest = calls.at(-1) ?? part;
    assert.equal(latest?.state?.status, 'completed', JSON.stringify(latest));
    assert.ok(fixture.stats.sentModels.slice(before).includes(role), `wire model ${role}`);
    if (role === 'gokiHead') assert.ok(fixture.stats.sentModels.slice(before).includes('worker'), 'README custom worker wire model');
  };
  await invoke('ideal');
  await mcp('enno_ideal_submit', { ...identity, expectedRevision: 1, idempotencyKey: 'ideal', ideal: {
    objective: 'Verify README through selected models', principles: ['Retain fixture contents'], skillContributions: [], successSignals: ['Fixture verification passes'] } });
  await invoke('zenki');
  // Restore selection from the same persisted run after a real host restart.
  await server.close(); server = await startOpenCode(opencode, environment, project);
  const plan = await mcp('enno_plan_submit', { ...identity, expectedRevision: 1, idempotencyKey: 'plan', scope: ['README.md'], exclusions: [],
    acceptanceCriteria: [{ id: 'fixture', description: 'Fixture verification passes' }],
    workPlan: { objective: 'Verify README fixture', units: [{ id: 'verify-readme', objective: 'Verify README fixture', scope: ['README.md'], dependencies: [], routes: ['code'], skillNames: [],
      expertRefs: [{ id: 'code.verification.v1', reason: 'Verify existing README' }], acceptanceCriteria: ['Fixture verification passes'], focusedVerifiers: [] }] },
    skillRequirements: [], finalVerifiers: [{ id: 'fixture', kind: 'test', executable: process.execPath, args: ['--eval','process.exit(0)'], cwd: '.', timeoutMs: 5000 }], maxAttempts: 3,
    provenance: { scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user' }, capabilities });
  assert.equal(plan.ennoOduno.status, 'goki_executing');
  const lease = plan.executionLease;
  completeAction = () => mcp('enno_work_report', { ...identity, expectedRevision: 2, idempotencyKey: 'report', workUnitId: lease.workUnitId, leaseToken: lease.leaseToken,
    routeEpoch: lease.routeEpoch, attempt: lease.attempt, inputManifestDigest: lease.inputManifestDigest,
    result: { outcome: 'completed', summary: 'Fixture verified through worker', mutated: false, changedPaths: [] } });
  await invoke('gokiHead');
  await mcp('enno_verify_prepare', { ...identity, expectedRevision: 2, idempotencyKey: 'verify' });
  await invoke('check');
  await mcp('task_execution_select', { runId: prepared.run.runId, expectedRevision: 1, idempotencyKey: 'cancel', choice: 'cancelled', cwd: project });
  await fetch(server.url + `/session/${session.id}`, { method: 'DELETE' });
  action = undefined; childAction = undefined;
  for (const role of ['ideal', 'zenki', 'check', 'gokiHead', 'worker']) {
    console.error(`Verifying permissions ${role}`);
    attackModel = role;
    const probe = await request('/session', { title: `Permission probe ${role}` });
    await request(`/session/${probe.id}/message`, { agent: role === 'worker' ? 'my-orchestration-worker' : `fixture-${role}`,
      model: { providerID: 'fixture', modelID: role }, parts: [{ type: 'text', text: 'Probe the forbidden tool.' }] });
    const history = await request(`/session/${probe.id}/message`);
    const calls = history.flatMap(item => item.parts ?? []).filter(item => item.type === 'tool');
    assert.ok(calls.some(item => item.state.status === 'error'), `permission rejection ${role}`);
    await assert.rejects(access(path.join(project, 'forbidden-write.txt')));
    await fetch(server.url + `/session/${probe.id}`, { method: 'DELETE' });
  }
  attackModel = undefined;
  for (const status of [401, 404, 429]) {
    console.error(`Verifying provider failure ${status}`);
    const failedSession = await request('/session', { title: `Provider failure ${status}` });
    const failurePrepare = await mcp('task_prepare', { soulRead: true, requestId: `failure-${status}`, task: 'Verify model failure handling', cwd: project,
      profileHints: { taskType: 'build', target: 'README.md', expected: 'no automatic fallback' }, capabilities,
      client: { kind: 'opencode', version: health.version, sessionId: failedSession.id }, executionCatalog: catalog });
    const failureSelection = await mcp('task_execution_select', { runId: failurePrepare.run.runId, expectedRevision: 0, idempotencyKey: 'select-failure', choice: 'enno', agents, cwd: project });
    const prefix = failureSelection.execution.dispatch.ideal;
    action = { description: 'Failure fixture', subagent_type: prefix.subagent_type, prompt: prefix.promptPrefix + 'Test provider failure.' };
    failureStatus = status;
    const start = fixture.stats.sentModels.length;
    await request(`/session/${failedSession.id}/message`, { model: { providerID: 'fixture', modelID: 'parent' }, parts: [{ type: 'text', text: 'Execute failure now.' }] });
    const history = await request(`/session/${failedSession.id}/message`);
    assert.ok(history.flatMap(item => item.parts ?? []).some(item => item.type === 'tool' && item.tool === 'task' && item.state.status === 'error'), `task failed ${status}`);
    assert.ok(fixture.stats.sentModels.slice(start).includes('ideal'));
    assert.ok(fixture.stats.sentModels.slice(start).every(model => ['parent','ideal'].includes(model)), 'no fallback model sent');
    failureStatus = undefined;
    let failureRecorded = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const recovered = await mcp('task_context_read', { runId: failurePrepare.run.runId, afterContextRevision: 0 });
      if (recovered.execution.modelFailure) { failureRecorded = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(failureRecorded, 'provider failure remains recorded');
    if (status === 401) {
      await server.close(); server = await startOpenCode(opencode, environment, project);
      const beforeRetry = fixture.stats.sentModels.filter(model => model === 'ideal').length;
      action.prompt += ' A changed retry prompt must not bypass the failed selection.';
      await request(`/session/${failedSession.id}/message`, { model: { providerID: 'fixture', modelID: 'parent' }, parts: [{ type: 'text', text: 'Execute retry without reselection.' }] });
      assert.equal(fixture.stats.sentModels.filter(model => model === 'ideal').length, beforeRetry, 'restart never silently retries a failed selection');
    }
    await mcp('task_execution_select', { runId: failurePrepare.run.runId, expectedRevision: 1, idempotencyKey: 'cancel-failure', choice: 'cancelled', cwd: project });
    await fetch(server.url + `/session/${failedSession.id}`, { method: 'DELETE' });
  }
  action = undefined;
  console.log(JSON.stringify({ status: 'passed', opencode: health.version, models: [...new Set(fixture.stats.sentModels)], nativeOrdinarySelection: true, readmeCustomWorker: true, nestedDelegation: true, restart: true, permissions: true, providerFailures: [401,404,429] }));
} catch (error) {
  console.error(`Fixture directory: ${root}`);
  throw error;
} finally { await server.close(); await fixture.close(); }
