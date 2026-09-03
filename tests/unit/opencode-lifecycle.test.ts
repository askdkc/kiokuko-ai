import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodePluginLifecycle } from '../../src/opencode/lifecycle.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('plugin lifecycle single-flights reconciliation and allows independent event work', async () => {
  const lifecycle = new OpenCodePluginLifecycle();
  const gate = deferred();
  let reconciles = 0;
  let events = 0;
  const first = lifecycle.reconcile(async () => { reconciles += 1; await gate.promise; });
  const replay = lifecycle.reconcile(async () => { reconciles += 1; });
  const event = lifecycle.run(async () => { events += 1; });
  assert.equal(first, replay);
  await event;
  assert.equal(events, 1);
  assert.equal(reconciles, 1);
  gate.resolve();
  await first;
});

test('plugin disposal stops ingress, aborts owned work, and waits for settlement', async () => {
  const lifecycle = new OpenCodePluginLifecycle();
  let stopped = 0;
  let settled = false;
  const running = lifecycle.run(async () => {
    await new Promise<void>((resolve) => lifecycle.signal.addEventListener('abort', () => resolve(), { once: true }));
    settled = true;
  });
  await lifecycle.dispose(() => { stopped += 1; });
  assert.equal(stopped, 1);
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(settled, true);
  await running;
  let startedAfterDispose = false;
  await lifecycle.run(async () => { startedAfterDispose = true; });
  assert.equal(startedAfterDispose, false);
  await lifecycle.dispose(() => { stopped += 1; });
  assert.equal(stopped, 1);
});

test('plugin disposal reports an in-flight failure instead of hiding it', async () => {
  const lifecycle = new OpenCodePluginLifecycle();
  const gate = deferred();
  void lifecycle.run(async () => { await gate.promise; throw new Error('in-flight failure'); }).catch(() => undefined);
  const disposal = lifecycle.dispose(() => undefined);
  gate.resolve();
  await assert.rejects(disposal, AggregateError);
});
