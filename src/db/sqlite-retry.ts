import { KiokukoError } from '../errors.js';

const LOCK_ATTEMPT_LIMIT = 5;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_OPERATIONAL_CODES = new Set([SQLITE_BUSY, SQLITE_LOCKED, 8, 10, 13, 14]);

function sqliteErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const sqliteError = error as Error & { code?: unknown; errcode?: unknown };
  if (
    sqliteError.code !== 'ERR_SQLITE_ERROR'
    || typeof sqliteError.errcode !== 'number'
    || !Number.isSafeInteger(sqliteError.errcode)
    || sqliteError.errcode < 0
  ) {
    return undefined;
  }
  return sqliteError.errcode;
}

/** Match only node:sqlite errors whose SQLite primary result code is BUSY or LOCKED. */
export function isSqliteLockError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code === undefined) return false;
  const primaryResultCode = code & 0xff;
  return primaryResultCode === SQLITE_BUSY || primaryResultCode === SQLITE_LOCKED;
}

/** Match only native node:sqlite operational failures discovery may safely report as bounded degradation. */
export function isSqliteOperationalError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  return code !== undefined && SQLITE_OPERATIONAL_CODES.has(code & 0xff);
}

/** Match database bytes that SQLite itself reports as corrupt or not a database. */
export function isSqliteCorruptionError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code === undefined) return false;
  const primaryResultCode = code & 0xff;
  return primaryResultCode === SQLITE_CORRUPT || primaryResultCode === SQLITE_NOTADB;
}

/** Match one exact PRIMARY KEY/UNIQUE target; trigger text cannot spoof this check. */
export function isSqliteUniqueConstraintError(error: unknown, targets: readonly string[]): boolean {
  const code = sqliteErrorCode(error);
  if (code !== SQLITE_CONSTRAINT_PRIMARYKEY && code !== SQLITE_CONSTRAINT_UNIQUE) return false;
  return error instanceof Error && targets.some((target) => error.message === `UNIQUE constraint failed: ${target}`);
}

function waitForRetry(attempt: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, attempt * 25);
}

/** Retry a synchronous operation at most five total attempts, and only for SQLite BUSY/LOCKED. */
export function withSqliteLockRetry<T>(operation: () => T): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteLockError(error)) throw error;
      if (attempt >= LOCK_ATTEMPT_LIMIT) {
        throw new KiokukoError(
          'BACKPRESSURE',
          'SQLite remained busy after bounded retry',
          { retryAfterSeconds: 1 },
        );
      }
      waitForRetry(attempt);
    }
  }
}
