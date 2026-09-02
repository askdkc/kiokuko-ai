import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { validateTimestamp } from '../ledger/validate.js';
import { requireWorkspace } from '../serialization/validate.js';
import { readEntry } from '../memory/entries.js';
import { buildEmbeddingDocumentForProfile } from './document.js';
import { readEmbeddingProfile, readEmbeddingRuntimeState, upsertEntryEmbeddingInTransaction } from './store.js';

export { enqueueAllCurrentEntryEmbeddingsInTransaction, enqueueCurrentEntryEmbeddingInTransaction } from './store.js';
export type { CurrentEntryEmbeddingJobInput } from './store.js';

export const EMBEDDING_JOB_LEASE_MS = 180_000;
export const EMBEDDING_JOB_MAX_ATTEMPTS = 6;

export type EmbeddingJobState = 'pending' | 'leased' | 'failed' | 'blocked';
export type EmbeddingJobErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'dimension_mismatch'
  | 'secret_blocked'
  | 'profile_changed'
  | 'entry_changed';

export interface EmbeddingJob {
  readonly entryId: string;
  readonly profileId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly state: EmbeddingJobState;
  readonly attempts: number;
  readonly availableAt: string;
  readonly leaseId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly errorCode: EmbeddingJobErrorCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workspace: string;
}

export interface ClaimedEmbeddingJob extends EmbeddingJob {
  readonly state: 'leased';
  readonly generation: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimEmbeddingJobsOptions {
  readonly maxJobs: number;
  readonly workspace?: string;
  readonly now?: string;
  readonly leaseMs?: number;
  readonly leaseIdFactory?: () => string;
}

export interface FinalizeEmbeddingJobInput {
  readonly entryId: string;
  readonly profileId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly documentHash: string;
  readonly vector: Float32Array | readonly number[];
  readonly now: string;
}

export interface FailEmbeddingJobInput {
  readonly entryId: string;
  readonly profileId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly errorCode: EmbeddingJobErrorCode;
  readonly availableAt: string;
  readonly now: string;
  readonly permanent?: boolean;
}

interface JobRow extends SqliteRow {
  entry_id: unknown;
  profile_id: unknown;
  revision: unknown;
  content_hash: unknown;
  state: unknown;
  attempts: unknown;
  available_at: unknown;
  lease_id: unknown;
  lease_expires_at: unknown;
  error_code: unknown;
  created_at: unknown;
  updated_at: unknown;
  workspace: unknown;
}

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function integrity(message: string): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    integrity(`Stored embedding job ${label} is invalid`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) invalid(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function jobRow(row: JobRow): EmbeddingJob {
  if (typeof row.entry_id !== 'string' || row.entry_id.length === 0
    || typeof row.profile_id !== 'string' || !/^[0-9a-f]{64}$/u.test(row.profile_id)
    || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof row.content_hash !== 'string' || !/^[0-9a-f]{64}$/u.test(row.content_hash)
    || (row.state !== 'pending' && row.state !== 'leased' && row.state !== 'failed' && row.state !== 'blocked')
    || typeof row.attempts !== 'number' || !Number.isSafeInteger(row.attempts) || row.attempts < 0
    || typeof row.workspace !== 'string' || row.workspace.length === 0) {
    integrity('Stored embedding job is invalid');
  }
  const availableAt = canonicalTimestamp(row.available_at, 'available_at');
  const createdAt = canonicalTimestamp(row.created_at, 'created_at');
  const updatedAt = canonicalTimestamp(row.updated_at, 'updated_at');
  const leaseId = row.lease_id === null ? null : row.lease_id;
  const leaseExpiresAt = row.lease_expires_at === null ? null : row.lease_expires_at;
  if ((row.state === 'leased') !== (leaseId !== null && leaseExpiresAt !== null)
    || (leaseId !== null && (typeof leaseId !== 'string' || leaseId.length === 0))
    || (leaseExpiresAt !== null && typeof leaseExpiresAt !== 'string')) {
    integrity('Stored embedding job lease state is invalid');
  }
  const normalizedLeaseExpiresAt = leaseExpiresAt === null ? null : canonicalTimestamp(leaseExpiresAt, 'lease_expires_at');
  const errorCode = row.error_code === null ? null : row.error_code;
  const errorCodes = new Set<EmbeddingJobErrorCode>([
    'timeout', 'rate_limited', 'provider_unavailable', 'invalid_response',
    'dimension_mismatch', 'secret_blocked', 'profile_changed', 'entry_changed',
  ]);
  if (errorCode !== null && (typeof errorCode !== 'string' || !errorCodes.has(errorCode as EmbeddingJobErrorCode))) {
    integrity('Stored embedding job error code is invalid');
  }
  return {
    entryId: row.entry_id,
    profileId: row.profile_id,
    revision: row.revision,
    contentHash: row.content_hash,
    state: row.state,
    attempts: row.attempts,
    availableAt,
    leaseId,
    leaseExpiresAt: normalizedLeaseExpiresAt,
    errorCode: errorCode as EmbeddingJobErrorCode | null,
    createdAt,
    updatedAt,
    workspace: row.workspace,
  };
}

function claimLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) invalid('maxJobs must be an integer between 1 and 64');
  return value;
}

