import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointEligibility, type CheckpointEligibility } from '../../src/ledger/checkpoint-eligibility.js';
import type { RunStatus } from '../../src/ledger/types.js';

test('checkpoint eligibility returns a deterministic public-safe result for every run status', () => {
  const cases: Array<[RunStatus, CheckpointEligibility]> = [
    ['active', { allowed: true }],
    ['intake', {
      allowed: false,
      reason: 'run_awaiting_intake_answer',
      nextAction: 'answer_from_evidence_or_ask_user',
      retryableAfterStateChange: true,
    }],
    ['completed', { allowed: false, reason: 'run_terminal', nextAction: 'stop', retryableAfterStateChange: false }],
    ['failed', { allowed: false, reason: 'run_terminal', nextAction: 'stop', retryableAfterStateChange: false }],
    ['cancelled', { allowed: false, reason: 'run_terminal', nextAction: 'stop', retryableAfterStateChange: false }],
    ['interrupted', { allowed: false, reason: 'run_terminal', nextAction: 'stop', retryableAfterStateChange: false }],
  ];

  for (const [status, expected] of cases) {
    const first = checkpointEligibility(status);
    const second = checkpointEligibility(status);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
    assert.notStrictEqual(first, second);
  }
});
