import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_IDLE_RETRIES, OpenCodeIdleState } from '../../src/opencode/idle-state.js';

test('idle state keeps hook and prompt retries separate with compare-and-set transitions', () => {
  const state = new OpenCodeIdleState();
  const first = state.begin('event');
  assert.deepEqual(first, { kind: 'run_hook', hookAttempts: 1 });
  assert.equal(state.markHookFailure('event', 99, 'stale'), false);
  assert.equal(state.markHookFailure('event', 1, 'timeout'), true);
  const retry = state.begin('event');
  assert.deepEqual(retry, { kind: 'run_hook', hookAttempts: 2 });
  assert.equal(state.markPendingPrompt('event', 2, 'message', 'continue'), true);

  const claim = state.claimPrompt('event');
  assert.deepEqual(claim, { messageId: 'message', text: 'continue', deliveryAttempts: 0 });
  assert.equal(state.claimPrompt('event'), undefined);
  const attempted = state.markPromptAttempt('event', claim!);
  assert.equal(attempted?.deliveryAttempts, 1);
  assert.equal(state.markPromptUnconfirmed('event', attempted!), true);
  assert.deepEqual(state.get('event'), {
    state: 'pending_prompt', messageId: 'message', text: 'continue', deliveryAttempts: 1,
  });
});

test('idle state makes completed and quarantined states terminal', () => {
  const completed = new OpenCodeIdleState();
  const started = completed.begin('completed');
  assert.equal(started.kind, 'run_hook');
  assert.equal(completed.markCompleted('completed', 'stopped', { state: 'in_flight', hookAttempts: 1 }), true);
  assert.deepEqual(completed.begin('completed'), { kind: 'ignored' });
  assert.equal(completed.markHookFailure('completed', 1, 'stale'), false);

  const quarantined = new OpenCodeIdleState();
  for (let attempt = 1; attempt <= MAX_IDLE_RETRIES; attempt += 1) {
    const claim = quarantined.begin('quarantined');
    assert.deepEqual(claim, { kind: 'run_hook', hookAttempts: attempt });
    assert.equal(quarantined.markHookFailure('quarantined', attempt, 'timeout'), true);
  }
  assert.deepEqual(quarantined.get('quarantined'), { state: 'quarantined', reason: 'retry_exhausted' });
  assert.deepEqual(quarantined.begin('quarantined'), { kind: 'ignored' });
});

test('idle state releases only the exact current provisional claim', () => {
  const state = new OpenCodeIdleState();
  assert.deepEqual(state.begin('event'), { kind: 'run_hook', hookAttempts: 1 });
  assert.equal(state.release('event', 2), false);
  assert.equal(state.get('event')?.state, 'in_flight');
  assert.equal(state.release('event', 1), true);
  assert.equal(state.get('event'), undefined);
});
