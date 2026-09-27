import assert from 'node:assert/strict';
import test from 'node:test';
import type { Plugin } from '@opencode/plugin';
import { agentDefinition, buildExecutionCatalog, orchestrationOptionsSchema } from '../../src/execution/catalog.js';
import { registerExecutionHooks } from '../../src/opencode/execution.js';
import { fixtureCatalogInput } from '../fixtures/execution-selection.js';

function fixture(model = 'fixture/worker') {
  const agent = 'my-worker';
  const options = orchestrationOptionsSchema.parse({ customAgents: { gokiWorker: [agent] } });
  const catalogInput = fixtureCatalogInput({ [agent]: agentDefinition('gokiWorker', 'fixture/worker') });
  const candidate = buildExecutionCatalog(catalogInput, options).candidates.find(item => item.agent === agent)!;
  const hooks = new Map<string, (value: never) => Promise<void>>();
  const stages: string[] = [];
  const ctx = {
    location: { directory: '/repo', project: { id: 'prj' } },
    options: { orchestration: { customAgents: { gokiWorker: [agent] } } },
    agent: { list: async () => ({ data: catalogInput.agents }) },
    model: { list: async () => ({ data: catalogInput.models }) },
    provider: { list: async () => ({ data: catalogInput.providers }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID, projectID: 'prj', location: { directory: '/repo' },
        ...(sessionID === 'child' ? { parentID: 'parent', agent, outcome: 'succeeded' } : {}),
      }),
      context: async () => [{ type: 'assistant', id: 'msg_child', time: { completed: 1 },
        model: { providerID: 'fixture', id: model.split('/')[1] } }],
    },
    tool: { hook: async (name: string, callback: (value: never) => Promise<void>) => { hooks.set(name, callback); } },
  } as unknown as Plugin.Context;
  const route = async (input: { stage?: string }) => {
    if (input.stage) stages.push(input.stage);
    return { active: true, choice: 'enno', role: 'gokiWorker', revision: 1, selected: {
      gokiWorker: { agent, model: candidate.model, configurationDigest: candidate.configurationDigest },
    } };
  };
  const beforeInput = { tool: 'subagent', sessionID: 'parent', id: 'call_1',
    input: { agent, prompt: '<kiokuko-execution>{"runId":"run_1","revision":1,"role":"gokiWorker"}</kiokuko-execution>\nImplement' } };
  return { ctx, hooks, route, stages, candidate, beforeInput };
}

test('v2 subagent rejects background and existing child reuse before dispatch', async () => {
  const f = fixture();
  await registerExecutionHooks(f.ctx, '/repo', {}, f.route);
  const before = f.hooks.get('execute.before')!;
  await assert.rejects(before({ ...f.beforeInput, input: { ...f.beforeInput.input, background: true } } as never));
  await assert.rejects(before({ ...f.beforeInput, input: { ...f.beforeInput.input, sessionID: 'child' } } as never));
  assert.deepEqual(f.stages, []);
});

test('v2 dispatch completes only after child identity, model and outcome are checked', async () => {
  const f = fixture();
  await registerExecutionHooks(f.ctx, '/repo', {}, f.route);
  const before = f.hooks.get('execute.before')!;
  const after = f.hooks.get('execute.after')!;
  const input = structuredClone(f.beforeInput);
  await before(input as never);
  assert.equal((input.input as { model?: string }).model, f.candidate.model);
  assert.deepEqual(f.stages, ['begin']);
  await after({ tool: 'subagent', sessionID: 'parent', id: 'call_1', status: 'completed',
    result: { metadata: { sessionID: 'child', status: 'completed' } } } as never);
  assert.deepEqual(f.stages, ['begin', 'complete']);
});

test('running result and actual model mismatch never record completion', async () => {
  const f = fixture('fixture/wrong');
  await registerExecutionHooks(f.ctx, '/repo', {}, f.route);
  await f.hooks.get('execute.before')!(structuredClone(f.beforeInput) as never);
  await f.hooks.get('execute.after')!({ tool: 'subagent', sessionID: 'parent', id: 'call_1', status: 'completed',
    result: { metadata: { sessionID: 'child', status: 'running' } } } as never);
  assert.deepEqual(f.stages, ['begin']);
  await assert.rejects(f.hooks.get('execute.after')!({ tool: 'subagent', sessionID: 'parent', id: 'call_1', status: 'completed',
    result: { metadata: { sessionID: 'child', status: 'completed' } } } as never));
  assert.deepEqual(f.stages, ['begin', 'failed']);
});

test('a tool that becomes background work completes only after the child ends', async () => {
  const f = fixture();
  const execution = await registerExecutionHooks(f.ctx, '/repo', {}, f.route);
  await f.hooks.get('execute.before')!(structuredClone(f.beforeInput) as never);
  await f.hooks.get('execute.after')!({ tool: 'subagent', sessionID: 'parent', id: 'call_1', status: 'completed',
    result: { metadata: { sessionID: 'child', status: 'running' } } } as never);
  assert.deepEqual(f.stages, ['begin']);
  await execution.onSessionEnded('child');
  assert.deepEqual(f.stages, ['begin', 'complete']);
});

test('a failed subagent cannot be silently retried without selection', async () => {
  const f = fixture();
  await registerExecutionHooks(f.ctx, '/repo', {}, f.route);
  await f.hooks.get('execute.before')!(structuredClone(f.beforeInput) as never);
  await f.hooks.get('execute.after')!({ tool: 'subagent', sessionID: 'parent', id: 'call_1', status: 'error' } as never);
  assert.deepEqual(f.stages, ['begin', 'failed']);
  await assert.rejects(f.hooks.get('execute.before')!({ ...structuredClone(f.beforeInput), id: 'call_retry' } as never));
  assert.deepEqual(f.stages, ['begin', 'failed']);
});
