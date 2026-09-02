import type { SqliteDatabase } from '../db/adapter.js';
import { openConnection, SqliteVecLoadError, type ConnectionOptions } from '../db/connection.js';
import { KiokukoError } from '../errors.js';
import { JavaScriptVectorSearchBackend } from './javascript-backend.js';
import { createSqliteVecLoader, type SqliteVecLoader } from './sqlite-vec-loader.js';
import { SqliteVecVectorSearchBackend } from './sqlite-vec-backend.js';
import { defaultEmbeddingConfig, readPersistedEmbeddingSettings } from './settings.js';
import type { EmbeddingConfig, VectorHit, VectorSearchBackend, VectorSearchInput } from './types.js';

export type EmbeddingDatabaseOpener = (
  databasePath: string,
  options?: ConnectionOptions,
) => SqliteDatabase | PromiseLike<SqliteDatabase>;

export interface OpenEmbeddingDatabaseOptions {
  readonly config?: EmbeddingConfig;
  readonly openDatabase?: EmbeddingDatabaseOpener;
  readonly createLoader?: () => Promise<SqliteVecLoader | null>;
  readonly backend?: VectorSearchBackend;
}

export interface OpenEmbeddingDatabaseResult {
  readonly database: SqliteDatabase;
  readonly backend: VectorSearchBackend | undefined;
}

/** A forced backend could not be selected; doctor may convert this to a finding. */
export class EmbeddingBackendUnavailableError extends KiokukoError {
  constructor() {
    super('SERVICE_UNAVAILABLE', 'The configured sqlite-vec backend is unavailable');
    this.name = 'EmbeddingBackendUnavailableError';
  }
}

function forcedSqliteVecUnavailable(): never {
  throw new EmbeddingBackendUnavailableError();
}

/** Keep optional semantic search available when the native extension disappears after startup. */
class OptionalSqliteVecBackend implements VectorSearchBackend {
  readonly id = 'sqlite-vec';

  constructor(
    private readonly nativeBackend: VectorSearchBackend,
    private readonly fallbackBackend: VectorSearchBackend,
  ) {}

  search(database: SqliteDatabase, input: VectorSearchInput): VectorHit[] {
    try {
      return this.nativeBackend.search(database, input);
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'SERVICE_UNAVAILABLE') {
        return this.fallbackBackend.search(database, input);
      }
      throw error;
    }
  }
}

/**
 * Open one owned database connection and select the backend that is actually
 * usable on that connection. Only the package-owned sqlite-vec loader can
 * create an extension-enabled connection.
 */
export async function openEmbeddingDatabase(
  databasePath: string,
  options: OpenEmbeddingDatabaseOptions,
): Promise<OpenEmbeddingDatabaseResult> {
  const openDatabase = options.openDatabase ?? openConnection;
  if (options.backend !== undefined) {
    return { database: await openDatabase(databasePath), backend: options.backend };
  }
  let config = options.config;
  if (config === undefined) {
    const probe = await openDatabase(databasePath);
    try {
      try {
        config = readPersistedEmbeddingSettings(probe);
      } catch {
        config = defaultEmbeddingConfig();
      }
    } finally {
      probe.close();
    }
  }
  if (config.mode === 'off') {
    return { database: await openDatabase(databasePath), backend: undefined };
  }

  const javascriptBackend = new JavaScriptVectorSearchBackend();
  if (config.vectorBackend === 'javascript') {
    return { database: await openDatabase(databasePath), backend: javascriptBackend };
  }

  const loader = await (options.createLoader ?? createSqliteVecLoader)();
  if (loader === null) {
    if (config.vectorBackend === 'sqlite-vec') forcedSqliteVecUnavailable();
    return { database: await openDatabase(databasePath), backend: javascriptBackend };
  }

  try {
    const database = await openDatabase(databasePath, { sqliteVecLoader: loader });
    const nativeBackend = new SqliteVecVectorSearchBackend();
    return {
      database,
      backend: config.mode === 'optional' ? new OptionalSqliteVecBackend(nativeBackend, javascriptBackend) : nativeBackend,
    };
  } catch (error) {
    if (!(error instanceof SqliteVecLoadError)) throw error;
    if (config.vectorBackend === 'sqlite-vec') forcedSqliteVecUnavailable();
    return { database: await openDatabase(databasePath), backend: javascriptBackend };
  }
}
