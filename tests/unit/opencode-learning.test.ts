import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';
import { pluginContextFixture } from '../fixtures/opencode-v2-plugin.js';
import { registerOpenCodeLearning, renderOpenCodeLearningContext, summarizeOpenCodePublicContext, classifyOpenCodeFeedback, type OpenCodeLearningObservation } from '../../src/opencode/learning.js';
import { OpenCodePluginLifecycle } from '../../src/opencode/lifecycle.js';
import { v2EventSession } from '../../src/opencode/v2-adapter.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('a late response for the same query cannot restore memory withdrawn by a newer response', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const pending: Array<(value: string) => void> = [];
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: () => new Promise(resolve => pending.push(resolve)),
  }, () => undefined);
  for (const id of ['first', 'second']) {
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: id, prompt: { text: 'sqlite' } } as never);
    await tick();
  }
  pending[1]!(JSON.stringify({ entries: [], handoff: null })); await tick();
  pending[0]!(JSON.stringify({ entries: [{ entryId: 'withdrawn', summary: 'OLD_WITHDRAWN_ADVICE' }], handoff: null })); await tick();
  const system: unknown[] = [];
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  assert.doesNotMatch(JSON.stringify(system), /OLD_WITHDRAWN_ADVICE/);
});

test('different original requests sharing a bounded search prefix do not share cached memory', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const pending: Array<(value: string) => void> = [];
  const queries: string[] = [];
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: query => { queries.push(query); return new Promise(resolve => pending.push(resolve)); },
  }, () => undefined);
  const prefix = 'Shared repository instructions. '.repeat(40);
  await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'sqlite', prompt: { text: prefix + 'Fix sqlite locks.' } } as never);
  await tick(); pending[0]!('SQLITE_ONLY_ADVICE'); await tick();
  await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'css', prompt: { text: prefix + 'Fix CSS spacing.' } } as never);
  await tick();
  assert.equal(queries[0], queries[1], 'the lookup stays bounded; request identity must retain the distinction');
  const system: unknown[] = [];
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  assert.doesNotMatch(JSON.stringify(system), /SQLITE_ONLY_ADVICE/);
});

test('model-switch recall cannot overwrite a newer result for an identical request', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const pending: Array<(value: string) => void> = [];
  const adapter = await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: () => new Promise(resolve => pending.push(resolve)),
  }, () => undefined);
  const prompt = async (messageID: string) => {
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID, prompt: { text: 'sqlite' } } as never);
    await tick();
  };
  await prompt('first');
  adapter.observeEvent({ id: 'switch', type: 'session.model.selected', sessionId: 'ses_1' }); await tick();
  await prompt('newer');
  pending[2]!('CURRENT_MEMORY'); await tick();
  pending[1]!('OLD_SWITCH_MEMORY'); pending[0]!('OLD_PROMPT_MEMORY'); await tick();
  const system: unknown[] = [];
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  assert.match(JSON.stringify(system), /CURRENT_MEMORY/);
  assert.doesNotMatch(JSON.stringify(system), /OLD_SWITCH_MEMORY|OLD_PROMPT_MEMORY/);
});

test('newer missing or failed recall cannot be undone by a late same-request result', async t => {
  for (const failure of [false, true]) {
    const fixture = pluginContextFixture();
    const lifecycle = new OpenCodePluginLifecycle();
    t.after(() => lifecycle.dispose(() => undefined));
    const pending: Array<{ resolve(value: string | undefined): void; reject(error: Error): void }> = [];
    await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
      recall: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    }, () => undefined);
    for (const messageID of ['first', 'newer']) {
      await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID, prompt: { text: 'sqlite' } } as never);
      await tick();
    }
    if (failure) pending[1]!.reject(new Error('offline')); else pending[1]!.resolve(undefined);
    await tick(); pending[0]!.resolve('OLD_MEMORY'); await tick();
    const system: unknown[] = [];
    await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
    assert.deepEqual(system, []);
  }
});

test('a new request clears prior recall and late results cannot replace the current request', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const pending = new Map<string, (value: string | undefined) => void>();
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: query => new Promise(resolve => pending.set(query, resolve)),
  }, () => undefined);
  const prompt = async (text: string) => {
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: text, prompt: { text } } as never);
    await tick();
  };
  const context = async () => {
    const system: Array<{ type: 'text'; text: string }> = [];
    await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
    return JSON.stringify(system);
  };
  await prompt('sqlite'); pending.get('sqlite')!('SQLITE_CAUTION'); await tick();
  assert.match(await context(), /SQLITE_CAUTION/);
  await prompt('css');
  assert.doesNotMatch(await context(), /SQLITE_CAUTION/, 'unrelated prior memory cannot leak while recall is pending');
  await prompt('network'); pending.get('network')!('NETWORK_CAUTION'); await tick();
  pending.get('css')!('CSS_CAUTION'); await tick();
  assert.match(await context(), /NETWORK_CAUTION/);
  assert.doesNotMatch(await context(), /CSS_CAUTION|SQLITE_CAUTION/);
  await prompt('no-matches'); pending.get('no-matches')!(undefined); await tick();
  assert.equal(await context(), '[]', 'no matches must leave no previous recall');
});

