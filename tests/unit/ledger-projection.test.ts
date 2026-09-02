import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLedger } from '../../src/ledger/projection.js';

function baseInput() {
  return {
    initialProfile: {
      taskType: 'build',
      target: 'src/app.ts',
      expected: 'tests pass',
      constraints: null,
    },
    intakeStatus: 'ready',
    coverage: {
      run: 'complete',
      tool: 'complete',
      command: 'complete',
      file: 'complete',
      approval: 'complete',
    },
    throughSequence: 0,
    events: [],
  } as const;
}

test('projects an empty committed ledger without mutating its input', () => {
  const input = baseInput();
  const before = structuredClone(input);

  const result = projectLedger(input);

  assert.deepEqual(result.taskProfile, input.initialProfile);
  assert.match(result.profileHash, /^[0-9a-f]{64}$/);
  assert.equal(result.throughSequence, 0);
  assert.equal(result.evidenceState, 'none');
  assert.deepEqual(result.unresolvedFailureEventIds, []);
  assert.deepEqual(result.unknownOutcomeEventIds, []);
  assert.equal(result.latestMutationSequence, null);
  assert.equal(result.latestPassingVerificationSequence, null);
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.declaredCoverage, input.coverage);
  assert.equal(result.intakeIncomplete, false);
  assert.deepEqual(result.missingProfileFields, []);
  assert.deepEqual(input, before);
});

test('applies ordered partial task profile revisions and hashes the resulting profile', () => {
  const input = {
    ...baseInput(),
    throughSequence: 2,
    events: [
      { eventId: 'revision-1', sequence: 1, eventType: 'task_profile.revised', payload: { profile: { target: 'src/new.ts' } } },
      { eventId: 'revision-2', sequence: 2, eventType: 'task_profile.revised', payload: { profile: { expected: null, constraints: 'no network' } } },
    ],
  };
  const before = structuredClone(input);

  const result = projectLedger(input);

  assert.deepEqual(result.taskProfile, {
    taskType: 'build',
    target: 'src/new.ts',
    expected: null,
    constraints: 'no network',
  });
  assert.equal(result.profileHash, '3a5b74a47460eb855474aa08d8e0465913c583df95954ad4c4df826140c49c84');
  assert.equal(result.latestMutationSequence, 2);
  assert.deepEqual(input, before);
});

test('marks a passing verification as fresh evidence', () => {
  const input = {
    ...baseInput(),
    throughSequence: 1,
    events: [
      { eventId: 'verify-1', sequence: 1, eventType: 'verification.recorded', outcome: 'passed' },
    ],
  };

  const result = projectLedger(input);

  assert.equal(result.evidenceState, 'fresh');
  assert.equal(result.latestPassingVerificationSequence, 1);
});

test('marks passing evidence stale after a later explicit mutation', () => {
  const input = {
    ...baseInput(),
    throughSequence: 2,
    events: [
      { eventId: 'verify-1', sequence: 1, eventType: 'verification.recorded', outcome: 'passed' },
      { eventId: 'file-1', sequence: 2, eventType: 'file.changed' },
    ],
  };

  const result = projectLedger(input);

  assert.equal(result.evidenceState, 'stale');
  assert.equal(result.latestMutationSequence, 2);
  assert.equal(result.latestPassingVerificationSequence, 1);
});

test('lets a later passing verification restore freshness after a failure', () => {
  const input = {
    ...baseInput(),
    throughSequence: 3,
    events: [
      { eventId: 'verify-1', sequence: 1, eventType: 'verification.recorded', outcome: 'passed' },
      { eventId: 'verify-2', sequence: 2, eventType: 'test.completed', outcome: 'failed' },
      { eventId: 'verify-3', sequence: 3, eventType: 'verification.recorded', outcome: 'passed' },
    ],
  };

  const result = projectLedger(input);

  assert.equal(result.evidenceState, 'fresh');
  assert.equal(result.latestPassingVerificationSequence, 3);
});

test('tracks unresolved failure event IDs in sequence order', () => {
  const input = {
    ...baseInput(),
    throughSequence: 5,
    events: [
      { eventId: 'step-failure', sequence: 1, eventType: 'step.failed' },
      { eventId: 'tool-failure', sequence: 2, eventType: 'tool.failed' },
      { eventId: 'test-failure', sequence: 3, eventType: 'test.completed', outcome: 'failed' },
      { eventId: 'verification-failure', sequence: 4, eventType: 'verification.recorded', outcome: 'failed' },
      { eventId: 'error-failure', sequence: 5, eventType: 'error.recorded' },
    ],
  };

  const result = projectLedger(input);

  assert.deepEqual(result.unresolvedFailureEventIds, [
    'step-failure',
    'tool-failure',
    'test-failure',
    'verification-failure',
    'error-failure',
  ]);
});