function leaseDuration(value: number | undefined): number {
  const duration = value ?? EMBEDDING_JOB_LEASE_MS;
  if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > 300_000) {
    invalid('leaseMs must be an integer between 1000 and 300000');
  }
  return duration;
}

function claimInTransaction(database: SqliteDatabase, options: ClaimEmbeddingJobsOptions): ClaimedEmbeddingJob[] {
  const maxJobs = claimLimit(options.maxJobs);
  const now = options.now ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(now)
    || !Number.isFinite(Date.parse(now)) || new Date(Date.parse(now)).toISOString() !== now) {
    invalid('now must be a canonical ISO-8601 UTC timestamp');
  }
  const leaseExpiresAt = new Date(Date.parse(now) + leaseDuration(options.leaseMs)).toISOString();
  const workspace = options.workspace === undefined ? undefined : requireWorkspace(options.workspace);
  const runtime = readEmbeddingRuntimeState(database);
  if (runtime.activeProfileId === null) return [];
  database.prepare(`
    UPDATE embedding_jobs
       SET state = 'failed', available_at = ?, lease_id = NULL,
           lease_expires_at = NULL, error_code = 'timeout', updated_at = ?
     WHERE profile_id = ?
       AND state = 'leased'
       AND attempts >= ?
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ?
  `).run(
    now,
    now,
    runtime.activeProfileId,
    EMBEDDING_JOB_MAX_ATTEMPTS,
    now,
  );
  const rows = database.prepare(`
    SELECT j.entry_id, j.profile_id, j.revision, j.content_hash, j.state,
           j.attempts, j.available_at, j.lease_id, j.lease_expires_at,
           j.error_code, j.created_at, j.updated_at, e.workspace
      FROM embedding_jobs AS j
      JOIN entries AS e ON e.id = j.entry_id
     WHERE j.profile_id = ?
       AND (
         (j.state = 'pending' AND j.available_at <= ?)
         OR (j.state = 'failed' AND j.attempts < ? AND j.available_at <= ?)
         OR (j.state = 'leased' AND j.attempts < ? AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= ?)
       )
       ${workspace === undefined ? '' : 'AND e.workspace = ?'}
     ORDER BY j.available_at ASC, j.entry_id ASC
     LIMIT ?
  `).all<JobRow>(
    runtime.activeProfileId,
    now,
    EMBEDDING_JOB_MAX_ATTEMPTS,
    now,
    EMBEDDING_JOB_MAX_ATTEMPTS,
    now,
    ...(workspace === undefined ? [] : [workspace]),
    maxJobs,
  );
  const leaseIdFactory = options.leaseIdFactory ?? randomUUID;
  const claimed: ClaimedEmbeddingJob[] = [];
  for (const row of rows) {
    const job = jobRow(row);
    const leaseId = leaseIdFactory();
    if (typeof leaseId !== 'string' || leaseId.length === 0 || leaseId.length > 256) invalid('leaseIdFactory returned an invalid lease ID');
    database.prepare(`
      UPDATE embedding_jobs
         SET state = 'leased', attempts = attempts + 1, available_at = ?,
             lease_id = ?, lease_expires_at = ?, error_code = NULL, updated_at = ?
       WHERE entry_id = ? AND profile_id = ?
         AND state = ? AND revision = ? AND content_hash = ?
    `).run(
      now,
      leaseId,
      leaseExpiresAt,
      now,
      job.entryId,
      job.profileId,
      job.state,
      job.revision,
      job.contentHash,
    );
    const updated = database.prepare(`
      SELECT j.entry_id, j.profile_id, j.revision, j.content_hash, j.state,
             j.attempts, j.available_at, j.lease_id, j.lease_expires_at,
             j.error_code, j.created_at, j.updated_at, e.workspace
        FROM embedding_jobs AS j
        JOIN entries AS e ON e.id = j.entry_id
       WHERE j.entry_id = ? AND j.profile_id = ?
    `).get<JobRow>(job.entryId, job.profileId);
    if (updated === undefined) integrity('Claimed embedding job disappeared');
    const claimedJob = jobRow(updated);
    if (claimedJob.state !== 'leased' || claimedJob.leaseId !== leaseId || claimedJob.leaseExpiresAt !== leaseExpiresAt) {
      integrity('Embedding job lease claim was not persisted');
    }
    claimed.push({ ...claimedJob, state: 'leased', generation: runtime.generation, leaseId, leaseExpiresAt });
  }
  return claimed;
}

