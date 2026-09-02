import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSqliteCapabilityContract } from '../../tests/fixtures/sqlite-capability-contract.js';

test('node:sqlite satisfies the Kiokuko capability contract', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-capability-test-'));
  const database = new DatabaseSync(path.join(directory, 'data.sqlite3'));
  try {
    const result = await assertSqliteCapabilityContract(database);
    assert.equal(result.fts5, true);
    assert.equal(result.wal, true);
    assert.equal(result.integrityCheck, true);
    assert.equal(result.backup, true);
  } finally {
    database.close();
  }
});
