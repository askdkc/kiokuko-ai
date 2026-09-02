import { getGlobalDatabasePath } from '../config/paths.js';
import { realpath } from 'node:fs/promises';
import {
  databaseFileIdentity,
  openConnection,
  requireDatabaseFileIdentity,
} from '../db/connection.js';
import {
  createSerializedBackupArtifact,
  type SerializedBackupCreationHooks,
} from '../db/upgrade-backup.js';
import { databaseBackupIntegrityError, KiokukoError } from '../errors.js';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function reservedSqliteOutput(source: string, output: string): boolean {
  const normalizedSource = source.normalize('NFC').toLowerCase();
  const normalizedOutput = output.normalize('NFC').toLowerCase();
  return normalizedOutput === `${normalizedSource}-wal`
    || normalizedOutput === `${normalizedSource}-shm`
    || normalizedOutput === `${normalizedSource}-journal`
    || normalizedOutput.startsWith(`${normalizedSource}-mj `);
}

export async function createBackup(
  output: string,
  databasePath?: string,
  hooks: SerializedBackupCreationHooks = {},
): Promise<{ output: string; databasePath: string }> {
  const selectedDatabasePath = databasePath ?? getGlobalDatabasePath();
  let expectedIdentity: ReturnType<typeof databaseFileIdentity>;
  try {
    expectedIdentity = databaseFileIdentity(selectedDatabasePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const failure = new KiokukoError(
      'NOT_FOUND',
      'SQLite database does not exist; initialize it before creating a backup',
    );
    Object.defineProperty(failure, 'cause', { value: error });
    throw failure;
  }
  const canonicalDatabasePath = await realpath(selectedDatabasePath);
  requireDatabaseFileIdentity(canonicalDatabasePath, expectedIdentity);
  const database = openConnection(canonicalDatabasePath, {
    readOnly: true,
    expectedFileIdentity: expectedIdentity,
  });
  let operationFailed = false;
  let operationError: unknown;
  try {
    try {
      await createSerializedBackupArtifact(database, output, {
        ...hooks,
        async validateDestination(canonicalOutput) {
          if (reservedSqliteOutput(canonicalDatabasePath, canonicalOutput)) {
            throw new KiokukoError(
              'VALIDATION_ERROR',
              'Backup destination conflicts with a reserved SQLite sidecar pathname',
            );
          }
          await hooks.validateDestination?.(canonicalOutput);
        },
      });
    } catch (error) {
      if (error instanceof KiokukoError) throw error;
      throw databaseBackupIntegrityError(error);
    }
    requireDatabaseFileIdentity(canonicalDatabasePath, expectedIdentity);
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      database.close();
    } catch (closeError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, closeError],
          'SQLite backup failed and closing its source connection also failed',
        );
      }
      throw closeError;
    }
  }
  return { output, databasePath: selectedDatabasePath };
}