export function claimEmbeddingJobs(database: SqliteDatabase, options: ClaimEmbeddingJobsOptions): ClaimedEmbeddingJob[] {
  return withImmediateTransaction(database, () => claimInTransaction(database, options));
}

function jobForLease(database: SqliteDatabase, input: { entryId: string; profileId: string }): EmbeddingJob | undefined {
  const row = database.prepare(`
    SELECT j.entry_id, j.profile_id, j.revision, j.content_hash, j.state,
           j.attempts, j.available_at, j.lease_id, j.lease_expires_at,
           j.error_code, j.created_at, j.updated_at, e.workspace
      FROM embedding_jobs AS j
      JOIN entries AS e ON e.id = j.entry_id
     WHERE j.entry_id = ? AND j.profile_id = ?
  `).get<JobRow>(input.entryId, input.profileId);
  return row === undefined ? undefined : jobRow(row);
}

function leaseOwner(
  database: SqliteDatabase,
  input: { entryId: string; profileId: string; generation: number; leaseId: string; now: string },
): EmbeddingJob {
  const runtime = readEmbeddingRuntimeState(database);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1
    || runtime.activeProfileId !== input.profileId || runtime.generation !== input.generation) {
    throw new KiokukoError('CONFLICT', 'Embedding runtime changed while processing a job');
  }
  const job = jobForLease(database, input);
  if (job === undefined || job.state !== 'leased' || job.leaseId !== input.leaseId
    || job.leaseExpiresAt === null || job.leaseExpiresAt <= input.now) {
    throw new KiokukoError('CONFLICT', 'Embedding job lease is stale');
  }
  return job;
}

export function finalizeEmbeddingJobInTransaction(database: SqliteDatabase, input: FinalizeEmbeddingJobInput): void {
  const now = validateTimestamp(input.now, 'now');
  const job = leaseOwner(database, {
    entryId: input.entryId,
    profileId: input.profileId,
    generation: input.generation,
    leaseId: input.leaseId,
    now,
  });
  if (job.revision !== input.revision || job.contentHash !== input.contentHash) {
    throw new KiokukoError('CONFLICT', 'Embedding job source changed while processing');
  }
  const profile = readEmbeddingProfile(database, input.profileId);
  if (profile === undefined) throw new KiokukoError('NOT_FOUND', 'Embedding profile not found');
  const entry = readEntry(database, { workspace: job.workspace, entryId: job.entryId });
  if (entry.revision !== job.revision || entry.contentHash !== job.contentHash) {
    throw new KiokukoError('CONFLICT', 'Embedding job source changed while finalizing');
  }
  const document = buildEmbeddingDocumentForProfile({
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: entry.tags,
    scope: entry.scope,
  }, profile.identity);
  if (document.documentHash !== input.documentHash) {
    throw new KiokukoError('CONFLICT', 'Embedding document changed while processing');
  }
  upsertEntryEmbeddingInTransaction(database, {
    entryId: input.entryId,
    profileId: input.profileId,
    revision: input.revision,
    contentHash: input.contentHash,
    documentHash: input.documentHash,
    vector: input.vector,
    createdAt: now,
  });
  database.prepare(`
    DELETE FROM embedding_jobs
     WHERE entry_id = ? AND profile_id = ? AND state = 'leased' AND lease_id = ?
  `).run(input.entryId, input.profileId, input.leaseId);
  if (jobForLease(database, input) !== undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Embedding job was not finalized');
  }
}