test('clears failures and unknown outcomes only through later explicit resolution IDs', () => {
  const input = {
    ...baseInput(),
    throughSequence: 5,
    events: [
      { eventId: 'failure-1', sequence: 1, eventType: 'error.recorded' },
      { eventId: 'unknown-1', sequence: 2, eventType: 'tool.outcome_unknown' },
      { eventId: 'unrelated-1', sequence: 3, eventType: 'run.started', payload: { message: 'failure-1 unknown-1' } },
      { eventId: 'resolve-failure', sequence: 4, eventType: 'step.completed', payload: { resolvesEventIds: ['failure-1'] } },
      { eventId: 'resolve-unknown', sequence: 5, eventType: 'step.completed', payload: { resolvesEventIds: ['unknown-1'] } },
    ],
  };

  const result = projectLedger(input);

  assert.deepEqual(result.unresolvedFailureEventIds, []);
  assert.deepEqual(result.unknownOutcomeEventIds, []);
});

test('reports exhausted intake with ordered missing high-value profile fields', () => {
  const input = {
    ...baseInput(),
    initialProfile: { taskType: null, target: null, expected: null, constraints: 'optional' },
    intakeStatus: 'exhausted',
  };

  const result = projectLedger(input);

  assert.equal(result.intakeIncomplete, true);
  assert.deepEqual(result.missingProfileFields, ['taskType', 'target', 'expected']);
});

test('rejects ready intake with missing high-value fields as an integrity error', () => {
  const input = {
    ...baseInput(),
    initialProfile: { taskType: null, target: 'src/app.ts', expected: null, constraints: null },
  };

  assert.throws(() => projectLedger(input), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'INTEGRITY_ERROR');
    assert.equal((error as Error).message, 'Invalid persisted ledger projection state');
    return true;
  });
});

test('projects coverage as partial without upgrading declared levels', () => {
  const input = {
    ...baseInput(),
    coverage: {
      run: 'complete',
      tool: 'best_effort',
      command: 'declared',
      file: 'unavailable',
      approval: 'complete',
    },
  };

  const result = projectLedger(input);

  assert.equal(result.coverage, 'partial');
  assert.deepEqual(result.declaredCoverage, input.coverage);
});

test('rejects zero as an event local sequence', () => {
  const input = {
    ...baseInput(),
    throughSequence: 0,
    events: [{ eventId: 'event-zero', sequence: 0, eventType: 'run.started' }],
  };

  assert.throws(() => projectLedger(input), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'VALIDATION_ERROR');
    return true;
  });
});

test('rejects events outside the cursor or not strictly ordered', () => {
  const afterCursor = {
    ...baseInput(),
    throughSequence: 1,
    events: [{ eventId: 'event-2', sequence: 2, eventType: 'run.started' }],
  };
  const outOfOrder = {
    ...baseInput(),
    throughSequence: 2,
    events: [
      { eventId: 'event-2', sequence: 2, eventType: 'run.started' },
      { eventId: 'event-1', sequence: 1, eventType: 'run.closed' },
    ],
  };
  const duplicateSequence = {
    ...baseInput(),
    throughSequence: 2,
    events: [
      { eventId: 'event-1', sequence: 1, eventType: 'run.started' },
      { eventId: 'event-2', sequence: 1, eventType: 'run.closed' },
    ],
  };
  const duplicateId = {
    ...baseInput(),
    throughSequence: 2,
    events: [
      { eventId: 'event-1', sequence: 1, eventType: 'run.started' },
      { eventId: 'event-1', sequence: 2, eventType: 'run.closed' },
    ],
  };

  assert.throws(() => projectLedger(afterCursor), (error: unknown) => (error as { code: string }).code === 'VALIDATION_ERROR');
  assert.throws(() => projectLedger(outOfOrder), (error: unknown) => (error as { code: string }).code === 'VALIDATION_ERROR');
  assert.throws(() => projectLedger(duplicateSequence), (error: unknown) => (error as { code: string }).code === 'VALIDATION_ERROR');
  assert.throws(() => projectLedger(duplicateId), (error: unknown) => (error as { code: string }).code === 'VALIDATION_ERROR');
});

test('is deterministic for canonical-equivalent object key order', () => {
  const first = {
    ...baseInput(),
    throughSequence: 1,
    events: [{ eventId: 'event-1', sequence: 1, eventType: 'run.started', payload: { z: 1, a: 2 } }],
  };
  const reordered = {
    events: [{ payload: { a: 2, z: 1 }, eventType: 'run.started', sequence: 1, eventId: 'event-1' }],
    throughSequence: 1,
    coverage: { approval: 'complete', file: 'complete', command: 'complete', tool: 'complete', run: 'complete' },
    intakeStatus: 'ready',
    initialProfile: { constraints: null, expected: 'tests pass', target: 'src/app.ts', taskType: 'build' },
  };

  assert.deepEqual(projectLedger(first), projectLedger(reordered));
});

