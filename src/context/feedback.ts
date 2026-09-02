import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { sanitizeJson } from '../security/sanitize.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { entryOriginMatchesWorkspace, isContextEntryOrigin } from './origin.js';
import {
  CONTEXT_FEEDBACK_VERDICTS,
  MAX_FEEDBACK_COMMENT_BYTES,
  MAX_FEEDBACK_IDENTIFIER_LENGTH,
} from '../ledger/checkpoint-contract.js';

export { CONTEXT_FEEDBACK_VERDICTS, MAX_FEEDBACK_COMMENT_BYTES, MAX_FEEDBACK_IDENTIFIER_LENGTH };

export const MAX_FEEDBACK_OUTCOME_BYTES = 4 * 1024;

export type ContextFeedbackVerdict = (typeof CONTEXT_FEEDBACK_VERDICTS)[number];
export const RUN_FEEDBACK_RECOMMENDATION_VERDICTS = ['accepted', 'dismissed', 'resolved'] as const;
export type RunFeedbackRecommendationVerdict = (typeof RUN_FEEDBACK_RECOMMENDATION_VERDICTS)[number];

export interface ContextFeedbackRecord {
  feedbackId: string;
  workspace: string;
  deliveryId: string;
  entryId: string;
  runId: string;
  verdict: ContextFeedbackVerdict;
  comment: string | null;
  actor: string;
  /** The idempotency key is stored as this lowercase SHA-256 digest; the raw key is never returned. */
  idempotencyKeyHash: string;
  createdAt: string;
}

export interface ContextFeedbackSignal {
  verdict: ContextFeedbackVerdict;
  distinctRuns: number;
  boundedInfluence: number;
}

/** Shared cross-run feedback evidence for retrieval policy consumers. */
export function contextFeedbackSignals(database: SqliteDatabase, entryId: string): ContextFeedbackSignal[] {
  const rows = database.prepare(`
    SELECT verdict, COUNT(DISTINCT run_id) AS distinctRuns
      FROM context_feedback
     WHERE entry_id = ?
     GROUP BY verdict
  `).all<{ verdict: unknown; distinctRuns: unknown }>(entryId);
  const byVerdict = new Map<ContextFeedbackVerdict, number>();
  for (const row of rows) {
    if (typeof row.verdict !== 'string'
      || !CONTEXT_FEEDBACK_VERDICTS.includes(row.verdict as ContextFeedbackVerdict)
      || typeof row.distinctRuns !== 'number'
      || !Number.isSafeInteger(row.distinctRuns)
      || row.distinctRuns < 1) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context feedback aggregate is invalid');
    }
    byVerdict.set(row.verdict as ContextFeedbackVerdict, row.distinctRuns);
  }
  return CONTEXT_FEEDBACK_VERDICTS.flatMap((verdict) => {
    const distinctRuns = byVerdict.get(verdict);
    return distinctRuns === undefined ? [] : [{ verdict, distinctRuns, boundedInfluence: Math.min(2, distinctRuns) }];
  });
}

export interface FeedbackListPage<T> {
  records: T[];
  truncated: boolean;
}

export interface RunFeedbackRecord {
  feedbackId: string;
  workspace: string;
  runId: string;
  outcome: string | null;
  recommendationCode: string | null;
  recommendationVerdict: RunFeedbackRecommendationVerdict | null;
  rating: number | null;
  comment: string | null;
  actor: string;
  /** The idempotency key is stored as this lowercase SHA-256 digest; the raw key is never returned. */
  idempotencyKeyHash: string;
  createdAt: string;
}

interface ValidatedContextFeedbackInput {
  feedbackId: string;
  workspace: string;
  deliveryId: string;
  entryId: string;
  entryRevision?: number;
  runId: string;
  verdict: ContextFeedbackVerdict;
  comment: string | null;
  actor: string;
  idempotencyKeyHash: string;
  createdAt: string;
}

interface ContextFeedbackRow extends SqliteRow {
  feedback_id: unknown;
  delivery_id: unknown;
  entry_id: unknown;
  run_id: unknown;
  verdict: unknown;
  comment: unknown;
  actor: unknown;
  idempotency_key: unknown;
  created_at: unknown;
  run_workspace: unknown;
  delivery_run_id: unknown;
  joined_delivery_id: unknown;
  linked_delivery_id: unknown;
  linked_entry_id: unknown;
  entry_revision: unknown;
  entry_workspace: unknown;
  revision_workspace: unknown;
  origin_scope: unknown;
}

interface RunFeedbackRow extends SqliteRow {
  feedback_id: unknown;
  run_id: unknown;
  outcome: unknown;
  recommendation_code: unknown;
  recommendation_verdict: unknown;
  rating: unknown;
  comment: unknown;
  actor: unknown;
  idempotency_key: unknown;
  created_at: unknown;
  run_workspace: unknown;
}

const CONTEXT_INPUT_FIELDS = new Set([
  'workspace', 'feedbackId', 'deliveryId', 'entryId', 'entryRevision', 'runId', 'verdict',
  'comment', 'actor', 'idempotencyKey', 'createdAt',
]);
const CONTEXT_LIST_FIELDS = new Set(['workspace', 'runId', 'deliveryId', 'entryId', 'limit']);
const RUN_INPUT_FIELDS = new Set([
  'workspace', 'feedbackId', 'runId', 'outcome', 'recommendationCode', 'recommendationVerdict',
  'rating', 'comment', 'actor', 'idempotencyKey', 'createdAt',
]);
const RUN_LIST_FIELDS = new Set(['workspace', 'runId', 'limit']);
const VALIDATION_MESSAGE = 'Feedback input is invalid';
const NOT_FOUND_MESSAGE = 'Feedback target was not found';
const CONFLICT_MESSAGE = 'Feedback conflicts with existing record';
const INTEGRITY_MESSAGE = 'Stored feedback is invalid';
const DATABASE_MESSAGE = 'Feedback database operation failed';

function fail(code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'INTEGRITY_ERROR' | 'DATABASE_ERROR', message: string): never {
  throw new KiokukoError(code, message);
}

function validation(): never {
  return fail('VALIDATION_ERROR', VALIDATION_MESSAGE);
}

