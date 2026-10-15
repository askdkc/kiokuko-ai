import test from 'node:test';
import assert from 'node:assert/strict';
import type { Plugin } from '@opencode/plugin/tui';
import { registerNativeReplayReview, askNativeReplayQuestion } from '../../src/opencode/tui.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';
import { OPENCODE_HOOK_PROTOCOL_VERSION } from '../../src/opencode/hook-protocol.js';
import { readFileSync } from 'node:fs';
import type { ReviewQuestion } from '../../src/memory/replay-review.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  let listener: ((input: { details: unknown }) => void) | undefined;
  let sessionId = 'session-1';
  let messages: unknown[] = [
    { type: 'user', id: 'request-1', text: 'Fix startup', time: { created: 1 } },
    { type: 'assistant', id: 'answer-1', finish: 'stop', content: [{ type: 'text', text: 'Fixed and tested startup.' }], time: { completed: 2 } },
    { type: 'idle', outcome: 'succeeded' },
  ];
  const shown: string[] = [];
  const choices = ['revise', 'approve'];
  const ctx = {
    options: { protocolVersion: OPENCODE_HOOK_PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION, nodeExecutable: process.execPath, cliScript: '/repo/dist/bin/kiokuko.js' },
    location: { directory: '/repo' },
    data: { listen: (fn: typeof listener) => { listener = fn; return () => { listener = undefined; }; }, session: { pending: { list: () => [] } } },
    client: { session: { get: async () => ({ id: sessionId, location: { directory: '/repo' } }), context: async () => messages } },
    ui: { router: { current: () => ({ type: 'session', sessionID: sessionId }) }, toast: { show: () => undefined },
      dialog: { confirm: async ({ message }: { message: string }) => { shown.push(message); return true; },
        alert: async ({ message }: { message: string }) => { shown.push(message); },
        select: async () => choices.shift(), prompt: async () => 'Use the revised finding.' } },
  } as unknown as Plugin.Context;
  return { ctx, shown, choices, emit(type: string, id = 'event-1') { listener?.({ details: { id, type, data: { sessionID: sessionId } } }); }, setMessages(value: unknown[]) { messages = value; }, navigate(id: string) { sessionId = id; } };
}

test('package exposes the native host resolver TUI subpath', () => {
  const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.exports['./tui'].import, './dist/opencode/tui.js');
  // The installed host resolver independently identifies package /tui as its supported entrypoint.
  const host = readFileSync(new URL('../../node_modules/@opencode/plugin/dist/host.js', import.meta.url), 'utf8');
  assert.match(host, /tui: entry\(\["tui"\]\)/u);
});

test('native dialog displays the exact revision, comments and close never approve', async () => {
  const f = fixture();
  const q: ReviewQuestion = { id: 'q-1', phase: 'review', revision: 1, digest: 'abc', text: 'Exact proposed content with its provenance' };
  assert.deepEqual(await askNativeReplayQuestion(f.ctx, q), { questionId: 'q-1', choice: 'revise', comment: 'Use the revised finding.' });
  assert.equal(f.shown[0], q.text);
  assert.deepEqual(await askNativeReplayQuestion(f.ctx, { ...q, id: 'q-2', revision: 2 }), { questionId: 'q-2', choice: 'approve' });
  assert.deepEqual(await askNativeReplayQuestion(f.ctx, q), { questionId: 'q-1', choice: 'decline' });
});

test('successful final idle offers once per request; tool turns and duplicate events do not', async t => {
  const previous = process.env.AGENTICREPLAY_RUN_DIR; process.env.AGENTICREPLAY_RUN_DIR = '/repo/.agenticreplay/runs/run_123456';
  t.after(() => { if (previous === undefined) delete process.env.AGENTICREPLAY_RUN_DIR; else process.env.AGENTICREPLAY_RUN_DIR = previous; });
  const f = fixture(); let calls = 0;
  const cleanup = await registerNativeReplayReview(f.ctx, async input => { calls++; assert.equal(input.taskId, 'request-1'); return { status: 'declined', workMayContinue: true }; });
  t.after(cleanup);
  f.emit('session.execution.succeeded'); await tick();
  f.emit('session.execution.succeeded', 'event-2'); await tick();
  assert.equal(calls, 1);
  f.setMessages([{ type: 'user', id: 'request-2' }, { type: 'assistant', finish: 'tool-calls', content: [], time: { completed: 3 } }, { type: 'idle', outcome: 'succeeded' }]);
  f.emit('session.execution.succeeded', 'event-3'); await tick(); assert.equal(calls, 1);
});

