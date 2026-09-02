import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import {
  COVERAGE_LEVELS,
  LEDGER_EVENT_TYPES,
  RUN_STATUSES,
  type Coverage,
  type JsonObject,
  type JsonValue,
  type Redaction,
  type RunRecord,
  type RunStatus,
  type LedgerEventType,
} from './types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const RUN_CURSOR_VERSION = 1;

type RunCursor = {
  version: typeof RUN_CURSOR_VERSION;
  createdAt: string;
  runId: string;
};

type RunRow = SqliteRow & {
  run_id: string;
  workspace: string;
  client_kind: string;
  client_version: string | null;
  source_session_id: string | null;
  protocol_version: string;
  capture_profile: RunRecord['captureProfile'];
  coverage_json: string;
  status: RunStatus;
  title: string | null;
  task_hash: string | null;
  metadata_json: string;
  last_sequence: number;
  last_source_sequence: number | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = SqliteRow & {
  event_id: string;
  run_id: string;
  sequence: number;
  source_event_id: string | null;
  source_sequence: number | null;
  event_type: string;
  source_type: string | null;
  actor: string;
  outcome: string | null;
  occurred_at: string | null;
  ingested_at: string;
  payload_json: string;
  redaction_json: string;
  previous_hash: string;
  event_hash: string;
};

export interface LedgerRunView extends Omit<RunRecord, 'title' | 'metadata'> {
  title: string | null;
  metadata: JsonObject;
  untrusted: true;
}

export interface LedgerRunsPage {
  items: LedgerRunView[];
  nextCursor: string | null;
}

export interface ReadLedgerRunInput {
  workspace: string;
  runId: string;
}

export interface LedgerEventView {
  eventId: string;
  runId: string;
  sequence: number;
  sourceEventId: string | null;
  sourceSequence: number | null;
  eventType: string;
  sourceType: string | null;
  actor: string;
  outcome: string | null;
  occurredAt: string | null;
  ingestedAt: string;
  payload: JsonValue;
  redaction: Redaction[];
  previousHash: string;
  eventHash: string;
  untrusted: true;
}

export interface LedgerEventsPage {
  items: LedgerEventView[];
  nextCursor: number | null;
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function notFound(): never {
  throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
}

function integrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Stored ledger JSON is invalid');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inputObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) validation(`${label} must be an object`);
  return value;
}

function rejectUnknownFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) validation(`Unknown ${label} field`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) validation(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    validation('limit must be an integer between 1 and 100');
  }
  return value;
}

function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseRunCursor(value: string | undefined): RunCursor | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) validation('Invalid run cursor');
  let parsed: unknown;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) validation('Invalid run cursor');
    parsed = JSON.parse(decoded.toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    if (error instanceof SyntaxError) validation('Invalid run cursor');
    throw error;
  }
  if (!isPlainObject(parsed) || Object.keys(parsed).length !== 3 || !Object.keys(parsed).every((key) => ['version', 'createdAt', 'runId'].includes(key))) {
    validation('Invalid run cursor');
  }
  if (parsed.version !== RUN_CURSOR_VERSION) validation('Unsupported run cursor version');
  if (typeof parsed.createdAt !== 'string' || !isUtcTimestamp(parsed.createdAt) || typeof parsed.runId !== 'string' || parsed.runId.length === 0) {
    validation('Invalid run cursor');
  }
  return { version: RUN_CURSOR_VERSION, createdAt: parsed.createdAt, runId: parsed.runId };
}

function isUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseStatus(value: unknown): RunStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !RUN_STATUSES.includes(value as RunStatus)) validation('status has an invalid enum value');
  return value as RunStatus;
}

function parseAfter(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) validation('after must be a non-negative safe integer');
  return value;
}

function parseEventType(value: unknown): LedgerEventType | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !LEDGER_EVENT_TYPES.includes(value as LedgerEventType)) validation('type has an invalid event type');
  return value as LedgerEventType;
}

