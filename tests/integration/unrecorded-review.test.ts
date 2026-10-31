import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { openConnection } from '../../src/db/connection.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { memoryContext } from '../../src/memory/learning.js';

const draft = {
  title: 'Safe explicit removal',
  request: 'Create a safe removal path for installed skills.',
  body: 'Remove only byte-identical files. Preserve edited files. Focused tests passed; end-to-end remains unverified.',
  tags: ['setup', 'removal'],
  keywords: ['retireStandardSkills'],
  sourceNotes: ['Working tree and reported test results; no recording was made.'],
};

async function fixture(t: { after(fn: () => Promise<void> | void): void }, choices: Array<'organize' | 'approve' | 'decline' | 'revise'>, supportsElicitation = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-no-replay-'));
  execFileSync('git', ['init', '-q', root]);
  const databasePath = path.join(root, 'memory.sqlite');
  await initializeDatabase({ databasePath });
  const server = createKiokukoMcpServer({ databasePath });
  const client = new Client({ name: 'human-ui-host', version: '1' }, supportsElicitation ? { capabilities: { elicitation: { form: {} } } } : {});
  const prompts: string[] = [];
  if (supportsElicitation) client.setRequestHandler(ElicitRequestSchema, async req => {
    prompts.push(req.params.message);
    const db = openConnection(databasePath, { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 0, 'nothing may be saved before native approval'); } finally { db.close(); }
    return { action: 'accept', content: { choice: choices.shift() ?? 'decline' } };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, databasePath, client, prompts };
}

test('no-log MCP review asks the human and saves the exact approved project memory without a task run', async t => {
  const f = await fixture(t, ['organize', 'approve']);
  const input = { cwd: f.root, requestId: 'standalone-review-1', draft };
  const result = await f.client.callTool({ name: 'memory_review_unrecorded', arguments: input });
  assert.equal((result.structuredContent as any)?.status, 'saved', JSON.stringify(result));
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[0]!, /AgenticReplay/i);
  assert.match(f.prompts[0]!, /without|no recording/i);
  for (const text of [draft.title, draft.request, draft.body, draft.sourceNotes[0]!]) assert.ok(f.prompts[1]!.includes(text), text);
  const db = openConnection(f.databasePath); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 1);
  const recalled = await memoryContext(db, { cwd: f.root, query: 'retireStandardSkills' });
  assert.equal(recalled.entries.length, 1, JSON.stringify(recalled));
  const memory = recalled.entries[0] as any;
  assert.equal(memory.kind, 'reviewed_unrecorded');
  assert.equal(memory.source.kind, 'unrecorded');
  assert.deepEqual(memory.source.traces, []);
  assert.match(JSON.stringify(memory.source), /AgenticReplay/i);
  assert.equal(memory.verification, 'user_reviewed_not_task_verified');
  const again = await f.client.callTool({ name: 'memory_review_unrecorded', arguments: input });
  assert.equal((again.structuredContent as any)?.status, 'saved');
  assert.equal(f.prompts.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 1);
});

test('decline at either native prompt and unavailable native UI never create memory', async t => {
  for (const [choices, supports] of [[['decline'], true], [['organize', 'decline'], true], [[], false]] as Array<[Array<'organize' | 'decline'>, boolean]>) {
    const f = await fixture(t, choices, supports);
    const result = await f.client.callTool({ name: 'memory_review_unrecorded', arguments: { cwd: f.root, requestId: 'decline-1', draft } });
    assert.equal((result.structuredContent as any)?.status, supports ? 'declined' : 'unavailable', JSON.stringify(result));
    if (!supports) assert.equal((result.structuredContent as any)?.reason, 'native_elicitation_unavailable');
    const db = openConnection(f.databasePath, { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 0); } finally { db.close(); }
  }
});

test('no-log draft cannot contain credentials or a model-supplied approval flag', async t => {
  const f = await fixture(t, ['organize', 'approve']);
  for (const badDraft of [ { ...draft, body: 'authorization: bearer abcdefghijklmnop1234' }, { ...draft, approved: true } ]) {
    const result = await f.client.callTool({ name: 'memory_review_unrecorded', arguments: { cwd: f.root, requestId: 'unsafe-1', draft: badDraft } });
    assert.notEqual((result.structuredContent as any)?.status, 'saved', JSON.stringify(result));
  }
  assert.equal(f.prompts.length, 0);
  const db = openConnection(f.databasePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 0); } finally { db.close(); }
});


