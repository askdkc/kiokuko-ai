import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAkinatorReasoning, reasoningQuestionGuidance } from '../../src/akinator/reasoning.js';

test('narrows abstract action families into one executable action', () => {
  const abstract = deriveAkinatorReasoning('何か改善したい', {
    taskType: null,
    target: null,
    expected: null,
    constraints: null,
  });
  assert.equal(abstract.stage, 'exploring');
  assert.equal(abstract.hypotheses.filter((item) => item.status === 'possible').length, 7);
  assert.equal(abstract.questions.find((item) => item.id === 'taskType')?.status, 'pending');
  assert.equal(abstract.selectedAction, null);

  const actionable = deriveAkinatorReasoning('検索を直す', {
    taskType: 'debug',
    target: '検索API',
    expected: '回帰テストが成功する',
    constraints: '既存レスポンス形式を変えない',
  });
  assert.equal(actionable.stage, 'actionable');
  assert.equal(actionable.hypotheses.find((item) => item.status === 'selected')?.id, 'debug');
  assert.match(actionable.selectedAction ?? '', /検索API/u);
  assert.equal(actionable.silo.completeness, 1);
  assert.ok(actionable.questions.every((item) => item.status === 'answered'));
  assert.match(actionable.stopConditions[1] ?? '', /既存レスポンス形式/u);
});

test('documents which decision dimension each Akinator question narrows', () => {
  assert.ok(reasoningQuestionGuidance('taskType').discriminates.includes('debug'));
  assert.ok(reasoningQuestionGuidance('target').discriminates.includes('変更境界'));
  assert.ok(reasoningQuestionGuidance('expected').discriminates.includes('検証方法'));
});
