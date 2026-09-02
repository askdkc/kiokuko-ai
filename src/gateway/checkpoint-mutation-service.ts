import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readAkinatorSession, readRunIntakeLink } from '../akinator/store.js';
import { checkpointEligibility } from '../ledger/checkpoint-eligibility.js';
import { projectLedger, type LedgerProjection } from '../ledger/projection.js';
import { LedgerStore } from '../ledger/store.js';
import { sanitizeEvent } from '../ledger/redaction.js';
import { validateEventBatch, validateTimestamp } from '../ledger/validate.js';
import { COVERAGE_LEVELS, type JsonObject, type JsonValue, type LedgerEventInput, type LedgerEventType, type RunStatus } from '../ledger/types.js';
import { executeIdempotentInTransaction } from '../server/idempotency.js';
import {
  buildRecommendations,
  RECOMMENDATION_CODES,
  RECOMMENDATION_PRIORITY,
  type Recommendation,
} from '../context/recommendations.js';
import { readContextRunRetrievalState } from '../context/run-state.js';
import {
  recordContextFeedbackInTransaction,
  validateFeedbackTimestamp,
} from '../context/feedback.js';
import { canonicalJson } from '../serialization/validate.js';

const CHECKPOINT_EVENT_TYPES: readonly LedgerEventType[] = [
  'step.started', 'step.completed', 'step.failed', 'file.changed', 'error.recorded',
  'context.feedback', 'task_profile.revised', 'correction.recorded', 'request.received',
];
const MAX_TEXT = 4_096;
const MAX_ARRAY = 200;
const PROFILE_FIELDS = ['taskType', 'target', 'expected', 'constraints'] as const;
const TASK_TYPES = ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'] as const;

type CheckpointRequest = {
  events: LedgerEventInput[];
  contextFeedback: unknown[];
  characterBudget: number;
};

export interface CheckpointMutationResult {
  readonly runId: string;
  readonly acceptedThrough: number;
  readonly localSequences: readonly number[];
  readonly sourceSequences: readonly (number | null)[];
  readonly eventIds: readonly string[];
  readonly runStatus: 'active';
  readonly intakeStatus: 'ready' | 'exhausted';
  readonly taskProfile: {
    readonly taskType: string | null;
    readonly target: string | null;
    readonly expected: string | null;
    readonly constraints: string | null;
    readonly source: 'akinator+ledger-revisions';
  };
  readonly profileHash: string;
  readonly projection: LedgerProjection;
  readonly preliminaryRecommendations: readonly Recommendation[];
  readonly characterBudget: number;
}

export interface CheckpointMutationPort {
  checkpoint(input: unknown): CheckpointMutationResult | PromiseLike<CheckpointMutationResult>;
}

type PersistedCheckpointAcknowledgement = Omit<CheckpointMutationResult, 'preliminaryRecommendations'> & {
  readonly recommendations: readonly Recommendation[];
  readonly nudge: null;
  readonly context: null;
  readonly untrusted: true;
};

function validation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Invalid checkpoint request');
}

function conflict(message = 'Checkpoint requires an active run'): never {
  throw new KiokukoError('CONFLICT', message);
}

function checkpointIntegrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Stored checkpoint acknowledgement is invalid');
}

function assertCheckpointEligible(status: RunStatus): void {
  const eligibility = checkpointEligibility(status);
  if (eligibility.allowed) return;
  throw new KiokukoError('CONFLICT', status === 'intake'
    ? 'Checkpoint is not allowed during intake'
    : 'Checkpoint is not allowed for a terminal run', {
      checkpointEligibility: eligibility,
      runStatus: status,
    });
}

function assertPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) validation();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) validation();
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length') || keys.some((key) => typeof key !== 'string')) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  if (!isDenseArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') return false;
  }
  return true;
}

function isNumberArray(value: unknown): value is number[] {
  if (!isDenseArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'number'
      || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0) return false;
  }
  return true;
}

function isSourceSequenceArray(value: unknown): value is Array<number | null> {
  if (!isDenseArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)
      || (descriptor.value !== null && (typeof descriptor.value !== 'number'
        || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0))) return false;
  }
  return true;
}

function isNonNegativeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isTaskProfile(value: unknown): value is LedgerProjection['taskProfile'] {
  if (!isPlainRecord(value)) return false;
  return (value.taskType === null || (typeof value.taskType === 'string'
    && TASK_TYPES.includes(value.taskType as (typeof TASK_TYPES)[number])))
    && isNullableString(value.target)
    && isNullableString(value.expected)
    && isNullableString(value.constraints);
}

function isResponseTaskProfile(value: unknown): value is CheckpointMutationResult['taskProfile'] {
  return isTaskProfile(value) && isPlainRecord(value) && value.source === 'akinator+ledger-revisions';
}

function isCoverage(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (['run', 'tool', 'command', 'file', 'approval'] as const).every((field) => (
    typeof value[field] === 'string' && COVERAGE_LEVELS.includes(value[field] as (typeof COVERAGE_LEVELS)[number])
  ));
}

function isProjection(value: unknown): value is LedgerProjection {
  if (!isPlainRecord(value)) return false;
  const evidenceStates = ['none', 'failed', 'fresh', 'stale'] as const;
  const missingFields = ['taskType', 'target', 'expected'] as const;
  return isNonNegativeSequence(value.throughSequence)
    && isTaskProfile(value.taskProfile)
    && typeof value.profileHash === 'string'
    && typeof value.evidenceState === 'string'
    && evidenceStates.includes(value.evidenceState as (typeof evidenceStates)[number])
    && isStringArray(value.unresolvedFailureEventIds)
    && isStringArray(value.unknownOutcomeEventIds)
    && (value.latestMutationSequence === null || isNonNegativeSequence(value.latestMutationSequence))
    && isStringArray(value.latestMutationEventIds)
    && (value.latestPassingVerificationSequence === null || isNonNegativeSequence(value.latestPassingVerificationSequence))
    && isStringArray(value.latestPassingVerificationEventIds)
    && (value.coverage === 'complete' || value.coverage === 'partial')
    && isCoverage(value.declaredCoverage)
    && typeof value.intakeIncomplete === 'boolean'
    && isDenseArray(value.missingProfileFields)
    && value.missingProfileFields.every((field) => typeof field === 'string'
      && missingFields.includes(field as (typeof missingFields)[number]));
}

function isRecommendation(value: unknown): value is Recommendation {
  if (!isPlainRecord(value) || typeof value.code !== 'string'
    || !RECOMMENDATION_CODES.includes(value.code as (typeof RECOMMENDATION_CODES)[number])
    || typeof value.message !== 'string'
    || !isStringArray(value.evidenceEventIds)
    || typeof value.priority !== 'number'
    || value.priority !== RECOMMENDATION_PRIORITY[value.code as (typeof RECOMMENDATION_CODES)[number]]
    || value.untrusted !== true
    || value.actionable !== false
    || !isPlainRecord(value.metadata)
    || typeof value.metadata.truncated !== 'boolean'
    || !isStringArray(value.metadata.referenceIds)) return false;
  return value.metadata.incompleteCoverageCategories === undefined
    || isStringArray(value.metadata.incompleteCoverageCategories);
}

function isRecommendationArray(value: unknown): value is Recommendation[] {
  if (!isDenseArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !isRecommendation(descriptor.value)) return false;
  }
  return true;
}

function isCheckpointMutationResult(value: unknown): value is CheckpointMutationResult {
  if (!isPlainRecord(value)) return false;
  return typeof value.runId === 'string'
    && isNonNegativeSequence(value.acceptedThrough)
    && isNumberArray(value.localSequences)
    && isSourceSequenceArray(value.sourceSequences)
    && isStringArray(value.eventIds)
    && value.runStatus === 'active'
    && (value.intakeStatus === 'ready' || value.intakeStatus === 'exhausted')
    && isResponseTaskProfile(value.taskProfile)
    && typeof value.profileHash === 'string'
    && isProjection(value.projection)
    && isRecommendationArray(value.preliminaryRecommendations)
    && typeof value.characterBudget === 'number'
    && Number.isSafeInteger(value.characterBudget)
    && value.characterBudget >= 1
    && value.characterBudget <= 100_000;
}

function storedCheckpointObject(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored checkpoint acknowledgement is invalid');
  }
  return value;
}