test('rejects unknown fields with a fixed validation error that does not echo input', () => {
  const secret = 'untrusted-secret-value';
  const invalidInputs = [
    { ...baseInput(), unexpected: secret },
    { ...baseInput(), initialProfile: { ...baseInput().initialProfile, unexpected: secret } },
    { ...baseInput(), coverage: { ...baseInput().coverage, unexpected: secret } },
    {
      ...baseInput(),
      throughSequence: 1,
      events: [{ eventId: 'event-1', sequence: 1, eventType: 'run.started', unexpected: secret }],
    },
    {
      ...baseInput(),
      throughSequence: 1,
      events: [{ eventId: 'event-1', sequence: 1, eventType: 'task_profile.revised', payload: { profile: { unexpected: secret } } }],
    },
  ];

  for (const input of invalidInputs) {
    assert.throws(() => projectLedger(input), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'VALIDATION_ERROR');
      assert.equal((error as Error).message, 'Invalid ledger projection input');
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
  }
});

test('rejects malformed revision and resolution control payloads without echoing them', () => {
  const secret = 'payload-secret-value';
  const invalidInputs = [
    {
      ...baseInput(),
      throughSequence: 1,
      events: [{ eventId: 'revision-1', sequence: 1, eventType: 'task_profile.revised', payload: { unexpected: secret } }],
    },
    {
      ...baseInput(),
      throughSequence: 1,
      events: [{ eventId: 'revision-1', sequence: 1, eventType: 'task_profile.revised', payload: { profile: { target: 42 } } }],
    },
    {
      ...baseInput(),
      throughSequence: 1,
      events: [{ eventId: 'resolve-1', sequence: 1, eventType: 'step.completed', payload: { resolvesEventIds: [42] } }],
    },
  ];

  for (const input of invalidInputs) {
    assert.throws(() => projectLedger(input), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'VALIDATION_ERROR');
      assert.equal((error as Error).message, 'Invalid ledger projection input');
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
  }
});

test('recognizes only explicit v1 mutation signals', () => {
  const input = {
    ...baseInput(),
    throughSequence: 4,
    events: [
      { eventId: 'verify-1', sequence: 1, eventType: 'verification.recorded', outcome: 'passed' },
      { eventId: 'command-no-mutation', sequence: 2, eventType: 'command.completed', payload: { mutated: false } },
      { eventId: 'tool-text-only', sequence: 3, eventType: 'tool.completed', payload: { message: 'changed files' } },
      { eventId: 'file-observed', sequence: 4, eventType: 'file.observed', payload: { mutated: true } },
    ],
  };

  const result = projectLedger(input);

  assert.equal(result.latestMutationSequence, null);
  assert.equal(result.evidenceState, 'fresh');
});

test('marks command and tool completion as mutations only when explicitly flagged', () => {
  const input = {
    ...baseInput(),
    throughSequence: 3,
    events: [
      { eventId: 'verify-1', sequence: 1, eventType: 'verification.recorded', outcome: 'passed' },
      { eventId: 'command-mutation', sequence: 2, eventType: 'command.completed', payload: { mutated: true } },
      { eventId: 'tool-mutation', sequence: 3, eventType: 'tool.completed', payload: { mutated: true } },
    ],
  };

  const result = projectLedger(input);

  assert.equal(result.latestMutationSequence, 3);
  assert.equal(result.evidenceState, 'stale');
});

test('reports latest failed verification and preserves unknown tool outcomes', () => {
  const input = {
    ...baseInput(),
    throughSequence: 2,
    events: [
      { eventId: 'test-failure', sequence: 1, eventType: 'test.completed', outcome: 'failed' },
      { eventId: 'unknown-tool', sequence: 2, eventType: 'tool.outcome_unknown' },
    ],
  };

  const result = projectLedger(input);

  assert.equal(result.evidenceState, 'failed');
  assert.deepEqual(result.unresolvedFailureEventIds, ['test-failure']);
  assert.deepEqual(result.unknownOutcomeEventIds, ['unknown-tool']);
});

test('validates malformed revision payloads before reporting persisted intake integrity', () => {
  const input = {
    ...baseInput(),
    initialProfile: { taskType: null, target: null, expected: null, constraints: null },
    throughSequence: 1,
    events: [{ eventId: 'revision-1', sequence: 1, eventType: 'task_profile.revised', payload: { profile: { target: 42 } } }],
  };

  assert.throws(() => projectLedger(input), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'VALIDATION_ERROR');
    return true;
  });
});
