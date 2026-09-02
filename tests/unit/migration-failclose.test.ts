import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SqliteDatabase, SqliteRow, SqliteStatement } from '../../src/db/adapter.js';
import {
  migrateDatabase,
  migrateDatabaseSnapshotInTransaction,
  type MigrationSnapshot,
} from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';

const MIGRATION_SQL = 'SELECT 1;\n';

function sqliteError(errcode: number, message = 'sqlite operation failed'): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
}

async function migrationDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-migration-failclose-'));
  const migrations = path.join(root, 'migrations');
  await mkdir(migrations);
  await writeFile(path.join(migrations, '001_fixture.sql'), MIGRATION_SQL);
  return migrations;
}

function migrationDatabase(
  onExec: (sql: string) => void,
  appliedRows: readonly SqliteRow[] = [],
): { database: SqliteDatabase; statements: string[] } {
  let hasMigrationTable = appliedRows.length > 0;
  const statements: string[] = [];
  const database: SqliteDatabase = {
    filePath: ':memory:',
    exec(sql) {
      statements.push(sql);
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/u.test(sql)) hasMigrationTable = true;
      onExec(sql);
    },
    prepare(sql): SqliteStatement {
      return {
        run() {},
        get<T extends SqliteRow>() {
          if (/FROM sqlite_master/u.test(sql)) return (hasMigrationTable ? { present: 1 } : undefined) as T | undefined;
          if (/SELECT checksum FROM schema_migrations/u.test(sql)) return undefined;
          throw new Error(`Unexpected mock get statement: ${sql}`);
        },
        all<T extends SqliteRow>() {
          if (/SELECT version, name, checksum/u.test(sql)) return [...appliedRows] as T[];
          throw new Error(`Unexpected mock all statement: ${sql}`);
        },
      };
    },
    close() {},
  };
  return { database, statements };
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

test('migration does not retry a programmer TypeError containing busy text', async () => {
  const directory = await migrationDirectory();
  const programmerError = new TypeError('programmer busy sentinel');
  let beginAttempts = 0;
  const { database, statements } = migrationDatabase((sql) => {
    if (sql === 'BEGIN IMMEDIATE') {
      beginAttempts += 1;
      throw programmerError;
    }
  });

  assert.throws(() => migrateDatabase(database, directory), (error: unknown) => error === programmerError);
  assert.equal(beginAttempts, 1);
  assert.equal(statements.includes('ROLLBACK'), false);
});

test('migration surfaces both its operation failure and a rollback failure', async () => {
  const directory = await migrationDirectory();
  const operationError = new Error('migration-operation-secret-sentinel');
  const rollbackError = sqliteError(10, 'migration-rollback-secret-sentinel');
  const { database, statements } = migrationDatabase((sql) => {
    if (sql === MIGRATION_SQL) throw operationError;
    if (sql === 'ROLLBACK') throw rollbackError;
  });

  assert.throws(
    () => migrateDatabase(database, directory),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Transaction operation failed and rollback also failed');
      assert.deepEqual(error.errors, [operationError, rollbackError]);
      assert.doesNotMatch(error.message, /migration-operation-secret-sentinel|migration-rollback-secret-sentinel/u);
      return true;
    },
  );
  assert.deepEqual(statements.slice(-2), [MIGRATION_SQL, 'ROLLBACK']);
});

test('rejects a non-contiguous migration file set before touching the database', async () => {
  const directory = await migrationDirectory();
  await writeFile(path.join(directory, '003_gap.sql'), MIGRATION_SQL);
  const { database, statements } = migrationDatabase(() => {});

  assert.throws(
    () => migrateDatabase(database, directory),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /exact contiguous sequence/u.test(error.message)
      && error.details.expectedVersion === 2
      && error.details.actualVersion === 3,
  );
  assert.deepEqual(statements, []);
});

test('rejects an empty migration directory before touching the database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-empty-migration-failclose-'));
  const directory = path.join(root, 'migrations');
  await mkdir(directory);
  const { database, statements } = migrationDatabase(() => {});

  assert.throws(
    () => migrateDatabase(database, directory),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /contains no versioned migration files/u.test(error.message),
  );
  assert.deepEqual(statements, []);
});