test('blank or unsafe requests invalidate pending recall without blocking context', async t => {
  for (const text of ['', 'password=supersecretcredential123']) {
    const fixture = pluginContextFixture();
    const lifecycle = new OpenCodePluginLifecycle();
    t.after(() => lifecycle.dispose(() => undefined));
    let release!: (value: string) => void;
    let calls = 0;
    await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
      recall: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    }, () => undefined);
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'old', prompt: { text: 'sqlite' } } as never);
    await tick();
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'current', prompt: { text } } as never);
    release('OLD_CAUTION'); await tick();
    const system: unknown[] = [];
    await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
    assert.deepEqual(system, []);
    assert.equal(calls, 1);
  }
});

test('out-of-order prompt results retain only the current request memory', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const pending: Array<(value: string) => void> = [];
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: () => new Promise(resolve => pending.push(resolve)),
  }, () => undefined);
  for (const text of ['old request', 'current request']) {
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: text, prompt: { text } } as never);
    await tick();
  }
  pending[1]!('CURRENT_CAUTION'); await tick();
  pending[0]!('OLD_CAUTION'); await tick();
  const system: unknown[] = [];
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  assert.match(JSON.stringify(system), /CURRENT_CAUTION/);
  assert.doesNotMatch(JSON.stringify(system), /OLD_CAUTION/);
});

test('repeated identical queries can consume slow recall but cannot revive an earlier query epoch', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const pending: Array<(value: string) => void> = [];
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: () => new Promise(resolve => pending.push(resolve)),
  }, () => undefined);
  let message = 0;
  const prompt = async (text: string) => {
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: `msg-${++message}`, prompt: { text } } as never);
    await tick();
  };
  const context = async () => {
    const system: unknown[] = [];
    await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
    return JSON.stringify(system);
  };
  await prompt('sqlite'); await prompt('sqlite');
  pending[0]!('MATCHING_SLOW_RECALL'); await tick();
  assert.match(await context(), /MATCHING_SLOW_RECALL/);
  await prompt('css'); await prompt('sqlite');
  pending[1]!('EARLIER_SQLITE'); pending[2]!('UNRELATED_CSS'); await tick();
  assert.equal(await context(), '[]');
  pending[3]!('CURRENT_SQLITE'); await tick();
  assert.match(await context(), /CURRENT_SQLITE/);
});

test('model-switch refresh keeps the task query and cannot cross a new request boundary', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const pending: Array<{ query: string; resolve(value: string | undefined): void }> = [];
  const adapter = await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: query => new Promise(resolve => pending.push({ query, resolve })),
  }, () => undefined);
  await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'first', prompt: { text: 'sqlite' } } as never);
  await tick();
  adapter.observeEvent({ id: 'switch', type: 'session.model.selected', sessionId: 'ses_1' });
  await tick();
  assert.deepEqual(pending.map(call => call.query), ['sqlite', 'sqlite']);
  await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'next', prompt: { text: 'css' } } as never);
  await tick();
  pending[2]!.resolve('CURRENT_CSS'); await tick();
  pending[1]!.resolve('OLD_SWITCH_SQLITE'); pending[0]!.resolve('OLD_PROMPT_SQLITE'); await tick();
  const system: unknown[] = [];
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  assert.match(JSON.stringify(system), /CURRENT_CSS/);
  assert.doesNotMatch(JSON.stringify(system), /SQLITE/);
});

test('failed current recall does not restore earlier request memory', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const warnings: string[] = [];
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: async query => { if (query === 'sqlite') return 'SQLITE_CAUTION'; throw new Error('offline'); },
  }, warning => warnings.push(warning));
  for (const text of ['sqlite', 'css']) {
    await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: text, prompt: { text } } as never);
    await tick();
  }
  const system: unknown[] = [];
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  assert.deepEqual(system, []);
  assert.deepEqual(warnings, ['learning_context_failed']);
});

test('bounded context preserves complete source identities and does not mutate caller data', () => {
  const input = { items: [{ entryId: 'entry-a', source: 'event-a', summary: 'A'.repeat(3000) }, { entryId: 'entry-b', source: 'event-b', summary: 'B'.repeat(3000) }],
    handoff: { summary: 'handoff', source: 'event-c' }, principles: [] };
  const context = renderOpenCodeLearningContext(input, 5000)!;
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