const REDACTION_KINDS: readonly Redaction['kind'][] = [
  'sensitive_key', 'secret_pattern', 'url', 'home_path', 'preview_truncated',
  'environment_value', 'hidden_reasoning',
];

function parseRedactions(value: string): Redaction[] {
  const parsed = parseStoredJson(value);
  if (!Array.isArray(parsed)) integrity();
  const redactions: Redaction[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item) || typeof item.path !== 'string' || typeof item.kind !== 'string' || !REDACTION_KINDS.includes(item.kind as Redaction['kind'])) integrity();
    redactions.push({ path: item.path, kind: item.kind as Redaction['kind'] });
  }
  return redactions;
}

function rowToEvent(row: EventRow): LedgerEventView {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.sequence,
    sourceEventId: row.source_event_id,
    sourceSequence: row.source_sequence,
    eventType: row.event_type,
    sourceType: row.source_type,
    actor: row.actor,
    outcome: row.outcome,
    occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at,
    payload: parseStoredJson(row.payload_json),
    redaction: parseRedactions(row.redaction_json),
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    untrusted: true,
  };
}

function parseStoredJson(value: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) integrity();
    throw error;
  }
  if (!isJsonValue(parsed)) integrity();
  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (isPlainObject(value)) return Object.values(value).every((item) => isJsonValue(item));
  return false;
}

function parseJsonObject(value: string): JsonObject {
  const parsed = parseStoredJson(value);
  if (!isPlainObject(parsed)) integrity();
  return parsed as JsonObject;
}

function parseCoverage(value: string): Coverage {
  const parsed = parseJsonObject(value);
  const fields = ['run', 'tool', 'command', 'file', 'approval'] as const;
  const levels = fields.map((field) => parsed[field]);
  if (levels.some((level) => typeof level !== 'string' || !COVERAGE_LEVELS.includes(level as Coverage['run']))) integrity();
  return {
    run: parsed.run as Coverage['run'],
    tool: parsed.tool as Coverage['tool'],
    command: parsed.command as Coverage['command'],
    file: parsed.file as Coverage['file'],
    approval: parsed.approval as Coverage['approval'],
  };
}

function rowToRun(row: RunRow): LedgerRunView {
  return {
    runId: row.run_id,
    workspace: row.workspace,
    client: {
      kind: row.client_kind,
      ...(row.client_version === null ? {} : { version: row.client_version }),
      ...(row.source_session_id === null ? {} : { sessionId: row.source_session_id }),
    },
    protocolVersion: row.protocol_version,
    captureProfile: row.capture_profile,
    coverage: parseCoverage(row.coverage_json),
    status: row.status,
    title: row.title,
    taskHash: row.task_hash,
    metadata: parseJsonObject(row.metadata_json),
    lastSequence: row.last_sequence,
    lastSourceSequence: row.last_source_sequence,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    untrusted: true,
  };
}

interface ParsedListRunsInput {
  workspace: string;
  limit: number;
  client?: string;
  status?: RunStatus;
  cursor?: RunCursor;
}

