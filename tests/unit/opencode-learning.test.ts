import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';
import { pluginContextFixture } from '../fixtures/opencode-v2-plugin.js';
import { registerOpenCodeLearning, renderOpenCodeLearningContext, summarizeOpenCodePublicContext, classifyOpenCodeFeedback, type OpenCodeLearningObservation } from '../../src/opencode/learning.js';
import { OpenCodePluginLifecycle } from '../../src/opencode/lifecycle.js';
import { v2EventSession } from '../../src/opencode/v2-adapter.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('bounded context preserves complete source identities and does not mutate caller data', () => {
  const input = { items: [{ source: 'event-a', summary: 'A'.repeat(3000) }, { source: 'event-b', summary: 'B'.repeat(3000) }],
    handoff: { summary: 'handoff', source: 'event-c' }, principles: [] };
  const context = renderOpenCodeLearningContext(input)!;
  assert.ok(context.length <= 5000);
  assert.deepEqual(JSON.parse(context).entries.map((item: { source: string }) => item.source), ['event-a']);
  assert.equal(input.items.length, 2);
  assert.equal(renderOpenCodeLearningContext({ items: [{ summary: 'Authorization: Basic private-credentials' }] }), undefined);
});

test('record failure, conflict and unavailable context cannot reject the host prompt or model request', async () => {
  for (const reason of ['database_unavailable', 'identity_conflict', 'communication_failed']) {
    const fixture = pluginContextFixture();
    const lifecycle = new OpenCodePluginLifecycle();
    const warnings: string[] = [];
    await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
      observe: async () => { throw new Error(reason); }, recall: async () => { throw new Error(reason); },
    }, warning => warnings.push(warning));
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'msg_1', prompt: { text: 'まだ動かない' } } as never);
    const system: unknown[] = [];
    await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system, model: { providerID: 'p', id: 'new' } } as never);
    await tick();
    assert.deepEqual(system, []);
    assert.deepEqual(warnings.sort(), ['learning_context_failed']);
    await lifecycle.dispose(() => undefined);
  }
});

test('a hung recorder does not wait in the prompt hook or keep plugin disposal pending', async () => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    observe: () => new Promise(() => undefined), recall: async () => undefined,
  }, () => undefined);
  await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'msg_1', prompt: { text: 'ありがとう' } } as never);
  await tick();
  await lifecycle.dispose(() => undefined);
  assert.equal(lifecycle.isActive(), false);
});

test('same-session model changes carry public results, real event identity and unknown verification', async () => {
  const fixture = pluginContextFixture();
  fixture.ctx.session.context = async () => [{ type: 'assistant', content: [
    { type: 'reasoning', text: 'PRIVATE_REASONING_MUST_NOT_APPEAR' }, { type: 'text', text: 'Fixed retry handling. Two checks passed.' },
  ] }] as never;
  const lifecycle = new OpenCodePluginLifecycle();
  const observations: OpenCodeLearningObservation[] = [];
  const adapter = await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    observe: async observation => { observations.push(observation); }, recall: async () => 'Prior caution with source event-1; confidence: low.',
  }, () => undefined);
  adapter.observeTool({ sessionID: 'ses_1', tool: 'apply_patch', status: 'completed' });
  adapter.observeEvent({ id: 'event-complete', type: 'session.execution.succeeded', sessionId: 'ses_1' });
  await tick();
  const event = v2EventSession({ id: 'event-switch', type: 'session.model.selected', data: {
    sessionID: 'ses_1', previous: { providerID: 'p', id: 'old' }, model: { providerID: 'p', id: 'new' },
  } })!;
  adapter.observeEvent(event);
  await tick();
  const system: unknown[] = [];
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system, model: { providerID: 'p', id: 'new' } } as never);
  assert.match(JSON.stringify(system), /Fixed retry handling/);
  assert.match(JSON.stringify(system), /Prior caution/);
  assert.doesNotMatch(JSON.stringify({ system, observations }), /PRIVATE_REASONING/);
  assert.deepEqual(observations, [], 'completion and model-switch are ephemeral, not consent to persist');
  const foreignSystem: unknown[] = [];
  adapter.append('ses_other', foreignSystem as never);
  assert.deepEqual(foreignSystem, []);
  await lifecycle.dispose(() => undefined);
});

test('foreign repository and child sessions cannot cause a memory write', async () => {
  for (const session of [
    { id: 'ses_1', location: { directory: '/elsewhere' }, projectID: 'prj' },
    { id: 'ses_1', location: { directory: '/repo' }, projectID: 'prj', parentID: 'parent' },
  ]) {
    const fixture = pluginContextFixture();
    fixture.ctx.session.get = async () => session as never;
    const lifecycle = new OpenCodePluginLifecycle();
    let calls = 0;
    const adapter = await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
      observe: async () => { calls++; }, recall: async () => { calls++; return undefined; },
    }, () => undefined);
    adapter.observeEvent({ id: 'evt_1', type: 'session.execution.succeeded', sessionId: 'ses_1' });
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'msg_1', prompt: { text: 'まだ動かない' } } as never);
    await tick();
    assert.equal(calls, 0);
    await lifecycle.dispose(() => undefined);
  }
});

test('compaction excerpts, feedback detection and credentials use only bounded public text', () => {
  assert.equal(classifyOpenCodeFeedback('> まだ動かない\nThe quoted complaint is an example.'), undefined);
  assert.equal(classifyOpenCodeFeedback('まだ動かない。通常起動を確認してください。'), 'complaint');
  assert.equal(classifyOpenCodeFeedback('ありがとう。直った。'), 'praise');
  assert.equal(summarizeOpenCodePublicContext([{ type: 'compaction', status: 'completed', summary: 'Public work and pending regression.' }]), 'Public work and pending regression.');
  assert.equal(summarizeOpenCodePublicContext([{ type: 'assistant', content: [{ type: 'text', text: 'prefix ' + 'x'.repeat(2000) + ' password=supersecretcredential123' }] }]), '');
  assert.equal(summarizeOpenCodePublicContext([{ type: 'compaction', status: 'completed', summary: 'Cookie: private-session-token' }]), '');
});

test('host-executed focused verifier results retain evidence without claiming full task verification', async () => {
  const fixture = pluginContextFixture();
  fixture.ctx.session.context = async () => [{ type: 'assistant', content: [{ type: 'text', text: 'A focused check passed.' }] }] as never;
  const lifecycle = new OpenCodePluginLifecycle();
  const observations: OpenCodeLearningObservation[] = [];
  const adapter = await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    observe: async observation => { observations.push(observation); }, recall: async () => undefined,
  }, () => undefined);
  adapter.observeTool({ sessionID: 'ses_1', tool: 'kiokuko_task_memory_verify', status: 'completed', result: { output: JSON.stringify({
    origin: 'host_executed', executionState: 'finished', root: '/repo', evidenceId: 'evidence-123', outcome: 'passed', exitCode: 0,
  }) } });
  adapter.observeEvent({ id: 'evt_verified', type: 'session.execution.succeeded', sessionId: 'ses_1' });
  await tick();
  assert.deepEqual(observations, [], 'verification evidence does not authorize automatic memory writes');
  await lifecycle.dispose(() => undefined);
});

test('the shipped plugin registers real nonblocking prompt and model context learning hooks', async () => {
  const fixture = pluginContextFixture();
  const cleanup = await KiokukoPlugin.setup(fixture.ctx);
  try {
    assert.ok(fixture.hooks.has('session:prompt'));
    assert.ok(fixture.hooks.has('session:context'));
  } finally { await cleanup?.(); }
});
