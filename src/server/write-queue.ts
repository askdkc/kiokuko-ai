import { KiokukoError } from '../errors.js';

export interface WriteQueueState {
  readonly accepting: boolean;
  readonly running: boolean;
  readonly waiting: number;
}

type WriteOperation<T> = () => T | PromiseLike<T>;

export const WRITE_QUEUE_RETRY_AFTER_SECONDS = 1;

interface QueueItem<T> {
  readonly operation: WriteOperation<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export class WriteQueue<T> {
  readonly #waitingCapacity: number;
  readonly #items: Array<QueueItem<T>> = [];
  #accepting = true;
  #running = false;
  readonly #drainWaiters: Array<() => void> = [];

  constructor(waitingCapacity: number) {
    if (!Number.isInteger(waitingCapacity) || waitingCapacity <= 0) {
      throw new KiokukoError('VALIDATION_ERROR', 'waitingCapacity must be a positive integer');
    }
    this.#waitingCapacity = waitingCapacity;
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  get running(): boolean {
    return this.#running;
  }

  get waiting(): number {
    return this.#items.length;
  }

  get state(): WriteQueueState {
    return {
      accepting: this.#accepting,
      running: this.#running,
      waiting: this.#items.length,
    };
  }

  enqueue(operation: WriteOperation<T>): Promise<T> {
    if (!this.#accepting) {
      return Promise.reject(new KiokukoError('SERVICE_UNAVAILABLE', 'Write queue is closed'));
    }

    if (this.#items.length >= this.#waitingCapacity) {
      return Promise.reject(new KiokukoError('BACKPRESSURE', 'Write queue is at capacity', {
        retryAfterSeconds: WRITE_QUEUE_RETRY_AFTER_SECONDS,
      }));
    }

    return new Promise<T>((resolve, reject) => {
      this.#items.push({ operation, resolve, reject });
      this.#startNext();
    });
  }

  close(): Promise<void> {
    this.#accepting = false;
    return this.drain();
  }

  drain(): Promise<void> {
    if (!this.#running && this.#items.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  #startNext(): void {
    if (this.#running) return;
    const item = this.#items.shift();
    if (item === undefined) return;

    this.#running = true;
    void Promise.resolve()
      .then(item.operation)
      .then(
        (value) => {
          item.resolve(value);
          this.#finishCurrent();
        },
        (error: unknown) => {
          item.reject(error);
          this.#finishCurrent();
        },
      );
  }

  #finishCurrent(): void {
    this.#running = false;
    this.#startNext();
    if (this.#running || this.#items.length > 0) return;
    const waiters = this.#drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
