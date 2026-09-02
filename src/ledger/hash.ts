import { createHash } from 'node:crypto';
import { canonicalJson as canonicalJsonValue } from '../serialization/validate.js';
import type { JsonValue, Redaction } from './types.js';

export const GENESIS_HASH = '0'.repeat(64);

export const canonicalJson = canonicalJsonValue;

export interface LedgerHashInput {
  runId: string;
  sequence: number;
  eventId: string;
  previousHash: string;
  eventType: string;
  sourceEventId?: string;
  sourceSequence?: number;
  sourceType?: string;
  actor: string;
  outcome?: string | null;
  occurredAt?: string;
  ingestedAt?: string;
  payload: JsonValue;
  redaction: Redaction[];
}

export function hashLedgerEvent(input: LedgerHashInput): string {
  const preimage = {
    protocol: 'kiokuko-ledger-event-v1',
    runId: input.runId,
    sequence: input.sequence,
    eventId: input.eventId,
    previousHash: input.previousHash,
    eventType: input.eventType,
    sourceEventId: input.sourceEventId ?? null,
    sourceSequence: input.sourceSequence ?? null,
    sourceType: input.sourceType ?? null,
    actor: input.actor,
    outcome: input.outcome ?? null,
    occurredAt: input.occurredAt ?? null,
    ingestedAt: input.ingestedAt ?? null,
    payload: input.payload,
    redaction: input.redaction,
  };
  return createHash('sha256').update(canonicalJson(preimage), 'utf8').digest('hex');
}
