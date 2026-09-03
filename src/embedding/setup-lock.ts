import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { getEmbeddingModelsDirectory, getEmbeddingSetupLockPath, type PathEnvironment } from '../config/paths.js';
import { KiokukoError } from '../errors.js';

export interface EmbeddingSetupLock {
  readonly path: string;
  release(): Promise<void>;
}

/** Release one setup lock without hiding either the operation or cleanup failure. */
export async function withEmbeddingSetupLock<T>(
  lock: EmbeddingSetupLock,
  operation: () => Promise<T>,
): Promise<T> {
  let result: { value: T } | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = { value: await operation() };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await lock.release();
  } catch (releaseError) {
    if (operationFailed) {
      throw new AggregateError([operationError, releaseError], 'Embedding setup failed and releasing its lock also failed');
    }
    throw releaseError;
  }
  if (operationFailed) throw operationError;
  if (result === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Embedding setup produced no result');
  return result.value;
}

export async function acquireEmbeddingSetupLock(options: PathEnvironment = {}): Promise<EmbeddingSetupLock> {
  await mkdir(getEmbeddingModelsDirectory(options), { recursive: true, mode: 0o700 });
  const lockPath = getEmbeddingSetupLockPath(options);
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${randomUUID()}\n`, 'utf8');
  } catch (error) {
    try { await handle?.close(); } catch { /* preserve the lock conflict */ }
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new KiokukoError('CONFLICT', 'Another embedding setup is already in progress');
    }
    throw error;
  }
  let released = false;
  return Object.freeze({
    path: lockPath,
    release: async () => {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(lockPath);
    },
  });
}
