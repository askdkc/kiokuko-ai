import assert from 'node:assert/strict';
import test from 'node:test';
import type { LedgerProjection } from '../../src/ledger/projection.js';
import {
  DEFAULT_NUDGE_RATE_LIMIT,
  deriveNudgeCandidates,
  NUDGE_MESSAGES,
  NUDGE_PRIORITY,
  selectNudge,
  type NudgeCandidate,
} from '../../src/context/nudges.js';
import {
  RECOMMENDATION_MESSAGES,
  RECOMMENDATION_PRIORITY,
  type Recommendation,
  type RecommendationCode,
} from '../../src/context/recommendations.js';

function projection(overrides: Partial<LedgerProjection> = {}): LedgerProjection {
  return {
    throughSequence: 10,
    taskProfile: { taskType: 'build', target: 'src/app.ts', expected: 'tests pass', constraints: null },
    profileHash: 'a'.repeat(64),
    evidenceState: 'none',
    unresolvedFailureEventIds: [],
    unknownOutcomeEventIds: [],
    latestMutationSequence: null,
    latestMutationEventIds: [],
    latestPassingVerificationSequence: null,
    latestPassingVerificationEventIds: [],
    coverage: 'complete',
    declaredCoverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
    intakeIncomplete: false,
    missingProfileFields: [],
    ...overrides,
  };
}

function recommendation(
  code: RecommendationCode,
  overrides: Partial<Recommendation> = {},
): Recommendation {
  return {
    code,
    message: RECOMMENDATION_MESSAGES[code],
    evidenceEventIds: [],
    priority: RECOMMENDATION_PRIORITY[code],
    untrusted: true,
    actionable: false,
    metadata: { truncated: false, referenceIds: [] },
    ...overrides,
  };
}

function history(
  deliveredOccurrenceIds: readonly string[] = [],
  runDeliveryCount = deliveredOccurrenceIds.length,
  lastSequenceByCode: ReadonlyMap<NudgeCandidate['code'], number> = new Map(),
) {
  return {
    deliveredOccurrenceIds: new Set(deliveredOccurrenceIds),
    runDeliveryCount,
    lastSequenceByCode,
  };
}

test('derives deterministic candidates independent of identifier and recommendation ordering', () => {
  const first = projection({
    evidenceState: 'stale',
    latestMutationSequence: 8,
    latestMutationEventIds: ['mutation-z', 'mutation-a', 'mutation-z'],
    latestPassingVerificationEventIds: ['pass-z', 'pass-a'],
    unknownOutcomeEventIds: ['unknown-z', 'unknown-a'],
    unresolvedFailureEventIds: ['failure-z', 'failure-a'],
  });
  const second = projection({
    ...first,
    latestMutationEventIds: ['mutation-a', 'mutation-z'],
    latestPassingVerificationEventIds: ['pass-a', 'pass-z'],
    unknownOutcomeEventIds: ['unknown-a', 'unknown-z'],
    unresolvedFailureEventIds: ['failure-a', 'failure-z'],
  });
  const recommendations = [
    recommendation('UNRESOLVED_FAILURE', { evidenceEventIds: ['failure-z', 'failure-a'] }),
    recommendation('VERIFY_AFTER_MUTATION', { evidenceEventIds: ['pass-z', 'mutation-a'] }),
    recommendation('SIDE_EFFECT_OUTCOME_UNKNOWN', { evidenceEventIds: ['unknown-z', 'unknown-a'] }),
  ];

  assert.deepEqual(deriveNudgeCandidates(first, recommendations), deriveNudgeCandidates(second, [...recommendations].reverse()));
  assert.equal(deriveNudgeCandidates(first, recommendations)[0]?.code, 'SIDE_EFFECT_OUTCOME_UNKNOWN');
  assert.equal(deriveNudgeCandidates(first, recommendations)[0]?.message, NUDGE_MESSAGES.SIDE_EFFECT_OUTCOME_UNKNOWN);
});

test('uses causal episode state rather than unrelated sequence advancement for occurrence identity', () => {
  const original = projection({
    evidenceState: 'stale',
    throughSequence: 4,
    latestMutationSequence: 3,
    latestMutationEventIds: ['mutation-a'],
    latestPassingVerificationEventIds: ['verification-a'],
  });
  const unrelated = { ...original, throughSequence: 99 };
  const newMutation = { ...original, throughSequence: 100, latestMutationSequence: 100, latestMutationEventIds: ['mutation-b'] };
  const recommendations = [recommendation('VERIFY_AFTER_MUTATION')];
  const originalCandidate = deriveNudgeCandidates(original, recommendations)[0];
  const unrelatedCandidate = deriveNudgeCandidates(unrelated, recommendations)[0];
  const newCandidate = deriveNudgeCandidates(newMutation, recommendations)[0];

  assert.equal(originalCandidate?.occurrenceId, unrelatedCandidate?.occurrenceId);
  assert.notEqual(originalCandidate?.occurrenceId, newCandidate?.occurrenceId);
});

