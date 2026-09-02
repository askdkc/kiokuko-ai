import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { AKINATOR_POLICY_VERSION, evaluateProfile } from '../akinator/domain.js';
import { readAkinatorSession, readRunIntakeLink } from '../akinator/store.js';
import type { TaskProfile } from '../akinator/types.js';
import { GENESIS_HASH, hashLedgerEvent } from '../ledger/hash.js';
import { projectLedger, type LedgerEventSnapshot, type LedgerProjection } from '../ledger/projection.js';
import { LedgerStore } from '../ledger/store.js';
import {
  COVERAGE_LEVELS,
  TERMINAL_RUN_STATUSES,
  type JsonValue,
  type Redaction,
  type RunRecord,
} from '../ledger/types.js';
import { validateEventInput, validateTimestamp } from '../ledger/validate.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';

const HASH = /^[0-9a-f]{64}$/u;
const CURRENT_PROFILE_SCHEMA_VERSION = 1;
const REDACTION_KINDS: readonly Redaction['kind'][] = [
  'sensitive_key',
  'secret_pattern',
  'url',
  'home_path',
  'preview_truncated',
  'environment_value',
  'hidden_reasoning',
];

export interface ContextRunRetrievalState {
  run: RunRecord;
  profile: TaskProfile;
  profileHash: string;
  recommendedTags: string[];
  intakeSessionId: string;
  intakeStatus: 'active' | 'ready' | 'exhausted';
  projection: LedgerProjection | null;
  stateHash: string;
}

export interface ContextRunProfileBinding {
  workspace: string;
  intakeSessionId: string;
  intakePolicyVersion: string;
  initialProfileHash: string;
  profileHash: string;
}

function integrity(message = 'Stored context run is invalid'): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function storedRun(database: SqliteDatabase, runId: string): RunRecord {
  let run: RunRecord | undefined;
  try {
    run = new LedgerStore(database).readRun(runId);
  } catch (error) {
    if (error instanceof SyntaxError) integrity();
    throw error;
  }
  if (run === undefined) throw new KiokukoError('NOT_FOUND', 'Context run was not found');
  const coverageFields = ['run', 'tool', 'command', 'file', 'approval'] as const;
  if (typeof run.workspace !== 'string'
    || run.workspace.length === 0
    || (run.title !== null && typeof run.title !== 'string')
    || !Number.isSafeInteger(run.lastSequence)
    || run.lastSequence < 0
    || typeof run.createdAt !== 'string'
    || typeof run.updatedAt !== 'string'
    || typeof run.coverage !== 'object'
    || run.coverage === null
    || Array.isArray(run.coverage)
    || Object.keys(run.coverage).length !== coverageFields.length
    || coverageFields.some((field) => !COVERAGE_LEVELS.includes(run.coverage[field]))) {
    integrity();
  }
  try {
    validateTimestamp(run.createdAt, 'createdAt');
    validateTimestamp(run.updatedAt, 'updatedAt');
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') integrity();
    throw error;
  }
  return run;
}

function parseCanonicalJson(value: unknown): JsonValue {
  if (typeof value !== 'string') integrity('Stored context ledger event is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) integrity('Stored context ledger event is invalid');
    throw error;
  }
  try {
    if (canonicalJson(parsed) !== value) integrity('Stored context ledger event is invalid');
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') {
      integrity('Stored context ledger event is invalid');
    }
    throw error;
  }
  return parsed as JsonValue;
}

function parsedRedactions(value: unknown): Redaction[] {
  const parsed = parseCanonicalJson(value);
  if (!Array.isArray(parsed)) integrity('Stored context ledger event is invalid');
  return parsed.map((item) => {
    if (typeof item !== 'object'
      || item === null
      || Array.isArray(item)
      || Object.keys(item).length !== 2
      || typeof item.path !== 'string'
      || item.path.length === 0
      || typeof item.kind !== 'string'
      || !REDACTION_KINDS.includes(item.kind as Redaction['kind'])) {
      integrity('Stored context ledger event is invalid');
    }
    return { path: item.path, kind: item.kind as Redaction['kind'] };
  });
}

interface ValidatedEventState {
  projection: LedgerEventSnapshot;
  hashInput: {
    eventId: string;
    sequence: number;
    eventType: string;
    sourceEventId: string | null;
    sourceSequence: number | null;
    sourceType: string | null;
    actor: string;
    outcome: string | null;
    occurredAt: string | null;
    ingestedAt: string;
    payload: JsonValue;
    redaction: Redaction[];
    previousHash: string;
    eventHash: string;
  };
}

