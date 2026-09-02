import assert from 'node:assert/strict';
import test from 'node:test';
import { WriteQueue } from '../../src/server/write-queue.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('rejects a non-positive or non-integer waiting capacity', () => {
  for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new WriteQueue<unknown>(capacity), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'VALIDATION_ERROR');
      assert.deepEqual((error as { details: Record<string, unknown> }).details, {});
      return true;
    });
  }
});

test('starts accepting work while idle with no running or waiting items', () => {
  const queue = new WriteQueue<unknown>(2);

  assert.deepEqual(queue.state, { accepting: true, running: false, waiting: 0 });
  assert.equal(queue.accepting, true);
  assert.equal(queue.running, false);
  assert.equal(queue.waiting, 0);
});

test('executes an enqueued operation and removes it after settlement', async () => {
  const queue = new WriteQueue<string>(2);

  const result = queue.enqueue(async () => 'completed');

  assert.equal(await result, 'completed');
  assert.deepEqual(queue.state, { accepting: true, running: false, waiting: 0 });
});

test('drain resolves immediately while idle', async () => {
  const queue = new WriteQueue<unknown>(1);

  await queue.drain();

  assert.deepEqual(queue.state, { accepting: true, running: false, waiting: 0 });
});

test('drain waits for running and waiting operations to finish', async () => {
  const queue = new WriteQueue<string>(2);
  const started = deferred<void>();
  const release = deferred<void>();
  let drained = false;

  const running = queue.enqueue(async () => {
    started.resolve();
    await release.promise;
    return 'running';
  });
  await started.promise;
  const waiting = queue.enqueue(async () => 'waiting');
  const drainPromise = queue.drain().then(() => {
    drained = true;
  });

  await Promise.resolve();
  assert.equal(drained, false);
  assert.deepEqual(queue.state, { accepting: true, running: true, waiting: 1 });

  release.resolve();
  assert.equal(await running, 'running');
  assert.equal(await waiting, 'waiting');
  await drainPromise;
  assert.equal(drained, true);
});

test('close is idempotent, rejects new work, and drains accepted work', async () => {
  const queue = new WriteQueue<string>(1);
  const started = deferred<void>();
  const release = deferred<void>();

  const running = queue.enqueue(async () => {
    started.resolve();
    await release.promise;
    return 'running';
  });
  await started.promise;
  const waiting = queue.enqueue(async () => 'waiting');

  const firstClose = queue.close();
  const secondClose = queue.close();
  assert.equal(queue.accepting, false);

  await assert.rejects(queue.enqueue(async () => 'rejected'), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'SERVICE_UNAVAILABLE');
    assert.equal((error as { exitCode: number }).exitCode, 6);
    assert.deepEqual((error as { details: Record<string, unknown> }).details, {});
    return true;
  });

  release.resolve();
  assert.equal(await running, 'running');
  assert.equal(await waiting, 'waiting');
  await firstClose;
  await secondClose;
  assert.deepEqual(queue.state, { accepting: false, running: false, waiting: 0 });
});

test('rejects one failed operation while continuing with the next FIFO operation', async () => {
  const queue = new WriteQueue<string>(2);
  const failure = new Error('operation failed');
  const failed = queue.enqueue(async () => {
    throw failure;
  });
  const succeeded = queue.enqueue(async () => 'next');

  await assert.rejects(failed, (error: unknown) => error === failure);
  assert.equal(await succeeded, 'next');
  assert.deepEqual(queue.state, { accepting: true, running: false, waiting: 0 });
});

test('executes queued operations in FIFO order with one operation running at a time', async () => {
  const queue = new WriteQueue<string>(2);
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondStarted = deferred<void>();
  let active = 0;
  let maximumActive = 0;
  let secondHasStarted = false;
  const order: string[] = [];

  const first = queue.enqueue(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push('first');
    firstStarted.resolve();
    await releaseFirst.promise;
    active -= 1;
    return 'first';
  });
  await firstStarted.promise;

  const second = queue.enqueue(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push('second');
    secondHasStarted = true;
    secondStarted.resolve();
    active -= 1;
    return 'second';
  });

  assert.equal(queue.waiting, 1);
  assert.equal(secondHasStarted, false);
  releaseFirst.resolve();

  assert.equal(await first, 'first');
  await secondStarted.promise;
  assert.equal(await second, 'second');
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(maximumActive, 1);
});

test('settles the completed write for its caller before starting the next queued mutation', async () => {
  const queue = new WriteQueue<string>(2);
  const releaseFirst = deferred<void>();
  let secondStarted = false;
  const first = queue.enqueue(async () => {
    await releaseFirst.promise;
    return 'first';
  });
  const second = queue.enqueue(async () => {
    secondStarted = true;
    return 'second';
  });

  releaseFirst.resolve();
  assert.equal(await first, 'first');
  assert.equal(secondStarted, false, 'the caller must be able to attest its committed state first');
  assert.equal(await second, 'second');
});

test('rejects immediately at waiting capacity without running the rejected operation', async () => {
  const queue = new WriteQueue<string>(1);
  const started = deferred<void>();
  const release = deferred<void>();
  let rejectedOperationRan = false;

  const running = queue.enqueue(async () => {
    started.resolve();
    await release.promise;
    return 'running';
  });
  await started.promise;

  const waiting = queue.enqueue(async () => 'waiting');
  assert.equal(queue.waiting, 1);

  const rejected = queue.enqueue(async () => {
    rejectedOperationRan = true;
    return 'rejected';
  });

  await assert.rejects(rejected, (error: unknown) => {
    assert.equal((error as { code: string }).code, 'BACKPRESSURE');
    assert.equal((error as { exitCode: number }).exitCode, 6);
    assert.equal((error as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds, 1);
    return true;
  });
  assert.equal(rejectedOperationRan, false);

  release.resolve();
  assert.equal(await running, 'running');
  assert.equal(await waiting, 'waiting');
});
