import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalJson, type JsonValue } from '../serialization/validate.js';

export type TaskRequestOperation<T = JsonValue> = () => T;

type ValidatedInput = {
  readonly scope: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly createdAt: string;
};

const MAX_SCOPE_OR_KEY_LENGTH = 256;
const INPUT_FIELDS = new Set(['scope', 'key', 'request', 'createdAt']);
const CONTROL_CHARACTERS = /\p{Cc}/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VALIDATION_MESSAGE = 'Invalid idempotency input';
const RESPONSE_VALIDATION_MESSAGE = 'Invalid idempotency response';
const INTEGRITY_MESSAGE = 'Stored idempotency record is invalid';
const CONFLICT_MESSAGE = 'Idempotency key was reused with a different request';

type JsonValidationFailure = () => never;

function invalidInput(): never {
  throw new KiokukoError('VALIDATION_ERROR', VALIDATION_MESSAGE);
}

function invalidResponse(): never {
  throw new KiokukoError('VALIDATION_ERROR', RESPONSE_VALIDATION_MESSAGE);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isCanonicalArrayIndex(value: string): boolean {
  if (value === '0') return true;
  if (!/^[1-9]\d*$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index < 4_294_967_295 && String(index) === value;
}

function validateJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  failure: JsonValidationFailure,
): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    failure();
  }
  if (typeof value !== 'object') failure();
  if (ancestors.has(value)) failure();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || (key !== 'length' && !isCanonicalArrayIndex(key))) failure();
      }
      for (const item of value) validateJsonValue(item, ancestors, failure);
    } else {
      if (!isPlainObject(value)) failure();
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') failure();
      }
      for (const child of Object.values(value)) validateJsonValue(child, ancestors, failure);
    }
  } finally {
    ancestors.delete(value);
  }
}

function boundedString(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_SCOPE_OR_KEY_LENGTH
    || CONTROL_CHARACTERS.test(value)
  ) {
    invalidInput();
  }
  return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) invalidInput();
  return value;
}

function validateInput(input: unknown): ValidatedInput {
  if (!isPlainObject(input)) invalidInput();
  try {
    for (const field of Reflect.ownKeys(input)) {
      if (typeof field !== 'string' || !INPUT_FIELDS.has(field)) invalidInput();
    }
  } catch {
    invalidInput();
  }
  const scope = boundedString(input.scope);
  const key = boundedString(input.key);
  let requestJson: string;
  try {
    validateJsonValue(input.request, new WeakSet<object>(), invalidInput);
    requestJson = canonicalJson(input.request);
  } catch {
    invalidInput();
  }
  const createdAt = input.createdAt === undefined
    ? new Date().toISOString()
    : canonicalTimestamp(input.createdAt);
  return {
    scope,
    keyHash: sha256(key),
    requestHash: sha256(requestJson),
    createdAt,
  };
}

type StoredIdempotencyRow = {
  scope: unknown;
  key_hash: unknown;
  request_hash: unknown;
  response_json: unknown;
  created_at: unknown;
  run_id: unknown;
  purged_at: unknown;
};

type ValidStoredIdempotencyRow = StoredIdempotencyRow & {
  scope: string;
  key_hash: string;
  request_hash: string;
  response_json: string;
  created_at: string;
  purged_at: string | null;
};

function invalidStoredRecord(): never {
  throw new KiokukoError('INTEGRITY_ERROR', INTEGRITY_MESSAGE);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function validateStoredRecord(
  row: StoredIdempotencyRow,
  expectedScope: string,
): asserts row is ValidStoredIdempotencyRow {
  if (
    row.scope !== expectedScope
    || !isSha256(row.key_hash)
    || !isSha256(row.request_hash)
    || typeof row.response_json !== 'string'
    || !isCanonicalTimestamp(row.created_at)
  ) {
    invalidStoredRecord();
  }
  if (row.purged_at !== null) {
    if (!isCanonicalTimestamp(row.purged_at) || row.run_id !== null || row.response_json !== 'null') invalidStoredRecord();
  }
}

function storedResponse(row: StoredIdempotencyRow, expectedScope: string): JsonValue {
  validateStoredRecord(row, expectedScope);
  if (row.purged_at !== null) {
    throw new KiokukoError('CONFLICT', 'Idempotent task request was purged');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_json);
    if (canonicalJson(parsed) !== row.response_json) invalidStoredRecord();
  } catch {
    invalidStoredRecord();
  }
  return parsed as JsonValue;
}

