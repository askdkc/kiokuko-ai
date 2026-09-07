import { validateSkillQuery } from '../skills/query-builder.js';
import { normalizeSkillDiscoveryMode } from '../skills/config.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { findSecretInValue } from '../memory/secrets.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import { enqueueOrchestrationJob, assertOrchestrationJobLease } from '../orchestration/jobs.js';
import { readOrcaTraceManifest, readTraceBatch, ORCA_TRACE_READER_POLICY_VERSION } from './orca-trace.js';
import { applyTraceEvents, buildTraceContext, buildTraceMemoryCandidates, traceProjectionSchema, type TraceProjection } from './aggregate.js';
import { TRACE_LIMITS, TraceInputError, sameFile, fileIdentity, parseTraceJson, type TraceFileIdentity } from './bounded-read.js';
export const ORCA_TRACE_CONTEXT_MAX_BYTES = TRACE_LIMITS.context;
export const ORCA_TRACE_MAX_MEMORY_CANDIDATES = 8;
export const ORCA_TRACE_MAX_SKILL_QUERIES = 3;
export const ORCA_TRACE_MAX_SKILL_CANDIDATES = 2;
export type TraceIngestOutcome = JsonObject & {
    ingested: boolean;
    reason: string | null;
    traceRunId: string;
    throughSeq: number;
    cursorSeq: number;
    integrity: 'verified' | 'mismatch' | 'unavailable';
    contextDigest: string | null;
    memoryCandidates: number;
    suppressedMemoryCandidates: number;
    skillCandidates: number;
    hasMore: boolean;
    finalization: string;
};
export interface TraceIngestInput {
    runsDirectory: string;
    traceRunId: string;
    fromSeq: number;
    fetchImpl?: typeof fetch;
    now?: string;
    skillDiscoveryMode?: 'off' | 'official' | 'community';
    signal?: AbortSignal;
    maxBytes?: number;
    maxEvents?: number;
    beforeCommit?: () => void | Promise<void>;
    beforeFinalVerify?: () => void | Promise<void>;
    lease?: {
        jobId: string;
        owner: string;
    };
}
export interface TraceCursorRow {
    lastSeq: number;
    state: 'active' | 'unsupported';
    updatedAt: string;
    generation: number;
    revision: number;
    offset: number;
    fileIdentity: TraceFileIdentity | null;
    manifestFingerprint: string | null;
    aggregate: TraceProjection | undefined;
    finalization: string;
    integrity: 'verified' | 'mismatch' | 'unavailable';
}
export function requireTraceRunId(value: unknown): string {
    if (typeof value !== 'string' || !/^run_[0-9a-f]{6,32}$/u.test(value))
        throw new KiokukoError('INTEGRITY_ERROR', 'Trace run ID is invalid');
    return value;
}
export function readTraceCursor(database: SqliteDatabase, directory: string, id: string): TraceCursorRow | undefined {
    const row = database.prepare('SELECT * FROM orcareplay_trace_cursors WHERE directory=? AND trace_run_id=?').get<Record<string, any>>(directory, id);
    if (!row)
        return undefined;
    if (!Number.isSafeInteger(row.last_seq) || row.last_seq < -1 || !Number.isSafeInteger(row.revision) || !Number.isSafeInteger(row.generation))
        throw new KiokukoError('INTEGRITY_ERROR', 'Trace cursor invalid');
    const aggregate = row.aggregate_json === null ? undefined : parseTraceJson(row.aggregate_json) as unknown as TraceProjection;
    if (aggregate && (!traceProjectionSchema.safeParse(aggregate).success || canonicalContentHash(aggregate) !== row.aggregate_digest || findSecretInValue(aggregate) !== undefined || !Number.isSafeInteger(aggregate.events)))
        throw new KiokukoError('INTEGRITY_ERROR', 'Trace aggregate invalid');
    return { lastSeq: row.last_seq, state: row.state, updatedAt: row.updated_at, generation: row.generation, revision: row.revision,
        offset: row.next_byte_offset, fileIdentity: row.file_identity_json === null ? null : JSON.parse(row.file_identity_json),
        manifestFingerprint: row.manifest_fingerprint, aggregate, finalization: row.finalization, integrity: row.integrity };
}
export function upsertTraceCursor(database: SqliteDatabase, input: {
    runsDirectory: string;
    traceRunId: string;
    lastSeq: number;
    state: 'active' | 'unsupported';
    now: string;
}): void {
    if (!Number.isSafeInteger(input.lastSeq) || input.lastSeq < -1)
        throw new KiokukoError('VALIDATION_ERROR', 'Trace sequence invalid');
    database.prepare(`INSERT INTO orcareplay_trace_cursors(directory,trace_run_id,last_seq,state,created_at,updated_at)
 VALUES(?,?,?,?,?,?) ON CONFLICT(directory,trace_run_id) DO UPDATE SET last_seq=excluded.last_seq,state=excluded.state,updated_at=excluded.updated_at`).run(input.runsDirectory, input.traceRunId, input.lastSeq, input.state, input.now, input.now);
}
export function readStoredTraceContext(database: SqliteDatabase, runsDirectory: string, traceRunId: string): {
    digest: string;
    context: JsonObject;
} | undefined {
    const row = database.prepare(`
    SELECT digest AS digest, context_json AS contextJson
    FROM orcareplay_trace_context
    WHERE directory = ? AND trace_run_id = ?
  `).get<{
        digest: unknown;
        contextJson: unknown;
    }>(runsDirectory, traceRunId);
    if (row === undefined)
        return undefined;
    if (typeof row.digest !== 'string' || typeof row.contextJson !== 'string') {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored OrcaReplay trace context is invalid');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.contextJson);
    }
    catch {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored OrcaReplay trace context is invalid');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored OrcaReplay trace context is invalid');
    }
    return { digest: row.digest, context: parsed as JsonObject };
}
function writeTraceContext(database: SqliteDatabase, input: {
    readonly runsDirectory: string;
    readonly traceRunId: string;
    readonly digest: string;
    readonly contextJson: string;
    readonly now: string;
}): 'inserted' | 'unchanged' | 'updated' {
    const existing = database.prepare('SELECT digest,context_json AS json FROM orcareplay_trace_context WHERE directory=? AND trace_run_id=?').get<{
        digest: string;
        json: string;
    }>(input.runsDirectory, input.traceRunId);
    if (existing !== undefined && existing.digest === input.digest && existing.json === input.contextJson)
        return 'unchanged';
    database.prepare(`
    INSERT INTO orcareplay_trace_context (directory, trace_run_id, digest, context_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'orcareplay', ?, ?)
    ON CONFLICT(directory, trace_run_id) DO UPDATE SET
      digest = excluded.digest,
      context_json = excluded.context_json,
      source = excluded.source,
      updated_at = excluded.updated_at
    WHERE orcareplay_trace_context.digest <> excluded.digest OR orcareplay_trace_context.context_json <> excluded.context_json
  `).run(input.runsDirectory, input.traceRunId, input.digest, input.contextJson, input.now, input.now);
    return existing === undefined ? 'inserted' : 'updated';
}
/** Read outside the transaction; publish progress, projection and candidates under one CAS. */
export async function ingestTraceRun(database: SqliteDatabase, input: TraceIngestInput): Promise<TraceIngestOutcome> {
    const runs = input.runsDirectory;
    const id = requireTraceRunId(input.traceRunId);
    if (!path.isAbsolute(runs) || runs.length > 4096 || !Number.isSafeInteger(input.fromSeq) || input.fromSeq < 0)
        throw new KiokukoError('INTEGRITY_ERROR', 'Trace ingestion input invalid');
    const previous = readTraceCursor(database, runs, id);
    const now = input.now ?? new Date().toISOString();
    let interruptedFinalization = false;
    const leaseCheck = () => { if (!interruptedFinalization)
        input.signal?.throwIfAborted(); if (input.lease)
        assertOrchestrationJobLease(database, input.lease); };
    const cas = () => {
        leaseCheck();
        const current = readTraceCursor(database, runs, id);
        if (current?.revision !== previous?.revision || current?.generation !== previous?.generation)
            throw new KiokukoError('CONFLICT', 'Trace progress changed');
    };
    const outcome: TraceIngestOutcome = { ingested: false, reason: null, traceRunId: id, throughSeq: previous?.lastSeq ?? -1, cursorSeq: previous?.lastSeq ?? -1,
        integrity: previous?.integrity ?? 'unavailable', contextDigest: null, memoryCandidates: 0, suppressedMemoryCandidates: 0, skillCandidates: 0, hasMore: false, finalization: previous?.finalization ?? 'recording' };
    const manifestRead = await readOrcaTraceManifest(runs, id);
    if (!manifestRead.ok) {
        outcome.reason = manifestRead.reason;
        outcome.finalization = manifestRead.reason === 'unsupported_schema' ? 'unsupported' : 'recording';
        canonicalContentHash(outcome);
        return withImmediateTransaction(database, () => {
            cas();
            if (manifestRead.reason === 'unsupported_schema') {
                upsertTraceCursor(database, { runsDirectory: runs, traceRunId: id, lastSeq: previous?.lastSeq ?? -1, state: 'unsupported', now });
                database.prepare("UPDATE orcareplay_trace_cursors SET finalization='unsupported', revision=revision+1 WHERE directory=? AND trace_run_id=?").run(runs, id);
            }
            return outcome;
        });
    }
    const { manifest, fingerprint } = manifestRead;
    const currentIdentity = fileIdentity(await lstat(path.join(runs, id, 'events.jsonl')));
    let generation = previous?.generation ?? 1;
    let offset = previous?.offset ?? 0;
    let lastSeq = previous?.lastSeq ?? -1;
    let aggregate = previous?.aggregate;
    const replaced = previous?.fileIdentity && (previous.fileIdentity.dev !== currentIdentity.dev || previous.fileIdentity.ino !== currentIdentity.ino
        || currentIdentity.size < previous.fileIdentity.size || (currentIdentity.size === previous.fileIdentity.size && !sameFile(previous.fileIdentity, currentIdentity)));
    if (replaced) {
        generation++;
        offset = 0;
        lastSeq = -1;
        aggregate = undefined;
    }
    if (!replaced && previous?.aggregate && previous.fileIdentity && sameFile(previous.fileIdentity, currentIdentity) && previous.offset === currentIdentity.size && previous.manifestFingerprint === fingerprint
        && !['ended_unverified', 'ended_pending_manifest'].includes(previous.finalization)) {
        outcome.reason = 'already_ingested';
        outcome.contextDigest = readStoredTraceContext(database, runs, id)?.digest ?? null;
        return outcome;
    }
    let batch = await readTraceBatch(runs, id, { offset, lastSeq, ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        ...(input.maxEvents === undefined ? {} : { maxEvents: input.maxEvents }), ...(input.signal ? { signal: input.signal } : {}) });
    aggregate = applyTraceEvents(aggregate, batch.events, batch.warningCount, batch.skippedEventCount);
    let integrity: TraceIngestOutcome['integrity'] = 'unavailable';
    let finalization = aggregate.runEnded ? 'ended_pending_manifest' : 'recording';
    let sourceDigest: string | null = null;
    if (!batch.hasMore && (aggregate.runEnded || manifest.endedAt) && manifest.eventsSha256) {
        finalization = 'ended_unverified';
        // Rebuild and hash the same raw snapshot. Hash state is never persisted.
        const provisionalBatch = batch;
        const provisionalAggregate = aggregate;
        try {
            await input.beforeFinalVerify?.();
            const hash = createHash('sha256');
            let rebuilt: TraceProjection | undefined;
            let position = 0;
            let seq = -1;
            const firstIdentity = batch.fileIdentity;
            do {
                leaseCheck();
                batch = await readTraceBatch(runs, id, { offset: position, lastSeq: seq, final: true, hash, ...(input.signal ? { signal: input.signal } : {}) });
                if (!sameFile(firstIdentity, batch.fileIdentity))
                    throw new TraceInputError('file_changed', true);
                rebuilt = applyTraceEvents(rebuilt, batch.events, batch.warningCount, batch.skippedEventCount);
                position = batch.nextByteOffset;
                seq = batch.lastSeq;
            } while (batch.hasMore);
            const reread = await readOrcaTraceManifest(runs, id);
            if (!reread.ok || reread.fingerprint !== fingerprint)
                throw new TraceInputError('manifest_changed', true);
            sourceDigest = hash.digest('hex');
            integrity = sourceDigest === manifest.eventsSha256 ? 'verified' : 'mismatch';
            aggregate = rebuilt!;
            finalization = integrity === 'verified' ? 'finalized' : 'blocked';
        }
        catch (error) {
            if (!input.signal?.aborted)
                throw error;
            interruptedFinalization = true;
            batch = provisionalBatch;
            aggregate = provisionalAggregate;
            finalization = 'ended_unverified';
            outcome.reason = 'final_verification_interrupted';
        }
    }
    const metadata: JsonObject = { readerPolicyVersion: ORCA_TRACE_READER_POLICY_VERSION, generation, finalization, sourceDigest,
        captureCwd: path.dirname(path.dirname(runs)), traceCreatedAt: manifest.createdAt ?? '', derived: manifest.derived ?? false };
    const built = buildTraceContext(id, manifest.schemaVersion, batch.lastSeq, integrity, aggregate, metadata);
    if (!built.bounded || findSecretInValue(built.context) !== undefined || findSecretInValue(aggregate) !== undefined)
        throw new KiokukoError('SECURITY_REJECTION', 'Trace projection rejected');
    const aggregateJson = JSON.stringify(aggregate);
    const aggregateDigest = canonicalContentHash(aggregate);
    if (Buffer.byteLength(aggregateJson) > TRACE_LIMITS.aggregate)
        throw new TraceInputError('aggregate_too_large');
    const digest = canonicalContentHash(built.context);
    const candidates = finalization === 'finalized' && aggregate.runEnded && aggregate.warningCount === 0 ? buildTraceMemoryCandidates(aggregate) : { candidates: [], suppressed: 0 };
    const payload: JsonObject = { source: 'orcareplay', runsDirectory: runs, traceRunId: id, generation, readerPolicyVersion: ORCA_TRACE_READER_POLICY_VERSION, sourceDigest, candidates: [...candidates.candidates] };
    if (findSecretInValue(payload) !== undefined)
        throw new KiokukoError('SECURITY_REJECTION', 'Trace candidate rejected');
    canonicalContentHash(payload);
    Object.assign(outcome, { ingested: true, throughSeq: batch.lastSeq, cursorSeq: batch.lastSeq, integrity, contextDigest: digest,
        memoryCandidates: candidates.candidates.length, suppressedMemoryCandidates: candidates.suppressed, hasMore: batch.hasMore, finalization });
    canonicalContentHash(outcome);
    await input.beforeCommit?.();
    return withImmediateTransaction(database, () => {
        cas();
        upsertTraceCursor(database, { runsDirectory: runs, traceRunId: id, lastSeq: batch.lastSeq, state: 'active', now });
        database.prepare(`UPDATE orcareplay_trace_cursors SET generation=?, revision=revision+1,next_byte_offset=?,file_identity_json=?,manifest_fingerprint=?,
   aggregate_json=?,aggregate_digest=?,finalization=?,integrity=?,reader_policy_version=2,diagnostic_code=? WHERE directory=? AND trace_run_id=?`).run(generation, batch.nextByteOffset, JSON.stringify(batch.fileIdentity), fingerprint, aggregateJson, aggregateDigest, finalization, integrity, integrity === 'mismatch' ? 'integrity_mismatch' : interruptedFinalization ? 'final_verification_interrupted' : batch.waitingForCompleteLine ? 'waiting_for_complete_line' : null, runs, id);
        writeTraceContext(database, { runsDirectory: runs, traceRunId: id, digest, contextJson: JSON.stringify(built.context), now });
        database.prepare('UPDATE orcareplay_trace_context SET reader_policy_version=2,generation=?,trace_created_at=?,finalization=? WHERE directory=? AND trace_run_id=?').run(generation, manifest.createdAt ?? '', finalization, runs, id);
        let mode: 'off' | 'official' | 'community' = 'off';
        try {
            mode = input.skillDiscoveryMode ?? normalizeSkillDiscoveryMode(process.env.KIOKUKO_SKILL_DISCOVERY);
        }
        catch { /* Optional configuration never rolls back trace ingestion. */ }
        if (finalization === 'finalized' && mode !== 'off') {
            const queries: string[] = [];
            for (const tool of aggregate.toolCalls) {
                try {
                    const query = validateSkillQuery(tool.name);
                    if (!queries.includes(query))
                        queries.push(query);
                }
                catch (error) {
                    if (!(error instanceof KiokukoError))
                        throw error;
                }
                if (queries.length === 3)
                    break;
            }
            if (queries.length)
                enqueueOrchestrationJob(database, { kind: 'skill_discovery', payload: { source: 'orcareplay', directory: runs, traceRunId: id, generation, readerPolicyVersion: 2, sourceDigest, mode, queries }, now });
        }
        if (candidates.candidates.length)
            enqueueOrchestrationJob(database, { kind: 'memory_promotion', payload, now });
        if (batch.hasMore)
            enqueueOrchestrationJob(database, { kind: 'trace_ingestion', payload: { directory: runs, traceRunId: id, fromSeq: Math.max(0, batch.lastSeq + 1), generation,
                    readerPolicyVersion: 2, offset: batch.nextByteOffset, revision: (previous?.revision ?? 0) + 1, fingerprint }, now });
        return outcome;
    });
}
