import { createHash } from 'node:crypto';
import { KiokukoError } from '../errors.js';
import type { TaskProfile } from '../akinator/types.js';
import { COVERAGE_LEVELS, LEDGER_EVENT_TYPES, TASK_TYPES } from './types.js';
import type { Coverage, CoverageLevel, JsonValue, LedgerEventType } from './types.js';
import { canonicalJson } from './hash.js';

export type IntakeStatus = 'ready' | 'exhausted';
export type ProjectionCoverage = 'complete' | 'partial';
export type EvidenceState = 'none' | 'failed' | 'fresh' | 'stale';
export type MissingProfileField = 'taskType' | 'target' | 'expected';

export interface LedgerEventSnapshot {
  eventId: string;
  sequence: number;
  eventType: LedgerEventType;
  outcome?: string | null;
  payload?: JsonValue;
}

export interface LedgerProjectionInput {
  initialProfile: TaskProfile;
  intakeStatus: IntakeStatus;
  coverage: Coverage;
  throughSequence: number;
  events: LedgerEventSnapshot[];
}

export interface LedgerProjection {
  throughSequence: number;
  taskProfile: TaskProfile;
  profileHash: string;
  evidenceState: EvidenceState;
  unresolvedFailureEventIds: string[];
  unknownOutcomeEventIds: string[];
  latestMutationSequence: number | null;
  latestMutationEventIds: string[];
  latestPassingVerificationSequence: number | null;
  latestPassingVerificationEventIds: string[];
  coverage: ProjectionCoverage;
  declaredCoverage: Coverage;
  intakeIncomplete: boolean;
  missingProfileFields: MissingProfileField[];
}

const PROFILE_FIELDS = ['taskType', 'target', 'expected', 'constraints'] as const;
const REQUIRED_PROFILE_FIELDS = PROFILE_FIELDS;
const COVERAGE_FIELDS = ['run', 'tool', 'command', 'file', 'approval'] as const;
const EVENT_FIELDS = ['eventId', 'sequence', 'eventType', 'outcome', 'payload'] as const;
const TOP_LEVEL_FIELDS = ['initialProfile', 'intakeStatus', 'coverage', 'throughSequence', 'events'] as const;
const HIGH_VALUE_FIELDS: readonly MissingProfileField[] = ['taskType', 'target', 'expected'];
const PASSING_OUTCOMES = new Set(['pass', 'passed', 'success', 'succeeded']);
const FAILURE_EVENT_TYPES = new Set<LedgerEventType>(['step.failed', 'tool.failed', 'error.recorded']);
const VERIFICATION_EVENT_TYPES = new Set<LedgerEventType>(['verification.recorded', 'test.completed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function projectionValidation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Invalid ledger projection input');
}

function projectionIntegrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Invalid persisted ledger projection state');
}

function assertKnownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) projectionValidation();
  }
}