test('the same review identity cannot reuse approval for changed draft or project', async t => {
  const f = await fixture(t, ['organize', 'approve']);
  const input = { cwd: f.root, requestId: 'bound-review', draft };
  assert.equal((await f.client.callTool({ name: 'memory_review_unrecorded', arguments: input }).then(r => r.structuredContent as any)).status, 'saved');
  const changed = await f.client.callTool({ name: 'memory_review_unrecorded', arguments: { ...input, draft: { ...draft, body: 'Different contents' } } });
  assert.notEqual((changed.structuredContent as any)?.status, 'saved');
  const otherProject = await f.client.callTool({ name: 'memory_review_unrecorded', arguments: { ...input, cwd: path.join(f.root, 'other') } });
  assert.notEqual((otherProject.structuredContent as any)?.status, 'saved');
  assert.equal(f.prompts.length, 2);
  const db = openConnection(f.databasePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 1); } finally { db.close(); }
});

test('unrecorded review reconciles a lost save acknowledgement without a second approval or write', async t => {
  const f = await fixture(t, []);
  const { createMcpUnrecordedReview, unrecordedReviewInputSchema } = await import('../../src/mcp/unrecorded-review.js');
  const db = openConnection(f.databasePath); t.after(() => db.close());
  let prompts = 0, connections = 0;
  const server = { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }),
    elicitInput: async () => ({ action: 'accept', content: { choice: ++prompts === 1 ? 'organize' : 'approve' } }) } };
  const review = createMcpUnrecordedReview(server as any, async fn => {
    const n = ++connections; const result = await fn(db);
    if (n === 2) throw Error('lost save acknowledgement');
    return result;
  });
  const input = unrecordedReviewInputSchema.parse({ cwd: f.root, requestId: 'uncertain', draft });
  const first = await review.review(input);
  assert.equal(first.status, 'unavailable');
  assert.match(first.approvalKey!, /^[a-f0-9]{64}$/u);
  const conflict = await review.review({ ...input, draft: { ...input.draft, body: 'Not the approved content' } });
  assert.equal(conflict.status, 'unavailable');
  const recovered = await review.review(input);
  assert.equal(recovered.status, 'saved');
  assert.equal(recovered.approvalKey, first.approvalKey);
  assert.equal(prompts, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 1);
});

test('Stop while the approved no-log review waits for its save prevents a late write', async t => {
  const f = await fixture(t, []);
  const { createMcpUnrecordedReview, unrecordedReviewInputSchema } = await import('../../src/mcp/unrecorded-review.js');
  const db = openConnection(f.databasePath); t.after(() => db.close());
  let prompts = 0, connections = 0; let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(r => entered = r); const wait = new Promise<void>(r => release = r);
  const server = { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }),
    elicitInput: async () => ({ action: 'accept', content: { choice: ++prompts === 1 ? 'organize' : 'approve' } }) } };
  const review = createMcpUnrecordedReview(server as any, async fn => { if (++connections === 2) { entered(); await wait; } return fn(db); });
  const controller = new AbortController();
  const running = review.review(unrecordedReviewInputSchema.parse({ cwd: f.root, requestId: 'stop-save', draft }), controller.signal);
  await pending; controller.abort(); release();
  assert.notEqual((await running).status, 'saved');
  await new Promise(r => setImmediate(r));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 0);
});


test('a native revision replaces the draft finding and needs a fresh approval', async t => {
  const f = await fixture(t, []); const prompts: string[] = [];
  f.client.setRequestHandler(ElicitRequestSchema, async req => {
    prompts.push(req.params.message);
    const db = openConnection(f.databasePath, { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n, 0); } finally { db.close(); }
    if (prompts.length === 1) return { action: 'accept', content: { choice: 'organize' } };
    if (prompts.length === 2) return { action: 'accept', content: { choice: 'revise', comment: 'Verify symlink behavior before applying this.' } };
    return { action: 'accept', content: { choice: 'approve' } };
  });
  const result = await f.client.callTool({ name: 'memory_review_unrecorded', arguments: { cwd: f.root, requestId: 'revised', draft: { ...draft, body: `${draft.body} discardedinterpretation` } } });
  assert.equal((result.structuredContent as any)?.status, 'saved', JSON.stringify(result));
  assert.equal(prompts.length, 3);
  assert.ok(prompts[1]!.includes(draft.body));
  assert.ok(prompts[2]!.includes('Verify symlink behavior before applying this.'));
  assert.ok(!prompts[2]!.includes(draft.body));
  const db = openConnection(f.databasePath); t.after(() => db.close());
  const recalled = await memoryContext(db, { cwd: f.root, query: 'symlink' });
  assert.equal(recalled.entries.length, 1, JSON.stringify(recalled));
  assert.equal((recalled.entries[0] as any).findings[0].basis, 'user_corrected');
  assert.equal((await memoryContext(db, { cwd: f.root, query: 'discardedinterpretation' })).entries.length, 0);
});
