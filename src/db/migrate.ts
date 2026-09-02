import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase, SqliteRow } from './adapter.js';
import { withImmediateTransaction } from './transaction.js';

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

export interface MigrationPlan {
  readonly applied: readonly number[];
  readonly pending: readonly number[];
  readonly databaseVersion: number;
  readonly currentVersion: number;
  readonly migrations: readonly MigrationSource[];
}

export interface MigrationIdentity {
  readonly version: number;
  readonly name: string;
}

export interface MigrationSource extends MigrationIdentity {
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationSnapshot {
  readonly migrations: readonly MigrationSource[];
}

export interface MigrationHooks {
  /**
   * Runs after a pending migration's SQL and before its schema marker is
   * written. The hook is inside the same SQLite transaction as both steps.
  */
  readonly beforeMarkApplied?: (database: SqliteDatabase, migration: MigrationIdentity) => void;
}

interface AppliedMigrationRow extends SqliteRow {
  version: unknown;
  name: unknown;
  checksum: unknown;
}

const MIGRATION_FILE = /^([0-9]{3})_([a-z0-9_-]+)\.sql$/;
const loadedMigrationSnapshots = new WeakSet<MigrationSnapshot>();
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

export function loadMigrationSnapshot(directory = defaultMigrationsDirectory()): MigrationSnapshot {
  const migrations = readdirSync(directory)
    .map((name) => {
      const match = MIGRATION_FILE.exec(name);
      if (!match) {
        if (/\.sql$/iu.test(name)) {
          throw new KiokukoError(
            'INTEGRITY_ERROR',
            `Migration filename is not canonical: ${name}`,
            { name },
          );
        }
        return undefined;
      }
      const version = Number(match[1]);
      const bytes = readFileSync(path.join(directory, name));
      if (bytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))) {
        throw new KiokukoError(
          'INTEGRITY_ERROR',
          `Migration file ${name} has a non-canonical UTF-8 BOM`,
        );
      }
      let sql: string;
      try {
        sql = fatalUtf8Decoder.decode(bytes);
      } catch (error) {
        const failure = new KiokukoError(
          'INTEGRITY_ERROR',
          `Migration file ${name} is not valid UTF-8`,
        );
        Object.defineProperty(failure, 'cause', { value: error });
        throw failure;
      }
      if (sql.includes('\r')) {
        throw new KiokukoError(
          'INTEGRITY_ERROR',
          `Migration file ${name} has non-canonical line endings; use LF only`,
        );
      }
      return {
        version,
        name,
        sql,
        checksum: createHash('sha256').update(bytes).digest('hex'),
      };
    })
    .filter((migration): migration is MigrationSource => migration !== undefined)
    .sort((left, right) => left.version - right.version);
  if (migrations.length === 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Migration directory contains no versioned migration files');
  }
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new KiokukoError('INTEGRITY_ERROR', `Migration version is invalid for ${migration.name}`);
    }
    if (versions.has(migration.version)) {
      throw new KiokukoError('INTEGRITY_ERROR', `Migration version ${migration.version} is duplicated`);
    }
    versions.add(migration.version);
  }
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        `Migration files must form an exact contiguous sequence starting at version 1; expected ${expectedVersion} but found ${migration.version}`,
        { expectedVersion, actualVersion: migration.version, name: migration.name },
      );
    }
  }
  const snapshot = Object.freeze({
    migrations: Object.freeze(migrations.map((migration) => Object.freeze(migration))),
  });
  loadedMigrationSnapshots.add(snapshot);
  return snapshot;
}

function requireLoadedMigrationSnapshot(snapshot: MigrationSnapshot): readonly MigrationSource[] {
  if (!loadedMigrationSnapshots.has(snapshot)) {
    throw new KiokukoError(
      'INTEGRITY_ERROR',
      'Migration snapshot was not produced by the validated snapshot loader',
    );
  }
  return snapshot.migrations;
}

function hasMigrationTable(database: SqliteDatabase): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get());
}

function appliedMigrationRows(database: SqliteDatabase): AppliedMigrationRow[] {
  if (!hasMigrationTable(database)) return [];
  return database.prepare(`
    SELECT version, name, checksum
    FROM schema_migrations
    ORDER BY version
  `).all<AppliedMigrationRow>();
}

function appliedMigrationVersion(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  throw new KiokukoError('INTEGRITY_ERROR', 'Database migration history contains an invalid version');
}

