import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCompletedReplay, type ReplayMemoryProposal, type ReviewQuestion } from '../../src/memory/replay-review.js';

test('review asks once with six saved summary lines and bounded provenance available', async () => {
  const proposal: ReplayMemoryProposal = {
    schemaVersion: 1, proposalId: '', revision: 1,
    source: { kind: 'unrecorded', workspace: 'project', taskId: 'task', sessionId: 'session', traces: [], limitations: ['No recording supplied.'] },
    request: { text: 'Fix startup\n' + 'long request '.repeat(200), evidenceRefs: [] },
    languages: [], attempts: [], tags: [], keywords: [],
    findings: [{ kind: 'key_point', text: 'Startup now works.\n' + 'extra details '.repeat(200), basis: 'inferred', evidenceRefs: [] }],
  };
  const questions: ReviewQuestion[] = [];
  let saved: ReplayMemoryProposal | undefined;
  await reviewCompletedReplay({ completed: true, sourceKind: 'unrecorded', workspace: 'project', taskId: 'task', sessionId: 'session',
    extract: async () => proposal, ask: async q => { questions.push(q); return { questionId: q.id, choice: q.phase === 'organize' ? 'organize' : 'approve' }; },
    save: async p => { saved = p; },
  });
  for (const q of questions) {
    assert.equal(q.text.split('\n').length, 7);
    assert.ok(q.text.split('\n').every(line => line.length <= 240));
  }
  assert.equal(questions.length, 1);
  const review = questions[0]!;
  assert.match(review.text.split('\n')[0]!, /Save this summary/);
  assert.match(review.text, /Fix startup/);
  assert.match(review.text, /Startup now works/);
  assert.match(review.text, /No recording.*unverified/);
  assert.doesNotMatch(review.text, /SHA-256|schemaVersion|workspace/);
  assert.equal(review.details, JSON.stringify(saved, null, 2));
  assert.equal(saved!.summary, review.text.split('\n').slice(1).join('\n'));
  assert.ok(saved!.findings[0]!.text.length <= 240);
});

test('recorded preview keeps task failure and partial evidence visible', async () => {
  let preview: ReviewQuestion | undefined;
  const result = await reviewCompletedReplay({ completed: true, taskOutcome: 'failed', workspace: 'project', taskId: 'task', sessionId: 'session',
    extract: async () => ({ schemaVersion: 1, proposalId: '', revision: 1,
      source: { workspace: 'project', taskId: 'task', sessionId: 'session', traces: [{ runId: 'trace', eventsSha256: '', eventsRead: 1, totalEvents: null, complete: false, gaps: ['Missing events'] }] },
      request: { text: 'Check startup', evidenceRefs: [] }, languages: [], attempts: [], findings: [], tags: [], keywords: [] }),
    ask: async q => { if (q.phase === 'review') preview = q; return { questionId: q.id, choice: q.phase === 'organize' ? 'organize' : 'decline' }; },
    save: async () => { assert.fail('decline must not save'); },
  });
  assert.equal(result.status, 'declined');
  assert.match(preview!.text, /task failed/);
  assert.match(preview!.text, /Partial recording/);
  assert.match(preview!.text, /No key points supplied/);
  assert.equal(preview!.text.split('\n').length, 7);
});
