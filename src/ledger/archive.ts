import { createHash } from 'node:crypto';

import type { SqliteDatabase, SqliteValue } from '../db/adapter.js';
import { isSqliteCorruptionError, isSqliteUniqueConstraintError } from '../db/sqlite-retry.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { findSecret } from '../memory/secrets.js';
import { canonicalJson, compareCanonicalStrings, requireWorkspace } from '../serialization/validate.js';
import { hashLedgerEvent, GENESIS_HASH } from './hash.js';
import { entryOriginMatchesWorkspace, isContextEntryOrigin } from '../context/origin.js';
import { DEFAULT_NUDGE_RATE_LIMIT, NUDGE_CODES, NUDGE_POLICY_VERSION, NUDGE_PRIORITY } from '../context/nudges.js';
import { parseStoredNudgeDelivery, validateStoredNudgeHistory } from '../context/nudge-validation.js';
import {
  CAPTURE_PROFILES,
  COVERAGE_LEVELS,
  LEDGER_EVENT_TYPES,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type JsonValue,
  type Redaction,
} from './types.js';

export const LEDGER_ARCHIVE_FORMAT = 'kiokuko-ledger-jsonl' as const;
export const LEDGER_ARCHIVE_API_VERSION = '1' as const;
export const LEDGER_ARCHIVE_VERSION = 1 as const;

export const MAX_ARCHIVE_LINE_COUNT = 10_000;
export const MAX_ARCHIVE_LINE_BYTES = 512 * 1024;
export const MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024;

const COMMENT_MAX_BYTES = 4 * 1024;
const IDENTIFIER_MAX_LENGTH = 256;
const TEXT_MAX_LENGTH = 16 * 1024;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_FIELDS = new Set(['taskType', 'target', 'expected', 'constraints']);
const PROFILE_SOURCES = new Set(['inferred', 'client_supplied', 'user_answer']);
const TASK_TYPES = new Set(['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis']);
const REDACTION_KINDS = new Set([
  'sensitive_key', 'secret_pattern', 'url', 'home_path', 'preview_truncated', 'environment_value', 'hidden_reasoning',
]);
const CONTEXT_FEEDBACK_VERDICTS = new Set(['helpful', 'irrelevant', 'stale', 'conflicting']);
const RECOMMENDATION_VERDICTS = new Set(['accepted', 'dismissed', 'resolved']);
const EVIDENCE_KINDS = new Set(['command', 'test', 'file', 'diff', 'url', 'artifact']);
const PURGE_TARGET_TYPES = new Set(['run', 'event', 'evidence', 'delivery', 'feedback', 'memory_link']);

export interface LedgerArchiveCounts {
  runs: number;
  sessions: number;
  answers: number;
  runIntakes: number;
  intakeFeedback: number;
  events: number;
  evidence: number;
  deliveries: number;
  deliveryEntries: number;
  nudgeDeliveries: number;
  contextFeedback: number;
  runFeedback: number;
  memoryLinks: number;
  purgeAudit: number;
}

export interface ExportLedgerArchiveOptions {
  workspace: string;
}

export interface LedgerArchiveExport {
  workspace: string;
  counts: LedgerArchiveCounts;
  checksum: string;
  content: string;
}

export interface ImportLedgerArchiveOptions {
  content: string;
  workspace?: string;
  dryRun?: boolean;
}

export interface LedgerArchiveImportResult {
  workspace: string;
  dryRun: boolean;
  counts: LedgerArchiveCounts;
  imported: LedgerArchiveCounts;
  duplicates: LedgerArchiveCounts;
  conflicts: number;
}

type ArchiveRecordType = keyof LedgerArchiveCounts;
type ArchiveRecord = Record<string, unknown> & { type: string };
type Row = Record<string, unknown>;

const EMPTY_COUNTS: LedgerArchiveCounts = {
  runs: 0,
  sessions: 0,
  answers: 0,
  runIntakes: 0,
  intakeFeedback: 0,
  events: 0,
  evidence: 0,
  deliveries: 0,
  deliveryEntries: 0,
  nudgeDeliveries: 0,
  contextFeedback: 0,
  runFeedback: 0,
  memoryLinks: 0,
  purgeAudit: 0,
};

const RECORD_FIELDS: Record<ArchiveRecordType | 'manifest' | 'checksum', readonly string[]> = {
  checksum: ['type', 'sha256'],
  manifest: ['type', 'apiVersion', 'archiveVersion', 'format', 'workspace', 'counts'],
  runs: [
    'type', 'run_id', 'workspace', 'client_kind', 'client_version', 'source_session_id', 'parent_run_id',
    'protocol_version', 'capture_profile', 'coverage_json', 'status', 'title', 'task_hash', 'metadata_json',
    'last_sequence', 'last_source_sequence', 'started_at', 'ended_at', 'created_at', 'updated_at',
  ],
  sessions: ['type', 'id', 'workspace', 'task_text', 'profile_json', 'status', 'question_count', 'created_at', 'updated_at'],
  answers: ['type', 'session_id', 'question_id', 'answer_json', 'created_at'],
  runIntakes: [
    'type', 'run_id', 'session_id', 'policy_version', 'profile_schema_version', 'profile_sources_json',
    'initial_profile_hash', 'recommended_tags_json', 'linked_at', 'finalized_at',
  ],
  intakeFeedback: [
    'type', 'feedback_id', 'run_id', 'session_id', 'question_id', 'profile_field', 'verdict', 'comment',
    'actor', 'idempotency_key', 'created_at',
  ],
  events: [
    'type', 'event_id', 'run_id', 'sequence', 'source_event_id', 'source_sequence', 'event_type', 'source_type',
    'actor', 'outcome', 'occurred_at', 'ingested_at', 'payload_json', 'redaction_json', 'previous_hash', 'event_hash',
  ],
  evidence: [
    'type', 'evidence_id', 'run_id', 'event_id', 'kind', 'locator', 'digest_algorithm', 'digest', 'byte_size', 'summary', 'created_at',
  ],
  deliveries: [
    'type', 'delivery_id', 'run_id', 'through_sequence', 'intake_session_id', 'task_profile_hash', 'query_hash',
    'policy_version', 'score_schema_version', 'char_budget', 'char_count', 'truncated', 'created_at',
  ],
  deliveryEntries: ['type', 'delivery_id', 'entry_id', 'entry_revision', 'rank', 'score_components_json', 'selection_reason_json', 'origin_scope'],
  nudgeDeliveries: [
    'type', 'id', 'run_id', 'policy_version', 'code', 'occurrence_id', 'checkpoint_id',
    'through_sequence', 'priority', 'evidence_event_ids_json', 'reference_ids_json', 'delivered_at',
  ],
  contextFeedback: ['type', 'feedback_id', 'delivery_id', 'entry_id', 'run_id', 'verdict', 'comment', 'actor', 'idempotency_key', 'created_at'],
  runFeedback: [
    'type', 'feedback_id', 'run_id', 'outcome', 'recommendation_code', 'recommendation_verdict', 'rating', 'comment',
    'actor', 'idempotency_key', 'created_at',
  ],
  memoryLinks: ['type', 'link_id', 'run_id', 'event_id', 'delivery_id', 'entry_id', 'created_at'],
  purgeAudit: [
    'type', 'purge_id', 'run_id', 'event_id', 'delivery_id', 'entry_id', 'target_type', 'target_id', 'actor', 'reason', 'created_at',
  ],
};

