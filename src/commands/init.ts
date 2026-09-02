import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePlatformDataDirectory, getGlobalDatabasePath } from '../config/paths.js';
import { detectCapabilities, type SqliteCapabilities } from '../db/capabilities.js';
import {
  databaseFileIdentity,
  openConnection,
  requireDatabaseFileIdentity,
  sameDatabaseFileIdentity,
  type DatabaseFileIdentity,
} from '../db/connection.js';
import {
  defaultMigrationsDirectory,
  inspectMigrationSnapshot,
  loadMigrationSnapshot,
  migrateDatabaseSnapshotInTransaction,
  type MigrationPlan,
  type MigrationResult,
} from '../db/migrate.js';
import { withSqliteLockRetry } from '../db/sqlite-retry.js';
import { rollbackFailedTransaction } from '../db/transaction.js';
import {
  createPreMigrationBackup,
  requirePosixBackupOpenFlags,
  type PreMigrationBackup,
} from '../db/upgrade-backup.js';
import { KiokukoError } from '../errors.js';

export interface InitOptions {
  databasePath?: string;
  migrationsDirectory?: string;
}

export interface InitHooks {
  /** Runs immediately before serializing the already-open backup source. */
  readonly beforeBackupSerialization?: () => void | Promise<void>;
  /** Runs after the pre-migration backup directory is bound, before its worker starts. */
  readonly afterBackupDirectoryBound?: () => void | Promise<void>;
  /** Runs with the unpredictable backup name before its create-only open. */
  readonly beforeBackupArtifactWrite?: (output: string) => void | Promise<void>;
  /** Runs after artifact attestation, before init binds the handoff. */
  readonly afterBackupArtifactWritten?: (output: string) => void | Promise<void>;
  /** Runs after the read-only preflight and any required backup complete. */
  readonly afterPreflight?: () => void | Promise<void>;
  /** Runs only after this process atomically reserves a previously absent path. */
  readonly afterPathReserved?: () => void | Promise<void>;
  /** Runs after the writable connection's initial state is captured, before its lock. */
  readonly afterWritableOpen?: () => void | Promise<void>;
  /** Runs inside the migration transaction immediately before final identity checks. */
  readonly beforeCommit?: () => void;
}

export interface InitResult {
  databasePath: string;
  dataDirectory: string;
  applied: number[];
  currentVersion: number;
  backupPath: string | null;
  capabilities: SqliteCapabilities;
}

function requireForeignKeyIntegrity(connection: ReturnType<typeof openConnection>, stage: 'before' | 'after'): void {
  const violations = connection.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new KiokukoError(
      'INTEGRITY_ERROR',
      `Database foreign-key integrity check failed ${stage} migration`,
      { stage, violationCount: violations.length },
    );
  }
}

function dataVersion(connection: ReturnType<typeof openConnection>): number {
  const value = connection.prepare('PRAGMA data_version').get()?.data_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new KiokukoError('INTEGRITY_ERROR', 'SQLite data-version probe returned an invalid result');
  }
  return value;
}

function moveRestoredDatabaseWalSidecars(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const descriptor = openSync(databasePath, constants.O_RDONLY);
  try {
    const header = Buffer.alloc(20);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length
      || header.subarray(0, 16).toString('ascii') !== 'SQLite format 3\u0000'
      || header[18] !== 1) return;
  } finally {
    closeSync(descriptor);
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${databasePath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    let sequence = 0;
    let preserved = `${sidecar}.before-setup-${Date.now()}`;
    while (existsSync(preserved)) {
      sequence += 1;
      preserved = `${sidecar}.before-setup-${Date.now()}-${sequence}`;
    }
    renameSync(sidecar, preserved);
  }
}

