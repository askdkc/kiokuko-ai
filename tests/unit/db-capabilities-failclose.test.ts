import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SqliteDatabase,
  SqliteRow,
  SqliteSerializationDatabase,
  SqliteStatement,
  SqliteValue,
} from '../../src/db/adapter.js';
import { detectCapabilities } from '../../src/db/capabilities.js';
import { KiokukoError } from '../../src/errors.js';

const validRows: Record<string, SqliteRow> = {
  version: { version: '3.53.4' },
  foreign_keys: { foreign_keys: 1 },
  journal_mode: { journal_mode: 'wal' },
  synchronous: { synchronous: 1 },
  busy_timeout: { timeout: 5000 },
};

function capabilityDatabase(
  overrides: Partial<typeof validRows> = {},
  exec: (sql: string) => void = () => {},
): SqliteDatabase & SqliteSerializationDatabase {
  const rows = { ...validRows, ...overrides };
  return {
    filePath: ':memory:',
    exec,
    prepare(sql): SqliteStatement {
      const key = Object.keys(rows).find((candidate) => sql.includes(candidate));
      if (key === undefined) throw new Error(`Unexpected capability statement: ${sql}`);
      return {
        run() {},
        get<T extends SqliteRow = SqliteRow>(..._parameters: SqliteValue[]): T | undefined {
          return rows[key] as unknown as T;
        },
        all<T extends SqliteRow = SqliteRow>(..._parameters: SqliteValue[]): T[] { return [] as T[]; },
      };
    },
    serializeDatabase: () => new Uint8Array(),
    close() {},
  };
}

test('detectCapabilities returns only exact configured SQLite capabilities', () => {
  assert.deepEqual(detectCapabilities(capabilityDatabase()), {
    driver: 'node:sqlite',
    sqliteVersion: '3.53.4',
    fts5: true,
    foreignKeys: true,
    journalMode: 'wal',
    synchronous: '1',
    busyTimeout: 5000,
    backup: true,
  });
});

test('detectCapabilities propagates an unexpected FTS probe exception unchanged', () => {
  const programmerError = new TypeError('fts probe programmer sentinel');
  assert.throws(
    () => detectCapabilities(capabilityDatabase({}, () => { throw programmerError; })),
    (error: unknown) => error === programmerError,
  );
});

test('detectCapabilities rejects a database without the serialized backup capability', () => {
  const database = capabilityDatabase() as SqliteDatabase & Partial<SqliteSerializationDatabase>;
  delete database.serializeDatabase;
  assert.throws(
    () => detectCapabilities(database),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && error.details.capability === 'backup',
  );
});

test('detectCapabilities rejects missing, coerced, or disabled required settings', () => {
  const cases: Array<[string, Partial<typeof validRows>]> = [
    ['sqliteVersion', { version: {} }],
    ['sqliteVersion', { version: { version: 35304 } }],
    ['foreignKeys', { foreign_keys: { foreign_keys: 0 } }],
    ['journalMode', { journal_mode: { journal_mode: 'delete' } }],
    ['synchronous', { synchronous: { synchronous: '1' } }],
    ['busyTimeout', { busy_timeout: { timeout: '5000' } }],
    ['busyTimeout', { busy_timeout: { timeout: 0 } }],
  ];
  for (const [capability, overrides] of cases) {
    assert.throws(
      () => detectCapabilities(capabilityDatabase(overrides)),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'INTEGRITY_ERROR'
        && error.details.capability === capability,
      capability,
    );
  }
});
