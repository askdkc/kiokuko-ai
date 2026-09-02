import { KiokukoError } from '../errors.js';
import type { LedgerProjection } from '../ledger/projection.js';
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js';
import {
  MAX_EVIDENCE_EVENT_IDS,
  MAX_REFERENCE_IDS,
  type Recommendation,
} from './recommendations.js';
import type { NudgeHistory } from './nudge-store.js';

export const NUDGE_POLICY_VERSION = 'nudges.v1' as const;

export function assertNudgePolicyVersion(value: string): asserts value is typeof NUDGE_POLICY_VERSION {
  if (value !== NUDGE_POLICY_VERSION) {
    throw new KiokukoError('VALIDATION_ERROR', 'Unsupported nudge policy version');
  }
}

export function isNudgePolicyVersion(value: unknown): value is typeof NUDGE_POLICY_VERSION {
  return value === NUDGE_POLICY_VERSION;
}

export const NUDGE_CODES = [
  'SIDE_EFFECT_OUTCOME_UNKNOWN',
  'UNRESOLVED_FAILURE',
  'VERIFY_AFTER_MUTATION',
] as const;

export type NudgeCode = (typeof NUDGE_CODES)[number];

export interface NudgeCandidate {
  readonly code: NudgeCode;
  readonly occurrenceId: string;
  readonly priority: number;
  readonly message: string;
  readonly evidenceEventIds: readonly string[];
  readonly referenceIds: readonly string[];
}

export interface DeliveredNudge {
  readonly occurrenceId: string;
  readonly code: NudgeCode;
  readonly message: string;
  readonly evidenceEventIds: readonly string[];
  readonly referenceIds: readonly string[];
  readonly priority: number;
  readonly policyVersion: typeof NUDGE_POLICY_VERSION;
}

export interface NudgeRateLimitPolicy {
  maxPerResponse: 1;
  maxPerRun: number;
  minSequenceDistancePerCode: number;
}

export const NUDGE_PRIORITY: Readonly<Record<NudgeCode, number>> = Object.freeze({
  SIDE_EFFECT_OUTCOME_UNKNOWN: 2,
  UNRESOLVED_FAILURE: 3,
  VERIFY_AFTER_MUTATION: 4,
});

export const NUDGE_MESSAGES: Readonly<Record<NudgeCode, string>> = Object.freeze({
  SIDE_EFFECT_OUTCOME_UNKNOWN: 'A side effect has no known outcome. Consider verifying its result before relying on subsequent work.',
  UNRESOLVED_FAILURE: 'Unresolved failures remain. Consider resolving or explicitly carrying them forward before finishing.',
  VERIFY_AFTER_MUTATION: 'The latest passing verification predates the most recent mutation. Consider re-running the affected verification before finishing.',
});

export const DEFAULT_NUDGE_RATE_LIMIT: NudgeRateLimitPolicy = Object.freeze({
  maxPerResponse: 1,
  maxPerRun: 3,
  minSequenceDistancePerCode: 3,
});

const NUDGE_CODE_SET = new Set<string>(NUDGE_CODES);

function isNudgeCode(value: string): value is NudgeCode {
  return NUDGE_CODE_SET.has(value);
}

function sortedBoundedIds(values: readonly string[], maximum: number): string[] {
  return [...new Set(values)].sort(compareCanonicalStrings).slice(0, maximum);
}

function canonicalIdentityIds(values: readonly string[]): { count: number; hash: string } {
  const ids = [...new Set(values)].sort(compareCanonicalStrings);
  return { count: ids.length, hash: canonicalContentHash(ids) };
}

function occurrenceId(code: NudgeCode, occurrence: Record<string, unknown>): string {
  return canonicalContentHash({
    policyVersion: NUDGE_POLICY_VERSION,
    code,
    occurrence,
  });
}

