import assert from 'node:assert/strict';
import test from 'node:test';
import { extractOpenCodeCompactionSummary } from '../../src/opencode/plugin.js';

test('only a completed text compaction produces a stable summary identity', () => {
  const messages = [
    { type: 'compaction', id: 'msg_old', status: 'completed', summary: 'old' },
    { type: 'compaction', id: 'msg_new', status: 'completed', summary: '  readable summary  ' },
  ];
  const original = structuredClone(messages);
  assert.deepEqual(extractOpenCodeCompactionSummary(messages), { id: 'msg_new', summary: 'readable summary' });
  assert.deepEqual(messages, original);
});

test('opaque, incomplete, and oversized compactions cannot be saved as summaries', () => {
  for (const messages of [
    [],
    [{ type: 'compaction', id: 'opaque', status: 'completed', providerState: { checkpoint: 'opaque' } }],
    [{ type: 'compaction', id: 'pending', status: 'running', summary: 'partial' }],
    [{ type: 'compaction', id: 'empty', status: 'completed', summary: '  ' }],
    [{ type: 'compaction', id: 'large', status: 'completed', summary: 'x'.repeat(64 * 1024 + 1) }],
  ]) assert.equal(extractOpenCodeCompactionSummary(messages), null);
});
