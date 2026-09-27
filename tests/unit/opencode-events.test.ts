import assert from 'node:assert/strict';
import test from 'node:test';
import { v2EventSession } from '../../src/opencode/v2-adapter.js';

test('OpenCode v2 event envelope extracts session and repository location', () => {
  assert.deepEqual(v2EventSession({ id: 'evt_1', type: 'session.execution.succeeded',
    data: { sessionID: 'ses_1', outcome: 'succeeded' }, location: { directory: '/repo' } }),
  { id: 'evt_1', type: 'session.execution.succeeded', sessionId: 'ses_1', directory: '/repo' });
});

test('legacy properties envelope and missing event IDs cannot drive state transitions', () => {
  assert.equal(v2EventSession({ type: 'session.idle', properties: { sessionID: 'ses_1' } }), null);
  assert.equal(v2EventSession({ id: 'evt_1', type: 'session.execution.succeeded', data: {} }), null);
});
