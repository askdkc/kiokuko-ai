import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import type { EmbeddingRuntime } from '../embedding/types.js';
import { prepareEmbeddingSearchRuntime } from '../embedding/runtime.js';
import { queryScopedContext, type ScopedContextQuery } from '../context/scoped-broker.js';
import { recordTaskContextRevision } from '../context/revisions.js';
import { findSkills } from '../skills/find.js';
import { publishPlanArtifact } from '../enno-oduno/plan-artifact.js';
import { KiokukoError } from '../errors.js';
import type { JsonObject, JsonValue } from '../serialization/validate.js';
import { processCompactionMeditationJob } from '../meditation/compaction.js';
import { LedgerStore } from '../ledger/store.js';
import {
  claimOrchestrationJobs,
  completeOrchestrationJob,
  failOrchestrationJob,
  type OrchestrationJob,
} from './jobs.js';

export const DEFAULT_ORCHESTRATION_WORKER_INTERVAL_MS = 1_000;

export interface OrchestrationWorker {
  readonly running: boolean;
  start(): void;
  stop(): void;
  close(): Promise<void>;
}

export interface OrchestrationWorkerOptions {
  database: SqliteDatabase;
  embeddingRuntime?: EmbeddingRuntime;
  dataDirectory?: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onError?: (error: unknown) => void | PromiseLike<void>;
  processCompactionMeditation?: (job: OrchestrationJob) => Promise<unknown>;
}

