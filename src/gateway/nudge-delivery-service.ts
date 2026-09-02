import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { LedgerStore } from '../ledger/store.js';
import type { LedgerProjection } from '../ledger/projection.js';
import { buildDeliveredNudge, deriveNudgeCandidates, NUDGE_POLICY_VERSION, selectNudge, type DeliveredNudge } from '../context/nudges.js';
import { parseNewNudgeDelivery, readNudgeDeliveryForCheckpoint, readNudgeHistory, insertNudgeDelivery, serializeNudgeDelivery } from '../context/nudge-store.js';
import type { Recommendation } from '../context/recommendations.js';

export interface ValidatedNudgeDeliveryRequest {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly throughSequence: number;
  readonly projection: LedgerProjection;
  readonly recommendations: readonly Recommendation[];
}

export interface NudgeDeliveryPort {
  deliver(input: ValidatedNudgeDeliveryRequest): DeliveredNudge | null;
}

export class NudgeDeliveryService {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  deliver(input: ValidatedNudgeDeliveryRequest): DeliveredNudge | null {
    if (input.runId.length === 0 || input.idempotencyKey.length === 0
      || !Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
      throw new KiokukoError('VALIDATION_ERROR', 'Invalid nudge delivery request');
    }
    const checkpointId = canonicalContentHash({
      kind: 'agent-checkpoint-nudge-v1',
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
    });
    const candidates = deriveNudgeCandidates(input.projection, input.recommendations);
    return withImmediateTransaction(this.database, () => {
      const run = new LedgerStore(this.database).readRun(input.runId);
      if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
      if (run.lastSequence !== input.throughSequence) {
        throw new KiokukoError('CONFLICT', 'Nudge delivery conflicts with current run state');
      }
      const existing = readNudgeDeliveryForCheckpoint(this.database, {
        runId: input.runId,
        policyVersion: NUDGE_POLICY_VERSION,
        checkpointId,
      });
      if (existing !== null) {
        const matchingCandidate = candidates.find(
          (candidateValue) => candidateValue.occurrenceId === existing.occurrenceId,
        );
        if (matchingCandidate === undefined) return null;
        if (matchingCandidate.code !== existing.code) {
          throw new KiokukoError('INTEGRITY_ERROR', 'Stored nudge occurrence binding is invalid');
        }
        return existing;
      }
      const history = readNudgeHistory(this.database, input.runId, NUDGE_POLICY_VERSION);
      const selected = selectNudge(candidates, history, input.throughSequence);
      if (selected === null) return null;
      const delivery = parseNewNudgeDelivery({
        runId: input.runId,
        policyVersion: NUDGE_POLICY_VERSION,
        code: selected.code,
        occurrenceId: selected.occurrenceId,
        checkpointId,
        throughSequence: input.throughSequence,
        priority: selected.priority,
        evidenceEventIds: selected.evidenceEventIds,
        referenceIds: selected.referenceIds,
        deliveredAt: this.now(),
      });
      insertNudgeDelivery(this.database, serializeNudgeDelivery(delivery));
      return buildDeliveredNudge(selected);
    });
  }
}