function samePlan(left: MigrationPlan, right: MigrationPlan): boolean {
  return left.databaseVersion === right.databaseVersion
    && left.currentVersion === right.currentVersion
    && left.applied.length === right.applied.length
    && left.applied.every((version, index) => version === right.applied[index])
    && left.pending.length === right.pending.length
    && left.pending.every((version, index) => version === right.pending[index])
    && left.migrations.length === right.migrations.length
    && left.migrations.every((migration, index) => {
      const candidate = right.migrations[index];
      return candidate !== undefined
        && migration.version === candidate.version
        && migration.name === candidate.name
        && migration.checksum === candidate.checksum
        && migration.sql === candidate.sql;
    });
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function unsupportedExistingDatabase(error: unknown): KiokukoError {
  const failure = new KiokukoError(
    'DATABASE_ERROR',
    'The existing database is unsupported and was not modified',
  );
  Object.defineProperty(failure, 'cause', { value: error });
  return failure;
}

/**
 * Atomically claims an absent database pathname before SQLite opens it. A
 * false return means this process owns the empty file; true means another
 * process created the path after the read-only existence preflight.
 */
interface DatabasePathReservation {
  readonly appeared: boolean;
  readonly descriptor?: number;
  readonly identity?: DatabaseFileIdentity;
}

interface BackupArtifactBinding {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: DatabaseFileIdentity;
  readonly size: bigint;
  readonly mode: bigint;
  readonly owner: bigint;
  readonly group: bigint;
  readonly linkCount: bigint;
  readonly sha256: string;
  readonly directoryPath: string;
  readonly directoryDescriptor?: number;
  readonly directoryDevice: bigint;
  readonly directoryInode: bigint;
  readonly directoryOwner: bigint;
  readonly directoryGroup: bigint;
  readonly directoryMode: bigint;
}

function reserveAbsentDatabasePath(databasePath: string, dataDirectory: string): DatabasePathReservation {
  if (databasePath === ':memory:') return { appeared: false };
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(databasePath, 'wx', 0o600);
    try {
      const status = fstatSync(descriptor, { bigint: true });
      if (!status.isFile()) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Reserved SQLite database path is not a regular file');
      }
      return {
        appeared: false,
        descriptor,
        identity: Object.freeze({ device: status.dev, inode: status.ino }),
      };
    } catch (error) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'Database path reservation failed and closing its descriptor also failed',
        );
      }
      throw error;
    }
  } catch (error) {
    if (isAlreadyExistsError(error)) return { appeared: true };
    throw error;
  }
}

function hasPersistentSchema(connection: ReturnType<typeof openConnection>): boolean {
  return Boolean(connection.prepare(`
    SELECT 1 AS present
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     LIMIT 1
  `).get());
}

