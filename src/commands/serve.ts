import { KiokukoError } from '../errors.js';
import { startAgentHttpServer } from '../server/agent-application.js';
import type { RuntimeDescriptorView } from '../server/runtime-descriptor.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
type SignalName = 'SIGINT' | 'SIGTERM';

type SignalListener = () => void;

export interface SignalSource {
  once(signal: SignalName, listener: SignalListener): unknown;
  off(signal: SignalName, listener: SignalListener): unknown;
}

export interface ServeCommandOptions {
  readonly host?: string;
  readonly port?: number;
  readonly json?: boolean;
}

export interface ServeStartup {
  readonly status: 'running';
  readonly url: string;
  readonly descriptor: RuntimeDescriptorView;
}

export interface ServeRuntime {
  readonly url: string;
  readonly descriptor: RuntimeDescriptorView;
  close(): Promise<void> | void;
}

export type ServeStarter = (options: { readonly host: string; readonly port: number }) => PromiseLike<ServeRuntime>;

export interface ServeCommandDependencies {
  readonly startServer?: ServeStarter;
  readonly signals?: SignalSource;
  readonly onStarted?: (startup: ServeStartup) => void | PromiseLike<void>;
}

const processSignals: SignalSource = {
  once: (signal, listener) => {
    process.once(signal, listener);
  },
  off: (signal, listener) => {
    process.off(signal, listener);
  },
};

function safeCommandError(error: unknown, phase: 'startup' | 'close' | 'post-start'): KiokukoError {
  if (error instanceof KiokukoError) {
    const messages: Record<string, string> = {
      VALIDATION_ERROR: 'Runtime configuration is invalid',
      CONFLICT: 'Request conflicts with current runtime state',
      SECURITY_REJECTION: 'Runtime file was rejected',
      SERVICE_UNAVAILABLE: phase === 'close' ? 'Unable to close the HTTP server' : 'The HTTP server is unavailable',
      DATABASE_ERROR: phase === 'close' ? 'Unable to close the HTTP server' : 'Unable to start the HTTP server',
    };
    return new KiokukoError(error.code, messages[error.code] ?? 'Unable to run the HTTP server');
  }
  return new KiokukoError(
    phase === 'close' ? 'SERVICE_UNAVAILABLE' : 'DATABASE_ERROR',
    phase === 'close' ? 'Unable to close the HTTP server' : 'Unable to start the HTTP server',
  );
}

function publicDescriptor(descriptor: RuntimeDescriptorView): RuntimeDescriptorView {
  return {
    protocolVersion: descriptor.protocolVersion,
    instanceId: descriptor.instanceId,
    pid: descriptor.pid,
    baseUrl: descriptor.baseUrl,
    databaseFingerprint: descriptor.databaseFingerprint,
    startedAt: descriptor.startedAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export async function runServeCommand(
  options: ServeCommandOptions = {},
  dependencies: ServeCommandDependencies = {},
): Promise<void> {
  const startServer: ServeStarter = dependencies.startServer ?? (startAgentHttpServer as ServeStarter);
  const signals = dependencies.signals ?? processSignals;
  let runtime: ServeRuntime | undefined;

  try {
    try {
      runtime = await startServer({
        host: options.host ?? DEFAULT_HOST,
        port: options.port ?? DEFAULT_PORT,
      });
    } catch (error) {
      throw safeCommandError(error, 'startup');
    }

    const startup: ServeStartup = {
      status: 'running',
      url: runtime.url,
      descriptor: publicDescriptor(runtime.descriptor),
    };
    const shutdown = deferred<void>();
    let closePromise: Promise<void> | undefined;
    const closeOnce = (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closePromise = Promise.resolve()
        .then(() => runtime?.close())
        .then(() => undefined)
        .catch((error: unknown) => {
          throw safeCommandError(error, 'close');
        });
      return closePromise;
    };
    const onSignal = (): void => {
      void closeOnce().then(shutdown.resolve, shutdown.reject);
    };

    try {
      signals.once('SIGINT', onSignal);
      signals.once('SIGTERM', onSignal);
      try {
        await dependencies.onStarted?.(startup);
      } catch (error) {
        if (closePromise === undefined) await closeOnce().catch(() => undefined);
        throw safeCommandError(error, 'post-start');
      }
      await shutdown.promise;
    } catch (error) {
      if (closePromise === undefined) await closeOnce().catch(() => undefined);
      throw error instanceof KiokukoError ? error : safeCommandError(error, 'post-start');
    } finally {
      try {
        signals.off('SIGINT', onSignal);
      } catch {
        // Listener cleanup must not replace the command result.
      }
      try {
        signals.off('SIGTERM', onSignal);
      } catch {
        // Listener cleanup must not replace the command result.
      }
    }
  } catch (error) {
    if (runtime !== undefined && !(error instanceof KiokukoError)) {
      throw safeCommandError(error, 'post-start');
    }
    throw error;
  }
}
