import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmbeddingWorker } from '../../src/embedding/worker.js';
import type { EmbeddingDrainResult, EmbeddingRuntime } from '../../src/embedding/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const drainResult: EmbeddingDrainResult = {
  claimed: 1,
  completed: 1,
  failed: 0,
  blocked: 0,
  remaining: 0,
};

test('worker stop prevents a new claim while close aborts and joins the active drain', async () => {
  const callbacks: Array<() => void> = [];
  const drainStarted = deferred<void>();
  const releaseDrain = deferred<EmbeddingDrainResult>();
  let closeCalls = 0;
  const runtime: EmbeddingRuntime = {
    mode: 'optional',
    profileId: 'a'.repeat(64),
    backendId: null,
    backend: null,
    prepareQuery: async () => null,
    drain: async () => {
      drainStarted.resolve();
      return releaseDrain.promise;
    },
    close: async () => { closeCalls += 1; },
  };
  const worker = createEmbeddingWorker({
    runtime,
    intervalMs: 10,
    maxJobs: 1,
    deadlineMs: 1_000,
    setTimeout: ((callback: () => void) => {
      const timer = setTimeout(() => undefined, 1_000);
      callbacks.push(() => {
        clearTimeout(timer);
        callback();
      });
      return timer;
    }) as typeof setTimeout,
    clearTimeout: ((timer) => clearTimeout(timer)) as typeof clearTimeout,
  });

  worker.start();
  assert.equal(worker.running, true);
  callbacks.shift()?.();
  await drainStarted.promise;
  worker.stop();
  assert.equal(worker.running, false);
  releaseDrain.resolve(drainResult);
  await worker.close();
  assert.equal(closeCalls, 1);
  assert.equal(callbacks.length, 0);
});