function descriptorSha256(descriptor: number, size: bigint): string {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Pre-migration backup size is unsupported');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const expectedLength = Number(size);
  let offset = 0;
  while (offset < expectedLength) {
    const length = Math.min(buffer.length, expectedLength - offset);
    const bytesRead = readSync(descriptor, buffer, 0, length, offset);
    if (bytesRead === 0) {
      throw new KiokukoError('CONFLICT', 'Pre-migration backup changed during verification');
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

function bindBackupArtifact(backup: PreMigrationBackup): BackupArtifactBinding {
  const posixFlags = requirePosixBackupOpenFlags();
  const backupFilePath = backup.path;
  const directoryPath = dirname(backupFilePath);
  const directoryBefore = lstatSync(directoryPath, { bigint: true });
  if (directoryPath !== backup.directory.path
    || !directoryBefore.isDirectory()
    || directoryBefore.isSymbolicLink()
    || directoryBefore.dev !== backup.directory.device
    || directoryBefore.ino !== backup.directory.inode
    || directoryBefore.uid !== backup.directory.owner
    || directoryBefore.gid !== backup.directory.group
    || directoryBefore.mode !== backup.directory.mode
    || (process.platform !== 'win32' && (directoryBefore.mode & 0o777n) !== 0o700n)) {
    throw new KiokukoError(
      'INTEGRITY_ERROR',
      'Pre-migration backup directory is not a private non-symbolic-link directory',
    );
  }
  let directoryDescriptor: number | undefined;
  try {
    if (posixFlags !== undefined) {
      directoryDescriptor = openSync(
        directoryPath,
        constants.O_RDONLY | posixFlags.directory | posixFlags.noFollow,
      );
      const openedDirectory = fstatSync(directoryDescriptor, { bigint: true });
      if (!openedDirectory.isDirectory()
        || openedDirectory.dev !== directoryBefore.dev
        || openedDirectory.ino !== directoryBefore.ino
        || openedDirectory.uid !== directoryBefore.uid
        || openedDirectory.gid !== directoryBefore.gid
        || openedDirectory.mode !== directoryBefore.mode
        || (openedDirectory.mode & 0o777n) !== 0o700n) {
        throw new KiokukoError('CONFLICT', 'Pre-migration backup directory changed while it was being bound');
      }
    }
    const descriptor = openSync(
      backupFilePath,
      posixFlags === undefined
        ? constants.O_RDONLY
        : constants.O_RDONLY | posixFlags.noFollow | posixFlags.nonBlock,
    );
    try {
      const status = fstatSync(descriptor, { bigint: true });
      if (!status.isFile()
        || status.dev !== backup.artifact.device
        || status.ino !== backup.artifact.inode
        || status.uid !== backup.artifact.owner
        || status.gid !== backup.artifact.group
        || status.mode !== backup.artifact.mode
        || status.size !== backup.artifact.size
        || status.nlink !== backup.artifact.linkCount
        || status.size <= 0n
        || status.nlink !== 1n
        || (process.platform !== 'win32' && (status.mode & 0o777n) !== 0o600n)) {
        throw new KiokukoError(
          'INTEGRITY_ERROR',
          'Pre-migration backup is not a private, non-empty, singly linked regular file',
        );
      }
      const identity = Object.freeze({ device: status.dev, inode: status.ino });
      const pathIdentity = databaseFileIdentity(backupFilePath);
      if (!sameDatabaseFileIdentity(identity, pathIdentity)) {
        throw new KiokukoError('CONFLICT', 'Pre-migration backup changed while it was being bound');
      }
      const sha256 = descriptorSha256(descriptor, status.size);
      if (sha256 !== backup.artifact.sha256) {
        throw new KiokukoError('CONFLICT', 'Pre-migration backup changed before it was bound');
      }
      const after = fstatSync(descriptor, { bigint: true });
      const directoryAfter = lstatSync(directoryPath, { bigint: true });
      if (after.dev !== status.dev
        || after.ino !== status.ino
        || after.size !== status.size
        || after.mode !== status.mode
        || after.uid !== status.uid
        || after.gid !== status.gid
        || after.nlink !== status.nlink
        || !directoryAfter.isDirectory()
        || directoryAfter.isSymbolicLink()
        || directoryAfter.dev !== directoryBefore.dev
        || directoryAfter.ino !== directoryBefore.ino
        || directoryAfter.uid !== directoryBefore.uid
        || directoryAfter.gid !== directoryBefore.gid
        || directoryAfter.mode !== directoryBefore.mode
        || (process.platform !== 'win32' && (directoryAfter.mode & 0o777n) !== 0o700n)) {
        throw new KiokukoError('CONFLICT', 'Pre-migration backup changed while it was being bound');
      }
      return Object.freeze({
        path: backupFilePath,
        descriptor,
        identity,
        size: status.size,
        mode: status.mode,
        owner: status.uid,
        group: status.gid,
        linkCount: status.nlink,
        sha256,
        directoryPath,
        ...(directoryDescriptor === undefined ? {} : { directoryDescriptor }),
        directoryDevice: directoryBefore.dev,
        directoryInode: directoryBefore.ino,
        directoryOwner: directoryBefore.uid,
        directoryGroup: directoryBefore.gid,
        directoryMode: directoryBefore.mode,
      });
    } catch (error) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'Binding the pre-migration backup failed and closing it also failed',
        );
      }
      throw error;
    }
  } catch (error) {
    if (directoryDescriptor === undefined) throw error;
    try {
      closeSync(directoryDescriptor);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Binding the pre-migration backup failed and closing its directory also failed',
      );
    }
    throw error;
  }
}

