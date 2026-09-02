import type { EmbeddingDrainResult, EmbeddingRuntime } from './types.js';

export const DEFAULT_EMBEDDING_WORKER_INTERVAL_MS = 5_000;
export const DEFAULT_EMBEDDING_WORKER_MAX_JOBS = 64;
export const DEFAULT_EMBEDDING_WORKER_DEADLINE_MS = 120_000;

export interface EmbeddingWorkerOptions {
  readonly runtime: EmbeddingRuntime;
  readonly intervalMs?: number;
  readonly maxJobs?: number;
  readonly deadlineMs?: number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly onDrain?: (result: EmbeddingDrainResult) => void | PromiseLike<void>;
  readonly onError?: (error: unknown) => void | PromiseLike<void>;
}

export interface EmbeddingWorker {
  readonly running: boolean;
  start(): void;
  stop(): void;
  close(): Promise<void>;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

/** Run bounded embedding drains without overlapping provider calls or timers. */
export function createEmbeddingWorker(options: EmbeddingWorkerOptions): EmbeddingWorker {
  const intervalMs = positiveInteger(options.intervalMs ?? DEFAULT_EMBEDDING_WORKER_INTERVAL_MS, 'intervalMs');
  const maxJobs = positiveInteger(options.maxJobs ?? DEFAULT_EMBEDDING_WORKER_MAX_JOBS, 'maxJobs');
  const deadlineMs = positiveInteger(options.deadlineMs ?? DEFAULT_EMBEDDING_WORKER_DEADLINE_MS, 'deadlineMs');
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  let started = false;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;

  const schedule = (delay: number): void => {
    if (!started || closing || timer !== undefined) return;
    timer = setTimer(() => {
      timer = undefined;
      void run();
    }, delay);
  };

  const run = async (): Promise<void> => {
    if (!started || closing || active !== undefined) return;
    const operation = (async () => {
      try {
        const result = await options.runtime.drain({ maxJobs, deadlineMs });
        await options.onDrain?.(result);
      } catch (error) {
        try {
          await options.onError?.(error);
        } catch {
          // A background observer must not create an unhandled rejection.
        }
      }
    })();
    active = operation;
    try {
      await operation;
    } finally {
      if (active === operation) active = undefined;
      schedule(intervalMs);
    }
  };

  const stop = (): void => {
    if (closing) return;
    closing = true;
    started = false;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const worker: EmbeddingWorker = {
    get running(): boolean {
      return started && !closing;
    },
    start(): void {
      if (started || closing) return;
      started = true;
      schedule(0);
    },
    stop,
    async close(): Promise<void> {
      stop();
      await options.runtime.close();
      await active;
    },
  };
  return Object.freeze(worker);
}
