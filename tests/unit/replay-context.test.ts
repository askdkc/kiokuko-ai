import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedReplayContext } from '../../src/memory/replay-context.js';
import { renderOpenCodeLearningContext } from '../../src/opencode/learning.js';
import type { ReplayMemoryProposal } from '../../src/memory/replay-review.js';

function proposal(): ReplayMemoryProposal {
  return { schemaVersion: 1, proposalId: 'approved', revision: 1,
    source: { workspace: 'project:test', taskId: 'historical-task', sessionId: 'historical-session', taskOutcome: 'completed',
      traces: [{ runId: 'run_abcdef', eventsSha256: 'a'.repeat(64), eventsRead: 3, totalEvents: 3, complete: true, gaps: [] }] },
    request: { text: 'Fix a transient sqlite lock', evidenceRefs: ['run_abcdef:1'] }, languages: [],
    findings: [{ kind: 'key_point', text: 'Retry only for transient locks after reproducing the current failure.',
      basis: 'verified', evidenceRefs: [] }], attempts: [], tags: ['sqlite'], keywords: ['retry'] };
}

test('a recorded verified claim without evidence is not current verification or applicability', () => {
  const entry = approvedReplayContext(proposal());
  assert.equal(entry.findings[0]?.basis, 'verified', 'retain the recorded claim without upgrading its authority');
  assert.equal(entry.findings[0]?.evidenceStatus, 'not_provided');
  assert.equal(entry.verification, 'user_reviewed_not_task_verified');
  assert.equal(entry.currentApplicability, 'unverified');
  assert.equal(entry.attempts.length, 0);
});

test('unresolved references and another task successful attempt cannot substantiate a finding', () => {
  const p = proposal(); p.findings[0]!.evidenceRefs = ['run_abcdef:99'];
  p.attempts = [{ taskId: 'other-task', attemptId: 'attempt', tool: 'bash', command: 'node lock.test.js',
    callRef: 'run_abcdef:2', resultRef: 'run_abcdef:3', execution: 'completed', outcome: 'succeeded', exitCode: 0,
    payloadHashes: [], limitations: [], outputExcerpt: 'RAW_OUTPUT_NOT_FOR_CONTEXT', arguments: { details: 'RAW_ARGUMENTS_NOT_FOR_CONTEXT' } }];
  const entry = approvedReplayContext(p);
  assert.equal(entry.findings[0]?.evidenceStatus, 'references_only');
  assert.equal(entry.attempts[0]?.taskBinding, 'other_task');
  assert.equal(entry.attempts[0]?.outcome, 'succeeded');
  assert.equal(entry.currentApplicability, 'unverified');
  assert.doesNotMatch(JSON.stringify(entry), /RAW_OUTPUT|RAW_ARGUMENTS/);
});

test('bounded previews retain linked evidence and explicitly disclose omitted material', () => {
  const p = proposal();
  p.findings = Array.from({ length: 20 }, (_, i) => ({ kind: 'key_point', text: `Recorded condition ${i}: ` + 'x'.repeat(1000),
    basis: 'observed', evidenceRefs: ['run_abcdef:2', 'run_abcdef:3'] }));
  p.attempts = Array.from({ length: 10 }, (_, i) => ({ taskId: 'historical-task', attemptId: `attempt-${i}`, tool: 'bash',
    command: 'node check.js ' + 'x'.repeat(1000), callRef: `run_abcdef:${i + 2}`, resultRef: `run_abcdef:${i + 3}`,
    execution: 'completed', outcome: 'failed', exitCode: 1, payloadHashes: [], limitations: ['historical execution only'],
    outputExcerpt: 'RAW_OUTPUT_NOT_FOR_CONTEXT'.repeat(1000) }));
  const entry = approvedReplayContext(p);
  const rendered = renderOpenCodeLearningContext({ entries: [entry] })!;
  assert.equal(JSON.parse(rendered).entries.length, 1, 'a bounded preview must reach the consumer');
  assert.ok(rendered.length <= 5000);
  assert.equal(entry.omitted.findings, 18);
  assert.equal(entry.omitted.attempts, 7);
  assert.equal(entry.findings[0]?.textTruncated, true);
  assert.equal(entry.attempts[0]?.commandTruncated, true);
  assert.equal(entry.findings[0]?.evidenceStatus, 'recorded_attempts');
  assert.equal(entry.attempts[0]?.taskBinding, 'reviewed_task');
  assert.doesNotMatch(rendered, /RAW_OUTPUT/);
});
