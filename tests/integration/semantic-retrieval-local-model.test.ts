import assert from 'node:assert/strict';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createEmbeddingRuntime } from '../../src/embedding/runtime.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { createLocalTransformersModelLoader } from '../../src/embedding/local-model-loader.js';
import { activateLocalEmbeddingProfile } from '../../src/embedding/store.js';
import type { EmbeddingProvider } from '../../src/embedding/types.js';
import { recordEntry } from '../../src/memory/entries.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('local loader requests offline q8 mean-normalized feature extraction', async () => {
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET).identity;
  let requested: unknown;
  const loader = createLocalTransformersModelLoader({
    verifyInstallation: false,
    pipeline: async (task, model, options) => {
      requested = { task, model, options };
      return async (inputs, callOptions) => {
        assert.deepEqual(callOptions, { pooling: 'mean', normalize: true });
        const data = new Float32Array(inputs.length * 384);
        for (let row = 0; row < inputs.length; row += 1) data[row * 384] = 1;
        return { dims: [inputs.length, 384], data };
      };
    },
  });
  const runtime = await loader.load(profile, '/verified/local-model-root');
  const vectors = await runtime.embed(['query: idempotent retry handling', 'passage: duplicate requests are safe']);
  assert.deepEqual(requested, {
    task: 'feature-extraction',
    model: '/verified/local-model-root',
    options: { dtype: 'q8' },
  });
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0]?.length, 384);
  assert.equal(vectors[0]?.[0], 1);
  await runtime.dispose?.();
});

test('local runtime renders v2 inputs and shares concurrent query cache misses', async () => {
  const database = openConnection(':memory:');
  const timestamp = '2026-08-31T00:00:00.000Z';
  try {
    migrateDatabase(database);
    const active = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    recordEntry(database, {
      workspace: 'project:local-runtime',
      kind: 'lesson',
      title: 'Local runtime document',
      body: 'The local runtime must use the passage input contract.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-local-runtime', now: timestamp });

    let calls = 0;
    let closes = 0;
    const queryStarted = deferred<void>();
    const releaseQuery = deferred<void>();
    const received: string[] = [];
    const provider: EmbeddingProvider & { close(): Promise<void> } = {
      profile: active.identity,
      async embed(inputs) {
        calls += 1;
        received.push(...inputs);
        if (inputs[0]?.startsWith('query: ') === true) {
          queryStarted.resolve();
          await releaseQuery.promise;
        }
        return inputs.map(() => {
          const vector = new Float32Array(384);
          vector[0] = 1;
          return vector;
        });
      },
      async close() {
        closes += 1;
      },
    };
    const runtime = createEmbeddingRuntime(database, {
      mode: 'optional',
      provider: 'local-transformers',
      presetId: 'local-small',
      vectorBackend: 'javascript',
      timeoutMs: 30_000,
      batchSize: 16,
    }, { provider, now: () => timestamp });

    const drain = await runtime.drain({ maxJobs: 1, deadlineMs: 5_000 });
    assert.deepEqual(drain, { claimed: 1, completed: 1, failed: 0, blocked: 0, remaining: 0 });
    assert.ok(received[0]?.startsWith('passage: '));

    const first = runtime.prepareQuery(database, 'local query');
    await queryStarted.promise;
    const second = runtime.prepareQuery(database, 'local query');
    releaseQuery.resolve();
    const [firstQuery, secondQuery] = await Promise.all([first, second]);
    assert.ok(firstQuery);
    assert.ok(secondQuery);
    assert.equal(firstQuery?.vectorHash, secondQuery?.vectorHash);
    assert.equal(calls, 2);
    assert.equal(received.filter((input) => input.startsWith('query: ')).length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM query_embeddings').get<{ count: number }>()?.count, 1);

    await runtime.close();
    await runtime.close();
    assert.equal(closes, 1);
  } finally {
    database.close();
  }
});
