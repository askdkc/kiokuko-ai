import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { runKiokukoHook } from '../../src/opencode/hook-effect.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function child(output: string, exitCode = 0) {
  return {
    stdin: { write() {}, end() {} },
    stdout: stream(output),
    stderr: stream('diagnostic output is discarded'),
    exited: Promise.resolve(exitCode),
    kill() {},
  } as never;
}

const validOutput = JSON.stringify({
  protocolVersion: 1,
  packageVersion: PACKAGE_VERSION,
  disposition: 'continue',
  code: 'continue',
  continue: true,
  runId: 'run-test',
  status: 'goki_executing',
  directive: null,
  reason: 'resume the approved WorkUnit',
  warning: null,
  resumeToken: 'token-test',
  routeEpoch: 1,
  executionLease: null,
});

test('hook execution never searches a workspace binary or ambient PATH', async () => {
  const checked: string[] = [];
  let spawned = false;
  const decision = await runKiokukoHook(
    { sessionId: 'session-test', terminalMessageId: 'terminal-test', cwd: '/workspace' },
    {
      env: {},
      lstat: async (pathname) => {
        checked.push(String(pathname));
        return { isFile: () => true, isSymbolicLink: () => false, mode: 0o755 } as never;
      },
      spawn: () => {
        spawned = true;
        return child(validOutput);
      },
    },
  );
  assert.equal(decision.kind, 'continue');
  assert.equal(spawned, true);
  assert.equal(checked.some((pathname) => pathname === path.join('/workspace', 'node_modules', '.bin', 'kiokuko')), false);
});

test('hook execution rejects symlinks, nonzero exits, and non-exact output', async () => {
  const symlink = await runKiokukoHook(
    { sessionId: 'session-test', terminalMessageId: 'terminal-test', cwd: '/workspace' },
    {
      env: { KIOKUKO_BIN: '/tmp/kiokuko-link' },
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true, mode: 0o755 } as never),
      spawn: () => child(validOutput),
    },
  );
  assert.deepEqual(symlink, { kind: 'failure', retryable: true, reason: 'cli_unavailable' });

  const nonzero = await runKiokukoHook(
    { sessionId: 'session-test', terminalMessageId: 'terminal-test', cwd: '/workspace' },
    {
      env: { KIOKUKO_BIN: '/tmp/kiokuko' },
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o755 } as never),
      spawn: () => child(validOutput, 8),
    },
  );
  assert.deepEqual(nonzero, { kind: 'failure', retryable: true, reason: 'hook_failed' });

  const extraKey = await runKiokukoHook(
    { sessionId: 'session-test', terminalMessageId: 'terminal-test', cwd: '/workspace' },
    {
      env: { KIOKUKO_BIN: '/tmp/kiokuko' },
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o755 } as never),
      spawn: () => child(JSON.stringify({ continue: true, reason: 'unsafe shape' })),
    },
  );
  assert.deepEqual(extraKey, { kind: 'failure', retryable: false, reason: 'invalid_response' });
});
