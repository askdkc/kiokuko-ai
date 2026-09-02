import assert from 'node:assert/strict';
import { DatabaseSync, type DatabaseSync as DatabaseSyncType } from 'node:sqlite';

export interface SqliteCapabilityContractResult {
  sqliteVersion: string;
  fts5: boolean;
  wal: boolean;
  integrityCheck: boolean;
  backup: boolean;
}

function rowValue<T extends Record<string, unknown>>(row: unknown, key: string): T[keyof T] | undefined {
  return (row as T | undefined)?.[key as keyof T];
}

export async function assertSqliteCapabilityContract(database: DatabaseSyncType): Promise<SqliteCapabilityContractResult> {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE capability_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO capability_fixture(value) VALUES ('contract');
  `);
  const sqliteVersion = String(rowValue<{ version: string }>(database.prepare('SELECT sqlite_version() AS version').get(), 'version'));
  const fts5 = (() => {
    try {
      database.exec('CREATE VIRTUAL TABLE capability_fts USING fts5(value, content=capability_fixture, content_rowid=id);');
      return true;
    } catch {
      return false;
    }
  })();
  const journalMode = String(rowValue<{ journal_mode: string }>(database.prepare('PRAGMA journal_mode').get(), 'journal_mode')).toLowerCase();
  const wal = journalMode === 'wal';
  const integrityCheck = rowValue<{ integrity_check: string }>(database.prepare('PRAGMA integrity_check').get(), 'integrity_check') === 'ok';
  const sourceMethods = database as DatabaseSyncType & { serialize?: () => Uint8Array };
  const backupAvailable = typeof sourceMethods.serialize === 'function';
  assert.equal(rowValue<{ value: string }>(database.prepare('SELECT value FROM capability_fixture').get(), 'value'), 'contract');
  assert.equal(backupAvailable, true);
  const serialized = Buffer.from(sourceMethods.serialize!());
  serialized[18] = 1;
  serialized[19] = 1;
  const backupDatabase = new DatabaseSync(':memory:');
  try {
    const backupMethods = backupDatabase as DatabaseSync & { deserialize?: (bytes: Uint8Array) => void };
    assert.equal(typeof backupMethods.deserialize, 'function');
    backupMethods.deserialize!(serialized);
    assert.equal(rowValue<{ integrity_check: string }>(backupDatabase.prepare('PRAGMA integrity_check').get(), 'integrity_check'), 'ok');
    assert.equal(rowValue<{ value: string }>(backupDatabase.prepare('SELECT value FROM capability_fixture').get(), 'value'), 'contract');
  } finally {
    backupDatabase.close();
  }
  return { sqliteVersion, fts5, wal, integrityCheck, backup: backupAvailable };
}