test('native Stop and new execution abort pending review and ignore a late human response', async t => {
  const previous = process.env.AGENTICREPLAY_RUN_DIR; process.env.AGENTICREPLAY_RUN_DIR = '/repo/.agenticreplay/runs/run_123456';
  t.after(() => { if (previous === undefined) delete process.env.AGENTICREPLAY_RUN_DIR; else process.env.AGENTICREPLAY_RUN_DIR = previous; });
  for (const event of ['session.execution.interrupted', 'session.execution.started']) {
    const f = fixture(); let signal: AbortSignal | undefined;
    let resolve!: () => void;
    const cleanup = await registerNativeReplayReview(f.ctx, async (_input, _runtime, _ask, abort) => { signal = abort; await new Promise<void>(r => { resolve = r; }); return { status: 'declined', workMayContinue: true }; });
    f.emit('session.execution.succeeded'); await tick();
    assert.equal(signal?.aborted, false); f.emit(event); assert.equal(signal?.aborted, true);
    resolve(); cleanup(); await tick();
  }
});

test('native review includes failed terminal tasks and defers to an already queued MCP review', async t => {
  const previous = process.env.AGENTICREPLAY_RUN_DIR; process.env.AGENTICREPLAY_RUN_DIR = '/repo/.agenticreplay/runs/run_123456';
  t.after(() => { if (previous === undefined) delete process.env.AGENTICREPLAY_RUN_DIR; else process.env.AGENTICREPLAY_RUN_DIR = previous; });
  const f = fixture(); let calls = 0;
  const cleanup = await registerNativeReplayReview(f.ctx, async input => { calls++; assert.equal(input.taskOutcome, 'failed'); return { status: 'declined', workMayContinue: true }; });
  t.after(cleanup);
  f.setMessages([{ type: 'user', id: 'failed-task' }, { type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'Tests failed; task ended.' }], time: { completed: 3 } }, { type: 'idle', outcome: 'failed' }]);
  f.emit('session.execution.failed'); await tick(); assert.equal(calls, 1);
  f.setMessages([{ type: 'user', id: 'queued-task' }, { type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'Done.' }, { type: 'tool', name: 'kiokuko_memory_checkpoint', state: { status: 'completed', content: [{ type: 'text', text: JSON.stringify({ memoryReview: { status: 'queued' } }) }] } }], time: { completed: 4 } }, { type: 'idle', outcome: 'succeeded' }]);
  f.emit('session.execution.succeeded'); await tick(); assert.equal(calls, 1);
});

test('TUI retry keeps the already-approved identity after an unavailable save instead of extracting another proposal', async t => {
  const previous = process.env.AGENTICREPLAY_RUN_DIR; process.env.AGENTICREPLAY_RUN_DIR = '/repo/.agenticreplay/runs/run_123456';
  t.after(() => { if (previous === undefined) delete process.env.AGENTICREPLAY_RUN_DIR; else process.env.AGENTICREPLAY_RUN_DIR = previous; });
  const f = fixture(); let calls = 0;
  const recovery = { proposal: { proposalId: 'exact-approved', revision: 2 } as any, approvalKey: 'a'.repeat(64) };
  const cleanup = await registerNativeReplayReview(f.ctx, async (input, _node, _ask, _signal, onApproved) => {
    calls++;
    if (calls === 1) { assert.equal(input.approvedRecovery, undefined); onApproved?.(recovery); return { status: 'unavailable', workMayContinue: true, approvalKey: recovery.approvalKey }; }
    assert.deepEqual(input.approvedRecovery, recovery);
    return { status: 'saved', workMayContinue: true, approvalKey: recovery.approvalKey };
  });
  t.after(cleanup);
  f.emit('session.execution.succeeded'); await tick();
  f.emit('session.execution.succeeded', 'retry'); await tick();
  f.emit('session.execution.succeeded', 'duplicate'); await tick();
  assert.equal(calls, 2);
});
