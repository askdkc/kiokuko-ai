import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlanStartRecovery,
  PLAN_START_RECOVERY_REASONS,
  renderPlanStartRecovery,
} from '../../src/enno-oduno/plan-recovery.js';

test('missing environment information offers three general-language choices', () => {
  const recovery = buildPlanStartRecovery('environment_information_missing');
  assert.equal(recovery.code, 'PLAN_START_RECOVERY_REQUIRED');
  assert.deepEqual(recovery.userFacingRecovery.options, [
    {
      action: 'continue_same_plan',
      label: 'Continue with the same plan',
      recommended: true,
      whenToChoose: 'The plan is still correct and only the current environment information needs to be attached.',
      whatHappens: 'The current environment information is attached automatically, and the same attempt continues.',
    },
    {
      action: 'revise_plan',
      label: 'Review the plan',
      recommended: false,
      whenToChoose: 'You want to change the scope, work items, or verification before continuing.',
      whatHappens: 'You are asked what to change, and implementation does not start until you answer.',
    },
    {
      action: 'cancel',
      label: 'Cancel',
      recommended: false,
      whenToChoose: 'You no longer want this work to continue.',
      whatHappens: 'The current attempt is cancelled, and no replacement attempt is created.',
    },
  ]);
  const rendered = renderPlanStartRecovery(recovery);
  assert.match(rendered, /not carried into the plan/iu);
  assert.match(rendered, /did not begin new work or make additional code changes/iu);
  assert.match(rendered, /continue with the same plan/iu);
  assert.match(rendered, /Choose this when: The plan is still correct/iu);
  assert.match(rendered, /What happens: The current environment information is attached automatically/iu);
});

test('a changed environment offers restart, review, and cancellation without internal display terms', () => {
  const recovery = buildPlanStartRecovery('environment_changed');
  assert.deepEqual(recovery.userFacingRecovery.options, [
    {
      action: 'restart_same_plan',
      label: 'Restart the same plan in the current environment',
      recommended: true,
      whenToChoose: 'The plan is still correct and only the available features have changed.',
      whatHappens: 'The current attempt is cancelled, and a new attempt starts with the current environment and the same agreed plan.',
    },
    {
      action: 'revise_then_restart',
      label: 'Review the plan before restarting',
      recommended: false,
      whenToChoose: 'The changed features should alter the scope, work items, or verification.',
      whatHappens: 'You are asked what to change; after you answer, the current attempt is cancelled and a new attempt starts with the current environment and revised plan.',
    },
    {
      action: 'cancel',
      label: 'Cancel',
      recommended: false,
      whenToChoose: 'You no longer want this work to continue.',
      whatHappens: 'The current attempt is cancelled, and no replacement attempt is created.',
    },
  ]);
  const rendered = renderPlanStartRecovery(recovery);
  assert.match(rendered, /features available.*have changed/iu);
  assert.match(rendered, /Start a new attempt using the current environment/iu);
  for (const forbidden of ['enno_', 'capabilities', 'digest', 'runId', 'revision']) {
    assert.equal(rendered.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test('an already-ended attempt explains that the plan can be reused in a new attempt', () => {
  const recovery = buildPlanStartRecovery('previous_attempt_ended');
  assert.deepEqual(recovery.userFacingRecovery.options, [
    {
      action: 'restart_same_plan',
      label: 'Restart with the same plan',
      recommended: true,
      whenToChoose: 'The ended attempt\'s plan is still correct and should be reused.',
      whatHappens: 'The ended attempt stays unchanged, and a new attempt starts with the current environment and the same agreed plan.',
    },
    {
      action: 'revise_then_restart',
      label: 'Review the plan before restarting',
      recommended: false,
      whenToChoose: 'You want to change the scope, work items, or verification before creating a replacement.',
      whatHappens: 'You are asked what to change; the ended attempt stays unchanged, and a new attempt starts with the current environment and revised plan only after you answer.',
    },
    {
      action: 'cancel',
      label: 'Cancel',
      recommended: false,
      whenToChoose: 'You do not want to restart the work.',
      whatHappens: 'The ended attempt remains ended, and no new attempt is created.',
    },
  ]);
  const rendered = renderPlanStartRecovery(recovery);
  assert.match(rendered, /required environment information.*not included/iu);
  assert.match(rendered, /attempt has ended/iu);
  assert.match(rendered, /plan itself can be used/iu);
  assert.match(rendered, /did not begin new work or make additional code changes/iu);
});

test('every user-visible recovery hides internal protocol terms', () => {
  for (const reason of PLAN_START_RECOVERY_REASONS) {
    const recovery = buildPlanStartRecovery(reason);
    const rendered = renderPlanStartRecovery(recovery);
    assert.equal(recovery.userFacingRecovery.options.length, 3);
    assert.equal(recovery.userFacingRecovery.options.filter((option) => option.recommended).length, 1);
    assert.equal((rendered.match(/Choose this when:/gu) ?? []).length, 3);
    assert.equal((rendered.match(/What happens:/gu) ?? []).length, 3);
    assert.equal((rendered.match(/\(Recommended\)/gu) ?? []).length, 1);
    for (const option of recovery.userFacingRecovery.options) {
      assert.equal(option.whenToChoose.length > 0, true);
      assert.equal(option.whatHappens.length > 0, true);
      assert.ok(rendered.indexOf(option.label) < rendered.indexOf(option.whenToChoose));
      assert.ok(rendered.indexOf(option.whenToChoose) < rendered.indexOf(option.whatHappens));
    }
    for (const forbidden of [
      'enno_', 'capabilities', 'catalog', 'digest', 'run id', 'runId', 'revision',
      'whenToChoose', 'whatHappens', 'presentationVersion', 'PLAN_START_RECOVERY_REQUIRED',
    ]) {
      assert.equal(rendered.toLowerCase().includes(forbidden.toLowerCase()), false, `${reason}: ${forbidden}`);
    }
  }
});
