import { DatabaseSync } from 'node:sqlite';
import type { SqliteDatabase, SqliteSerializationDatabase } from './adapter.js';
import { KiokukoError } from '../errors.js';
import { SQLITE_VEC_BACKEND_ID } from '../embedding/sqlite-vec-backend.js';
import { SQLITE_VEC_EXTENSION_VERSION } from '../embedding/sqlite-vec-loader.js';

export interface SqliteVecCapability {
  readonly id: typeof SQLITE_VEC_BACKEND_ID;
  readonly available: boolean;
  readonly version: string | null;
}

export interface SqliteCapabilities {
  driver: 'node:sqlite';
  sqliteVersion: string;
  fts5: boolean;
  foreignKeys: boolean;
  journalMode: string;
  synchronous: string;
  busyTimeout: number;
  backup: boolean;
}

function invalidCapability(capability: string): never {
  throw new KiokukoError(
    'INTEGRITY_ERROR',
    'SQLite capability probe returned an invalid or unsupported result',
    { capability },
  );
}

/** Probe the optional extension without changing the core SQLite contract. */
export function detectSqliteVecCapability(database: SqliteDatabase): SqliteVecCapability {
  try {
    const version = database.prepare('SELECT vec_version() AS version').get()?.version;
    if (version !== SQLITE_VEC_EXTENSION_VERSION) return { id: SQLITE_VEC_BACKEND_ID, available: false, version: null };
    return { id: SQLITE_VEC_BACKEND_ID, available: true, version };
  } catch {
    return { id: SQLITE_VEC_BACKEND_ID, available: false, version: null };
  }
}

export function detectCapabilities(database: SqliteDatabase): SqliteCapabilities {
  // Migrations require FTS5. An unavailable module or any unexpected probe
  // failure is fatal rather than a false capability report.
  database.exec('CREATE VIRTUAL TABLE temp.kiokuko_capability_fts USING fts5(content); DROP TABLE temp.kiokuko_capability_fts;');

  const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get()?.version;
  if (typeof sqliteVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(sqliteVersion)) {
    invalidCapability('sqliteVersion');
  }
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
  if (foreignKeys !== 1) invalidCapability('foreignKeys');
  const journalMode = database.prepare('PRAGMA journal_mode').get()?.journal_mode;
  if (journalMode !== 'wal') invalidCapability('journalMode');
  const synchronous = database.prepare('PRAGMA synchronous').get()?.synchronous;
  if (synchronous !== 1) invalidCapability('synchronous');
  const busyTimeout = database.prepare('PRAGMA busy_timeout').get()?.timeout;
  if (busyTimeout !== 5000) invalidCapability('busyTimeout');
  const nativePrototype = DatabaseSync.prototype as DatabaseSync & { serialize?: () => Uint8Array };
  const serializationDatabase = database as SqliteDatabase & Partial<SqliteSerializationDatabase>;
  if (typeof nativePrototype.serialize !== 'function'
    || typeof serializationDatabase.serializeDatabase !== 'function') {
    invalidCapability('backup');
  }

  return {
    driver: 'node:sqlite',
    sqliteVersion,
    fts5: true,
    foreignKeys: true,
    journalMode,
    synchronous: String(synchronous),
    busyTimeout,
    backup: true,
  };
}
