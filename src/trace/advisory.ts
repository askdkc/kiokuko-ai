import { z } from 'zod';
import type { SqliteDatabase } from '../db/adapter.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import { findSecretInValue } from '../memory/secrets.js';
import { parseTraceJson, TRACE_LIMITS, TraceInputError } from './bounded-read.js';
const count = z.number().int().nonnegative();
const contextSchema = z.object({ source: z.literal('orcareplay'), traceRunId: z.string().regex(/^run_[0-9a-f]{6,32}$/u),
    schemaVersion: z.string().regex(/^0\.\d+\.\d+$/u), readerPolicyVersion: z.literal(2), generation: z.number().int().positive(),
    throughSeq: z.number().int().min(-1), referenceOnly: z.literal(true), autoInstall: z.literal(false), autoExecute: z.literal(false),
    finalization: z.enum(['recording', 'ended_pending_manifest', 'ended_unverified', 'finalized', 'blocked']),
    integrity: z.enum(['verified', 'unavailable', 'mismatch']), sourceDigest: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
    captureCwd: z.string(), traceCreatedAt: z.string(), derived: z.boolean(),
    completeness: z.object({ parse: z.enum(['complete', 'partial']), warningCount: count, skippedEventCount: count, detailsTruncated: z.boolean() }).strict(),
    summary: z.object({ events: count, turns: count, errorCount: count, shellFailures: count, runEnded: z.boolean(), exitCode: z.number().int().nullable(),
        otherToolCalls: count, overflow: z.boolean(), toolCalls: z.array(z.object({ name: z.string(), count })).max(8),
        errors: z.array(z.object({ kind: z.string(), seq: count, suite: z.string().optional() })).max(4),
        fsChanges: z.array(z.object({ path: z.string(), status: z.string() })).max(8), notes: z.array(z.object({ rule: z.string(), detail: z.string().optional() })).max(4) }).strict(),
}).strict();
export interface TraceAdvisory {
    source: 'orcareplay';
    referenceOnly: true;
    autoInstall: false;
    autoExecute: false;
    traceRunId: string;
    digest: string;
    context: JsonObject;
    skills?: JsonObject;
    sourceAvailable?: false;
}
export function readTraceAdvisory(database: SqliteDatabase, root: string, captureCwd: string): {
    context?: TraceAdvisory;
    rejected: boolean;
} {
    const rows = database.prepare(`SELECT c.context_json AS json,c.digest,c.trace_run_id AS id,c.generation,c.finalization,s.capture_cwd AS captureCwd,p.finalization AS progressState
  FROM orcareplay_trace_context c JOIN orcareplay_trace_stores s ON s.directory=c.directory
  JOIN orcareplay_trace_cursors p ON p.directory=c.directory AND p.trace_run_id=c.trace_run_id AND p.generation=c.generation
  WHERE s.repository_root=? AND s.state='present' AND c.reader_policy_version=2 AND p.reader_policy_version=2
  ORDER BY (c.finalization='finalized') DESC,(s.capture_cwd=?) DESC,c.trace_created_at DESC,c.trace_run_id DESC LIMIT 16`).all<{
        json: string;
        digest: string;
        id: string;
        generation: number;
        finalization: string;
        captureCwd: string;
        progressState: string;
    }>(root, captureCwd);
    let rejected = false;
    for (const row of rows) {
        try {
            if (Buffer.byteLength(row.json) > TRACE_LIMITS.context)
                throw new TraceInputError('context_too_large');
            const parsed = parseTraceJson(row.json);
            const checked = contextSchema.safeParse(parsed);
            if (!checked.success)
                throw new TraceInputError('context_invalid');
            const context = checked.data;
            if (context.traceRunId !== row.id || context.generation !== row.generation || context.finalization !== row.finalization || context.captureCwd !== row.captureCwd
                || context.integrity === 'mismatch' || context.finalization === 'blocked' || canonicalContentHash(context) !== row.digest || findSecretInValue(context) !== undefined
                || (context.finalization === 'finalized' && (context.integrity !== 'verified' || context.sourceDigest === null)))
                throw new TraceInputError('context_rejected');
            if (['blocked', 'unsupported'].includes(row.progressState))
                throw new TraceInputError('context_source_rejected');
            if (context.derived)
                continue;
            const wrapper: TraceAdvisory = { source: 'orcareplay', referenceOnly: true, autoInstall: false, autoExecute: false, traceRunId: row.id, digest: row.digest, context: context as JsonObject };
            if (row.progressState === 'source_missing')
                wrapper.sourceAvailable = false;
            const enrichment = database.prepare('SELECT result_json AS json FROM orcareplay_trace_enrichment WHERE directory=(SELECT directory FROM orcareplay_trace_stores WHERE capture_cwd=? AND repository_root=?) AND trace_run_id=? AND generation=? AND source_digest=?').get<{
                json: string;
            }>(row.captureCwd, root, row.id, row.generation, context.sourceDigest);
            if (enrichment) {
                try {
                    const parsed = parseTraceJson(enrichment.json);
                    const schema = z.object({ referenceOnly: z.literal(true), autoInstall: z.literal(false), autoExecute: z.literal(false), queries: z.array(z.string()).max(3), candidates: z.array(z.object({ skillId: z.string(), name: z.string(), source: z.string(), officialStatus: z.string() }).strict()).max(2), failures: z.array(z.literal('skill_search_failed')).max(3) }).strict();
                    const skills = schema.safeParse(parsed);
                    if (skills.success && findSecretInValue(skills.data) === undefined && Buffer.byteLength(JSON.stringify({ ...wrapper, skills: skills.data })) <= TRACE_LIMITS.context)
                        wrapper.skills = skills.data;
                }
                catch (error) {
                    if (!(error instanceof TraceInputError))
                        throw error;
                }
            }
            if (Buffer.byteLength(JSON.stringify(wrapper)) > TRACE_LIMITS.context)
                throw new TraceInputError('context_too_large');
            return { context: wrapper, rejected };
        }
        catch (error) {
            if (!(error instanceof TraceInputError))
                throw error;
            rejected = true;
        }
    }
    return { rejected };
}
