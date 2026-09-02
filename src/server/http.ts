import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer as nodeCreateServer, type RequestListener, type Server } from 'node:http';
import path from 'node:path';
import { initializeDatabase as defaultInitializeDatabase, type InitOptions } from '../commands/init.js';
import { getGlobalDatabasePath, getRuntimeDescriptorPath, type PathEnvironment } from '../config/paths.js';
import { openConnection } from '../db/connection.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { createApp } from './app.js';
import {
  acquireInstanceLock as defaultAcquireInstanceLock,
  isPidAlive as defaultIsPidAlive,
  type InstanceLock,
  type InstanceLockOptions,
  type PidLiveness,
} from './instance-lock.js';
import {
  createRuntimeDescriptor as defaultCreateRuntimeDescriptor,
  readRuntimeDescriptor as defaultReadRuntimeDescriptor,
  removeRuntimeDescriptor as defaultRemoveRuntimeDescriptor,
  toPublicRuntimeDescriptor,
  writeRuntimeDescriptor as defaultWriteRuntimeDescriptor,
  type CreateRuntimeDescriptorInput,
  type RuntimeDescriptor,
  type RuntimeDescriptorView,
} from './runtime-descriptor.js';
import { WriteQueue, type WriteQueueState } from './write-queue.js';
import type { V1RouteHandler } from './router.js';
import {
  createEmbeddingRuntime,
  type EmbeddingRuntimeOptions,
} from '../embedding/runtime.js';
import { openEmbeddingDatabase, type EmbeddingDatabaseOpener } from '../embedding/backend.js';
import { createEmbeddingWorker, type EmbeddingWorker } from '../embedding/worker.js';
import type { EmbeddingProvider, EmbeddingRuntime, EmbeddingConfig, VectorSearchBackend } from '../embedding/types.js';
import { defaultEmbeddingConfig } from '../embedding/settings.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_QUEUE_CAPACITY = 64;

interface RequestAdmission {
  active: boolean;
}

export type DatabaseOpener = EmbeddingDatabaseOpener;
export type DatabaseInitializer = (options: InitOptions) => unknown | PromiseLike<unknown>;
export type HttpServerFactory = (listener: RequestListener) => Server;
export type InstanceLockAcquirer = (databasePath: string, options: InstanceLockOptions) => InstanceLock | PromiseLike<InstanceLock>;
export type RuntimeDescriptorFactory = (input: CreateRuntimeDescriptorInput) => RuntimeDescriptor;
export type RuntimeDescriptorReader = (filePath: string) => RuntimeDescriptor | undefined | PromiseLike<RuntimeDescriptor | undefined>;
export type RuntimeDescriptorWriter = (filePath: string, descriptor: RuntimeDescriptor) => void | PromiseLike<void>;
export type RuntimeDescriptorRemover = (filePath: string, expectedInstanceId: string) => boolean | PromiseLike<boolean>;

export interface HttpApplicationContext {
  readonly database: SqliteDatabase;
  readonly embeddingRuntime: EmbeddingRuntime;
  enqueueWrite<T>(operation: () => T | PromiseLike<T>): Promise<T>;
  createAuthenticatedApp(v1?: V1RouteHandler): RequestListener;
}

export type HttpApplicationFactory = (context: HttpApplicationContext) => RequestListener;
export type EmbeddingRuntimeFactory = (
  database: SqliteDatabase,
  config: EmbeddingConfig | undefined,
  options: EmbeddingRuntimeOptions,
) => EmbeddingRuntime | PromiseLike<EmbeddingRuntime>;
export type EmbeddingWorkerFactory = (runtime: EmbeddingRuntime) => EmbeddingWorker;

export interface HttpServerDependencies {
  readonly initializeDatabase?: DatabaseInitializer;
  readonly openDatabase?: DatabaseOpener;
  readonly createServer?: HttpServerFactory;
  readonly acquireInstanceLock?: InstanceLockAcquirer;
  readonly isPidAlive?: PidLiveness;
  readonly createRuntimeDescriptor?: RuntimeDescriptorFactory;
  readonly readRuntimeDescriptor?: RuntimeDescriptorReader;
  readonly writeRuntimeDescriptor?: RuntimeDescriptorWriter;
  readonly removeRuntimeDescriptor?: RuntimeDescriptorRemover;
  readonly createEmbeddingRuntime?: EmbeddingRuntimeFactory;
  readonly createEmbeddingWorker?: EmbeddingWorkerFactory;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly embeddingBackend?: VectorSearchBackend;
}