function validatedLedgerEvents(database: SqliteDatabase, run: RunRecord): ValidatedEventState[] {
  const rows = new LedgerStore(database).readEvents(run.runId);
  if (rows.length !== run.lastSequence) integrity('Stored context ledger sequence is invalid');
  const events: ValidatedEventState[] = [];
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined
      || row.run_id !== run.runId
      || row.sequence !== index + 1
      || row.previous_hash !== previousHash
      || typeof row.event_hash !== 'string'
      || !HASH.test(row.event_hash)
      || typeof row.ingested_at !== 'string') {
      integrity('Stored context ledger sequence is invalid');
    }
    const payload = parseCanonicalJson(row.payload_json);
    const redaction = parsedRedactions(row.redaction_json);
    let event;
    try {
      event = validateEventInput({
        eventId: row.event_id,
        ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
        ...(row.source_sequence === null ? {} : { sourceSequence: row.source_sequence }),
        eventType: row.event_type,
        ...(row.source_type === null ? {} : { sourceType: row.source_type }),
        actor: row.actor,
        outcome: row.outcome,
        ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at }),
        payload,
      });
      validateTimestamp(row.ingested_at, 'ingestedAt');
    } catch (error) {
      if (error instanceof KiokukoError
        && (error.code === 'VALIDATION_ERROR' || error.code === 'SECURITY_REJECTION')) {
        integrity('Stored context ledger event is invalid');
      }
      throw error;
    }
    const calculated = hashLedgerEvent({
      runId: run.runId,
      sequence: row.sequence,
      eventId: event.eventId as string,
      previousHash: row.previous_hash,
      eventType: event.eventType,
      ...(event.sourceEventId === undefined ? {} : { sourceEventId: event.sourceEventId }),
      ...(event.sourceSequence === undefined ? {} : { sourceSequence: event.sourceSequence }),
      ...(event.sourceType === undefined ? {} : { sourceType: event.sourceType }),
      actor: event.actor,
      ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
      ingestedAt: row.ingested_at,
      payload: event.payload,
      redaction,
    });
    if (calculated !== row.event_hash) integrity('Stored context ledger hash chain is invalid');
    const projection: LedgerEventSnapshot = {
      eventId: event.eventId as string,
      sequence: row.sequence,
      eventType: event.eventType,
      ...(event.outcome === undefined || event.outcome === null ? {} : { outcome: event.outcome }),
      payload: event.payload,
    };
    events.push({
      projection,
      hashInput: {
        eventId: event.eventId as string,
        sequence: row.sequence,
        eventType: event.eventType,
        sourceEventId: event.sourceEventId ?? null,
        sourceSequence: event.sourceSequence ?? null,
        sourceType: event.sourceType ?? null,
        actor: event.actor,
        outcome: event.outcome ?? null,
        occurredAt: event.occurredAt ?? null,
        ingestedAt: row.ingested_at,
        payload: event.payload,
        redaction,
        previousHash: row.previous_hash,
        eventHash: row.event_hash,
      },
    });
    previousHash = row.event_hash;
  }
  return events;
}

function validatedFinalizedIntake(
  database: SqliteDatabase,
  run: RunRecord,
): {
  link: ReturnType<typeof readRunIntakeLink>;
  session: ReturnType<typeof readAkinatorSession>;
  initialProfileHash: string;
} {
  let link: ReturnType<typeof readRunIntakeLink>;
  try {
    link = readRunIntakeLink(database, { workspace: run.workspace, runId: run.runId });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
      integrity('Stored context run intake state is invalid');
    }
    throw error;
  }
  let session: ReturnType<typeof readAkinatorSession>;
  try {
    session = readAkinatorSession(database, { workspace: run.workspace, sessionId: link.sessionId });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
      integrity('Stored context run intake state is invalid');
    }
    throw error;
  }
  if (link.runId !== run.runId
    || link.workspace !== run.workspace
    || session.id !== link.sessionId
    || session.workspace !== run.workspace
    || session.status === 'active') {
    integrity('Stored context run intake state is invalid');
  }
  validatedCurrentIntakeMetadata(link, session);
  const initialProfileHash = canonicalContentHash(session.profile);
  if (link.initialProfileHash !== initialProfileHash || link.finalizedAt === null) {
    integrity('Context run intake link does not match its session state');
  }
  return { link, session, initialProfileHash };
}

function validatedCurrentIntakeMetadata(
  link: ReturnType<typeof readRunIntakeLink>,
  session: ReturnType<typeof readAkinatorSession>,
): string[] {
  if (link.policyVersion !== AKINATOR_POLICY_VERSION
    || link.profileSchemaVersion !== CURRENT_PROFILE_SCHEMA_VERSION) {
    integrity('Stored context run intake state is invalid');
  }
  let expected: ReturnType<typeof evaluateProfile>;
  try {
    expected = evaluateProfile(session.profile, session.questionCount);
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') {
      integrity('Stored context run intake state is invalid');
    }
    throw error;
  }
  if (session.status !== 'active'
    && (link.recommendedTags.length !== expected.recommendedTags.length
      || link.recommendedTags.some((tag, index) => tag !== expected.recommendedTags[index]))) {
    integrity('Stored context run intake state is invalid');
  }
  return [...expected.recommendedTags];
}