function objectPayload(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('INTEGRITY_ERROR', `${label} job payload is invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KiokukoError('INTEGRITY_ERROR', `${label} job payload is invalid`);
  }
  return value;
}

function boundedStrings(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Orchestration job string list is invalid');
  }
  return value as string[];
}

async function processSemanticContext(options: OrchestrationWorkerOptions, job: OrchestrationJob): Promise<unknown> {
  if (job.runId === null) throw new KiokukoError('INTEGRITY_ERROR', 'Semantic context job has no run');
  const payload = objectPayload(job.payload, 'Semantic context');
  const queryText = requiredString(payload.queryText, 'Semantic context');
  const query = objectPayload(payload.query, 'Semantic context') as unknown as ScopedContextQuery;
  const runtime = await prepareEmbeddingSearchRuntime(options.embeddingRuntime, options.database, queryText);
  if (runtime.semantic === undefined) return { enriched: false, reason: 'embedding_unavailable' };
  const context = await queryScopedContext(options.database, query, runtime);
  const revision = recordTaskContextRevision(options.database, {
    runId: job.runId,
    context: {
      kind: 'semantic_context',
      scopedContext: context as unknown as JsonObject,
    },
  });
  return { enriched: true, contextRevision: revision.contextRevision };
}

async function processSkillDiscovery(options: OrchestrationWorkerOptions, job: OrchestrationJob): Promise<unknown> {
  if (job.runId === null) throw new KiokukoError('INTEGRITY_ERROR', 'Skill discovery job has no run');
  const payload = objectPayload(job.payload, 'Skill discovery');
  const mode = payload.mode;
  if (mode !== 'official' && mode !== 'community') {
    if (mode === 'off') return { searched: false, reason: 'disabled' };
    throw new KiokukoError('INTEGRITY_ERROR', 'Skill discovery mode is invalid');
  }
  const queries = boundedStrings(payload.queries ?? [], 3);
  const candidates = [] as Array<{
    skillId: string;
    name: string;
    source: string;
    officialStatus: string;
  }>;
  const failures: Array<{ query: string; code: string }> = [];
  for (const query of queries) {
    try {
      const found = await findSkills({
        query,
        officialOnly: mode === 'official',
        limit: 10,
      }, { ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
      for (const candidate of found.candidates) {
        if (candidates.some((existing) => existing.skillId === candidate.id)) continue;
        candidates.push({
          skillId: candidate.id,
          name: candidate.name,
          source: candidate.source,
          officialStatus: candidate.officialStatus,
        });
        if (candidates.length >= 2) break;
      }
    } catch (error) {
      failures.push({
        query,
        code: error instanceof KiokukoError ? error.code : 'SKILL_SEARCH_FAILED',
      });
    }
    if (candidates.length >= 2) break;
  }
  const revision = recordTaskContextRevision(options.database, {
    runId: job.runId,
    context: {
      kind: 'skill_recommendation',
      source: 'external_reference_only',
      autoInstall: false,
      autoExecute: false,
      requirements: boundedStrings(payload.requirements ?? [], 64),
      queries,
      candidates,
      failures,
    },
  });
  if (failures.length > 0) {
    const run = new LedgerStore(options.database).readRun(job.runId);
    if (run?.status === 'active') {
      new LedgerStore(options.database).appendBatch(job.runId, { events: [{
        eventType: 'error.recorded',
        actor: 'akinator',
        outcome: candidates.length > 0 ? 'degraded' : 'unavailable',
        payload: {
          category: 'skill_discovery',
          requirements: boundedStrings(payload.requirements ?? [], 64),
          failures,
        },
      }] });
    }
  }
  return { searched: queries.length > 0, contextRevision: revision.contextRevision, candidateCount: candidates.length };
}

async function processJob(options: OrchestrationWorkerOptions, job: OrchestrationJob): Promise<unknown> {
  if (job.kind === 'plan_publish') {
    const payload = objectPayload(job.payload, 'Plan publish');
    const runId = requiredString(payload.runId, 'Plan publish');
    const contractRevision = payload.contractRevision;
    if (!Number.isSafeInteger(contractRevision) || (contractRevision as number) < 1) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Plan publish revision is invalid');
    }
    return publishPlanArtifact(options.database, {
      runId,
      contractRevision: contractRevision as number,
      ...(options.dataDirectory === undefined ? {} : { dataDirectory: options.dataDirectory }),
    });
  }
  if (job.kind === 'semantic_context') return processSemanticContext(options, job);
  if (job.kind === 'skill_discovery') return processSkillDiscovery(options, job);
  if (job.kind === 'compaction_meditation') {
    return options.processCompactionMeditation === undefined
      ? processCompactionMeditationJob(options.database, job)
      : options.processCompactionMeditation(job);
  }
  // Candidate promotion is deliberately never treated as global promotion by
  // this worker. A dedicated Curator/user-authorized path owns that boundary.
  return { promoted: false, reason: 'curator_authorization_required' };
}

export function createOrchestrationWorker(options: OrchestrationWorkerOptions): OrchestrationWorker {
  const intervalMs = options.intervalMs ?? DEFAULT_ORCHESTRATION_WORKER_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) {
    throw new TypeError('Orchestration worker interval is invalid');
  }
  const owner = `orchestration-worker-${randomUUID()}`;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  let running = false;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;

  const schedule = (delay: number): void => {
    if (!running || closing || timer !== undefined) return;
    timer = setTimer(() => {
      timer = undefined;
      void drain();
    }, delay);
  };

  const drain = async (): Promise<void> => {
    if (!running || closing || active !== undefined) return;
    const operation = (async () => {
      const jobs = claimOrchestrationJobs(options.database, { owner, limit: 4, leaseMs: 120_000 });
      for (const job of jobs) {
        try {
          const result = await processJob(options, job);
          completeOrchestrationJob(options.database, { jobId: job.jobId, owner, result: result as JsonValue });
        } catch (error) {
          try {
            const retryAt = new Date(Date.now() + Math.min(60_000, 1_000 * (2 ** Math.min(job.attempts, 6)))).toISOString();
            failOrchestrationJob(options.database, {
              jobId: job.jobId,
              owner,
              errorCode: error instanceof KiokukoError ? error.code : 'ORCHESTRATION_JOB_FAILED',
              retryAt,
            });
          } catch (settleError) {
            await options.onError?.(new AggregateError([error, settleError], 'Orchestration job failed and could not be settled'));
          }
        }
      }
    })();
    active = operation;
    try {
      await operation;
    } catch (error) {
      try { await options.onError?.(error); } catch { /* observer errors are non-blocking */ }
    } finally {
      if (active === operation) active = undefined;
      schedule(intervalMs);
    }
  };

  return Object.freeze({
    get running(): boolean { return running && !closing; },
    start(): void {
      if (running || closing) return;
      running = true;
      schedule(0);
    },
    stop(): void {
      if (closing) return;
      closing = true;
      running = false;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    async close(): Promise<void> {
      this.stop();
      await active;
    },
  });
}
