import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { runNativeReplayReview } from '../../src/opencode/replay-review-worker.js';
import { createApprovedReplayMemoryStore } from '../../src/memory/replay-store.js';
import { memoryContext, observeMemory, improveMemory } from '../../src/memory/learning.js';
import type { ReviewQuestion } from '../../src/memory/replay-review.js';
import { renderOpenCodeLearningContext } from '../../src/opencode/learning.js';

async function fixture(t: { after(fn: () => void): void }, schemaVersion = '0.4.0') {
  const directory = mkdtempSync(path.join(tmpdir(), 'kiokuko-reviewed-replay-'));
  const previous = process.env.KIOKUKO_DATA_DIR;
  process.env.KIOKUKO_DATA_DIR = path.join(directory, 'data');
  t.after(() => { if (previous === undefined) delete process.env.KIOKUKO_DATA_DIR; else process.env.KIOKUKO_DATA_DIR = previous; rmSync(directory, { recursive: true, force: true }); });
  const cwd = path.join(directory, 'repo'); execFileSync('git', ['init', '-q', cwd]);
  const initialized = await initializeDatabase(); const db = openConnection(initialized.databasePath);
  const project = (await resolveProjectWorkspace(db, cwd))!;
  db.close();
  const traceDirectory = path.join(cwd, '.agenticreplay', 'runs', 'run_123456'); mkdirSync(traceDirectory, { recursive: true });
  const events = [
    { seq: 1, type: 'model.request', payload: { messages: [{ role: 'user', content: 'Fix migration retry in TypeScript' }] } },
    { seq: 2, type: 'tool.call', attrs: { callId: 'first', name: 'bash' }, payload: { command: 'node retry.test.js' } },
    { seq: 3, type: 'tool.result', causes: [2], attrs: { callId: 'first', exit_code: 1 }, payload: { output: 'retry failed' } },
    { seq: 4, type: 'tool.call', attrs: { callId: 'second', name: 'bash' }, payload: { command: 'node retry.test.js' } },
    { seq: 5, type: 'tool.result', causes: [4], attrs: { callId: 'second', exit_code: 0 }, payload: { output: 'retry passes' } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  writeFileSync(path.join(traceDirectory, 'events.jsonl'), events);
  writeFileSync(path.join(traceDirectory, 'manifest.json'), JSON.stringify({ schema_version: schemaVersion, run_id: 'run_123456', counts: { events: 5 }, integrity: { events_sha256: createHash('sha256').update(events).digest('hex') } }));
  return { input: { cwd, traceDirectory, taskId: 'request-1', sessionId: 'session-1' }, databasePath: initialized.databasePath, workspace: project.workspace };
}

test('automatic observations and improvement cannot write, including a fabricated approval flag', async t => {
  const f = await fixture(t); const db = openConnection(f.databasePath);
  t.after(() => db.close());
  const before = db.prepare('SELECT count(*) AS n FROM entries').get();
  for (const operation of [observeMemory, improveMemory]) {
    const result = await operation(db, { cwd: f.input.cwd, approved: true, summary: 'save me', kind: 'praise' });
    assert.equal(result.recorded, false); assert.equal(result.workMayContinue, true);
    assert.deepEqual(result.warnings, ['post_task_review_required']);
  }
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM entries').get(), before);
});

test('decline before extraction and after preview leave no proposal, entry, or replay tables', async t => {
  const f = await fixture(t);
  for (const afterPreview of [false, true]) {
    let asks = 0;
    const result = await runNativeReplayReview(f.input, async q => { asks++; return { questionId: q.id, choice: afterPreview && q.phase === 'organize' ? 'organize' : 'decline' }; });
    assert.equal(result.status, 'declined'); assert.equal(asks, afterPreview ? 2 : 1);
    const db = openConnection(f.databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memories'").get(), undefined);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entries').get<{ n: number }>()?.n, 0); db.close();
  }
});

test('native approved revision survives restart, recalls context, retains failed and successful attempts', async t => {
  const f = await fixture(t, '1.0.0'); const questions: ReviewQuestion[] = [];
  const receipt = await runNativeReplayReview(f.input, async q => {
    questions.push(q);
    return { questionId: q.id, choice: q.phase === 'organize' ? 'organize' : q.revision === 1 ? 'revise' : 'approve', ...(q.phase === 'review' && q.revision === 1 ? { comment: 'Migration retry check passed; overall task still needs deployment validation.' } : {}) };
  });
  assert.equal(receipt.status, 'saved'); assert.equal(questions.length, 3);
  const db = openConnection(f.databasePath); t.after(() => db.close());
  const stored = createApprovedReplayMemoryStore(db, f.workspace).query('migration retry');
  assert.equal(stored.length, 1); assert.equal(stored[0]?.revision, 2);
  assert.equal(stored[0]?.attempts[0]?.outcome, 'failed'); assert.equal(stored[0]?.attempts[1]?.outcome, 'succeeded');
  assert.equal(stored[0]?.findings.length, 1); assert.equal(stored[0]?.findings[0]?.basis, 'user_corrected');
  assert.ok(questions[2]?.text.includes(JSON.stringify(stored[0], null, 2)));
  assert.equal(createApprovedReplayMemoryStore(db, 'foreign').query('migration').length, 0);
  assert.equal(createApprovedReplayMemoryStore(db, f.workspace).query('unrelated').length, 0);
  const recalled = await memoryContext(db, { cwd: f.input.cwd, query: 'migration retry' });
  assert.match(JSON.stringify(recalled.entries), /deployment validation/);
  const count = db.prepare('SELECT count(*) AS n FROM entries').get();
  createApprovedReplayMemoryStore(db, f.workspace).save(stored[0]!, receipt.approvalKey!);
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM entries').get(), count);
});

test('tag-only and empty recall remain available after an approved save', async t => {
  const f = await fixture(t);
  const receipt = await runNativeReplayReview(f.input, async q => ({ questionId: q.id,
    choice: q.phase === 'organize' ? 'organize' : 'approve' }));
  assert.equal(receipt.status, 'saved');
  const db = openConnection(f.databasePath); t.after(() => db.close());
  const tagged = await memoryContext(db, { cwd: f.input.cwd, tags: ['typescript'] });
  assert.equal(tagged.available, true, JSON.stringify(tagged));
  assert.equal(tagged.entries.length, 1);
  assert.equal(tagged.entries[0]?.kind, 'reviewed_replay');
  assert.equal((await memoryContext(db, { cwd: f.input.cwd, tags: ['unrelated'] })).entries.length, 0);
  const empty = await memoryContext(db, { cwd: f.input.cwd, sessionId: f.input.sessionId });
  assert.equal(empty.available, true, JSON.stringify(empty));
  assert.equal(empty.entries.length, 0, 'an empty query must not recall every approved experience');
});

test('injected recall distinguishes recorded failures, success, user corrections and current applicability', async t => {
  const f = await fixture(t);
  const condition = 'Use retry only for transient SQLITE_BUSY; reproduce the current lock before applying it.';
  const receipt = await runNativeReplayReview(f.input, async q => ({ questionId: q.id,
    choice: q.phase === 'organize' ? 'organize' : q.revision === 1 ? 'revise' : 'approve',
    ...(q.phase === 'review' && q.revision === 1 ? { comment: condition } : {}) }));
  assert.equal(receipt.status, 'saved');
  const db = openConnection(f.databasePath); t.after(() => db.close());
  const context = await memoryContext(db, { cwd: f.input.cwd, query: 'migration retry' });
  const rendered = renderOpenCodeLearningContext(context)!;
  const entry = JSON.parse(rendered).entries[0];
  assert.equal(entry.findings[0].text, condition);
  assert.equal(entry.findings[0].basis, 'user_corrected');
  assert.deepEqual(entry.findings[0].evidenceRefs, []);
  assert.equal(entry.findings[0].evidenceStatus, 'not_provided');
  assert.deepEqual(entry.attempts.map((a: { outcome: string; exitCode: number; taskBinding: string }) =>
    [a.outcome, a.exitCode, a.taskBinding]), [['failed', 1, 'unassigned'], ['succeeded', 0, 'unassigned']]);
  assert.equal(entry.source.traces[0].eventsSha256.length, 64);
  assert.equal(entry.verification, 'user_reviewed_not_task_verified');
  assert.equal(entry.currentApplicability, 'unverified');
  assert.ok(!rendered.includes('retry passes'), 'raw command output is not injected');
  assert.ok(rendered.length <= 5000);
});

test('injected references retain their evidence boundaries and exclude stale, foreign and unapproved memories', async t => {
  const f = await fixture(t);
  const receipt = await runNativeReplayReview(f.input, async q => ({ questionId: q.id,
    choice: q.phase === 'organize' ? 'organize' : 'approve' }));
  assert.equal(receipt.status, 'saved');
  const db = openConnection(f.databasePath); t.after(() => db.close());
  const injected = async (cwd = f.input.cwd) => JSON.parse(renderOpenCodeLearningContext(
    await memoryContext(db, { cwd, query: 'migration retry' }))!).entries;
  const entry = (await injected())[0];
  assert.equal(entry.findings[0].basis, 'observed');
  assert.equal(entry.findings[0].evidenceStatus, 'recorded_attempts');
  assert.deepEqual(entry.findings[0].evidenceRefs, [entry.attempts[0].callRef, entry.attempts[0].resultRef]);
  assert.equal(entry.currentApplicability, 'unverified', 'historical exit zero is not current applicability');
  const other = path.join(f.input.cwd, 'other-repository'); execFileSync('git', ['init', '-q', other]);
  await resolveProjectWorkspace(db, other);
  assert.deepEqual(await injected(other), []);
  const count = db.prepare('SELECT count(*) AS n FROM entries').get();
  await runNativeReplayReview({ ...f.input, taskId: 'unapproved' }, async q => ({ questionId: q.id, choice: 'decline' }));
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM entries').get(), count);
  const { updateCandidateEntry } = await import('../../src/memory/entries.js');
  const indexed = db.prepare('SELECT id FROM entries WHERE workspace=?').get<{ id: string }>(f.workspace)!;
  updateCandidateEntry(db, { workspace: f.workspace, entryId: indexed.id, expectedRevision: 1,
    kind: 'lesson', title: 'Withdraw the old retry advice', body: 'The current source contradicts the historical advice.' });
  assert.deepEqual(await injected(), []);
});

test('abort during review, stale reply and changed source fail safely without a save', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const receipt = await runNativeReplayReview(f.input, async q => {
    if (q.phase === 'review') controller.abort();
    return { questionId: q.id, choice: q.phase === 'organize' ? 'organize' : 'approve' };
  }, controller.signal);
  assert.equal(receipt.status, 'declined');
  assert.equal((await runNativeReplayReview(f.input, async () => ({ questionId: 'wrong', choice: 'approve' }))).status, 'declined');
  writeFileSync(path.join(f.input.traceDirectory, 'events.jsonl'), readFileSync(path.join(f.input.traceDirectory, 'events.jsonl'), 'utf8') + '{}\n');
  assert.equal((await runNativeReplayReview(f.input, async q => ({ questionId: q.id, choice: 'organize' }))).status, 'unavailable');
  const db = openConnection(f.databasePath, { readOnly: true }); t.after(() => db.close());
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memories'").get(), undefined);
});

