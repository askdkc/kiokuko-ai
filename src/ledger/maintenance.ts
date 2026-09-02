import { createHash } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { isSqliteCorruptionError } from '../db/sqlite-retry.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { findSecret } from '../memory/secrets.js';
import { sanitizeJson } from '../security/sanitize.js';
import { canonicalJson, GENESIS_HASH, hashLedgerEvent } from './hash.js';
import { entryOriginMatchesWorkspace, isContextEntryOrigin } from '../context/origin.js';
import { DEFAULT_NUDGE_RATE_LIMIT } from '../context/nudges.js';
import { parseStoredIdentifier, parseStoredNudgeDelivery, validateStoredNudgeHistory, type StoredNudgeDelivery } from '../context/nudge-validation.js';
import {
  CAPTURE_PROFILES,
  COVERAGE_LEVELS,
  LEDGER_EVENT_TYPES,
  RUN_STATUSES,
  type JsonValue,
  type Redaction,
} from './types.js';

export const LEDGER_CHECK_NAMES = [
  'runs', 'eventIdentity', 'eventHashChain', 'runCursors', 'runIntakes',
  'references', 'contextDeliveries', 'nudgeDeliveries', 'feedbackLinks', 'storedValues', 'secretResidue',
] as const;
export type LedgerCheckName = (typeof LEDGER_CHECK_NAMES)[number];

export interface LedgerFinding {
  check: LedgerCheckName;
  kind: string;
  category: string;
  idHash?: string;
}

export interface LedgerIntegrityCheck {
  ok: boolean;
  count: number;
  findingCount: number;
  findings: LedgerFinding[];
  truncated: boolean;
}
export type LedgerIntegrityChecks = Record<LedgerCheckName, LedgerIntegrityCheck>;

export interface LedgerIntegrityReport {
  ok: boolean;
  workspace: string | null;
  counts: {
    runs: number;
    events: number;
    evidence: number;
    deliveries: number;
    deliveryEntries: number;
    nudgeDeliveries: number;
    intakeFeedback: number;
    contextFeedback: number;
    runFeedback: number;
    memoryLinks: number;
    tombstones: number;
  };
  checks: LedgerIntegrityChecks;
  findings: LedgerFinding[];
  findingCount: number;
  findingsTruncated: boolean;
  tombstoneCount: number;
}

const MAX_FINDINGS = 100;
const MAX_FINDINGS_PER_CHECK = 25;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REDACTION_KINDS = new Set(['sensitive_key', 'secret_pattern', 'url', 'home_path', 'preview_truncated', 'environment_value', 'hidden_reasoning']);
const EVIDENCE_KINDS = new Set(['command', 'test', 'file', 'diff', 'url', 'artifact']);
const CONTEXT_FEEDBACK_VERDICTS = new Set(['helpful', 'irrelevant', 'stale', 'conflicting']);
const INTAKE_FEEDBACK_VERDICTS = new Set(['helpful', 'unnecessary', 'corrected']);
const RECOMMENDATION_VERDICTS = new Set(['accepted', 'dismissed', 'resolved']);
const SECRET_KEY = /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token)/iu;
type Row = SqliteRow & Record<string, unknown>;
type Counts = LedgerIntegrityReport['counts'];

type Run = Row & { run_id?: string };

type Event = Row & { run_id?: string; sequence?: number };

