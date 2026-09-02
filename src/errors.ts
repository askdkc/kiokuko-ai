export type ErrorCode =
  | 'USAGE_ERROR'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE_ERROR'
  | 'BACKPRESSURE'
  | 'SERVICE_UNAVAILABLE'
  | 'SECURITY_REJECTION'
  | 'AUTHENTICATION_ERROR'
  | 'INTEGRITY_ERROR'
  | 'PARTIAL_FAILURE'
  | 'NOT_IMPLEMENTED'
  | 'UNSUPPORTED_CLIENT';

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE_ERROR: 2,
  VALIDATION_ERROR: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  DATABASE_ERROR: 6,
  BACKPRESSURE: 6,
  SERVICE_UNAVAILABLE: 6,
  SECURITY_REJECTION: 7,
  AUTHENTICATION_ERROR: 7,
  INTEGRITY_ERROR: 8,
  PARTIAL_FAILURE: 9,
  NOT_IMPLEMENTED: 2,
  UNSUPPORTED_CLIENT: 2,
};

export class KiokukoError extends Error {
  readonly exitCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'KiokukoError';
    this.exitCode = EXIT_CODES[code];
  }
}

export const STORED_MEMORY_RECOVERY_MESSAGE = [
  'Stored entry or revision failed the current integrity checks.',
  'No compatibility conversion or automatic data deletion is performed.',
  'Restore a known-good database backup or start with a new database after preserving the original file.',
].join('\n');

export function storedMemoryIntegrityError(): KiokukoError {
  return new KiokukoError('INTEGRITY_ERROR', STORED_MEMORY_RECOVERY_MESSAGE);
}

export const DATABASE_BACKUP_RECOVERY_MESSAGE = [
  'Database backup could not be created; the source database was not changed.',
  'Check that Node.js is version 24.16.0 or newer and that the backup destination is new and writable.',
  'Do not delete or replace the source database. If backup still fails, preserve the original file for repair or recovery.',
].join('\n');

export function databaseBackupIntegrityError(cause?: unknown): KiokukoError {
  const error = new KiokukoError('INTEGRITY_ERROR', DATABASE_BACKUP_RECOVERY_MESSAGE);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof KiokukoError) return error.exitCode;
  return EXIT_CODES.INTEGRITY_ERROR;
}
