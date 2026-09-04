import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalJson, type JsonObject, type JsonValue } from '../serialization/validate.js';

export const ORCHESTRATION_JOB_KINDS = [
  'semantic_context',
  'skill_discovery',
  'compaction_meditation',
  'plan_publish',
  'memory_promotion',
] as const;

export type OrchestrationJobKind = (typeof ORCHESTRATION_JOB_KINDS)[number];
export type OrchestrationJobState = 'pending' | 'leased' | 'completed' | 'failed' | 'abandoned';

export interface OrchestrationJob {
  jobId: string;
  kind: OrchestrationJobKind;
  runId: string | null;
  inputDigest: string;
  payload: JsonObject;
  state: OrchestrationJobState;
  attempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  resultDigest: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface JobRow extends SqliteRow {
  job_id: unknown;
  kind: unknown;
  run_id: unknown;
  input_digest: unknown;
  payload_json: unknown;
  state: unknown;
  attempts: unknown;
  available_at: unknown;
  lease_owner: unknown;
  lease_expires_at: unknown;
  result_digest: unknown;
  error_code: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

function parsePayload(value: unknown): JsonObject {
  if (typeof value !== 'string') throw new KiokukoError('INTEGRITY_ERROR', 'Stored orchestration job payload is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored orchestration job payload is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored orchestration job payload is invalid');
  }
  return parsed as JsonObject;
}

function parseRow(row: JobRow): OrchestrationJob {
  if (typeof row.job_id !== 'string'
    || typeof row.kind !== 'string' || !ORCHESTRATION_JOB_KINDS.includes(row.kind as OrchestrationJobKind)
    || (row.run_id !== null && typeof row.run_id !== 'string')
    || typeof row.input_digest !== 'string'
    || typeof row.state !== 'string' || !['pending', 'leased', 'completed', 'failed', 'abandoned'].includes(row.state)
    || typeof row.attempts !== 'number'
    || typeof row.available_at !== 'string'
    || (row.lease_owner !== null && typeof row.lease_owner !== 'string')
    || (row.lease_expires_at !== null && typeof row.lease_expires_at !== 'string')
    || (row.result_digest !== null && typeof row.result_digest !== 'string')
    || (row.error_code !== null && typeof row.error_code !== 'string')
    || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
    || (row.completed_at !== null && typeof row.completed_at !== 'string')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored orchestration job is invalid');
  }
  return {
    jobId: row.job_id,
    kind: row.kind as OrchestrationJobKind,
    runId: row.run_id,
    inputDigest: row.input_digest,
    payload: parsePayload(row.payload_json),
    state: row.state as OrchestrationJobState,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    resultDigest: row.result_digest,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const SELECT_JOB = `
  SELECT job_id, kind, run_id, input_digest, payload_json, state, attempts,
         available_at, lease_owner, lease_expires_at, result_digest, error_code,
         created_at, updated_at, completed_at
  FROM orchestration_jobs
`;

export function enqueueOrchestrationJob(database: SqliteDatabase, input: {
  kind: OrchestrationJobKind;
  runId?: string | null;
  payload: JsonObject;
  availableAt?: string;
  now?: string;
}): OrchestrationJob {
  const now = input.now ?? new Date().toISOString();
  const inputDigest = canonicalContentHash({ kind: input.kind, runId: input.runId ?? null, payload: input.payload });
  database.prepare(`
    INSERT INTO orchestration_jobs (
      job_id, kind, run_id, input_digest, payload_json, state, attempts,
      available_at, lease_owner, lease_expires_at, result_digest, error_code,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)
    ON CONFLICT(kind, input_digest) DO NOTHING
  `).run(
    randomUUID(),
    input.kind,
    input.runId ?? null,
    inputDigest,
    canonicalJson(input.payload),
    input.availableAt ?? now,
    now,
    now,
  );
  const row = database.prepare(`${SELECT_JOB} WHERE kind = ? AND input_digest = ?`)
    .get<JobRow>(input.kind, inputDigest);
  if (row === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Orchestration job could not be read back');
  return parseRow(row);
}

export function claimOrchestrationJobs(database: SqliteDatabase, input: {
  owner: string;
  limit?: number;
  leaseMs?: number;
  kinds?: readonly OrchestrationJobKind[];
  now?: string;
}): OrchestrationJob[] {
  const limit = input.limit ?? 4;
  const leaseMs = input.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new KiokukoError('VALIDATION_ERROR', 'Orchestration job claim bounds are invalid');
  }
  return withImmediateTransaction(database, () => {
    const now = input.now ?? new Date().toISOString();
    database.prepare(`
      UPDATE orchestration_jobs
      SET state = 'abandoned', lease_owner = NULL, lease_expires_at = NULL,
          error_code = 'lease_expired', updated_at = ?
      WHERE state = 'leased' AND lease_expires_at <= ?
    `).run(now, now);
    const kinds = input.kinds ?? ORCHESTRATION_JOB_KINDS;
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(', ');
    const candidates = database.prepare(`
      SELECT job_id AS jobId
      FROM orchestration_jobs
      WHERE state IN ('pending', 'failed', 'abandoned')
        AND attempts < 20
        AND available_at <= ?
        AND kind IN (${placeholders})
      ORDER BY available_at, created_at, job_id
      LIMIT ?
    `).all<{ jobId: string }>(now, ...kinds, limit);
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const claimed: OrchestrationJob[] = [];
    for (const candidate of candidates) {
      const row = database.prepare(`
        UPDATE orchestration_jobs
        SET state = 'leased', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at = ?, error_code = NULL, updated_at = ?
        WHERE job_id = ? AND state IN ('pending', 'failed', 'abandoned')
        RETURNING job_id, kind, run_id, input_digest, payload_json, state, attempts,
                  available_at, lease_owner, lease_expires_at, result_digest,
                  error_code, created_at, updated_at, completed_at
      `).get<JobRow>(input.owner, expiresAt, now, candidate.jobId);
      if (row !== undefined) claimed.push(parseRow(row));
    }
    return claimed;
  });
}

export function completeOrchestrationJob(database: SqliteDatabase, input: {
  jobId: string;
  owner: string;
  result?: JsonValue;
  now?: string;
}): void {
  const now = input.now ?? new Date().toISOString();
  const updated = database.prepare(`
    UPDATE orchestration_jobs
    SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
        result_digest = ?, error_code = NULL, completed_at = ?, updated_at = ?
    WHERE job_id = ? AND state = 'leased' AND lease_owner = ? AND lease_expires_at > ?
    RETURNING job_id AS jobId
  `).get<{ jobId: string }>(
    input.result === undefined ? null : canonicalContentHash(input.result),
    now,
    now,
    input.jobId,
    input.owner,
    now,
  );
  if (updated?.jobId !== input.jobId) throw new KiokukoError('CONFLICT', 'Orchestration job lease is stale');
}

export function failOrchestrationJob(database: SqliteDatabase, input: {
  jobId: string;
  owner: string;
  errorCode: string;
  retryAt?: string;
  now?: string;
}): void {
  const now = input.now ?? new Date().toISOString();
  const updated = database.prepare(`
    UPDATE orchestration_jobs
    SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
        error_code = ?, available_at = ?, updated_at = ?
    WHERE job_id = ? AND state = 'leased' AND lease_owner = ? AND lease_expires_at > ?
    RETURNING job_id AS jobId
  `).get<{ jobId: string }>(input.errorCode.slice(0, 200), input.retryAt ?? now, now, input.jobId, input.owner, now);
  if (updated?.jobId !== input.jobId) throw new KiokukoError('CONFLICT', 'Orchestration job lease is stale');
}

export function orchestrationJobDiagnostics(database: SqliteDatabase): {
  pending: number;
  leased: number;
  failed: number;
  oldestPendingAt: string | null;
} {
  const row = database.prepare(`
    SELECT
      SUM(CASE WHEN state IN ('pending', 'abandoned') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state = 'leased' THEN 1 ELSE 0 END) AS leased,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
      MIN(CASE WHEN state IN ('pending', 'abandoned', 'failed') THEN created_at END) AS oldestPendingAt
    FROM orchestration_jobs
  `).get<{ pending: number | null; leased: number | null; failed: number | null; oldestPendingAt: string | null }>();
  return {
    pending: row?.pending ?? 0,
    leased: row?.leased ?? 0,
    failed: row?.failed ?? 0,
    oldestPendingAt: row?.oldestPendingAt ?? null,
  };
}
