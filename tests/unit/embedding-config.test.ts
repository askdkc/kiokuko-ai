import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { readPersistedEmbeddingSettings } from '../../src/embedding/settings.js';

test('defaults embeddings to the disabled local v0.1.0 contract', () => {
  const config = parseEmbeddingConfig({});
  assert.deepEqual(config, {
    mode: 'off',
    provider: 'local-transformers',
    vectorBackend: 'auto',
    timeoutMs: 30_000,
    batchSize: 16,
  });
});

test('parses the enabled local-small contract without endpoint settings', () => {
  const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig({
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_VECTOR_BACKEND: 'javascript',
    KIOKUKO_EMBEDDING_TIMEOUT_MS: '5000',
    KIOKUKO_EMBEDDING_BATCH_SIZE: '4',
  }));
  assert.deepEqual(config, {
    mode: 'optional',
    provider: 'local-transformers',
    presetId: 'local-small',
    vectorBackend: 'javascript',
    timeoutMs: 5000,
    batchSize: 4,
  });
});

test('rejects unsupported mode, backend, and numeric settings', () => {
  assert.throws(() => parseEmbeddingConfig({ KIOKUKO_EMBEDDINGS: 'sometimes' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => parseEmbeddingConfig({ KIOKUKO_VECTOR_BACKEND: 'native' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => parseEmbeddingConfig({ KIOKUKO_EMBEDDING_TIMEOUT_MS: '99' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => parseEmbeddingConfig({ KIOKUKO_EMBEDDING_BATCH_SIZE: '65' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => requireEnabledEmbeddingConfig(parseEmbeddingConfig({})), { code: 'VALIDATION_ERROR' });
});

test('ignores unrelated embedding environment variables', () => {
  const config = parseEmbeddingConfig({
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_UNRELATED: 'ignored',
  });
  assert.equal(config.provider, 'local-transformers');
  assert.equal(config.presetId, 'local-small');
});

test('reads persisted off settings as the local provider contract', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const config = readPersistedEmbeddingSettings(database);
    assert.equal(config.mode, 'off');
    assert.equal(config.provider, 'local-transformers');
  } finally {
    database.close();
  }
});
