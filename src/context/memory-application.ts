import { runVerifiers, type VerifierDependencies } from '../enno-oduno/verifier.js';
import { submissionVerifierSpecSchema } from '../enno-oduno/schemas.js';
import { captureRepositoryState } from '../enno-oduno/repository-state.js';
import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { findSecretInValue } from '../memory/secrets.js';
import { checkpointPathSchema } from '../ledger/checkpoint-contract.js';
import { hasActionableMemorySelection, memoryReasoningRequired } from '../akinator/capabilities.js';
import { readContextRunRetrievalState } from './run-state.js';
import { readContextDelivery } from './delivery.js';

const id = z.string().min(1).max(256).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const text = z.string().trim().min(1).max(2000);
const identity = { cwd: z.string().min(1), runId: id, deliveryId: id, requestId: id };
export const memoryReviewSchema = z.object({
  ...identity, entryId: id, entryRevision: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
  decision: z.enum(['adopt', 'not_applicable', 'contradicted']),
  basis: text, invariant: text.optional(), counterexample: text.optional(),
  verificationMethod: text.optional(), evidenceIds: z.array(id).max(30).default([]),
}).strict().superRefine((value, context) => {
  if (value.decision === 'adopt' && (!value.invariant || !value.counterexample || !value.verificationMethod)) {
    context.addIssue({ code: 'custom', message: 'Adoption requires an invariant, counterexample, and verification method' });
  }
});
export const memoryEvidenceSchema = z.object({
  ...identity, command: text, outcome: z.enum(['passed', 'failed', 'skipped', 'unknown']),
  exitCode: z.number().int().nonnegative().optional(),
  paths: z.array(checkpointPathSchema).min(1).max(200),
}).strict().superRefine((value, context) => {
  if (value.outcome === 'passed' && value.exitCode !== 0) context.addIssue({ code: 'custom', message: 'Passed execution requires exit code zero' });
});
type Evidence = z.infer<typeof memoryEvidenceSchema> & {
  evidenceId: string; origin: 'model_reported' | 'host_executed'; root: string; stateDigest: string; repositoryDigest?: string; executionState?: 'running' | 'finished'; verifierDigest?: string;
};
type Review = z.infer<typeof memoryReviewSchema> & { revision: number; origin: 'model_reported' };

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new KiokukoError('VALIDATION_ERROR', 'Invalid memory application request', { issues: result.error.issues.map(i => i.message) });
  if (findSecretInValue(result.data)) throw new KiokukoError('SECURITY_REJECTION', 'Memory application contains secret-shaped data');
  return result.data;
}

export async function memoryApplicationProject(database: SqliteDatabase, cwd: string, runId: string) {
  const project = await resolveProjectWorkspaceReadOnly(database, cwd);
  const run = new LedgerStore(database).readRun(runId);
  if (!project || !run || run.workspace !== project.workspace) throw new KiokukoError('NOT_FOUND', 'Task run was not found in this repository');
  if (run.status !== 'active') throw new KiokukoError('CONFLICT', 'Task run is terminal');
  return project;
}

export function latestMemoryDeliveryId(database: SqliteDatabase, runId: string): string | null {
  return database.prepare('SELECT delivery_id FROM context_deliveries WHERE run_id = ? ORDER BY rowid DESC LIMIT 1')
    .get<{ delivery_id: string }>(runId)?.delivery_id ?? null;
}

function assertDelivery(database: SqliteDatabase, runId: string, deliveryId: string) {
  const state = readContextRunRetrievalState(database, runId);
  if (latestMemoryDeliveryId(database, runId) !== deliveryId) throw new KiokukoError('CONFLICT', 'Memory delivery changed; review the current delivery');
  const delivery = readContextDelivery(database, { workspace: state.run.workspace, deliveryId });
  if (delivery.runId !== runId) throw new KiokukoError('CONFLICT', 'Memory delivery belongs to another run');
  return delivery;
}