function notFound(): never {
  return fail('NOT_FOUND', NOT_FOUND_MESSAGE);
}

function conflict(): never {
  return fail('CONFLICT', CONFLICT_MESSAGE);
}

function integrity(): never {
  return fail('INTEGRITY_ERROR', INTEGRITY_MESSAGE);
}

function databaseFailure(): never {
  return fail('DATABASE_ERROR', DATABASE_MESSAGE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inputFields(value: unknown, allowed: ReadonlySet<string>, exact = false): Record<string, unknown> {
  if (!isPlainObject(value)) validation();
  const keys = Reflect.ownKeys(value);
  if (exact && keys.length !== allowed.size) validation();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) validation();
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) validation();
    result[key] = descriptor.value;
  }
  return result;
}

function isKiokukoError(error: unknown): error is KiokukoError {
  return error instanceof KiokukoError;
}

interface NodeSqliteFailure extends Error {
  readonly code?: unknown;
  readonly errcode?: unknown;
}

const SQLITE_CONSTRAINT_PRIMARY_KEY = 1_555;
const SQLITE_CONSTRAINT_UNIQUE = 2_067;
const NO_UNIQUENESS_FAILURES = new Set<string>();
const SQLITE_OPERATIONAL_PRIMARY_CODES = new Set([5, 6, 7, 8, 9, 10, 13, 14, 15, 22, 23]);
const SQLITE_INTEGRITY_PRIMARY_CODES = new Set([11, 24, 26]);
const CONTEXT_FEEDBACK_UNIQUENESS_FAILURES = new Set([
  'UNIQUE constraint failed: context_feedback.feedback_id',
  'UNIQUE constraint failed: context_feedback.run_id, context_feedback.actor, context_feedback.idempotency_key',
]);
const RUN_FEEDBACK_UNIQUENESS_FAILURES = new Set([
  'UNIQUE constraint failed: run_feedback.feedback_id',
  'UNIQUE constraint failed: run_feedback.run_id, run_feedback.actor, run_feedback.idempotency_key',
]);
const INTAKE_FEEDBACK_UNIQUENESS_FAILURES = new Set([
  'UNIQUE constraint failed: intake_feedback.feedback_id',
  'UNIQUE constraint failed: intake_feedback.run_id, intake_feedback.actor, intake_feedback.idempotency_key',
]);

function nodeSqliteFailure(error: unknown): NodeSqliteFailure | null {
  if (!(error instanceof Error)) return null;
  const failure = error as NodeSqliteFailure;
  if (
    failure.code !== 'ERR_SQLITE_ERROR'
    || typeof failure.errcode !== 'number'
    || !Number.isSafeInteger(failure.errcode)
    || failure.errcode < 0
  ) return null;
  return failure;
}

function normalizeDatabaseError(error: unknown, uniquenessFailures: ReadonlySet<string> = NO_UNIQUENESS_FAILURES): never {
  if (isKiokukoError(error)) throw error;
  const failure = nodeSqliteFailure(error);
  if (failure === null) throw error;
  if (
    (failure.errcode === SQLITE_CONSTRAINT_PRIMARY_KEY || failure.errcode === SQLITE_CONSTRAINT_UNIQUE)
    && uniquenessFailures.has(failure.message)
  ) conflict();
  const primaryResultCode = (failure.errcode as number) & 0xff;
  if (SQLITE_INTEGRITY_PRIMARY_CODES.has(primaryResultCode)) integrity();
  if (SQLITE_OPERATIONAL_PRIMARY_CODES.has(primaryResultCode)) databaseFailure();
  throw error;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FEEDBACK_IDENTIFIER_LENGTH) validation();
  return value;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) validation();
  return value;
}

function optionalUtf8Text(value: unknown, maximumBytes: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes) validation();
  return value;
}

function isCanonicalFeedbackTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validateFeedbackTimestamp(value: unknown): string {
  if (!isCanonicalFeedbackTimestamp(value)) validation();
  return value;
}

function normalizeComment(value: unknown, workspace: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') validation();
  if (value.trim().length === 0) return null;
  const sanitized = sanitizeJson(value, { workspace }).value;
  if (typeof sanitized !== 'string') validation();
  if (sanitized.trim().length === 0) return null;
  if (Buffer.byteLength(sanitized, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) validation();
  return sanitized;
}

function hashIdempotencyKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function contextBodyHash(input: Pick<ContextFeedbackRecord, 'feedbackId' | 'workspace' | 'deliveryId' | 'entryId' | 'runId' | 'verdict' | 'comment' | 'actor' | 'createdAt'>): string {
  return canonicalContentHash({
    feedbackId: input.feedbackId,
    workspace: input.workspace,
    deliveryId: input.deliveryId,
    entryId: input.entryId,
    runId: input.runId,
    verdict: input.verdict,
    comment: input.comment,
    actor: input.actor,
    createdAt: input.createdAt,
  });
}

function runBodyHash(input: Pick<RunFeedbackRecord, 'feedbackId' | 'workspace' | 'runId' | 'outcome' | 'recommendationCode' | 'recommendationVerdict' | 'rating' | 'comment' | 'actor' | 'createdAt'>): string {
  return canonicalContentHash({
    feedbackId: input.feedbackId,
    workspace: input.workspace,
    runId: input.runId,
    outcome: input.outcome,
    recommendationCode: input.recommendationCode,
    recommendationVerdict: input.recommendationVerdict,
    rating: input.rating,
    comment: input.comment,
    actor: input.actor,
    createdAt: input.createdAt,
  });
}

function validateContextFeedbackInput(value: unknown): ValidatedContextFeedbackInput {
  const fields = inputFields(value, CONTEXT_INPUT_FIELDS);
  const workspace = requiredString(fields.workspace);
  const feedbackId = requiredString(fields.feedbackId);
  const deliveryId = requiredString(fields.deliveryId);
  const entryId = requiredString(fields.entryId);
  const entryRevision = fields.entryRevision === undefined
    ? undefined
    : typeof fields.entryRevision === 'number' && Number.isSafeInteger(fields.entryRevision) && fields.entryRevision > 0
      ? fields.entryRevision
      : validation();
  const runId = requiredString(fields.runId);
  if (typeof fields.verdict !== 'string' || !CONTEXT_FEEDBACK_VERDICTS.includes(fields.verdict as ContextFeedbackVerdict)) validation();
  const verdict = fields.verdict as ContextFeedbackVerdict;
  const actor = requiredString(fields.actor);
  const idempotencyKey = requiredString(fields.idempotencyKey);
  const createdAt = validateFeedbackTimestamp(fields.createdAt);
  const comment = normalizeComment(fields.comment, workspace);
  return {
    feedbackId,
    workspace,
    deliveryId,
    entryId,
    ...(entryRevision === undefined ? {} : { entryRevision }),
    runId,
    verdict,
    comment,
    actor,
    idempotencyKeyHash: hashIdempotencyKey(idempotencyKey),
    createdAt,
  };
}

interface ValidatedContextFeedbackListInput {
  workspace: string;
  runId?: string;
  deliveryId?: string;
  entryId?: string;
  limit: number;
}

function validateContextFeedbackListInput(value: unknown): ValidatedContextFeedbackListInput {
  const fields = inputFields(value, CONTEXT_LIST_FIELDS);
  const workspace = requiredString(fields.workspace);
  const runId = fields.runId === undefined ? undefined : requiredString(fields.runId);
  const deliveryId = fields.deliveryId === undefined ? undefined : requiredString(fields.deliveryId);
  const entryId = fields.entryId === undefined ? undefined : requiredString(fields.entryId);
  const limit = fields.limit === undefined ? 100 : fields.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) validation();
  return {
    workspace,
    ...(runId === undefined ? {} : { runId }),
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(entryId === undefined ? {} : { entryId }),
    limit,
  };
}