function serializeCheckpointAcknowledgement(
  value: CheckpointMutationResult,
): PersistedCheckpointAcknowledgement {
  const { preliminaryRecommendations, ...acknowledgement } = value;
  return {
    ...acknowledgement,
    recommendations: preliminaryRecommendations,
    nudge: null,
    context: null,
    untrusted: true,
  };
}

function sameTaskProfile(
  left: CheckpointMutationResult['taskProfile'],
  right: LedgerProjection['taskProfile'],
): boolean {
  return left.taskType === right.taskType
    && left.target === right.target
    && left.expected === right.expected
    && left.constraints === right.constraints;
}

interface CheckpointLedgerEventRow extends SqliteRow {
  sequence: unknown;
  source_sequence: unknown;
  event_id: unknown;
}

function assertCheckpointAcknowledgementAgainstLedger(
  database: SqliteDatabase,
  acknowledgement: CheckpointMutationResult,
): void {
  if (acknowledgement.localSequences.length > MAX_ARRAY) checkpointIntegrity();
  const placeholders = acknowledgement.localSequences.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT sequence, source_sequence, event_id
      FROM ledger_events
     WHERE run_id = ?
       AND sequence IN (${placeholders})
     ORDER BY sequence ASC
  `).all<CheckpointLedgerEventRow>(acknowledgement.runId, ...acknowledgement.localSequences);
  if (rows.length !== acknowledgement.localSequences.length) checkpointIntegrity();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined
      || row.sequence !== acknowledgement.localSequences[index]
      || row.source_sequence !== acknowledgement.sourceSequences[index]
      || row.event_id !== acknowledgement.eventIds[index]) {
      checkpointIntegrity();
    }
  }
}

function assertCheckpointMutationInvariants(
  normalized: CheckpointMutationResult,
  expected: { runId: string; characterBudget: number },
  database: SqliteDatabase,
): void {
  if (normalized.runId !== expected.runId
    || normalized.characterBudget !== expected.characterBudget
    || normalized.acceptedThrough !== normalized.projection.throughSequence
    || normalized.profileHash !== normalized.projection.profileHash
    || !sameTaskProfile(normalized.taskProfile, normalized.projection.taskProfile)
    || normalized.localSequences.length === 0
    || normalized.localSequences.length !== normalized.sourceSequences.length
    || normalized.localSequences.length !== normalized.eventIds.length
    || normalized.localSequences.at(-1) !== normalized.acceptedThrough) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored checkpoint acknowledgement is invalid');
  }

  assertCheckpointAcknowledgementAgainstLedger(database, normalized);

  let authoritative: ReturnType<typeof projectionFor>;
  try {
    authoritative = projectionFor(database, normalized.runId, normalized.acceptedThrough);
  } catch (error) {
    if (error instanceof KiokukoError) checkpointIntegrity();
    throw error;
  }
  if (authoritative.intakeStatus !== normalized.intakeStatus
    || canonicalJson(authoritative.projection) !== canonicalJson(normalized.projection)
    || normalized.profileHash !== authoritative.projection.profileHash
    || !sameTaskProfile(normalized.taskProfile, authoritative.projection.taskProfile)) {
    checkpointIntegrity();
  }

  let recommendations: Recommendation[];
  try {
    recommendations = buildRecommendations({ projection: authoritative.projection, broker: {} });
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored checkpoint acknowledgement is invalid');
  }
  if (canonicalJson(normalized.preliminaryRecommendations) !== canonicalJson(recommendations)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored checkpoint acknowledgement is invalid');
  }
}

function normalizeCheckpointMutationResult(
  database: SqliteDatabase,
  value: unknown,
  expected: { runId: string; characterBudget: number },
): CheckpointMutationResult {
  const object = storedCheckpointObject(value);
  const recommendations = Object.hasOwn(object, 'preliminaryRecommendations')
    ? object.preliminaryRecommendations
    : object.recommendations;
  const normalized = { ...object, preliminaryRecommendations: recommendations };
  if (!isCheckpointMutationResult(normalized)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored checkpoint acknowledgement is invalid');
  }
  const result = {
    runId: normalized.runId,
    acceptedThrough: normalized.acceptedThrough,
    localSequences: normalized.localSequences,
    sourceSequences: normalized.sourceSequences,
    eventIds: normalized.eventIds,
    runStatus: normalized.runStatus,
    intakeStatus: normalized.intakeStatus,
    taskProfile: normalized.taskProfile,
    profileHash: normalized.profileHash,
    projection: normalized.projection,
    preliminaryRecommendations: normalized.preliminaryRecommendations,
    characterBudget: normalized.characterBudget,
  };
  assertCheckpointMutationInvariants(result, expected, database);
  return result;
}

function boundedString(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /\p{Cc}/u.test(value)) validation();
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY) validation();
  return value.map((item) => boundedString(item));
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  const object = assertPlainObject(value);
  const result: JsonObject = {};
  for (const key of Object.keys(object)) result[key] = jsonValue(object[key]);
  return result;
}

function partialProfile(value: unknown): JsonObject {
  const object = assertPlainObject(value);
  if (Object.keys(object).some((field) => !PROFILE_FIELDS.includes(field as (typeof PROFILE_FIELDS)[number]))) validation();
  const result: JsonObject = {};
  for (const field of PROFILE_FIELDS) {
    if (!Object.hasOwn(object, field)) continue;
    const fieldValue = object[field];
    if (field === 'taskType') {
      if (fieldValue !== null && (typeof fieldValue !== 'string' || !TASK_TYPES.includes(fieldValue as (typeof TASK_TYPES)[number]))) validation();
    } else if (fieldValue !== null && typeof fieldValue !== 'string') {
      validation();
    }
    result[field] = jsonValue(fieldValue);
  }
  if (Object.keys(result).length === 0) validation();
  return result;
}

function event(eventType: LedgerEventType, payload: JsonValue, now: string): LedgerEventInput {
  return { eventId: randomUUID(), eventType, actor: 'kiokuko-checkpoint', occurredAt: now, payload };
}

function normalizeRequest(raw: unknown, workspace: string, now: string): CheckpointRequest {
  const value = assertPlainObject(raw);
  const allowed = new Set([
    'apiVersion', 'events', 'currentGoal', 'currentStep', 'changedPaths', 'errorSignatures',
    'unresolvedItems', 'contextFeedback', 'taskProfileRevision', 'characterBudget',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.apiVersion !== '1') validation();
  const events: LedgerEventInput[] = [];
  if (value.events !== undefined) {
    if (!Array.isArray(value.events) || value.events.length === 0) validation();
    const validated = validateEventBatch({ events: value.events });
    for (const item of validated) {
      if (!CHECKPOINT_EVENT_TYPES.includes(item.eventType)) validation();
      events.push(sanitizeEvent(item, { workspace }).value);
    }
  }
  if (value.currentGoal !== undefined) events.push(event('step.started', { goal: boundedString(value.currentGoal) }, now));
  if (value.currentStep !== undefined) events.push(event('step.started', { step: boundedString(value.currentStep) }, now));
  if (value.changedPaths !== undefined) {
    for (const path of stringArray(value.changedPaths)) events.push(event('file.changed', { path }, now));
  }
  if (value.errorSignatures !== undefined) {
    for (const signature of stringArray(value.errorSignatures)) events.push(event('error.recorded', { signature }, now));
  }
  if (value.unresolvedItems !== undefined) {
    for (const item of stringArray(value.unresolvedItems)) events.push(event('correction.recorded', { unresolved: item }, now));
  }
  if (value.taskProfileRevision !== undefined) events.push(event('task_profile.revised', { profile: partialProfile(value.taskProfileRevision) }, now));
  const contextFeedback = value.contextFeedback === undefined ? [] : (() => {
    if (!Array.isArray(value.contextFeedback) || value.contextFeedback.length > MAX_ARRAY) validation();
    return value.contextFeedback.map((item) => {
      const feedback = assertPlainObject(item);
      if (feedback.comment !== undefined && feedback.comment !== null) boundedString(feedback.comment);
      return item;
    });
  })();
  for (const feedback of contextFeedback) events.push(event('context.feedback', jsonValue(feedback), now));
  if (events.length === 0 || events.length > 200) validation();
  const characterBudget = value.characterBudget === undefined ? 8_000 : value.characterBudget;
  if (typeof characterBudget !== 'number' || !Number.isSafeInteger(characterBudget) || characterBudget < 1 || characterBudget > 100_000) validation();
  return { events, contextFeedback, characterBudget };
}

function projectionFor(
  database: SqliteDatabase,
  runId: string,
  acceptedThrough: number,
): { intakeStatus: CheckpointMutationResult['intakeStatus']; projection: LedgerProjection } {
  const state = readContextRunRetrievalState(database, runId);
  if (acceptedThrough > state.run.lastSequence) {
    checkpointIntegrity();
  }
  const store = new LedgerStore(database);
  const run = state.run;
  const link = readRunIntakeLink(database, { workspace: run.workspace, runId });
  const session = readAkinatorSession(database, { workspace: run.workspace, sessionId: link.sessionId });
  if (session.status !== 'ready' && session.status !== 'exhausted') conflict('Checkpoint requires finalized intake');
  const events = store.readEvents(runId).filter((row) => row.sequence <= acceptedThrough).map((row) => ({
    eventId: row.event_id,
    sequence: row.sequence,
    eventType: row.event_type as LedgerEventType,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.payload_json === null ? {} : { payload: JSON.parse(row.payload_json) as JsonValue }),
  }));
  return {
    intakeStatus: session.status,
    projection: projectLedger({
      initialProfile: session.profile,
      intakeStatus: session.status,
      coverage: run.coverage,
      throughSequence: acceptedThrough,
      events,
    }),
  };
}

function mutationValue(
  database: SqliteDatabase,
  runId: string,
  request: CheckpointRequest,
  idempotencyKey: string,
  now: string,
): CheckpointMutationResult {
  // Validate the authoritative state before the first mutation.
  const currentRun = new LedgerStore(database).readRun(runId);
  if (!currentRun) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
  assertCheckpointEligible(currentRun.status);
  const state = readContextRunRetrievalState(database, runId);
  const run = state.run;
  const store = new LedgerStore(database);
  const ack = store.appendBatchInTransaction(runId, { events: request.events });
  for (let index = 0; index < request.contextFeedback.length; index += 1) {
    const feedback = assertPlainObject(request.contextFeedback[index]);
    recordContextFeedbackInTransaction(database, {
      ...feedback,
      workspace: run.workspace,
      runId,
      actor: Object.hasOwn(feedback, 'actor') ? feedback.actor : 'kiokuko-checkpoint',
      idempotencyKey: `${idempotencyKey}:context:${index}`,
      createdAt: Object.hasOwn(feedback, 'createdAt') ? validateFeedbackTimestamp(feedback.createdAt) : now,
    });
  }
  const { intakeStatus, projection } = projectionFor(database, runId, ack.acceptedThrough);
  const preliminaryRecommendations = buildRecommendations({ projection, broker: {} });
  return {
    ...ack,
    runStatus: 'active',
    intakeStatus,
    taskProfile: { ...projection.taskProfile, source: 'akinator+ledger-revisions' },
    profileHash: projection.profileHash,
    projection,
    preliminaryRecommendations,
    characterBudget: request.characterBudget,
  };
}

export class CheckpointMutationService {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  checkpoint(input: unknown): CheckpointMutationResult {
    const value = assertPlainObject(input);
    if (typeof value.runId !== 'string' || value.runId.length === 0 || typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length === 0) validation();
    const run = new LedgerStore(this.database).readRun(value.runId);
    if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
    const now = validateTimestamp(this.now(), 'createdAt');
    const request = normalizeRequest(value.request, run.workspace, now);
    return withImmediateTransaction(this.database, () => {
      const response = executeIdempotentInTransaction(
        this.database,
        { scope: `agent.checkpoint.${value.runId}`, key: value.idempotencyKey, request: value.request, createdAt: now },
        () => serializeCheckpointAcknowledgement(
          mutationValue(this.database, value.runId as string, request, value.idempotencyKey as string, now),
        ) as unknown as JsonValue,
      );
      return normalizeCheckpointMutationResult(this.database, response, {
        runId: value.runId as string,
        characterBudget: request.characterBudget,
      });
    });
  }
}
