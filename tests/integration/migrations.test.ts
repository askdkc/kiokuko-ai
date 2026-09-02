import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { loadMigrationSnapshot, migrateDatabase } from '../../src/db/migrate.js';

test('the v0.1.0 database has one canonical initial migration and is idempotent', () => {
  const database = openConnection(':memory:');
  try {
    const first = migrateDatabase(database);
    assert.deepEqual(first.applied, [1]);
    assert.equal(first.currentVersion, 1);
    assert.deepEqual(migrateDatabase(database).applied, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'entries'").get()?.['1'], 1);
  } finally {
    database.close();
  }
});
test('a future migration remains a generic, checksum-bound migration concern', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-migration-future-'));
  const migrations = path.join(root, 'migrations');
  await mkdir(migrations);
  await writeFile(path.join(migrations, '001_initial.sql'), 'CREATE TABLE baseline (id INTEGER PRIMARY KEY);\n');
  const database = openConnection(path.join(root, 'database.sqlite3'));
  try {
    assert.deepEqual(migrateDatabase(database, migrations).applied, [1]);
    await writeFile(path.join(migrations, '002_feature.sql'), 'ALTER TABLE baseline ADD COLUMN feature TEXT;\n');
    assert.deepEqual(loadMigrationSnapshot(migrations).migrations.map(({ version }) => version), [1, 2]);
    assert.deepEqual(migrateDatabase(database, migrations).applied, [2]);
    assert.equal(database.prepare("SELECT name FROM pragma_table_info('baseline') WHERE name = 'feature'").get<{ name: string }>()?.name, 'feature');
  } finally {
    database.close();
  }
});
