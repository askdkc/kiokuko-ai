import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError, type ErrorCode } from '../errors.js';
import { canonicalJson } from '../serialization/validate.js';
import { parseStrictJson } from '../setup/strict-json.js';
import { SkillProviderError } from '../skills/providers/schema.js';
import { SkillSourceError, type SkillSourceFailureCode } from '../skills/source/errors.js';
import type { SkillCandidate, SkillDiscoveryMode, SkillDiscoverySummary, SkillProviderFailureCode } from '../skills/types.js';
import { ENNO_MAX_EXTERNAL_SKILLS, ENNO_MAX_TOTAL_SKILL_QUERIES } from '../enno-oduno/types.js';

const HASH = /^[0-9a-f]{64}$/u;
const INVALID_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u;
const MAX_SUMMARY_JSON_CHARS = 256 * 1024;
const MAX_FAILURE_JSON_CHARS = 4 * 1024;
const SUMMARY_FIELDS = new Set(['attempted', 'mode', 'requirements', 'queries', 'cacheHits', 'candidates', 'selected', 'failures']);
const SELECTED_FIELDS = new Set(['skillId', 'name', 'source', 'officialStatus', 'imported', 'updated']);
const SUMMARY_FAILURE_FIELDS = new Set(['stage', 'code']);
const KIOKUKO_FAILURE_FIELDS = new Set(['kind', 'code']);
const PROVIDER_FAILURE_FIELDS = new Set(['kind', 'code', 'retryAfterSeconds']);
const SOURCE_FAILURE_FIELDS = new Set(['kind', 'code', 'retryAfterSeconds']);
const ERROR_CODES: readonly ErrorCode[] = [
  'USAGE_ERROR',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'DATABASE_ERROR',
  'BACKPRESSURE',
  'SERVICE_UNAVAILABLE',
  'SECURITY_REJECTION',
  'AUTHENTICATION_ERROR',
  'INTEGRITY_ERROR',
  'PARTIAL_FAILURE',
  'NOT_IMPLEMENTED',
];
const PROVIDER_FAILURE_CODES: readonly SkillProviderFailureCode[] = [
  'registry_authentication_failed',
  'registry_unavailable',
  'registry_rate_limited',
  'registry_invalid_response',
];
const SOURCE_FAILURE_CODES: readonly SkillSourceFailureCode[] = [
  'source_missing',
  'source_rate_limited',
  'source_unavailable',
  'candidate_not_found_at_source',
  'source_tree_truncated',
  'skill_disabled_for_model_invocation',
  'skill_secret_detected',
  'skill_too_large',
  'skill_validation_failed',
  'skill_blocked',
];
const DISCOVERY_MODES: readonly SkillDiscoveryMode[] = ['off', 'official', 'community'];
const OFFICIAL_STATUSES: readonly SkillCandidate['officialStatus'][] = [
  'curated',
  'catalog-verified',
  'owner-verified',
  'registry-only',
  'unknown',
];
const SUMMARY_FAILURE_STAGES: readonly SkillDiscoverySummary['failures'][number]['stage'][] = [
  'search',
  'source',
  'validation',
  'persistence',
];

interface StoredAttemptRow {
  [key: string]: unknown;
  run_id: unknown;
  phase: unknown;
  request_digest: unknown;
  reserved_query_count: unknown;
  reserved_selection_count: unknown;
  consumed_query_count: unknown;
  consumed_selection_count: unknown;
  state: unknown;
  summary_json: unknown;
  failure_json: unknown;
  started_at: unknown;
  finished_at: unknown;
}

type StoredDiscoveryFailure =
  | { kind: 'kiokuko'; code: ErrorCode }
  | { kind: 'skill_provider'; code: SkillProviderFailureCode; retryAfterSeconds: number | null }
  | { kind: 'skill_source'; code: SkillSourceFailureCode; retryAfterSeconds: number | null };

export interface TaskSkillDiscoveryAttemptIdentity {
  runId: string;
  phase: 'intake' | 'zenki';
  requestDigest: string;
  mode: SkillDiscoveryMode;
}

export type TaskSkillDiscoveryAttemptClaim =
  | { kind: 'execute'; queryBudget: number; selectionBudget: number }
  | { kind: 'replay'; summary: SkillDiscoverySummary };

function integrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Stored task Skill discovery attempt is invalid');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value: unknown, fields: ReadonlySet<string>): value is Record<string, unknown> {
  return plainObject(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !INVALID_TEXT.test(value);
}

function boundedTextArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => boundedText(item, maxLength))
    && new Set(value).size === value.length;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function retryAfterSeconds(value: unknown): value is number | null {
  return value === null || nonNegativeSafeInteger(value);
}

function parseCanonicalStoredJson(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) integrity();
  let parsed: unknown;
  try {
    parsed = parseStrictJson(
      value,
      { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
      'Stored task Skill discovery JSON is invalid',
    );
    if (canonicalJson(parsed) !== value) integrity();
  } catch (error) {
    if (error instanceof RangeError
      || (error instanceof KiokukoError && (error.code === 'VALIDATION_ERROR' || error.code === 'INTEGRITY_ERROR'))) {
      integrity();
    }
    throw error;
  }
  return parsed;
}

function validateSummary(value: unknown, mode: SkillDiscoveryMode): SkillDiscoverySummary {
  if (!exactObject(value, SUMMARY_FIELDS)
    || typeof value.attempted !== 'boolean'
    || typeof value.mode !== 'string'
    || !DISCOVERY_MODES.includes(value.mode as SkillDiscoveryMode)
    || value.mode !== mode
    || !boundedTextArray(value.requirements, 64, 300)
    || !boundedTextArray(value.queries, 64, 500)
    || !nonNegativeSafeInteger(value.cacheHits)
    || !nonNegativeSafeInteger(value.candidates)
    || !Array.isArray(value.selected)
    || value.selected.length > 2
    || !Array.isArray(value.failures)
    || value.failures.length > 128
    || (value.attempted ? value.queries.length === 0 : value.queries.length !== 0)) {
    integrity();
  }
  const selected = value.selected.map((item) => {
    if (!exactObject(item, SELECTED_FIELDS)
      || !boundedText(item.skillId, 1_000)
      || !boundedText(item.name, 500)
      || !boundedText(item.source, 201)
      || typeof item.officialStatus !== 'string'
      || !OFFICIAL_STATUSES.includes(item.officialStatus as SkillCandidate['officialStatus'])
      || typeof item.imported !== 'boolean'
      || typeof item.updated !== 'boolean') {
      integrity();
    }
    return {
      skillId: item.skillId,
      name: item.name,
      source: item.source,
      officialStatus: item.officialStatus as SkillCandidate['officialStatus'],
      imported: item.imported,
      updated: item.updated,
    };
  });
  if (new Set(selected.map((item) => item.skillId)).size !== selected.length) integrity();
  const failures = value.failures.map((item) => {
    if (!exactObject(item, SUMMARY_FAILURE_FIELDS)
      || typeof item.stage !== 'string'
      || !SUMMARY_FAILURE_STAGES.includes(item.stage as SkillDiscoverySummary['failures'][number]['stage'])
      || !boundedText(item.code, 200)
      || !/^[a-z0-9_]+$/u.test(item.code)) {
      integrity();
    }
    return {
      stage: item.stage as SkillDiscoverySummary['failures'][number]['stage'],
      code: item.code,
    };
  });
  return {
    attempted: value.attempted,
    mode: value.mode as SkillDiscoveryMode,
    requirements: [...value.requirements],
    queries: [...value.queries],
    cacheHits: value.cacheHits,
    candidates: value.candidates,
    selected,
    failures,
  };
}

function validateFailure(value: unknown): StoredDiscoveryFailure {
  if (!plainObject(value) || typeof value.kind !== 'string') integrity();
  if (value.kind === 'kiokuko') {
    if (!exactObject(value, KIOKUKO_FAILURE_FIELDS)
      || typeof value.code !== 'string'
      || !ERROR_CODES.includes(value.code as ErrorCode)) {
      integrity();
    }
    return { kind: value.kind, code: value.code as ErrorCode };
  }
  if (value.kind === 'skill_provider') {
    if (!exactObject(value, PROVIDER_FAILURE_FIELDS)
      || typeof value.code !== 'string'
      || !PROVIDER_FAILURE_CODES.includes(value.code as SkillProviderFailureCode)
      || !retryAfterSeconds(value.retryAfterSeconds)) {
      integrity();
    }
    return { kind: value.kind, code: value.code as SkillProviderFailureCode, retryAfterSeconds: value.retryAfterSeconds };
  }
  if (value.kind === 'skill_source') {
    if (!exactObject(value, SOURCE_FAILURE_FIELDS)
      || typeof value.code !== 'string'
      || !SOURCE_FAILURE_CODES.includes(value.code as SkillSourceFailureCode)
      || !retryAfterSeconds(value.retryAfterSeconds)) {
      integrity();
    }
    return { kind: value.kind, code: value.code as SkillSourceFailureCode, retryAfterSeconds: value.retryAfterSeconds };
  }
  return integrity();
}