const TABLE_FIELDS: Record<ArchiveRecordType, readonly string[]> = {
  runs: RECORD_FIELDS.runs.slice(1),
  sessions: RECORD_FIELDS.sessions.slice(1),
  answers: RECORD_FIELDS.answers.slice(1),
  runIntakes: RECORD_FIELDS.runIntakes.slice(1),
  intakeFeedback: RECORD_FIELDS.intakeFeedback.slice(1),
  events: RECORD_FIELDS.events.slice(1),
  evidence: RECORD_FIELDS.evidence.slice(1),
  deliveries: RECORD_FIELDS.deliveries.slice(1),
  deliveryEntries: RECORD_FIELDS.deliveryEntries.slice(1),
  nudgeDeliveries: RECORD_FIELDS.nudgeDeliveries.slice(1),
  contextFeedback: RECORD_FIELDS.contextFeedback.slice(1),
  runFeedback: RECORD_FIELDS.runFeedback.slice(1),
  memoryLinks: RECORD_FIELDS.memoryLinks.slice(1),
  purgeAudit: RECORD_FIELDS.purgeAudit.slice(1),
};

const TABLE_NAMES: Record<ArchiveRecordType, string> = {
  runs: 'ledger_runs',
  sessions: 'akinator_sessions',
  answers: 'akinator_answers',
  runIntakes: 'run_intakes',
  intakeFeedback: 'intake_feedback',
  events: 'ledger_events',
  evidence: 'ledger_evidence',
  deliveries: 'context_deliveries',
  deliveryEntries: 'context_delivery_entries',
  nudgeDeliveries: 'nudge_deliveries',
  contextFeedback: 'context_feedback',
  runFeedback: 'run_feedback',
  memoryLinks: 'ledger_memory_links',
  purgeAudit: 'ledger_purge_audit',
};

const UNIQUE_CONSTRAINT_TARGETS: Record<ArchiveRecordType, readonly string[]> = {
  runs: ['ledger_runs.run_id'],
  sessions: ['akinator_sessions.id'],
  answers: ['akinator_answers.session_id, akinator_answers.question_id'],
  runIntakes: ['run_intakes.run_id', 'run_intakes.session_id'],
  intakeFeedback: ['intake_feedback.feedback_id', 'intake_feedback.run_id, intake_feedback.actor, intake_feedback.idempotency_key'],
  events: ['ledger_events.event_id', 'ledger_events.run_id, ledger_events.sequence', 'ledger_events.run_id, ledger_events.source_event_id'],
  evidence: ['ledger_evidence.evidence_id'],
  deliveries: ['context_deliveries.delivery_id'],
  deliveryEntries: ['context_delivery_entries.delivery_id, context_delivery_entries.entry_id'],
  nudgeDeliveries: [
    'nudge_deliveries.id',
    'nudge_deliveries.run_id, nudge_deliveries.policy_version, nudge_deliveries.occurrence_id',
    'nudge_deliveries.run_id, nudge_deliveries.policy_version, nudge_deliveries.checkpoint_id',
  ],
  contextFeedback: ['context_feedback.feedback_id', 'context_feedback.run_id, context_feedback.actor, context_feedback.idempotency_key'],
  runFeedback: ['run_feedback.feedback_id', 'run_feedback.run_id, run_feedback.actor, run_feedback.idempotency_key'],
  memoryLinks: ['ledger_memory_links.link_id'],
  purgeAudit: ['ledger_purge_audit.purge_id'],
};

const RECORD_NAMES: Record<ArchiveRecordType, string> = {
  runs: 'run',
  sessions: 'session',
  answers: 'answer',
  runIntakes: 'run_intake',
  intakeFeedback: 'intake_feedback',
  events: 'event',
  evidence: 'evidence',
  deliveries: 'delivery',
  deliveryEntries: 'delivery_entry',
  nudgeDeliveries: 'nudge_delivery',
  contextFeedback: 'context_feedback',
  runFeedback: 'run_feedback',
  memoryLinks: 'memory_link',
  purgeAudit: 'purge_audit',
};

const RECORD_TYPES = new Map(Object.entries(RECORD_NAMES).map(([key, value]) => [value, key as ArchiveRecordType]));

function fail(code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'SECURITY_REJECTION' | 'INTEGRITY_ERROR' | 'DATABASE_ERROR', message: string, details: Record<string, unknown> = {}): never {
  throw new KiokukoError(code, message, details);
}

function validation(): never {
  return fail('VALIDATION_ERROR', 'Ledger archive validation failed');
}

function integrity(): never {
  return fail('INTEGRITY_ERROR', 'Ledger archive integrity validation failed');
}

function conflict(): never {
  return fail('CONFLICT', 'Ledger archive conflicts with existing data');
}

function notFound(): never {
  return fail('NOT_FOUND', 'Ledger archive reference was not found');
}

function databaseFailure(): never {
  return fail('DATABASE_ERROR', 'Ledger archive database operation failed');
}

function canonicalIntegrityFailure(error: unknown): never {
  if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') integrity();
  throw error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!isObject(value)) validation();
}

function assertFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  if (Object.keys(value).length !== fields.length || Object.keys(value).some((field) => !allowed.has(field))) validation();
}

function stringValue(value: unknown, nonEmpty = true, maximum = TEXT_MAX_LENGTH): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0) || value.length > maximum || value.includes('\u0000')) validation();
  return value;
}

function nullableString(value: unknown, maximum = TEXT_MAX_LENGTH): string | null {
  if (value === null) return null;
  return stringValue(value, true, maximum);
}

function integerValue(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) validation();
  return value;
}

function nullableInteger(value: unknown, minimum = 0): number | null {
  if (value === null) return null;
  return integerValue(value, minimum);
}

function timestampValue(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) validation();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) validation();
  return value;
}

function hashValue(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) validation();
  return value;
}

function enumValue(value: unknown, allowed: Set<string>): string {
  if (typeof value !== 'string' || !allowed.has(value)) validation();
  return value;
}

function parsedJson(value: unknown, validator: (value: unknown) => void): string {
  if (typeof value !== 'string') integrity();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) integrity();
    throw error;
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch (error) {
    canonicalIntegrityFailure(error);
  }
  if (canonical !== value) integrity();
  validator(parsed);
  return value;
}

function anyJson(value: unknown): void {
  try {
    canonicalJson(value);
  } catch (error) {
    canonicalIntegrityFailure(error);
  }
}

function objectJson(value: unknown): void {
  if (!isObject(value)) integrity();
  anyJson(value);
}

function coverageJson(value: unknown): void {
  if (!isObject(value)) integrity();
  const fields = ['run', 'tool', 'command', 'file', 'approval'];
  if (Object.keys(value).length !== fields.length || fields.some((field) => typeof value[field] !== 'string' || !COVERAGE_LEVELS.includes(value[field] as (typeof COVERAGE_LEVELS)[number]))) integrity();
}

function metadataJson(value: unknown): void {
  objectJson(value);
}

function profileJson(value: unknown): void {
  if (!isObject(value) || Object.keys(value).length !== 4 || [...PROFILE_FIELDS].some((field) => !Object.hasOwn(value, field))) integrity();
  if (value.taskType !== null && (typeof value.taskType !== 'string' || !TASK_TYPES.has(value.taskType))) integrity();
  for (const field of ['target', 'expected', 'constraints']) {
    if (value[field] !== null && typeof value[field] !== 'string') integrity();
  }
}

function answerJson(value: unknown): void {
  anyJson(value);
}

function profileSourcesJson(value: unknown): void {
  if (!isObject(value)) integrity();
  for (const [field, source] of Object.entries(value)) {
    if (!PROFILE_FIELDS.has(field) || typeof source !== 'string' || !PROFILE_SOURCES.has(source)) integrity();
  }
}

function tagsJson(value: unknown): void {
  if (!Array.isArray(value)) integrity();
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string' || tag.trim().length === 0 || tag.length > 200 || seen.has(tag)) integrity();
    seen.add(tag);
  }
}