/** Fingerprint only explicit verification dependencies; no file bytes or command output are persisted. */
export function verificationState(root: string, paths: readonly string[]): string {
  const canonicalRoot = realpathSync(root);
  let total = 0;
  const files = [...new Set(paths)].sort().map(relative => {
    if (!checkpointPathSchema.safeParse(relative).success) throw new KiokukoError('VALIDATION_ERROR', 'Invalid verification path');
    const absolute = path.resolve(canonicalRoot, relative);
    if (!absolute.startsWith(canonicalRoot + path.sep) || relative.split(/[\\/]/u).some(p => p === '.git' || p.startsWith('.env'))) {
      throw new KiokukoError('SECURITY_REJECTION', 'Verification path is outside permitted source files');
    }
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute || stat.size > 4 * 1024 * 1024) {
        throw new KiokukoError('VALIDATION_ERROR', 'Verification requires bounded regular files');
      }
      total += stat.size;
      if (total > 32 * 1024 * 1024) throw new KiokukoError('VALIDATION_ERROR', 'Verification dependencies exceed the byte limit');
      const bytes = readFileSync(absolute);
      if (bytes.length !== stat.size || realpathSync(absolute) !== absolute) throw new KiokukoError('CONFLICT', 'Verification input changed during read');
      return [relative, createHash('sha256').update(bytes).digest('hex')];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [relative, null];
      throw error;
    }
  });
  return canonicalContentHash({ root: canonicalRoot, files });
}

export function replayMemoryOperation<T>(database: SqliteDatabase, input: { runId: string; requestId: string }, digest: string): T | undefined {
  const row = database.prepare('SELECT digest, result_json FROM task_memory_operations WHERE run_id = ? AND request_id = ?')
    .get<{ digest: string; result_json: string }>(input.runId, input.requestId);
  if (!row) return undefined;
  if (row.digest !== digest) throw new KiokukoError('CONFLICT', 'Memory operation request identity was reused with different input');
  return JSON.parse(row.result_json) as T;
}
export function rememberMemoryOperation(database: SqliteDatabase, input: { runId: string; requestId: string }, digest: string, result: unknown) {
  database.prepare('INSERT INTO task_memory_operations VALUES (?, ?, ?, ?)').run(input.runId, input.requestId, digest, canonicalJson(result));
}

export async function recordMemoryEvidence(database: SqliteDatabase, raw: unknown): Promise<Evidence> {
  const input = parse(memoryEvidenceSchema, raw);
  const project = await memoryApplicationProject(database, input.cwd, input.runId);
  const digest = canonicalContentHash({ kind: 'evidence', input });
  return withImmediateTransaction(database, () => {
    const old = replayMemoryOperation<Evidence>(database, input, digest);
    if (old) return old;
    assertDelivery(database, input.runId, input.deliveryId);
    const evidence: Evidence = { ...input, evidenceId: randomUUID(), origin: 'model_reported',
      root: project.repositoryRoot, stateDigest: verificationState(project.repositoryRoot, input.paths) };
    database.prepare('INSERT INTO task_memory_evidence VALUES (?, ?, ?, ?)')
      .run(evidence.evidenceId, input.runId, input.deliveryId, canonicalJson(evidence));
    rememberMemoryOperation(database, input, digest, evidence);
    return evidence;
  });
}

function readEvidence(database: SqliteDatabase, evidenceId: string, runId: string, deliveryId: string): Evidence {
  const row = database.prepare('SELECT evidence_json FROM task_memory_evidence WHERE evidence_id = ? AND run_id = ? AND delivery_id = ?')
    .get<{ evidence_json: string }>(evidenceId, runId, deliveryId);
  if (!row) throw new KiokukoError('CONFLICT', 'Execution evidence is missing or belongs to another run or delivery');
  return JSON.parse(row.evidence_json) as Evidence;
}

