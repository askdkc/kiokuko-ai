import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePlatformDataDirectory, getGlobalDatabasePath } from '../config/paths.js';
import { detectCapabilities, type SqliteCapabilities } from '../db/capabilities.js';
import { databaseFileIdentity, openConnection } from '../db/connection.js';
import {
  defaultMigrationsDirectory,
  inspectMigrationSnapshot,
  loadMigrationSnapshot,
  migrateDatabaseSnapshotInTransaction,
  type MigrationPlan,
} from '../db/migrate.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';

export interface InitOptions {
  databasePath?: string;
  migrationsDirectory?: string;
}

export interface InitResult {
  databasePath: string;
  dataDirectory: string;
  applied: number[];
  currentVersion: number;
  /** Kept for output compatibility. Alpha schema upgrades no longer create backups. */
  backupPath: null;
  capabilities: SqliteCapabilities;
}

const OBSOLETE_ALPHA_SCHEMA_MESSAGE =
  'This database uses an obsolete alpha schema. Preserve it if needed, remove or relocate it, then run kiokuko-ai setup again. No in-place migration is supported.';

function obsoleteAlphaSchema(cause?: unknown): KiokukoError {
  const failure = new KiokukoError('DATABASE_ERROR', OBSOLETE_ALPHA_SCHEMA_MESSAGE);
  if (cause !== undefined) Object.defineProperty(failure, 'cause', { value: cause });
  return failure;
}

function hasPersistentSchema(connection: ReturnType<typeof openConnection>): boolean {
  return Boolean(connection.prepare(`
    SELECT 1 AS present
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     LIMIT 1
  `).get());
}

function isCurrentSchema(plan: MigrationPlan): boolean {
  return plan.currentVersion === 1
    && plan.databaseVersion === 1
    && plan.applied.length === 1
    && plan.applied[0] === 1
    && plan.pending.length === 0;
}

function inspectExistingDatabase(
  databasePath: string,
  snapshot: ReturnType<typeof loadMigrationSnapshot>,
): { readonly hasSchema: boolean; readonly current: boolean } {
  let connection: ReturnType<typeof openConnection> | undefined;
  try {
    connection = openConnection(databasePath, { readOnly: true });
    const hasSchema = hasPersistentSchema(connection);
    if (!hasSchema) return { hasSchema: false, current: false };
    const plan = inspectMigrationSnapshot(connection, snapshot);
    return { hasSchema: true, current: isCurrentSchema(plan) };
  } catch (error) {
    throw obsoleteAlphaSchema(error);
  } finally {
    connection?.close();
  }
}

/**
 * Initialize a fresh OpenCode-only database or open the exact current schema.
 *
 * Existing alpha schemas are deliberately rejected from a read-only
 * connection. Setup never upgrades, deletes, relocates, or backs them up.
 */
export async function initializeDatabase(options: InitOptions = {}): Promise<InitResult> {
  const databasePath = options.databasePath ?? getGlobalDatabasePath();
  if (databasePath === ':memory:') {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'Kiokuko initialization requires a persistent database path with persistent WAL mode',
    );
  }

  const dataDirectory = options.databasePath === undefined
    ? await ensurePlatformDataDirectory()
    : dirname(databasePath);
  const snapshot = loadMigrationSnapshot(options.migrationsDirectory ?? defaultMigrationsDirectory());
  if (snapshot.migrations.length !== 1 || snapshot.migrations[0]?.version !== 1) {
    throw new KiokukoError(
      'INTEGRITY_ERROR',
      'This Kiokuko release requires exactly one fresh-schema migration: 001',
    );
  }

  const existed = existsSync(databasePath);
  const wasZeroLength = existed && statSync(databasePath).size === 0;
  const expectedIdentity = existed ? databaseFileIdentity(databasePath) : undefined;
  if (existed && !wasZeroLength) {
    const inspection = inspectExistingDatabase(databasePath, snapshot);
    if (inspection.hasSchema && !inspection.current) throw obsoleteAlphaSchema();
  }

  const connection = openConnection(databasePath, {
    ...(expectedIdentity === undefined ? {} : { expectedFileIdentity: expectedIdentity }),
  });
  try {
    let applied: number[] = [];
    const hasSchema = hasPersistentSchema(connection);
    if (hasSchema) {
      let plan: MigrationPlan;
      try {
        plan = inspectMigrationSnapshot(connection, snapshot);
      } catch (error) {
        throw obsoleteAlphaSchema(error);
      }
      if (!isCurrentSchema(plan)) throw obsoleteAlphaSchema();
    } else {
      const migration = withImmediateTransaction(
        connection,
        () => migrateDatabaseSnapshotInTransaction(connection, snapshot),
      );
      applied = migration.applied;
    }

    const finalPlan = inspectMigrationSnapshot(connection, snapshot);
    if (!isCurrentSchema(finalPlan)) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Database initialization did not produce schema version 1');
    }
    return {
      databasePath,
      dataDirectory,
      applied,
      currentVersion: finalPlan.currentVersion,
      backupPath: null,
      capabilities: detectCapabilities(connection),
    };
  } finally {
    connection.close();
  }
}
