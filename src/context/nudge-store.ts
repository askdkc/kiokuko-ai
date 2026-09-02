import { isProxy } from 'node:util/types';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { isSqliteUniqueConstraintError } from '../db/sqlite-retry.js';
import { validateTimestamp } from '../ledger/validate.js';
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js';
import {
  NUDGE_CODES,
  DEFAULT_NUDGE_RATE_LIMIT,
  NUDGE_MESSAGES,
  NUDGE_POLICY_VERSION,
  NUDGE_PRIORITY,
  assertNudgeCode,
  assertNudgePolicyVersion,
  type DeliveredNudge,
  type NudgeCode,
} from './nudges.js';
import {
  parseInputIdentifier,
  parseStoredNudgeDelivery,
  type StoredNudgeDelivery,
  validateStoredNudgeHistory,
} from './nudge-validation.js';

export interface NudgeHistory {
  deliveredOccurrenceIds: ReadonlySet<string>;
  runDeliveryCount: number;
  lastSequenceByCode: ReadonlyMap<NudgeCode, number>;
}

interface NudgeDeliveryRow extends SqliteRow {
  id: unknown;
  policy_version: unknown;
  code: unknown;
  occurrence_id: unknown;
  checkpoint_id: unknown;
  through_sequence: unknown;
  priority: unknown;
  evidence_event_ids_json: unknown;
  reference_ids_json: unknown;
}

export interface NewNudgeDelivery {
  readonly id: string;
  readonly runId: string;
  readonly policyVersion: typeof NUDGE_POLICY_VERSION;
  readonly code: NudgeCode;
  readonly occurrenceId: string;
  readonly checkpointId: string;
  readonly throughSequence: number;
  readonly priority: number;
  readonly evidenceEventIds: readonly string[];
  readonly referenceIds: readonly string[];
  readonly deliveredAt: string;
}

export interface NudgeDeliveryInsertRow {
  readonly id: string;
  readonly runId: string;
  readonly policyVersion: string;
  readonly code: string;
  readonly occurrenceId: string;
  readonly checkpointId: string;
  readonly throughSequence: number;
  readonly priority: number;
  readonly evidenceEventIdsJson: string;
  readonly referenceIdsJson: string;
  readonly deliveredAt: string;
}

export interface NudgeDeliveryInput {
  readonly runId: string;
  readonly policyVersion: string;
  readonly code: NudgeCode;
  readonly occurrenceId: string;
  readonly checkpointId: string;
  readonly throughSequence: number;
  readonly priority: number;
  readonly evidenceEventIds?: readonly string[];
  readonly referenceIds?: readonly string[];
  readonly deliveredAt: string;
}

const NUDGE_DELIVERY_FIELDS = new Set([
  'runId',
  'policyVersion',
  'code',
  'occurrenceId',
  'checkpointId',
  'throughSequence',
  'priority',
  'evidenceEventIds',
  'referenceIds',
  'deliveredAt',
]);

function ownedPlainObject(input: unknown): Record<string, unknown> {
  try {
    if (isProxy(input)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Nudge delivery input is invalid');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Nudge delivery input is invalid');
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new KiokukoError('VALIDATION_ERROR', 'Nudge delivery input is invalid');
    }

    const descriptors = Object.getOwnPropertyDescriptors(input);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !NUDGE_DELIVERY_FIELDS.has(key)) {
        throw new KiokukoError('VALIDATION_ERROR', 'Nudge delivery input is invalid');
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new KiokukoError('VALIDATION_ERROR', 'Nudge delivery input is invalid');
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw new KiokukoError('VALIDATION_ERROR', 'Nudge delivery input is invalid');
  }
}

function inputIdList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  try {
    if (isProxy(value) || !Array.isArray(value) || value.length > 16) {
      throw new KiokukoError('VALIDATION_ERROR', 'Nudge evidence is too large');
    }
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new KiokukoError('VALIDATION_ERROR', `${label} must be a dense data array`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length') || keys.some((key) => typeof key !== 'string')) {
      throw new KiokukoError('VALIDATION_ERROR', `${label} must be a dense data array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const parsed: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new KiokukoError('VALIDATION_ERROR', `${label} must be a dense data array`);
      }
      parsed.push(parseInputIdentifier(descriptor.value, label));
    }
    return [...new Set(parsed)].sort(compareCanonicalStrings);
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a dense data array`);
  }
}

export function parseNewNudgeDelivery(input: unknown): NewNudgeDelivery {
  const value = ownedPlainObject(input);
  const runId = parseInputIdentifier(value.runId, 'runId');
  const policyVersion = parseInputIdentifier(value.policyVersion, 'policyVersion');
  assertNudgePolicyVersion(policyVersion);
  const occurrenceId = parseInputIdentifier(value.occurrenceId, 'occurrenceId');
  const checkpointId = parseInputIdentifier(value.checkpointId, 'checkpointId');
  const code = value.code;
  if (typeof code !== 'string') {
    throw new KiokukoError('VALIDATION_ERROR', 'Invalid nudge code');
  }
  assertNudgeCode(code);
  const throughSequence = value.throughSequence;
  if (!Number.isSafeInteger(throughSequence) || (throughSequence as number) < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'throughSequence must be a non-negative safe integer');
  }
  const priority = value.priority;
  if (!Number.isSafeInteger(priority) || (priority as number) < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'priority must be a positive safe integer');
  }
  if (priority !== NUDGE_PRIORITY[code]) {
    throw new KiokukoError('VALIDATION_ERROR', 'priority does not match nudge code');
  }
  const deliveredAt = validateTimestamp(value.deliveredAt, 'deliveredAt');
  const evidenceEventIds = inputIdList(value.evidenceEventIds, 'evidenceEventId');
  const referenceIds = inputIdList(value.referenceIds, 'referenceId');
  const id = canonicalContentHash({ policyVersion, runId, occurrenceId });
  return {
    id,
    runId,
    policyVersion,
    code,
    occurrenceId,
    checkpointId,
    throughSequence: throughSequence as number,
    priority: priority as number,
    evidenceEventIds,
    referenceIds,
    deliveredAt,
  };
}

