import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { isSqliteCorruptionError, isSqliteLockError, isSqliteUniqueConstraintError } from '../../src/db/sqlite-retry.js';
import { KiokukoError } from '../../src/errors.js';
import {
  TransactionCommitUncertainError,
  withImmediateTransaction,
} from '../../src/db/transaction.js';

function sqliteError(errcode: number, message = 'sqlite operation failed'): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
}

function databaseWithExec(exec: (sql: string) => void): SqliteDatabase {
  return {
    filePath: ':memory:',
    exec,
    prepare: () => { throw new Error('prepare must not be called'); },
    close: () => undefined,
  };
}

test('classifies only node:sqlite BUSY/LOCKED primary result codes as retryable', () => {
  assert.equal(isSqliteLockError(sqliteError(5)), true);
  assert.equal(isSqliteLockError(sqliteError(6)), true);
  assert.equal(isSqliteLockError(sqliteError(5 | (2 << 8))), true);
  assert.equal(isSqliteLockError(sqliteError(6 | (1 << 8))), true);
  assert.equal(isSqliteLockError(sqliteError(11, 'database is busy')), false);
  assert.equal(isSqliteLockError(Object.assign(new Error('database is busy'), { errcode: 5 })), false);
  assert.equal(isSqliteLockError(new TypeError('programmer busy sentinel')), false);
});

test('classifies corruption and exact unique targets without trusting error text alone', () => {
  assert.equal(isSqliteCorruptionError(sqliteError(11)), true);
  assert.equal(isSqliteCorruptionError(sqliteError(26)), true);
  assert.equal(isSqliteCorruptionError(sqliteError(17, 'database disk image is malformed')), false);
  assert.equal(isSqliteCorruptionError(new Error('database disk image is malformed')), false);

  const target = 'ledger_runs.run_id';
  assert.equal(isSqliteUniqueConstraintError(sqliteError(1555, `UNIQUE constraint failed: ${target}`), [target]), true);
  assert.equal(isSqliteUniqueConstraintError(sqliteError(2067, `UNIQUE constraint failed: ${target}`), [target]), true);
  assert.equal(isSqliteUniqueConstraintError(sqliteError(1811, `UNIQUE constraint failed: ${target}`), [target]), false);
  assert.equal(isSqliteUniqueConstraintError(new Error(`UNIQUE constraint failed: ${target}`), [target]), false);
  assert.equal(isSqliteUniqueConstraintError(sqliteError(1555, 'UNIQUE constraint failed: other.id'), [target]), false);
});

for (const [name, errcode] of [['BUSY', 5], ['LOCKED', 6]] as const) {
  test(`retries an exact SQLite ${name} result code`, () => {
    const statements: string[] = [];
    let beginAttempts = 0;
    let operationCalls = 0;
    const database = databaseWithExec((sql) => {
      statements.push(sql);
      if (sql === 'BEGIN IMMEDIATE' && beginAttempts++ === 0) throw sqliteError(errcode);
    });

    const result = withImmediateTransaction(database, () => {
      operationCalls += 1;
      return 'committed';
    });

    assert.equal(result, 'committed');
    assert.equal(beginAttempts, 2);
    assert.equal(operationCalls, 1);
    assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'BEGIN IMMEDIATE', 'COMMIT']);
  });
}

test('bounds retries for a persistent SQLite lock', () => {
  const locked = sqliteError(5);
  let beginAttempts = 0;
  const database = databaseWithExec(() => {
    beginAttempts += 1;
    throw locked;
  });

  assert.throws(
    () => withImmediateTransaction(database, () => undefined),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'BACKPRESSURE'
      && error.message === 'SQLite remained busy after bounded retry'
      && error.details.retryAfterSeconds === 1,
  );
  assert.equal(beginAttempts, 5);
});

test('does not retry a programmer TypeError containing busy text', () => {
  const programmerError = new TypeError('programmer busy sentinel');
  let beginAttempts = 0;
  const database = databaseWithExec(() => {
    beginAttempts += 1;
    throw programmerError;
  });

  assert.throws(() => withImmediateTransaction(database, () => undefined), (error: unknown) => error === programmerError);
  assert.equal(beginAttempts, 1);
});

test('does not retry SQLite CORRUPT, SCHEMA, or MISUSE result codes', () => {
  for (const errcode of [11, 17, 21]) {
    const sqliteFailure = sqliteError(errcode);
    let beginAttempts = 0;
    const database = databaseWithExec(() => {
      beginAttempts += 1;
      throw sqliteFailure;
    });

    assert.throws(() => withImmediateTransaction(database, () => undefined), (error: unknown) => error === sqliteFailure);
    assert.equal(beginAttempts, 1);
  }
});

test('surfaces both the operation failure and a rollback IOERR without copying their messages', () => {
  const operationError = new Error('operation-secret-sentinel');
  const rollbackError = sqliteError(10, 'rollback-secret-sentinel');
  const statements: string[] = [];
  const database = databaseWithExec((sql) => {
    statements.push(sql);
    if (sql === 'ROLLBACK') throw rollbackError;
  });

  assert.throws(
    () => withImmediateTransaction(database, () => { throw operationError; }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Transaction operation failed and rollback also failed');
      assert.deepEqual(error.errors, [operationError, rollbackError]);
      assert.doesNotMatch(error.message, /operation-secret-sentinel|rollback-secret-sentinel/u);
      return true;
    },
  );
  assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'ROLLBACK']);
});

test('marks the transaction outcome uncertain when COMMIT may have succeeded and ROLLBACK fails', () => {
  const commitError = new Error('post-commit-transport-sentinel');
  const rollbackError = sqliteError(1, 'no transaction is active');
  const statements: string[] = [];
  let committed = false;
  const database = databaseWithExec((sql) => {
    statements.push(sql);
    if (sql === 'COMMIT') {
      committed = true;
      throw commitError;
    }
    if (sql === 'ROLLBACK') throw rollbackError;
  });

  assert.throws(
    () => withImmediateTransaction(database, () => 'result'),
    (error: unknown) => {
      assert.ok(error instanceof TransactionCommitUncertainError);
      assert.equal(error.name, 'TransactionCommitUncertainError');
      assert.equal(
        error.message,
        'Transaction commit outcome is uncertain because commit and rollback both failed',
      );
      assert.equal(error.commitError, commitError);
      assert.equal(error.rollbackError, rollbackError);
      assert.deepEqual(error.errors, [commitError, rollbackError]);
      assert.doesNotMatch(error.message, /transport-sentinel|no transaction/u);
      return true;
    },
  );
  assert.equal(committed, true);
  assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
});

test('retries a locked COMMIT only after a successful rollback establishes non-commit', () => {
  const locked = sqliteError(5);
  const statements: string[] = [];
  let commitAttempts = 0;
  let operationCalls = 0;
  const database = databaseWithExec((sql) => {
    statements.push(sql);
    if (sql === 'COMMIT' && commitAttempts++ === 0) throw locked;
  });

  const result = withImmediateTransaction(database, () => {
    operationCalls += 1;
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.equal(operationCalls, 2);
  assert.deepEqual(statements, [
    'BEGIN IMMEDIATE',
    'COMMIT',
    'ROLLBACK',
    'BEGIN IMMEDIATE',
    'COMMIT',
  ]);
});