test('packaged native Node worker completes actual IPC approval and commits only its displayed revision', async t => {
  const f = await fixture(t);
  const { runNativeReviewWorker } = await import(new URL('../../dist/opencode/tui.js', import.meta.url).href);
  const questions: ReviewQuestion[] = [];
  const receipt = await runNativeReviewWorker(f.input, process.execPath, async (question: ReviewQuestion) => {
    questions.push(question);
    const check = openConnection(f.databasePath, { readOnly: true });
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 0); check.close();
    return { questionId: question.id, choice: question.phase === 'organize' ? 'organize' : 'approve' };
  }, new AbortController().signal);
  assert.equal(receipt.status, 'saved'); assert.equal(questions.length, 2);
  const db = openConnection(f.databasePath, { readOnly: true }); t.after(() => db.close());
  const stored = createApprovedReplayMemoryStore(db, f.workspace).query('migration');
  assert.equal(stored.length, 1); assert.ok(questions[1]?.text.includes(JSON.stringify(stored[0], null, 2)));
});

test('native IPC retains the approved revision before commit and refuses to write when retention fails', async t => {
  const f = await fixture(t);
  const { runNativeReviewWorker } = await import(new URL('../../dist/opencode/tui.js', import.meta.url).href);
  let retained = 0;
  const receipt = await runNativeReviewWorker(f.input, process.execPath,
    async (question: ReviewQuestion) => ({ questionId: question.id, choice: question.phase === 'organize' ? 'organize' : 'approve' }),
    new AbortController().signal, (recovery: import('../../src/opencode/replay-review-worker.js').ApprovedReplayRecovery) => {
      retained++;
      assert.equal(recovery.proposal.source.taskId, f.input.taskId);
      assert.match(recovery.approvalKey, /^[a-f0-9]{64}$/u);
      const db = openConnection(f.databasePath, { readOnly: true });
      try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()?.n, 0); }
      finally { db.close(); }
      throw new Error('host retention failed');
    });
  assert.equal(retained, 1);
  assert.equal(receipt.status, 'unavailable');
  const db = openConnection(f.databasePath, { readOnly: true }); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()?.n, 0);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memories'").get(), undefined);
});

