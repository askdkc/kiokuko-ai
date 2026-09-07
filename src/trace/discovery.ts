import type { SqliteDatabase } from '../db/adapter.js';
import { TraceScanSession, scanOrcaTraceStore } from './scan.js';
import { registerTraceStore, validateTraceStore, type TraceStoreLocation } from './store-location.js';
import { TraceInputError } from './bounded-read.js';
export class TraceDiscoveryCoordinator {
    #sessions = new Map<string, TraceScanSession>();
    #abort = new AbortController();
    #timer: ReturnType<typeof setTimeout> | undefined;
    #active: Promise<void> | undefined;
    #index = 0;
    #running = false;
    #lastError: string | null = null;
    get lastError(): string | null { return this.#lastError; }
    constructor(readonly database: SqliteDatabase, readonly intervalMs = 1000) { }
    register(location: TraceStoreLocation): void {
        if (!this.#abort.signal.aborted)
            registerTraceStore(this.database, location);
    }
    async step(): Promise<void> {
        if (this.#abort.signal.aborted)
            return;
        const stores = this.database.prepare('SELECT directory AS runsDirectory,repository_root AS repositoryRoot,capture_cwd AS captureCwd FROM orcareplay_trace_stores ORDER BY directory').all<TraceStoreLocation & Record<string, unknown>>();
        if (!stores.length)
            return;
        const store = stores[this.#index++ % stores.length]!;
        try {
            const state = await validateTraceStore(store);
            if (this.#abort.signal.aborted)
                return;
            this.database.prepare('UPDATE orcareplay_trace_stores SET state=?,diagnostic_code=NULL WHERE directory=?').run(state, store.runsDirectory);
            if (state !== 'present')
                return;
            let session = this.#sessions.get(store.runsDirectory);
            if (!session || session.complete) {
                if (session)
                    await session.close();
                session = new TraceScanSession(store.runsDirectory);
                this.#sessions.set(store.runsDirectory, session);
            }
            await scanOrcaTraceStore(this.database, store.runsDirectory, { session, signal: this.#abort.signal });
        }
        catch (error) {
            if (!(error instanceof TraceInputError))
                throw error;
            if (!this.#abort.signal.aborted)
                this.database.prepare("UPDATE orcareplay_trace_stores SET state='blocked',diagnostic_code=? WHERE directory=?").run(error.code, store.runsDirectory);
        }
    }
    start(): void {
        if (this.#running || this.#abort.signal.aborted)
            return;
        this.#running = true;
        const tick = () => {
            if (this.#abort.signal.aborted)
                return;
            this.#active = this.step();
            void this.#active.catch(() => { this.#lastError = "trace_discovery_failed"; }).finally(() => {
                this.#active = undefined;
                if (!this.#abort.signal.aborted) {
                    this.#timer = setTimeout(tick, this.intervalMs);
                    this.#timer.unref();
                }
            });
        };
        this.#timer = setTimeout(tick, 0);
        this.#timer.unref();
    }
    stop(): void {
        this.#abort.abort();
        if (this.#timer)
            clearTimeout(this.#timer);
    }
    async close(): Promise<void> {
        this.stop();
        const errors: unknown[] = [];
        try {
            await this.#active;
        }
        catch (error) {
            errors.push(error);
        }
        for (const session of this.#sessions.values())
            try {
                await session.close();
            }
            catch (error) {
                errors.push(error);
            }
        this.#sessions.clear();
        if (errors.length)
            throw new AggregateError(errors, 'Trace discovery cleanup failed');
    }
}
