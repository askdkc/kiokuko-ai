import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SqliteSerializationDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { createPreMigrationBackup } from '../../src/db/upgrade-backup.js';
import { KiokukoError } from '../../src/errors.js';

test('pre-migration backup exposes a fixed public error while retaining the private cause non-enumerably', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-upgrade-backup-'));
  const sentinel = 'private-backup-error-sentinel';
  const operationError = new Error(sentinel);
  const database: SqliteSerializationDatabase = {
    serializeDatabase() { throw operationError; },
  };

  await assert.rejects(
    createPreMigrationBackup(database, path.join(directory, 'data.sqlite3'), 1, 2),
    (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'DATABASE_ERROR');
      assert.equal(error.message, 'Could not create and verify the pre-migration backup; the database was not migrated');
      assert.deepEqual(error.details, {});
      assert.equal((error as Error & { cause?: unknown }).cause, operationError);
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      return true;
    },
  );
});

test('pre-migration backup never overwrites or removes a create-only destination collision', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-upgrade-backup-collision-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = openConnection(databasePath);
  const victim = Buffer.from('preexisting-victim');
  let output = '';
  try {
    database.exec('CREATE TABLE source_data (value TEXT NOT NULL);');
    await assert.rejects(
      createPreMigrationBackup(database, databasePath, 1, 2, {
        async beforeArtifactWrite(candidate) {
          output = candidate;
          await writeFile(candidate, victim, { flag: 'wx' });
        },
      }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'DATABASE_ERROR',
    );
    assert.notEqual(output, '');
    assert.deepEqual(await readFile(output), victim);
  } finally {
    database.close();
  }
});

test('pre-migration backup rejects foreign-key corruption before creating a backup directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-upgrade-backup-foreign-key-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = openConnection(databasePath);
  try {
    database.exec(`
      CREATE TABLE parent_rows (id INTEGER PRIMARY KEY);
      CREATE TABLE child_rows (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent_rows(id));
      PRAGMA foreign_keys = OFF;
      INSERT INTO child_rows (id, parent_id) VALUES (1, 999);
      PRAGMA foreign_keys = ON;
    `);
    await assert.rejects(
      createPreMigrationBackup(database, databasePath, 1, 2),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'DATABASE_ERROR'
        && error.message === 'Could not create and verify the pre-migration backup; the database was not migrated',
    );
    assert.equal((await readdir(directory)).includes('backups'), false);
  } finally {
    database.close();
  }
});

test('pre-migration backup derives a deterministic portable label from any valid POSIX database basename', {
  skip: process.platform === 'win32' ? 'the source basename is intentionally POSIX-only' : false,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-upgrade-backup-portable-name-'));
  const sourceBasename = 'CON:archive\\source.sqlite3';
  const databasePath = path.join(directory, sourceBasename);
  const database = openConnection(databasePath);
  try {
    database.exec(`
      CREATE TABLE source_data (value TEXT NOT NULL);
      INSERT INTO source_data (value) VALUES ('portable backup');
    `);
    const first = await createPreMigrationBackup(database, databasePath, 1, 2);
    const second = await createPreMigrationBackup(database, databasePath, 1, 2);
    const firstName = path.basename(first.path);
    const secondName = path.basename(second.path);
    const suffix = /\.pre-upgrade-v1-to-v2-[0-9]{17}-[a-f0-9]{16}\.sqlite3$/u;
    const expectedHash = createHash('sha256').update(sourceBasename, 'utf8').digest('hex').slice(0, 16);
    const expectedLabel = `db-con-archive-source-sqlite3-${expectedHash}`;

    assert.match(firstName, /^[a-z0-9_.-]+$/u);
    assert.match(secondName, /^[a-z0-9_.-]+$/u);
    assert.doesNotMatch(firstName, /[:\\]/u);
    assert.doesNotMatch(secondName, /[:\\]/u);
    assert.equal(firstName.replace(suffix, ''), expectedLabel);
    assert.equal(secondName.replace(suffix, ''), expectedLabel);
    assert.notEqual(first.path, second.path);

    for (const backupPath of [first.path, second.path]) {
      const backup = openConnection(backupPath, { readOnly: true });
      try {
        assert.equal(
          backup.prepare('SELECT value FROM source_data').get<{ value: string }>()?.value,
          'portable backup',
        );
      } finally {
        backup.close();
      }
    }
  } finally {
    database.close();
  }
});