function attemptRow(database: SqliteDatabase, identity: TaskSkillDiscoveryAttemptIdentity): StoredAttemptRow | undefined {
  return database.prepare(`
    SELECT run_id, phase, request_digest,
           reserved_query_count, reserved_selection_count,
           consumed_query_count, consumed_selection_count,
           state, summary_json, failure_json, started_at, finished_at
    FROM task_skill_discovery_attempts
    WHERE run_id = ? AND phase = ? AND request_digest = ?
  `).get<StoredAttemptRow>(identity.runId, identity.phase, identity.requestDigest);
}

function allAttemptRows(database: SqliteDatabase, runId: string): StoredAttemptRow[] {
  return database.prepare(`
    SELECT run_id, phase, request_digest,
           reserved_query_count, reserved_selection_count,
           consumed_query_count, consumed_selection_count,
           state, summary_json, failure_json, started_at, finished_at
    FROM task_skill_discovery_attempts
    WHERE run_id = ?
  `).all<StoredAttemptRow>(runId);
}

function activeAttemptRow(database: SqliteDatabase, runId: string, phase: TaskSkillDiscoveryAttemptIdentity['phase']): StoredAttemptRow | undefined {
  return database.prepare(`
    SELECT run_id, phase, request_digest,
           reserved_query_count, reserved_selection_count,
           consumed_query_count, consumed_selection_count,
           state, summary_json, failure_json, started_at, finished_at
    FROM task_skill_discovery_attempts
    WHERE run_id = ? AND phase = ? AND state = 'started'
    LIMIT 1
  `).get<StoredAttemptRow>(runId, phase);
}

function boundedBudget(value: unknown, maximum: number): value is number {
  return nonNegativeSafeInteger(value) && value <= maximum;
}

function validateAttemptRow(row: StoredAttemptRow, identity?: TaskSkillDiscoveryAttemptIdentity): void {
  if (typeof row.run_id !== 'string'
    || typeof row.phase !== 'string'
    || !['intake', 'zenki'].includes(row.phase)
    || typeof row.request_digest !== 'string'
    || !HASH.test(row.request_digest)
    || !boundedBudget(row.reserved_query_count, ENNO_MAX_TOTAL_SKILL_QUERIES)
    || !boundedBudget(row.reserved_selection_count, ENNO_MAX_EXTERNAL_SKILLS)
    || !boundedBudget(row.consumed_query_count, row.reserved_query_count as number)
    || !boundedBudget(row.consumed_selection_count, row.reserved_selection_count as number)
    || !canonicalTimestamp(row.started_at)
    || !['started', 'completed', 'failed'].includes(String(row.state))) {
    integrity();
  }
  if (identity !== undefined && (row.run_id !== identity.runId
    || row.phase !== identity.phase
    || row.request_digest !== identity.requestDigest)) integrity();
  if (row.state === 'started') {
    if (row.consumed_query_count !== 0 || row.consumed_selection_count !== 0
      || row.summary_json !== null || row.failure_json !== null || row.finished_at !== null) integrity();
    return;
  }
  if (!canonicalTimestamp(row.finished_at) || row.finished_at < row.started_at) integrity();
  if (row.state === 'completed') {
    if (typeof row.summary_json !== 'string' || row.failure_json !== null) integrity();
    return;
  }
  if (row.summary_json !== null || typeof row.failure_json !== 'string') integrity();
}

function throwStoredFailure(failure: StoredDiscoveryFailure): never {
  if (failure.kind === 'skill_provider') {
    throw new SkillProviderError(failure.code, failure.retryAfterSeconds);
  }
  if (failure.kind === 'skill_source') {
    throw new SkillSourceError(failure.code, failure.retryAfterSeconds);
  }
  throw new KiokukoError(failure.code, 'External Skill discovery failed closed');
}