function candidate(
  code: NudgeCode,
  occurrence: Record<string, unknown>,
  recommendation: Recommendation,
): NudgeCandidate {
  return {
    code,
    occurrenceId: occurrenceId(code, occurrence),
    priority: NUDGE_PRIORITY[code],
    message: NUDGE_MESSAGES[code],
    evidenceEventIds: sortedBoundedIds(recommendation.evidenceEventIds, MAX_EVIDENCE_EVENT_IDS),
    referenceIds: sortedBoundedIds(recommendation.metadata.referenceIds, MAX_REFERENCE_IDS),
  };
}

function compareNudgeCandidates(left: NudgeCandidate, right: NudgeCandidate): number {
  return left.priority - right.priority
    || compareCanonicalStrings(left.code, right.code)
    || compareCanonicalStrings(left.occurrenceId, right.occurrenceId);
}

function recommendationByCode(recommendations: readonly Recommendation[]): Map<NudgeCode, Recommendation> {
  const result = new Map<NudgeCode, Recommendation>();
  for (const recommendation of recommendations) {
    if (!isNudgeCode(recommendation.code)) continue;
    const current = result.get(recommendation.code);
    if (current === undefined || canonicalContentHash(recommendation) < canonicalContentHash(current)) {
      result.set(recommendation.code, recommendation);
    }
  }
  return result;
}

export function deriveNudgeCandidates(
  projection: LedgerProjection,
  recommendations: readonly Recommendation[],
): NudgeCandidate[] {
  const byCode = recommendationByCode(recommendations);
  const candidates: NudgeCandidate[] = [];

  const unknownOutcome = byCode.get('SIDE_EFFECT_OUTCOME_UNKNOWN');
  if (unknownOutcome !== undefined && projection.unknownOutcomeEventIds.length > 0) {
    candidates.push(candidate('SIDE_EFFECT_OUTCOME_UNKNOWN', {
      unknownOutcomeEventIds: canonicalIdentityIds(projection.unknownOutcomeEventIds),
    }, unknownOutcome));
  }

  const failure = byCode.get('UNRESOLVED_FAILURE');
  if (failure !== undefined && projection.unresolvedFailureEventIds.length > 0) {
    candidates.push(candidate('UNRESOLVED_FAILURE', {
      unresolvedFailureEventIds: canonicalIdentityIds(projection.unresolvedFailureEventIds),
    }, failure));
  }

  const verification = byCode.get('VERIFY_AFTER_MUTATION');
  if (verification !== undefined
    && projection.evidenceState === 'stale'
    && projection.latestMutationSequence !== null) {
    candidates.push(candidate('VERIFY_AFTER_MUTATION', {
      latestMutationSequence: projection.latestMutationSequence,
      latestMutationEventIds: canonicalIdentityIds(projection.latestMutationEventIds),
    }, verification));
  }

  return candidates.sort(compareNudgeCandidates);
}

export function selectNudge(
  candidates: readonly NudgeCandidate[],
  history: NudgeHistory,
  throughSequence: number,
  policy: NudgeRateLimitPolicy = DEFAULT_NUDGE_RATE_LIMIT,
): NudgeCandidate | null {
  if (policy.maxPerResponse < 1 || history.runDeliveryCount >= policy.maxPerRun) return null;

  const eligible = candidates
    .filter((candidateValue) => !history.deliveredOccurrenceIds.has(candidateValue.occurrenceId))
    .filter((candidateValue) => {
      const previous = history.lastSequenceByCode.get(candidateValue.code);
      return previous === undefined || throughSequence - previous >= policy.minSequenceDistancePerCode;
    })
    .sort(compareNudgeCandidates);

  return eligible[0] ?? null;
}

export function buildDeliveredNudge(candidateValue: NudgeCandidate): DeliveredNudge {
  return {
    occurrenceId: candidateValue.occurrenceId,
    code: candidateValue.code,
    message: candidateValue.message,
    evidenceEventIds: [...candidateValue.evidenceEventIds],
    referenceIds: [...candidateValue.referenceIds],
    priority: candidateValue.priority,
    policyVersion: NUDGE_POLICY_VERSION,
  };
}

export function assertNudgeCode(value: string): asserts value is NudgeCode {
  if (!isNudgeCode(value)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid nudge code');
}