test('rejects invalid UTF-8 migration bytes before touching the database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-invalid-utf8-migration-'));
  const directory = path.join(root, 'migrations');
  await mkdir(directory);
  await writeFile(path.join(directory, '001_invalid.sql'), Buffer.from([0x53, 0x45, 0xff, 0x4c]));
  const { database, statements } = migrationDatabase(() => {});

  assert.throws(
    () => migrateDatabase(database, directory),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /not valid UTF-8/u.test(error.message),
  );
  assert.deepEqual(statements, []);
});

test('rejects a UTF-8 BOM in migration SQL before touching the database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-bom-migration-'));
  const directory = path.join(root, 'migrations');
  await mkdir(directory);
  await writeFile(
    path.join(directory, '001_bom.sql'),
    Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(MIGRATION_SQL)]),
  );
  const { database, statements } = migrationDatabase(() => {});

  assert.throws(
    () => migrateDatabase(database, directory),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /non-canonical UTF-8 BOM/u.test(error.message),
  );
  assert.deepEqual(statements, []);
});

test('rejects CRLF migration SQL before checksum or database effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-crlf-migration-'));
  const directory = path.join(root, 'migrations');
  await mkdir(directory);
  await writeFile(path.join(directory, '001_crlf.sql'), MIGRATION_SQL.replaceAll('\n', '\r\n'));
  const { database, statements } = migrationDatabase(() => {});

  assert.throws(
    () => migrateDatabase(database, directory),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /non-canonical line endings; use LF only/u.test(error.message),
  );
  assert.deepEqual(statements, []);
});

test('rejects every non-canonical SQL migration basename before touching the database', async () => {
  for (const name of [
    '1_short.sql',
    '0001_long.sql',
    '001_UPPER.sql',
    '001_missing-name.sql.SQL',
    '001 space.sql',
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-invalid-migration-name-'));
    const directory = path.join(root, 'migrations');
    await mkdir(directory);
    await writeFile(path.join(directory, '001_fixture.sql'), MIGRATION_SQL);
    await writeFile(path.join(directory, name), MIGRATION_SQL);
    const { database, statements } = migrationDatabase(() => {});

    assert.throws(
      () => migrateDatabase(database, directory),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'INTEGRITY_ERROR'
        && /filename is not canonical/u.test(error.message)
        && error.details.name === name,
      name,
    );
    assert.deepEqual(statements, [], name);
  }
});

test('rejects wrong-type, non-integer, and unsafe migration-history versions before any write', async () => {
  const directory = await migrationDirectory();
  for (const version of [
    '1',
    1.5,
    0,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    null,
  ]) {
    const { database, statements } = migrationDatabase(() => {}, [{
      version,
      name: '001_fixture.sql',
      checksum: checksum(MIGRATION_SQL),
    }]);
    assert.throws(
      () => migrateDatabase(database, directory),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'INTEGRITY_ERROR'
        && /invalid version/u.test(error.message),
      String(version),
    );
    assert.deepEqual(statements, [], String(version));
  }
});

test('rejects duplicate migration-history versions before any write', async () => {
  const directory = await migrationDirectory();
  const row = {
    version: 1,
    name: '001_fixture.sql',
    checksum: checksum(MIGRATION_SQL),
  };
  const { database, statements } = migrationDatabase(() => {}, [row, row]);

  assert.throws(
    () => migrateDatabase(database, directory),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /duplicate version 1/u.test(error.message),
  );
  assert.deepEqual(statements, []);
});

test('rejects migration history that is not an exact contiguous prefix before any write', async () => {
  const directory = await migrationDirectory();
  const secondSql = 'SELECT 2;\n';
  await writeFile(path.join(directory, '002_second.sql'), secondSql);
  const { database, statements } = migrationDatabase(() => {}, [{
    version: 2,
    name: '002_second.sql',
    checksum: checksum(secondSql),
  }]);

  assert.throws(
    () => migrateDatabase(database, directory),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /not a contiguous prefix/u.test(error.message),
  );
  assert.deepEqual(statements, []);
});

test('rejects a structurally forged migration snapshot before touching the database', () => {
  const forged = {
    migrations: [{
      version: 2,
      name: '002_forged.sql',
      checksum: '0'.repeat(64),
      sql: 'CREATE TABLE forged (id INTEGER PRIMARY KEY);',
    }],
  } as unknown as MigrationSnapshot;
  const { database, statements } = migrationDatabase(() => {});

  assert.throws(
    () => migrateDatabaseSnapshotInTransaction(database, forged),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /validated snapshot loader/u.test(error.message),
  );
  assert.deepEqual(statements, []);
});
