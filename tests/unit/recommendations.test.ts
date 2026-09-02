import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecommendations, MAX_EVIDENCE_EVENT_IDS } from '../../src/context/recommendations.js';

function projection(overrides: Record<string, unknown> = {}) {
  return {
    intakeIncomplete: false,
    missingProfileFields: [],
    evidenceState: 'none',
    unresolvedFailureEventIds: [],
    unknownOutcomeEventIds: [],
    coverage: 'complete',
    ...overrides,
  };
}

function input(projectionOverrides: Record<string, unknown> = {}, broker: Record<string, unknown> = {}) {
  return { projection: projection(projectionOverrides), broker };
}

test('returns a fixed incomplete-intake recommendation only for exhausted missing intake', () => {
  const result = buildRecommendations(input({
    intakeIncomplete: true,
    missingProfileFields: ['target', 'expected'],
  }));

  assert.deepEqual(result, [{
    code: 'INTAKE_INCOMPLETE',
    message: 'Intake is incomplete; required task details remain unanswered',
    evidenceEventIds: [],
    priority: 1,
    untrusted: true,
    actionable: false,
    metadata: { truncated: false, referenceIds: [] },
  }]);
  assert.equal(JSON.stringify(result).includes('target'), false);
});

test('recommends verification after stale evidence with deterministic evidence IDs', () => {
  const result = buildRecommendations(input({
    evidenceState: 'stale',
    latestMutationEventIds: ['mutation-z', 'mutation-a', 'mutation-z'],
    latestPassingVerificationEventIds: ['pass-b', 'pass-a', 'pass-b'],
  }));

  assert.deepEqual(result, [{
    code: 'VERIFY_AFTER_MUTATION',
    message: 'Passing evidence predates the latest mutation',
    evidenceEventIds: ['mutation-a', 'mutation-z', 'pass-a', 'pass-b'],
    priority: 2,
    untrusted: true,
    actionable: false,
    metadata: { truncated: false, referenceIds: [] },
  }]);
});

test('bounds side-effect unknown outcomes to one recommendation with sorted unique evidence', () => {
  const result = buildRecommendations(input({
    unknownOutcomeEventIds: ['unknown-z', 'unknown-a', 'unknown-z'],
  }));

  assert.deepEqual(result, [{
    code: 'SIDE_EFFECT_OUTCOME_UNKNOWN',
    message: 'A side effect has no known outcome',
    evidenceEventIds: ['unknown-a', 'unknown-z'],
    priority: 3,
    untrusted: true,
    actionable: false,
    metadata: { truncated: false, referenceIds: [] },
  }]);
});

test('recommends unresolved failures as one sorted unique bounded set', () => {
  const result = buildRecommendations(input({
    unresolvedFailureEventIds: ['failure-z', 'failure-a', 'failure-z'],
  }));

  assert.deepEqual(result, [{
    code: 'UNRESOLVED_FAILURE',
    message: 'Unresolved failures remain',
    evidenceEventIds: ['failure-a', 'failure-z'],
    priority: 4,
    untrusted: true,
    actionable: false,
    metadata: { truncated: false, referenceIds: [] },
  }]);
});

test('reports partial declared coverage without upgrading or echoing arbitrary categories', () => {
  const result = buildRecommendations(input({
    coverage: 'partial',
    declaredCoverage: {
      run: 'complete',
      tool: 'best_effort',
      command: 'declared',
      file: 'unavailable',
      approval: 'complete',
    },
  }));

  assert.deepEqual(result, [{
    code: 'COVERAGE_INCOMPLETE',
    message: 'Observed coverage is incomplete',
    evidenceEventIds: [],
    priority: 5,
    untrusted: true,
    actionable: false,
    metadata: {
      truncated: false,
      referenceIds: [],
      incompleteCoverageCategories: ['command', 'file', 'tool'],
    },
  }]);
});

test('reports only categories explicitly present in a partial declared coverage object', () => {
  const result = buildRecommendations(input({
    coverage: 'partial',
    declaredCoverage: { file: 'unavailable' },
  }));

  assert.deepEqual(result[0]?.metadata.incompleteCoverageCategories, ['file']);
});

test('reports explicitly stale delivered entries with bounded evidence and references', () => {
  const result = buildRecommendations(input({}, {
    staleDeliveredEntries: [
      {
        entryId: 'entry-z',
        deliveredRevision: 4,
        currentRevision: 5,
        stale: true,
        evidenceEventIds: ['event-z', 'event-a', 'event-z'],
      },
      {
        entryId: 'entry-a',
        deliveredRevision: 1,
        currentRevision: 2,
        stale: true,
        evidenceEventIds: ['event-b'],
      },
    ],
  }));

  assert.deepEqual(result, [{
    code: 'CONTEXT_STALE',
    message: 'Previously delivered context may be stale',
    evidenceEventIds: ['event-a', 'event-b', 'event-z'],
    priority: 6,
    untrusted: true,
    actionable: false,
    metadata: {
      truncated: false,
      referenceIds: ['entry-a', 'entry-z'],
    },
  }]);
});

test('reports only explicitly verified contradictory memory pairs without choosing a winner', () => {
  const result = buildRecommendations(input({}, {
    contradictoryMemoryPairs: [
      {
        leftEntryId: 'memory-z',
        rightEntryId: 'memory-a',
        verified: true,
        evidenceEventIds: ['event-z', 'event-a'],
      },
    ],
  }));

  assert.deepEqual(result, [{
    code: 'CONTRADICTORY_MEMORY',
    message: 'Verified memory entries contain a contradiction',
    evidenceEventIds: ['event-a', 'event-z'],
    priority: 7,
    untrusted: true,
    actionable: false,
    metadata: {
      truncated: false,
      referenceIds: ['memory-a', 'memory-z'],
    },
  }]);
});

