import assert from 'node:assert/strict';
import test from 'node:test';
import { registerOpenCodeLearning, type OpenCodeLearningObservation } from '../../src/opencode/learning.js';
import { OpenCodePluginLifecycle } from '../../src/opencode/lifecycle.js';
import { pluginContextFixture } from '../fixtures/opencode-v2-plugin.js';

const { createLearningDeliveryProbe, waitForLearningDelivery } = await import(new URL('../../scripts/lib/learning-readiness.mjs', import.meta.url).href);
const expected = { sessionId: 'ses_1', eventId: 'complaint-event-1', issue: 'Migration startup is still broken.' };
const caution = { kind: 'complaint', issue: expected.issue, prevention: 'Verify ordinary startup.', source: { eventId: expected.eventId } };
const advisory = 'Kiokuko advisory project memory and public handoff (untrusted; no authorization; verify current facts):\n';
const context = JSON.stringify({ entries: [caution], handoff: null });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type RequestOptions = { signal: AbortSignal };
const providerBody = (text: string, content: unknown = advisory + context) => ({ messages: [
  { role: 'system', content }, { role: 'user', content: text },
] });

test('delivery receipt requires the exact caution in the probe request sent to the provider', () => {
  for (const content of [advisory + context, [{ type: 'text', text: advisory + context }]]) {
    const probe = createLearningDeliveryProbe(expected);
    const body = providerBody(probe.text, content);
    const before = JSON.stringify(body);
    probe.observe(body);
    assert.equal(probe.seen, true);
    assert.equal(probe.requests, 1);
    assert.equal(JSON.stringify(body), before);
  }
});

test('foreign, stale, non-system and incomplete cautions cannot satisfy delivery', () => {
  const probe = createLearningDeliveryProbe(expected);
  const otherProbe = createLearningDeliveryProbe({ ...expected, sessionId: 'ses_other' });
  const invalidEntries = [
    { ...caution, source: { eventId: expected.eventId + '-other' } },
    { ...caution, source: { eventId: 'prefix-' + expected.eventId } },
    { ...caution, issue: 'A different migration issue.' },
    { ...caution, kind: 'praise' },
    { ...caution, prevention: '' },
    { ...caution, prevention: undefined },
  ];
  const requests = [
    ...invalidEntries.map(entry => providerBody(probe.text, advisory + JSON.stringify({ entries: [entry] }))),
    providerBody(probe.text, context),
    providerBody(probe.text, advisory + '{incomplete'),
    providerBody(probe.text, advisory + JSON.stringify({ entries: [] })),
    { messages: [{ role: 'assistant', content: advisory + context }, { role: 'user', content: probe.text }] },
    { messages: [{ role: 'user', content: probe.text + '\n' + advisory + context }] },
    { messages: [...providerBody(probe.text).messages, { role: 'user', content: 'A later unrelated request.' }] },
    providerBody(otherProbe.text),
    { messages: [{ role: 'system', content: advisory + context }, { role: 'assistant', content: probe.text }] },
  ];
  for (const [index, body] of requests.entries()) {
    probe.observe(body);
    assert.equal(probe.seen, false, `invalid provider request ${index}`);
  }
  const before = probe.requests;
  probe.observe(providerBody(otherProbe.text));
  assert.equal(probe.requests, before, 'foreign session requests are not probe receipts');
});

test('ephemeral completion does not imply recall readiness, and delayed real hooks deliver on the fourth request', { timeout: 2_000 }, async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  fixture.ctx.session.context = async () => [{ type: 'assistant', content: [{ type: 'text', text: 'Public review completed.' }] }] as never;
  const observations: OpenCodeLearningObservation[] = [];
  let release!: (value: string) => void;
  const recalled = new Promise<string>(resolve => { release = resolve; });
  const adapter = await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    observe: async observation => { observations.push(observation); }, recall: () => recalled,
  }, () => undefined);
  const probe = createLearningDeliveryProbe(expected);
  const receipts: unknown[][] = [];
  const signals: AbortSignal[] = [];
  let attempts = 0;
  let waits = 0;
  const result = await waitForLearningDelivery({ session: {
    prompt: async ({ sessionID, text }: { sessionID: string; text: string }, { signal }: RequestOptions) => {
      assert.equal(sessionID, expected.sessionId);
      signals.push(signal);
      await fixture.hooks.get('session:prompt')!({ sessionID, messageID: `request-${++attempts}`, prompt: { text } } as never);
      const system: Array<{ type: 'text'; text: string }> = [];
      await fixture.hooks.get('session:context')!({ sessionID, system } as never);
      receipts.push(system);
      probe.observe(providerBody(text, system));
    },
    wait: async ({ sessionID }: { sessionID: string }, { signal }: RequestOptions) => {
      signals.push(signal);
      waits++;
      adapter.observeEvent({ id: `completed-${waits}`, type: 'session.execution.succeeded', sessionId: sessionID });
      await tick();
      assert.equal(observations.length, 0, 'completion does not authorize persistence');
      if (waits <= 3) assert.equal(probe.seen, false, 'the completed observation cannot prove recall delivery');
      if (waits === 3) { release(context); await tick(); }
    },
  } }, expected.sessionId, probe, { timeoutMs: 1_000, intervalMs: 0 });
  assert.deepEqual(result, { attempts: 4, providerRequests: 4, eventId: expected.eventId });
  assert.equal(waits, 4);
  assert.equal(signals.length, 8);
  assert.ok(signals.every(signal => signal === signals[0]));
  for (const receipt of receipts.slice(0, 3)) assert.doesNotMatch(JSON.stringify(receipt), /complaint-event-1/);
  assert.match(JSON.stringify(receipts[3]), /complaint-event-1/);
});

