import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBearerAuthorization } from '../../src/server/auth.js';

const token = 'a'.repeat(64);

test('accepts one exact bearer authorization header', () => {
  assert.equal(requireBearerAuthorization(`Bearer ${token}`, token), undefined);
});

test('rejects a missing authorization header with an empty authentication error', () => {
  assert.throws(() => requireBearerAuthorization(undefined, token), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'AUTHENTICATION_ERROR');
    assert.equal((error as { exitCode: number }).exitCode, 7);
    assert.deepEqual((error as { details: Record<string, unknown> }).details, {});
    return true;
  });
});

test('rejects multiple authorization header values', () => {
  const header = [`Bearer ${token}`];

  assert.throws(() => requireBearerAuthorization(header, token), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'AUTHENTICATION_ERROR');
    assert.deepEqual((error as { details: Record<string, unknown> }).details, {});
    assert.equal((error as Error).message.includes(JSON.stringify(header)), false);
    return true;
  });
});

test('rejects malformed or mismatched authorization strings without exposing header material', () => {
  const invalidHeaders = [
    '',
    'Basic credentials',
    'Bearer',
    'Bearer ',
    `Bearer ${token} extra`,
    `Bearer ${token}\n`,
    `Bearer ${token.toUpperCase()}`,
    `Bearer ${'g'.repeat(64)}`,
    `Bearer ${'a'.repeat(63)}`,
    `Bearer ${'a'.repeat(65)}`,
    `Bearer ${'b'.repeat(64)}`,
    null,
  ];

  for (const header of invalidHeaders) {
    assert.throws(() => requireBearerAuthorization(header, token), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'AUTHENTICATION_ERROR');
      assert.deepEqual((error as { details: Record<string, unknown> }).details, {});
      if (header !== '') {
        assert.equal((error as Error).message.includes(String(header)), false);
        assert.equal(JSON.stringify((error as { details: Record<string, unknown> }).details).includes(String(header)), false);
      }
      return true;
    });
  }
});

test('rejects an invalid expected server token as a token-free integrity error', () => {
  const invalidExpectedToken = 'not-a-lowercase-hex-token';

  assert.throws(() => requireBearerAuthorization(`Bearer ${token}`, invalidExpectedToken), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'INTEGRITY_ERROR');
    assert.equal((error as { exitCode: number }).exitCode, 8);
    assert.equal((error as Error).message.includes(invalidExpectedToken), false);
    assert.deepEqual((error as { details: Record<string, unknown> }).details, {});
    assert.equal(JSON.stringify((error as { details: Record<string, unknown> }).details).includes(token), false);
    return true;
  });
});
