import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openCodeHookRequestSchema,
  openCodeHookResponseSchema,
  inspectOpenCodeHookResponse,
  parseOpenCodeHookRequest,
  parseOpenCodeHookResponse,
} from '../../src/opencode/hook-protocol.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    packageVersion: PACKAGE_VERSION,
    sessionId: 'session-test',
    terminalMessageId: 'terminal-test',
    cwd: '/workspace',
    ...overrides,
  };
}

function continuingResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return response({
    disposition: 'continue',
    code: 'continue',
    continue: true,
    runId: 'run-test',
    status: 'goki_executing',
    directive: { runId: 'run-test', contractRevision: 1 },
    reason: 'resume',
    warning: null,
    resumeToken: 'token-test',
    routeEpoch: 1,
    executionLease: null,
    ...overrides,
  });
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    packageVersion: PACKAGE_VERSION,
    disposition: 'stop',
    code: 'no_active_run',
    continue: false,
    runId: null,
    status: null,
    directive: null,
    reason: null,
    warning: null,
    resumeToken: null,
    routeEpoch: null,
    executionLease: null,
    ...overrides,
  };
}

test('OpenCode hook request is strict, versioned, and bounded', () => {
  assert.deepEqual(parseOpenCodeHookRequest(request()), request());
  assert.equal(openCodeHookRequestSchema.safeParse(request({ extra: true })).success, false);
  assert.equal(openCodeHookRequestSchema.safeParse(request({ sessionId: ' session-test' })).success, false);
  assert.equal(openCodeHookRequestSchema.safeParse(request({ terminalMessageId: 'terminal\n' })).success, false);
  assert.throws(() => parseOpenCodeHookRequest(request({ packageVersion: '0.0.0' })), /package version/u);
  assert.throws(() => parseOpenCodeHookRequest(request({ terminalMessageId: 'sk-1234567890123456' })), /secret-shaped/u);
});

test('OpenCode hook response requires an exact disposition contract and hides invalid payloads', () => {
  assert.deepEqual(parseOpenCodeHookResponse(response()), response());
  assert.deepEqual(
    parseOpenCodeHookResponse(response({ disposition: 'retry', code: 'timeout' })),
    response({ disposition: 'retry', code: 'timeout' }),
  );
  assert.equal(openCodeHookResponseSchema.safeParse(response({ unexpected: true })).success, false);
  assert.equal(parseOpenCodeHookResponse(continuingResponse({ continue: false })), undefined);
  assert.equal(parseOpenCodeHookResponse(continuingResponse({ code: 'no_active_run' })), undefined);
  assert.equal(parseOpenCodeHookResponse(response({ disposition: 'retry', code: 'no_active_run' })), undefined);
  assert.equal(parseOpenCodeHookResponse(response({ packageVersion: '0.0.0' })), undefined);
  assert.deepEqual(inspectOpenCodeHookResponse(response({ packageVersion: '0.0.0' })), { ok: false, reason: 'version_mismatch' });
  assert.deepEqual(inspectOpenCodeHookResponse(response({ protocolVersion: 2 })), { ok: false, reason: 'version_mismatch' });
  assert.deepEqual(inspectOpenCodeHookResponse({ continue: true }), { ok: false, reason: 'invalid_response' });
  assert.equal(parseOpenCodeHookResponse(response({ resumeToken: 'sk-1234567890123456' })), undefined);
  assert.deepEqual(
    parseOpenCodeHookResponse(continuingResponse({ reason: 'line one\nline two' }))?.reason,
    'line one\nline two',
  );
  assert.equal(parseOpenCodeHookResponse(continuingResponse({ reason: 'line one\u0000line two' })), undefined);
});
