import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { createExecutionHooks } from '../../src/opencode/execution.js';
import { MANAGED_EXECUTION_AGENTS, EXECUTION_PRESETS, buildExecutionCatalog, orchestrationOptionsSchema, type ExecutionRole } from '../../src/execution/catalog.js';
import { fixtureProviders } from '../fixtures/execution-selection.js';

async function fixture(role: ExecutionRole = 'ideal') {
  const agents = EXECUTION_PRESETS[0]!.agents;
  const config = { subagent_depth: 2, agent: structuredClone(MANAGED_EXECUTION_AGENTS) };
  const catalog = buildExecutionCatalog(config, fixtureProviders(), orchestrationOptionsSchema.parse({}));
  const selected = Object.fromEntries(Object.entries(agents).map(([r,a]) => [r,catalog.candidates.find(c => c.role === r && c.agent === a)]));
  const sessions: Record<string, unknown> = { root: { id: 'root' }, head: { id: 'head', parentID: 'root', agent: agents.gokiHead },
    worker: { id: 'worker', parentID: 'head', agent: agents.gokiWorker }, alien: { id: 'alien' } };
  const writes: unknown[] = [];
  const hooks = createExecutionHooks({ provider: { list: async () => ({ data: fixtureProviders() }) },
    session: { messages: async () => ({ data: [] }), get: async ({ path }: { path: { id: string } }) => ({ data: sessions[path.id] }) } } as unknown as PluginInput['client'], '/fixture', {}, {
      readRouting: async input => {
        assert.equal(input.rootSessionId, 'root');
        if (input.stage) { writes.push(input); return { accepted: true }; }
        return { active: true, choice: 'enno', revision: 1, role, selected };
      },
    });
  await hooks.config!(config as never);
  const args = (r: ExecutionRole) => ({ subagent_type: agents[r], prompt: `<kiokuko-execution>${JSON.stringify({ runId: 'run', revision: 1, role: r })}</kiokuko-execution>\nDo the approved work.` });
  const before = (sessionID: string, input: unknown, tool = 'task') => hooks['tool.execute.before']!({ tool, sessionID, callID: 'call' }, { args: input });
  return { before, hooks, args, agents, writes, config };
}

test('execution hook verifies exact root, role, revision, model and configuration before dispatch', async () => {
  const f = await fixture();
  await f.before('root', f.args('ideal'));
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.before('alien', f.args('ideal')));
  await assert.rejects(f.before('root', f.args('check')), /role/u);
  await assert.rejects(f.before('root', { ...f.args('ideal'), task_id: 'old-child' }), /fresh/u);
  await assert.rejects(f.before('root', { ...f.args('ideal'), background: true }), /Await/u);
  f.config.agent[f.agents.ideal]!.model = 'openai/changed-model';
  await assert.rejects(f.before('root', f.args('ideal')), /unavailable or changed/u);
});

test('head can dispatch only the selected worker and worker cannot redelegate or select', async () => {
  const f = await fixture('gokiHead');
  await f.before('root', f.args('gokiHead'));
  await f.before('head', f.args('gokiWorker'));
  await assert.rejects(f.before('root', f.args('gokiWorker')), /role/u);
  await assert.rejects(f.before('head', { subagent_type: 'general', prompt: 'bypass the selected worker' }), /Select/u);
  await assert.rejects(f.before('worker', f.args('gokiWorker')), /role/u);
  await assert.rejects(f.before('head', { runId: 'run' }, 'kiokuko_task_execution_select'), /Only the parent/u);
});

test('a failed or mismatched model result does not authorize the next task', async () => {
  const f = await fixture();
  await f.before('root', f.args('ideal'));
  await assert.rejects(f.hooks['tool.execute.after']!({ tool: 'task', sessionID: 'root', callID: 'call', args: f.args('ideal') }, {
    title: 'fixture', metadata: { model: { providerID: 'openai', modelID: 'different-model' } }, output: 'done',
  }), /Selected model failed/u);
  await assert.rejects(f.before('root', f.args('ideal')), /previous model call failed/u);
  assert.equal(f.writes.length, 2, 'failed call is durably marked failed');
  assert.equal((f.writes[1] as { stage: string }).stage, 'failed');
});

test('successful model metadata completes the durable dispatch receipt', async () => {
  const f = await fixture();
  await f.before('root', f.args('ideal'));
  await f.hooks['tool.execute.after']!({ tool: 'task', sessionID: 'root', callID: 'call', args: f.args('ideal') }, {
    title: 'fixture', metadata: { model: { providerID: 'openai', modelID: 'gpt-6-astra' } }, output: 'done',
  });
  assert.equal(f.writes.length, 2);
});

test('parallel runs keep model verification separate even when providers reuse a tool call ID', async () => {
  const config = { subagent_depth: 2, agent: MANAGED_EXECUTION_AGENTS };
  const catalog = buildExecutionCatalog(config, fixtureProviders(), orchestrationOptionsSchema.parse({}));
  const selections = [EXECUTION_PRESETS[0]!, EXECUTION_PRESETS[2]!].map(p => Object.fromEntries(Object.entries(p.agents).map(([role,agent]) => [role, catalog.candidates.find(c => c.role === role && c.agent === agent)])));
  const stages: unknown[] = [];
  const hooks = createExecutionHooks({ provider: { list: async () => ({ data: fixtureProviders() }) }, session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }), messages: async () => ({ data: [] }),
  } } as unknown as PluginInput['client'], '/fixture', {}, { readRouting: async input => {
    if (input.stage) { stages.push(input); return { accepted: true }; }
    return { active: true, choice: 'enno', revision: 1, role: 'ideal', selected: selections[input.rootSessionId === 'root-a' ? 0 : 1] };
  } });
  await hooks.config!(config as never);
  for (const [index, sessionID] of ['root-a','root-b'].entries()) {
    await hooks['tool.execute.before']!({ tool: 'task', sessionID, callID: 'reused-provider-call' }, { args: {
      subagent_type: selections[index]!.ideal!.agent,
      prompt: `<kiokuko-execution>${JSON.stringify({ runId: sessionID, revision: 1, role: 'ideal' })}</kiokuko-execution>\nRead the approved task.`,
    } });
  }
  for (const [index, sessionID] of ['root-a','root-b'].entries()) {
    const model = selections[index]!.ideal!.model;
    const slash = model.indexOf('/');
    await hooks['tool.execute.after']!({ tool: 'task', sessionID, callID: 'reused-provider-call', args: {} }, {
      title: 'done', metadata: { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } }, output: 'done',
    });
  }
  assert.equal(stages.length, 4);
});

test('native MCP hooks enrich the original args reference retained by OpenCode', async () => {
  const f = await fixture();
  const input: Record<string, unknown> = { requestId: 'same-request' };
  await f.before('root', input, 'kiokuko_task_prepare');
  assert.deepEqual(input.client, { kind: 'opencode', sessionId: 'root' });
  assert.ok((input.executionCatalog as { candidates: unknown[] }).candidates.length > 0);
  const first = input.executionCatalog;
  await f.before('root', input, 'kiokuko_task_prepare');
  assert.equal(input.executionCatalog, first, 'retry retains its bound catalog');
  const selection: Record<string, unknown> = { runId: 'run' };
  await f.before('root', selection, 'kiokuko_task_execution_select');
  assert.ok((selection.catalog as { candidates: unknown[] }).candidates.length > 0);
});
