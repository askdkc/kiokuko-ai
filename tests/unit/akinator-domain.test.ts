import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import {
  AKINATOR_POLICY_VERSION,
  applyAnswer,
  deriveProfile,
  evaluateProfile,
  profileHash,
} from '../../src/akinator/domain.js';

test('derives task types from Japanese and English task text while preserving explicit non-null hints', () => {
  const cases = [
    ['Implement a feature', 'build'],
    ['デバッグして不具合を修正する', 'debug'],
    ['Research comparable approaches', 'research'],
    ['レビューと監査を行う', 'review'],
    ['Deploy the service with DevOps', 'devops'],
    ['Write project documentation', 'writing'],
    ['ログを分析して集計する', 'analysis'],
  ] as const;

  for (const [task, taskType] of cases) {
    assert.equal(deriveProfile(task).taskType, taskType);
  }

  const hints = {
    taskType: 'review' as const,
    target: 'src/explicit.ts',
    expected: 'tests pass',
    constraints: null,
  };
  const before = structuredClone(hints);
  const profile = deriveProfile('Implement and build a feature', hints);

  assert.deepEqual(profile, hints);
  assert.deepEqual(hints, before);
});

test('asks only missing required fields in taskType, target, expected order', () => {
  const empty = { taskType: null, target: null, expected: null, constraints: null } as const;
  const taskType = evaluateProfile(empty, 0);
  assert.equal(taskType.question?.id, 'taskType');
  assert.equal(taskType.question?.prompt, 'この作業の主目的はどれですか？');
  assert.deepEqual(taskType.question?.options, ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis']);
  assert.equal(taskType.question?.required, true);
  assert.deepEqual(taskType.missingFields, ['taskType', 'target', 'expected']);

  const target = evaluateProfile({ ...empty, taskType: 'build' }, 1);
  assert.equal(target.question?.id, 'target');
  assert.equal(target.question?.prompt, '対象のリポジトリ、ファイル、機能、またはサービスは何ですか？');
  assert.equal(target.question?.options, null);
  assert.equal(target.question?.required, true);

  const expected = evaluateProfile({ ...empty, taskType: 'build', target: 'src/index.ts' }, 2);
  assert.equal(expected.question?.id, 'expected');
  assert.equal(expected.question?.prompt, '完了と判断する成功条件は何ですか？');
  assert.equal(expected.question?.options, null);
  assert.equal(expected.question?.required, true);

  const readyWithoutConstraints = evaluateProfile({
    ...empty,
    taskType: 'build',
    target: 'src/index.ts',
    expected: 'tests pass',
  }, 3);
  assert.equal(readyWithoutConstraints.status, 'ready');
  assert.equal(readyWithoutConstraints.question, null);
  assert.deepEqual(readyWithoutConstraints.missingFields, []);
});

test('fixes the current domain state machine boundaries before policy refactoring', () => {
  const empty = { taskType: null, target: null, expected: null, constraints: null } as const;
  const cases = [
    { name: 'no taskType', profile: empty, questionCount: 0, status: 'needs_answer', questionId: 'taskType' },
    { name: 'taskType only', profile: { ...empty, taskType: 'build' as const }, questionCount: 1, status: 'needs_answer', questionId: 'target' },
    { name: 'taskType and target', profile: { ...empty, taskType: 'build' as const, target: 'src/index.ts' }, questionCount: 2, status: 'needs_answer', questionId: 'expected' },
    { name: 'all required fields', profile: { ...empty, taskType: 'build' as const, target: 'src/index.ts', expected: 'tests pass' }, questionCount: 0, status: 'ready', questionId: null },
    { name: 'missing fields at count 3', profile: empty, questionCount: 3, status: 'exhausted', questionId: null },
  ] as const;

  for (const current of cases) {
    const evaluation = evaluateProfile(current.profile, current.questionCount);
    assert.equal(evaluation.status, current.status, current.name);
    assert.equal(evaluation.question?.id ?? null, current.questionId, current.name);
    if (evaluation.status === 'needs_answer') assert.notEqual(evaluation.question, null, current.name);
    if (evaluation.status === 'ready') assert.deepEqual(evaluation.missingFields, [], current.name);
    if (evaluation.status === 'exhausted') assert.notDeepEqual(evaluation.missingFields, [], current.name);
    assert.deepEqual(evaluateProfile(current.profile, current.questionCount), evaluation, `${current.name} is deterministic`);
  }
});

test('rejects answers for fields other than the current question without mutating state or echoing values', () => {
  const state = {
    task: 'Implement a feature',
    profile: deriveProfile('Implement a feature'),
    questionCount: 0,
  };
  const before = structuredClone(state);

  assert.throws(
    () => applyAnswer(state, { questionId: 'expected', value: 'secret answer' }),
    (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /current question/i);
      assert.deepEqual(error.details, { expectedField: 'target' });
      assert.equal(JSON.stringify(error).includes('secret answer'), false);
      return true;
    },
  );
  assert.deepEqual(state, before);
});