function parseListRunsInput(value: unknown): ParsedListRunsInput {
  const input = inputObject(value, 'run list input');
  rejectUnknownFields(input, ['workspace', 'client', 'status', 'cursor', 'limit'], 'run list input');
  const workspace = requiredString(input.workspace, 'workspace');
  const client = optionalString(input.client, 'client');
  const status = parseStatus(input.status);
  const cursor = parseRunCursor(optionalString(input.cursor, 'cursor'));
  return {
    workspace,
    limit: parseLimit(input.limit),
    ...(client === undefined ? {} : { client }),
    ...(status === undefined ? {} : { status }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function parseReadRunInput(value: unknown): ReadLedgerRunInput {
  const input = inputObject(value, 'run read input');
  rejectUnknownFields(input, ['workspace', 'runId'], 'run read input');
  return {
    workspace: requiredString(input.workspace, 'workspace'),
    runId: requiredString(input.runId, 'runId'),
  };
}

function parseListEventsInput(value: unknown): { workspace: string; runId: string; after: number; limit: number; type?: LedgerEventType } {
  const input = inputObject(value, 'event list input');
  rejectUnknownFields(input, ['workspace', 'runId', 'after', 'type', 'limit'], 'event list input');
  const type = parseEventType(input.type);
  return {
    workspace: requiredString(input.workspace, 'workspace'),
    runId: requiredString(input.runId, 'runId'),
    after: parseAfter(input.after),
    limit: parseLimit(input.limit),
    ...(type === undefined ? {} : { type }),
  };
}

export function listLedgerEvents(database: SqliteDatabase, input: unknown): LedgerEventsPage {
  const parsed = parseListEventsInput(input);
  const run = database.prepare('SELECT run_id FROM ledger_runs WHERE run_id = ? AND workspace = ?').get<{ run_id: string }>(parsed.runId, parsed.workspace);
  if (!run) notFound();

  const clauses = ['run_id = ?', 'sequence > ?'];
  const parameters: Array<string | number> = [parsed.runId, parsed.after];
  if (parsed.type !== undefined) {
    clauses.push('event_type = ?');
    parameters.push(parsed.type);
  }
  parameters.push(parsed.limit + 1);
  const rows = database.prepare(`
    SELECT event_id, run_id, sequence, source_event_id, source_sequence, event_type,
           source_type, actor, outcome, occurred_at, ingested_at, payload_json,
           redaction_json, previous_hash, event_hash
      FROM ledger_events
     WHERE ${clauses.join(' AND ')}
     ORDER BY sequence ASC
     LIMIT ?
  `).all<EventRow>(...parameters);
  const pageRows = rows.slice(0, parsed.limit);
  const nextCursor = rows.length > parsed.limit ? pageRows.at(-1)?.sequence ?? null : null;
  return { items: pageRows.map(rowToEvent), nextCursor };
}

export function readLedgerRun(database: SqliteDatabase, input: unknown): LedgerRunView {
  const parsed = parseReadRunInput(input);
  const row = database.prepare(`
    SELECT run_id, workspace, client_kind, client_version, source_session_id,
           protocol_version, capture_profile, coverage_json, status, title, task_hash,
           metadata_json, last_sequence, last_source_sequence, started_at, ended_at,
           created_at, updated_at
      FROM ledger_runs
     WHERE run_id = ? AND workspace = ?
  `).get<RunRow>(parsed.runId, parsed.workspace);
  if (!row) notFound();
  return rowToRun(row);
}

export function listLedgerRuns(database: SqliteDatabase, input: unknown): LedgerRunsPage {
  const parsed = parseListRunsInput(input);
  const clauses = ['workspace = ?'];
  const parameters: Array<string | number> = [parsed.workspace];
  if (parsed.client !== undefined) {
    clauses.push('client_kind = ?');
    parameters.push(parsed.client);
  }
  if (parsed.status !== undefined) {
    clauses.push('status = ?');
    parameters.push(parsed.status);
  }
  if (parsed.cursor !== undefined) {
    clauses.push('(created_at < ? OR (created_at = ? AND run_id > ?))');
    parameters.push(parsed.cursor.createdAt, parsed.cursor.createdAt, parsed.cursor.runId);
  }
  parameters.push(parsed.limit + 1);
  const rows = database.prepare(`
    SELECT run_id, workspace, client_kind, client_version, source_session_id,
           protocol_version, capture_profile, coverage_json, status, title, task_hash,
           metadata_json, last_sequence, last_source_sequence, started_at, ended_at,
           created_at, updated_at
      FROM ledger_runs
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC, run_id ASC
     LIMIT ?
  `).all<RunRow>(...parameters);
  const pageRows = rows.slice(0, parsed.limit);
  const nextCursor = rows.length > parsed.limit
    ? encodeRunCursor({ version: RUN_CURSOR_VERSION, createdAt: pageRows.at(-1)?.created_at ?? '', runId: pageRows.at(-1)?.run_id ?? '' })
    : null;
  return { items: pageRows.map(rowToRun), nextCursor };
}
