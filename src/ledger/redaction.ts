import { canonicalJson } from './hash.js';
import { validateAnswerInput, validateEventInput, validateProfileHints, validateTaskInput } from './validate.js';
import { MAX_EVENT_PAYLOAD_BYTES, type AnswerInput, type LedgerEventInput, type ProfileHints, type SanitizationOptions, type Sanitized, type TaskInput } from './types.js';
import { sanitizeJson } from '../security/sanitize.js';
import type { JsonValue } from './types.js';
import { KiokukoError } from '../errors.js';

function snapshotTooLarge(label: string): never {
  throw new KiokukoError('VALIDATION_ERROR', `sanitized ${label} exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
}

function assertBounded(value: unknown, label: string): void {
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_EVENT_PAYLOAD_BYTES) snapshotTooLarge(label);
}

function withTypedValue<T>(value: unknown, options: SanitizationOptions, validator: (input: unknown) => T, label: string): Sanitized<T> {
  const validated = validator(value);
  const result = sanitizeJson(validated, options);
  assertBounded(result.value, label);
  return { value: result.value as unknown as T, redactions: result.redactions, truncated: result.truncated };
}

export function sanitizeEvent(value: unknown, options: SanitizationOptions = {}): Sanitized<LedgerEventInput> {
  const validated = validateEventInput(value);
  const result = sanitizeJson(validated, options);
  const payload = (result.value as { payload: JsonValue }).payload;
  assertBounded(payload, 'event payload');
  return { value: result.value as unknown as LedgerEventInput, redactions: result.redactions, truncated: result.truncated };
}

export function sanitizeTask(value: unknown, options: SanitizationOptions = {}): Sanitized<TaskInput> {
  return withTypedValue(value, options, validateTaskInput, 'task snapshot');
}

export function sanitizeProfileHints(value: unknown, options: SanitizationOptions = {}): Sanitized<ProfileHints> {
  return withTypedValue(value, options, validateProfileHints, 'profile hints snapshot');
}

export function sanitizeAnswer(value: unknown, options: SanitizationOptions = {}): Sanitized<AnswerInput> {
  return withTypedValue(value, options, validateAnswerInput, 'answer snapshot');
}

export function sanitizeRunMetadata(value: JsonValue, options: SanitizationOptions = {}): Sanitized<JsonValue> {
  const result = sanitizeJson(value, options);
  assertBounded(result.value, 'run metadata');
  return { value: result.value, redactions: result.redactions, truncated: result.truncated };
}