function requireBackupDirectoryBinding(binding: BackupArtifactBinding): void {
  const status = lstatSync(binding.directoryPath, { bigint: true });
  if (!status.isDirectory()
    || status.isSymbolicLink()
    || status.dev !== binding.directoryDevice
    || status.ino !== binding.directoryInode
    || status.uid !== binding.directoryOwner
    || status.gid !== binding.directoryGroup
    || status.mode !== binding.directoryMode) {
    throw new KiokukoError('CONFLICT', 'Pre-migration backup directory changed before migration completed');
  }
  if (binding.directoryDescriptor !== undefined) {
    const opened = fstatSync(binding.directoryDescriptor, { bigint: true });
    if (!opened.isDirectory()
      || opened.dev !== binding.directoryDevice
      || opened.ino !== binding.directoryInode
      || opened.uid !== binding.directoryOwner
      || opened.gid !== binding.directoryGroup
      || opened.mode !== binding.directoryMode) {
      throw new KiokukoError('CONFLICT', 'Pre-migration backup directory changed before migration completed');
    }
  }
}

function requireBackupBytes(binding: BackupArtifactBinding): void {
  requireBackupDirectoryBinding(binding);
  const pathIdentity = databaseFileIdentity(binding.path);
  const status = fstatSync(binding.descriptor, { bigint: true });
  if (!sameDatabaseFileIdentity(pathIdentity, binding.identity)
    || status.dev !== binding.identity.device
    || status.ino !== binding.identity.inode
    || status.size !== binding.size
    || status.mode !== binding.mode
    || status.uid !== binding.owner
    || status.gid !== binding.group
    || status.nlink !== binding.linkCount
    || descriptorSha256(binding.descriptor, binding.size) !== binding.sha256) {
    throw new KiokukoError('CONFLICT', 'Pre-migration backup changed before migration completed');
  }
  requireBackupDirectoryBinding(binding);
}

function requireBackupArtifact(binding: BackupArtifactBinding, verifySqlite: boolean): void {
  try {
    requireBackupBytes(binding);
    if (verifySqlite) {
      const verification = openConnection(binding.path, {
        readOnly: true,
        expectedFileIdentity: binding.identity,
      });
      let verificationFailed = false;
      let verificationError: unknown;
      try {
        const integrity = verification.prepare('PRAGMA integrity_check').get()?.integrity_check;
        if (integrity !== 'ok' || verification.prepare('PRAGMA foreign_key_check').all().length > 0) {
          throw new KiokukoError('CONFLICT', 'Pre-migration backup failed revalidation');
        }
      } catch (error) {
        verificationFailed = true;
        verificationError = error;
        throw error;
      } finally {
        try {
          verification.close();
        } catch (closeError) {
          if (verificationFailed) {
            throw new AggregateError(
              [verificationError, closeError],
              'Pre-migration backup verification failed and closing it also failed',
            );
          }
          throw closeError;
        }
      }
      requireBackupBytes(binding);
    }
  } catch (error) {
    if (error instanceof AggregateError) throw error;
    if (error instanceof KiokukoError && /^Pre-migration backup/u.test(error.message)) throw error;
    const failure = new KiokukoError(
      'CONFLICT',
      'Pre-migration backup changed before migration completed',
    );
    Object.defineProperty(failure, 'cause', { value: error });
    throw failure;
  }
}

function requireUntouchedReservation(
  descriptor: number,
  expectedIdentity: DatabaseFileIdentity,
): void {
  const status = fstatSync(descriptor, { bigint: true });
  if (!status.isFile()
    || status.dev !== expectedIdentity.device
    || status.ino !== expectedIdentity.inode
    || status.size !== 0n) {
    throw new KiokukoError(
      'CONFLICT',
      'Reserved database file changed before SQLite opened it; migration was not applied without a backup',
    );
  }
}

