import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAnswer, sanitizeEvent, sanitizeProfileHints, sanitizeTask } from '../../src/ledger/redaction.js';

const options = { workspace: '/tmp/kiokuko-workspace', home: '/home/alice' };
const secret = 'ghp_123456789012345678901234';

function json(value: unknown): string {
  return JSON.stringify(value);
}

test('recursively redacts sensitive keys and secret patterns before storage', () => {
  const result = sanitizeEvent({
    eventType: 'tool.completed',
    actor: 'agent',
    payload: {
      nested: { credentials: { apiKey: secret, normal: 'kept' } },
      message: `request failed with ${secret}`,
      authorization: 'Bearer very-secret-value-12345',
    },
  }, options);

  const stored = json(result.value);
  assert.equal(stored.includes(secret), false);
  assert.equal(stored.includes('very-secret-value-12345'), false);
  assert.equal((result.value as unknown as { payload: { nested: { credentials: { normal: string } } } }).payload.nested.credentials.normal, 'kept');
  assert.ok(result.redactions.length >= 2);
});

test('rejects secret material embedded in a dynamic JSON key without echoing it', () => {
  const rawSecretKey = 'password=super-secret-value-12345';

  assert.throws(() => sanitizeEvent({
    eventType: 'tool.completed',
    actor: 'agent',
    payload: { [rawSecretKey]: 'value' },
  }, options), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'SECURITY_REJECTION');
    assert.equal((error as Error).message.includes(rawSecretKey), false);
    assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(rawSecretKey), false);
    return true;
  });
});

test('strips URL userinfo, query, and fragment and normalizes workspace/home paths', () => {
  const result = sanitizeEvent({
    eventType: 'file.observed',
    actor: 'agent',
    payload: {
      url: 'https://alice:password@example.test/repo/file.ts?token=secret#private',
      path: '/tmp/kiokuko-workspace/src/file.ts',
      externalPath: '/home/alice/private/notes.txt',
    },
  }, options);

  const payload = (result.value as unknown as { payload: { url: string; path: string; externalPath: string } }).payload;
  assert.equal(payload.url, 'https://example.test/repo/file.ts');
  assert.equal(payload.path, 'src/file.ts');
  assert.equal(payload.externalPath, '<HOME>/private/notes.txt');
  assert.equal(json(payload).includes('password'), false);
  assert.equal(json(payload).includes('token=secret'), false);
});

test('omits non-allowlisted environment values and bounds stream previews', () => {
  const output = 'safe-output-'.repeat(1000);
  const result = sanitizeEvent({
    eventType: 'command.completed',
    actor: 'agent',
    payload: {
      env: { NODE_ENV: 'test', API_KEY: 'do-not-store-123456789', PATH: '/secret/bin' },
      stdout: output,
      stderr: 'short',
    },
  }, options);

  const payload = (result.value as unknown as { payload: { env: Record<string, string>; stdout: string; stderr: string } }).payload;
  assert.equal(payload.env.NODE_ENV, 'test');
  assert.equal('API_KEY' in payload.env, false);
  assert.equal('PATH' in payload.env, false);
  assert.ok(Buffer.byteLength(payload.stdout, 'utf8') <= 4096);
  assert.equal(payload.stderr, 'short');
  assert.equal(json(result.value).includes('do-not-store-123456789'), false);
  assert.ok(result.truncated.length >= 1);
});

test('task, profile hints, and answers are sanitized recursively without raw values', () => {
  const task = sanitizeTask({ title: 'Task', query: `password = hidden-secret-value-12345`, profileHints: { taskType: 'build', target: '/tmp/kiokuko-workspace/src/a.ts', expected: 'pass', constraints: null } }, options);
  const profile = sanitizeProfileHints({ taskType: 'build', target: '/home/alice/src/a.ts', expected: 'pass', constraints: { token: 'hidden-token-value-12345' } }, options);
  const answer = sanitizeAnswer({ apiVersion: '1', questionId: 'target', value: '/tmp/kiokuko-workspace/src/a.ts' }, options);

  assert.equal(json(task.value).includes('hidden-secret-value-12345'), false);
  assert.equal(json(profile.value).includes('hidden-token-value-12345'), false);
  assert.equal((profile.value as { target: string }).target, '<HOME>/src/a.ts');
  assert.equal((answer.value as { value: string }).value, 'src/a.ts');
});
