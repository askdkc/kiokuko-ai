import type { SqliteDatabase } from './adapter.js';
import { withSqliteLockRetry } from './sqlite-retry.js';

/**
 * COMMIT threw and the subsequent ROLLBACK also threw. The caller must treat
 * the transaction as possibly committed: compensating durable side effects
 * could otherwise turn an uncertain outcome into split-brain state.
 */
export class TransactionCommitUncertainError extends AggregateError {
  readonly commitError: unknown;
  readonly rollbackError: unknown;

  constructor(commitError: unknown, rollbackError: unknown) {
    super(
      [commitError, rollbackError],
      'Transaction commit outcome is uncertain because commit and rollback both failed',
    );
    this.name = 'TransactionCommitUncertainError';
    this.commitError = commitError;
    this.rollbackError = rollbackError;
  }
}

export function rollbackFailedTransaction(database: SqliteDatabase, operationError: unknown): never {
  try {
    database.exec('ROLLBACK');
  } catch (rollbackError) {
    throw new AggregateError(
      [operationError, rollbackError],
      'Transaction operation failed and rollback also failed',
    );
  }
  throw operationError;
}

function commitOrRollback(database: SqliteDatabase): void {
  try {
    database.exec('COMMIT');
  } catch (commitError) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new TransactionCommitUncertainError(commitError, rollbackError);
    }
    throw commitError;
  }
}

/** Run a synchronous write transaction with bounded retry for SQLite lock errors only. */
export function withImmediateTransaction<T>(database: SqliteDatabase, operation: () => T): T {
  return withSqliteLockRetry(() => {
    database.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = operation();
    } catch (error) {
      rollbackFailedTransaction(database, error);
    }
    commitOrRollback(database);
    return result;
  });
}

/** Run synchronous reads against one SQLite snapshot without reserving a writer lock. */
export function withDeferredReadTransaction<T>(database: SqliteDatabase, operation: () => T): T {
  database.exec('BEGIN DEFERRED');
  let result: T;
  try {
    result = operation();
  } catch (error) {
    rollbackFailedTransaction(database, error);
  }
  commitOrRollback(database);
  return result;
}
