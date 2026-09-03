import { KiokukoError } from '../errors.js';
import { findSecret } from '../memory/secrets.js';
import {
  CAPTURE_PROFILES,
  COVERAGE_LEVELS,
  LEDGER_EVENT_TYPES,
  MAX_BATCH_EVENTS,
  MAX_ID_LENGTH,
  MAX_TEXT_LENGTH,
  RUN_STATUSES,
  TASK_TYPES,
  type AnswerInput,
  type ClientInput,
  type CreateRunInput,
  type Coverage,
  type JsonObject,
  type JsonValue,
  type LedgerEventInput,
  type ProfileHints,
  type RunStatus,
  type TaskInput,
} from './types.js';

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) validation(`${label} must be a JSON object`);
  return value;
}

function knownFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) validation(`Unknown ${label} field`);
}

function nonEmptyString(value: unknown, label: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\u0000')) {
    validation(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function nullableString(value: unknown, label: string, max = MAX_TEXT_LENGTH): string | null {
  if (value === null) return null;
  return nonEmptyString(value, label, max);
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) validation(`${label} has an invalid enum value`);
  return value as T[number];
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    validation(`${label} must contain finite JSON numbers`);
  }
  if (Array.isArray(value)) return value.map((child, index) => jsonValue(child, `${label}[${index}]`));
  if (isPlainObject(value)) {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (findSecret(key)) throw new KiokukoError('SECURITY_REJECTION', 'JSON object key contains secret material');
      result[key] = jsonValue(child, `${label} field`);
    }
    return result;
  }
  validation(`${label} must be JSON-compatible`);
}

