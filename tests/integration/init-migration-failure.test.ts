import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';

test('initializeDatabase keeps the verified backup and rolls back a failing future migration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-migration-failure-'));
  const initialMigrations = path.join(root, 'initial-migrations');
  const brokenMigrations = path.join(root, 'broken-migrations');
  await Promise.all([initialMigrations, brokenMigrations].map((directory) => mkdir(directory)));
  const initialSql = 'CREATE TABLE preserved_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n';
  await writeFile(path.join(initialMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(brokenMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(brokenMigrations, '002_broken.sql'), `
    CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);
    SELECT missing_column FROM missing_table;
  `);
  const databasePath = path.join(root, 'data.sqlite3');
  const initial = openConnection(databasePath);
  try {
    migrateDatabase(initial, initialMigrations);
    initial.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('keep me');
  } finally {
    initial.close();
  }

  await assert.rejects(initializeDatabase({ databasePath, migrationsDirectory: brokenMigrations }), /missing_table|no such/i);
  const backups = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite3'));
  assert.equal(backups.length, 1);

  for (const candidate of [databasePath, path.join(root, 'backups', backups[0]!)]) {
    const database = openConnection(candidate, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
      assert.equal(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(), undefined);
    } finally {
      database.close();
    }
  }
});

test('initializeDatabase rolls back a future migration whose final foreign-key check fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-post-foreign-key-'));
  const initialMigrations = path.join(root, 'initial-migrations');
  const futureMigrations = path.join(root, 'future-migrations');
  await Promise.all([initialMigrations, futureMigrations].map((directory) => mkdir(directory)));
  const initialSql = 'CREATE TABLE parent_rows (id INTEGER PRIMARY KEY);\n';
  await writeFile(path.join(initialMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(futureMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(futureMigrations, '002_deferred_orphan.sql'), `
    PRAGMA defer_foreign_keys = ON;
    CREATE TABLE orphan_rows (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent_rows(id) DEFERRABLE INITIALLY DEFERRED
    );
    INSERT INTO orphan_rows (id, parent_id) VALUES (1, 999);
  `);
  const databasePath = path.join(root, 'data.sqlite3');
  const source = openConnection(databasePath);
  try {
    assert.deepEqual(migrateDatabase(source, initialMigrations).applied, [1]);
  } finally {
    source.close();
  }

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: futureMigrations }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && error.details.stage === 'after',
  );
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
    assert.equal(
      unchanged.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'orphan_rows'").get(),
      undefined,
    );
    assert.deepEqual(unchanged.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    unchanged.close();
  }
});