interface ValidatedRunFeedbackListInput {
  workspace: string;
  runId?: string;
  limit: number;
}

function validateRunFeedbackListInput(value: unknown): ValidatedRunFeedbackListInput {
  const fields = inputFields(value, RUN_LIST_FIELDS);
  const workspace = requiredString(fields.workspace);
  const runId = fields.runId === undefined ? undefined : requiredString(fields.runId);
  const limit = fields.limit === undefined ? 100 : fields.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) validation();
  return { workspace, ...(runId === undefined ? {} : { runId }), limit };
}

interface ValidatedRunFeedbackInput {
  feedbackId: string;
  workspace: string;
  runId: string;
  outcome: string | null;
  recommendationCode: string | null;
  recommendationVerdict: RunFeedbackRecommendationVerdict | null;
  rating: number | null;
  comment: string | null;
  actor: string;
  idempotencyKeyHash: string;
  createdAt: string;
}

function validateRunFeedbackInput(value: unknown): ValidatedRunFeedbackInput {
  const fields = inputFields(value, RUN_INPUT_FIELDS);
  const workspace = requiredString(fields.workspace);
  const feedbackId = requiredString(fields.feedbackId);
  const runId = requiredString(fields.runId);
  const outcome = optionalUtf8Text(fields.outcome, MAX_FEEDBACK_OUTCOME_BYTES);
  const recommendationCode = optionalText(fields.recommendationCode, MAX_FEEDBACK_IDENTIFIER_LENGTH);
  const rawRecommendationVerdict = fields.recommendationVerdict;
  const recommendationVerdict = rawRecommendationVerdict === undefined || rawRecommendationVerdict === null
    ? null
    : typeof rawRecommendationVerdict === 'string' && RUN_FEEDBACK_RECOMMENDATION_VERDICTS.includes(rawRecommendationVerdict as RunFeedbackRecommendationVerdict)
      ? rawRecommendationVerdict as RunFeedbackRecommendationVerdict
      : validation();
  if ((recommendationCode === null) !== (recommendationVerdict === null)) validation();
  const rawRating = fields.rating;
  const rating = rawRating === undefined || rawRating === null
    ? null
    : typeof rawRating === 'number' && Number.isInteger(rawRating) && rawRating >= 1 && rawRating <= 5
      ? rawRating
      : validation();
  if (outcome === null && recommendationCode === null && rating === null) validation();
  const actor = requiredString(fields.actor);
  const idempotencyKey = requiredString(fields.idempotencyKey);
  const createdAt = validateFeedbackTimestamp(fields.createdAt);
  const comment = normalizeComment(fields.comment, workspace);
  return {
    feedbackId,
    workspace,
    runId,
    outcome,
    recommendationCode,
    recommendationVerdict,
    rating,
    comment,
    actor,
    idempotencyKeyHash: hashIdempotencyKey(idempotencyKey),
    createdAt,
  };
}

function assertContextTarget(database: SqliteDatabase, input: ValidatedContextFeedbackInput): void {
  const target = database.prepare(`
    SELECT cde.entry_revision AS entry_revision, cde.origin_scope AS origin_scope,
           e.workspace AS entry_workspace, er.workspace AS revision_workspace
    FROM context_deliveries AS cd
    JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
    JOIN context_delivery_entries AS cde
      ON cde.delivery_id = cd.delivery_id AND cde.entry_id = ?
    JOIN entries AS e ON e.id = cde.entry_id
    JOIN entry_revisions AS er
      ON er.entry_id = cde.entry_id AND er.revision = cde.entry_revision
    WHERE cd.delivery_id = ?
      AND cd.run_id = ?
      AND lr.workspace = ?
  `).get<{ entry_revision: number; origin_scope: unknown; entry_workspace: unknown; revision_workspace: unknown }>(input.entryId, input.deliveryId, input.runId, input.workspace);
  if (!target) notFound();
  if (!isContextEntryOrigin(target.origin_scope)
    || typeof target.entry_workspace !== 'string'
    || target.revision_workspace !== target.entry_workspace
    || !entryOriginMatchesWorkspace({ origin: target.origin_scope, runWorkspace: input.workspace, entryWorkspace: target.entry_workspace })) notFound();
  if (input.entryRevision !== undefined && target.entry_revision !== input.entryRevision) conflict();
}

