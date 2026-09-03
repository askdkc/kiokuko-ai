import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { KiokukoError } from '../../src/errors.js';
import { CURRENT_SCHEMA_VERSION } from '../fixtures/current-migrations.js';
import { openConnection } from '../../src/db/connection.js';

test('initializes an isolated database and applies migrations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-'));
  const databasePath = path.join(directory, 'data', 'kiokuko-ai.sqlite');
  const result = await initializeDatabase({ databasePath });
  assert.equal(result.databasePath, databasePath);
  await access(databasePath);
  assert.equal(result.currentVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(result.backupPath, null);
  assert.equal(result.capabilities.driver, 'node:sqlite');
  assert.equal(result.capabilities.foreignKeys, true);
  assert.equal(result.capabilities.journalMode, 'wal');
  assert.equal(result.capabilities.busyTimeout, 5000);
});

test('rejects an in-memory database before loading or applying migrations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-memory-'));
  const missingMigrationsDirectory = path.join(directory, 'missing-migrations');

  await assert.rejects(
    initializeDatabase({
      databasePath: ':memory:',
      migrationsDirectory: missingMigrationsDirectory,
    }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'VALIDATION_ERROR'
      && /persistent WAL mode/u.test(error.message),
  );
});

test('rejects an obsolete alpha schema without modifying or backing up the database', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-obsolete-'));
  const databasePath = path.join(directory, 'obsolete.sqlite3');
  const obsolete = openConnection(databasePath);
  obsolete.exec('CREATE TABLE obsolete_alpha_data (value TEXT NOT NULL)');
  obsolete.prepare('INSERT INTO obsolete_alpha_data (value) VALUES (?)').run('preserve-me');
  obsolete.close();
  const before = await readFile(databasePath);

  await assert.rejects(
    initializeDatabase({ databasePath }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'DATABASE_ERROR'
      && error.message === 'This database uses an obsolete alpha schema. Preserve it if needed, remove or relocate it, then run kiokuko-ai setup again. No in-place migration is supported.',
  );

  assert.deepEqual(await readFile(databasePath), before);
  await assert.rejects(access(`${databasePath}.backup`));
});
