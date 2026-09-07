import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getPlatformDataDirectory, type PathEnvironment } from '../config/paths.js';
import { KiokukoError } from '../errors.js';
import type { ManagedMutationGuard } from './types.js';

export const MANAGED_FILE_LOCK_WAIT_MS = 2_000;
const RETRY_DELAY_MS = 8;
const queues = new Map<string, Promise<void>>();

export function managedResourceKey(target: string, options: PathEnvironment = {}): string {
  const windows = (options.platform ?? process.platform) === 'win32';
  const platformPath = windows ? path.win32 : path.posix;
  const normalized = platformPath.normalize(platformPath.resolve(target));
  return windows ? normalized.toLowerCase() : normalized;
}

async function resolvedResourceKey(target: string, options: PathEnvironment): Promise<string> {
  const platformPath = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  let current = platformPath.resolve(target);
  for (;;) {
    try {
      const resolved = await realpath(current);
      const suffix = platformPath.relative(current, platformPath.resolve(target));
      return managedResourceKey(suffix.length === 0 ? resolved : platformPath.join(resolved, suffix), options);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
      const parent = platformPath.dirname(current);
      if (parent === current) return managedResourceKey(target, options);
      current = parent;
    }
  }
}

function lockDatabasePath(options: PathEnvironment): string {
  const platformPath = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  return platformPath.join(getPlatformDataDirectory(options), 'managed-files.sqlite');
}

function busy(error: unknown): boolean {
  return error instanceof Error && /busy|locked/iu.test(error.message);
}

async function openLockDatabase(options: PathEnvironment): Promise<DatabaseSync> {
  const filePath = lockDatabasePath(options);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filePath, { timeout: 0 });
  try {
    database.exec('PRAGMA busy_timeout = 0;');
    await chmod(filePath, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function acquire(resourceKey: string, options: PathEnvironment, deadline: number): Promise<{
  database: DatabaseSync;
  guard: ManagedMutationGuard;
}> {
  for (;;) {
    if (Date.now() >= deadline) throw new KiokukoError('CONFLICT', 'Managed file lock wait timed out', { reason: 'lock_busy' });
    let database: DatabaseSync | undefined;
    try {
      database = await openLockDatabase(options);
      database.exec('BEGIN IMMEDIATE');
      return { database, guard: { resourceKey, token: Symbol(randomUUID()) } };
    } catch (error) {
      try { database?.close(); } catch { }
      if (!busy(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(RETRY_DELAY_MS, Math.max(0, deadline - Date.now()))));
    }
  }
}

async function release(database: DatabaseSync): Promise<void> {
  try { database.exec('ROLLBACK'); } finally { database.close(); }
}

export async function withManagedFileLock<T>(
  target: string,
  operation: (guard: ManagedMutationGuard) => Promise<T>,
  options: PathEnvironment & { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const resourceKey = await resolvedResourceKey(target, options);
  const predecessor = queues.get(resourceKey) ?? Promise.resolve();
  let settle!: () => void;
  const queued = new Promise<void>((resolve) => { settle = resolve; });
  const chain = predecessor.then(() => queued);
  queues.set(resourceKey, chain);
  await predecessor;
  try {
    if (options.signal?.aborted) throw new KiokukoError('CONFLICT', 'Managed file update was aborted', { reason: 'aborted' });
    const lock = await acquire(resourceKey, options, Date.now() + (options.timeoutMs ?? MANAGED_FILE_LOCK_WAIT_MS));
    try {
      return await operation(lock.guard);
    } finally {
      await release(lock.database);
    }
  } finally {
    settle();
    if (queues.get(resourceKey) === chain) queues.delete(resourceKey);
  }
}

export function managedLockDatabaseFingerprint(options: PathEnvironment = {}): string {
  return createHash('sha256').update(lockDatabasePath(options), 'utf8').digest('hex');
}
