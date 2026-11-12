import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCompletedReplay, type ReplayMemoryProposal, type ReviewQuestion } from '../../src/memory/replay-review.js';
import { askMcpReviewQuestion } from '../../src/mcp/review-question.js';
import { registerOpenCodeLearning } from '../../src/opencode/learning.js';
import { OpenCodePluginLifecycle } from '../../src/opencode/lifecycle.js';
import { pluginContextFixture } from '../fixtures/opencode-v2-plugin.js';

test('save asks once about the actual compact summary, without retaining raw output', async () => {
  const questions: ReviewQuestion[] = [];
  let saved: ReplayMemoryProposal | undefined;
  const result = await reviewCompletedReplay({ completed: true, sourceKind: 'unrecorded', workspace: 'repo', taskId: 'task', sessionId: 'session',
    extract: async () => ({ schemaVersion: 1, proposalId: '', revision: 1,
      source: { kind: 'unrecorded', workspace: 'repo', taskId: 'task', sessionId: 'session', traces: [] },
      request: { text: 'Fix SQLite retry', evidenceRefs: [] }, languages: [], attempts: [], tags: ['sqlite'], keywords: ['retry'],
      findings: [{ kind: 'key_point', text: 'Retry only transient locks.\n' + 'discarded detail '.repeat(500), basis: 'inferred', evidenceRefs: [] }] }),
    ask: async q => { questions.push(q); return { questionId: q.id, choice: 'approve' }; }, save: async p => { saved = p; },
  });
  assert.equal(result.status, 'saved');
  assert.equal(questions.length, 1);
  assert.ok(saved?.summary);
  assert.equal(saved.summary.split('\n').length, 6);
  assert.ok(questions[0]!.text.includes(saved.summary));
  assert.equal(questions[0]!.details, JSON.stringify(saved, null, 2));
  assert.ok(JSON.stringify(saved).length < 4000);
});

test('native MCP save form has no comment field; editing opens a separate summary field', async () => {
  const forms: any[] = [];
  const answers = [{ choice: 'revise' }, { summary: 'Use bounded retries.\nVerify lock handling.' }];
  const server = { server: { elicitInput: async (form: unknown) => { forms.push(form); return { action: 'accept', content: answers.shift() }; } } };
  const answer = await askMcpReviewQuestion(server as any, { id: 'q', phase: 'review', text: 'Save this summary?' }, new AbortController().signal);
  assert.equal(forms[0].requestedSchema.properties.comment, undefined);
  assert.deepEqual(forms[1].requestedSchema.required, ['summary']);
  assert.equal(answer.choice, 'revise');
  assert.equal(answer.comment, 'Use bounded retries.\nVerify lock handling.');
});

test('the first model context receives request-specific recall even before background lookup settles', async t => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  let release!: (value: string) => void;
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: () => new Promise(resolve => { release = resolve; }),
  }, () => undefined);
  await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'request', prompt: { text: 'Fix SQLite retry' } } as never);
  await new Promise<void>(resolve => setImmediate(resolve));
  const system: unknown[] = [];
  const context = Promise.resolve(fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never));
  release('MATCHED_SQLITE_MEMORY');
  await context;
  assert.match(JSON.stringify(system), /MATCHED_SQLITE_MEMORY/);
});

test('an unavailable recall cannot hold the first context indefinitely or survive disposal', async () => {
  const fixture = pluginContextFixture();
  const lifecycle = new OpenCodePluginLifecycle();
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, {
    recall: () => new Promise(() => undefined),
  }, () => undefined);
  await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'request', prompt: { text: 'SQLite' } } as never);
  const system: unknown[] = [];
  const started = performance.now();
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(system, []);
  const waiting = fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  await lifecycle.dispose(() => undefined);
  await waiting;
  assert.deepEqual(system, []);
});
