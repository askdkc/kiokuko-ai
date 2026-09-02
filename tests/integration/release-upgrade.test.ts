import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';

test('unknown non-empty SQLite schema is rejected without mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-release-unknown-db-'));
  const databasePath = path.join(root, 'unknown.sqlite3');
  const database = openConnection(databasePath);
  try {
    database.exec('CREATE TABLE unrelated_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
    database.prepare('INSERT INTO unrelated_data (id, value) VALUES (1, ?)').run('preserve');
  } finally {
    database.close();
  }
  const before = await readFile(databasePath);

  await assert.rejects(initializeDatabase({ databasePath }), (error: unknown) => (
    (error as { code?: string }).code === 'DATABASE_ERROR'
    && /unsupported schema/u.test((error as Error).message)
  ));

  assert.deepEqual(await readFile(databasePath), before);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('SELECT value FROM unrelated_data WHERE id = 1').get<{ value: string }>()?.value, 'preserve');
  } finally {
    unchanged.close();
  }
});
test('current empty database path initializes from the complete migration history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-release-empty-db-'));
  const databasePath = path.join(root, 'empty.sqlite3');
  await mkdir(root, { recursive: true });
  await writeFile(databasePath, Buffer.alloc(0));

  const result = await initializeDatabase({ databasePath });
  assert.deepEqual(result.applied, [1, 2]);
  assert.equal(result.currentVersion, 2);
  assert.equal(result.backupPath, null);
});
