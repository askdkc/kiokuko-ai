import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import {
  validateAnswerInput,
  validateEventBatch,
  validateEventInput,
  validateProfileHints,
  validateRunInput,
  validateTaskInput,
} from '../../src/ledger/validate.js';
import { canonicalJson } from '../../src/ledger/hash.js';
import { MAX_BATCH_EVENTS, MAX_EVENT_PAYLOAD_BYTES } from '../../src/ledger/types.js';
import { sanitizeAnswer, sanitizeEvent, sanitizeProfileHints, sanitizeRunMetadata, sanitizeTask } from '../../src/ledger/redaction.js';

const now = '2026-08-20T00:00:00.000Z';

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceEventId: 'source-1',
    sourceSequence: 7,
    eventType: 'tool.completed',
    sourceType: 'generic',
    actor: 'agent',
    outcome: 'success',
    occurredAt: now,
    payload: { tool: 'read_file' },
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-1',
    workspace: '/tmp/workspace',
    protocolVersion: '1',
    client: { kind: 'opencode' as const, version: '1.0.0', sessionId: 'session-1' },
    captureProfile: 'standard',
    coverage: {
      run: 'complete',
      tool: 'best_effort',
      command: 'declared',
      file: 'unavailable',
      approval: 'unavailable',
    },
    task: { title: 'Build', query: 'run tests', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
    metadata: {},
    startedAt: now,
    ...overrides,
  };
}

test('rejects unknown event fields without echoing untrusted values', () => {
  const secret = 'password = hidden-secret-value-12345';
  assert.throws(() => validateEventInput(event({ unexpected: secret })), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'VALIDATION_ERROR');
    assert.equal((error as Error).message.includes(secret), false);
    return true;
  });
});

test('rejects unknown enums and non-canonical timestamps', () => {
  assert.throws(() => validateEventInput(event({ eventType: 'tool.magic' })), /event type|enum|invalid/i);
  assert.throws(() => validateEventInput(event({ occurredAt: '2026-08-20' })), /timestamp|time|invalid/i);
  assert.throws(() => validateRunInput(run({ captureProfile: 'unbounded' })), /capture|profile|invalid/i);
});

test('validates run coverage and immutable task/profile/answer shapes', () => {
  assert.doesNotThrow(() => validateRunInput(run()));
  assert.throws(
    () => validateRunInput(run({ client: { kind: 'codex' } })),
    (error: unknown) => error instanceof KiokukoError && error.code === 'UNSUPPORTED_CLIENT',
  );
  assert.throws(() => validateRunInput(run({ coverage: { run: 'complete', unexpected: 'best_effort' } })), /coverage|unknown|invalid/i);
  assert.doesNotThrow(() => validateTaskInput({ title: 'Task', query: 'Query', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } }));
  assert.doesNotThrow(() => validateProfileHints({ taskType: 'build', target: null, expected: null, constraints: null }));
  assert.doesNotThrow(() => validateAnswerInput({ questionId: 'target', value: 'src/index.ts' }));
  assert.throws(() => validateAnswerInput({ questionId: 'target', value: 'src/index.ts', ignored: true }), /unknown|invalid/i);
});

test('rejects event payloads over the sanitized 64 KiB bound and batches over 200 events', () => {
  const oversized = event({ payload: { data: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) } });
  assert.throws(() => sanitizeEvent(oversized, { workspace: '/tmp/workspace', home: '/home/tester' }), /64|payload|size/i);
  assert.throws(
    () => validateEventBatch({ events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => event()) }),
    new RegExp(`at most ${MAX_BATCH_EVENTS}`, 'i'),
  );
});

test('accepts sanitized snapshots exactly at the 64 KiB boundary', () => {
  const options = { workspace: '/tmp/workspace', home: '/home/tester' };
  const bounded = <T>(factory: (text: string) => T): T => {
    const overhead = Buffer.byteLength(canonicalJson(factory('')), 'utf8');
    return factory('x'.repeat(MAX_EVENT_PAYLOAD_BYTES - overhead));
  };

  const payload = bounded((data) => ({ data }));
  assert.equal(Buffer.byteLength(canonicalJson(payload), 'utf8'), MAX_EVENT_PAYLOAD_BYTES);
  assert.doesNotThrow(() => sanitizeEvent(event({ payload }), options));

  const task = bounded((constraints) => ({
    title: 'Task', query: 'Query',
    profileHints: { taskType: 'build', target: null, expected: null, constraints },
  }));
  assert.equal(Buffer.byteLength(canonicalJson(task), 'utf8'), MAX_EVENT_PAYLOAD_BYTES);
  assert.doesNotThrow(() => sanitizeTask(task, options));

  const profile = bounded((constraints) => ({ taskType: 'build', target: null, expected: null, constraints }));
  assert.equal(Buffer.byteLength(canonicalJson(profile), 'utf8'), MAX_EVENT_PAYLOAD_BYTES);
  assert.doesNotThrow(() => sanitizeProfileHints(profile, options));

  const answer = bounded((value) => ({ questionId: 'target', value }));
  assert.equal(Buffer.byteLength(canonicalJson(answer), 'utf8'), MAX_EVENT_PAYLOAD_BYTES);
  assert.doesNotThrow(() => sanitizeAnswer(answer, options));

  const metadata = bounded((data) => ({ data }));
  assert.equal(Buffer.byteLength(canonicalJson(metadata), 'utf8'), MAX_EVENT_PAYLOAD_BYTES);
  assert.doesNotThrow(() => sanitizeRunMetadata(metadata, options));
});

test('task, profile hints, and answers share the sanitization boundary', () => {
  const options = { workspace: '/tmp/workspace', home: '/home/tester' };
  assert.doesNotThrow(() => sanitizeTask({ title: 'Task', query: 'Query', profileHints: { taskType: 'build', target: 'src/index.ts', expected: 'pass', constraints: null } }, options));
  assert.doesNotThrow(() => sanitizeProfileHints({ taskType: 'build', target: 'src/index.ts', expected: 'pass', constraints: null }, options));
  assert.doesNotThrow(() => sanitizeAnswer({ questionId: 'target', value: '/tmp/workspace/src/index.ts' }, options));
});

test('rejects task, profile, and answer snapshots over the sanitized 64 KiB bound', () => {
  const options = { workspace: '/tmp/workspace', home: '/home/tester' };
  const oversized = { data: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) };

  assert.throws(() => sanitizeTask({
    title: 'Task',
    query: 'Query',
    profileHints: { taskType: 'build', target: null, expected: null, constraints: oversized },
  }, options), /64|sanitized|size|bytes/i);
  assert.throws(() => sanitizeProfileHints({
    taskType: 'build', target: null, expected: null, constraints: oversized,
  }, options), /64|sanitized|size|bytes/i);
  assert.throws(() => sanitizeAnswer({
    questionId: 'target', value: oversized,
  }, options), /64|sanitized|size|bytes/i);
});