test('reports only eligible durable proposal events as promotion candidates', () => {
  const result = buildRecommendations(input({}, {
    promotionCandidates: [
      { eventId: 'proposal-z', eligible: false },
      { eventId: 'proposal-a', eligible: true, evidenceEventIds: ['proposal-z', 'proposal-a'] },
    ],
  }));

  assert.deepEqual(result, [{
    code: 'PROMOTION_CANDIDATE',
    message: 'A durable proposal is eligible for candidate promotion only',
    evidenceEventIds: ['proposal-a', 'proposal-z'],
    priority: 8,
    untrusted: true,
    actionable: false,
    metadata: { truncated: false, referenceIds: [] },
  }]);
});

test('returns simultaneous rule results in exported fixed priority order', () => {
  const result = buildRecommendations(input({
    intakeIncomplete: true,
    missingProfileFields: ['target'],
    evidenceState: 'stale',
    latestMutationEventIds: ['mutation-1'],
    latestPassingVerificationEventIds: ['pass-1'],
    unknownOutcomeEventIds: ['unknown-1'],
    unresolvedFailureEventIds: ['failure-1'],
    coverage: 'partial',
    declaredCoverage: { file: 'unavailable' },
  }, {
    staleDeliveredEntries: [{ entryId: 'entry-1', deliveredRevision: 1, currentRevision: 2, stale: true }],
    contradictoryMemoryPairs: [{ leftEntryId: 'memory-1', rightEntryId: 'memory-2', verified: true }],
    promotionCandidates: [{ eventId: 'proposal-1', eligible: true }],
  }));

  assert.deepEqual(result.map((recommendation) => recommendation.code), [
    'INTAKE_INCOMPLETE',
    'VERIFY_AFTER_MUTATION',
    'SIDE_EFFECT_OUTCOME_UNKNOWN',
    'UNRESOLVED_FAILURE',
    'COVERAGE_INCOMPLETE',
    'CONTEXT_STALE',
    'CONTRADICTORY_MEMORY',
    'PROMOTION_CANDIDATE',
  ]);
});

test('does not recommend for complete intake or fresh and none evidence', () => {
  assert.deepEqual(buildRecommendations(input({ intakeIncomplete: false, evidenceState: 'fresh' })), []);
  assert.deepEqual(buildRecommendations(input({ intakeIncomplete: false, evidenceState: 'none' })), []);
});

test('rejects unknown fields and unsafe identifiers with fixed non-echoing errors', () => {
  const cases = [
    () => buildRecommendations({ ...input(), storedText: 'rm -rf / secret' }),
    () => buildRecommendations(input({ unexpected: 'https://secret.example/token' })),
    () => buildRecommendations(input({ latestMutationEventIds: ['https://secret.example/token'] })),
  ];

  for (const action of cases) {
    assert.throws(action, (error: unknown) => {
      const value = error as { code?: unknown; message?: unknown };
      assert.equal(value.code, 'VALIDATION_ERROR');
      assert.equal(value.message, 'Invalid recommendation input');
      assert.equal(String(value.message).includes('secret'), false);
      return true;
    });
  }
});

test('caps evidence IDs and marks output truncation explicitly', () => {
  const ids = Array.from({ length: MAX_EVIDENCE_EVENT_IDS + 3 }, (_, index) => `event-${String(index).padStart(2, '0')}`);
  const result = buildRecommendations(input({ unknownOutcomeEventIds: ids }));

  assert.equal(result[0]?.evidenceEventIds.length, MAX_EVIDENCE_EVENT_IDS);
  assert.equal(result[0]?.metadata.truncated, true);
  assert.deepEqual(result[0]?.evidenceEventIds, ids.slice(0, MAX_EVIDENCE_EVENT_IDS));
});

test('is canonical across insertion order and does not mutate input or share output arrays', () => {
  const first = input({
    evidenceState: 'stale',
    latestMutationEventIds: ['mutation-z', 'mutation-a'],
    latestPassingVerificationEventIds: ['pass-b', 'pass-a'],
    coverage: 'partial',
    declaredCoverage: { file: 'unavailable', command: 'declared' },
  }, {
    staleDeliveredEntries: [{ entryId: 'entry-z', deliveredRevision: 2, currentRevision: 3, stale: true, evidenceEventIds: ['event-z', 'event-a'] }],
  });
  const second = input({
    evidenceState: 'stale',
    latestMutationEventIds: ['mutation-a', 'mutation-z'],
    latestPassingVerificationEventIds: ['pass-a', 'pass-b'],
    coverage: 'partial',
    declaredCoverage: { command: 'declared', file: 'unavailable' },
  }, {
    staleDeliveredEntries: [{ entryId: 'entry-z', deliveredRevision: 2, currentRevision: 3, stale: true, evidenceEventIds: ['event-a', 'event-z'] }],
  });
  const before = structuredClone(first);

  const firstResult = buildRecommendations(first);
  const secondResult = buildRecommendations(second);

  assert.deepEqual(firstResult, secondResult);
  assert.deepEqual(first, before);
  firstResult[0]?.evidenceEventIds.push('caller-mutation');
  assert.equal(buildRecommendations(second)[0]?.evidenceEventIds.includes('caller-mutation'), false);
});
