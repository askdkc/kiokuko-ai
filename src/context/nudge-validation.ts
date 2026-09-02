import { KiokukoError } from '../errors.js';
import { canonicalJson, compareCanonicalStrings } from '../serialization/validate.js';
import {
  NUDGE_CODES,
  NUDGE_POLICY_VERSION,
  NUDGE_PRIORITY,
  type NudgeCode,
  type NudgeRateLimitPolicy,
} from './nudges.js';

export interface StoredNudgeHistoryItem {
  readonly occurrenceId: string;
  readonly checkpointId: string;
  readonly code: NudgeCode;
  readonly throughSequence: number;
}

export interface StoredNudgeDelivery {
  readonly id: string;
  readonly policyVersion: typeof NUDGE_POLICY_VERSION;
  readonly occurrenceId: string;
  readonly checkpointId: string;
  readonly code: NudgeCode;
  readonly throughSequence: number;
  readonly priority: number;
  readonly evidenceEventIds: readonly string[];
  readonly referenceIds: readonly string[];
  readonly deliveredAt: string;
}

function integrity(message = 'Stored nudge delivery is invalid'): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !value.includes('\u0000');
}

export function parseInputIdentifier(value: unknown, label: string): string {
  if (!validIdentifier(value)) throw new KiokukoError('VALIDATION_ERROR', `${label} must be a non-empty bounded string`);
  return value;
}

export function parseStoredIdentifier(value: unknown, label: string): string {
  if (!validIdentifier(value)) integrity(`Stored nudge ${label} is invalid`);
  return value;
}

export function parseStoredNudgeCode(value: unknown): NudgeCode {
  if (typeof value !== 'string' || !NUDGE_CODES.includes(value as NudgeCode)) integrity('Stored nudge code is invalid');
  return value as NudgeCode;
}

export function parseStoredPolicyVersion(value: unknown): typeof NUDGE_POLICY_VERSION {
  if (value !== NUDGE_POLICY_VERSION) integrity('Stored nudge policy version is invalid');
  return NUDGE_POLICY_VERSION;
}

function parseStoredSequence(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) integrity(`Stored nudge ${label} is invalid`);
  return value;
}

function parseStoredTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) integrity('Stored nudge timestamp is invalid');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) integrity('Stored nudge timestamp is invalid');
  return value;
}

function parseStoredIdList(value: unknown, label: string): string[] {
  if (typeof value !== 'string') integrity(`Stored nudge ${label} is invalid`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    integrity(`Stored nudge ${label} is invalid`);
  }
  if (!Array.isArray(parsed) || parsed.length > 16) integrity(`Stored nudge ${label} is invalid`);
  const result = parsed.map((item) => parseStoredIdentifier(item, label));
  if (new Set(result).size !== result.length) integrity(`Stored nudge ${label} is invalid`);
  for (let index = 1; index < result.length; index += 1) {
    if (compareCanonicalStrings(result[index - 1]!, result[index]!) > 0) {
      integrity(`Stored nudge ${label} is invalid`);
    }
  }
  if (canonicalJson(result) !== value) integrity(`Stored nudge ${label} is invalid`);
  return result;
}

export function parseStoredNudgeDelivery(value: unknown): StoredNudgeDelivery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) integrity();
  const row = value as Record<string, unknown>;
  const code = parseStoredNudgeCode(row.code);
  const priority = parseStoredSequence(row.priority, 'priority');
  if (priority !== NUDGE_PRIORITY[code]) integrity('Stored nudge priority is invalid');
  return {
    id: parseStoredIdentifier(row.id, 'id'),
    policyVersion: parseStoredPolicyVersion(row.policy_version),
    code,
    occurrenceId: parseStoredIdentifier(row.occurrence_id, 'occurrenceId'),
    checkpointId: parseStoredIdentifier(row.checkpoint_id, 'checkpointId'),
    throughSequence: parseStoredSequence(row.through_sequence, 'sequence'),
    priority,
    evidenceEventIds: parseStoredIdList(row.evidence_event_ids_json, 'evidenceEventIds'),
    referenceIds: parseStoredIdList(row.reference_ids_json, 'referenceIds'),
    deliveredAt: parseStoredTimestamp(row.delivered_at),
  };
}

function compareHistoryItems(left: StoredNudgeHistoryItem, right: StoredNudgeHistoryItem): number {
  return left.throughSequence - right.throughSequence
    || compareCanonicalStrings(left.code, right.code)
    || compareCanonicalStrings(left.occurrenceId, right.occurrenceId)
    || compareCanonicalStrings(left.checkpointId, right.checkpointId);
}

export function validateStoredNudgeHistory(
  rows: readonly StoredNudgeHistoryItem[],
  policy: NudgeRateLimitPolicy,
): void {
  if (!Number.isSafeInteger(policy.maxPerRun) || policy.maxPerRun < 0
    || !Number.isSafeInteger(policy.minSequenceDistancePerCode) || policy.minSequenceDistancePerCode < 0
    || policy.maxPerResponse !== 1) integrity('Stored nudge rate-limit policy is invalid');
  if (rows.length > policy.maxPerRun) integrity('Stored nudge history exceeds its per-run limit');

  const ordered = [...rows].sort(compareHistoryItems);
  const occurrenceIds = new Set<string>();
  const checkpointIds = new Set<string>();
  const lastSequenceByCode = new Map<NudgeCode, number>();
  for (const row of ordered) {
    if (!validIdentifier(row.occurrenceId) || !validIdentifier(row.checkpointId)
      || !NUDGE_CODES.includes(row.code) || !Number.isSafeInteger(row.throughSequence) || row.throughSequence < 0) integrity('Stored nudge history item is invalid');
    if (occurrenceIds.has(row.occurrenceId) || checkpointIds.has(row.checkpointId)) integrity('Stored nudge history contains duplicate identity');
    occurrenceIds.add(row.occurrenceId);
    checkpointIds.add(row.checkpointId);
    const previous = lastSequenceByCode.get(row.code);
    if (previous !== undefined && row.throughSequence - previous < policy.minSequenceDistancePerCode) integrity('Stored nudge history violates its sequence-distance limit');
    lastSequenceByCode.set(row.code, row.throughSequence);
  }
}