function hasTaskReceiptRunBinding(database: SqliteDatabase): boolean {
  const columns = database.prepare('PRAGMA table_info(task_request_receipts)').all<{ name: unknown }>();
  return columns.some(({ name }) => name === 'run_id')
    && columns.some(({ name }) => name === 'purged_at');
}

function findStoredRecord(
  database: SqliteDatabase,
  validated: ValidatedInput,
): { requestHash: string; response: JsonValue } | undefined {
  const select = hasTaskReceiptRunBinding(database)
    ? `SELECT scope, key_hash, request_hash, response_json, created_at, run_id, purged_at
         FROM task_request_receipts`
    : `SELECT scope, key_hash, request_hash, response_json, created_at,
              NULL AS run_id, NULL AS purged_at
         FROM task_request_receipts`;
  const direct = database.prepare(`${select} WHERE scope = ? AND key_hash = ?`).get<StoredIdempotencyRow>(
    validated.scope,
    validated.keyHash,
  );
  if (direct) {
    const response = storedResponse(direct, validated.scope);
    return { requestHash: direct.request_hash as string, response };
  }

  for (const row of database.prepare(`${select} WHERE scope = ?`).all<StoredIdempotencyRow>(validated.scope)) {
    validateStoredRecord(row, validated.scope);
    if (row.key_hash === validated.keyHash) {
      const response = storedResponse(row, validated.scope);
      return { requestHash: row.request_hash as string, response };
    }
  }
  return undefined;
}

function validateOperation(operation: unknown): void {
  if (typeof operation !== 'function') invalidInput();
}

function executeValidated<T>(
  database: SqliteDatabase,
  validated: ValidatedInput,
  operation: TaskRequestOperation<T>,
): T {
  const existing = findStoredRecord(database, validated);
  if (existing) {
    if (existing.requestHash !== validated.requestHash) {
      throw new KiokukoError('CONFLICT', CONFLICT_MESSAGE, { reason: 'request_mismatch' });
    }
    return existing.response as T;
  }

  const responseValue = operation();
  let responseJson: string;
  try {
    validateJsonValue(responseValue, new WeakSet<object>(), invalidResponse);
    responseJson = canonicalJson(responseValue);
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', RESPONSE_VALIDATION_MESSAGE);
  }
  const taskRunScope = validated.scope === 'opencode.task.create'
    || validated.scope === 'opencode.task.answer';
  const runId = taskRunScope && isPlainObject(responseValue) && typeof responseValue.runId === 'string'
    ? responseValue.runId
    : null;
  if (hasTaskReceiptRunBinding(database)) {
    database.prepare(`
      INSERT INTO task_request_receipts (scope, key_hash, request_hash, response_json, created_at, run_id, purged_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      validated.scope, validated.keyHash, validated.requestHash, responseJson, validated.createdAt, runId,
    );
  } else {
    database.prepare(`
      INSERT INTO task_request_receipts (scope, key_hash, request_hash, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      validated.scope, validated.keyHash, validated.requestHash, responseJson, validated.createdAt,
    );
  }
  return JSON.parse(responseJson) as T;
}

export function executeTaskRequest<T>(
  database: SqliteDatabase,
  input: unknown,
  operation: TaskRequestOperation<T>,
): T {
  validateOperation(operation);
  const validated = validateInput(input);
  return withImmediateTransaction(database, () => executeValidated(database, validated, operation));
}

export function executeTaskRequestInTransaction<T>(
  database: SqliteDatabase,
  input: unknown,
  operation: TaskRequestOperation<T>,
): T {
  validateOperation(operation);
  const validated = validateInput(input);
  return executeValidated(database, validated, operation);
}
