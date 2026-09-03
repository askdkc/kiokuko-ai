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
  directive: { runId: 'run-test', contractRevision: 1 },
  reason: 'resume the approved WorkUnit',
  warning: null,
  resumeToken: 'token-test',
  routeEpoch: 1,
  executionLease: { leaseToken: 'lease-test' },
});

const runtime = {
  protocolVersion: 1 as const,
  packageVersion: PACKAGE_VERSION,
  nodeExecutable: '/runtime/node',
  cliScript: '/runtime/package/dist/bin/kiokuko.js',
};

const packageFile = async () => Buffer.from(JSON.stringify({ name: 'kiokuko-ai', version: PACKAGE_VERSION }));

test('hook execution never searches a workspace binary or ambient PATH', async () => {
  const checked: string[] = [];
  let spawned = false;
  const decision = await runKiokukoHook(
    { sessionId: 'session-test', terminalMessageId: 'terminal-test', cwd: '/workspace' },
    {
      env: {},
      runtime,
      readFile: packageFile as never,
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
      runtime,
      readFile: packageFile as never,
      lstat: async (pathname) => ({ isFile: () => true, isSymbolicLink: () => pathname === runtime.cliScript, mode: 0o755 } as never),
      spawn: () => child(validOutput),
    },
  );
  assert.deepEqual(symlink, { kind: 'failure', retryable: true, reason: 'cli_unavailable' });

  const nonzero = await runKiokukoHook(
    { sessionId: 'session-test', terminalMessageId: 'terminal-test', cwd: '/workspace' },
    {
      runtime,
      readFile: packageFile as never,
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o755 } as never),
      spawn: () => child(validOutput, 8),
    },
  );
  assert.deepEqual(nonzero, { kind: 'failure', retryable: true, reason: 'hook_failed' });

  const extraKey = await runKiokukoHook(
    { sessionId: 'session-test', terminalMessageId: 'terminal-test', cwd: '/workspace' },
    {
      runtime,
      readFile: packageFile as never,
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o755 } as never),
      spawn: () => child(JSON.stringify({ continue: true, reason: 'unsafe shape' })),
    },
  );
  assert.deepEqual(extraKey, { kind: 'failure', retryable: false, reason: 'invalid_response' });
});

test('hook timeout and lifecycle cancellation kill and settle the child', async () => {
  for (const mode of ['timeout', 'cancel'] as const) {
    let killed = 0;
    let settle!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { settle = resolve; });
    const stalled = () => new ReadableStream<Uint8Array>({ start() {} });
    const controller = new AbortController();
    const operation = runKiokukoHook(
      { sessionId: `session-${mode}`, terminalMessageId: `terminal-${mode}`, cwd: '/workspace' },
      {
        runtime,
        readFile: packageFile as never,
        lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o755 } as never),
        spawn: () => ({
          stdin: { write() {}, end() {} },
          stdout: stalled(),
          stderr: stalled(),
          exited,
          kill() { killed += 1; settle(143); },
        }),
        timeoutMs: mode === 'timeout' ? 5 : 1_000,
        signal: controller.signal,
      },
    );
    if (mode === 'cancel') controller.abort();
    const result = await operation;
    assert.equal(result.kind, 'failure');
    assert.equal(result.kind === 'failure' ? result.reason : '', mode === 'timeout' ? 'timeout' : 'cancelled');
    assert.equal(killed >= 1, true);
  }
});

test('hook rejects a replaced CLI package identity before spawning', async () => {
  let spawned = false;
  const result = await runKiokukoHook(
    { sessionId: 'session-package', terminalMessageId: 'terminal-package', cwd: '/workspace' },
    {
      runtime,
      readFile: async () => Buffer.from(JSON.stringify({ name: 'other-package', version: PACKAGE_VERSION })) as never,
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o755 } as never),
      spawn: () => { spawned = true; return child(validOutput); },
    },
  );
  assert.deepEqual(result, { kind: 'failure', retryable: false, reason: 'version_mismatch' });
  assert.equal(spawned, false);
});