function normalizedFailure(error: unknown): { failure: StoredDiscoveryFailure; error: Error } {
  if (error instanceof SkillProviderError) {
    const failure: StoredDiscoveryFailure = {
      kind: 'skill_provider',
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
    };
    validateFailure(failure);
    return { failure, error };
  }
  if (error instanceof SkillSourceError) {
    const failure: StoredDiscoveryFailure = {
      kind: 'skill_source',
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
    };
    validateFailure(failure);
    return { failure, error };
  }
  if (error instanceof KiokukoError) {
    const failure: StoredDiscoveryFailure = { kind: 'kiokuko', code: error.code };
    validateFailure(failure);
    const normalized = new KiokukoError(error.code, 'External Skill discovery failed closed');
    Object.defineProperty(normalized, 'cause', { value: error });
    return { failure, error: normalized };
  }
  const normalized = new KiokukoError('INTEGRITY_ERROR', 'External Skill discovery failed unexpectedly');
  Object.defineProperty(normalized, 'cause', { value: error });
  return {
    failure: { kind: 'kiokuko', code: normalized.code },
    error: normalized,
  };
}

function resolveExistingAttempt(
  existing: StoredAttemptRow,
  identity: TaskSkillDiscoveryAttemptIdentity,
): Extract<TaskSkillDiscoveryAttemptClaim, { kind: 'replay' }> {
  validateAttemptRow(existing, identity);
  if (existing.state === 'started') {
    throw new KiokukoError('CONFLICT', 'Task Skill discovery is already in progress or did not complete');
  }
  if (existing.state === 'completed') {
    return {
      kind: 'replay',
      summary: validateSummary(parseCanonicalStoredJson(existing.summary_json, MAX_SUMMARY_JSON_CHARS), identity.mode),
    };
  }
  throwStoredFailure(validateFailure(parseCanonicalStoredJson(existing.failure_json, MAX_FAILURE_JSON_CHARS)));
}

export function readTaskSkillDiscoveryAttempt(
  database: SqliteDatabase,
  identity: TaskSkillDiscoveryAttemptIdentity,
): Extract<TaskSkillDiscoveryAttemptClaim, { kind: 'replay' }> | undefined {
  const existing = attemptRow(database, identity);
  return existing === undefined ? undefined : resolveExistingAttempt(existing, identity);
}

function usedDiscoveryBudget(database: SqliteDatabase, runId: string): {
  queryBudget: number;
  selectionBudget: number;
} {
  let queryBudget = 0;
  let selectionBudget = 0;
  for (const row of allAttemptRows(database, runId)) {
    validateAttemptRow(row);
    const active = row.state === 'started';
    queryBudget += active ? row.reserved_query_count as number : row.consumed_query_count as number;
    selectionBudget += active ? row.reserved_selection_count as number : row.consumed_selection_count as number;
  }
  if (queryBudget > ENNO_MAX_TOTAL_SKILL_QUERIES || selectionBudget > ENNO_MAX_EXTERNAL_SKILLS) integrity();
  return { queryBudget, selectionBudget };
}

export function claimTaskSkillDiscoveryAttempt(
  database: SqliteDatabase,
  identity: TaskSkillDiscoveryAttemptIdentity,
  requestedBudget: {
    queryBudget: number;
    selectionBudget: number;
  } = {
    queryBudget: ENNO_MAX_TOTAL_SKILL_QUERIES,
    selectionBudget: ENNO_MAX_EXTERNAL_SKILLS,
  },
): TaskSkillDiscoveryAttemptClaim {
  if (!boundedText(identity.runId, 256)
    || !HASH.test(identity.requestDigest)
    || (identity.phase !== 'intake' && identity.phase !== 'zenki')
    || !DISCOVERY_MODES.includes(identity.mode)
    || !boundedBudget(requestedBudget.queryBudget, ENNO_MAX_TOTAL_SKILL_QUERIES)
    || !boundedBudget(requestedBudget.selectionBudget, ENNO_MAX_EXTERNAL_SKILLS)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Task Skill discovery attempt identity is invalid');
  }
  return withImmediateTransaction(database, () => {
    const existing = attemptRow(database, identity);
    if (existing === undefined) {
      const active = activeAttemptRow(database, identity.runId, identity.phase);
      if (active !== undefined) {
        validateAttemptRow(active);
        throw new KiokukoError('CONFLICT', 'Task Skill discovery is already in progress or did not complete');
      }
      const used = usedDiscoveryBudget(database, identity.runId);
      const queryBudget = Math.min(requestedBudget.queryBudget, ENNO_MAX_TOTAL_SKILL_QUERIES - used.queryBudget);
      const selectionBudget = Math.min(requestedBudget.selectionBudget, ENNO_MAX_EXTERNAL_SKILLS - used.selectionBudget);
      const grantedQueryBudget = queryBudget === 0 || selectionBudget === 0 ? 0 : queryBudget;
      const grantedSelectionBudget = queryBudget === 0 || selectionBudget === 0 ? 0 : selectionBudget;
      database.prepare(`
        INSERT INTO task_skill_discovery_attempts (
          run_id, phase, request_digest,
          reserved_query_count, reserved_selection_count,
          consumed_query_count, consumed_selection_count,
          state, summary_json, failure_json, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 'started', NULL, NULL, ?, NULL)
      `).run(identity.runId, identity.phase, identity.requestDigest, grantedQueryBudget, grantedSelectionBudget, new Date().toISOString());
      const inserted = attemptRow(database, identity);
      if (inserted === undefined) integrity();
      validateAttemptRow(inserted, identity);
      return { kind: 'execute', queryBudget: grantedQueryBudget, selectionBudget: grantedSelectionBudget };
    }
    return resolveExistingAttempt(existing, identity);
  });
}

