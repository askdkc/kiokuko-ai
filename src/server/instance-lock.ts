import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDatabaseLockPath, type PathEnvironment } from '../config/paths.js';
import { KiokukoError } from '../errors.js';

export type PidLiveness = (pid: number) => boolean | Promise<boolean>;

export interface InstanceLockOptions extends PathEnvironment {
  runtimeDirectory?: string;
  pid?: number;
  instanceId?: string;
  isPidAlive?: PidLiveness;
}

export interface InstanceLock {
  path: string;
  instanceId: string;
  release(): Promise<boolean>;
}

interface LockRecord {
  instanceId: string;
  pid: number;
}

function lockPath(databasePath: string, options: InstanceLockOptions): string {
  if (options.runtimeDirectory) {
    const platform = options.platform ?? process.platform;
    const platformPath = platform === 'win32' ? path.win32 : path.posix;
    const resolvedPath = platformPath.resolve(databasePath);
    const fingerprint = createHash('sha256').update(resolvedPath, 'utf8').digest('hex');
    const join = platform === 'win32' ? path.win32.join : path.posix.join;
    return join(options.runtimeDirectory, `${fingerprint}.lock`);
  }
  return getDatabaseLockPath(databasePath, options);
}

function lockRecord(value: unknown): LockRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('CONFLICT', 'Database instance lock is unavailable');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.instanceId !== 'string' || typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
    throw new KiokukoError('CONFLICT', 'Database instance lock is unavailable');
  }
  return { instanceId: record.instanceId, pid: record.pid };
}

function assertSecureLockFile(info: Awaited<ReturnType<typeof lstat>>): void {
  if (info.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', 'Database instance lock must not be a symbolic link');
  if (!info.isFile()) throw new KiokukoError('VALIDATION_ERROR', 'Database instance lock must be a regular file');
  if (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0) {
    throw new KiokukoError('SECURITY_REJECTION', 'Database instance lock permissions are too broad');
  }
}

async function readLockRecord(lockFilePath: string): Promise<LockRecord> {
  assertSecureLockFile(await lstat(lockFilePath));
  try {
    return lockRecord(JSON.parse(await readFile(lockFilePath, 'utf8')));
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw new KiokukoError('CONFLICT', 'Database instance lock is unavailable');
  }
}

export async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EPERM') return true;
      if (error.code === 'ESRCH') return false;
    }
    throw error;
  }
}

export async function acquireInstanceLock(databasePath: string, options: InstanceLockOptions = {}): Promise<InstanceLock> {
  const instanceId = options.instanceId ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const pidLiveness = options.isPidAlive ?? isPidAlive;
  const lockFilePath = lockPath(databasePath, options);
  await mkdir(path.dirname(lockFilePath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockFilePath, `${JSON.stringify({ instanceId, pid })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await chmod(lockFilePath, 0o600);
      return {
        path: lockFilePath,
        instanceId,
        release: () => releaseInstanceLock(lockFilePath, instanceId),
      };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = await readLockRecord(lockFilePath);
      if (await pidLiveness(existing.pid)) {
        throw new KiokukoError('CONFLICT', 'Another live Kiokuko instance owns this database');
      }
      try {
        await unlink(lockFilePath);
      } catch (unlinkError) {
        if (!(unlinkError instanceof Error && 'code' in unlinkError && unlinkError.code === 'ENOENT')) throw unlinkError;
      }
    }
  }
  throw new KiokukoError('CONFLICT', 'Database instance lock is busy');
}

export async function releaseInstanceLock(lockFilePath: string, expectedInstanceId: string): Promise<boolean> {
  let record: LockRecord;
  try {
    record = await readLockRecord(lockFilePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (record.instanceId !== expectedInstanceId) return false;
  try {
    await unlink(lockFilePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