function selectContextByKey(database: SqliteDatabase, input: ValidatedContextFeedbackInput): ContextFeedbackRow | undefined {
  return database.prepare(`
    SELECT
      cf.feedback_id, cf.delivery_id, cf.entry_id, cf.run_id, cf.verdict, cf.comment,
      cf.actor, cf.idempotency_key, cf.created_at,
      lr.workspace AS run_workspace,
      cd.run_id AS delivery_run_id,
      cd.delivery_id AS joined_delivery_id,
      cde.delivery_id AS linked_delivery_id,
      cde.entry_id AS linked_entry_id,
      cde.entry_revision AS entry_revision,
      e.workspace AS entry_workspace,
      er.workspace AS revision_workspace,
      cde.origin_scope AS origin_scope
    FROM context_feedback AS cf
    LEFT JOIN ledger_runs AS lr ON lr.run_id = cf.run_id
    LEFT JOIN context_deliveries AS cd ON cd.delivery_id = cf.delivery_id
    LEFT JOIN context_delivery_entries AS cde
      ON cde.delivery_id = cf.delivery_id AND cde.entry_id = cf.entry_id
    LEFT JOIN entries AS e ON e.id = cf.entry_id
    LEFT JOIN entry_revisions AS er
      ON er.entry_id = cde.entry_id AND er.revision = cde.entry_revision
    WHERE cf.run_id = ? AND cf.actor = ? AND cf.idempotency_key = ?
  `).get<ContextFeedbackRow>(input.runId, input.actor, input.idempotencyKeyHash);
}

function hasContextFeedbackId(database: SqliteDatabase, feedbackId: string): boolean {
  return Boolean(database.prepare('SELECT 1 AS present FROM context_feedback WHERE feedback_id = ?').get<{ present: number }>(feedbackId));
}

function storedString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) integrity();
  return value;
}

function storedHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) integrity();
  return value;
}

function storedTimestamp(value: unknown): string {
  if (!isCanonicalFeedbackTimestamp(value)) integrity();
  return value;
}

