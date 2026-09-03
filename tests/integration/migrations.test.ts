import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { loadMigrationSnapshot, migrateDatabase } from '../../src/db/migrate.js';
import { CURRENT_MIGRATION_VERSIONS, CURRENT_SCHEMA_VERSION } from '../fixtures/current-migrations.js';

test('the current database has canonical migrations and is idempotent', () => {
  const database = openConnection(':memory:');
  try {
    const first = migrateDatabase(database);
    assert.deepEqual(first.applied, CURRENT_MIGRATION_VERSIONS);
    assert.equal(first.currentVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(migrateDatabase(database).applied, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, CURRENT_MIGRATION_VERSIONS.length);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'entries'").get()?.['1'], 1);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'enno_opencode_continuation_receipts'").get()?.['1'], 1);
    assert.equal(database.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version, CURRENT_SCHEMA_VERSION);
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