export function completeTaskSkillDiscoveryAttempt(
  database: SqliteDatabase,
  identity: TaskSkillDiscoveryAttemptIdentity,
  summary: SkillDiscoverySummary,
  assertBeforeComplete?: () => void,
): SkillDiscoverySummary {
  const validated = validateSummary(summary, identity.mode);
  const serialized = canonicalJson(validated);
  if (serialized.length > MAX_SUMMARY_JSON_CHARS) integrity();
  return withImmediateTransaction(database, () => {
    const existing = attemptRow(database, identity);
    if (existing === undefined) integrity();
    validateAttemptRow(existing, identity);
    if (existing.state !== 'started') integrity();
    const reservedQueries = existing.reserved_query_count as number;
    const reservedSelections = existing.reserved_selection_count as number;
    if (validated.queries.length > reservedQueries
      || validated.selected.length > reservedSelections) {
      integrity();
    }
    assertBeforeComplete?.();
    const finishedAt = new Date().toISOString();
    const updated = database.prepare(`
      UPDATE task_skill_discovery_attempts
      SET state = 'completed', summary_json = ?, consumed_query_count = ?, consumed_selection_count = ?, finished_at = ?
      WHERE run_id = ? AND phase = ? AND request_digest = ? AND state = 'started'
      RETURNING state, summary_json
    `).get<{ state: unknown; summary_json: unknown }>(serialized, validated.queries.length, validated.selected.length, finishedAt, identity.runId, identity.phase, identity.requestDigest);
    if (updated?.state !== 'completed' || updated.summary_json !== serialized) integrity();
    const completed = attemptRow(database, identity);
    if (completed === undefined) integrity();
    validateAttemptRow(completed, identity);
    if (completed.state !== 'completed' || completed.summary_json !== serialized) integrity();
    return validateSummary(parseCanonicalStoredJson(completed.summary_json, MAX_SUMMARY_JSON_CHARS), identity.mode);
  });
}

export function failTaskSkillDiscoveryAttempt(
  database: SqliteDatabase,
  identity: TaskSkillDiscoveryAttemptIdentity,
  cause: unknown,
): never {
  const normalized = normalizedFailure(cause);
  const serialized = canonicalJson(normalized.failure);
  try {
    withImmediateTransaction(database, () => {
      const existing = attemptRow(database, identity);
      if (existing === undefined) integrity();
      validateAttemptRow(existing, identity);
      if (existing.state !== 'started') integrity();
      const updated = database.prepare(`
        UPDATE task_skill_discovery_attempts
        SET state = 'failed', failure_json = ?,
            consumed_query_count = reserved_query_count,
            consumed_selection_count = reserved_selection_count,
            finished_at = ?
        WHERE run_id = ? AND phase = ? AND request_digest = ? AND state = 'started'
        RETURNING state, failure_json
      `).get<{ state: unknown; failure_json: unknown }>(serialized, new Date().toISOString(), identity.runId, identity.phase, identity.requestDigest);
      if (updated?.state !== 'failed' || updated.failure_json !== serialized) integrity();
      const failed = attemptRow(database, identity);
      if (failed === undefined) integrity();
      validateAttemptRow(failed, identity);
      if (failed.state !== 'failed' || failed.failure_json !== serialized) integrity();
    });
  } catch (persistenceError) {
    throw new AggregateError(
      [normalized.error, persistenceError],
      'Task Skill discovery failed and its terminal attempt state could not be persisted',
    );
  }
  throw normalized.error;
}