test('purging or revising the indexed entry cannot resurrect the approved replay mirror', async t => {
  const f = await fixture(t);
  const receipt = await runNativeReplayReview(f.input, async q => ({ questionId: q.id, choice: q.phase === 'organize' ? 'organize' : 'approve' }));
  assert.equal(receipt.status, 'saved');
  const db = openConnection(f.databasePath); t.after(() => db.close());
  const store = createApprovedReplayMemoryStore(db, f.workspace);
  const proposal = store.query('migration')[0]!;
  const entry = db.prepare('SELECT id FROM entries WHERE workspace=?').get<{ id: string }>(f.workspace)!;
  const { purgeEntry } = await import('../../src/commands/purge.js');
  purgeEntry(db, { workspace: f.workspace, entryId: entry.id, confirm: true });
  assert.equal(store.query('migration').length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replay_memories').get<{n:number}>()?.n, 0);
  assert.throws(() => store.save(proposal, receipt.approvalKey!), /approval_retired/);
});

test('Stop while acquiring the save database prevents a late approved revision from committing', async t => {
  const f = await fixture(t); const db = openConnection(f.databasePath); t.after(() => db.close());
  const { LedgerStore } = await import('../../src/ledger/store.js');
  const { createMcpReplayReview } = await import('../../src/mcp/replay-review.js');
  const ledger = new LedgerStore(db);
  ledger.createRunInTransaction({ runId: 'terminal', workspace: f.workspace, protocolVersion: '1', client: { kind: 'opencode', sessionId: 'session-1' }, captureProfile: 'minimal', coverage: { run: 'best_effort', tool: 'declared', command: 'declared', file: 'declared', approval: 'unavailable' }, task: { title: 'Check migration', query: 'Check migration', profileHints: { taskType: null, target: null, expected: null, constraints: null } }, metadata: { intakeRequired: false } });
  ledger.updateRunStatusInTransaction('terminal', 'completed');
  let prompts = 0, connections = 0; let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(r => entered = r); const wait = new Promise<void>(r => release = r);
  const server = { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async () => ({ action: 'accept', content: { choice: ++prompts === 1 ? 'organize' : 'approve' } }) } };
  const review = createMcpReplayReview(server as any, async fn => { if (++connections === 2) { entered(); await wait; } return fn(db); });
  const controller = new AbortController();
  const running = review.review({ runId: 'terminal', cwd: f.input.cwd, traceDirectory: f.input.traceDirectory }, controller.signal);
  await pending; controller.abort(); release();
  assert.notEqual((await running).status, 'saved'); await new Promise(r => setImmediate(r));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 0);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memories'").get(), undefined);
});