function requireFreshDatabaseMetadata(connection: ReturnType<typeof openConnection>): void {
  const userVersion = connection.prepare('PRAGMA user_version').get()?.user_version;
  const applicationId = connection.prepare('PRAGMA application_id').get()?.application_id;
  const schemaVersion = connection.prepare('PRAGMA schema_version').get()?.schema_version;
  if (userVersion !== 0 || applicationId !== 0 || schemaVersion !== 0) {
    throw new KiokukoError(
      'CONFLICT',
      'Fresh database metadata changed after its path was reserved; migration was not applied without a backup',
    );
  }
}

export async function initializeDatabase(options: InitOptions = {}, hooks: InitHooks = {}): Promise<InitResult> {
  const databasePath = options.databasePath ?? getGlobalDatabasePath();
  if (databasePath === ':memory:') {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'In-memory databases are unsupported because Kiokuko requires persistent WAL mode',
    );
  }
  const dataDirectory = options.databasePath
    ? dirname(databasePath)
    : await ensurePlatformDataDirectory();
  const migrationsDirectory = options.migrationsDirectory ?? defaultMigrationsDirectory();
  // Load and validate once. Every plan comparison and applied SQL statement in
  // this run is bound to these exact ordered bytes, even if the source files
  // are replaced while a backup or SQLite lock is in progress.
  const migrationSnapshot = loadMigrationSnapshot(migrationsDirectory);
  const databaseExistedAtPreflight = databasePath !== ':memory:' && existsSync(databasePath);
  if (databaseExistedAtPreflight) moveRestoredDatabaseWalSidecars(databasePath);
  let expectedDatabaseIdentity = databaseExistedAtPreflight
    ? databaseFileIdentity(databasePath)
    : undefined;
  let backupPath: string | null = null;
  let backupBinding: BackupArtifactBinding | undefined;
  let inspection: ReturnType<typeof openConnection> | undefined;
  let preflightPlan: MigrationPlan | undefined;
  let preBackupDataVersion: number | undefined;
  let reservationDescriptor: number | undefined;

  // Existing databases get a genuinely read-only preflight. This rejects a
  // future/checksum-invalid/corrupt source without chmod, WAL negotiation, or
  // any other writable-open side effect.
  if (databaseExistedAtPreflight) {
    if (expectedDatabaseIdentity === undefined) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Existing database file identity is unavailable');
    }
    const preflightDatabaseIdentity = expectedDatabaseIdentity;
    let readOnlyInspection: ReturnType<typeof openConnection>;
    try {
      readOnlyInspection = openConnection(databasePath, {
        readOnly: true,
        expectedFileIdentity: preflightDatabaseIdentity,
      });
    } catch (error) {
      if (error instanceof KiokukoError) throw error;
      throw unsupportedExistingDatabase(error);
    }
    inspection = readOnlyInspection;
    try {
      try {
        preflightPlan = inspectMigrationSnapshot(readOnlyInspection, migrationSnapshot);
      } catch (error) {
        if (error instanceof KiokukoError) throw error;
        throw unsupportedExistingDatabase(error);
      }
      if (preflightPlan.applied.length === 0 && hasPersistentSchema(readOnlyInspection)) {
        throw new KiokukoError(
          'DATABASE_ERROR',
          'The database contains an unsupported schema and was not modified',
        );
      }
      if (preflightPlan.pending.length > 0
        && (preflightPlan.applied.length > 0 || hasPersistentSchema(readOnlyInspection))) {
        requireForeignKeyIntegrity(readOnlyInspection, 'before');
        preBackupDataVersion = dataVersion(readOnlyInspection);
        // Serialize this exact already-open inspection connection. Reopening
        // the pathname in a worker would allow a rename/restore ABA to back up
        // a different inode than the one preflight validated.
        const createdBackup = await createPreMigrationBackup(
          readOnlyInspection,
          databasePath,
          preflightPlan.databaseVersion,
          preflightPlan.currentVersion,
          {
            ...(hooks.beforeBackupSerialization === undefined
              ? {}
              : { beforeSerialization: hooks.beforeBackupSerialization }),
            ...(hooks.afterBackupDirectoryBound === undefined
              ? {}
              : { afterDirectoryBound: hooks.afterBackupDirectoryBound }),
            ...(hooks.beforeBackupArtifactWrite === undefined
              ? {}
              : { beforeArtifactWrite: hooks.beforeBackupArtifactWrite }),
            ...(hooks.afterBackupArtifactWritten === undefined
              ? {}
              : { afterArtifactWritten: hooks.afterBackupArtifactWritten }),
          },
        );
        backupPath = createdBackup.path;
        requireDatabaseFileIdentity(databasePath, preflightDatabaseIdentity);
        backupBinding = bindBackupArtifact(createdBackup);
      } else {
        inspection = undefined;
        readOnlyInspection.close();
      }
    } catch (error) {
      if (inspection !== undefined) {
        inspection = undefined;
        try {
          readOnlyInspection.close();
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            'Database preflight failed and closing its inspection also failed',
          );
        }
      }
      throw error;
    }
  }

  let connection: ReturnType<typeof openConnection> | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    if (hooks.afterPreflight !== undefined) await hooks.afterPreflight();
    const reservation = databaseExistedAtPreflight
      ? { appeared: false }
      : reserveAbsentDatabasePath(databasePath, dataDirectory);
    if (reservation.appeared) {
      throw new KiokukoError(
        'CONFLICT',
        'Database appeared after the existence preflight; migration was not applied without a backup',
      );
    }
    reservationDescriptor = reservation.descriptor;
    if (reservation.identity !== undefined) expectedDatabaseIdentity = reservation.identity;
    if (reservationDescriptor !== undefined && hooks.afterPathReserved !== undefined) {
      await hooks.afterPathReserved();
    }
    if (reservationDescriptor !== undefined) {
      if (expectedDatabaseIdentity === undefined) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Reserved database file identity is unavailable');
      }
      requireUntouchedReservation(reservationDescriptor, expectedDatabaseIdentity);
    }
    if (expectedDatabaseIdentity !== undefined) {
      requireDatabaseFileIdentity(databasePath, expectedDatabaseIdentity);
    }
    if (backupBinding !== undefined) requireBackupArtifact(backupBinding, true);
    if (inspection !== undefined) {
      const postBackupDataVersion = dataVersion(inspection);
      if (postBackupDataVersion !== preBackupDataVersion) {
        throw new KiokukoError(
          'CONFLICT',
          'The SQLite database changed while setup was preparing it; setup was not completed',
        );
      }
      const completedInspection = inspection;
      inspection = undefined;
      completedInspection.close();
    }
    const writableConnection = openConnection(databasePath, expectedDatabaseIdentity === undefined
      ? {}
      : { expectedFileIdentity: expectedDatabaseIdentity });
    connection = writableConnection;
    const freshDataVersion = reservationDescriptor === undefined
      ? undefined
      : dataVersion(writableConnection);
    const writableDataVersion = databaseExistedAtPreflight
      ? dataVersion(writableConnection)
      : undefined;
    if (freshDataVersion !== undefined) requireFreshDatabaseMetadata(writableConnection);
    if (hooks.afterWritableOpen !== undefined) await hooks.afterWritableOpen();
    if (writableDataVersion !== undefined && dataVersion(writableConnection) !== writableDataVersion) {
      throw new KiokukoError(
        'CONFLICT',
        'The SQLite database changed while setup was preparing it; setup was not completed',
      );
    }
    // Validate existing history before taking a write lock. The exact same
    // immutable migration snapshot is revalidated under the lock.
    const writablePlan = inspectMigrationSnapshot(writableConnection, migrationSnapshot);
    if (writablePlan.pending.length === 0 && preflightPlan?.pending.length === 0) {
      if (expectedDatabaseIdentity !== undefined) {
        requireDatabaseFileIdentity(databasePath, expectedDatabaseIdentity);
      }
      if (backupBinding !== undefined) requireBackupArtifact(backupBinding, true);
      return {
        databasePath,
        dataDirectory,
        applied: [],
        currentVersion: writablePlan.currentVersion,
        backupPath,
        capabilities: detectCapabilities(writableConnection),
      };
    }
    withSqliteLockRetry(() => writableConnection.exec('BEGIN IMMEDIATE'));
    let migration: MigrationResult;
    try {
      if (expectedDatabaseIdentity !== undefined) {
        requireDatabaseFileIdentity(databasePath, expectedDatabaseIdentity);
      }
      if (backupBinding !== undefined) requireBackupArtifact(backupBinding, true);
      if (freshDataVersion !== undefined) {
        if (dataVersion(writableConnection) !== freshDataVersion) {
          throw new KiokukoError(
            'CONFLICT',
            'Fresh database changed before its write lock was acquired; migration was not applied without a backup',
          );
        }
        requireFreshDatabaseMetadata(writableConnection);
      }
      const lockedPlan = inspectMigrationSnapshot(writableConnection, migrationSnapshot);
      if (preflightPlan === undefined
        && (lockedPlan.databaseVersion > 0 || hasPersistentSchema(writableConnection))) {
        throw new KiokukoError(
          'CONFLICT',
          'Fresh database state changed after its path was reserved; migration was not applied without a backup',
        );
      }
      if (preflightPlan !== undefined && !samePlan(preflightPlan, lockedPlan)) {
        throw new KiokukoError(
          'CONFLICT',
          'Database migration state changed after preflight; migration was not applied',
        );
      }
      requireForeignKeyIntegrity(writableConnection, 'before');
      migration = migrateDatabaseSnapshotInTransaction(writableConnection, migrationSnapshot);
      requireForeignKeyIntegrity(writableConnection, 'after');
      hooks.beforeCommit?.();
      if (expectedDatabaseIdentity !== undefined) {
        requireDatabaseFileIdentity(databasePath, expectedDatabaseIdentity);
      }
      if (backupBinding !== undefined) requireBackupArtifact(backupBinding, false);
      withSqliteLockRetry(() => writableConnection.exec('COMMIT'));
    } catch (error) {
      rollbackFailedTransaction(writableConnection, error);
    }
    if (expectedDatabaseIdentity !== undefined) {
      requireDatabaseFileIdentity(databasePath, expectedDatabaseIdentity);
    }
    if (backupBinding !== undefined) requireBackupArtifact(backupBinding, false);
    return {
      databasePath,
      dataDirectory,
      applied: migration.applied,
      currentVersion: migration.currentVersion,
      backupPath,
      capabilities: detectCapabilities(writableConnection),
    };
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (backupBinding !== undefined) {
      const completedBackupBinding = backupBinding;
      backupBinding = undefined;
      for (const descriptor of [
        completedBackupBinding.descriptor,
        completedBackupBinding.directoryDescriptor,
      ]) {
        if (descriptor === undefined) continue;
        try {
          closeSync(descriptor);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (reservationDescriptor !== undefined) {
      const descriptor = reservationDescriptor;
      reservationDescriptor = undefined;
      try {
        closeSync(descriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (inspection !== undefined) {
      const pendingInspection = inspection;
      inspection = undefined;
      try {
        pendingInspection.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (connection !== undefined) {
      const pendingConnection = connection;
      connection = undefined;
      try {
        pendingConnection.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          'Database initialization failed and resource cleanup also failed',
        );
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, 'Database initialization resource cleanup failed');
    }
  }
}