function errorValidation(message: string): never { throw new KiokukoError('VALIDATION_ERROR', message); }
function errorIntegrity(): never { throw new KiokukoError('INTEGRITY_ERROR', 'Ledger database integrity validation failed'); }
function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function nullableStr(value: unknown): string | null | undefined { return value === null ? null : str(value); }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined; }
function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function validTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function idHash(category: string, value: unknown): string | undefined {
  const text = str(value);
  return text === undefined || text.length === 0 ? undefined : createHash('sha256').update(`${category}:${text}`, 'utf8').digest('hex');
}
function rowCount(database: SqliteDatabase, sql: string, ...parameters: Array<string | number>): number {
  const value = database.prepare(sql).get<Row>(...parameters)?.count;
  const result = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function hasTable(database: SqliteDatabase, table: string): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS present
      FROM sqlite_master
     WHERE type = 'table' AND name = ?
  `).get(table));
}

function emptyChecks(): LedgerIntegrityChecks {
  return Object.fromEntries(LEDGER_CHECK_NAMES.map((name) => [name, { ok: true, count: 0, findingCount: 0, findings: [], truncated: false }])) as unknown as LedgerIntegrityChecks;
}

class FindingCollector {
  readonly findings: LedgerFinding[] = [];
  findingCount = 0;
  findingsTruncated = false;
  constructor(readonly checks: LedgerIntegrityChecks) {}
  add(checkName: LedgerCheckName, kind: string, category: string, value?: unknown): void {
    const check = this.checks[checkName];
    check.ok = false;
    check.findingCount += 1;
    this.findingCount += 1;
    const hash = idHash(category, value);
    const finding: LedgerFinding = { check: checkName, kind, category, ...(hash === undefined ? {} : { idHash: hash }) };
    if (check.findings.length < MAX_FINDINGS_PER_CHECK && this.findings.length < MAX_FINDINGS) {
      check.findings.push(finding);
      this.findings.push(finding);
    } else {
      check.truncated = true;
      this.findingsTruncated = true;
    }
  }
}

function scanValue(value: unknown): boolean {
  if (typeof value === 'string') return findSecret(value) !== undefined;
  if (Array.isArray(value)) return value.some(scanValue);
  if (isObject(value)) return Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || scanValue(child));
  return false;
}
function scanRow(row: Row, category: string, value: unknown, findings: FindingCollector): void {
  if (Object.entries(row).some(([key, item]) => SECRET_KEY.test(key) || scanValue(item))) findings.add('secretResidue', 'secret_residue', category, value);
}

function parseJson(
  raw: unknown,
  checks: readonly LedgerCheckName[],
  category: string,
  value: unknown,
  findings: FindingCollector,
  shape: 'any' | 'object' | 'array',
): unknown | undefined {
  if (typeof raw !== 'string') {
    for (const check of checks) findings.add(check, 'malformed_json', category, value);
    return undefined;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch (error) {
    if (error instanceof SyntaxError) {
      for (const check of checks) findings.add(check, 'malformed_json', category, value);
      return undefined;
    }
    throw error;
  }
  try {
    if (canonicalJson(parsed) !== raw) for (const check of checks) findings.add(check, 'noncanonical_json', category, value);
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') {
      for (const check of checks) findings.add(check, 'invalid_json_value', category, value);
      return undefined;
    }
    throw error;
  }
  if ((shape === 'object' && !isObject(parsed)) || (shape === 'array' && !Array.isArray(parsed))) {
    for (const check of checks) findings.add(check, 'invalid_json_shape', category, value);
    return undefined;
  }
  return parsed;
}
function validCoverage(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = ['run', 'tool', 'command', 'file', 'approval'];
  return Object.keys(value).length === keys.length && keys.every((key) => typeof value[key] === 'string' && COVERAGE_LEVELS.includes(value[key] as (typeof COVERAGE_LEVELS)[number]));
}
function validRedactions(value: unknown): value is Redaction[] {
  return Array.isArray(value) && value.every((item) => isObject(item) && typeof item.path === 'string' && typeof item.kind === 'string' && REDACTION_KINDS.has(item.kind));
}

function selectedEvents(database: SqliteDatabase, workspace: string | undefined): Event[] {
  if (workspace === undefined) return database.prepare('SELECT * FROM ledger_events ORDER BY run_id ASC, sequence ASC, event_id ASC').all<Event>();
  return database.prepare(`SELECT e.* FROM ledger_events AS e JOIN ledger_runs AS r ON r.run_id = e.run_id WHERE r.workspace = ? ORDER BY e.run_id ASC, e.sequence ASC, e.event_id ASC`).all<Event>(workspace);
}
function counts(database: SqliteDatabase, workspace: string | undefined, nudgeDeliveriesAvailable: boolean): Counts {
  const child = (table: string): number => workspace === undefined ? rowCount(database, `SELECT COUNT(*) AS count FROM ${table}`) : rowCount(database, `SELECT COUNT(*) AS count FROM ${table} AS c JOIN ledger_runs AS r ON r.run_id = c.run_id WHERE r.workspace = ?`, workspace);
  const entries = workspace === undefined ? rowCount(database, 'SELECT COUNT(*) AS count FROM context_delivery_entries') : rowCount(database, 'SELECT COUNT(*) AS count FROM context_delivery_entries AS e JOIN context_deliveries AS d ON d.delivery_id = e.delivery_id JOIN ledger_runs AS r ON r.run_id = d.run_id WHERE r.workspace = ?', workspace);
  const tombstones = workspace === undefined ? rowCount(database, 'SELECT COUNT(*) AS count FROM ledger_purge_audit') : rowCount(database, 'SELECT COUNT(*) AS count FROM ledger_purge_audit AS p JOIN ledger_runs AS r ON r.run_id = p.run_id WHERE r.workspace = ?', workspace);
  return {
    runs: workspace === undefined ? rowCount(database, 'SELECT COUNT(*) AS count FROM ledger_runs') : rowCount(database, 'SELECT COUNT(*) AS count FROM ledger_runs WHERE workspace = ?', workspace),
    events: child('ledger_events'), evidence: child('ledger_evidence'), deliveries: child('context_deliveries'), deliveryEntries: entries,
    nudgeDeliveries: nudgeDeliveriesAvailable ? child('nudge_deliveries') : 0, intakeFeedback: child('intake_feedback'), contextFeedback: child('context_feedback'), runFeedback: child('run_feedback'), memoryLinks: child('ledger_memory_links'), tombstones,
  };
}

function inspectRuns(rows: Run[], findings: FindingCollector): Map<string, Run> {
  const runs = new Map<string, Run>();
  for (const row of rows) {
    const runId = str(row.run_id) ?? '';
    runs.set(runId, row);
    const status = str(row.status);
    if (!status || !RUN_STATUSES.includes(status as (typeof RUN_STATUSES)[number])) {
      findings.add('runs', 'invalid_status', 'ledger_runs', row.run_id);
      findings.add('storedValues', 'invalid_enum', 'ledger_runs', row.run_id);
    }
    if (row.capture_profile === undefined || !CAPTURE_PROFILES.includes(row.capture_profile as (typeof CAPTURE_PROFILES)[number])) findings.add('runs', 'invalid_enum', 'ledger_runs', row.run_id);
    if (row.protocol_version !== '1') findings.add('runs', 'invalid_enum', 'ledger_runs', row.run_id);
    for (const field of ['started_at', 'created_at', 'updated_at']) if (!validTimestamp(row[field])) {
      findings.add('runs', 'invalid_timestamp', 'ledger_runs', row.run_id);
      findings.add('storedValues', 'invalid_timestamp', 'ledger_runs', row.run_id);
    }
    if (row.ended_at !== null && !validTimestamp(row.ended_at)) findings.add('runs', 'invalid_timestamp', 'ledger_runs', row.run_id);
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
    if (terminal !== (row.ended_at !== null)) findings.add('runs', 'terminal_ended_at_mismatch', 'ledger_runs', row.run_id);
    if (row.last_sequence === undefined || integer(row.last_sequence) === undefined || (row.last_sequence as number) < 0) findings.add('runCursors', 'invalid_last_sequence', 'ledger_runs', row.run_id);
    if (row.last_source_sequence !== null && (integer(row.last_source_sequence) === undefined || (row.last_source_sequence as number) < 0)) findings.add('runCursors', 'invalid_last_source_sequence', 'ledger_runs', row.run_id);
    if (row.task_hash !== null && (typeof row.task_hash !== 'string' || !HASH.test(row.task_hash))) findings.add('storedValues', 'invalid_hash_shape', 'ledger_runs', row.run_id);
    const metadata = parseJson(row.metadata_json, ['runs', 'storedValues'], 'ledger_runs.metadata_json', row.run_id, findings, 'object');
    const coverage = parseJson(row.coverage_json, ['runs', 'storedValues'], 'ledger_runs.coverage_json', row.run_id, findings, 'object');
    if (coverage !== undefined && !validCoverage(coverage)) findings.add('runs', 'invalid_coverage_shape', 'ledger_runs.coverage_json', row.run_id);
    if (metadata !== undefined && scanValue(metadata)) findings.add('secretResidue', 'secret_residue', 'ledger_runs.metadata_json', row.run_id);
    scanRow(row, 'ledger_runs', row.run_id, findings);
  }
  return runs;
}

function inspectEvents(rows: Event[], runs: Map<string, Run>, findings: FindingCollector): Map<string, Event[]> {
  const grouped = new Map<string, Event[]>();
  const eventIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const row of rows) {
    const runId = str(row.run_id) ?? '';
    const list = grouped.get(runId) ?? [];
    list.push(row);
    grouped.set(runId, list);
    const eventId = str(row.event_id);
    if (!eventId) findings.add('eventIdentity', 'invalid_event_id', 'ledger_events', row.event_id);
    else if (eventIds.has(eventId)) findings.add('eventIdentity', 'duplicate_event_id', 'ledger_events', eventId);
    else eventIds.add(eventId);
    const sourceEventId = nullableStr(row.source_event_id);
    if (sourceEventId !== null && sourceEventId !== undefined) {
      const sourceKey = `${runId}:${sourceEventId}`;
      if (sourceIds.has(sourceKey)) findings.add('eventIdentity', 'duplicate_source_event_id', 'ledger_events', sourceEventId);
      else sourceIds.add(sourceKey);
    }
    if (integer(row.sequence) === undefined || (row.sequence as number) < 1) {
      findings.add('eventIdentity', 'invalid_sequence', 'ledger_events', row.event_id);
      findings.add('storedValues', 'invalid_sequence', 'ledger_events', row.event_id);
    }
    if (typeof row.event_type !== 'string' || !LEDGER_EVENT_TYPES.includes(row.event_type as (typeof LEDGER_EVENT_TYPES)[number])) findings.add('storedValues', 'invalid_enum', 'ledger_events', row.event_id);
    if (typeof row.actor !== 'string' || row.actor.length === 0 || !validTimestamp(row.ingested_at)) findings.add('storedValues', 'invalid_text_or_timestamp', 'ledger_events', row.event_id);
    if (row.occurred_at !== null && !validTimestamp(row.occurred_at)) findings.add('storedValues', 'invalid_timestamp', 'ledger_events', row.event_id);
    if (row.source_sequence !== null && (integer(row.source_sequence) === undefined || (row.source_sequence as number) < 0)) findings.add('storedValues', 'invalid_source_sequence', 'ledger_events', row.event_id);
    const payload = parseJson(row.payload_json, ['storedValues', 'eventHashChain'], 'ledger_events.payload_json', row.event_id, findings, 'any');
    const redactions = parseJson(row.redaction_json, ['storedValues', 'eventHashChain'], 'ledger_events.redaction_json', row.event_id, findings, 'array');
    if (redactions !== undefined && !validRedactions(redactions)) findings.add('storedValues', 'invalid_redaction_shape', 'ledger_events.redaction_json', row.event_id);
    if (typeof row.previous_hash !== 'string' || !HASH.test(row.previous_hash) || typeof row.event_hash !== 'string' || !HASH.test(row.event_hash)) {
      findings.add('storedValues', 'invalid_hash_shape', 'ledger_events', row.event_id);
      findings.add('eventHashChain', 'invalid_hash_shape', 'ledger_events', row.event_id);
    }
    if ((payload !== undefined && scanValue(payload)) || (redactions !== undefined && scanValue(redactions))) findings.add('secretResidue', 'secret_residue', 'ledger_events', row.event_id);
    scanRow(row, 'ledger_events', row.event_id, findings);
  }
  for (const [runId, list] of grouped) {
    let expected = 1;
    let previous = GENESIS_HASH;
    let sourceMax: number | null = null;
    for (const row of list) {
      if (integer(row.sequence) !== expected) findings.add('eventIdentity', 'non_contiguous_sequence', 'ledger_events', row.event_id);
      expected = (integer(row.sequence) ?? expected) + 1;
      if (integer(row.source_sequence) !== undefined) sourceMax = sourceMax === null ? row.source_sequence as number : Math.max(sourceMax, row.source_sequence as number);
      if (row.previous_hash !== previous) findings.add('eventHashChain', 'previous_hash_mismatch', 'ledger_events', row.event_id);
      const payload = parseJson(row.payload_json, [], 'ledger_events.payload_json', row.event_id, findings, 'any');
      const redactions = parseJson(row.redaction_json, [], 'ledger_events.redaction_json', row.event_id, findings, 'array');
      if (integer(row.sequence) !== undefined && typeof row.event_type === 'string' && payload !== undefined && validRedactions(redactions)) {
        const calculated = hashLedgerEvent({
          runId, sequence: row.sequence as number, eventId: str(row.event_id) ?? '', previousHash: str(row.previous_hash) ?? '', eventType: row.event_type,
          ...(typeof row.source_event_id === 'string' ? { sourceEventId: row.source_event_id } : {}),
          ...(integer(row.source_sequence) === undefined ? {} : { sourceSequence: row.source_sequence as number }),
          ...(typeof row.source_type === 'string' ? { sourceType: row.source_type } : {}), actor: str(row.actor) ?? '',
          ...(typeof row.outcome === 'string' ? { outcome: row.outcome } : {}), ...(typeof row.occurred_at === 'string' ? { occurredAt: row.occurred_at } : {}),
          ingestedAt: str(row.ingested_at) ?? '', payload: payload as JsonValue, redaction: redactions,
        });
        if (calculated !== row.event_hash) findings.add('eventHashChain', 'hash_mismatch', 'ledger_events', row.event_id);
      }
      previous = str(row.event_hash) ?? '';
    }
    const run = runs.get(runId);
    if (!run) findings.add('references', 'orphan_event_run', 'ledger_events', runId);
    else {
      const maxSequence = list.reduce((max, row) => Math.max(max, integer(row.sequence) ?? 0), 0);
      if (integer(run.last_sequence) !== maxSequence) findings.add('runCursors', 'last_sequence_mismatch', 'ledger_runs', runId);
      const storedSource = run.last_source_sequence === null ? null : integer(run.last_source_sequence);
      if (storedSource !== sourceMax) findings.add('runCursors', 'last_source_sequence_mismatch', 'ledger_runs', runId);
    }
  }
  for (const [runId, run] of runs) if (!grouped.has(runId) && (integer(run.last_sequence) !== 0 || run.last_source_sequence !== null)) findings.add('runCursors', 'empty_run_cursor_mismatch', 'ledger_runs', runId);
  return grouped;
}

function inspectIntakes(database: SqliteDatabase, workspace: string | undefined, runs: Map<string, Run>, findings: FindingCollector): void {
  const sql = `SELECT ri.*, r.workspace AS run_workspace, r.status AS run_status, s.workspace AS session_workspace, s.status AS session_status FROM run_intakes AS ri LEFT JOIN ledger_runs AS r ON r.run_id = ri.run_id LEFT JOIN akinator_sessions AS s ON s.id = ri.session_id${workspace === undefined ? '' : ' WHERE r.workspace = ?'} ORDER BY ri.run_id ASC, ri.session_id ASC`;
  const rows = (workspace === undefined ? database.prepare(sql).all<Row>() : database.prepare(sql).all<Row>(workspace));
  const runIds = new Set<string>();
  const sessions = new Set<string>();
  for (const row of rows) {
    const runId = str(row.run_id) ?? '';
    const sessionId = str(row.session_id) ?? '';
    if (runIds.has(runId)) findings.add('runIntakes', 'duplicate_run_intake', 'run_intakes', runId);
    if (sessions.has(sessionId)) findings.add('runIntakes', 'duplicate_session_intake', 'run_intakes', sessionId);
    runIds.add(runId); sessions.add(sessionId);
    if (!runs.has(runId) || row.session_workspace === null || row.session_workspace === undefined) findings.add('references', 'orphan_intake_reference', 'run_intakes', runId);
    if (row.run_workspace !== row.session_workspace) findings.add('runIntakes', 'workspace_mismatch', 'run_intakes', runId);
    if (!['active', 'ready', 'exhausted'].includes(str(row.session_status) ?? '')) findings.add('runIntakes', 'invalid_session_status', 'run_intakes', sessionId);
    if (row.finalized_at !== null && !validTimestamp(row.finalized_at)) findings.add('runIntakes', 'invalid_finalized_at', 'run_intakes', runId);
    if (row.session_status === 'active' && row.finalized_at !== null) findings.add('runIntakes', 'active_session_finalized', 'run_intakes', runId);
    if (['ready', 'exhausted'].includes(str(row.session_status) ?? '') && row.finalized_at === null) findings.add('runIntakes', 'missing_finalization', 'run_intakes', runId);
    if (row.run_status === 'active' && !['ready', 'exhausted'].includes(str(row.session_status) ?? '')) findings.add('runIntakes', 'active_before_intake_finalization', 'run_intakes', runId);
    if (row.run_status === 'intake' && ['ready', 'exhausted'].includes(str(row.session_status) ?? '')) findings.add('runIntakes', 'run_not_activated_after_finalization', 'run_intakes', runId);
    if (typeof row.policy_version !== 'string' || row.policy_version.length === 0) findings.add('storedValues', 'invalid_text', 'run_intakes', runId);
    if (integer(row.profile_schema_version) === undefined || (row.profile_schema_version as number) < 1) findings.add('storedValues', 'invalid_profile_schema_version', 'run_intakes', runId);
    if (!validTimestamp(row.linked_at)) findings.add('storedValues', 'invalid_timestamp', 'run_intakes', runId);
    parseJson(row.profile_sources_json, ['runIntakes', 'storedValues'], 'run_intakes.profile_sources_json', runId, findings, 'object');
    parseJson(row.recommended_tags_json, ['runIntakes', 'storedValues'], 'run_intakes.recommended_tags_json', runId, findings, 'array');
    if (row.initial_profile_hash !== null && (typeof row.initial_profile_hash !== 'string' || !HASH.test(row.initial_profile_hash))) findings.add('runIntakes', 'invalid_hash_shape', 'run_intakes', runId);
    scanRow(row, 'run_intakes', runId, findings);
  }
}

function inspectReferences(database: SqliteDatabase, workspace: string | undefined, findings: FindingCollector): void {
  const scope = workspace === undefined ? '' : ' WHERE r.workspace = ?';
  const param = workspace === undefined ? [] : [workspace];
  const evidence = database.prepare(`SELECT le.*, r.workspace AS run_workspace, e.run_id AS event_run_id FROM ledger_evidence AS le LEFT JOIN ledger_runs AS r ON r.run_id = le.run_id LEFT JOIN ledger_events AS e ON e.event_id = le.event_id${scope} ORDER BY le.evidence_id ASC`).all<Row>(...param);
  for (const row of evidence) {
    if (row.run_workspace === null || row.run_workspace === undefined || (row.event_id !== null && row.event_run_id !== row.run_id)) findings.add('references', 'orphan_evidence_reference', 'ledger_evidence', row.evidence_id);
    if (!EVIDENCE_KINDS.has(str(row.kind) ?? '')) findings.add('storedValues', 'invalid_enum', 'ledger_evidence', row.evidence_id);
    if (!validTimestamp(row.created_at)) findings.add('storedValues', 'invalid_timestamp', 'ledger_evidence', row.evidence_id);
    if (row.byte_size !== null && (integer(row.byte_size) === undefined || (row.byte_size as number) < 0)) findings.add('storedValues', 'invalid_byte_size', 'ledger_evidence', row.evidence_id);
    scanRow(row, 'ledger_evidence', row.evidence_id, findings);
  }
  const deliveries = database.prepare(`SELECT cd.delivery_id, cd.run_id, cd.through_sequence, cd.intake_session_id, cd.task_profile_hash, cd.query_hash, cd.policy_version, cd.char_budget, cd.char_count, cd.truncated, cd.created_at, cd.score_schema_version, r.workspace AS run_workspace, s.workspace AS intake_workspace FROM context_deliveries AS cd LEFT JOIN ledger_runs AS r ON r.run_id = cd.run_id LEFT JOIN akinator_sessions AS s ON s.id = cd.intake_session_id${scope} ORDER BY cd.delivery_id ASC`).all<Row>(...param);
  for (const row of deliveries) {
    if (row.run_workspace === null || row.run_workspace === undefined) findings.add('references', 'orphan_delivery_run', 'context_deliveries', row.delivery_id);
    if (row.intake_session_id !== null && row.intake_workspace !== row.run_workspace) findings.add('references', 'delivery_intake_workspace_mismatch', 'context_deliveries', row.delivery_id);
    scanRow(row, 'context_deliveries', row.delivery_id, findings);
  }
  const entries = database.prepare(`SELECT cde.*, cd.run_id, r.workspace AS run_workspace, er.workspace AS revision_workspace, e.workspace AS entry_workspace FROM context_delivery_entries AS cde LEFT JOIN context_deliveries AS cd ON cd.delivery_id = cde.delivery_id LEFT JOIN ledger_runs AS r ON r.run_id = cd.run_id LEFT JOIN entry_revisions AS er ON er.entry_id = cde.entry_id AND er.revision = cde.entry_revision LEFT JOIN entries AS e ON e.id = cde.entry_id${scope} ORDER BY cde.delivery_id ASC, cde.entry_id ASC`).all<Row>(...param);
  for (const row of entries) {
    const origin = isContextEntryOrigin(row.origin_scope) ? row.origin_scope : null;
    const entryWorkspaceMatches = origin !== null
      && typeof row.run_workspace === 'string'
      && typeof row.entry_workspace === 'string'
      && entryOriginMatchesWorkspace({ origin, runWorkspace: row.run_workspace, entryWorkspace: row.entry_workspace });
    if (origin === null) findings.add('storedValues', 'invalid_enum', 'context_delivery_entries', row.entry_id);
    if (row.run_id === null || row.run_id === undefined || row.revision_workspace === null || row.revision_workspace === undefined || !entryWorkspaceMatches || row.revision_workspace !== row.entry_workspace) findings.add('references', 'orphan_delivery_entry_reference', 'context_delivery_entries', row.entry_id);
    if (integer(row.entry_revision) === undefined || (row.entry_revision as number) < 1) findings.add('contextDeliveries', 'invalid_entry_revision', 'context_delivery_entries', row.entry_id);
    if (integer(row.rank) === undefined || (row.rank as number) < 1) findings.add('contextDeliveries', 'invalid_rank', 'context_delivery_entries', row.entry_id);
    parseJson(row.score_components_json, ['contextDeliveries', 'storedValues'], 'context_delivery_entries.score_components_json', row.entry_id, findings, 'object');
    // Context delivery writers store the ordered selection reasons as a JSON
    // array. Keep the ledger check aligned with context/delivery.ts.
    parseJson(row.selection_reason_json, ['contextDeliveries', 'storedValues'], 'context_delivery_entries.selection_reason_json', row.entry_id, findings, 'array');
    scanRow(row, 'context_delivery_entries', row.entry_id, findings);
  }
}

function inspectContext(database: SqliteDatabase, workspace: string | undefined, runs: Map<string, Run>, findings: FindingCollector): void {
  const scope = workspace === undefined ? '' : ' WHERE r.workspace = ?';
  const param = workspace === undefined ? [] : [workspace];
  const deliveries = database.prepare(`SELECT cd.delivery_id, cd.run_id, cd.through_sequence, cd.intake_session_id, cd.task_profile_hash, cd.query_hash, cd.policy_version, cd.char_budget, cd.char_count, cd.truncated, cd.created_at, cd.score_schema_version, r.last_sequence AS run_last_sequence FROM context_deliveries AS cd LEFT JOIN ledger_runs AS r ON r.run_id = cd.run_id${scope} ORDER BY cd.delivery_id ASC`).all<Row>(...param);
  for (const row of deliveries) {
    const through = integer(row.through_sequence); const last = integer(row.run_last_sequence);
    if (through === undefined || through < 0 || last === undefined || through > last) findings.add('contextDeliveries', 'through_sequence_out_of_range', 'context_deliveries', row.delivery_id);
    const budget = integer(row.char_budget); const chars = integer(row.char_count);
    if (budget === undefined || budget < 0 || chars === undefined || chars < 0 || chars > budget) findings.add('contextDeliveries', 'char_budget_mismatch', 'context_deliveries', row.delivery_id);
    if (row.truncated !== 0 && row.truncated !== 1) findings.add('contextDeliveries', 'invalid_truncated_flag', 'context_deliveries', row.delivery_id);
    if (typeof row.task_profile_hash !== 'string' || !HASH.test(row.task_profile_hash)) findings.add('storedValues', 'invalid_hash_shape', 'context_deliveries', row.delivery_id);
    if (typeof row.query_hash !== 'string' || !HASH.test(row.query_hash)) findings.add('storedValues', 'invalid_hash_shape', 'context_deliveries', row.delivery_id);
    if (typeof row.policy_version !== 'string' || row.policy_version.length === 0) findings.add('storedValues', 'invalid_text', 'context_deliveries', row.delivery_id);
    if (!validTimestamp(row.created_at)) findings.add('contextDeliveries', 'invalid_timestamp', 'context_deliveries', row.delivery_id);
    if (!runs.has(str(row.run_id) ?? '')) findings.add('references', 'orphan_delivery_run', 'context_deliveries', row.delivery_id);
  }
}

function inspectNudgeDeliveries(database: SqliteDatabase, workspace: string | undefined, findings: FindingCollector): void {
  const scope = workspace === undefined ? '' : ' WHERE r.workspace = ?';
  const parameters = workspace === undefined ? [] : [workspace];
  const rows = database.prepare(`
    SELECT d.*, r.last_sequence AS run_last_sequence
      FROM nudge_deliveries AS d
      LEFT JOIN ledger_runs AS r ON r.run_id = d.run_id${scope}
     ORDER BY d.id ASC
  `).all<Row>(...parameters);
  const eventRows = database.prepare('SELECT event_id, run_id, sequence FROM ledger_events').all<Row>();
  const eventById = new Map(eventRows.map((row) => [String(row.event_id), row]));
  const histories = new Map<string, StoredNudgeDelivery[]>();

  for (const row of rows) {
    let stored: StoredNudgeDelivery;
    try {
      parseStoredIdentifier(row.run_id, 'runId');
      stored = parseStoredNudgeDelivery(row);
    } catch (error) {
      if (!(error instanceof KiokukoError) || error.code !== 'INTEGRITY_ERROR') throw error;
      findings.add('nudgeDeliveries', 'invalid_row', 'nudge_deliveries', row.id);
      findings.add('storedValues', 'invalid_nudge_row', 'nudge_deliveries', row.id);
      scanRow(row, 'nudge_deliveries', row.id, findings);
      continue;
    }

    if (integer(row.run_last_sequence) === undefined) {
      findings.add('nudgeDeliveries', 'orphan_nudge_run', 'nudge_deliveries', row.id);
    } else if (stored.throughSequence > (row.run_last_sequence as number)) {
      findings.add('nudgeDeliveries', 'through_sequence_out_of_range', 'nudge_deliveries', row.id);
    }
    const historyKey = `${row.run_id}\u0000${stored.policyVersion}`;
    const history = histories.get(historyKey) ?? [];
    history.push(stored);
    histories.set(historyKey, history);
    for (const eventId of stored.evidenceEventIds) {
      const event = eventById.get(eventId);
      if (!event || event.run_id !== row.run_id || integer(event.sequence) === undefined || (event.sequence as number) > stored.throughSequence) {
        findings.add('nudgeDeliveries', 'invalid_evidence_event_reference', 'nudge_deliveries', row.id);
        break;
      }
    }
    scanRow(row, 'nudge_deliveries', row.id, findings);
  }

  for (const history of histories.values()) {
    try {
      validateStoredNudgeHistory(history, DEFAULT_NUDGE_RATE_LIMIT);
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR') {
        findings.add('nudgeDeliveries', 'invalid_history', 'nudge_deliveries', history[0]?.id);
        continue;
      }
      throw error;
    }
  }
}

function inspectFeedback(database: SqliteDatabase, workspace: string | undefined, findings: FindingCollector): void {
  const scope = workspace === undefined ? '' : ' WHERE r.workspace = ?';
  const param = workspace === undefined ? [] : [workspace];
  const context = database.prepare(`SELECT cf.*, r.workspace AS run_workspace, cd.run_id AS delivery_run_id, cde.entry_id AS linked_entry_id, cde.origin_scope AS origin_scope, e.workspace AS entry_workspace, er.workspace AS revision_workspace FROM context_feedback AS cf LEFT JOIN ledger_runs AS r ON r.run_id = cf.run_id LEFT JOIN context_deliveries AS cd ON cd.delivery_id = cf.delivery_id LEFT JOIN context_delivery_entries AS cde ON cde.delivery_id = cf.delivery_id AND cde.entry_id = cf.entry_id LEFT JOIN entries AS e ON e.id = cf.entry_id LEFT JOIN entry_revisions AS er ON er.entry_id = cde.entry_id AND er.revision = cde.entry_revision${scope} ORDER BY cf.feedback_id ASC`).all<Row>(...param);
  for (const row of context) {
    const origin = isContextEntryOrigin(row.origin_scope) ? row.origin_scope : null;
    const entryWorkspaceMatches = origin !== null
      && typeof row.run_workspace === 'string'
      && typeof row.entry_workspace === 'string'
      && entryOriginMatchesWorkspace({ origin, runWorkspace: row.run_workspace, entryWorkspace: row.entry_workspace });
    if (origin === null) findings.add('storedValues', 'invalid_enum', 'context_delivery_entries', row.entry_id);
    if (row.run_workspace === null || row.run_workspace === undefined || row.delivery_run_id !== row.run_id || row.linked_entry_id !== row.entry_id || !entryWorkspaceMatches || row.revision_workspace !== row.entry_workspace) findings.add('feedbackLinks', 'feedback_tuple_mismatch', 'context_feedback', row.feedback_id);
    if (!CONTEXT_FEEDBACK_VERDICTS.has(str(row.verdict) ?? '')) findings.add('feedbackLinks', 'invalid_feedback_verdict', 'context_feedback', row.feedback_id);
    if (typeof row.actor !== 'string' || row.actor.length === 0) findings.add('storedValues', 'invalid_text', 'context_feedback', row.feedback_id);
    if (typeof row.idempotency_key !== 'string' || !HASH.test(row.idempotency_key)) findings.add('storedValues', 'invalid_hash_shape', 'context_feedback', row.feedback_id);
    if (!validTimestamp(row.created_at)) findings.add('storedValues', 'invalid_timestamp', 'context_feedback', row.feedback_id);
    scanRow(row, 'context_feedback', row.feedback_id, findings);
  }
  const run = database.prepare(`SELECT rf.*, r.workspace AS run_workspace FROM run_feedback AS rf LEFT JOIN ledger_runs AS r ON r.run_id = rf.run_id${scope} ORDER BY rf.feedback_id ASC`).all<Row>(...param);
  for (const row of run) {
    if (row.run_workspace === null || row.run_workspace === undefined) findings.add('feedbackLinks', 'orphan_run_feedback', 'run_feedback', row.feedback_id);
    if (row.recommendation_verdict !== null && !RECOMMENDATION_VERDICTS.has(str(row.recommendation_verdict) ?? '')) findings.add('feedbackLinks', 'invalid_recommendation_verdict', 'run_feedback', row.feedback_id);
    if ((row.recommendation_code === null) !== (row.recommendation_verdict === null)) findings.add('feedbackLinks', 'recommendation_tuple_mismatch', 'run_feedback', row.feedback_id);
    if (row.rating !== null && (integer(row.rating) === undefined || (row.rating as number) < 1 || (row.rating as number) > 5)) findings.add('feedbackLinks', 'invalid_rating', 'run_feedback', row.feedback_id);
    if (row.outcome === null && row.recommendation_code === null && row.rating === null) findings.add('feedbackLinks', 'empty_feedback', 'run_feedback', row.feedback_id);
    if (typeof row.actor !== 'string' || row.actor.length === 0) findings.add('storedValues', 'invalid_text', 'run_feedback', row.feedback_id);
    if (typeof row.idempotency_key !== 'string' || !HASH.test(row.idempotency_key)) findings.add('storedValues', 'invalid_hash_shape', 'run_feedback', row.feedback_id);
    if (!validTimestamp(row.created_at)) findings.add('storedValues', 'invalid_timestamp', 'run_feedback', row.feedback_id);
    scanRow(row, 'run_feedback', row.feedback_id, findings);
  }
  const intake = database.prepare(`SELECT ifb.*, r.workspace AS run_workspace, s.workspace AS session_workspace, ri.session_id AS linked_session_id FROM intake_feedback AS ifb LEFT JOIN ledger_runs AS r ON r.run_id = ifb.run_id LEFT JOIN akinator_sessions AS s ON s.id = ifb.session_id LEFT JOIN run_intakes AS ri ON ri.run_id = ifb.run_id AND ri.session_id = ifb.session_id${scope} ORDER BY ifb.feedback_id ASC`).all<Row>(...param);
  for (const row of intake) {
    if (row.run_workspace === null || row.run_workspace === undefined || row.session_workspace !== row.run_workspace || row.linked_session_id !== row.session_id) findings.add('feedbackLinks', 'intake_feedback_tuple_mismatch', 'intake_feedback', row.feedback_id);
    if (!INTAKE_FEEDBACK_VERDICTS.has(str(row.verdict) ?? '')) findings.add('feedbackLinks', 'invalid_feedback_verdict', 'intake_feedback', row.feedback_id);
    if ((row.question_id === null) === (row.profile_field === null)) findings.add('feedbackLinks', 'invalid_feedback_target', 'intake_feedback', row.feedback_id);
    if (typeof row.actor !== 'string' || row.actor.length === 0) findings.add('storedValues', 'invalid_text', 'intake_feedback', row.feedback_id);
    if (typeof row.idempotency_key !== 'string' || !HASH.test(row.idempotency_key)) findings.add('storedValues', 'invalid_hash_shape', 'intake_feedback', row.feedback_id);
    if (!validTimestamp(row.created_at)) findings.add('storedValues', 'invalid_timestamp', 'intake_feedback', row.feedback_id);
    scanRow(row, 'intake_feedback', row.feedback_id, findings);
  }
  const links = database.prepare(`SELECT l.*, r.workspace AS run_workspace, ev.run_id AS event_run_id, d.run_id AS delivery_run_id, e.workspace AS entry_workspace FROM ledger_memory_links AS l LEFT JOIN ledger_runs AS r ON r.run_id = l.run_id LEFT JOIN ledger_events AS ev ON ev.event_id = l.event_id LEFT JOIN context_deliveries AS d ON d.delivery_id = l.delivery_id LEFT JOIN entries AS e ON e.id = l.entry_id${scope} ORDER BY l.link_id ASC`).all<Row>(...param);
  for (const row of links) {
    if (row.run_workspace === null || row.run_workspace === undefined || (row.entry_workspace !== row.run_workspace && row.entry_workspace !== 'global')) findings.add('references', 'orphan_memory_link', 'ledger_memory_links', row.link_id);
    if (row.event_id === null && row.delivery_id === null) findings.add('feedbackLinks', 'memory_link_without_source', 'ledger_memory_links', row.link_id);
    if (row.event_id !== null && row.event_run_id !== row.run_id) findings.add('feedbackLinks', 'memory_link_event_mismatch', 'ledger_memory_links', row.link_id);
    if (row.delivery_id !== null && row.delivery_run_id !== row.run_id) findings.add('feedbackLinks', 'memory_link_delivery_mismatch', 'ledger_memory_links', row.link_id);
    if (!validTimestamp(row.created_at)) findings.add('storedValues', 'invalid_timestamp', 'ledger_memory_links', row.link_id);
    scanRow(row, 'ledger_memory_links', row.link_id, findings);
  }
}

function inspectTombstones(database: SqliteDatabase, workspace: string | undefined, findings: FindingCollector): number {
  const rows = workspace === undefined ? database.prepare('SELECT * FROM ledger_purge_audit ORDER BY purge_id ASC').all<Row>() : database.prepare('SELECT p.* FROM ledger_purge_audit AS p JOIN ledger_runs AS r ON r.run_id = p.run_id WHERE r.workspace = ? ORDER BY p.purge_id ASC').all<Row>(workspace);
  for (const row of rows) {
    if (typeof row.purge_id !== 'string' || row.purge_id.length === 0) findings.add('storedValues', 'invalid_tombstone_id', 'ledger_purge_audit', row.purge_id);
    if (!PURGE_TARGET_TYPES.includes(row.target_type as PurgeTargetType)) findings.add('storedValues', 'invalid_tombstone_target_type', 'ledger_purge_audit', row.purge_id);
    if (typeof row.target_id !== 'string' || row.target_id.length === 0 || typeof row.actor !== 'string' || row.actor.length === 0) findings.add('storedValues', 'invalid_tombstone_text', 'ledger_purge_audit', row.purge_id);
    if (!validTimestamp(row.created_at)) findings.add('storedValues', 'invalid_timestamp', 'ledger_purge_audit', row.purge_id);
    scanRow(row, 'ledger_purge_audit', row.purge_id, findings);
  }
  return rows.length;
}

export function inspectLedger(database: SqliteDatabase, options: { workspace?: string } = {}): LedgerIntegrityReport {
  if (options.workspace !== undefined && (typeof options.workspace !== 'string' || options.workspace.length === 0)) errorValidation('workspace must be a non-empty string');
  try {
    const workspace = options.workspace;
    const nudgeDeliveriesAvailable = hasTable(database, 'nudge_deliveries');
    const nudgeDeliveriesRequired = true;
    const reportCounts = counts(database, workspace, nudgeDeliveriesAvailable);
    const checks = emptyChecks();
    const findings = new FindingCollector(checks);
    const runRows = workspace === undefined ? database.prepare('SELECT * FROM ledger_runs ORDER BY run_id ASC').all<Run>() : database.prepare('SELECT * FROM ledger_runs WHERE workspace = ? ORDER BY run_id ASC').all<Run>(workspace);
    const eventRows = selectedEvents(database, workspace);
    const runs = inspectRuns(runRows, findings);
    inspectEvents(eventRows, runs, findings);
    inspectIntakes(database, workspace, runs, findings);
    inspectReferences(database, workspace, findings);
    inspectContext(database, workspace, runs, findings);
    if (nudgeDeliveriesRequired && !nudgeDeliveriesAvailable) {
      findings.add('nudgeDeliveries', 'missing_table', 'nudge_deliveries');
    }
    if (nudgeDeliveriesAvailable) inspectNudgeDeliveries(database, workspace, findings);
    inspectFeedback(database, workspace, findings);
    const tombstoneCount = inspectTombstones(database, workspace, findings);
    checks.runs.count = reportCounts.runs;
    checks.eventIdentity.count = reportCounts.events;
    checks.eventHashChain.count = reportCounts.events;
    checks.runCursors.count = reportCounts.runs;
    checks.runIntakes.count = workspace === undefined ? rowCount(database, 'SELECT COUNT(*) AS count FROM run_intakes') : rowCount(database, 'SELECT COUNT(*) AS count FROM run_intakes AS i JOIN ledger_runs AS r ON r.run_id = i.run_id WHERE r.workspace = ?', workspace);
    checks.references.count = reportCounts.evidence + reportCounts.deliveries + reportCounts.deliveryEntries + reportCounts.nudgeDeliveries + reportCounts.memoryLinks;
    checks.contextDeliveries.count = reportCounts.deliveries + reportCounts.deliveryEntries;
    checks.feedbackLinks.count = reportCounts.intakeFeedback + reportCounts.contextFeedback + reportCounts.runFeedback + reportCounts.memoryLinks;
    checks.nudgeDeliveries.count = reportCounts.nudgeDeliveries;
    checks.storedValues.count = runRows.length + eventRows.length + reportCounts.evidence + reportCounts.deliveries + reportCounts.deliveryEntries + reportCounts.nudgeDeliveries + reportCounts.intakeFeedback + reportCounts.contextFeedback + reportCounts.runFeedback + reportCounts.memoryLinks + tombstoneCount;
    checks.secretResidue.count = checks.storedValues.count;
    return { ok: LEDGER_CHECK_NAMES.every((name) => checks[name].ok), workspace: workspace ?? null, counts: reportCounts, checks, findings: findings.findings, findingCount: findings.findingCount, findingsTruncated: findings.findingsTruncated, tombstoneCount };
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    if (isSqliteCorruptionError(error)) errorIntegrity();
    throw error;
  }
}

export const PURGE_TARGET_TYPES = ['run', 'event', 'evidence', 'delivery', 'feedback', 'memory_link'] as const;
export type PurgeTargetType = (typeof PURGE_TARGET_TYPES)[number];
export const PURGE_BACKUP_WARNING = 'Backups may retain purged content and must be managed separately.';
export interface LedgerPurgeTombstone { purgeId: string; runId: string | null; eventId: string | null; deliveryId: string | null; entryId: string | null; targetType: PurgeTargetType; targetId: string; actor: string; reason: string | null; createdAt: string; }
export interface PurgeResult { purgeId: string; targetType: PurgeTargetType; targetId: string; deletedCount: number; replayed: boolean; tombstone: LedgerPurgeTombstone; backupWarning: typeof PURGE_BACKUP_WARNING; }

type ValidatedPurge = { workspace: string; targetType: PurgeTargetType; targetId: string; actor: string; reason: string | null; createdAt: string; purgeId: string; };
const PURGE_FIELDS = new Set(['workspace', 'targetType', 'targetId', 'actor', 'reason', 'createdAt', 'purgeId', 'confirmed']);
const PURGE_TYPES = new Set(PURGE_TARGET_TYPES);
const PURGE_NOT_FOUND = 'Ledger purge target was not found';
const PURGE_CONFLICT = 'Ledger purge conflicts with an existing purge';
const EVENT_PURGE_CONFLICT = 'Single-event purge is not permitted because it would corrupt the hash chain';
function boundedPurgeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\u0000')) errorValidation(`${label} must be a non-empty bounded string`);
  if (findSecret(value)) throw new KiokukoError('SECURITY_REJECTION', 'Purge input was rejected by privacy security policy');
  return value;
}
function normalizePurge(value: unknown): ValidatedPurge {
  if (!isObject(value) || Object.keys(value).some((key) => !PURGE_FIELDS.has(key))) errorValidation('Invalid ledger purge input');
  if (value.confirmed !== true) throw new KiokukoError('VALIDATION_ERROR', 'Explicit purge confirmation is required');
  const workspace = boundedPurgeText(value.workspace, 'workspace');
  if (typeof value.targetType !== 'string' || !PURGE_TYPES.has(value.targetType as PurgeTargetType)) errorValidation('Invalid ledger purge target type');
  const targetType = value.targetType as PurgeTargetType;
  const targetId = boundedPurgeText(value.targetId, 'targetId');
  const actor = boundedPurgeText(value.actor, 'actor');
  if (!validTimestamp(value.createdAt)) errorValidation('createdAt must be an ISO-8601 UTC timestamp');
  const purgeId = boundedPurgeText(value.purgeId, 'purgeId');
  let reason: string | null = null;
  if (value.reason !== undefined && value.reason !== null) {
    if (typeof value.reason !== 'string') errorValidation('reason must be a bounded string');
    const sanitized: unknown = sanitizeJson(value.reason).value;
    if (typeof sanitized !== 'string' || Buffer.byteLength(sanitized, 'utf8') > 2048) errorValidation('reason must be a bounded string');
    if (findSecret(sanitized)) throw new KiokukoError('SECURITY_REJECTION', 'Purge input was rejected by privacy security policy');
    reason = sanitized;
  }
  return { workspace, targetType, targetId, actor, reason, createdAt: value.createdAt as string, purgeId };
}
function tombstone(row: Row): LedgerPurgeTombstone { return { purgeId: str(row.purge_id) ?? '', runId: nullableStr(row.run_id) ?? null, eventId: nullableStr(row.event_id) ?? null, deliveryId: nullableStr(row.delivery_id) ?? null, entryId: nullableStr(row.entry_id) ?? null, targetType: row.target_type as PurgeTargetType, targetId: str(row.target_id) ?? '', actor: str(row.actor) ?? '', reason: nullableStr(row.reason) ?? null, createdAt: str(row.created_at) ?? '' }; }
function purgeResult(value: LedgerPurgeTombstone, deletedCount: number, replayed: boolean): PurgeResult { return { purgeId: value.purgeId, targetType: value.targetType, targetId: value.targetId, deletedCount, replayed, tombstone: value, backupWarning: PURGE_BACKUP_WARNING }; }
function samePurge(database: SqliteDatabase, input: ValidatedPurge, value: LedgerPurgeTombstone): boolean {
  const storedWorkspace = value.runId === null
    ? undefined
    : str(database.prepare('SELECT workspace FROM ledger_runs WHERE run_id = ?').get<Row>(value.runId)?.workspace);
  return input.purgeId === value.purgeId
    && (storedWorkspace === undefined || storedWorkspace === input.workspace)
    && input.targetType === value.targetType
    && input.targetId === value.targetId
    && input.actor === value.actor
    && input.reason === value.reason
    && input.createdAt === value.createdAt;
}
function target(database: SqliteDatabase, input: ValidatedPurge): Row | undefined {
  const id = input.targetId; const workspace = input.workspace;
  switch (input.targetType) {
    case 'run': return database.prepare('SELECT run_id, workspace FROM ledger_runs WHERE run_id = ? AND workspace = ?').get<Row>(id, workspace);
    case 'event': return database.prepare('SELECT e.event_id, e.run_id FROM ledger_events AS e JOIN ledger_runs AS r ON r.run_id = e.run_id WHERE e.event_id = ? AND r.workspace = ?').get<Row>(id, workspace);
    case 'evidence': return database.prepare('SELECT le.evidence_id, le.run_id, le.event_id FROM ledger_evidence AS le JOIN ledger_runs AS r ON r.run_id = le.run_id WHERE le.evidence_id = ? AND r.workspace = ?').get<Row>(id, workspace);
    case 'delivery': return database.prepare('SELECT cd.delivery_id, cd.run_id FROM context_deliveries AS cd JOIN ledger_runs AS r ON r.run_id = cd.run_id WHERE cd.delivery_id = ? AND r.workspace = ?').get<Row>(id, workspace);
    case 'memory_link': return database.prepare('SELECT l.link_id, l.run_id, l.event_id, l.delivery_id, l.entry_id FROM ledger_memory_links AS l JOIN ledger_runs AS r ON r.run_id = l.run_id WHERE l.link_id = ? AND r.workspace = ?').get<Row>(id, workspace);
    case 'feedback': {
      const rows = [
        database.prepare("SELECT feedback_id, run_id, 'context' AS feedback_table FROM context_feedback AS f JOIN ledger_runs AS r ON r.run_id = f.run_id WHERE f.feedback_id = ? AND r.workspace = ?").get<Row>(id, workspace),
        database.prepare("SELECT feedback_id, run_id, 'run' AS feedback_table FROM run_feedback AS f JOIN ledger_runs AS r ON r.run_id = f.run_id WHERE f.feedback_id = ? AND r.workspace = ?").get<Row>(id, workspace),
        database.prepare("SELECT feedback_id, run_id, 'intake' AS feedback_table FROM intake_feedback AS f JOIN ledger_runs AS r ON r.run_id = f.run_id WHERE f.feedback_id = ? AND r.workspace = ?").get<Row>(id, workspace),
      ].filter((row): row is Row => row !== undefined);
      if (rows.length > 1) throw new KiokukoError('CONFLICT', PURGE_CONFLICT);
      return rows[0];
    }
  }
}
function insertPurgeTombstone(database: SqliteDatabase, input: ValidatedPurge, row: Row): LedgerPurgeTombstone {
  const runId = input.targetType === 'run' ? input.targetId : nullableStr(row.run_id) ?? null;
  const eventId = input.targetType === 'evidence' || input.targetType === 'memory_link' ? nullableStr(row.event_id) ?? null : null;
  const deliveryId = input.targetType === 'delivery' ? input.targetId : input.targetType === 'memory_link' ? nullableStr(row.delivery_id) ?? null : null;
  const entryId = input.targetType === 'memory_link' ? nullableStr(row.entry_id) ?? null : null;
  database.prepare('INSERT INTO ledger_purge_audit (purge_id, run_id, event_id, delivery_id, entry_id, target_type, target_id, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.purgeId, runId, eventId, deliveryId, entryId, input.targetType, input.targetId, input.actor, input.reason, input.createdAt);
  const saved = database.prepare('SELECT * FROM ledger_purge_audit WHERE purge_id = ?').get<Row>(input.purgeId);
  if (!saved) throw new KiokukoError('INTEGRITY_ERROR', 'Ledger purge tombstone could not be read back');
  return tombstone(saved);
}
function runGraphCount(database: SqliteDatabase, runId: string): number {
  let total = 1;
  for (const table of ['run_intakes', 'intake_feedback', 'ledger_events', 'ledger_evidence', 'context_deliveries', 'nudge_deliveries', 'context_feedback', 'run_feedback', 'ledger_memory_links']) total += rowCount(database, `SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`, runId);
  total += rowCount(database, 'SELECT COUNT(*) AS count FROM context_delivery_entries AS e JOIN context_deliveries AS d ON d.delivery_id = e.delivery_id WHERE d.run_id = ?', runId);
  const session = database.prepare('SELECT session_id FROM run_intakes WHERE run_id = ?').get<{ session_id: string }>(runId);
  if (session) { total += rowCount(database, 'SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?', session.session_id); total += rowCount(database, 'SELECT COUNT(*) AS count FROM akinator_sessions WHERE id = ?', session.session_id); }
  return total;
}
function executePurge(database: SqliteDatabase, input: ValidatedPurge, row: Row): { value: LedgerPurgeTombstone; count: number } {
  if (input.targetType === 'event') throw new KiokukoError('CONFLICT', EVENT_PURGE_CONFLICT);
  insertPurgeTombstone(database, input, row);
  let deleted = 1;
  switch (input.targetType) {
    case 'run': {
      deleted = runGraphCount(database, input.targetId);
      const session = database.prepare('SELECT session_id FROM run_intakes WHERE run_id = ?').get<{ session_id: string }>(input.targetId);
      database.prepare('DELETE FROM ledger_runs WHERE run_id = ?').run(input.targetId);
      if (session) { database.prepare('DELETE FROM akinator_answers WHERE session_id = ?').run(session.session_id); if (!database.prepare('SELECT 1 AS present FROM run_intakes WHERE session_id = ?').get<{ present: number }>(session.session_id)) database.prepare('DELETE FROM akinator_sessions WHERE id = ?').run(session.session_id); }
      break;
    }
    case 'evidence': database.prepare('DELETE FROM ledger_evidence WHERE evidence_id = ?').run(input.targetId); break;
    case 'delivery':
      deleted += rowCount(database, 'SELECT COUNT(*) AS count FROM context_feedback WHERE delivery_id = ?', input.targetId);
      deleted += rowCount(database, 'SELECT COUNT(*) AS count FROM context_delivery_entries WHERE delivery_id = ?', input.targetId);
      deleted += rowCount(database, 'SELECT COUNT(*) AS count FROM ledger_memory_links WHERE delivery_id = ?', input.targetId);
      database.prepare('DELETE FROM ledger_memory_links WHERE delivery_id = ?').run(input.targetId);
      database.prepare('DELETE FROM context_deliveries WHERE delivery_id = ?').run(input.targetId);
      break;
    case 'feedback': {
      const table = row.feedback_table === 'context' ? 'context_feedback' : row.feedback_table === 'run' ? 'run_feedback' : 'intake_feedback';
      database.prepare(`DELETE FROM ${table} WHERE feedback_id = ?`).run(input.targetId);
      break;
    }
    case 'memory_link': database.prepare('DELETE FROM ledger_memory_links WHERE link_id = ?').run(input.targetId); break;
    default: break;
  }
  const saved = database.prepare('SELECT * FROM ledger_purge_audit WHERE purge_id = ?').get<Row>(input.purgeId);
  if (!saved) throw new KiokukoError('INTEGRITY_ERROR', 'Ledger purge tombstone disappeared');
  return { value: tombstone(saved), count: deleted };
}
function purgeInTransaction(database: SqliteDatabase, input: ValidatedPurge): PurgeResult {
  const existing = database.prepare('SELECT * FROM ledger_purge_audit WHERE purge_id = ?').get<Row>(input.purgeId);
  if (existing) { const value = tombstone(existing); if (!samePurge(database, input, value)) throw new KiokukoError('CONFLICT', PURGE_CONFLICT); return purgeResult(value, 0, true); }
  const row = target(database, input);
  if (!row) throw new KiokukoError('NOT_FOUND', PURGE_NOT_FOUND);
  const result = executePurge(database, input, row);
  return purgeResult(result.value, result.count, false);
}
export function purgeLedgerTarget(database: SqliteDatabase, input: unknown): PurgeResult { const value = normalizePurge(input); return withImmediateTransaction(database, () => purgeInTransaction(database, value)); }