export interface HttpServerOptions extends PathEnvironment {
  readonly databasePath?: string;
  readonly migrationsDirectory?: string;
  readonly descriptorPath?: string;
  readonly runtimeDirectory?: string;
  readonly host?: string;
  readonly port?: number;
  readonly queueCapacity?: number;
  readonly pid?: number;
  readonly instanceId?: string;
  readonly startedAt?: string;
  readonly capabilityToken?: string;
  readonly app?: RequestListener;
  readonly v1?: V1RouteHandler;
  readonly applicationFactory?: HttpApplicationFactory;
  readonly dependencies?: HttpServerDependencies;
  readonly initializeDatabase?: DatabaseInitializer;
  readonly openDatabase?: DatabaseOpener;
  readonly createServer?: HttpServerFactory;
  readonly acquireInstanceLock?: InstanceLockAcquirer;
  readonly isPidAlive?: PidLiveness;
  readonly createRuntimeDescriptor?: RuntimeDescriptorFactory;
  readonly readRuntimeDescriptor?: RuntimeDescriptorReader;
  readonly writeRuntimeDescriptor?: RuntimeDescriptorWriter;
  readonly removeRuntimeDescriptor?: RuntimeDescriptorRemover;
  readonly embeddingConfig?: EmbeddingConfig;
  readonly createEmbeddingRuntime?: EmbeddingRuntimeFactory;
  readonly createEmbeddingWorker?: EmbeddingWorkerFactory;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly embeddingBackend?: VectorSearchBackend;
}

export interface HttpServerHandle {
  readonly server: Server;
  readonly url: string;
  readonly descriptor: RuntimeDescriptorView;
  readonly runtimeDescriptor: RuntimeDescriptorView;
  readonly queueState: WriteQueueState;
  enqueueWrite<T>(operation: () => T | PromiseLike<T>): Promise<T>;
  close(): Promise<void>;
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new KiokukoError('VALIDATION_ERROR', message, details);
}

function validateHost(host: string): string {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    invalid('The HTTP server only accepts loopback hosts');
  }
  return host;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    invalid('port must be an integer between 0 and 65535');
  }
  return port;
}

function validateCapabilityToken(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) invalid('capabilityToken must be a 256-bit lowercase hexadecimal value');
  return token;
}

function validateApplicationComposition(options: HttpServerOptions): void {
  if (options.applicationFactory !== undefined && (options.app !== undefined || options.v1 !== undefined)) {
    invalid('applicationFactory cannot be combined with app or v1');
  }
}

function descriptorPathFor(options: HttpServerOptions): string {
  if (options.descriptorPath !== undefined) return options.descriptorPath;
  if (options.runtimeDirectory !== undefined) {
    const join = options.platform === 'win32' ? path.win32.join : path.posix.join;
    return join(options.runtimeDirectory, 'server.json');
  }
  return getRuntimeDescriptorPath(options);
}

function databasePathFor(options: HttpServerOptions): string {
  return options.databasePath ?? getGlobalDatabasePath(options);
}

function lockOptionsFor(options: HttpServerOptions, instanceId: string, pid: number, isPidAlive: PidLiveness): InstanceLockOptions {
  const lockOptions: InstanceLockOptions = {
    instanceId,
    isPidAlive,
    pid,
  };
  if (options.runtimeDirectory !== undefined) lockOptions.runtimeDirectory = options.runtimeDirectory;
  if (options.platform !== undefined) lockOptions.platform = options.platform;
  if (options.env !== undefined) lockOptions.env = options.env;
  return lockOptions;
}

function publicUrl(host: string, port: number): string {
  const renderedHost = host === '::1' ? '[::1]' : host;
  return `http://${renderedHost}:${port}`;
}

function listeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string' || !Number.isInteger(address.port)) {
    throw new KiokukoError('DATABASE_ERROR', 'HTTP server did not expose a listening address');
  }
  return address.port;
}

