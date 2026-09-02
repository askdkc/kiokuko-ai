import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { SqliteVecLoadError } from '../../src/db/connection.js';
import { openEmbeddingDatabase } from '../../src/embedding/backend.js';
import type { EmbeddingConfig, VectorSearchBackend } from '../../src/embedding/types.js';
import type { SqliteVecLoader } from '../../src/embedding/sqlite-vec-loader.js';
import { KiokukoError } from '../../src/errors.js';

const enabledConfig = (overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig => ({
  mode: 'optional',
  provider: 'local-transformers',
  presetId: 'local-small',
  vectorBackend: 'auto',
  timeoutMs: 30_000,
  batchSize: 16,
  ...overrides,
});

function fakeDatabase(): SqliteDatabase {
  return {
    filePath: ':memory:',
    exec: () => undefined,
    prepare: () => { throw new Error('not used'); },
    close: () => undefined,
  };
}

const fakeLoader = {
  id: 'sqlite-vec',
  packageVersion: '0.1.9',
  extensionVersion: 'v0.1.9',
  load: () => undefined,
} as SqliteVecLoader;

test('embedding database composition loads sqlite-vec only for an enabled native-capable preference', async () => {
  let loaderCalls = 0;
  const openOptions: unknown[] = [];
  const database = fakeDatabase();
  const opened = await openEmbeddingDatabase(':memory:', {
    config: enabledConfig(),
    createLoader: async () => { loaderCalls += 1; return fakeLoader; },
    openDatabase: (_path, options) => { openOptions.push(options); return database; },
  });

  assert.equal(loaderCalls, 1);
  assert.equal(opened.database, database);
  assert.equal(opened.backend?.id, 'sqlite-vec');
  assert.equal((openOptions[0] as { sqliteVecLoader?: unknown }).sqliteVecLoader, fakeLoader);
});

test('embedding database composition keeps off mode extension-free and honors an injected backend', async () => {
  let loaderCalls = 0;
  const database = fakeDatabase();
  const injected: VectorSearchBackend = { id: 'test-backend', search: () => [] };
  const off = await openEmbeddingDatabase(':memory:', {
    config: enabledConfig({ mode: 'off' }),
    createLoader: async () => { loaderCalls += 1; return fakeLoader; },
    openDatabase: () => database,
  });
  const selected = await openEmbeddingDatabase(':memory:', {
    config: enabledConfig(),
    backend: injected,
    createLoader: async () => { loaderCalls += 1; return fakeLoader; },
    openDatabase: () => database,
  });

  assert.equal(loaderCalls, 0);
  assert.equal(off.backend, undefined);
  assert.equal(selected.backend, injected);
});

test('embedding database composition falls back only for an unavailable optional extension', async () => {
  let opens = 0;
  const database = fakeDatabase();
  const opened = await openEmbeddingDatabase(':memory:', {
    config: enabledConfig(),
    createLoader: async () => fakeLoader,
    openDatabase: (_path, options) => {
      opens += 1;
      if (options?.sqliteVecLoader !== undefined) {
        throw new SqliteVecLoadError('extension unavailable');
      }
      return database;
    },
  });

  assert.equal(opens, 2);
  assert.equal(opened.backend?.id, 'javascript');

  await assert.rejects(
    () => openEmbeddingDatabase(':memory:', {
      config: enabledConfig(),
      createLoader: async () => fakeLoader,
      openDatabase: () => { throw new KiokukoError('DATABASE_ERROR', 'database unavailable'); },
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'DATABASE_ERROR',
  );

  await assert.rejects(
    () => openEmbeddingDatabase(':memory:', {
      config: enabledConfig(),
      createLoader: async () => fakeLoader,
      openDatabase: () => { throw new KiokukoError('SERVICE_UNAVAILABLE', 'database unavailable'); },
    }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'SERVICE_UNAVAILABLE'
      && !(error instanceof SqliteVecLoadError),
  );
});

test('forced sqlite-vec fails before opening when the package is unavailable in either mode', async () => {
  for (const mode of ['optional', 'required'] as const) {
    let opens = 0;
    await assert.rejects(
      () => openEmbeddingDatabase(':memory:', {
        config: enabledConfig({ mode, vectorBackend: 'sqlite-vec' }),
        createLoader: async () => null,
        openDatabase: () => { opens += 1; return fakeDatabase(); },
      }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'SERVICE_UNAVAILABLE',
    );
    assert.equal(opens, 0);
  }
});
