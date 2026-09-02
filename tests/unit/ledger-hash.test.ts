import assert from 'node:assert/strict';
import assertStrict from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, hashLedgerEvent, GENESIS_HASH } from '../../src/ledger/hash.js';
import { sanitizeEvent } from '../../src/ledger/redaction.js';

const options = { workspace: '/tmp/workspace', home: '/home/tester' };

test('canonical JSON and event hashes are stable across object insertion order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  const first = hashLedgerEvent({
    runId: 'run-1', sequence: 1, eventId: 'event-1', previousHash: GENESIS_HASH,
    eventType: 'tool.completed', actor: 'agent', payload: { a: 1, b: 2 }, redaction: [],
  });
  const second = hashLedgerEvent({
    runId: 'run-1', sequence: 1, eventId: 'event-1', previousHash: GENESIS_HASH,
    eventType: 'tool.completed', actor: 'agent', payload: { b: 2, a: 1 }, redaction: [],
  });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('hash chain changes with sequence and previous hash', () => {
  const first = hashLedgerEvent({ runId: 'run-1', sequence: 1, eventId: 'event-1', previousHash: GENESIS_HASH, eventType: 'run.started', actor: 'agent', payload: {}, redaction: [] });
  const second = hashLedgerEvent({ runId: 'run-1', sequence: 2, eventId: 'event-2', previousHash: first, eventType: 'tool.completed', actor: 'agent', payload: {}, redaction: [] });
  assert.notEqual(first, second);
  assert.notEqual(second, hashLedgerEvent({ runId: 'run-1', sequence: 2, eventId: 'event-2', previousHash: GENESIS_HASH, eventType: 'tool.completed', actor: 'agent', payload: {}, redaction: [] }));
});

test('hash input uses the sanitized snapshot and never the raw secret', () => {
  const raw = 'ghp_123456789012345678901234';
  const sanitized = sanitizeEvent({ eventType: 'tool.completed', actor: 'agent', payload: { message: raw } }, options);
  const stored = sanitized.value as unknown as { payload: { message: string } };
  const digest = hashLedgerEvent({ runId: 'run-1', sequence: 1, eventId: 'event-1', previousHash: GENESIS_HASH, eventType: 'tool.completed', actor: 'agent', payload: stored.payload, redaction: sanitized.redactions });
  assertStrict.equal(JSON.stringify(stored).includes(raw), false);
  assertStrict.equal(digest, hashLedgerEvent({ runId: 'run-1', sequence: 1, eventId: 'event-1', previousHash: GENESIS_HASH, eventType: 'tool.completed', actor: 'agent', payload: stored.payload, redaction: sanitized.redactions }));
  assertStrict.notEqual(digest, hashLedgerEvent({ runId: 'run-1', sequence: 1, eventId: 'event-1', previousHash: GENESIS_HASH, eventType: 'tool.completed', actor: 'agent', payload: { message: raw }, redaction: [] }));
});
