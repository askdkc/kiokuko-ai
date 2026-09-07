import path from 'node:path';
import { opendir, lstat } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import type { SqliteDatabase } from '../db/adapter.js';
import { enqueueOrchestrationJob } from '../orchestration/jobs.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { findSecretInValue } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';
import { readOrcaTraceManifest, ORCA_TRACE_RUN_ID_PATTERN } from './orca-trace.js';
import { TRACE_LIMITS, TraceInputError, assertTracePath, traceCaptureRoot, fileIdentity, readBoundedTraceFile } from './bounded-read.js';
import { createHash } from 'node:crypto';
export const ORCA_TRACE_SCAN_MAX_RUNS = 8;
export interface TraceScanOutcome {
    runsDirectory: string;
    scanned: number;
    enqueued: number;
    skippedUnsupported: number;
    storesVisited: number;
    discovered: number;
    scanComplete: boolean;
    hasMore: boolean;
    warningCodes: string[];
}
export function orcaRunsDirectory(root: string): string {
    if (!path.isAbsolute(root) || root.length > 4096)
        throw new KiokukoError('VALIDATION_ERROR', 'Project root invalid');
    return path.join(root, '.orca', 'runs');
}
/** A live Dir handle is deliberately retained across bounded steps. */
export class TraceScanSession {
    #dir: Dir | undefined;
    #closed = false;
    complete = false;
    constructor(readonly runsDirectory: string) { }
    async step(database: SqliteDatabase, limit: number = TRACE_LIMITS.discovery, signal?: AbortSignal): Promise<number> {
        if (this.#closed || this.complete)
            return 0;
        if (!this.#dir) {
            try {
                await assertTracePath(this.runsDirectory, traceCaptureRoot(this.runsDirectory));
                this.#dir = await opendir(this.runsDirectory);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    this.complete = true;
                    return 0;
                }
                throw error;
            }
        }
        let discovered = 0;
        for (let i = 0; i < limit; i++) {
            if (this.#closed || signal?.aborted)
                break;
            const entry = await this.#dir.read();
            if (this.#closed || signal?.aborted)
                break;
            if (!entry) {
                this.complete = true;
                await this.#dir.close();
                this.#dir = undefined;
                break;
            }
            if (!ORCA_TRACE_RUN_ID_PATTERN.test(entry.name))
                continue;
            const now = new Date().toISOString();
            database.prepare(`INSERT INTO orcareplay_trace_cursors(directory,trace_run_id,created_at,updated_at,finalization,diagnostic_code)
    VALUES(?,?,?,?,?,?) ON CONFLICT(directory,trace_run_id) DO NOTHING`).run(this.runsDirectory, entry.name, now, now, entry.isDirectory() ? 'recording' : 'blocked', entry.isDirectory() ? null : 'run_not_directory');
            discovered++;
        }
        return discovered;
    }
    async close(): Promise<void> {
        this.#closed = true;
        if (this.#dir) {
            await this.#dir.close();
            this.#dir = undefined;
        }
    }
}
export async function scanOrcaTraceStore(database: SqliteDatabase, runsDirectory: string, options: {
    maxRuns?: number;
    now?: string;
    session?: TraceScanSession;
    signal?: AbortSignal;
    traceRunId?: string;
} = {}): Promise<TraceScanOutcome> {
    if (!path.isAbsolute(runsDirectory) || runsDirectory.length > 4096)
        throw new KiokukoError('VALIDATION_ERROR', 'Trace store path invalid');
    const limit = options.maxRuns ?? ORCA_TRACE_SCAN_MAX_RUNS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
        throw new KiokukoError('VALIDATION_ERROR', 'Trace scan limit invalid');
    const session = options.session ?? new TraceScanSession(runsDirectory);
    const out: TraceScanOutcome = { runsDirectory, scanned: 0, enqueued: 0, skippedUnsupported: 0, storesVisited: 1, discovered: 0, scanComplete: false, hasMore: false, warningCodes: [] };
    try {
        out.discovered = await session.step(database, TRACE_LIMITS.discovery, options.signal);
        out.scanComplete = session.complete;
        const rows = database.prepare(`SELECT trace_run_id AS id,last_seq AS seq,generation,revision,next_byte_offset AS offset,input_fingerprint AS fingerprint,
   finalization FROM orcareplay_trace_cursors WHERE directory=? ${options.traceRunId === undefined ? '' : 'AND trace_run_id=?'} ORDER BY last_checked_at,trace_run_id LIMIT ?`).all<{
            id: string;
            seq: number;
            generation: number;
            revision: number;
            offset: number;
            fingerprint: string | null;
            finalization: string;
        }>(runsDirectory, ...(options.traceRunId === undefined ? [] : [options.traceRunId]), limit);
        for (const row of rows) {
            if (options.signal?.aborted)
                break;
            out.scanned++;
            const now = options.now ?? new Date().toISOString();
            // Monotonic processing opportunities also work when callers inject one timestamp.
            database.prepare("UPDATE orcareplay_trace_cursors SET last_checked_at=printf('%020d',(SELECT COALESCE(CAST(MAX(last_checked_at) AS INTEGER),0)+1 FROM orcareplay_trace_cursors WHERE directory=?)) WHERE directory=? AND trace_run_id=?").run(runsDirectory, runsDirectory, row.id);
            try {
                const manifestPath = path.join(runsDirectory, row.id, 'manifest.json');
                const raw = await readBoundedTraceFile(manifestPath, traceCaptureRoot(runsDirectory), TRACE_LIMITS.manifest);
                const manifestHash = createHash('sha256').update(raw).digest('hex');
                const eventsPath = path.join(runsDirectory, row.id, 'events.jsonl');
                await assertTracePath(eventsPath, traceCaptureRoot(runsDirectory));
                const stat = await lstat(eventsPath);
                if (!stat.isFile())
                    throw new TraceInputError('not_regular_file');
                const fingerprint = canonicalContentHash({ manifestHash, file: fileIdentity(stat) });
                if (row.fingerprint === fingerprint)
                    continue;
                const manifest = await readOrcaTraceManifest(runsDirectory, row.id);
                if (options.signal?.aborted)
                    break;
                if (!manifest.ok && manifest.reason === 'unsupported_schema') {
                    database.prepare("UPDATE orcareplay_trace_cursors SET state='unsupported',finalization='unsupported',input_fingerprint=? WHERE directory=? AND trace_run_id=?").run(fingerprint, runsDirectory, row.id);
                    out.skippedUnsupported++;
                    continue;
                }
                if (!manifest.ok) {
                    database.prepare('UPDATE orcareplay_trace_cursors SET diagnostic_code=? WHERE directory=? AND trace_run_id=?').run(manifest.reason, runsDirectory, row.id);
                    out.warningCodes.push(manifest.reason);
                    continue;
                }
                const payload = { directory: runsDirectory, traceRunId: row.id, fromSeq: Math.max(0, row.seq + 1), generation: row.generation, readerPolicyVersion: 2,
                    revision: row.revision, offset: row.offset, fingerprint };
                if (findSecretInValue(payload) !== undefined)
                    throw new TraceInputError('unsafe_job_payload');
                const digest = canonicalContentHash({ kind: 'trace_ingestion', runId: null, payload });
                const exists = database.prepare("SELECT 1 FROM orchestration_jobs WHERE kind='trace_ingestion' AND input_digest=?").get(digest);
                if (!exists) {
                    enqueueOrchestrationJob(database, { kind: 'trace_ingestion', payload, now });
                    out.enqueued++;
                }
                database.prepare('UPDATE orcareplay_trace_cursors SET input_fingerprint=? WHERE directory=? AND trace_run_id=?').run(fingerprint, runsDirectory, row.id);
            }
            catch (error) {
                if (options.signal?.aborted)
                    break;
                const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
                if (!(error instanceof TraceInputError) && !missing)
                    throw error;
                const code = missing ? 'source_missing' : (error as TraceInputError).code;
                database.prepare('UPDATE orcareplay_trace_cursors SET finalization=?,diagnostic_code=? WHERE directory=? AND trace_run_id=?').run(missing ? 'source_missing' : 'blocked', code, runsDirectory, row.id);
                if (out.warningCodes.length < TRACE_LIMITS.warnings)
                    out.warningCodes.push(code);
            }
        }
        out.hasMore = !out.scanComplete || database.prepare("SELECT 1 FROM orcareplay_trace_cursors WHERE directory=? AND last_checked_at='' LIMIT 1").get(runsDirectory) !== undefined;
        return out;
    }
    finally {
        if (!options.session)
            await session.close();
    }
}
