import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOpenCodeEvent } from '../../src/opencode/events.js';

test('normalizes a session.idle event into an allowlisted envelope', () => {
  const event = {
    type: 'session.idle',
    properties: { sessionID: 'ses_123', ignored: 'not forwarded' },
  };
  const normalized = normalizeOpenCodeEvent({ event, directory: '/repo' });
  assert.deepEqual(normalized, {
    kind: 'session.idle',
    sessionId: 'ses_123',
    directory: '/repo',
    eventIdentity: 'session.idle:ses_123',
    capabilityEvidence: { adapter: 'opencode', continuation: 'session_idle' },
    terminalEvidence: { eventType: 'session.idle' },
  });
  assert.deepEqual(event, {
    type: 'session.idle',
    properties: { sessionID: 'ses_123', ignored: 'not forwarded' },
  });
});

test('rejects malformed, unsupported, and secret-shaped events before effects', () => {
  assert.throws(
    () => normalizeOpenCodeEvent({ event: { type: 'session.idle', properties: {} }, directory: '/repo' }),
    /sessionID/iu,
  );
  assert.throws(
    () => normalizeOpenCodeEvent({ event: { type: 'session.created', properties: {} }, directory: '/repo' }),
    /unsupported|malformed/iu,
  );
  assert.throws(
    () => normalizeOpenCodeEvent({ event: { type: 'session.idle', properties: { sessionID: 'sk-1234567890123456' } }, directory: '/repo' }),
    /secret/iu,
  );
});