export function validateTimestamp(value: unknown, label = 'timestamp'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) validation(`${label} must be an ISO-8601 UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) validation(`${label} must be a valid ISO-8601 UTC timestamp`);
  return value;
}

export function validateProfileHints(value: unknown): ProfileHints {
  const input = object(value, 'profile hints');
  knownFields(input, ['taskType', 'target', 'expected', 'constraints'], 'profile hints');
  const taskType = input.taskType === null ? null : enumValue(input.taskType, TASK_TYPES, 'profileHints.taskType');
  const target = nullableString(input.target, 'profileHints.target');
  const expected = nullableString(input.expected, 'profileHints.expected');
  const constraints = input.constraints === null ? null : jsonValue(input.constraints, 'profileHints.constraints');
  return { taskType, target, expected, constraints };
}

export function validateTaskInput(value: unknown): TaskInput {
  const input = object(value, 'task');
  knownFields(input, ['title', 'query', 'profileHints'], 'task');
  return {
    title: nonEmptyString(input.title, 'task.title'),
    query: nonEmptyString(input.query, 'task.query'),
    profileHints: validateProfileHints(input.profileHints),
  };
}

export function validateAnswerInput(value: unknown): AnswerInput {
  const input = object(value, 'answer');
  knownFields(input, ['apiVersion', 'questionId', 'value'], 'answer');
  return {
    apiVersion: enumValue(input.apiVersion, ['1'] as const, 'answer.apiVersion'),
    questionId: nonEmptyString(input.questionId, 'answer.questionId', MAX_ID_LENGTH),
    value: jsonValue(input.value, 'answer.value'),
  };
}

function validateClient(value: unknown): ClientInput {
  const input = object(value, 'client');
  knownFields(input, ['kind', 'version', 'sessionId'], 'client');
  const kind = nonEmptyString(input.kind, 'client.kind', MAX_ID_LENGTH);
  if (kind !== 'opencode') {
    throw new KiokukoError('UNSUPPORTED_CLIENT', 'Only OpenCode task runs are supported');
  }
  return {
    kind,
    ...(input.version === undefined ? {} : { version: nonEmptyString(input.version, 'client.version', MAX_ID_LENGTH) }),
    ...(input.sessionId === undefined ? {} : { sessionId: nonEmptyString(input.sessionId, 'client.sessionId', MAX_ID_LENGTH) }),
  };
}

function validateCoverage(value: unknown): Coverage {
  const input = object(value, 'coverage');
  const fields = ['run', 'tool', 'command', 'file', 'approval'] as const;
  knownFields(input, fields, 'coverage');
  const result = {} as Coverage;
  for (const field of fields) result[field] = enumValue(input[field], COVERAGE_LEVELS, `coverage.${field}`);
  return result;
}

export function validateEventInput(value: unknown): LedgerEventInput {
  const input = object(value, 'event');
  knownFields(input, ['eventId', 'sourceEventId', 'sourceSequence', 'eventType', 'sourceType', 'actor', 'outcome', 'occurredAt', 'payload'], 'event');
  if (input.sourceSequence !== undefined && (typeof input.sourceSequence !== 'number' || !Number.isSafeInteger(input.sourceSequence) || input.sourceSequence < 0)) validation('sourceSequence must be a non-negative safe integer');
  const sourceSequence = input.sourceSequence as number | undefined;
  const occurredAt = input.occurredAt === undefined ? undefined : validateTimestamp(input.occurredAt, 'occurredAt');
  const outcome = input.outcome === undefined || input.outcome === null ? input.outcome : nonEmptyString(input.outcome, 'outcome', MAX_ID_LENGTH);
  return {
    ...(input.eventId === undefined ? {} : { eventId: nonEmptyString(input.eventId, 'eventId', MAX_ID_LENGTH) }),
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: nonEmptyString(input.sourceEventId, 'sourceEventId', MAX_ID_LENGTH) }),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    eventType: enumValue(input.eventType, LEDGER_EVENT_TYPES, 'eventType'),
    ...(input.sourceType === undefined ? {} : { sourceType: nonEmptyString(input.sourceType, 'sourceType', MAX_ID_LENGTH) }),
    actor: nonEmptyString(input.actor, 'actor', MAX_ID_LENGTH),
    ...(outcome === undefined ? {} : { outcome }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    payload: jsonValue(input.payload, 'payload'),
  };
}

export function validateEventBatch(value: unknown): LedgerEventInput[] {
  const input = object(value, 'event batch');
  knownFields(input, ['events'], 'event batch');
  if (!Array.isArray(input.events) || input.events.length === 0) validation('event batch must contain at least one event');
  if (input.events.length > MAX_BATCH_EVENTS) validation(`event batch must contain at most ${MAX_BATCH_EVENTS} events`);
  return input.events.map((event, index) => {
    try {
      return validateEventInput(event);
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') throw new KiokukoError('VALIDATION_ERROR', `Invalid event at batch index ${index}`);
      throw error;
    }
  });
}

export function validateRunInput(value: unknown): CreateRunInput {
  const input = object(value, 'run');
  knownFields(input, ['runId', 'workspace', 'protocolVersion', 'client', 'captureProfile', 'coverage', 'task', 'metadata', 'parentRunId', 'startedAt'], 'run');
  const metadata = input.metadata === undefined ? {} : object(input.metadata, 'metadata');
  const metadataJson = jsonValue(metadata, 'metadata');
  if (!isPlainObject(metadataJson)) validation('metadata must be a JSON object');
  const startedAt = input.startedAt === undefined ? undefined : validateTimestamp(input.startedAt, 'startedAt');
  const workspace = nonEmptyString(input.workspace, 'workspace', MAX_TEXT_LENGTH);
  if (findSecret(workspace)) throw new KiokukoError('SECURITY_REJECTION', 'Workspace contains secret material');
  return {
    runId: nonEmptyString(input.runId, 'runId', MAX_ID_LENGTH),
    workspace,
    protocolVersion: enumValue(input.protocolVersion, ['1'] as const, 'protocolVersion'),
    client: validateClient(input.client),
    captureProfile: enumValue(input.captureProfile, CAPTURE_PROFILES, 'captureProfile'),
    coverage: validateCoverage(input.coverage),
    task: validateTaskInput(input.task),
    metadata: metadataJson as JsonObject,
    ...(input.parentRunId === undefined ? {} : { parentRunId: nonEmptyString(input.parentRunId, 'parentRunId', MAX_ID_LENGTH) }),
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

export function validateRunStatus(value: unknown): RunStatus {
  return enumValue(value, RUN_STATUSES, 'run status');
}
