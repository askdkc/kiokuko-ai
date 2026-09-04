import { initializeDatabase, type InitOptions } from '../commands/init.js';
import path from 'node:path';
import { getGlobalDatabasePath, getPlatformDataDirectory, type PathEnvironment } from '../config/paths.js';
import { openConnection } from '../db/connection.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { openEmbeddingDatabase, type EmbeddingDatabaseOpener } from '../embedding/backend.js';
import { createEmbeddingRuntime } from '../embedding/runtime.js';
import type { EmbeddingConfig, EmbeddingProvider, EmbeddingRuntime, VectorSearchBackend } from '../embedding/types.js';
import { createEmbeddingWorker, type EmbeddingWorker } from '../embedding/worker.js';
import { WriteQueue } from '../server/write-queue.js';
import { createOrchestrationWorker, type OrchestrationWorker } from '../orchestration/worker.js';

export interface McpRuntimeOwnerOptions extends PathEnvironment {
  readonly databasePath?: string;
  readonly migrationsDirectory?: string;
  readonly initializeDatabase?: (options: InitOptions) => unknown | PromiseLike<unknown>;
  readonly openDatabase?: EmbeddingDatabaseOpener;
  readonly embeddingConfig?: EmbeddingConfig;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly embeddingBackend?: VectorSearchBackend;
  readonly fetchImpl?: typeof fetch;
  readonly orchestrationWorkerIntervalMs?: number;
}

export type McpDatabaseOperation<T> = (
  database: SqliteDatabase,
  runtime: EmbeddingRuntime,
) => Promise<T> | T;

export interface McpDatabaseOwner {
  withDatabase<T>(operation: McpDatabaseOperation<T>): Promise<T>;
  close(): Promise<void>;
}

interface OwnerState {
  readonly database: SqliteDatabase;
  readonly runtime: EmbeddingRuntime;
  readonly worker: EmbeddingWorker | undefined;
  readonly orchestrationWorker: OrchestrationWorker;
  readonly queue: WriteQueue<unknown>;
}

/** Own one MCP-process database/runtime instead of opening a connection per tool call. */
export class McpRuntimeOwner implements McpDatabaseOwner {
  readonly #options: McpRuntimeOwnerOptions;
  #initialization: Promise<OwnerState> | undefined;
  #state: OwnerState | undefined;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: McpRuntimeOwnerOptions = {}) {
    this.#options = options;
  }

  async #initialize(): Promise<OwnerState> {
    const databasePath = this.#options.databasePath ?? getGlobalDatabasePath(this.#options);
    const initialize = this.#options.initializeDatabase ?? initializeDatabase;
    await initialize({
      databasePath,
      ...(this.#options.migrationsDirectory === undefined ? {} : { migrationsDirectory: this.#options.migrationsDirectory }),
    });
    const config = this.#options.embeddingConfig;
    const opened = await openEmbeddingDatabase(databasePath, {
      ...(config === undefined ? {} : { config }),
      openDatabase: this.#options.openDatabase ?? openConnection,
      ...(this.#options.embeddingBackend === undefined ? {} : { backend: this.#options.embeddingBackend }),
    });
    const database = opened.database;
    const queue = new WriteQueue<unknown>(64);
    let runtime: EmbeddingRuntime | undefined;
    try {
      runtime = createEmbeddingRuntime(database, config, {
        ...(this.#options.embeddingProvider === undefined ? {} : { provider: this.#options.embeddingProvider }),
        ...(opened.backend === undefined ? {} : { backend: opened.backend }),
        enqueueWrite: <T>(operation: () => T | PromiseLike<T>) => queue.enqueue(operation) as Promise<T>,
      });
      const worker = runtime.profileId === null ? undefined : createEmbeddingWorker({ runtime });
      const dataDirectory = this.#options.databasePath === undefined
        ? getPlatformDataDirectory(this.#options)
        : path.dirname(databasePath);
      const orchestrationWorker = createOrchestrationWorker({
        database,
        embeddingRuntime: runtime,
        dataDirectory,
        ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
        ...(this.#options.orchestrationWorkerIntervalMs === undefined
          ? {}
          : { intervalMs: this.#options.orchestrationWorkerIntervalMs }),
      });
      const state = { database, runtime, worker, orchestrationWorker, queue } satisfies OwnerState;
      this.#state = state;
      worker?.start();
      orchestrationWorker.start();
      return state;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (runtime !== undefined) {
        try {
          await runtime.close();
        } catch (closeError) {
          cleanupErrors.push(closeError);
        }
      }
      try {
        await queue.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
      try {
        database.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'MCP runtime initialization failed and cleanup was incomplete');
      throw error;
    }
  }

  async #ensureState(): Promise<OwnerState> {
    if (this.#closed || this.#closing) throw new KiokukoError('SERVICE_UNAVAILABLE', 'MCP runtime is closed');
    if (this.#state !== undefined) return this.#state;
    if (this.#initialization === undefined) {
      const initialization = this.#initialize();
      this.#initialization = initialization;
      void initialization.then(undefined, () => {
        if (this.#initialization === initialization) this.#initialization = undefined;
      });
    }
    return this.#initialization;
  }

  async withDatabase<T>(operation: McpDatabaseOperation<T>): Promise<T> {
    const state = await this.#ensureState();
    return operation(state.database, state.runtime);
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    const attempt = (async () => {
      const state = this.#state ?? await this.#initialization;
      if (state === undefined) {
        this.#closed = true;
        return;
      }
      const errors: unknown[] = [];
      try {
        await state.orchestrationWorker.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await state.worker?.close();
      } catch (error) {
        errors.push(error);
      }
      if (state.worker === undefined) {
        try {
          await state.runtime.close();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await state.queue.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        state.database.close();
      } catch (error) {
        errors.push(error);
      }
      this.#closed = true;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'MCP runtime cleanup failed');
    })();
    this.#closePromise = attempt;
    return attempt;
  }
}