export async function reviewTaskMemory(database: SqliteDatabase, raw: unknown): Promise<Review> {
  const input = parse(memoryReviewSchema, raw);
  await memoryApplicationProject(database, input.cwd, input.runId);
  const digest = canonicalContentHash({ kind: 'review', input });
  return withImmediateTransaction(database, () => {
    const old = replayMemoryOperation<Review>(database, input, digest);
    if (old) return old;
    const delivery = assertDelivery(database, input.runId, input.deliveryId);
    const selected = delivery.items.find(item => item.entryId === input.entryId && item.entryRevision === input.entryRevision);
    const current = database.prepare('SELECT current_revision FROM entries WHERE id = ?').get<{ current_revision: number }>(input.entryId);
    if (!selected || current?.current_revision !== input.entryRevision) throw new KiokukoError('CONFLICT', 'Memory entry revision changed or was not delivered');
    const stored = database.prepare('SELECT revision FROM task_memory_reviews WHERE run_id = ? AND delivery_id = ? AND entry_id = ?')
      .get<{ revision: number }>(input.runId, input.deliveryId, input.entryId);
    if ((stored?.revision ?? 0) !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Memory review revision changed');
    for (const evidenceId of input.evidenceIds) readEvidence(database, evidenceId, input.runId, input.deliveryId);
    const review: Review = { ...input, revision: input.expectedRevision + 1, origin: 'model_reported' };
    database.prepare(`INSERT INTO task_memory_reviews VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, delivery_id, entry_id) DO UPDATE SET revision = excluded.revision, review_json = excluded.review_json`)
      .run(input.runId, input.deliveryId, input.entryId, input.entryRevision, review.revision, canonicalJson(review));
    rememberMemoryOperation(database, input, digest, review);
    return review;
  });
}

export interface MemoryApplicationStatus {
  deliveryId: string | null;
  required: number;
  pending: string[];
  invalid: Array<{ entryId: string; reason: string }>;
  complete: boolean;
  evidenceOrigin: 'model_reported' | 'host_executed' | 'mixed' | 'none';
  clientObserved: false;
}

/** A missing review degrades completion evidence, never permission to continue ordinary work. */
export function memoryApplicationStatus(database: SqliteDatabase, runId: string, root: string): MemoryApplicationStatus {
  const state = readContextRunRetrievalState(database, runId);
  const deliveryId = latestMemoryDeliveryId(database, runId);
  const result: MemoryApplicationStatus = { deliveryId, required: 0, pending: [], invalid: [], complete: true, evidenceOrigin: 'none', clientObserved: false };
  if (!deliveryId) return result;
  const delivery = readContextDelivery(database, { workspace: state.run.workspace, deliveryId });
  const applicable = memoryReasoningRequired(state.profile, 'actionable');
  if (!applicable) return result;
  const codeChange = state.profile.taskType === 'build' || state.profile.taskType === 'debug';
  for (const item of delivery.items.filter(item => hasActionableMemorySelection([item]))) {
    result.required++;
    const row = database.prepare('SELECT review_json FROM task_memory_reviews WHERE run_id = ? AND delivery_id = ? AND entry_id = ?')
      .get<{ review_json: string }>(runId, deliveryId, item.entryId);
    if (!row) { result.pending.push(item.entryId); continue; }
    const review = JSON.parse(row.review_json) as Review;
    const current = database.prepare('SELECT current_revision FROM entries WHERE id = ?').get<{ current_revision: number }>(item.entryId);
    if (current?.current_revision !== review.entryRevision) { result.invalid.push({ entryId: item.entryId, reason: 'entry_revision_changed' }); continue; }
    if (review.decision !== 'adopt' || !codeChange) continue;
    if (review.evidenceIds.length === 0) { result.invalid.push({ entryId: item.entryId, reason: 'verification_missing' }); continue; }
    for (const evidenceId of review.evidenceIds) {
      const evidence = readEvidence(database, evidenceId, runId, deliveryId);
      result.evidenceOrigin = result.evidenceOrigin === 'none' || result.evidenceOrigin === evidence.origin ? evidence.origin : 'mixed';
      let reason: string | undefined;
      if (evidence.outcome !== 'passed' || evidence.exitCode !== 0) reason = `verification_${evidence.outcome}`;
      else {
        try {
          if (evidence.root !== realpathSync(root) || verificationState(root, evidence.paths) !== evidence.stateDigest
            || (evidence.repositoryDigest !== undefined && captureRepositoryState(root).digest !== evidence.repositoryDigest)) reason = 'verification_stale';
        } catch {
          // Unreadable or replaced inputs invalidate evidence without preventing cancellation.
          reason = 'verification_state_unavailable';
        }
      }
      if (reason) result.invalid.push({ entryId: item.entryId, reason });
    }
  }
  result.complete = result.pending.length === 0 && result.invalid.length === 0;
  return result;
}

export const memoryVerifySchema = z.object({
  ...identity, paths: z.array(checkpointPathSchema).min(1).max(200), verifier: submissionVerifierSpecSchema,
}).strict();

/** The host owns execution and records no output text. An uncertain attempt is never automatically rerun. */
export async function verifyTaskMemory(database: SqliteDatabase, raw: unknown, dependencies: VerifierDependencies = {}): Promise<Evidence> {
  const input = parse(memoryVerifySchema, raw);
  dependencies.signal?.throwIfAborted();
  const project = await memoryApplicationProject(database, input.cwd, input.runId);
  const digest = canonicalContentHash({ kind: 'verify', input });
  let claimed = false;
  const pending = withImmediateTransaction(database, () => {
    const old = replayMemoryOperation<Evidence>(database, input, digest);
    if (old) return old;
    assertDelivery(database, input.runId, input.deliveryId);
    const evidence: Evidence = { cwd: input.cwd, runId: input.runId, deliveryId: input.deliveryId, requestId: input.requestId,
      paths: input.paths, command: input.verifier.executable, evidenceId: randomUUID(), origin: 'host_executed',
      verifierDigest: canonicalContentHash(input.verifier),
      outcome: 'unknown', executionState: 'running', root: project.repositoryRoot,
      stateDigest: verificationState(project.repositoryRoot, input.paths), repositoryDigest: captureRepositoryState(project.repositoryRoot).digest };
    database.prepare('INSERT INTO task_memory_evidence VALUES (?, ?, ?, ?)')
      .run(evidence.evidenceId, input.runId, input.deliveryId, canonicalJson(evidence));
    rememberMemoryOperation(database, input, digest, evidence);
    claimed = true;
    return evidence;
  });
  if (!claimed) return pending;
  const results = await runVerifiers([input.verifier], project.repositoryRoot, dependencies);
  const result = results[0]!;
  const currentDigest = captureRepositoryState(project.repositoryRoot).digest;
  const passed = result.status === 'passed' && result.exitCode === 0 && !result.changedDuringVerification
    && pending.repositoryDigest === currentDigest && !dependencies.signal?.aborted;
  const evidence: Evidence = { ...pending, executionState: 'finished',
    outcome: passed ? 'passed' : result.status === 'failed' ? 'failed' : 'unknown',
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }) };
  return withImmediateTransaction(database, () => {
    // A concurrent delivery/terminal change leaves the reserved attempt unknown.
    assertDelivery(database, input.runId, input.deliveryId);
    database.prepare('UPDATE task_memory_evidence SET evidence_json = ? WHERE evidence_id = ?')
      .run(canonicalJson(evidence), evidence.evidenceId);
    database.prepare('UPDATE task_memory_operations SET result_json = ? WHERE run_id = ? AND request_id = ? AND digest = ?')
      .run(canonicalJson(evidence), input.runId, input.requestId, digest);
    return evidence;
  });
}
