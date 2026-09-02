import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { NodeSqliteAdapter } from './adapter.js';
import { withSqliteLockRetry } from './sqlite-retry.js';
import { KiokukoError } from '../errors.js';
import {
  isSqliteVecLoader,
  type SqliteVecLoader,
} from '../embedding/sqlite-vec-loader.js';

export interface DatabaseFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface ConnectionOptions {
  readonly readOnly?: boolean;
  readonly expectedFileIdentity?: DatabaseFileIdentity;
  readonly sqliteVecLoader?: SqliteVecLoader;
}

/** Internal discriminator for failures caused specifically by sqlite-vec loading. */
export class SqliteVecLoadError extends KiokukoError {
  constructor(message: string, cause?: unknown) {
    super('SERVICE_UNAVAILABLE', message);
    this.name = 'SqliteVecLoadError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}

function requireSqliteVecLoader(value: SqliteVecLoader | undefined): SqliteVecLoader | undefined {
  if (value === undefined) return undefined;
  if (!isSqliteVecLoader(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'The SQLite extension loader is not the known sqlite-vec loader');
  }
  return value;
}

function loadSqliteVec(database: DatabaseSync, loader: SqliteVecLoader): void {
  let failure: unknown;
  let failed = false;
  let loadingDisabled = false;
  try {
    loader.load(database);
    database.enableLoadExtension(false);
    loadingDisabled = true;
    const version = database.prepare('SELECT vec_version() AS version').get()?.version;
    if (version !== loader.extensionVersion) {
      throw new SqliteVecLoadError('The loaded sqlite-vec version is unsupported');
    }
  } catch (error) {
    failure = error;
    failed = true;
  }
  if (!loadingDisabled) {
    try {
      database.enableLoadExtension(false);
    } catch (disableError) {
      failure = failed
        ? new AggregateError([failure, disableError], 'sqlite-vec loading failed and disabling extension loading also failed')
        : disableError;
      failed = true;
    }
  }
  if (!failed) return;
  if (failure instanceof SqliteVecLoadError) throw failure;
  throw new SqliteVecLoadError('The sqlite-vec extension could not be loaded', failure);
}

export function databaseFileIdentity(filePath: string): DatabaseFileIdentity {
  const status = lstatSync(filePath, { bigint: true });
  if (!status.isFile()) {
    throw new KiokukoError('INTEGRITY_ERROR', 'SQLite database path is not a regular non-symbolic-link file');
  }
  return Object.freeze({ device: status.dev, inode: status.ino });
}

export function sameDatabaseFileIdentity(left: DatabaseFileIdentity, right: DatabaseFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function requireDatabaseFileIdentity(filePath: string, expected: DatabaseFileIdentity): void {
  let actual: DatabaseFileIdentity;
  try {
    actual = databaseFileIdentity(filePath);
  } catch (error) {
    const failure = new KiokukoError(
      'CONFLICT',
      'SQLite database file identity changed during initialization',
    );
    Object.defineProperty(failure, 'cause', { value: error });
    throw failure;
  }
  if (!sameDatabaseFileIdentity(actual, expected)) {
    throw new KiokukoError(
      'CONFLICT',
      'SQLite database file identity changed during initialization',
    );
  }
}

function configureJournalMode(database: DatabaseSync): void {
  withSqliteLockRetry(() => database.exec('PRAGMA journal_mode = WAL;'));
}

export function openConnection(filePath: string, options: ConnectionOptions = {}): NodeSqliteAdapter {
  const sqliteVecLoader = requireSqliteVecLoader(options.sqliteVecLoader);
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  }
  const database = new DatabaseSync(filePath, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
    ...(sqliteVecLoader === undefined ? {} : { allowExtension: true }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  try {
    if (options.expectedFileIdentity !== undefined) {
      if (filePath === ':memory:') {
        throw new KiokukoError('VALIDATION_ERROR', 'An in-memory database cannot have a file identity');
      }
      // This check deliberately precedes chmod and every writable PRAGMA.
      requireDatabaseFileIdentity(filePath, options.expectedFileIdentity);
    }
    if (filePath !== ':memory:' && !options.readOnly) chmodSync(filePath, 0o600);
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    if (!options.readOnly) {
      configureJournalMode(database);
      database.exec('PRAGMA synchronous = NORMAL;');
    }
    if (sqliteVecLoader !== undefined) loadSqliteVec(database, sqliteVecLoader);
    return new NodeSqliteAdapter(filePath, database);
  } catch (error) {
    try {
      database.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'SQLite connection initialization failed and closing it also failed',
      );
    }
    throw error;
  }
}