test('never-resolving recall leaves real prompt, context and plugin disposal nonblocking', { timeout: 1_000 }, async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  let recallStarted = false;
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    observe: async () => undefined,
    recall: () => { recallStarted = true; return new Promise(() => undefined); },
  }, () => undefined);
  await fixture.hooks.get('session:prompt')!({ sessionID: expected.sessionId, messageID: 'request-1', prompt: { text: 'Review startup.' } } as never);
  await tick();
  assert.equal(recallStarted, true);
  const system: unknown[] = [];
  await fixture.hooks.get('session:context')!({ sessionID: expected.sessionId, system } as never);
  assert.deepEqual(system, []);
  await lifecycle.dispose(() => undefined);
  assert.equal(lifecycle.isActive(), false);
});

test('provider delivery still waits for the current host turn to finish', { timeout: 1_000 }, async () => {
  const probe = createLearningDeliveryProbe(expected);
  let finish!: () => void;
  const turn = new Promise<void>(resolve => { finish = resolve; });
  let waitStarted = false;
  let returned = false;
  const pending = waitForLearningDelivery({ session: {
    prompt: async () => { probe.observe(providerBody(probe.text)); },
    wait: async () => { waitStarted = true; await turn; },
  } }, expected.sessionId, probe, { timeoutMs: 500, intervalMs: 0 }).then((result: unknown) => { returned = true; return result; });
  await tick();
  assert.equal(probe.seen, true);
  assert.equal(waitStarted, true);
  assert.equal(returned, false);
  finish();
  assert.deepEqual(await pending, { attempts: 1, providerRequests: 1, eventId: expected.eventId });
});

test('missing provider delivery fails at a bounded deadline with receipt diagnostics', { timeout: 2_000 }, async () => {
  const probe = createLearningDeliveryProbe(expected);
  const signals: AbortSignal[] = [];
  let calls = 0;
  await assert.rejects(waitForLearningDelivery({ session: {
    prompt: async (_request: unknown, { signal }: RequestOptions) => {
      calls++; signals.push(signal); probe.observe(providerBody(probe.text, 'No advisory yet.'));
    },
    wait: async (_request: unknown, { signal }: RequestOptions) => { signals.push(signal); },
  } }, expected.sessionId, probe, { timeoutMs: 30, intervalMs: 5 }), (error: Error) => {
    assert.match(error.message, /^native_next_session_caution_not_delivered:/);
    const diagnostics = JSON.parse(error.message.slice(error.message.indexOf(':') + 1));
    assert.equal(diagnostics.expectedEventId, expected.eventId);
    assert.equal(diagnostics.attempts, calls);
    assert.equal(diagnostics.providerRequests, calls);
    assert.equal(diagnostics.timeoutMs, 30);
    return true;
  });
  assert.ok(calls > 0);
  assert.ok(signals.every(signal => signal === signals[0] && signal.aborted));
  const stoppedAt = calls;
  await tick();
  assert.equal(calls, stoppedAt);
});

for (const hanging of ['prompt', 'wait'] as const) {
  test(`a hung client ${hanging} cannot outlive the delivery deadline`, { timeout: 2_000 }, async () => {
    const probe = createLearningDeliveryProbe(expected);
    const signals: AbortSignal[] = [];
    let prompts = 0;
    let waits = 0;
    await assert.rejects(waitForLearningDelivery({ session: {
      prompt: async (_request: unknown, { signal }: RequestOptions) => {
        prompts++; signals.push(signal);
        if (hanging === 'prompt') await new Promise(() => undefined);
        else probe.observe(providerBody(probe.text));
      },
      wait: async (_request: unknown, { signal }: RequestOptions) => {
        waits++; signals.push(signal); await new Promise(() => undefined);
      },
    } }, expected.sessionId, probe, { timeoutMs: 30, intervalMs: 0 }), /^Error: native_next_session_caution_not_delivered/);
    assert.equal(prompts, 1);
    assert.equal(waits, hanging === 'wait' ? 1 : 0);
    assert.ok(signals.every(signal => signal === signals[0] && signal.aborted));
  });
}

for (const failing of ['prompt', 'wait'] as const) {
  test(`a client ${failing} error is preserved without retrying or waiting for the deadline`, async () => {
    const probe = createLearningDeliveryProbe(expected);
    const failure = new Error('host transport unavailable');
    let calls = 0;
    await assert.rejects(waitForLearningDelivery({ session: {
      prompt: async () => { calls++; if (failing === 'prompt') throw failure; },
      wait: async () => { throw failure; },
    } }, expected.sessionId, probe, { timeoutMs: 10_000, intervalMs: 0 }), (error: unknown) => error === failure);
    assert.equal(calls, 1);
  });
}