function migrationPlan(database: SqliteDatabase, migrations: readonly MigrationSource[]): MigrationPlan {
  const currentVersion = migrations.at(-1)?.version ?? 0;
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const rows = appliedMigrationRows(database);
  const applied: number[] = [];
  const seenVersions = new Set<number>();

  for (const row of rows) {
    const version = appliedMigrationVersion(row.version);
    if (seenVersions.has(version)) {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        `Database migration history contains duplicate version ${version}`,
        { version },
      );
    }
    seenVersions.add(version);
    const migration = byVersion.get(version);
    if (!migration) {
      if (version > currentVersion) {
        throw new KiokukoError(
          'INTEGRITY_ERROR',
          `Database schema version ${version} is newer than this Kiokuko binary supports (${currentVersion})`,
          { databaseVersion: version, supportedVersion: currentVersion },
        );
      }
      throw new KiokukoError('INTEGRITY_ERROR', `Database migration version ${version} is not supported by this Kiokuko binary`);
    }
    if (typeof row.name !== 'string' || typeof row.checksum !== 'string') {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        `Database migration history contains invalid metadata for version ${version}`,
        { version },
      );
    }
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        `Migration checksum mismatch for ${migration.name}`,
        { version: migration.version, name: migration.name },
      );
    }
    applied.push(version);
  }

  for (const [index, version] of applied.entries()) {
    const expectedVersion = index + 1;
    if (version !== expectedVersion) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Database migration history is not a contiguous prefix');
    }
  }
  const appliedSet = new Set(applied);
  return {
    applied: Object.freeze(applied),
    pending: Object.freeze(
      migrations.filter((migration) => !appliedSet.has(migration.version)).map((migration) => migration.version),
    ),
    databaseVersion: applied.at(-1) ?? 0,
    currentVersion,
    migrations,
  };
}

export function inspectMigrationSnapshot(database: SqliteDatabase, snapshot: MigrationSnapshot): MigrationPlan {
  return migrationPlan(database, requireLoadedMigrationSnapshot(snapshot));
}

function applyOneInTransaction(
  database: SqliteDatabase,
  migration: MigrationSource,
  migrations: readonly MigrationSource[],
  hooks: MigrationHooks,
): boolean {
  // Revalidate while the caller's write lock is held. No other migrator can
  // advance the history between this check, the SQL, the application hook,
  // and the marker write.
  migrationPlan(database, migrations);
  const existing = database
    .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
    .get<{ checksum: unknown }>(migration.version);
  if (existing) {
    if (typeof existing.checksum !== 'string' || existing.checksum !== migration.checksum) {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        `Migration checksum mismatch for ${migration.name}`,
        { version: migration.version, name: migration.name },
      );
    }
    return false;
  }

  database.exec(migration.sql);
  hooks.beforeMarkApplied?.(database, { version: migration.version, name: migration.name });
  database
    .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
    .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
  return true;
}

function applyMigrationSetInTransaction(
  database: SqliteDatabase,
  migrations: readonly MigrationSource[],
  hooks: MigrationHooks,
): MigrationResult {
  // Revalidate the database state after the writer transaction begins.
  migrationPlan(database, migrations);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied: number[] = [];
  for (const migration of migrations) {
    const result = applyOneInTransaction(database, migration, migrations, hooks);
    if (result) applied.push(migration.version);
  }
  const currentVersion = migrations.at(-1)?.version ?? 0;
  return { applied, currentVersion };
}

/** Apply an already-loaded migration snapshot inside a transaction owned by the caller. */
export function migrateDatabaseSnapshotInTransaction(
  database: SqliteDatabase,
  snapshot: MigrationSnapshot,
  hooks: MigrationHooks = {},
): MigrationResult {
  return applyMigrationSetInTransaction(database, requireLoadedMigrationSnapshot(snapshot), hooks);
}

export function migrateDatabase(
  database: SqliteDatabase,
  directory = defaultMigrationsDirectory(),
  hooks: MigrationHooks = {},
): MigrationResult {
  const migrations = loadMigrationSnapshot(directory).migrations;
  // Fail on unsupported history before beginning a write transaction, then
  // repeat the check under the lock in applyMigrationSetInTransaction.
  migrationPlan(database, migrations);
  return withImmediateTransaction(
    database,
    () => applyMigrationSetInTransaction(database, migrations, hooks),
  );
}
