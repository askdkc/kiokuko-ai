import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { findSkills } from '../skills/find.js';
import { validateSkillQuery } from '../skills/query-builder.js';
import { findSecretInValue } from '../memory/secrets.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import { KiokukoError } from '../errors.js';
import { assertOrchestrationJobLease, type OrchestrationJob } from '../orchestration/jobs.js';
/** Optional external references never participate in the ingestion transaction. */
export async function enrichTraceSkills(database: SqliteDatabase, job: OrchestrationJob, fetchImpl?: typeof fetch): Promise<JsonObject> {
    const p = job.payload;
    if (p.mode === 'off' || process.env.KIOKUKO_SKILL_DISCOVERY === 'off')
        return { searched: false, reason: 'disabled' };
    if (p.readerPolicyVersion !== 2 || (p.mode !== 'official' && p.mode !== 'community') || !Array.isArray(p.queries) || p.queries.length > 3
        || typeof p.directory !== 'string' || typeof p.traceRunId !== 'string' || typeof p.generation !== 'number' || typeof p.sourceDigest !== 'string'
        || findSecretInValue(p) !== undefined || canonicalContentHash({ kind: job.kind, runId: job.runId, payload: p }) !== job.inputDigest)
        throw new KiokukoError('INTEGRITY_ERROR', 'Trace enrichment payload rejected');
    const { directory, traceRunId, generation, sourceDigest } = p;
    const queries = p.queries.map(validateSkillQuery);
    const candidates: JsonObject[] = [];
    const failures: string[] = [];
    for (const query of queries) {
        try {
            const found = await findSkills({ query, officialOnly: p.mode === 'official', limit: 10 }, fetchImpl === undefined ? {} : { fetchImpl });
            for (const item of found.candidates) {
                if (candidates.some(x => x.skillId === item.id))
                    continue;
                const candidate = { skillId: item.id, name: item.name, source: item.source, officialStatus: item.officialStatus };
                if (findSecretInValue(candidate) === undefined && Buffer.byteLength(JSON.stringify(candidate)) <= 1200)
                    candidates.push(candidate);
                if (candidates.length >= 2)
                    break;
            }
        }
        catch {
            failures.push('skill_search_failed');
        }
        if (candidates.length >= 2)
            break;
    }
    const result: JsonObject = { referenceOnly: true, autoInstall: false, autoExecute: false, queries, candidates, failures };
    canonicalContentHash(result);
    return withImmediateTransaction(database, () => {
        assertOrchestrationJobLease(database, { jobId: job.jobId, owner: job.leaseOwner! });
        const current = database.prepare("SELECT 1 FROM orcareplay_trace_context WHERE directory=? AND trace_run_id=? AND generation=? AND reader_policy_version=2 AND finalization='finalized' AND json_extract(context_json,'$.sourceDigest')=?").get(directory, traceRunId, generation, sourceDigest);
        if (!current)
            return { searched: false, reason: 'trace_generation_superseded' };
        database.prepare('INSERT INTO orcareplay_trace_enrichment VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(directory, traceRunId, generation, sourceDigest, JSON.stringify(result));
        return { searched: true, candidateCount: candidates.length, failures };
    });
}
