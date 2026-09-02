import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalJson, hashLedgerEvent, GENESIS_HASH } from './hash.js';
import { sanitizeEvent, sanitizeRunMetadata, sanitizeTask } from './redaction.js';
import { sanitizeJson } from '../security/sanitize.js';
import { validateEventBatch, validateRunInput, validateRunStatus, validateTimestamp } from './validate.js';
import {
  TERMINAL_RUN_STATUSES,
  type AppendAck,
  type JsonObject,
  type LedgerEventInput,
  type LedgerStoreOptions,
  type Redaction,
  type RunRecord,
  type RunStatus,
  type Sanitized,
} from './types.js';

interface RunRow extends SqliteRow {
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
}

interface EventRow extends SqliteRow {
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
}

interface PreparedEvent {
  input: LedgerEventInput;
  sanitized: Sanitized<LedgerEventInput>;
  eventId: string;
  fingerprint: string;
}

function notFound(message: string): never {
  throw new KiokukoError('NOT_FOUND', message);
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function withBatchSavepoint<T>(database: SqliteDatabase, operation: () => T): T {
  const savepoint = `kiokuko_ledger_batch_${randomUUID().replaceAll('-', '')}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch (rollbackError) {
      cleanupFailures.push(rollbackError);
    }
    try {
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (releaseError) {
      cleanupFailures.push(releaseError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Ledger batch failed and savepoint cleanup also failed',
      );
    }
    throw error;
  }
}

function eventFingerprint(event: LedgerEventInput, redaction: Redaction[]): string {
  return canonicalJson({
    sourceEventId: event.sourceEventId ?? null,
    sourceSequence: event.sourceSequence ?? null,
    eventType: event.eventType,
    sourceType: event.sourceType ?? null,
    actor: event.actor,
    outcome: event.outcome ?? null,
    occurredAt: event.occurredAt ?? null,
    payload: event.payload,
    redaction,
  });
}

function rowFingerprint(row: EventRow): string {
  return eventFingerprint({
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    ...(row.source_sequence === null ? {} : { sourceSequence: row.source_sequence }),
    eventType: row.event_type as LedgerEventInput['eventType'],
    ...(row.source_type === null ? {} : { sourceType: row.source_type }),
    actor: row.actor,
    outcome: row.outcome,
    ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at }),
    payload: parseJson<import('./types.js').JsonValue>(row.payload_json),
  }, parseJson<Redaction[]>(row.redaction_json));
}

function preparedEvents(events: LedgerEventInput[], options: LedgerStoreOptions): PreparedEvent[] {
  const prepared = events.map((input) => {
    const sanitized = sanitizeEvent(input, options);
    const sanitizedInput = sanitized.value;
    return {
      input: sanitizedInput,
      sanitized,
      eventId: sanitizedInput.eventId ?? randomUUID(),
      fingerprint: eventFingerprint(sanitizedInput, sanitized.redactions),
    };
  });
  const sourceIds = new Set<string>();
  const eventIds = new Set<string>();
  for (const event of prepared) {
    if (event.input.sourceEventId && sourceIds.has(event.input.sourceEventId)) conflict('duplicate source event ID in batch');
    if (event.input.sourceEventId) sourceIds.add(event.input.sourceEventId);
    if (eventIds.has(event.eventId)) conflict('duplicate event ID in batch');
    eventIds.add(event.eventId);
  }
  return prepared;
}

function rowToRun(row: RunRow): RunRecord {
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
    coverage: parseJson(row.coverage_json),
    status: row.status,
    title: row.title,
    taskHash: row.task_hash,
    metadata: parseJson<JsonObject>(row.metadata_json),
    lastSequence: row.last_sequence,
    lastSourceSequence: row.last_source_sequence,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LedgerStore {
  private readonly options: LedgerStoreOptions;

  constructor(private readonly database: SqliteDatabase, options: LedgerStoreOptions = {}) {
    this.options = options;
  }

  /** Run a standalone operation in the store's top-level transaction. */
  withTransaction<T>(operation: () => T): T {
    return withImmediateTransaction(this.database, operation);
  }

  createRun(input: unknown): RunRecord {
    const prepared = this.prepareRun(input);
    return withImmediateTransaction(this.database, () => this.insertPreparedRun(prepared));
  }

  /** Caller-owned transaction primitive; it deliberately does not begin or commit a transaction. */
  createRunInTransaction(input: unknown, now = this.now()): RunRecord {
    const prepared = this.prepareRun(input, now);
    return this.insertPreparedRun(prepared);
  }

  readRun(runId: string, workspace?: string): RunRecord | undefined {
    const row = workspace === undefined
      ? this.database.prepare('SELECT * FROM ledger_runs WHERE run_id = ?').get<RunRow>(runId)
      : this.database.prepare('SELECT * FROM ledger_runs WHERE run_id = ? AND workspace = ?').get<RunRow>(runId, workspace);
    return row ? rowToRun(row) : undefined;
  }

  getRunStatus(runId: string, workspace?: string): RunStatus | undefined {
    return this.readRun(runId, workspace)?.status;
  }

  updateRunStatus(runId: string, status: RunStatus, endedAt?: string): RunRecord {
    const validatedStatus = validateRunStatus(status);
    const timestamp = validateTimestamp(endedAt ?? this.now(), 'endedAt');
    return withImmediateTransaction(this.database, () => this.updateRunStatusInTransaction(runId, validatedStatus, timestamp));
  }

  updateRunStatusInTransaction(runId: string, status: RunStatus, endedAt = this.now()): RunRecord {
    const validatedStatus = validateRunStatus(status);
    const timestamp = validateTimestamp(endedAt, 'endedAt');
    const current = this.database.prepare('SELECT * FROM ledger_runs WHERE run_id = ?').get<RunRow>(runId);
    if (!current) notFound('Ledger run not found');
    if (TERMINAL_RUN_STATUSES.includes(current.status as (typeof TERMINAL_RUN_STATUSES)[number]) && current.status !== validatedStatus) conflict('Terminal ledger run cannot change status');
    this.database.prepare('UPDATE ledger_runs SET status = ?, ended_at = ?, updated_at = ? WHERE run_id = ?').run(
      validatedStatus,
      TERMINAL_RUN_STATUSES.includes(validatedStatus as (typeof TERMINAL_RUN_STATUSES)[number]) ? timestamp : null,
      timestamp,
      runId,
    );
    const updated = this.database.prepare('SELECT * FROM ledger_runs WHERE run_id = ?').get<RunRow>(runId);
    if (!updated) notFound('Ledger run not found');
    return rowToRun(updated);
  }

  appendBatch(runId: string, input: unknown): AppendAck {
    const events = preparedEvents(validateEventBatch(input), this.options);
    return withImmediateTransaction(this.database, () => this.appendPreparedBatchInTransaction(runId, events));
  }

  /** Caller-owned transaction primitive; a savepoint isolates this batch without committing or rolling back the outer transaction. */
  appendBatchInTransaction(runId: string, input: unknown): AppendAck {
    const events = preparedEvents(validateEventBatch(input), this.options);
    return withBatchSavepoint(this.database, () => this.appendPreparedBatchInTransaction(runId, events));
  }

  readEvents(runId: string): EventRow[] {
    return this.database.prepare('SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence').all<EventRow>(runId);
  }

  verifyChain(runId: string): boolean {
    let previous = GENESIS_HASH;
    const rows = this.readEvents(runId);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || row.sequence !== index + 1 || row.previous_hash !== previous) return false;
      const calculated = hashLedgerEvent({
        runId,
        sequence: row.sequence,
        eventId: row.event_id,
        previousHash: row.previous_hash,
        eventType: row.event_type,
        ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
        ...(row.source_sequence === null ? {} : { sourceSequence: row.source_sequence }),
        ...(row.source_type === null ? {} : { sourceType: row.source_type }),
        actor: row.actor,
        ...(row.outcome === null ? {} : { outcome: row.outcome }),
        ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at }),
        ingestedAt: row.ingested_at,
        payload: parseJson<import('./types.js').JsonValue>(row.payload_json),
        redaction: parseJson<Redaction[]>(row.redaction_json),
      });
      if (calculated !== row.event_hash) return false;
      previous = row.event_hash;
    }
    return true;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private prepareRun(input: unknown, now = this.now()): {
    input: ReturnType<typeof validateRunInput>;
    task: ReturnType<typeof sanitizeTask>;
    metadata: JsonObject;
    now: string;
  } {
    const validated = validateRunInput(input);
    const client = sanitizeJson(validated.client, this.options).value as unknown as import('./types.js').ClientInput;
    const task = sanitizeTask(validated.task, this.options);
    const metadata = sanitizeRunMetadata(validated.metadata ?? {}, this.options).value;
    return { input: { ...validated, client }, task, metadata: (metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}) as JsonObject, now };
  }


  private insertPreparedRun(prepared: ReturnType<LedgerStore['prepareRun']>): RunRecord {
    const { input, task, metadata, now } = prepared;
    if (this.database.prepare('SELECT run_id FROM ledger_runs WHERE run_id = ?').get(input.runId)) conflict('Ledger run already exists');
    const taskHash = hashText(canonicalJson(task.value));
    const taskTitle = task.value.title;
    this.database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
        protocol_version, capture_profile, coverage_json, status, title, task_hash,
        metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intake', ?, ?, ?, 0, NULL, ?, NULL, ?, ?)
    `).run(
      input.runId,
      input.workspace,
      input.client.kind,
      input.client.version ?? null,
      input.client.sessionId ?? null,
      input.parentRunId ?? null,
      input.protocolVersion,
      input.captureProfile,
      canonicalJson(input.coverage),
      taskTitle,
      taskHash,
      canonicalJson(metadata),
      input.startedAt ?? now,
      now,
      now,
    );
    const row = this.database.prepare('SELECT * FROM ledger_runs WHERE run_id = ?').get<RunRow>(input.runId);
    if (!row) notFound('Ledger run not found after creation');
    return rowToRun(row);
  }

  private appendPreparedBatchInTransaction(runId: string, events: PreparedEvent[]): AppendAck {
    const run = this.database.prepare('SELECT * FROM ledger_runs WHERE run_id = ?').get<RunRow>(runId);
    if (!run) notFound('Ledger run not found');

    const existingRows: EventRow[] = [];
    for (const event of events) {
      const sourceRow = event.input.sourceEventId
        ? this.database.prepare('SELECT * FROM ledger_events WHERE run_id = ? AND source_event_id = ?').get<EventRow>(runId, event.input.sourceEventId)
        : undefined;
      const eventIdRow = this.database.prepare('SELECT * FROM ledger_events WHERE event_id = ?').get<EventRow>(event.eventId);
      if (sourceRow && eventIdRow && sourceRow.event_id !== eventIdRow.event_id) conflict('Event identities refer to different ledger events');
      const existing = sourceRow ?? eventIdRow;
      if (!existing) continue;
      if (existing.run_id !== runId) conflict('Event ID is already owned by another ledger run');
      if (event.input.eventId !== undefined && existing.event_id !== event.input.eventId) conflict('Event ID conflicts with the stored source event');
      if (event.fingerprint !== rowFingerprint(existing)) conflict('Source event conflicts with an existing ledger event');
      existingRows.push(existing);
    }
    if (existingRows.length > 0) {
      if (existingRows.length !== events.length || new Set(existingRows.map((row) => row.event_id)).size !== existingRows.length) {
        conflict('Source event conflicts with an existing ledger event');
      }
      return this.ackFromRows(runId, existingRows);
    }

    if (TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number])) conflict('Cannot append events to a terminal ledger run');

    let sequence = run.last_sequence;
    let previousHash = sequence === 0 ? GENESIS_HASH : (this.database.prepare('SELECT event_hash FROM ledger_events WHERE run_id = ? AND sequence = ?').get<{ event_hash: string }>(runId, sequence)?.event_hash ?? '');
    if (sequence > 0 && !previousHash) throw new KiokukoError('INTEGRITY_ERROR', 'Ledger sequence has no previous hash');
    let lastSourceSequence = run.last_source_sequence;
    const localSequences: number[] = [];
    const sourceSequences: Array<number | null> = [];
    const eventIds: string[] = [];
    const ingestedAt = this.now();

    for (const event of events) {
      sequence += 1;
      const sourceSequence = event.input.sourceSequence ?? null;
      const payloadJson = canonicalJson(event.input.payload);
      const redactionJson = canonicalJson(event.sanitized.redactions);
      const eventHash = hashLedgerEvent({
        runId,
        sequence,
        eventId: event.eventId,
        previousHash,
        eventType: event.input.eventType,
        ...(event.input.sourceEventId === undefined ? {} : { sourceEventId: event.input.sourceEventId }),
        ...(event.input.sourceSequence === undefined ? {} : { sourceSequence: event.input.sourceSequence }),
        ...(event.input.sourceType === undefined ? {} : { sourceType: event.input.sourceType }),
        actor: event.input.actor,
        ...(event.input.outcome === undefined ? {} : { outcome: event.input.outcome }),
        ...(event.input.occurredAt === undefined ? {} : { occurredAt: event.input.occurredAt }),
        ingestedAt,
        payload: event.input.payload,
        redaction: event.sanitized.redactions,
      });
      this.database.prepare(`
        INSERT INTO ledger_events (
          event_id, run_id, sequence, source_event_id, source_sequence, event_type, source_type,
          actor, outcome, occurred_at, ingested_at, payload_json, redaction_json, previous_hash, event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        runId,
        sequence,
        event.input.sourceEventId ?? null,
        sourceSequence,
        event.input.eventType,
        event.input.sourceType ?? null,
        event.input.actor,
        event.input.outcome ?? null,
        event.input.occurredAt ?? null,
        ingestedAt,
        payloadJson,
        redactionJson,
        previousHash,
        eventHash,
      );
      previousHash = eventHash;
      if (sourceSequence !== null) lastSourceSequence = lastSourceSequence === null ? sourceSequence : Math.max(lastSourceSequence, sourceSequence);
      localSequences.push(sequence);
      sourceSequences.push(sourceSequence);
      eventIds.push(event.eventId);
    }
    this.database.prepare('UPDATE ledger_runs SET last_sequence = ?, last_source_sequence = ?, updated_at = ? WHERE run_id = ?').run(sequence, lastSourceSequence, ingestedAt, runId);
    return { runId, acceptedThrough: sequence, localSequences, sourceSequences, eventIds };
  }

  private ackFromRows(runId: string, rows: EventRow[]): AppendAck {
    const ordered = [...rows].sort((left, right) => left.sequence - right.sequence);
    return {
      runId,
      acceptedThrough: ordered.at(-1)?.sequence ?? 0,
      localSequences: ordered.map((row) => row.sequence),
      sourceSequences: ordered.map((row) => row.source_sequence),
      eventIds: ordered.map((row) => row.event_id),
    };
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