function rowToContextFeedback(row: ContextFeedbackRow, workspace: string): ContextFeedbackRecord {
  const feedbackId = storedString(row.feedback_id);
  const deliveryId = storedString(row.delivery_id);
  const entryId = storedString(row.entry_id);
  const runId = storedString(row.run_id);
  const actor = storedString(row.actor);
  const runWorkspace = storedString(row.run_workspace);
  if (runWorkspace !== workspace) integrity();
  if (storedString(row.delivery_run_id) !== runId) integrity();
  if (storedString(row.joined_delivery_id) !== deliveryId) integrity();
  if (storedString(row.linked_delivery_id) !== deliveryId) integrity();
  if (storedString(row.linked_entry_id) !== entryId) integrity();
  const origin = isContextEntryOrigin(row.origin_scope) ? row.origin_scope : integrity();
  const entryWorkspace = storedString(row.entry_workspace);
  if (storedString(row.revision_workspace) !== entryWorkspace
    || !entryOriginMatchesWorkspace({ origin, runWorkspace: workspace, entryWorkspace })) integrity();
  if (typeof row.verdict !== 'string' || !CONTEXT_FEEDBACK_VERDICTS.includes(row.verdict as ContextFeedbackVerdict)) integrity();
  const verdict = row.verdict as ContextFeedbackVerdict;
  let comment: string | null;
  if (row.comment === null) {
    comment = null;
  } else if (typeof row.comment === 'string') {
    if (row.comment.length === 0 || Buffer.byteLength(row.comment, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) integrity();
    const sanitized = normalizeComment(row.comment, workspace);
    if (sanitized !== row.comment) integrity();
    comment = row.comment;
  } else {
    integrity();
  }
  return {
    feedbackId,
    workspace,
    deliveryId,
    entryId,
    runId,
    verdict,
    comment,
    actor,
    idempotencyKeyHash: storedHash(row.idempotency_key),
    createdAt: storedTimestamp(row.created_at),
  };
}

function preflightContextFeedbackWrite(
  database: SqliteDatabase,
  input: ValidatedContextFeedbackInput,
): ContextFeedbackRecord | undefined {
  assertContextTarget(database, input);
  const existingByKey = selectContextByKey(database, input);
  if (existingByKey) {
    const existing = rowToContextFeedback(existingByKey, input.workspace);
    if (contextBodyHash(existing) === contextBodyHash(input)) return existing;
    conflict();
  }
  if (hasContextFeedbackId(database, input.feedbackId)) conflict();
  return undefined;
}

/** Validate a context-feedback write and its exact persisted target without mutating state. */
export function assertContextFeedbackRecordable(database: SqliteDatabase, input: unknown): void {
  const validated = validateContextFeedbackInput(input);
  try {
    preflightContextFeedbackWrite(database, validated);
  } catch (error) {
    normalizeDatabaseError(error, CONTEXT_FEEDBACK_UNIQUENESS_FAILURES);
  }
}

function writeContextFeedback(database: SqliteDatabase, input: ValidatedContextFeedbackInput): ContextFeedbackRecord {
  const existing = preflightContextFeedbackWrite(database, input);
  if (existing !== undefined) return existing;
  database.prepare(`
    INSERT INTO context_feedback (
      feedback_id, delivery_id, entry_id, run_id, verdict, comment, actor, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.feedbackId,
    input.deliveryId,
    input.entryId,
    input.runId,
    input.verdict,
    input.comment,
    input.actor,
    input.idempotencyKeyHash,
    input.createdAt,
  );
  const row = selectContextByKey(database, input);
  if (!row) integrity();
  return rowToContextFeedback(row, input.workspace);
}

export function recordContextFeedbackInTransaction(database: SqliteDatabase, input: unknown): ContextFeedbackRecord {
  const validated = validateContextFeedbackInput(input);
  try {
    return writeContextFeedback(database, validated);
  } catch (error) {
    normalizeDatabaseError(error, CONTEXT_FEEDBACK_UNIQUENESS_FAILURES);
  }
}

export function recordContextFeedback(database: SqliteDatabase, input: unknown): ContextFeedbackRecord {
  const validated = validateContextFeedbackInput(input);
  try {
    return withImmediateTransaction(database, () => writeContextFeedback(database, validated));
  } catch (error) {
    normalizeDatabaseError(error, CONTEXT_FEEDBACK_UNIQUENESS_FAILURES);
  }
}

function runOptionalStoredText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) integrity();
  return value;
}

function runOptionalStoredUtf8Text(value: unknown, maximumBytes: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes) integrity();
  return value;
}

function runStoredComment(value: unknown, workspace: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) integrity();
  const sanitized = normalizeComment(value, workspace);
  if (sanitized !== value) integrity();
  return value;
}

function runBodyHashFromInput(input: ValidatedRunFeedbackInput): string {
  return runBodyHash(input);
}

function assertRunTarget(database: SqliteDatabase, input: ValidatedRunFeedbackInput): void {
  const target = database.prepare('SELECT 1 AS present FROM ledger_runs WHERE run_id = ? AND workspace = ?').get<{ present: number }>(input.runId, input.workspace);
  if (!target) notFound();
}

function selectRunByKey(database: SqliteDatabase, input: ValidatedRunFeedbackInput): RunFeedbackRow | undefined {
  return database.prepare(`
    SELECT
      rf.feedback_id, rf.run_id, rf.outcome, rf.recommendation_code, rf.recommendation_verdict,
      rf.rating, rf.comment, rf.actor, rf.idempotency_key, rf.created_at,
      lr.workspace AS run_workspace
    FROM run_feedback AS rf
    LEFT JOIN ledger_runs AS lr ON lr.run_id = rf.run_id
    WHERE rf.run_id = ? AND rf.actor = ? AND rf.idempotency_key = ?
  `).get<RunFeedbackRow>(input.runId, input.actor, input.idempotencyKeyHash);
}

function hasRunFeedbackId(database: SqliteDatabase, feedbackId: string): boolean {
  return Boolean(database.prepare('SELECT 1 AS present FROM run_feedback WHERE feedback_id = ?').get<{ present: number }>(feedbackId));
}

function rowToRunFeedback(row: RunFeedbackRow, workspace: string): RunFeedbackRecord {
  const feedbackId = storedString(row.feedback_id);
  const runId = storedString(row.run_id);
  const runWorkspace = storedString(row.run_workspace);
  if (runWorkspace !== workspace) integrity();
  const outcome = runOptionalStoredUtf8Text(row.outcome, MAX_FEEDBACK_OUTCOME_BYTES);
  const recommendationCode = runOptionalStoredText(row.recommendation_code, MAX_FEEDBACK_IDENTIFIER_LENGTH);
  let recommendationVerdict: RunFeedbackRecommendationVerdict | null;
  if (row.recommendation_verdict === null) {
    recommendationVerdict = null;
  } else if (typeof row.recommendation_verdict === 'string' && RUN_FEEDBACK_RECOMMENDATION_VERDICTS.includes(row.recommendation_verdict as RunFeedbackRecommendationVerdict)) {
    recommendationVerdict = row.recommendation_verdict as RunFeedbackRecommendationVerdict;
  } else {
    integrity();
  }
  if ((recommendationCode === null) !== (recommendationVerdict === null)) integrity();
  const rating = row.rating === null
    ? null
    : typeof row.rating === 'number' && Number.isInteger(row.rating) && row.rating >= 1 && row.rating <= 5
      ? row.rating
      : integrity();
  if (outcome === null && recommendationCode === null && rating === null) integrity();
  const actor = storedString(row.actor);
  const comment = runStoredComment(row.comment, workspace);
  return {
    feedbackId,
    workspace,
    runId,
    outcome,
    recommendationCode,
    recommendationVerdict,
    rating,
    comment,
    actor,
    idempotencyKeyHash: storedHash(row.idempotency_key),
    createdAt: storedTimestamp(row.created_at),
  };
}

function writeRunFeedback(database: SqliteDatabase, input: ValidatedRunFeedbackInput): RunFeedbackRecord {
  assertRunTarget(database, input);
  const existingByKey = selectRunByKey(database, input);
  if (existingByKey) {
    const existing = rowToRunFeedback(existingByKey, input.workspace);
    if (runBodyHash(existing) === runBodyHashFromInput(input)) return existing;
    conflict();
  }
  if (hasRunFeedbackId(database, input.feedbackId)) conflict();
  database.prepare(`
    INSERT INTO run_feedback (
      feedback_id, run_id, outcome, recommendation_code, recommendation_verdict,
      rating, comment, actor, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.feedbackId,
    input.runId,
    input.outcome,
    input.recommendationCode,
    input.recommendationVerdict,
    input.rating,
    input.comment,
    input.actor,
    input.idempotencyKeyHash,
    input.createdAt,
  );
  const row = selectRunByKey(database, input);
  if (!row) integrity();
  return rowToRunFeedback(row, input.workspace);
}

export function recordRunFeedbackInTransaction(database: SqliteDatabase, input: unknown): RunFeedbackRecord {
  const validated = validateRunFeedbackInput(input);
  try {
    return writeRunFeedback(database, validated);
  } catch (error) {
    normalizeDatabaseError(error, RUN_FEEDBACK_UNIQUENESS_FAILURES);
  }
}

export function recordRunFeedback(database: SqliteDatabase, input: unknown): RunFeedbackRecord {
  const validated = validateRunFeedbackInput(input);
  try {
    return withImmediateTransaction(database, () => writeRunFeedback(database, validated));
  } catch (error) {
    normalizeDatabaseError(error, RUN_FEEDBACK_UNIQUENESS_FAILURES);
  }
}

export function listRunFeedback(database: SqliteDatabase, input: unknown): FeedbackListPage<RunFeedbackRecord> {
  const validated = validateRunFeedbackListInput(input);
  try {
    const conditions = ['(lr.workspace = ? OR lr.workspace IS NULL)'];
    const parameters: Array<string | number> = [validated.workspace];
    if (validated.runId !== undefined) {
      conditions.push('rf.run_id = ?');
      parameters.push(validated.runId);
    }
    const rows = database.prepare(`
      SELECT
        rf.feedback_id, rf.run_id, rf.outcome, rf.recommendation_code, rf.recommendation_verdict,
        rf.rating, rf.comment, rf.actor, rf.idempotency_key, rf.created_at,
        lr.workspace AS run_workspace
      FROM run_feedback AS rf
      LEFT JOIN ledger_runs AS lr ON lr.run_id = rf.run_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rf.created_at ASC, rf.feedback_id ASC
      LIMIT ?
    `).all<RunFeedbackRow>(...parameters, validated.limit + 1);
    const records = rows.map((row) => rowToRunFeedback(row, validated.workspace));
    return { records: records.slice(0, validated.limit), truncated: records.length > validated.limit };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export function listContextFeedback(database: SqliteDatabase, input: unknown): FeedbackListPage<ContextFeedbackRecord> {
  const validated = validateContextFeedbackListInput(input);
  try {
    const conditions = ['(lr.workspace = ? OR lr.workspace IS NULL)'];
    const parameters: Array<string | number> = [validated.workspace];
    if (validated.runId !== undefined) {
      conditions.push('cf.run_id = ?');
      parameters.push(validated.runId);
    }
    if (validated.deliveryId !== undefined) {
      conditions.push('cf.delivery_id = ?');
      parameters.push(validated.deliveryId);
    }
    if (validated.entryId !== undefined) {
      conditions.push('cf.entry_id = ?');
      parameters.push(validated.entryId);
    }
    const rows = database.prepare(`
      SELECT
        cf.feedback_id, cf.delivery_id, cf.entry_id, cf.run_id, cf.verdict, cf.comment,
        cf.actor, cf.idempotency_key, cf.created_at,
        lr.workspace AS run_workspace,
        cd.run_id AS delivery_run_id,
        cd.delivery_id AS joined_delivery_id,
        cde.delivery_id AS linked_delivery_id,
        cde.entry_id AS linked_entry_id,
        cde.entry_revision AS entry_revision,
        e.workspace AS entry_workspace,
        er.workspace AS revision_workspace,
        cde.origin_scope AS origin_scope
      FROM context_feedback AS cf
      LEFT JOIN ledger_runs AS lr ON lr.run_id = cf.run_id
      LEFT JOIN context_deliveries AS cd ON cd.delivery_id = cf.delivery_id
      LEFT JOIN context_delivery_entries AS cde
        ON cde.delivery_id = cf.delivery_id AND cde.entry_id = cf.entry_id
      LEFT JOIN entries AS e ON e.id = cf.entry_id
      LEFT JOIN entry_revisions AS er
        ON er.entry_id = cde.entry_id AND er.revision = cde.entry_revision
      WHERE ${conditions.join(' AND ')}
      ORDER BY cf.created_at ASC, cf.feedback_id ASC
      LIMIT ?
    `).all<ContextFeedbackRow>(...parameters, validated.limit + 1);
    const records = rows.map((row) => rowToContextFeedback(row, validated.workspace));
    return { records: records.slice(0, validated.limit), truncated: records.length > validated.limit };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

export const INTAKE_FEEDBACK_VERDICTS = ['helpful', 'unnecessary', 'corrected'] as const;
export type IntakeFeedbackVerdict = (typeof INTAKE_FEEDBACK_VERDICTS)[number];

export interface IntakeFeedbackRecord {
  feedbackId: string;
  workspace: string;
  runId: string;
  sessionId: string;
  questionId: string | null;
  profileField: string | null;
  verdict: IntakeFeedbackVerdict;
  comment: string | null;
  actor: string;
  idempotencyKeyHash: string;
  createdAt: string;
}

const INTAKE_FEEDBACK_FIELDS = new Set([
  'workspace', 'feedbackId', 'runId', 'sessionId', 'questionId', 'profileField',
  'verdict', 'comment', 'actor', 'idempotencyKey', 'createdAt',
]);
const INTAKE_PROFILE_FIELDS = new Set(['taskType', 'target', 'expected', 'constraints']);

function initialInputIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FEEDBACK_IDENTIFIER_LENGTH || /\p{Cc}/u.test(value)) validation();
  return value;
}

function initialInputComment(value: unknown, workspace: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) validation();
  const sanitized = sanitizeJson(value, { workspace }).value;
  if (typeof sanitized !== 'string' || sanitized.length === 0 || Buffer.byteLength(sanitized, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) validation();
  return sanitized;
}

function validateInitialIntakeFeedbackInput(value: unknown): {
  feedbackId: string;
  workspace: string;
  runId: string;
  sessionId: string;
  questionId: string | null;
  profileField: string | null;
  verdict: IntakeFeedbackVerdict;
  comment: string | null;
  actor: string;
  idempotencyKeyHash: string;
  createdAt: string;
} {
  const fields = inputFields(value, INTAKE_FEEDBACK_FIELDS, true);
  const workspace = initialInputIdentifier(fields.workspace);
  const feedbackId = initialInputIdentifier(fields.feedbackId);
  const runId = initialInputIdentifier(fields.runId);
  const sessionId = initialInputIdentifier(fields.sessionId);
  const questionId = fields.questionId === null
    ? null
    : typeof fields.questionId === 'string' && INTAKE_PROFILE_FIELDS.has(fields.questionId)
      ? fields.questionId
      : validation();
  const profileField = fields.profileField === null
    ? null
    : typeof fields.profileField === 'string' && INTAKE_PROFILE_FIELDS.has(fields.profileField)
      ? fields.profileField
      : validation();
  if ((questionId === null) === (profileField === null)) validation();
  if (typeof fields.verdict !== 'string' || !INTAKE_FEEDBACK_VERDICTS.includes(fields.verdict as IntakeFeedbackVerdict)) validation();
  const actor = initialInputIdentifier(fields.actor);
  const idempotencyKey = initialInputIdentifier(fields.idempotencyKey);
  return {
    workspace,
    feedbackId,
    runId,
    sessionId,
    questionId,
    profileField,
    verdict: fields.verdict as IntakeFeedbackVerdict,
    comment: initialInputComment(fields.comment, workspace),
    actor,
    idempotencyKeyHash: hashIdempotencyKey(idempotencyKey),
    createdAt: validateFeedbackTimestamp(fields.createdAt),
  };
}

function initialIntakeTarget(database: SqliteDatabase, input: ReturnType<typeof validateInitialIntakeFeedbackInput>): void {
  const linked = database.prepare(`
    SELECT ri.run_id, ri.session_id
    FROM run_intakes AS ri
    JOIN ledger_runs AS lr ON lr.run_id = ri.run_id
    JOIN akinator_sessions AS s ON s.id = ri.session_id
    WHERE ri.run_id = ? AND ri.session_id = ?
      AND lr.workspace = ? AND s.workspace = ?
  `).get<{ run_id: string; session_id: string }>(input.runId, input.sessionId, input.workspace, input.workspace);
  if (!linked) notFound();
  if (input.questionId !== null) {
    const answer = database.prepare(`
      SELECT 1 AS present
      FROM akinator_answers
      WHERE session_id = ? AND question_id = ?
    `).get<{ present: number }>(input.sessionId, input.questionId);
    if (!answer) notFound();
  }
}

interface InitialIntakeFeedbackRow extends SqliteRow {
  feedback_id: unknown;
  run_id: unknown;
  session_id: unknown;
  question_id: unknown;
  profile_field: unknown;
  verdict: unknown;
  comment: unknown;
  actor: unknown;
  idempotency_key: unknown;
  created_at: unknown;
  run_workspace: unknown;
  session_workspace: unknown;
  linked_run_id: unknown;
  linked_session_id: unknown;
  question_answer_session_id: unknown;
}

function initialIntakeRecord(input: ReturnType<typeof validateInitialIntakeFeedbackInput>): IntakeFeedbackRecord {
  return {
    feedbackId: input.feedbackId,
    workspace: input.workspace,
    runId: input.runId,
    sessionId: input.sessionId,
    questionId: input.questionId,
    profileField: input.profileField,
    verdict: input.verdict,
    comment: input.comment,
    actor: input.actor,
    idempotencyKeyHash: input.idempotencyKeyHash,
    createdAt: input.createdAt,
  };
}

function initialIntakeBodyHash(input: IntakeFeedbackRecord): string {
  return canonicalContentHash({
    feedbackId: input.feedbackId,
    workspace: input.workspace,
    runId: input.runId,
    sessionId: input.sessionId,
    questionId: input.questionId,
    profileField: input.profileField,
    verdict: input.verdict,
    comment: input.comment,
    actor: input.actor,
    createdAt: input.createdAt,
  });
}

function selectInitialIntakeByKey(database: SqliteDatabase, input: ReturnType<typeof validateInitialIntakeFeedbackInput>): InitialIntakeFeedbackRow | undefined {
  return database.prepare(`
    SELECT
      ifb.feedback_id, ifb.run_id, ifb.session_id, ifb.question_id, ifb.profile_field,
      ifb.verdict, ifb.comment, ifb.actor, ifb.idempotency_key, ifb.created_at,
      lr.workspace AS run_workspace,
      s.workspace AS session_workspace,
      ri.run_id AS linked_run_id,
      ri.session_id AS linked_session_id,
      aa.session_id AS question_answer_session_id
    FROM intake_feedback AS ifb
    LEFT JOIN ledger_runs AS lr ON lr.run_id = ifb.run_id
    LEFT JOIN akinator_sessions AS s ON s.id = ifb.session_id
    LEFT JOIN run_intakes AS ri ON ri.run_id = ifb.run_id AND ri.session_id = ifb.session_id
    LEFT JOIN akinator_answers AS aa ON aa.session_id = ifb.session_id AND aa.question_id = ifb.question_id
    WHERE ifb.run_id = ? AND ifb.actor = ? AND ifb.idempotency_key = ?
  `).get<InitialIntakeFeedbackRow>(input.runId, input.actor, input.idempotencyKeyHash);
}

function hasInitialIntakeFeedbackId(database: SqliteDatabase, feedbackId: string): boolean {
  return Boolean(database.prepare('SELECT 1 AS present FROM intake_feedback WHERE feedback_id = ?').get<{ present: number }>(feedbackId));
}

function initialStoredIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FEEDBACK_IDENTIFIER_LENGTH || /\p{Cc}/u.test(value)) integrity();
  return value;
}

function initialStoredHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) integrity();
  return value;
}