function assertRequiredFields(value: Record<string, unknown>, required: readonly string[]): void {
  for (const field of required) {
    if (!hasOwn(value, field)) projectionValidation();
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isTaskType(value: unknown): value is TaskProfile['taskType'] {
  return value === null || (typeof value === 'string' && TASK_TYPES.some((candidate) => candidate === value));
}

function isCoverageLevel(value: unknown): value is CoverageLevel {
  return typeof value === 'string' && COVERAGE_LEVELS.some((candidate) => candidate === value);
}

function isLedgerEventType(value: unknown): value is LedgerEventType {
  return typeof value === 'string' && LEDGER_EVENT_TYPES.some((candidate) => candidate === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    projectionValidation();
  }
  if (Array.isArray(value)) {
    for (const child of value) assertJsonValue(child);
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) assertJsonValue(child);
    return;
  }
  projectionValidation();
}

function parseProfile(value: unknown): TaskProfile {
  if (!isRecord(value)) projectionValidation();
  assertKnownFields(value, PROFILE_FIELDS);
  assertRequiredFields(value, REQUIRED_PROFILE_FIELDS);
  const taskType = value.taskType;
  const target = value.target;
  const expected = value.expected;
  const constraints = value.constraints;
  if (!isTaskType(taskType) || !isNullableString(target) || !isNullableString(expected) || !isNullableString(constraints)) {
    projectionValidation();
  }
  return { taskType, target, expected, constraints };
}

function profileHash(profile: TaskProfile): string {
  return createHash('sha256').update(canonicalJson(profile), 'utf8').digest('hex');
}

function applyRevision(profile: TaskProfile, payload: unknown): TaskProfile {
  if (!isRecord(payload)) projectionValidation();
  assertKnownFields(payload, ['profile']);
  if (!hasOwn(payload, 'profile')) projectionValidation();
  const revision = payload.profile;
  if (!isRecord(revision)) projectionValidation();
  assertKnownFields(revision, PROFILE_FIELDS);
  for (const field of Object.keys(revision)) {
    if (revision[field] === undefined) projectionValidation();
  }
  const next = { ...profile };
  if (hasOwn(revision, 'taskType')) {
    if (!isTaskType(revision.taskType)) projectionValidation();
    next.taskType = revision.taskType;
  }
  if (hasOwn(revision, 'target')) {
    if (!isNullableString(revision.target)) projectionValidation();
    next.target = revision.target;
  }
  if (hasOwn(revision, 'expected')) {
    if (!isNullableString(revision.expected)) projectionValidation();
    next.expected = revision.expected;
  }
  if (hasOwn(revision, 'constraints')) {
    if (!isNullableString(revision.constraints)) projectionValidation();
    next.constraints = revision.constraints;
  }
  return next;
}

function parseCoverage(value: unknown): Coverage {
  if (!isRecord(value)) projectionValidation();
  assertKnownFields(value, COVERAGE_FIELDS);
  assertRequiredFields(value, COVERAGE_FIELDS);
  const run = value.run;
  const tool = value.tool;
  const command = value.command;
  const file = value.file;
  const approval = value.approval;
  if (!isCoverageLevel(run) || !isCoverageLevel(tool) || !isCoverageLevel(command) || !isCoverageLevel(file) || !isCoverageLevel(approval)) {
    projectionValidation();
  }
  return { run, tool, command, file, approval };
}

function parseEvent(value: unknown): LedgerEventSnapshot {
  if (!isRecord(value)) projectionValidation();
  assertKnownFields(value, EVENT_FIELDS);
  assertRequiredFields(value, ['eventId', 'sequence', 'eventType']);
  const eventId = value.eventId;
  const sequence = value.sequence;
  const eventType = value.eventType;
  if (!isNonEmptyString(eventId)) projectionValidation();
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) projectionValidation();
  if (!isLedgerEventType(eventType)) projectionValidation();
  const event: LedgerEventSnapshot = { eventId, sequence, eventType };
  if (hasOwn(value, 'outcome')) {
    const outcome = value.outcome;
    if (outcome === null) event.outcome = null;
    else if (isNonEmptyString(outcome)) event.outcome = outcome;
    else projectionValidation();
  }
  if (hasOwn(value, 'payload')) {
    const payload = value.payload;
    assertJsonValue(payload);
    event.payload = payload;
  }
  return event;
}

function parseInput(value: unknown): LedgerProjectionInput {
  if (!isRecord(value)) projectionValidation();
  assertKnownFields(value, TOP_LEVEL_FIELDS);
  assertRequiredFields(value, TOP_LEVEL_FIELDS);
  const initialProfile = parseProfile(value.initialProfile);
  if (value.intakeStatus !== 'ready' && value.intakeStatus !== 'exhausted') projectionValidation();
  const coverage = parseCoverage(value.coverage);
  if (typeof value.throughSequence !== 'number' || !Number.isSafeInteger(value.throughSequence) || value.throughSequence < 0) projectionValidation();
  if (!Array.isArray(value.events)) projectionValidation();
  const events: LedgerEventSnapshot[] = [];
  const eventIds = new Set<string>();
  let previousSequence = -1;
  for (const rawEvent of value.events) {
    const event = parseEvent(rawEvent);
    if (eventIds.has(event.eventId) || event.sequence <= previousSequence || event.sequence > value.throughSequence) projectionValidation();
    eventIds.add(event.eventId);
    previousSequence = event.sequence;
    events.push(event);
  }
  return {
    initialProfile,
    intakeStatus: value.intakeStatus,
    coverage,
    throughSequence: value.throughSequence,
    events,
  };
}

function controlPayload(payload: JsonValue | undefined): Record<string, unknown> | null {
  return isRecord(payload) ? payload : null;
}