/** Verify the exact intake/profile binding at a persisted delivery cursor. */
export function readContextRunProfileBinding(
  database: SqliteDatabase,
  runId: string,
  throughSequence: number,
): ContextRunProfileBinding {
  const run = storedRun(database, runId);
  if (!Number.isSafeInteger(throughSequence)
    || throughSequence < 0
    || throughSequence > run.lastSequence) {
    integrity('Stored context delivery sequence is invalid');
  }
  const { link, session, initialProfileHash } = validatedFinalizedIntake(database, run);
  const events = validatedLedgerEvents(database, run);
  let projection: LedgerProjection;
  try {
    projection = projectLedger({
      initialProfile: session.profile,
      intakeStatus: session.status,
      coverage: run.coverage,
      throughSequence,
      events: events
        .filter((event) => event.projection.sequence <= throughSequence)
        .map((event) => event.projection),
    });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') {
      integrity('Stored context ledger projection state is invalid');
    }
    throw error;
  }
  return {
    workspace: run.workspace,
    intakeSessionId: link.sessionId,
    intakePolicyVersion: link.policyVersion,
    initialProfileHash,
    profileHash: projection.profileHash,
  };
}

/** Read and validate the complete immutable input used by broker ranking/recommendations. */
export function readContextRunRetrievalState(
  database: SqliteDatabase,
  runId: string,
): ContextRunRetrievalState {
  const run = storedRun(database, runId);
  if (TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number])) {
    throw new KiokukoError('CONFLICT', 'Task run is terminal');
  }
  let link: ReturnType<typeof readRunIntakeLink>;
  try {
    link = readRunIntakeLink(database, { workspace: run.workspace, runId });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
      integrity('Stored context run intake state is invalid');
    }
    throw error;
  }
  let session: ReturnType<typeof readAkinatorSession>;
  try {
    session = readAkinatorSession(database, { workspace: run.workspace, sessionId: link.sessionId });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
      integrity('Stored context run intake state is invalid');
    }
    throw error;
  }
  if (link.runId !== run.runId
    || link.workspace !== run.workspace
    || session.id !== link.sessionId
    || session.workspace !== run.workspace) {
    integrity('Stored context run intake state is invalid');
  }
  const recommendedTags = validatedCurrentIntakeMetadata(link, session);
  const expectedRunStatus = session.status === 'active' ? 'intake' : 'active';
  if (run.status !== expectedRunStatus) {
    integrity('Context run status does not match its intake state');
  }
  const sessionProfileHash = canonicalContentHash(session.profile);
  if (session.status === 'active'
    ? link.initialProfileHash !== null || link.finalizedAt !== null
    : link.initialProfileHash !== sessionProfileHash || link.finalizedAt === null) {
    integrity('Context run intake link does not match its session state');
  }
  const events = validatedLedgerEvents(database, run);
  let projection: LedgerProjection | null = null;
  if (session.status !== 'active') {
    try {
      projection = projectLedger({
        initialProfile: session.profile,
        intakeStatus: session.status,
        coverage: run.coverage,
        throughSequence: run.lastSequence,
        events: events.map((event) => event.projection),
      });
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') {
        integrity('Stored context ledger projection state is invalid');
      }
      throw error;
    }
  }
  const profile = projection?.taskProfile ?? session.profile;
  const profileHash = projection?.profileHash ?? sessionProfileHash;
  const stateHash = canonicalContentHash({
    run: {
      runId: run.runId,
      workspace: run.workspace,
      status: run.status,
      title: run.title,
      coverage: run.coverage,
      lastSequence: run.lastSequence,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    intake: {
      session: {
        id: session.id,
        workspace: session.workspace,
        task: session.task,
        profile: session.profile,
        status: session.status,
        questionCount: session.questionCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      link: {
        runId: link.runId,
        sessionId: link.sessionId,
        workspace: link.workspace,
        policyVersion: link.policyVersion,
        profileSchemaVersion: link.profileSchemaVersion,
        profileSources: link.profileSources,
        initialProfileHash: link.initialProfileHash,
        recommendedTags: link.recommendedTags,
        linkedAt: link.linkedAt,
        finalizedAt: link.finalizedAt,
      },
    },
    events: events.map((event) => event.hashInput),
    projection,
  });
  return {
    run,
    profile,
    profileHash,
    recommendedTags,
    intakeSessionId: link.sessionId,
    intakeStatus: session.status,
    projection,
    stateHash,
  };
}