function initialStoredComment(value: unknown, workspace: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FEEDBACK_COMMENT_BYTES) integrity();
  const sanitized = initialInputComment(value, workspace);
  if (sanitized !== value) integrity();
  return value;
}

function rowToInitialIntakeFeedback(row: InitialIntakeFeedbackRow, workspace: string): IntakeFeedbackRecord {
  const feedbackId = initialStoredIdentifier(row.feedback_id);
  const runId = initialStoredIdentifier(row.run_id);
  const sessionId = initialStoredIdentifier(row.session_id);
  const actor = initialStoredIdentifier(row.actor);
  const runWorkspace = initialStoredIdentifier(row.run_workspace);
  const sessionWorkspace = initialStoredIdentifier(row.session_workspace);
  const linkedRunId = initialStoredIdentifier(row.linked_run_id);
  const linkedSessionId = initialStoredIdentifier(row.linked_session_id);
  if (runWorkspace !== workspace || sessionWorkspace !== workspace || linkedRunId !== runId || linkedSessionId !== sessionId) integrity();

  const questionId = row.question_id === null
    ? null
    : typeof row.question_id === 'string' && INTAKE_PROFILE_FIELDS.has(row.question_id)
      ? row.question_id
      : integrity();
  const profileField = row.profile_field === null
    ? null
    : typeof row.profile_field === 'string' && INTAKE_PROFILE_FIELDS.has(row.profile_field)
      ? row.profile_field
      : integrity();
  if ((questionId === null) === (profileField === null)) integrity();
  if (questionId !== null && initialStoredIdentifier(row.question_answer_session_id) !== sessionId) integrity();
  if (typeof row.verdict !== 'string' || !INTAKE_FEEDBACK_VERDICTS.includes(row.verdict as IntakeFeedbackVerdict)) integrity();

  return {
    feedbackId,
    workspace,
    runId,
    sessionId,
    questionId,
    profileField,
    verdict: row.verdict as IntakeFeedbackVerdict,
    comment: initialStoredComment(row.comment, workspace),
    actor,
    idempotencyKeyHash: initialStoredHash(row.idempotency_key),
    createdAt: storedTimestamp(row.created_at),
  };
}

