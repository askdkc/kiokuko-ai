import assert from 'node:assert/strict';
import test from 'node:test';
import { McpRuntimeOwner } from '../../src/mcp/runtime-owner.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';

function fakeDatabase(onClose: () => void): SqliteDatabase {
  return {
    filePath: ':memory:',
    exec: () => undefined,
    prepare: () => {
      throw new Error('not used');
    },
    close: onClose,
  };
}

test('MCP runtime owner initializes once, shares its connection, and closes idempotently', async () => {
  let initializations = 0;
  let closes = 0;
  const database = fakeDatabase(() => { closes += 1; });
  const owner = new McpRuntimeOwner({
    databasePath: ':memory:',
    initializeDatabase: () => { initializations += 1; },
    openDatabase: () => database,
    embeddingConfig: {
      mode: 'off',
      provider: 'local-transformers',
      vectorBackend: 'auto',
      timeoutMs: 30_000,
      batchSize: 16,
    },
  });

  const paths = await Promise.all([
    owner.withDatabase((connection) => connection.filePath),
    owner.withDatabase((connection) => connection.filePath),
  ]);
  assert.deepEqual(paths, [':memory:', ':memory:']);
  assert.equal(initializations, 1);
  await Promise.all([owner.close(), owner.close()]);
  assert.equal(closes, 1);
  await assert.rejects(
    () => owner.withDatabase(() => 'unavailable'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE',
  );
});