test('changes occurrences when unresolved failure state changes', () => {
  const failureRecommendation = recommendation('UNRESOLVED_FAILURE');
  const failureA = deriveNudgeCandidates(projection({ unresolvedFailureEventIds: ['failure-a'] }), [failureRecommendation])[0];
  const failureAReordered = deriveNudgeCandidates(projection({ unresolvedFailureEventIds: ['failure-a', 'failure-a'] }), [failureRecommendation])[0];
  const failureB = deriveNudgeCandidates(projection({ unresolvedFailureEventIds: ['failure-b'] }), [failureRecommendation])[0];

  assert.equal(failureA?.occurrenceId, failureAReordered?.occurrenceId);
  assert.notEqual(failureA?.occurrenceId, failureB?.occurrenceId);
});

test('changes occurrences when only the seventeenth causal event changes', () => {
  const common = Array.from({ length: 16 }, (_, index) => `failure-${index.toString().padStart(2, '0')}`);
  const first = deriveNudgeCandidates(
    projection({ unresolvedFailureEventIds: [...common, 'failure-a'] }),
    [recommendation('UNRESOLVED_FAILURE')],
  )[0];
  const second = deriveNudgeCandidates(
    projection({ unresolvedFailureEventIds: [...common, 'failure-b'] }),
    [recommendation('UNRESOLVED_FAILURE')],
  )[0];

  assert.notEqual(first?.occurrenceId, second?.occurrenceId);
});

test('does not create v1 candidates for unsupported recommendation codes', () => {
  const result = deriveNudgeCandidates(projection({ intakeIncomplete: true }), [
    recommendation('INTAKE_INCOMPLETE'),
    recommendation('PROMOTION_CANDIDATE'),
    recommendation('CONTEXT_STALE'),
    recommendation('COVERAGE_INCOMPLETE'),
  ]);
  assert.deepEqual(result, []);
});

test('selects by nudge priority and permits a different code during cooldown', () => {
  const candidates = deriveNudgeCandidates(
    projection({
      evidenceState: 'stale',
      latestMutationSequence: 10,
      latestMutationEventIds: ['mutation-a'],
      unknownOutcomeEventIds: ['unknown-a'],
      unresolvedFailureEventIds: ['failure-a'],
    }),
    [
      recommendation('VERIFY_AFTER_MUTATION'),
      recommendation('UNRESOLVED_FAILURE'),
      recommendation('SIDE_EFFECT_OUTCOME_UNKNOWN'),
    ],
  );
  const first = selectNudge(candidates, history(), 10);
  assert.equal(first?.code, 'SIDE_EFFECT_OUTCOME_UNKNOWN');
  const next = selectNudge(candidates, history(
    [first!.occurrenceId],
    1,
    new Map([['SIDE_EFFECT_OUTCOME_UNKNOWN', 10]]),
  ), 11);
  assert.equal(next?.code, 'UNRESOLVED_FAILURE');
});

test('suppresses duplicate occurrences, enforces sequence distance and run cap', () => {
  const candidate = deriveNudgeCandidates(
    projection({ unresolvedFailureEventIds: ['failure-a'] }),
    [recommendation('UNRESOLVED_FAILURE')],
  )[0]!;
  assert.equal(selectNudge([candidate], history([candidate.occurrenceId]), 10), null);
  assert.equal(selectNudge([candidate], history([], 0, new Map([['UNRESOLVED_FAILURE', 8]])), 10), null);
  assert.equal(selectNudge([candidate], history([], 0, new Map([['UNRESOLVED_FAILURE', 7]])), 10)?.occurrenceId, candidate.occurrenceId);
  assert.equal(selectNudge([candidate], history([], DEFAULT_NUDGE_RATE_LIMIT.maxPerRun), 10), null);
});

test('returns one bounded fixed-message candidate with stable priority', () => {
  const candidate = deriveNudgeCandidates(
    projection({ unknownOutcomeEventIds: ['event-z', 'event-a'] }),
    [recommendation('SIDE_EFFECT_OUTCOME_UNKNOWN', { evidenceEventIds: ['event-z', 'event-a'] })],
  )[0]!;
  assert.deepEqual(candidate.evidenceEventIds, ['event-a', 'event-z']);
  assert.equal(candidate.priority, NUDGE_PRIORITY.SIDE_EFFECT_OUTCOME_UNKNOWN);
  assert.equal(candidate.message, NUDGE_MESSAGES.SIDE_EFFECT_OUTCOME_UNKNOWN);
});