function resolutionIds(payload: JsonValue | undefined): string[] {
  const controls = controlPayload(payload);
  if (controls === null || !hasOwn(controls, 'resolvesEventIds')) return [];
  if (!Array.isArray(controls.resolvesEventIds)) projectionValidation();
  const ids: string[] = [];
  for (const id of controls.resolvesEventIds) {
    if (!isNonEmptyString(id)) projectionValidation();
    ids.push(id);
  }
  return ids;
}

function mutated(payload: JsonValue | undefined): boolean {
  const controls = controlPayload(payload);
  if (controls === null || !hasOwn(controls, 'mutated')) return false;
  if (typeof controls.mutated !== 'boolean') projectionValidation();
  return controls.mutated;
}

function evidenceOutcome(outcome: string | null | undefined): 'failed' | 'passed' | null {
  if (outcome === 'failed') return 'failed';
  if (outcome !== undefined && outcome !== null && PASSING_OUTCOMES.has(outcome)) return 'passed';
  return null;
}

function removeIds(ids: string[], toRemove: string[]): string[] {
  if (toRemove.length === 0) return ids;
  const removals = new Set(toRemove);
  return ids.filter((id) => !removals.has(id));
}

export function projectLedger(input: unknown): LedgerProjection {
  const parsed = parseInput(input);
  const missingProfileFields = HIGH_VALUE_FIELDS.filter((field) => parsed.initialProfile[field] === null);

  let taskProfile = { ...parsed.initialProfile };
  let latestMutationSequence: number | null = null;
  let latestMutationEventIds: string[] = [];
  let latestPassingVerificationSequence: number | null = null;
  let latestPassingVerificationEventIds: string[] = [];
  let latestEvidence: { outcome: 'failed' | 'passed'; sequence: number } | null = null;
  let unresolvedFailureEventIds: string[] = [];
  let unknownOutcomeEventIds: string[] = [];

  for (const event of parsed.events) {
    const resolves = resolutionIds(event.payload);
    unresolvedFailureEventIds = removeIds(unresolvedFailureEventIds, resolves);
    unknownOutcomeEventIds = removeIds(unknownOutcomeEventIds, resolves);

    if (event.eventType === 'task_profile.revised') {
      taskProfile = applyRevision(taskProfile, event.payload);
      latestMutationSequence = event.sequence;
      latestMutationEventIds = [event.eventId];
    } else if (event.eventType === 'file.changed' || ((event.eventType === 'command.completed' || event.eventType === 'tool.completed') && mutated(event.payload))) {
      latestMutationSequence = event.sequence;
      latestMutationEventIds = [event.eventId];
    }

    if (FAILURE_EVENT_TYPES.has(event.eventType) || ((event.eventType === 'test.completed' || event.eventType === 'verification.recorded') && event.outcome === 'failed')) {
      unresolvedFailureEventIds.push(event.eventId);
    }
    if (event.eventType === 'tool.outcome_unknown') unknownOutcomeEventIds.push(event.eventId);

    if (VERIFICATION_EVENT_TYPES.has(event.eventType)) {
      const outcome = evidenceOutcome(event.outcome);
      if (outcome !== null) {
        latestEvidence = { outcome, sequence: event.sequence };
        if (outcome === 'passed') {
          latestPassingVerificationSequence = event.sequence;
          latestPassingVerificationEventIds = [event.eventId];
        }
      }
    }
  }

  if (parsed.intakeStatus === 'ready' && missingProfileFields.length > 0) projectionIntegrity();

  let evidenceState: EvidenceState = 'none';
  if (latestEvidence?.outcome === 'failed') {
    evidenceState = 'failed';
  } else if (latestEvidence?.outcome === 'passed') {
    evidenceState = latestMutationSequence !== null && latestMutationSequence > latestEvidence.sequence ? 'stale' : 'fresh';
  }

  const declaredCoverage: Coverage = { ...parsed.coverage };
  const coverage: ProjectionCoverage = COVERAGE_FIELDS.every((field) => declaredCoverage[field] === 'complete') ? 'complete' : 'partial';
  return {
    throughSequence: parsed.throughSequence,
    taskProfile,
    profileHash: profileHash(taskProfile),
    evidenceState,
    unresolvedFailureEventIds,
    unknownOutcomeEventIds,
    latestMutationSequence,
    latestMutationEventIds,
    latestPassingVerificationSequence,
    latestPassingVerificationEventIds,
    coverage,
    declaredCoverage,
    intakeIncomplete: parsed.intakeStatus === 'exhausted' && missingProfileFields.length > 0,
    missingProfileFields,
  };
}
