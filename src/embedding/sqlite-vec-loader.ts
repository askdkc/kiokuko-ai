import type { PathEnvironment } from '../config/paths.js';
import { importOptionalRuntime } from './optional-runtime.js';
import path from 'node:path';

export const SQLITE_VEC_LOADER_ID = 'sqlite-vec' as const;
export const SQLITE_VEC_PACKAGE_VERSION = '0.1.9' as const;
export const SQLITE_VEC_EXTENSION_VERSION = 'v0.1.9' as const;
export const SQLITE_VEC_VERSION = SQLITE_VEC_PACKAGE_VERSION;

export interface SqliteVecLoadConnection {
  loadExtension(path: string): void;
}

export interface SqliteVecLoader {
  readonly id: typeof SQLITE_VEC_LOADER_ID;
  readonly packageVersion: typeof SQLITE_VEC_PACKAGE_VERSION;
  readonly extensionVersion: typeof SQLITE_VEC_EXTENSION_VERSION;
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

/** Resolve only the exact, package-owned sqlite-vec loader. */
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

  try {
    const loadablePath = candidate.getLoadablePath();
    if (!path.isAbsolute(loadablePath) || /[\u0000-\u001f\u007f]/u.test(loadablePath)) return null;
  } catch {
    return null;
  }

  const loader = Object.freeze({
    id: SQLITE_VEC_LOADER_ID,
    packageVersion: SQLITE_VEC_PACKAGE_VERSION,
    extensionVersion: SQLITE_VEC_EXTENSION_VERSION,
    load(database: SqliteVecLoadConnection): void {
      candidate.load(database);
    },
  });
  knownLoaders.add(loader);
  return loader;
}
