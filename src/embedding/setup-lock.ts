import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { getEmbeddingModelsDirectory, getEmbeddingSetupLockPath, type PathEnvironment } from '../config/paths.js';
import { KiokukoError } from '../errors.js';

export interface EmbeddingSetupLock {
  readonly path: string;
  release(): Promise<void>;
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