test('native recovery retains the approved identity and only reconciles that revision without another dialog or write', async t => {
  const f = await fixture(t);
  let approved!: import('../../src/opencode/replay-review-worker.js').ApprovedReplayRecovery;
  const receipt = await runNativeReplayReview(f.input, async q => ({ questionId: q.id, choice: q.phase === 'organize' ? 'organize' : 'approve' }), undefined,
    (proposal, approvalKey) => { approved = { proposal, approvalKey }; });
  assert.equal(receipt.status, 'saved');
  const recovered = await runNativeReplayReview({ ...f.input, approvedRecovery: approved }, async () => { throw Error('recovery must not ask again'); });
  assert.equal(recovered.status, 'saved'); assert.equal(recovered.approvalKey, approved.approvalKey);
  const db = openConnection(f.databasePath); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 1);
  const missing = { proposal: approved.proposal, approvalKey: 'a'.repeat(64) };
  const unknown = await runNativeReplayReview({ ...f.input, approvedRecovery: missing }, async () => { throw Error('unknown receipt cannot regenerate'); });
  assert.equal(unknown.status, 'unavailable'); assert.equal(unknown.approvalKey, missing.approvalKey);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 1);
});

test('MCP adapter retries the retained approval after a lost save acknowledgement without duplicate entry or approval', async t => {
  const f = await fixture(t); const db = openConnection(f.databasePath); t.after(() => db.close());
  const { LedgerStore } = await import('../../src/ledger/store.js');
  const { createMcpReplayReview } = await import('../../src/mcp/replay-review.js');
  const ledger = new LedgerStore(db);
  ledger.createRunInTransaction({ runId: 'uncertain', workspace: f.workspace, protocolVersion: '1', client: { kind: 'opencode', sessionId: 'session-1' }, captureProfile: 'minimal', coverage: { run: 'best_effort', tool: 'declared', command: 'declared', file: 'declared', approval: 'unavailable' }, task: { title: 'Check migration', query: 'Check migration', profileHints: { taskType: null, target: null, expected: null, constraints: null } }, metadata: { intakeRequired: false } });
  ledger.updateRunStatusInTransaction('uncertain', 'completed');
  let prompts = 0, connections = 0;
  const server = { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async () => ({ action: 'accept', content: { choice: ++prompts === 1 ? 'organize' : 'approve' } }) } };
  const review = createMcpReplayReview(server as any, async fn => { const n = ++connections; const result = await fn(db); if (n === 2) throw Error('lost save acknowledgement'); return result; });
  const input = { runId: 'uncertain', cwd: f.input.cwd, traceDirectory: f.input.traceDirectory };
  const uncertain = await review.review(input); assert.equal(uncertain.status, 'unavailable'); assert.match(uncertain.approvalKey!, /^[a-f0-9]{64}$/u);
  const recovered = await review.review(input); assert.equal(recovered.status, 'saved'); assert.equal(recovered.approvalKey, uncertain.approvalKey);
  assert.equal(prompts, 2); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 1);
});