function safeRuntimeError(error: unknown, fallback: string): KiokukoError {
  if (error instanceof KiokukoError) {
    const messages: Partial<Record<KiokukoError['code'], string>> = {
      CONFLICT: 'Request conflicts with current runtime state',
      VALIDATION_ERROR: 'Runtime configuration is invalid',
      SECURITY_REJECTION: 'Runtime file was rejected',
    };
    return new KiokukoError(error.code, messages[error.code] ?? fallback);
  }
  return new KiokukoError('DATABASE_ERROR', fallback);
}

function safeStartupError(error: unknown): KiokukoError {
  return safeRuntimeError(error, 'Unable to start the HTTP server');
}

function safeCloseError(error: unknown): KiokukoError {
  return safeRuntimeError(error, 'Unable to close the HTTP server');
}

function throwStartupFailure(originalError: unknown, cleanupErrors: readonly unknown[]): never {
  const startupError = safeStartupError(originalError);
  if (cleanupErrors.length === 0) throw startupError;
  throw new AggregateError(
    [startupError, ...cleanupErrors.map((error) => safeStartupError(error))],
    'HTTP server startup failed and resource cleanup also failed',
  );
}

function throwCloseFailures(errors: readonly unknown[]): void {
  if (errors.length === 0) return;
  const safeErrors = errors.map((error) => safeCloseError(error));
  if (safeErrors.length === 1) throw safeErrors[0];
  throw new AggregateError(safeErrors, 'HTTP server resource cleanup failed');
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      server.close((error?: Error) => {
        if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

async function removeOwnedDescriptor(
  removeDescriptor: RuntimeDescriptorRemover,
  descriptorPath: string,
  instanceId: string,
): Promise<void> {
  await removeDescriptor(descriptorPath, instanceId);
}

async function assertDescriptorAvailable(
  readDescriptor: RuntimeDescriptorReader,
  isPidAlive: PidLiveness,
  descriptorPath: string,
): Promise<void> {
  const existingDescriptor = await readDescriptor(descriptorPath);
  if (existingDescriptor && await isPidAlive(existingDescriptor.pid)) {
    throw new KiokukoError('CONFLICT', 'Another live Kiokuko instance owns the runtime descriptor');
  }
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const host = validateHost(options.host ?? DEFAULT_HOST);
  const port = validatePort(options.port ?? DEFAULT_PORT);
  validateApplicationComposition(options);
  const queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
  const queue = new WriteQueue<unknown>(queueCapacity);
  const databasePath = databasePathFor(options);
  const descriptorPath = descriptorPathFor(options);
  const instanceId = options.instanceId ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const capabilityToken = validateCapabilityToken(options.capabilityToken ?? randomBytes(32).toString('hex'));
  const isPidAlive = options.dependencies?.isPidAlive ?? options.isPidAlive ?? defaultIsPidAlive;
  const readDescriptor = options.dependencies?.readRuntimeDescriptor ?? options.readRuntimeDescriptor ?? defaultReadRuntimeDescriptor;
  const writeDescriptor = options.dependencies?.writeRuntimeDescriptor ?? options.writeRuntimeDescriptor ?? defaultWriteRuntimeDescriptor;
  const removeDescriptor = options.dependencies?.removeRuntimeDescriptor ?? options.removeRuntimeDescriptor ?? defaultRemoveRuntimeDescriptor;
  const createDescriptor = options.dependencies?.createRuntimeDescriptor ?? options.createRuntimeDescriptor ?? defaultCreateRuntimeDescriptor;
  const acquireLock = options.dependencies?.acquireInstanceLock ?? options.acquireInstanceLock ?? defaultAcquireInstanceLock;
  const initialize = options.dependencies?.initializeDatabase ?? options.initializeDatabase ?? defaultInitializeDatabase;
  const openDatabase = options.dependencies?.openDatabase ?? options.openDatabase ?? openConnection;
  const createHttpServer = options.dependencies?.createServer ?? options.createServer ?? nodeCreateServer;

  try {
    await assertDescriptorAvailable(readDescriptor, isPidAlive, descriptorPath);
  } catch (error) {
    throw safeStartupError(error);
  }

  let database: SqliteDatabase | undefined;
  let lock: InstanceLock | undefined;
  let server: Server | undefined;
  let descriptorAttempted = false;
  let serverClosed = false;
  let queueClosed = false;
  let databaseClosed = false;
  let lockReleased = false;
  let descriptorRemoved = false;
  let embeddingRuntime: EmbeddingRuntime | undefined;
  let embeddingWorker: EmbeddingWorker | undefined;
  let queueClosePromise: Promise<void> | undefined;

  const rollback = async (originalError: unknown): Promise<never> => {
           const cleanupErrors: unknown[] = [];
    if (embeddingWorker !== undefined) {
      try {
        await embeddingWorker.close();
        embeddingWorker = undefined;
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else if (embeddingRuntime !== undefined) {
      try {
        await embeddingRuntime.close();
        embeddingRuntime = undefined;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (server !== undefined && !serverClosed) {
      try {
        await closeServer(server);
        serverClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!queueClosed) {
      try {
        await queue.close();
        queueClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (database !== undefined && !databaseClosed) {
      try {
        database.close();
        databaseClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (descriptorAttempted && !descriptorRemoved) {
      try {
        await removeOwnedDescriptor(removeDescriptor, descriptorPath, instanceId);
        descriptorRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (lock !== undefined && !lockReleased) {
      try {
        await lock.release();
        lockReleased = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throwStartupFailure(originalError, cleanupErrors);
  };

  try {
    lock = await acquireLock(databasePath, lockOptionsFor(options, instanceId, pid, isPidAlive));
    await initialize({
      databasePath,
      ...(options.migrationsDirectory === undefined ? {} : { migrationsDirectory: options.migrationsDirectory }),
    });
    const embeddingConfig = options.embeddingConfig
      ?? (options.openDatabase === undefined && options.dependencies?.openDatabase === undefined
        ? undefined
        : defaultEmbeddingConfig());
    const configuredEmbeddingBackend = options.dependencies?.embeddingBackend ?? options.embeddingBackend;
    const opened = await openEmbeddingDatabase(databasePath, {
      ...(embeddingConfig === undefined ? {} : { config: embeddingConfig }),
      openDatabase,
      ...(configuredEmbeddingBackend === undefined ? {} : { backend: configuredEmbeddingBackend }),
    });
    database = opened.database;

    let closing = false;
    let ready = false;
    const requestAdmission = new AsyncLocalStorage<RequestAdmission>();
    let activeRequests = 0;
    const requestDrainWaiters: Array<() => void> = [];
    const waitForAcceptedRequests = (): Promise<void> => {
      if (activeRequests === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        requestDrainWaiters.push(resolve);
      });
    };
    const enqueueWrite = <T>(operation: () => T | PromiseLike<T>): Promise<T> => {
      if (closing && requestAdmission.getStore()?.active !== true) {
        return Promise.reject(new KiokukoError('SERVICE_UNAVAILABLE', 'Write queue is closed'));
      }
      return queue.enqueue(operation) as Promise<T>;
    };
    const enqueueRuntimeWrite = <T>(operation: () => T | PromiseLike<T>): Promise<T> => queue.enqueue(operation) as Promise<T>;
    const createRuntime = options.dependencies?.createEmbeddingRuntime
      ?? options.createEmbeddingRuntime
      ?? ((runtimeDatabase, config, runtimeOptions) => createEmbeddingRuntime(runtimeDatabase, config, runtimeOptions));
    const runtime = await createRuntime(database, embeddingConfig, {
      ...((options.dependencies?.embeddingProvider ?? options.embeddingProvider) === undefined
        ? {}
        : { provider: options.dependencies?.embeddingProvider ?? options.embeddingProvider }),
      ...(opened.backend === undefined ? {} : { backend: opened.backend }),
      enqueueWrite: enqueueRuntimeWrite,
    });
    embeddingRuntime = runtime;
    const createWorker = options.dependencies?.createEmbeddingWorker
      ?? options.createEmbeddingWorker
      ?? ((runtime: EmbeddingRuntime) => createEmbeddingWorker({ runtime }));
    if (runtime.profileId !== null) embeddingWorker = createWorker(runtime);
    const createAuthenticatedApp = (v1?: V1RouteHandler): RequestListener => createApp({
      expectedToken: capabilityToken,
      readiness: () => ready && !closing,
      ...(v1 === undefined ? {} : { v1 }),
    });
    const application = options.applicationFactory === undefined
      ? options.app ?? createAuthenticatedApp(options.v1)
      : options.applicationFactory({
        database,
        embeddingRuntime: runtime,
        enqueueWrite,
        createAuthenticatedApp,
      });
    const requestListener: RequestListener = (request, response) => {
      const admission: RequestAdmission = { active: true };
      activeRequests += 1;
      const settle = () => {
        if (!admission.active) return;
        admission.active = false;
        activeRequests -= 1;
        if (activeRequests !== 0) return;
        const waiters = requestDrainWaiters.splice(0);
        for (const resolve of waiters) resolve();
      };
      response.once('finish', settle);
      response.once('close', settle);
      try {
        requestAdmission.run(admission, () => application(request, response));
      } catch (error) {
        settle();
        throw error;
      }
    };
    server = createHttpServer(requestListener);
    await listen(server, port, host);
    const actualPort = listeningPort(server);
    const url = publicUrl(host, actualPort);
    const descriptor = createDescriptor({
      baseUrl: url,
      capabilityToken,
      databasePath,
      instanceId,
      pid,
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
    });

    await assertDescriptorAvailable(readDescriptor, isPidAlive, descriptorPath);
    descriptorAttempted = true;
    await writeDescriptor(descriptorPath, descriptor);
    ready = true;
    embeddingWorker?.start();
    const publicDescriptor = toPublicRuntimeDescriptor(descriptor);
    let closePromise: Promise<void> | undefined;

    const handle: HttpServerHandle = {
      server,
      url,
      descriptor: publicDescriptor,
      runtimeDescriptor: publicDescriptor,
      get queueState(): WriteQueueState {
        return queue.state;
      },
      enqueueWrite<T>(operation: () => T | PromiseLike<T>): Promise<T> {
        return enqueueWrite(operation);
      },
      close(): Promise<void> {
        if (closePromise !== undefined) return closePromise;
        closing = true;
        ready = false;
        const attempt = (async () => {
          const cleanupErrors: unknown[] = [];
          const capture = async (operation: () => unknown | PromiseLike<unknown>, completed: () => void): Promise<void> => {
            try {
              await operation();
              completed();
            } catch (error) {
              cleanupErrors.push(error);
            }
           };
           const closeQueue = async (): Promise<void> => {
             if (queueClosed) return;
             try {
               queueClosePromise ??= queue.close();
               await queueClosePromise;
               queueClosed = true;
             } catch (error) {
               cleanupErrors.push(error);
             }
            };
            embeddingWorker?.stop();
            if (activeRequests === 0 && embeddingWorker === undefined) queueClosePromise = queue.close();
            if (!serverClosed) {
             await capture(() => closeServer(server as Server), () => { serverClosed = true; });
           }
            if (embeddingWorker !== undefined) {
              await capture(() => embeddingWorker?.close(), () => { embeddingWorker = undefined; embeddingRuntime = undefined; });
            } else if (embeddingRuntime !== undefined) {
              await capture(() => embeddingRuntime?.close(), () => { embeddingRuntime = undefined; });
            }
            await capture(waitForAcceptedRequests, () => undefined);
            await closeQueue();
          if (database !== undefined && !databaseClosed) {
            await capture(() => database?.close(), () => { databaseClosed = true; });
          }
          if (!descriptorRemoved) {
            await capture(
              () => removeOwnedDescriptor(removeDescriptor, descriptorPath, instanceId),
              () => { descriptorRemoved = true; },
            );
          }
          if (lock !== undefined && !lockReleased) {
            await capture(() => lock?.release(), () => { lockReleased = true; });
          }
          throwCloseFailures(cleanupErrors);
        })();
        closePromise = attempt;
        void attempt.then(undefined, () => {
          if (closePromise === attempt) closePromise = undefined;
        });
        return attempt;
      },
    };
    return handle;
  } catch (error) {
    return rollback(error);
  }
}
