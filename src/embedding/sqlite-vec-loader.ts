import type { PathEnvironment } from '../config/paths.js';
import { importOptionalRuntime } from './optional-runtime.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export const SQLITE_VEC_LOADER_ID = 'sqlite-vec' as const;

export interface SqliteVecLoadConnection {
  loadExtension(path: string): void;
}

export interface SqliteVecLoader {
  readonly id: typeof SQLITE_VEC_LOADER_ID;
  readonly packageVersion: string | null;
  load(database: SqliteVecLoadConnection): void;
}

interface SqliteVecPackage {
  getLoadablePath(): string;
  load(database: SqliteVecLoadConnection): void;
}

const knownLoaders = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSqliteVecPackage(value: unknown): value is SqliteVecPackage {
  if (!isRecord(value)) return false;
  return typeof value.getLoadablePath === 'function' && typeof value.load === 'function';
}

export function isSqliteVecLoader(value: unknown): value is SqliteVecLoader {
  return typeof value === 'object' && value !== null && knownLoaders.has(value);
}

/** Resolve only the package-owned sqlite-vec loader; capability probes validate the loaded extension. */
export async function createSqliteVecLoader(options: PathEnvironment = {}): Promise<SqliteVecLoader | null> {
  let candidate: unknown;
  try {
    // Keep the package name constant so optional dependency resolution cannot
    // become an extension-path configuration surface.
    candidate = await importOptionalRuntime('sqlite-vec', options);
  } catch {
    return null;
  }
  if (!isSqliteVecPackage(candidate)) return null;

  let packageVersion: string | null = null;
  try {
    const loadablePath = candidate.getLoadablePath();
    if (!path.isAbsolute(loadablePath) || /[\u0000-\u001f\u007f]/u.test(loadablePath)) return null;
    try {
      const manifest = JSON.parse(await readFile(path.join(path.dirname(loadablePath), 'package.json'), 'utf8'));
      if (typeof manifest.version === 'string' && manifest.version.length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(manifest.version)) packageVersion = manifest.version;
    } catch { /* unavailable metadata does not remove a working vector API */ }
  } catch {
    return null;
  }

  const loader = Object.freeze({
    id: SQLITE_VEC_LOADER_ID,
    packageVersion,
    load(database: SqliteVecLoadConnection): void {
      candidate.load(database);
    },
  });
  knownLoaders.add(loader);
  return loader;
}
