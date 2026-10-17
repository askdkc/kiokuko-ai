import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractReplayProposal } from '../../src/memory/replay-extract.js';

for (const shape of ['long-request-history', 'many-request-messages', 'long-single-message', 'native-user-messages'] as const) {
  test(`replay proposal retains the latest public constraint in ${shape}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'replay-request-'));
    try {
      const traceDirectory = path.join(root, '.agenticreplay', 'runs', 'run_abcdef');
      mkdirSync(traceDirectory, { recursive: true });
      const constraint = 'Never modify upstream DSH; keep the repair in plugin code.';
      const count = shape === 'long-single-message' ? 1 : ['many-request-messages', 'native-user-messages'].includes(shape) ? 24 : 4;
      const messages = Array.from({ length: count }, (_, i) => ({ role: 'user',
        content: i === count - 1 ? (shape === 'long-single-message' ? 'Earlier request context. '.repeat(250) + constraint : constraint) : `Request ${i}: ` + 'Inspect parser behavior. '.repeat(shape === 'long-request-history' ? 65 : 2) }));
      const events = (shape === 'native-user-messages'
        ? messages.map((m, i) => JSON.stringify({ seq: i + 1, type: 'user.message', payload: { text: m.content } })).join('\n')
        : JSON.stringify({ seq: 1, type: 'model.request', payload: { messages } })) + '\n';
      writeFileSync(path.join(traceDirectory, 'events.jsonl'), events);
      writeFileSync(path.join(traceDirectory, 'manifest.json'), JSON.stringify({ schema_version: '0.4.0', run_id: 'run_abcdef', cwd: root,
        integrity: { events_sha256: createHash('sha256').update(events).digest('hex') } }));
      const p = await extractReplayProposal({ cwd: root, traceDirectory, taskId: 'task', sessionId: 'session', workspace: 'repo' });
      assert.ok(p.request.text.includes(constraint), 'the latest constraint must reach the human review preview');
      assert.ok(p.request.text.length <= 4096);
      assert.ok(p.keywords.includes('upstream'));
      assert.ok(p.source.traces[0]?.gaps.some(gap => /request.*omitted|request.*truncated/i.test(gap)), 'bounded omissions must be disclosed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