export function finalizeEmbeddingJob(database: SqliteDatabase, input: FinalizeEmbeddingJobInput): void {
  withImmediateTransaction(database, () => finalizeEmbeddingJobInTransaction(database, input));
}

function failureCode(value: EmbeddingJobErrorCode): EmbeddingJobErrorCode {
  if (![
    'timeout', 'rate_limited', 'provider_unavailable', 'invalid_response',
    'dimension_mismatch', 'secret_blocked', 'profile_changed', 'entry_changed',
  ].includes(value)) invalid('errorCode is invalid');
  return value;
}

export function failEmbeddingJobInTransaction(database: SqliteDatabase, input: FailEmbeddingJobInput): boolean {
  const now = validateTimestamp(input.now, 'now');
  const availableAt = validateTimestamp(input.availableAt, 'availableAt');
  failureCode(input.errorCode);
  const runtime = readEmbeddingRuntimeState(database);
  if (runtime.activeProfileId !== input.profileId || runtime.generation !== input.generation) return false;
  const job = jobForLease(database, input);
  if (job === undefined || job.state !== 'leased' || job.leaseId !== input.leaseId || job.leaseExpiresAt === null || job.leaseExpiresAt <= now) return false;
  const state = input.errorCode === 'secret_blocked' ? 'blocked' : 'failed';
  database.prepare(`
    UPDATE embedding_jobs
       SET state = ?, attempts = CASE WHEN ? = 1 THEN ? ELSE attempts END,
           available_at = ?, lease_id = NULL, lease_expires_at = NULL,
           error_code = ?, updated_at = ?
     WHERE entry_id = ? AND profile_id = ? AND state = 'leased' AND lease_id = ?
  `).run(
    state,
    input.permanent === true ? 1 : 0,
    EMBEDDING_JOB_MAX_ATTEMPTS,
    availableAt,
    input.errorCode,
    now,
    input.entryId,
    input.profileId,
    input.leaseId,
  );
  const updated = jobForLease(database, input);
  if (updated === undefined || updated.state !== state || updated.errorCode !== input.errorCode || updated.leaseId !== null) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Embedding job failure was not persisted');
  }
  return true;
}

export function failEmbeddingJob(database: SqliteDatabase, input: FailEmbeddingJobInput): boolean {
  return withImmediateTransaction(database, () => failEmbeddingJobInTransaction(database, input));
}

export function listEmbeddingJobs(
  database: SqliteDatabase,
  options: { profileId?: string; workspace?: string; state?: EmbeddingJobState } = {},
): EmbeddingJob[] {
  readEmbeddingRuntimeState(database);
  const profileId = options.profileId === undefined ? undefined : hash(options.profileId, 'profileId');
  const workspace = options.workspace === undefined ? undefined : requireWorkspace(options.workspace);
  const state = options.state;
  if (state !== undefined && state !== 'pending' && state !== 'leased' && state !== 'failed' && state !== 'blocked') invalid('state is invalid');
  const rows = database.prepare(`
    SELECT j.entry_id, j.profile_id, j.revision, j.content_hash, j.state,
           j.attempts, j.available_at, j.lease_id, j.lease_expires_at,
           j.error_code, j.created_at, j.updated_at, e.workspace
      FROM embedding_jobs AS j
      JOIN entries AS e ON e.id = j.entry_id
     WHERE (? IS NULL OR j.profile_id = ?)
       AND (? IS NULL OR e.workspace = ?)
       AND (? IS NULL OR j.state = ?)
     ORDER BY j.profile_id ASC, j.entry_id ASC
  `).all<JobRow>(
    profileId ?? null,
    profileId ?? null,
    workspace ?? null,
    workspace ?? null,
    state ?? null,
    state ?? null,
  );
  return rows.map(jobRow);
}
