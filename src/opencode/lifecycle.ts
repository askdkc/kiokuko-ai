/** Stop ingress, cancel supported effects, and drain every operation owned by one plugin instance. */
export class OpenCodePluginLifecycle {
  private readonly controller = new AbortController();
  private readonly operations = new Set<Promise<void>>();
  private reconcileOperation: Promise<void> | undefined;
  private disposeOperation: Promise<void> | undefined;
  private stopped = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  isActive(): boolean {
    return !this.stopped;
  }

  run(operation: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    let running: Promise<void>;
    try {
      running = Promise.resolve(operation());
    } catch (error) {
      running = Promise.reject(error);
    }
    this.operations.add(running);
    void running.finally(() => this.operations.delete(running)).catch(() => undefined);
    return running;
  }

  reconcile(operation: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reconcileOperation !== undefined) return this.reconcileOperation;
    const running = this.run(operation);
    this.reconcileOperation = running;
    void running.finally(() => {
      if (this.reconcileOperation === running) this.reconcileOperation = undefined;
    }).catch(() => undefined);
    return running;
  }

  dispose(stopIngress: () => void): Promise<void> {
    if (this.disposeOperation !== undefined) return this.disposeOperation;
    this.stopped = true;
    stopIngress();
    this.controller.abort();
    const pending = [...this.operations];
    this.disposeOperation = Promise.allSettled(pending).then((results) => {
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'OpenCode plugin disposal observed failed in-flight work');
    });
    return this.disposeOperation;
  }
}