function nudgeIdListJson(value: unknown): void {
  if (!Array.isArray(value) || value.length > 16) integrity();
  const seen = new Set<string>();
  for (const item of value) {
    const id = stringValue(item, true, IDENTIFIER_MAX_LENGTH);
    if (seen.has(id)) integrity();
    seen.add(id);
  }
  for (let index = 1; index < value.length; index += 1) {
    if (compareCanonicalStrings(String(value[index - 1]), String(value[index])) > 0) integrity();
  }
}

function redactionJson(value: unknown): void {
  if (!Array.isArray(value)) integrity();
  for (const item of value) {
    if (!isObject(item) || Object.keys(item).length !== 2 || typeof item.path !== 'string' || item.path.length === 0 || typeof item.kind !== 'string' || !REDACTION_KINDS.has(item.kind)) integrity();
  }
}

function scoreJson(value: unknown): void {
  objectJson(value);
}

function commentValue(value: unknown): string | null {
  const result = nullableString(value, TEXT_MAX_LENGTH);
  if (result !== null && Buffer.byteLength(result, 'utf8') > COMMENT_MAX_BYTES) integrity();
  return result;
}

function secretScan(record: ArchiveRecord): void {
  let serialized: string;
  try {
    serialized = canonicalJson(record);
  } catch (error) {
    canonicalIntegrityFailure(error);
  }
  const finding = findSecret(serialized);
  if (finding) fail('SECURITY_REJECTION', 'Ledger archive contains secret residue', { kind: finding.kind });
}