function recordInitialIntakeFeedback(database: SqliteDatabase, input: ReturnType<typeof validateInitialIntakeFeedbackInput>): IntakeFeedbackRecord {
  initialIntakeTarget(database, input);
  const existingByKey = selectInitialIntakeByKey(database, input);
  if (existingByKey) {
    const existing = rowToInitialIntakeFeedback(existingByKey, input.workspace);
    if (initialIntakeBodyHash(existing) === initialIntakeBodyHash(initialIntakeRecord(input))) return existing;
    conflict();
  }
  if (hasInitialIntakeFeedbackId(database, input.feedbackId)) conflict();
  database.prepare(`
    INSERT INTO intake_feedback (
      feedback_id, run_id, session_id, question_id, profile_field, verdict, comment, actor, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.feedbackId,
    input.runId,
    input.sessionId,
    input.questionId,
    input.profileField,
    input.verdict,
    input.comment,
    input.actor,
    input.idempotencyKeyHash,
    input.createdAt,
  );
  const row = selectInitialIntakeByKey(database, input);
  if (!row) integrity();
  return rowToInitialIntakeFeedback(row, input.workspace);
}

export function recordIntakeFeedback(database: SqliteDatabase, input: unknown): IntakeFeedbackRecord {
  const validated = validateInitialIntakeFeedbackInput(input);
  try {
    return withImmediateTransaction(database, () => recordInitialIntakeFeedback(database, validated));
  } catch (error) {
    normalizeDatabaseError(error, INTAKE_FEEDBACK_UNIQUENESS_FAILURES);
  }
}

export function recordIntakeFeedbackInTransaction(database: SqliteDatabase, input: unknown): IntakeFeedbackRecord {
  const validated = validateInitialIntakeFeedbackInput(input);
  try {
    return recordInitialIntakeFeedback(database, validated);
  } catch (error) {
    normalizeDatabaseError(error, INTAKE_FEEDBACK_UNIQUENESS_FAILURES);
  }
}

interface ValidatedInitialIntakeFeedbackListInput {
  workspace: string;
  runId?: string;
  sessionId?: string;
  questionId?: string;
  profileField?: string;
  limit: number;
}

const INTAKE_FEEDBACK_LIST_FIELDS = new Set(['workspace', 'runId', 'sessionId', 'questionId', 'profileField', 'limit']);

function validateInitialIntakeFeedbackListInput(value: unknown): ValidatedInitialIntakeFeedbackListInput {
  const fields = inputFields(value, INTAKE_FEEDBACK_LIST_FIELDS);
  const workspace = initialInputIdentifier(fields.workspace);
  const runId = fields.runId === undefined ? undefined : initialInputIdentifier(fields.runId);
  const sessionId = fields.sessionId === undefined ? undefined : initialInputIdentifier(fields.sessionId);
  const questionId = fields.questionId === undefined ? undefined : initialInputIdentifier(fields.questionId);
  const profileField = fields.profileField === undefined ? undefined : initialInputIdentifier(fields.profileField);
  if (questionId !== undefined && !INTAKE_PROFILE_FIELDS.has(questionId)) validation();
  if (profileField !== undefined && !INTAKE_PROFILE_FIELDS.has(profileField)) validation();
  if (questionId !== undefined && profileField !== undefined) validation();
  const limit = fields.limit === undefined ? 100 : fields.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) validation();
  return { workspace, ...(runId === undefined ? {} : { runId }), ...(sessionId === undefined ? {} : { sessionId }), ...(questionId === undefined ? {} : { questionId }), ...(profileField === undefined ? {} : { profileField }), limit };
}

function selectInitialIntakeRows(database: SqliteDatabase, input: ValidatedInitialIntakeFeedbackListInput): InitialIntakeFeedbackRow[] {
  const conditions = ['(lr.workspace = ? OR lr.workspace IS NULL)'];
  const parameters: Array<string | number> = [input.workspace];
  if (input.runId !== undefined) {
    conditions.push('ifb.run_id = ?');
    parameters.push(input.runId);
  }
  if (input.sessionId !== undefined) {
    conditions.push('ifb.session_id = ?');
    parameters.push(input.sessionId);
  }
  if (input.questionId !== undefined) {
    conditions.push('ifb.question_id = ?');
    parameters.push(input.questionId);
  }
  if (input.profileField !== undefined) {
    conditions.push('ifb.profile_field = ?');
    parameters.push(input.profileField);
  }
  return database.prepare(`
    SELECT
      ifb.feedback_id, ifb.run_id, ifb.session_id, ifb.question_id, ifb.profile_field,
      ifb.verdict, ifb.comment, ifb.actor, ifb.idempotency_key, ifb.created_at,
      lr.workspace AS run_workspace,
      s.workspace AS session_workspace,
      ri.run_id AS linked_run_id,
      ri.session_id AS linked_session_id,
      aa.session_id AS question_answer_session_id
    FROM intake_feedback AS ifb
    LEFT JOIN ledger_runs AS lr ON lr.run_id = ifb.run_id
    LEFT JOIN akinator_sessions AS s ON s.id = ifb.session_id
    LEFT JOIN run_intakes AS ri ON ri.run_id = ifb.run_id AND ri.session_id = ifb.session_id
    LEFT JOIN akinator_answers AS aa ON aa.session_id = ifb.session_id AND aa.question_id = ifb.question_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ifb.created_at ASC, ifb.feedback_id ASC
    LIMIT ?
  `).all<InitialIntakeFeedbackRow>(...parameters, input.limit + 1);
}

export function listIntakeFeedback(database: SqliteDatabase, input: unknown): FeedbackListPage<IntakeFeedbackRecord> {
  const validated = validateInitialIntakeFeedbackListInput(input);
  try {
    const rows = selectInitialIntakeRows(database, validated);
    const records = rows.map((row) => rowToInitialIntakeFeedback(row, validated.workspace));
    return { records: records.slice(0, validated.limit), truncated: records.length > validated.limit };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}
