import assert from 'node:assert/strict';
import test from 'node:test';
import { withEmbeddingSetupLock } from '../../src/embedding/setup-lock.js';

test('embedding setup lock releases after success and failure', async () => {
  const events: string[] = [];
  const value = await withEmbeddingSetupLock({
    path: '/lock',
    release: async () => { events.push('release'); },
  }, async () => { events.push('operation'); return 42; });
  assert.equal(value, 42);
  assert.deepEqual(events, ['operation', 'release']);

  await assert.rejects(withEmbeddingSetupLock({
    path: '/lock',
    release: async () => { events.push('failed-release'); },
  }, async () => { throw new Error('operation failed'); }), /operation failed/u);
  assert.equal(events.at(-1), 'failed-release');
});

test('embedding setup lock reports both operation and release failures', async () => {
  await assert.rejects(withEmbeddingSetupLock({
    path: '/lock',
    release: async () => { throw new Error('release failed'); },
  }, async () => { throw new Error('operation failed'); }), (error: unknown) => (
    error instanceof AggregateError
    && error.errors.length === 2
    && error.errors.every((item) => item instanceof Error)
  ));
});