export function serializeNudgeDelivery(value: NewNudgeDelivery): NudgeDeliveryInsertRow {
  return {
    id: value.id,
    runId: value.runId,
    policyVersion: value.policyVersion,
    code: value.code,
    occurrenceId: value.occurrenceId,
    checkpointId: value.checkpointId,
    throughSequence: value.throughSequence,
    priority: value.priority,
    evidenceEventIdsJson: JSON.stringify(value.evidenceEventIds),
    referenceIdsJson: JSON.stringify(value.referenceIds),
    deliveredAt: value.deliveredAt,
  };
}

export function insertNudgeDelivery(database: SqliteDatabase, row: NudgeDeliveryInsertRow): void {
  try {
    database.prepare(`
      INSERT INTO nudge_deliveries (
        id, run_id, policy_version, code, occurrence_id,
        checkpoint_id, through_sequence, priority,
        evidence_event_ids_json, reference_ids_json, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.runId,
      row.policyVersion,
      row.code,
      row.occurrenceId,
      row.checkpointId,
      row.throughSequence,
      row.priority,
      row.evidenceEventIdsJson,
      row.referenceIdsJson,
      row.deliveredAt,
    );
  } catch (error) {
    if (isSqliteUniqueConstraintError(error, [
      'nudge_deliveries.id',
      'nudge_deliveries.run_id, nudge_deliveries.policy_version, nudge_deliveries.occurrence_id',
      'nudge_deliveries.run_id, nudge_deliveries.policy_version, nudge_deliveries.checkpoint_id',
    ])) {
      throw new KiokukoError('CONFLICT', 'Nudge delivery already exists');
    }
    throw error;
  }
}

function deliveredValue(value: StoredNudgeDelivery): DeliveredNudge {
  return {
    occurrenceId: value.occurrenceId,
    code: value.code,
    message: NUDGE_MESSAGES[value.code],
    evidenceEventIds: [...value.evidenceEventIds],
    referenceIds: [...value.referenceIds],
    priority: value.priority,
    policyVersion: value.policyVersion,
  };
}

export function readNudgeDeliveryForCheckpoint(
  database: SqliteDatabase,
  input: { runId: string; policyVersion: string; checkpointId: string },
): DeliveredNudge | null {
  const runId = parseInputIdentifier(input.runId, 'runId');
  const policyVersion = parseInputIdentifier(input.policyVersion, 'policyVersion');
  assertNudgePolicyVersion(policyVersion);
  const checkpointId = parseInputIdentifier(input.checkpointId, 'checkpointId');
  const row = database.prepare(`
      SELECT id, policy_version, code, occurrence_id, checkpoint_id, through_sequence, priority,
           evidence_event_ids_json, reference_ids_json, delivered_at
      FROM nudge_deliveries
     WHERE run_id = ? AND checkpoint_id = ?
  `).get<NudgeDeliveryRow>(runId, checkpointId);
  if (row === undefined) return null;
  const stored = parseStoredNudgeDelivery(row);
  if (stored.policyVersion !== policyVersion) throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge policy identity is invalid');
  if (stored.checkpointId !== checkpointId) throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge checkpoint identity is invalid');
  return deliveredValue(stored);
}

export function readNudgeHistory(
  database: SqliteDatabase,
  runId: string,
  policyVersion: string,
): NudgeHistory {
  const safeRunId = parseInputIdentifier(runId, 'runId');
  const safePolicyVersion = parseInputIdentifier(policyVersion, 'policyVersion');
  assertNudgePolicyVersion(safePolicyVersion);
  const rows = database.prepare(`
    SELECT id, policy_version, code, occurrence_id, checkpoint_id, through_sequence, priority,
           evidence_event_ids_json, reference_ids_json, delivered_at
      FROM nudge_deliveries
     WHERE run_id = ?
      ORDER BY through_sequence ASC, code ASC, occurrence_id ASC, id ASC
  `).all<NudgeDeliveryRow>(safeRunId);
  const deliveredOccurrenceIds = new Set<string>();
  const lastSequenceByCode = new Map<NudgeCode, number>();
  const historyRows: StoredNudgeDelivery[] = [];
  for (const row of rows) {
    const value = parseStoredNudgeDelivery(row);
    if (value.policyVersion !== safePolicyVersion) throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge policy identity is invalid');
    historyRows.push(value);
    deliveredOccurrenceIds.add(value.occurrenceId);
    const previous = lastSequenceByCode.get(value.code);
    if (previous === undefined || value.throughSequence > previous) lastSequenceByCode.set(value.code, value.throughSequence);
  }
  validateStoredNudgeHistory(historyRows, DEFAULT_NUDGE_RATE_LIMIT);
  return {
    deliveredOccurrenceIds,
    runDeliveryCount: rows.length,
    lastSequenceByCode,
  };
}

export function recordNudgeDeliveryInTransaction(database: SqliteDatabase, input: NudgeDeliveryInput): void {
  const delivery = parseNewNudgeDelivery(input);
  insertNudgeDelivery(database, serializeNudgeDelivery(delivery));
}

export { NUDGE_CODES, NUDGE_POLICY_VERSION };