function normalizeRecord(type: ArchiveRecordType, source: Row, workspace: string, importing: boolean): ArchiveRecord {
  const raw: Row = { type, ...source };
  assertObject(raw);
  assertFields(raw, RECORD_FIELDS[type]);
  const normalized: Row = { type };
  switch (type) {
    case 'runs': {
      if (stringValue(raw.workspace) !== workspace) validation();
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.workspace = workspace;
      normalized.client_kind = stringValue(raw.client_kind, true, IDENTIFIER_MAX_LENGTH);
      normalized.client_version = nullableString(raw.client_version, IDENTIFIER_MAX_LENGTH);
      normalized.source_session_id = nullableString(raw.source_session_id, IDENTIFIER_MAX_LENGTH);
      normalized.parent_run_id = nullableString(raw.parent_run_id, IDENTIFIER_MAX_LENGTH);
      normalized.protocol_version = stringValue(raw.protocol_version, true, 32);
      normalized.capture_profile = enumValue(raw.capture_profile, new Set(CAPTURE_PROFILES));
      normalized.coverage_json = parsedJson(raw.coverage_json, coverageJson);
      normalized.status = enumValue(raw.status, new Set(RUN_STATUSES));
      normalized.title = nullableString(raw.title);
      normalized.task_hash = hashValue(raw.task_hash, true);
      normalized.metadata_json = parsedJson(raw.metadata_json, metadataJson);
      normalized.last_sequence = integerValue(raw.last_sequence);
      normalized.last_source_sequence = nullableInteger(raw.last_source_sequence);
      normalized.started_at = timestampValue(raw.started_at);
      normalized.ended_at = timestampValue(raw.ended_at, true);
      normalized.created_at = timestampValue(raw.created_at);
      normalized.updated_at = timestampValue(raw.updated_at);
      if (normalized.protocol_version !== '1') validation();
      const terminal = TERMINAL_RUN_STATUSES.includes(normalized.status as (typeof TERMINAL_RUN_STATUSES)[number]);
      if (terminal !== (normalized.ended_at !== null)) integrity();
      break;
    }
    case 'sessions':
      if (stringValue(raw.workspace) !== workspace) validation();
      normalized.id = stringValue(raw.id, true, IDENTIFIER_MAX_LENGTH);
      normalized.workspace = workspace;
      normalized.task_text = stringValue(raw.task_text);
      normalized.profile_json = parsedJson(raw.profile_json, profileJson);
      normalized.status = enumValue(raw.status, new Set(['active', 'ready', 'exhausted']));
      const questionCount = integerValue(raw.question_count);
      normalized.question_count = questionCount;
      if (questionCount > 3) integrity();
      normalized.created_at = timestampValue(raw.created_at);
      normalized.updated_at = timestampValue(raw.updated_at);
      break;
    case 'answers':
      normalized.session_id = stringValue(raw.session_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.question_id = enumValue(raw.question_id, PROFILE_FIELDS);
      normalized.answer_json = parsedJson(raw.answer_json, answerJson);
      normalized.created_at = timestampValue(raw.created_at);
      break;
    case 'runIntakes':
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.session_id = stringValue(raw.session_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.policy_version = stringValue(raw.policy_version, true, IDENTIFIER_MAX_LENGTH);
      normalized.profile_schema_version = integerValue(raw.profile_schema_version, 1);
      normalized.profile_sources_json = parsedJson(raw.profile_sources_json, profileSourcesJson);
      normalized.initial_profile_hash = hashValue(raw.initial_profile_hash, true);
      normalized.recommended_tags_json = parsedJson(raw.recommended_tags_json, tagsJson);
      normalized.linked_at = timestampValue(raw.linked_at);
      normalized.finalized_at = timestampValue(raw.finalized_at, true);
      if (normalized.finalized_at !== null && normalized.initial_profile_hash === null) integrity();
      break;
    case 'intakeFeedback':
      normalized.feedback_id = stringValue(raw.feedback_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.session_id = stringValue(raw.session_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.question_id = nullableString(raw.question_id, IDENTIFIER_MAX_LENGTH);
      normalized.profile_field = nullableString(raw.profile_field, IDENTIFIER_MAX_LENGTH);
      if ((normalized.question_id === null) === (normalized.profile_field === null)) validation();
      if (normalized.question_id !== null) enumValue(normalized.question_id, PROFILE_FIELDS);
      if (normalized.profile_field !== null) enumValue(normalized.profile_field, PROFILE_FIELDS);
      normalized.verdict = enumValue(raw.verdict, new Set(['helpful', 'unnecessary', 'corrected']));
      normalized.comment = commentValue(raw.comment);
      normalized.actor = stringValue(raw.actor, true, IDENTIFIER_MAX_LENGTH);
      normalized.idempotency_key = hashValue(raw.idempotency_key);
      normalized.created_at = timestampValue(raw.created_at);
      break;
    case 'events':
      normalized.event_id = stringValue(raw.event_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.sequence = integerValue(raw.sequence, 1);
      normalized.source_event_id = nullableString(raw.source_event_id, IDENTIFIER_MAX_LENGTH);
      normalized.source_sequence = nullableInteger(raw.source_sequence);
      normalized.event_type = enumValue(raw.event_type, new Set(LEDGER_EVENT_TYPES));
      normalized.source_type = nullableString(raw.source_type, IDENTIFIER_MAX_LENGTH);
      normalized.actor = stringValue(raw.actor, true, IDENTIFIER_MAX_LENGTH);
      normalized.outcome = nullableString(raw.outcome);
      normalized.occurred_at = timestampValue(raw.occurred_at, true);
      normalized.ingested_at = timestampValue(raw.ingested_at);
      normalized.payload_json = parsedJson(raw.payload_json, answerJson);
      normalized.redaction_json = parsedJson(raw.redaction_json, redactionJson);
      normalized.previous_hash = hashValue(raw.previous_hash) as string;
      normalized.event_hash = hashValue(raw.event_hash) as string;
      break;
    case 'evidence':
      normalized.evidence_id = stringValue(raw.evidence_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.event_id = nullableString(raw.event_id, IDENTIFIER_MAX_LENGTH);
      normalized.kind = enumValue(raw.kind, EVIDENCE_KINDS);
      normalized.locator = stringValue(raw.locator);
      normalized.digest_algorithm = nullableString(raw.digest_algorithm, IDENTIFIER_MAX_LENGTH);
      normalized.digest = nullableString(raw.digest, IDENTIFIER_MAX_LENGTH);
      normalized.byte_size = nullableInteger(raw.byte_size);
      normalized.summary = nullableString(raw.summary);
      normalized.created_at = timestampValue(raw.created_at);
      break;
    case 'deliveries':
      normalized.delivery_id = stringValue(raw.delivery_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.through_sequence = integerValue(raw.through_sequence);
      normalized.intake_session_id = nullableString(raw.intake_session_id, IDENTIFIER_MAX_LENGTH);
      normalized.task_profile_hash = hashValue(raw.task_profile_hash) as string;
      normalized.query_hash = hashValue(raw.query_hash) as string;
      normalized.policy_version = stringValue(raw.policy_version, true, IDENTIFIER_MAX_LENGTH);
      const scoreSchemaVersion = integerValue(raw.score_schema_version, 1);
      if (scoreSchemaVersion !== 1 && scoreSchemaVersion !== 2) integrity();
      normalized.score_schema_version = scoreSchemaVersion;
      normalized.char_budget = integerValue(raw.char_budget);
      normalized.char_count = integerValue(raw.char_count);
      const truncated = integerValue(raw.truncated);
      const charCount = Number(normalized.char_count);
      const charBudget = Number(normalized.char_budget);
      normalized.truncated = truncated;
      if (truncated > 1 || charCount > charBudget) integrity();
      normalized.created_at = timestampValue(raw.created_at);
      break;
    case 'deliveryEntries':
      normalized.delivery_id = stringValue(raw.delivery_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.entry_id = stringValue(raw.entry_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.entry_revision = integerValue(raw.entry_revision, 1);
      normalized.rank = integerValue(raw.rank, 1);
      normalized.score_components_json = parsedJson(raw.score_components_json, scoreJson);
      normalized.selection_reason_json = parsedJson(raw.selection_reason_json, tagsJson);
      normalized.origin_scope = enumValue(raw.origin_scope, new Set(['project', 'ecosystem', 'global']));
      break;
    case 'nudgeDeliveries':
      normalized.id = stringValue(raw.id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.policy_version = stringValue(raw.policy_version, true, IDENTIFIER_MAX_LENGTH);
      if (normalized.policy_version !== NUDGE_POLICY_VERSION) validation();
      const nudgeCode = enumValue(raw.code, new Set(NUDGE_CODES));
      normalized.code = nudgeCode;
      normalized.occurrence_id = stringValue(raw.occurrence_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.checkpoint_id = stringValue(raw.checkpoint_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.through_sequence = integerValue(raw.through_sequence);
      normalized.priority = integerValue(raw.priority, 1);
      if (normalized.priority !== NUDGE_PRIORITY[nudgeCode as keyof typeof NUDGE_PRIORITY]) integrity();
      normalized.evidence_event_ids_json = parsedJson(raw.evidence_event_ids_json, nudgeIdListJson);
      normalized.reference_ids_json = parsedJson(raw.reference_ids_json, nudgeIdListJson);
      normalized.delivered_at = timestampValue(raw.delivered_at);
      break;
    case 'contextFeedback':
      normalized.feedback_id = stringValue(raw.feedback_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.delivery_id = stringValue(raw.delivery_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.entry_id = stringValue(raw.entry_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.verdict = enumValue(raw.verdict, CONTEXT_FEEDBACK_VERDICTS);
      normalized.comment = commentValue(raw.comment);
      normalized.actor = stringValue(raw.actor, true, IDENTIFIER_MAX_LENGTH);
      normalized.idempotency_key = hashValue(raw.idempotency_key) as string;
      normalized.created_at = timestampValue(raw.created_at);
      break;
    case 'runFeedback':
      normalized.feedback_id = stringValue(raw.feedback_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.outcome = nullableString(raw.outcome);
      normalized.recommendation_code = nullableString(raw.recommendation_code, IDENTIFIER_MAX_LENGTH);
      normalized.recommendation_verdict = raw.recommendation_verdict === null ? null : enumValue(raw.recommendation_verdict, RECOMMENDATION_VERDICTS);
      const rating = nullableInteger(raw.rating, 1);
      normalized.rating = rating;
      if (rating !== null && rating > 5) integrity();
      normalized.comment = commentValue(raw.comment);
      normalized.actor = stringValue(raw.actor, true, IDENTIFIER_MAX_LENGTH);
      normalized.idempotency_key = hashValue(raw.idempotency_key) as string;
      normalized.created_at = timestampValue(raw.created_at);
      if (normalized.recommendation_code === null !== (normalized.recommendation_verdict === null)) integrity();
      if (normalized.outcome === null && normalized.recommendation_code === null && normalized.rating === null) integrity();
      break;
    case 'memoryLinks':
      normalized.link_id = stringValue(raw.link_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = stringValue(raw.run_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.event_id = nullableString(raw.event_id, IDENTIFIER_MAX_LENGTH);
      normalized.delivery_id = nullableString(raw.delivery_id, IDENTIFIER_MAX_LENGTH);
      normalized.entry_id = stringValue(raw.entry_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.created_at = timestampValue(raw.created_at);
      if (normalized.event_id === null && normalized.delivery_id === null) integrity();
      break;
    case 'purgeAudit':
      normalized.purge_id = stringValue(raw.purge_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.run_id = nullableString(raw.run_id, IDENTIFIER_MAX_LENGTH);
      normalized.event_id = nullableString(raw.event_id, IDENTIFIER_MAX_LENGTH);
      normalized.delivery_id = nullableString(raw.delivery_id, IDENTIFIER_MAX_LENGTH);
      normalized.entry_id = nullableString(raw.entry_id, IDENTIFIER_MAX_LENGTH);
      normalized.target_type = enumValue(raw.target_type, PURGE_TARGET_TYPES);
      normalized.target_id = stringValue(raw.target_id, true, IDENTIFIER_MAX_LENGTH);
      normalized.actor = stringValue(raw.actor, true, IDENTIFIER_MAX_LENGTH);
      normalized.reason = nullableString(raw.reason);
      normalized.created_at = timestampValue(raw.created_at);
      break;
  }
  const result = normalized as ArchiveRecord;
  if (!importing) secretScan(result);
  return result;
}

function rows(database: SqliteDatabase, sql: string, ...parameters: SqliteValue[]): Row[] {
  try {
    return database.prepare(sql).all<Row>(...parameters);
  } catch (error) {
    if (isSqliteCorruptionError(error)) integrity();
    throw error;
  }
}

function queryRows(database: SqliteDatabase, type: ArchiveRecordType, workspace: string): ArchiveRecord[] {
  const fields = TABLE_FIELDS[type].join(', ');
  const scoped: Record<ArchiveRecordType, { sql: string; parameters: SqliteValue[] }> = {
    runs: { sql: `SELECT ${fields} FROM ledger_runs WHERE workspace = ? ORDER BY run_id ASC`, parameters: [workspace] },
    sessions: { sql: `SELECT s.${TABLE_FIELDS.sessions.join(', s.')} FROM akinator_sessions AS s JOIN run_intakes AS ri ON ri.session_id = s.id JOIN ledger_runs AS lr ON lr.run_id = ri.run_id WHERE lr.workspace = ? ORDER BY s.id ASC`, parameters: [workspace] },
    answers: { sql: `SELECT a.${TABLE_FIELDS.answers.join(', a.')} FROM akinator_answers AS a JOIN akinator_sessions AS s ON s.id = a.session_id JOIN run_intakes AS ri ON ri.session_id = s.id JOIN ledger_runs AS lr ON lr.run_id = ri.run_id WHERE lr.workspace = ? ORDER BY a.session_id ASC, a.question_id ASC`, parameters: [workspace] },
    runIntakes: { sql: `SELECT ri.${TABLE_FIELDS.runIntakes.join(', ri.')} FROM run_intakes AS ri JOIN ledger_runs AS lr ON lr.run_id = ri.run_id WHERE lr.workspace = ? ORDER BY ri.run_id ASC`, parameters: [workspace] },
    intakeFeedback: { sql: `SELECT f.${TABLE_FIELDS.intakeFeedback.join(', f.')} FROM intake_feedback AS f JOIN ledger_runs AS lr ON lr.run_id = f.run_id WHERE lr.workspace = ? ORDER BY f.feedback_id ASC`, parameters: [workspace] },
    events: { sql: `SELECT e.${TABLE_FIELDS.events.join(', e.')} FROM ledger_events AS e JOIN ledger_runs AS lr ON lr.run_id = e.run_id WHERE lr.workspace = ? ORDER BY e.run_id ASC, e.sequence ASC`, parameters: [workspace] },
    evidence: { sql: `SELECT e.${TABLE_FIELDS.evidence.join(', e.')} FROM ledger_evidence AS e JOIN ledger_runs AS lr ON lr.run_id = e.run_id WHERE lr.workspace = ? ORDER BY e.run_id ASC, e.evidence_id ASC`, parameters: [workspace] },
    deliveries: { sql: `SELECT d.${TABLE_FIELDS.deliveries.join(', d.')} FROM context_deliveries AS d JOIN ledger_runs AS lr ON lr.run_id = d.run_id WHERE lr.workspace = ? ORDER BY d.run_id ASC, d.delivery_id ASC`, parameters: [workspace] },
    deliveryEntries: { sql: `SELECT c.${TABLE_FIELDS.deliveryEntries.join(', c.')} FROM context_delivery_entries AS c JOIN context_deliveries AS d ON d.delivery_id = c.delivery_id JOIN ledger_runs AS lr ON lr.run_id = d.run_id WHERE lr.workspace = ? ORDER BY c.delivery_id ASC, c.entry_id ASC`, parameters: [workspace] },
    nudgeDeliveries: { sql: `SELECT n.${TABLE_FIELDS.nudgeDeliveries.join(', n.')} FROM nudge_deliveries AS n JOIN ledger_runs AS lr ON lr.run_id = n.run_id WHERE lr.workspace = ? ORDER BY n.run_id ASC, n.through_sequence ASC, n.id ASC`, parameters: [workspace] },
    contextFeedback: { sql: `SELECT f.${TABLE_FIELDS.contextFeedback.join(', f.')} FROM context_feedback AS f JOIN ledger_runs AS lr ON lr.run_id = f.run_id WHERE lr.workspace = ? ORDER BY f.feedback_id ASC`, parameters: [workspace] },
    runFeedback: { sql: `SELECT f.${TABLE_FIELDS.runFeedback.join(', f.')} FROM run_feedback AS f JOIN ledger_runs AS lr ON lr.run_id = f.run_id WHERE lr.workspace = ? ORDER BY f.feedback_id ASC`, parameters: [workspace] },
    memoryLinks: { sql: `SELECT l.${TABLE_FIELDS.memoryLinks.join(', l.')} FROM ledger_memory_links AS l JOIN ledger_runs AS lr ON lr.run_id = l.run_id WHERE lr.workspace = ? ORDER BY l.link_id ASC`, parameters: [workspace] },
    purgeAudit: { sql: `SELECT p.${TABLE_FIELDS.purgeAudit.join(', p.')} FROM ledger_purge_audit AS p WHERE EXISTS (SELECT 1 FROM ledger_runs AS r WHERE r.run_id = p.run_id AND r.workspace = ?) OR EXISTS (SELECT 1 FROM ledger_events AS e JOIN ledger_runs AS r ON r.run_id = e.run_id WHERE e.event_id = p.event_id AND r.workspace = ?) OR EXISTS (SELECT 1 FROM context_deliveries AS d JOIN ledger_runs AS r ON r.run_id = d.run_id WHERE d.delivery_id = p.delivery_id AND r.workspace = ?) OR EXISTS (SELECT 1 FROM entries AS e WHERE e.id = p.entry_id AND e.workspace = ?) ORDER BY p.purge_id ASC`, parameters: [workspace, workspace, workspace, workspace] },
  };
  const selected = scoped[type];
  const result = rows(database, selected.sql, ...selected.parameters);
  return result.map((row) => normalizeRecord(type, row, workspace, false));
}

function countRecords(records: Map<ArchiveRecordType, ArchiveRecord[]>): LedgerArchiveCounts {
  const counts = { ...EMPTY_COUNTS };
  for (const type of Object.keys(counts) as ArchiveRecordType[]) counts[type] = records.get(type)?.length ?? 0;
  return counts;
}

function checkBounds(content: string): string[] {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_ARCHIVE_TOTAL_BYTES || !content.endsWith('\n')) validation();
  const lines = content.split('\n');
  if (lines.at(-1) !== '') validation();
  const serialized = lines.slice(0, -1);
  if (serialized.length > MAX_ARCHIVE_LINE_COUNT || serialized.some((line) => line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_ARCHIVE_LINE_BYTES)) validation();
  return serialized;
}

function buildArchive(workspace: string, records: Map<ArchiveRecordType, ArchiveRecord[]>): LedgerArchiveExport {
  const counts = countRecords(records);
  const manifest: ArchiveRecord = {
    type: 'manifest',
    apiVersion: LEDGER_ARCHIVE_API_VERSION,
    archiveVersion: LEDGER_ARCHIVE_VERSION,
    format: LEDGER_ARCHIVE_FORMAT,
    workspace,
    counts,
  };
  secretScan(manifest);
  const ordered = (Object.keys(counts) as ArchiveRecordType[]).flatMap((type) =>
    (records.get(type) ?? []).map((record) => ({ ...record, type: RECORD_NAMES[type] })),
  );
  const payloadLines = [manifest, ...ordered].map((record) => canonicalJson(record));
  const payload = `${payloadLines.join('\n')}\n`;
  const checksum = createHash('sha256').update(payload, 'utf8').digest('hex');
  const content = `${canonicalJson({ type: 'checksum', sha256: checksum })}\n${payload}`;
  checkBounds(content);
  return { workspace, counts, checksum, content };
}

export function exportLedgerArchive(database: SqliteDatabase, options: ExportLedgerArchiveOptions): LedgerArchiveExport {
  const workspace = requireWorkspace(options.workspace);
  const records = new Map<ArchiveRecordType, ArchiveRecord[]>();
  for (const type of Object.keys(EMPTY_COUNTS) as ArchiveRecordType[]) records.set(type, queryRows(database, type, workspace));
  validateGraph(records, workspace);
  validateMemoryReferences(database, records, workspace);
  return buildArchive(workspace, records);
}

function parseLine(line: string, fields: readonly string[]): Row {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) integrity();
    throw error;
  }
  assertObject(parsed);
  assertFields(parsed, fields);
  try {
    if (canonicalJson(parsed) !== line) integrity();
  } catch (error) {
    canonicalIntegrityFailure(error);
  }
  return parsed;
}

function parseCounts(value: unknown): LedgerArchiveCounts {
  assertObject(value);
  const fields = Object.keys(EMPTY_COUNTS);
  assertFields(value, fields);
  const counts = { ...EMPTY_COUNTS };
  for (const type of fields as ArchiveRecordType[]) counts[type] = integerValue(value[type]);
  return counts;
}

function parseArchive(content: string): { workspace: string; counts: LedgerArchiveCounts; records: Map<ArchiveRecordType, ArchiveRecord[]> } {
  const lines = checkBounds(content);
  if (lines.length < 2) integrity();
  const checksum = parseLine(lines[0]!, RECORD_FIELDS.checksum);
  if (checksum.type !== 'checksum' || typeof checksum.sha256 !== 'string' || !HASH_PATTERN.test(checksum.sha256)) integrity();
  const payload = `${lines.slice(1).join('\n')}\n`;
  const actual = createHash('sha256').update(payload, 'utf8').digest('hex');
  if (actual !== checksum.sha256) integrity();
  const manifest = parseLine(lines[1]!, RECORD_FIELDS.manifest);
  if (manifest.type !== 'manifest'
    || manifest.apiVersion !== LEDGER_ARCHIVE_API_VERSION
    || typeof manifest.archiveVersion !== 'number'
    || manifest.archiveVersion !== LEDGER_ARCHIVE_VERSION
    || manifest.format !== LEDGER_ARCHIVE_FORMAT) validation();
  secretScan(manifest as ArchiveRecord);
  const workspace = requireWorkspace(manifest.workspace);
  const counts = parseCounts(manifest.counts);
  const records = new Map<ArchiveRecordType, ArchiveRecord[]>();
  for (const type of Object.keys(EMPTY_COUNTS) as ArchiveRecordType[]) records.set(type, []);
  const seenManifest = [manifest];
  if (seenManifest.length !== 1) integrity();
  for (const line of lines.slice(2)) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) integrity();
      throw error;
    }
    assertObject(raw);
    if (raw.type === 'manifest' || raw.type === 'checksum') integrity();
    const type = raw.type;
    if (typeof type !== 'string') validation();
    const archiveType = RECORD_TYPES.get(type);
    if (!archiveType) validation();
    const parsed = parseLine(line, RECORD_FIELDS[archiveType]);
    const normalized = normalizeRecord(archiveType, parsed, workspace, true);
    secretScan(normalized);
    const bucket = records.get(archiveType);
    if (!bucket) integrity();
    bucket.push(normalized);
  }
  for (const type of Object.keys(counts) as ArchiveRecordType[]) {
    if (records.get(type)?.length !== counts[type]) integrity();
  }
  return { workspace, counts, records };
}

function identity(type: ArchiveRecordType, record: ArchiveRecord): string {
  switch (type) {
    case 'runs': return String(record.run_id);
    case 'sessions': return String(record.id);
    case 'answers': return `${record.session_id}\u0000${record.question_id}`;
    case 'runIntakes': return String(record.run_id);
    case 'intakeFeedback': return String(record.feedback_id);
    case 'events': return String(record.event_id);
    case 'evidence': return String(record.evidence_id);
    case 'deliveries': return String(record.delivery_id);
    case 'deliveryEntries': return `${record.delivery_id}\u0000${record.entry_id}`;
    case 'nudgeDeliveries': return String(record.id);
    case 'contextFeedback': return String(record.feedback_id);
    case 'runFeedback': return String(record.feedback_id);
    case 'memoryLinks': return String(record.link_id);
    case 'purgeAudit': return String(record.purge_id);
  }
}

function ensureUniqueRecords(records: Map<ArchiveRecordType, ArchiveRecord[]>): void {
  const globalEvents = new Set<string>();
  for (const type of Object.keys(EMPTY_COUNTS) as ArchiveRecordType[]) {
    const seen = new Set<string>();
    for (const record of records.get(type) ?? []) {
      const key = identity(type, record);
      if (seen.has(key)) integrity();
      seen.add(key);
      if (type === 'events') {
        if (globalEvents.has(String(record.event_id))) integrity();
        globalEvents.add(String(record.event_id));
      }
    }
  }
}

function byId(records: Map<ArchiveRecordType, ArchiveRecord[]>, type: ArchiveRecordType, key: string): ArchiveRecord | undefined {
  return (records.get(type) ?? []).find((record) => identity(type, record) === key);
}

function validateGraph(records: Map<ArchiveRecordType, ArchiveRecord[]>, workspace: string): void {
  ensureUniqueRecords(records);
  const runs = records.get('runs') ?? [];
  const sessions = records.get('sessions') ?? [];
  const intakes = records.get('runIntakes') ?? [];
  const runIds = new Set(runs.map((record) => String(record.run_id)));
  const sessionIds = new Set(sessions.map((record) => String(record.id)));
  const intakeByRun = new Map<string, ArchiveRecord>();
  const intakeBySession = new Map<string, ArchiveRecord>();
  for (const intake of intakes) {
    const runId = String(intake.run_id);
    const sessionId = String(intake.session_id);
    if (!runIds.has(runId) || !sessionIds.has(sessionId) || intakeByRun.has(runId) || intakeBySession.has(sessionId)) integrity();
    intakeByRun.set(runId, intake);
    intakeBySession.set(sessionId, intake);
  }
  for (const session of sessions) {
    if (String(session.workspace) !== workspace) integrity();
  }
  const eventsByRun = new Map<string, ArchiveRecord[]>();
  for (const event of records.get('events') ?? []) {
    const runId = String(event.run_id);
    if (!runIds.has(runId)) integrity();
    const list = eventsByRun.get(runId) ?? [];
    list.push(event);
    eventsByRun.set(runId, list);
  }
  for (const run of runs) {
    const runId = String(run.run_id);
    const parent = run.parent_run_id === null ? null : String(run.parent_run_id);
    if (parent !== null && !runIds.has(parent)) integrity();
    const eventRows = [...(eventsByRun.get(runId) ?? [])].sort((left, right) => Number(left.sequence) - Number(right.sequence));
    if (eventRows.length !== Number(run.last_sequence)) integrity();
    let previous = GENESIS_HASH;
    let maxSource: number | null = null;
    for (let index = 0; index < eventRows.length; index += 1) {
      const event = eventRows[index]!;
      if (Number(event.sequence) !== index + 1 || event.previous_hash !== previous) integrity();
      const calculated = hashLedgerEvent({
        runId,
        sequence: Number(event.sequence),
        eventId: String(event.event_id),
        previousHash: String(event.previous_hash),
        eventType: String(event.event_type),
        ...(event.source_event_id === null ? {} : { sourceEventId: String(event.source_event_id) }),
        ...(event.source_sequence === null ? {} : { sourceSequence: Number(event.source_sequence) }),
        ...(event.source_type === null ? {} : { sourceType: String(event.source_type) }),
        actor: String(event.actor),
        ...(event.outcome === null ? {} : { outcome: String(event.outcome) }),
        ...(event.occurred_at === null ? {} : { occurredAt: String(event.occurred_at) }),
        ingestedAt: String(event.ingested_at),
        payload: JSON.parse(String(event.payload_json)) as JsonValue,
        redaction: JSON.parse(String(event.redaction_json)) as Redaction[],
      });
      if (calculated !== event.event_hash) integrity();
      previous = String(event.event_hash);
      if (event.source_sequence !== null) maxSource = maxSource === null ? Number(event.source_sequence) : Math.max(maxSource, Number(event.source_sequence));
    }
    if ((run.last_source_sequence === null ? null : Number(run.last_source_sequence)) !== maxSource) integrity();
    if (run.status === 'active') {
      const intake = intakeByRun.get(runId);
      const session = intake ? byId(records, 'sessions', String(intake.session_id)) : undefined;
      if (!intake || !session || !['ready', 'exhausted'].includes(String(session.status))) integrity();
    }
  }
  for (const intake of intakes) {
    if (intake.finalized_at !== null) {
      const session = byId(records, 'sessions', String(intake.session_id));
      if (!session || !['ready', 'exhausted'].includes(String(session.status))) integrity();
    }
  }
  for (const answer of records.get('answers') ?? []) {
    if (!sessionIds.has(String(answer.session_id))) integrity();
  }
  for (const feedback of records.get('intakeFeedback') ?? []) {
    const intake = intakeByRun.get(String(feedback.run_id));
    if (!intake || intake.session_id !== feedback.session_id) integrity();
  }
  const eventIds = new Set((records.get('events') ?? []).map((event) => String(event.event_id)));
  const eventById = new Map((records.get('events') ?? []).map((event) => [String(event.event_id), event]));
  for (const evidence of records.get('evidence') ?? []) {
    if (!runIds.has(String(evidence.run_id)) || (evidence.event_id !== null && !eventIds.has(String(evidence.event_id)))) integrity();
  }
  const deliveryById = new Map((records.get('deliveries') ?? []).map((delivery) => [String(delivery.delivery_id), delivery]));
  for (const delivery of records.get('deliveries') ?? []) {
    const run = byId(records, 'runs', String(delivery.run_id));
    if (!run || Number(delivery.through_sequence) > Number(run.last_sequence)) integrity();
    if (delivery.intake_session_id !== null) {
      const intake = intakeByRun.get(String(delivery.run_id));
      if (!intake || intake.session_id !== delivery.intake_session_id) integrity();
    }
  }
  const nudgeOccurrences = new Set<string>();
  const nudgeCheckpoints = new Set<string>();
  const nudgeHistory = new Map<string, ReturnType<typeof parseStoredNudgeDelivery>[]>();
  for (const nudge of records.get('nudgeDeliveries') ?? []) {
    const run = byId(records, 'runs', String(nudge.run_id));
    if (!run || Number(nudge.through_sequence) > Number(run.last_sequence)) integrity();
    const occurrenceKey = `${nudge.run_id}\u0000${nudge.policy_version}\u0000${nudge.occurrence_id}`;
    const checkpointKey = `${nudge.run_id}\u0000${nudge.policy_version}\u0000${nudge.checkpoint_id}`;
    if (nudgeOccurrences.has(occurrenceKey) || nudgeCheckpoints.has(checkpointKey)) integrity();
    nudgeOccurrences.add(occurrenceKey);
    nudgeCheckpoints.add(checkpointKey);
    const stored = parseStoredNudgeDelivery(nudge);
    const historyKey = `${stored.policyVersion}\u0000${nudge.run_id}`;
    const history = nudgeHistory.get(historyKey) ?? [];
    history.push(stored);
    nudgeHistory.set(historyKey, history);
    let evidenceEventIds: unknown;
    try {
      evidenceEventIds = JSON.parse(String(nudge.evidence_event_ids_json));
    } catch {
      integrity();
    }
    if (!Array.isArray(evidenceEventIds)) integrity();
    for (const eventId of evidenceEventIds) {
      const event = eventById.get(String(eventId));
      if (!event || event.run_id !== nudge.run_id || Number(event.sequence) > Number(nudge.through_sequence)) integrity();
    }
  }
  for (const history of nudgeHistory.values()) {
    validateStoredNudgeHistory(history, DEFAULT_NUDGE_RATE_LIMIT);
  }
  const deliveryEntries = new Set<string>();
  for (const entry of records.get('deliveryEntries') ?? []) {
    const key = `${entry.delivery_id}\u0000${entry.entry_id}`;
    if (deliveryEntries.has(key) || !deliveryById.has(String(entry.delivery_id))) integrity();
    deliveryEntries.add(key);
  }
  for (const feedback of records.get('contextFeedback') ?? []) {
    const delivery = deliveryById.get(String(feedback.delivery_id));
    if (!delivery || delivery.run_id !== feedback.run_id || !deliveryEntries.has(`${feedback.delivery_id}\u0000${feedback.entry_id}`)) integrity();
  }
  for (const feedback of records.get('runFeedback') ?? []) {
    if (!runIds.has(String(feedback.run_id))) integrity();
  }
  for (const link of records.get('memoryLinks') ?? []) {
    if (!runIds.has(String(link.run_id))) integrity();
    if (link.event_id === null && link.delivery_id === null) integrity();
    if (link.event_id !== null) {
      const event = (records.get('events') ?? []).find((candidate) => candidate.event_id === link.event_id);
      if (!event || event.run_id !== link.run_id) integrity();
    }
    if (link.delivery_id !== null) {
      const delivery = deliveryById.get(String(link.delivery_id));
      if (!delivery || delivery.run_id !== link.run_id) integrity();
    }
  }
  for (const purge of records.get('purgeAudit') ?? []) {
    if (purge.run_id !== null && !runIds.has(String(purge.run_id))) integrity();
    if (purge.event_id !== null && !eventIds.has(String(purge.event_id))) integrity();
    if (purge.delivery_id !== null && !deliveryById.has(String(purge.delivery_id))) integrity();
  }
}

function exactEntryReference(database: SqliteDatabase, entryId: string, revision: number): Row | undefined {
  return rows(database, `
    SELECT e.id, e.workspace AS entry_workspace, er.revision,
           er.workspace AS revision_workspace
      FROM entries AS e
      JOIN entry_revisions AS er
        ON er.entry_id = e.id AND er.revision = ?
     WHERE e.id = ?
  `, revision, entryId)[0];
}

function validateMemoryReferences(
  database: SqliteDatabase,
  records: Map<ArchiveRecordType, ArchiveRecord[]>,
  workspace: string,
): void {
  const deliveryEntries = new Map<string, ArchiveRecord>();
  for (const record of records.get('deliveryEntries') ?? []) {
    const origin = isContextEntryOrigin(record.origin_scope) ? record.origin_scope : integrity();
    const entryId = String(record.entry_id);
    const entryRevision = Number(record.entry_revision);
    const entry = exactEntryReference(database, entryId, entryRevision);
    if (!entry) notFound();
    if (typeof entry.entry_workspace !== 'string'
      || entry.revision_workspace !== entry.entry_workspace
      || !entryOriginMatchesWorkspace({ origin, runWorkspace: workspace, entryWorkspace: entry.entry_workspace })) conflict();
    deliveryEntries.set(`${record.delivery_id}\u0000${entryId}`, record);
  }

  for (const feedback of records.get('contextFeedback') ?? []) {
    const deliveryEntry = deliveryEntries.get(`${feedback.delivery_id}\u0000${feedback.entry_id}`);
    if (!deliveryEntry) integrity();
    const entry = exactEntryReference(database, String(feedback.entry_id), Number(deliveryEntry.entry_revision));
    const origin = isContextEntryOrigin(deliveryEntry.origin_scope) ? deliveryEntry.origin_scope : integrity();
    if (!entry) notFound();
    if (typeof entry.entry_workspace !== 'string'
      || entry.revision_workspace !== entry.entry_workspace
      || !entryOriginMatchesWorkspace({ origin, runWorkspace: workspace, entryWorkspace: entry.entry_workspace })) conflict();
  }

  // Memory links are intentionally narrower than delivery provenance: they may
  // reference only the run project or Global, never an arbitrary foreign project.
  for (const link of records.get('memoryLinks') ?? []) {
    const entry = rows(database, 'SELECT id, workspace FROM entries WHERE id = ?', String(link.entry_id))[0];
    if (!entry) notFound();
    if (entry.workspace !== workspace && entry.workspace !== 'global') conflict();
  }
}

function selectExisting(database: SqliteDatabase, type: ArchiveRecordType, record: ArchiveRecord): Row | undefined {
  const fields = TABLE_FIELDS[type].join(', ');
  const table = TABLE_NAMES[type];
  let sql = `SELECT ${fields} FROM ${table} WHERE `;
  const parameters: SqliteValue[] = [];
  switch (type) {
    case 'runs': sql += 'run_id = ?'; parameters.push(String(record.run_id)); break;
    case 'sessions': sql += 'id = ?'; parameters.push(String(record.id)); break;
    case 'answers': sql += 'session_id = ? AND question_id = ?'; parameters.push(String(record.session_id), String(record.question_id)); break;
    case 'runIntakes': sql += 'run_id = ?'; parameters.push(String(record.run_id)); break;
    case 'intakeFeedback': sql += 'feedback_id = ?'; parameters.push(String(record.feedback_id)); break;
    case 'events': sql += 'event_id = ?'; parameters.push(String(record.event_id)); break;
    case 'evidence': sql += 'evidence_id = ?'; parameters.push(String(record.evidence_id)); break;
    case 'deliveries': sql += 'delivery_id = ?'; parameters.push(String(record.delivery_id)); break;
    case 'deliveryEntries': sql += 'delivery_id = ? AND entry_id = ?'; parameters.push(String(record.delivery_id), String(record.entry_id)); break;
    case 'nudgeDeliveries': sql += 'id = ?'; parameters.push(String(record.id)); break;
    case 'contextFeedback': sql += 'feedback_id = ?'; parameters.push(String(record.feedback_id)); break;
    case 'runFeedback': sql += 'feedback_id = ?'; parameters.push(String(record.feedback_id)); break;
    case 'memoryLinks': sql += 'link_id = ?'; parameters.push(String(record.link_id)); break;
    case 'purgeAudit': sql += 'purge_id = ?'; parameters.push(String(record.purge_id)); break;
  }
  return rows(database, sql, ...parameters)[0];
}

function hasUniqueConflict(database: SqliteDatabase, type: ArchiveRecordType, record: ArchiveRecord): boolean {
  let sql: string | undefined;
  const parameters: SqliteValue[] = [];
  switch (type) {
    case 'runIntakes': sql = 'SELECT 1 AS present FROM run_intakes WHERE session_id = ?'; parameters.push(String(record.session_id)); break;
    case 'events':
      if (record.source_event_id !== null) {
        sql = 'SELECT 1 AS present FROM ledger_events WHERE run_id = ? AND source_event_id = ?';
        parameters.push(String(record.run_id), String(record.source_event_id));
      }
      if (!sql) {
        sql = 'SELECT 1 AS present FROM ledger_events WHERE run_id = ? AND sequence = ?';
        parameters.push(String(record.run_id), Number(record.sequence));
      }
      break;
    case 'deliveryEntries': sql = 'SELECT 1 AS present FROM context_delivery_entries WHERE delivery_id = ? AND entry_id = ?'; parameters.push(String(record.delivery_id), String(record.entry_id)); break;
    case 'intakeFeedback': sql = 'SELECT 1 AS present FROM intake_feedback WHERE run_id = ? AND actor = ? AND idempotency_key = ?'; parameters.push(String(record.run_id), String(record.actor), String(record.idempotency_key)); break;
    case 'contextFeedback': sql = 'SELECT 1 AS present FROM context_feedback WHERE run_id = ? AND actor = ? AND idempotency_key = ?'; parameters.push(String(record.run_id), String(record.actor), String(record.idempotency_key)); break;
    case 'runFeedback': sql = 'SELECT 1 AS present FROM run_feedback WHERE run_id = ? AND actor = ? AND idempotency_key = ?'; parameters.push(String(record.run_id), String(record.actor), String(record.idempotency_key)); break;
    default: return false;
  }
  return rows(database, sql, ...parameters).length > 0;
}

function ensureMemoryReference(database: SqliteDatabase, record: ArchiveRecord, workspace: string): void {
  if (record.type !== 'memoryLinks') return;
  const entryId = String(record.entry_id);
  const entry = rows(database, 'SELECT id, workspace FROM entries WHERE id = ?', entryId)[0];
  if (!entry) notFound();
  if (entry.workspace !== workspace && entry.workspace !== 'global') conflict();
}

function compareExisting(database: SqliteDatabase, type: ArchiveRecordType, record: ArchiveRecord, workspace: string): 'new' | 'duplicate' {
  const existing = selectExisting(database, type, record);
  if (existing) {
    const normalized = normalizeRecord(type, existing, String(record.workspace ?? ''), true);
    if (canonicalJson(normalized) !== canonicalJson(record)) conflict();
    return 'duplicate';
  }
  if (hasUniqueConflict(database, type, record)) conflict();
  ensureMemoryReference(database, record, workspace);
  return 'new';
}

function insertRecord(database: SqliteDatabase, type: ArchiveRecordType, record: ArchiveRecord): void {
  const fields = [...TABLE_FIELDS[type]];
  const values = fields.map((field) => record[field] as SqliteValue);
  if (type === 'deliveries') {
    fields.push('external_sync_summary_json');
    values.push('{}');
  }
  const placeholders = fields.map(() => '?').join(', ');
  try {
    database.prepare(`INSERT INTO ${TABLE_NAMES[type]} (${fields.join(', ')}) VALUES (${placeholders})`).run(...values);
  } catch (error) {
    if (isSqliteUniqueConstraintError(error, UNIQUE_CONSTRAINT_TARGETS[type])) conflict();
    if (isSqliteCorruptionError(error)) integrity();
    throw error;
  }
}

function orderedForImport(records: Map<ArchiveRecordType, ArchiveRecord[]>): ArchiveRecord[] {
  const output: ArchiveRecord[] = [];
  const runRecords = records.get('runs') ?? [];
  const emittedRuns = new Set<string>();
  const emitRun = (run: ArchiveRecord): void => {
    const runId = String(run.run_id);
    if (emittedRuns.has(runId)) return;
    const parentId = run.parent_run_id === null ? null : String(run.parent_run_id);
    if (parentId !== null) {
      const parent = runRecords.find((candidate) => String(candidate.run_id) === parentId);
      if (parent) emitRun(parent);
    }
    emittedRuns.add(runId);
    output.push(run);
  };
  for (const run of runRecords) emitRun(run);
  const orderedTypes: ArchiveRecordType[] = [
    'sessions', 'answers', 'runIntakes', 'intakeFeedback', 'events', 'evidence', 'deliveries', 'nudgeDeliveries',
    'deliveryEntries', 'contextFeedback', 'runFeedback', 'memoryLinks', 'purgeAudit',
  ];
  for (const type of orderedTypes) output.push(...(records.get(type) ?? []));
  return output;
}

function emptyCounts(): LedgerArchiveCounts {
  return { ...EMPTY_COUNTS };
}

export function importLedgerArchive(database: SqliteDatabase | undefined, options: ImportLedgerArchiveOptions): LedgerArchiveImportResult {
  const parsed = parseArchive(options.content);
  if (options.workspace !== undefined && requireWorkspace(options.workspace) !== parsed.workspace) validation();
  validateGraph(parsed.records, parsed.workspace);
  if (database === undefined && !options.dryRun) databaseFailure();
  const imported = emptyCounts();
  const duplicates = emptyCounts();
  let conflicts = 0;
  const ordered = orderedForImport(parsed.records);
  if (database === undefined) {
    for (const record of ordered) imported[record.type as ArchiveRecordType] += 1;
    return { workspace: parsed.workspace, dryRun: true, counts: parsed.counts, imported, duplicates, conflicts };
  }
  const db = database;
  try {
    validateMemoryReferences(db, parsed.records, parsed.workspace);
    for (const record of ordered) {
      const type = record.type as ArchiveRecordType;
      try {
        const result = compareExisting(db, type, record, parsed.workspace);
        if (result === 'duplicate') duplicates[type] += 1;
        else imported[type] += 1;
      } catch (error) {
        if (options.dryRun && error instanceof KiokukoError && error.code === 'CONFLICT') {
          conflicts += 1;
          continue;
        }
        throw error;
      }
    }
    if (options.dryRun) return { workspace: parsed.workspace, dryRun: true, counts: parsed.counts, imported, duplicates, conflicts };
    withImmediateTransaction(db, () => {
      for (const record of ordered) {
        const type = record.type as ArchiveRecordType;
        if (duplicates[type] > 0 && selectExisting(db, type, record)) continue;
        insertRecord(db, type, record);
      }
    });
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    if (isSqliteCorruptionError(error)) integrity();
    throw error;
  }
  return { workspace: parsed.workspace, dryRun: false, counts: parsed.counts, imported, duplicates, conflicts };
}