test('trims accepted answers, normalizes task type aliases, and rejects invalid task types safely', () => {
  const state = {
    task: 'ambiguous request',
    profile: deriveProfile('ambiguous request'),
    questionCount: 0,
  };
  const before = structuredClone(state);
  const withTaskType = applyAnswer(state, { questionId: 'taskType', value: '  implementation  ' });

  assert.equal(withTaskType.profile.taskType, 'build');
  assert.equal(withTaskType.questionCount, 1);
  assert.equal(withTaskType.question?.id, 'target');
  assert.deepEqual(state, before);

  const beforeTarget = structuredClone(withTaskType);
  const withTarget = applyAnswer(withTaskType, { questionId: 'target', value: '  src/index.ts  ' });
  assert.equal(withTarget.profile.target, 'src/index.ts');
  assert.equal(withTarget.questionCount, 2);
  assert.equal(withTarget.question?.id, 'expected');
  assert.deepEqual(withTaskType, beforeTarget);

  const ready = applyAnswer(withTarget, { questionId: 'expected', value: '  tests pass  ' });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.question, null);
  assert.equal(ready.questionCount, 3);
  assert.deepEqual(ready.missingFields, []);

  assert.throws(
    () => applyAnswer(state, { questionId: 'taskType', value: 'secret-invalid-task-type' }),
    (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message.includes('secret-invalid-task-type'), false);
      assert.deepEqual(error.details, {});
      return true;
    },
  );
});

test('transitions between needs_answer, ready, and exhausted without inventing a question', () => {
  const empty = { taskType: null, target: null, expected: null, constraints: null };

  const needsAnswer = evaluateProfile(empty, 0);
  assert.equal(needsAnswer.status, 'needs_answer');
  assert.equal(needsAnswer.question?.id, 'taskType');
  assert.deepEqual(Object.keys(needsAnswer).sort(), [
    'missingFields', 'profileHash', 'question', 'recommendedTags', 'status',
  ]);

  const exhausted = evaluateProfile(empty, 3);
  assert.equal(exhausted.status, 'exhausted');
  assert.equal(exhausted.question, null);
  assert.deepEqual(exhausted.missingFields, ['taskType', 'target', 'expected']);

  const ready = evaluateProfile({
    taskType: 'debug',
    target: 'src/bug.ts',
    expected: 'the regression test passes',
    constraints: null,
  }, 0);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.question, null);
  assert.deepEqual(ready.missingFields, []);
});

test('hashes semantic profiles canonically and returns stable role-first skill tags without duplicates', () => {
  const profileA = {
    taskType: 'build' as const,
    target: 'src/index.ts',
    expected: 'tests pass',
    constraints: null,
  };
  const profileB = {
    constraints: null,
    expected: 'tests pass',
    target: 'src/index.ts',
    taskType: 'build' as const,
  };

  assert.equal(profileHash(profileA), 'd0813df79dce8212757ba9bb5d9f07471eaec8003895c80e2454a9e498335528');
  assert.equal(profileHash(profileA), profileHash(profileB));
  const tags = evaluateProfile(profileA, 0).recommendedTags;
  assert.deepEqual(tags, [
    'bot:builder',
    'skill:tdd',
  ]);
  assert.equal(new Set(tags).size, tags.length);
});

test('rejects unknown top-level profile, state, and answer fields with fixed validation errors', () => {
  const state = {
    task: 'Implement a feature',
    profile: deriveProfile('Implement a feature'),
    questionCount: 0,
  };
  const cases: Array<[string, () => unknown, string]> = [
    ['profile', () => deriveProfile('Implement a feature', { unknownProfileField: 'profile-secret' }), 'Unknown profile field'],
    ['profile', () => evaluateProfile({ ...state.profile, unknownProfileField: 'profile-secret' }, 0), 'Unknown profile field'],
    ['state', () => applyAnswer({ ...state, unknownStateField: 'state-secret' }, { questionId: 'target', value: 'src/index.ts' }), 'Unknown state field'],
    ['answer', () => applyAnswer(state, { questionId: 'target', value: 'src/index.ts', unknownAnswerField: 'answer-secret' }), 'Unknown answer field'],
  ];

  for (const [, action, message] of cases) {
    assert.throws(action, (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message, message);
      assert.deepEqual(error.details, {});
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
});

test('rejects question counts beyond the three-question policy budget', () => {
  const profile = { taskType: null, target: null, expected: null, constraints: null };
  assert.throws(() => evaluateProfile(profile, 4), (error: unknown) => {
    assert.ok(error instanceof KiokukoError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.message, 'questionCount must be an integer between 0 and 3');
    return true;
  });
  assert.throws(() => applyAnswer({ task: 'ambiguous', profile, questionCount: 4 }, {
    questionId: 'taskType',
    value: 'build',
  }), (error: unknown) => {
    assert.ok(error instanceof KiokukoError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    return true;
  });
});

test('exposes a stable domain policy version', () => {
  assert.equal(AKINATOR_POLICY_VERSION, 'v2');
});
