import assert from 'node:assert/strict';
import test from 'node:test';
import { requireIdempotencyKey } from '../../src/server/routes/agent-runs.js';

function request(value: string): Parameters<typeof requireIdempotencyKey>[0] {
  return {
    method: 'POST',
    url: new URL('http://127.0.0.1/api/v1/agent/runs'),
    headers: { 'idempotency-key': value },
    rawHeaders: ['Idempotency-Key', value],
  };
}

test('server preserves an exact idempotency key and rejects wire-normalized whitespace', () => {
  assert.equal(requireIdempotencyKey(request('exact-key')), 'exact-key');
  for (const value of [' leading', 'trailing ', '\tkey', 'key\t']) {
    assert.throws(
      () => requireIdempotencyKey(request(value)),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
    );
  }
});
