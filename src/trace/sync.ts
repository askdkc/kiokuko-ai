import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import { claimOrchestrationJobs, completeOrchestrationJob, failOrchestrationJob } from '../orchestration/jobs.js';
import { executeTraceJob } from '../orchestration/worker.js';
import { resolveTraceStoreLocation, registerTraceStore, validateTraceStore, type TraceStoreLocation } from './store-location.js';
import { TraceScanSession, scanOrcaTraceStore } from './scan.js';
import { requireTraceRunId } from './ingest.js';
import { TRACE_LIMITS, TraceInputError } from './bounded-read.js';
export interface TraceSyncOptions {
    captureCwd: string;
    traceRunId?: string;
    timeoutMs?: number;
    rebuild?: boolean;
    signal?: AbortSignal;
}
export type TraceSyncResult = JsonObject & {
    status: 'completed' | 'partial';
    exitCode: number;
    runsDirectory: string;
    processed: number;
    warningCodes: string[];
};
export function traceStatus(database: SqliteDatabase, location: TraceStoreLocation, traceRunId?: string): JsonObject {
    const rows = database.prepare(`SELECT trace_run_id AS traceRunId,generation,next_byte_offset AS nextByteOffset,last_seq AS lastSeq,
  finalization,integrity,diagnostic_code AS diagnosticCode FROM orcareplay_trace_cursors WHERE directory=? ${traceRunId === undefined ? '' : 'AND trace_run_id=?'} ORDER BY trace_run_id`).all<Record<string, any>>(location.runsDirectory, ...(traceRunId === undefined ? [] : [traceRunId]));
    return { runsDirectory: location.runsDirectory, repositoryRoot: location.repositoryRoot, captureCwd: location.captureCwd,
        store: database.prepare('SELECT state,diagnostic_code AS diagnosticCode FROM orcareplay_trace_stores WHERE directory=?').get<Record<string, any>>(location.runsDirectory) ?? null,
        jobs: database.prepare("SELECT state,COUNT(*) AS count FROM orchestration_jobs WHERE kind='trace_ingestion' AND json_extract(payload_json,'$.directory')=? GROUP BY state").all<Record<string, any>>(location.runsDirectory).map(x => ({ ...x })),
        runs: rows.map(row => ({ ...row, retryable: ['ended_unverified', 'ended_pending_manifest', 'source_missing'].includes(row.finalization) })) };
}
export async function syncTraceStore(database: SqliteDatabase, options: TraceSyncOptions): Promise<TraceSyncResult> {
    const timeout = options.timeoutMs ?? TRACE_LIMITS.syncMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86400000)
        throw new KiokukoError('VALIDATION_ERROR', 'Sync timeout invalid');
    const id = options.traceRunId === undefined ? undefined : requireTraceRunId(options.traceRunId);
    const location = await resolveTraceStoreLocation(options.captureCwd);
    registerTraceStore(database, location);
    const scope = { directory: location.runsDirectory, ...(id ? { traceRunId: id } : {}) };
    const result: TraceSyncResult = { status: 'completed', exitCode: 0, runsDirectory: location.runsDirectory, processed: 0, warningCodes: [] };
    const controller = new AbortController();
    const forward = () => controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    if (options.signal?.aborted)
        controller.abort();
    const timer = setTimeout(() => controller.abort(), timeout);
    const session = new TraceScanSession(location.runsDirectory);
    const owner = `trace-sync-${randomUUID()}`;
    try {
        const state = await validateTraceStore(location);
        database.prepare('UPDATE orcareplay_trace_stores SET state=? WHERE directory=?').run(state, location.runsDirectory);
        if (state === 'missing') {
            if (id)
                throw new KiokukoError('NOT_FOUND', 'Requested trace run was not found');
            return result;
        }
        // Discovery progresses in one retained enumeration session.
        while (!session.complete) {
            controller.signal.throwIfAborted();
            await session.step(database, TRACE_LIMITS.discovery, controller.signal);
        }
        if (id && !database.prepare('SELECT 1 FROM orcareplay_trace_cursors WHERE directory=? AND trace_run_id=?').get(location.runsDirectory, id))
            throw new KiokukoError('NOT_FOUND', 'Requested trace run was not found');
        if (options.rebuild)
            withImmediateTransaction(database, () => {
                database.prepare(`UPDATE orcareplay_trace_cursors SET generation=generation+1,revision=revision+1,next_byte_offset=0,last_seq=-1,
    aggregate_json=NULL,aggregate_digest=NULL,file_identity_json=NULL,manifest_fingerprint=NULL,input_fingerprint=NULL,finalization='recording',state='active',diagnostic_code=NULL
    WHERE directory=? ${id ? 'AND trace_run_id=?' : ''}`).run(location.runsDirectory, ...(id ? [id] : []));
            });
        const count = database.prepare(`SELECT COUNT(*) AS n FROM orcareplay_trace_cursors WHERE directory=? ${id ? 'AND trace_run_id=?' : ''}`).get<{
            n: number;
        }>(location.runsDirectory, ...(id ? [id] : []))!.n;
        // Check every known run once, without waiting for future changes to live runs.
        for (let n = 0; n < count; n += 64) {
            controller.signal.throwIfAborted();
            const scan = await scanOrcaTraceStore(database, location.runsDirectory, { session, maxRuns: Math.min(64, count - n), signal: controller.signal, ...(id ? { traceRunId: id } : {}) });
            result.warningCodes.push(...scan.warningCodes);
        }
        for (;;) {
            controller.signal.throwIfAborted();
            const [job] = claimOrchestrationJobs(database, { owner, limit: 1, leaseMs: 120000, kinds: ['trace_ingestion'], traceScope: scope });
            if (!job) {
                const busy = database.prepare(`SELECT 1 FROM orchestration_jobs WHERE kind='trace_ingestion' AND json_extract(payload_json,'$.directory')=?
     ${id ? "AND json_extract(payload_json,'$.traceRunId')=?" : ''} AND state IN ('pending','leased','failed','abandoned') AND attempts<20 LIMIT 1`).get(location.runsDirectory, ...(id ? [id] : []));
                if (!busy)
                    break;
                await wait(10, undefined, { signal: controller.signal });
                continue;
            }
            try {
                const outcome = await executeTraceJob({ database }, job, controller.signal);
                completeOrchestrationJob(database, { jobId: job.jobId, owner, result: outcome });
                result.processed++;
            }
            catch (error) {
                failOrchestrationJob(database, { jobId: job.jobId, owner, errorCode: error instanceof TraceInputError ? error.code : error instanceof KiokukoError ? error.code : 'trace_sync_failed', retryAt: new Date(Date.now() + 1000).toISOString() });
                throw error;
            }
        }
        const states = database.prepare(`SELECT finalization,COUNT(*) AS count FROM orcareplay_trace_cursors WHERE directory=? ${id ? 'AND trace_run_id=?' : ''} GROUP BY finalization`).all<{
            finalization: string;
            count: number;
        }>(location.runsDirectory, ...(id ? [id] : []));
        result.snapshots = states.map(x => ({ ...x }));
        const partial = database.prepare(`SELECT 1 FROM orcareplay_trace_cursors WHERE directory=? ${id ? 'AND trace_run_id=?' : ''}
   AND (finalization NOT IN ('recording','finalized') OR diagnostic_code IS NOT NULL) LIMIT 1`).get(location.runsDirectory, ...(id ? [id] : []));
        if (partial || result.warningCodes.length) {
            result.status = 'partial';
            result.exitCode = 3;
        }
    }
    catch (error) {
        if (!controller.signal.aborted && !(error instanceof TraceInputError))
            throw error;
        result.status = 'partial';
        result.exitCode = 3;
        result.warningCodes.push(controller.signal.aborted ? 'sync_interrupted' : (error as TraceInputError).code);
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', forward);
        await session.close();
    }
    result.warningCodes = [...new Set(result.warningCodes)].slice(0, TRACE_LIMITS.warnings);
    canonicalContentHash(result);
    return result;
}
