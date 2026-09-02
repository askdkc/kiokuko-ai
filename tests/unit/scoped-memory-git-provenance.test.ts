import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCheckpointSourceCommit } from '../../src/memory/scoped-memory.js';

function processFailure(overrides: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('raw process failure'), {
    status: 1,
    signal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  });
}

function throwing(error: unknown) {
  return () => { throw error; };
}

test('returns null only for explicit non-Git and unborn-HEAD states', async () => {
  const nonGit = await mkdtemp(path.join(tmpdir(), 'kiokuko-checkpoint-non-git-'));
  assert.equal(resolveCheckpointSourceCommit(nonGit), null);

  const unborn = await mkdtemp(path.join(tmpdir(), 'kiokuko-checkpoint-unborn-'));
  execFileSync('git', ['init', '-q', unborn]);
  assert.equal(resolveCheckpointSourceCommit(unborn), null);

  for (const stderr of [
    'fatal: Needed a single revision\n',
    'fatal: not a git repository (or any of the parent directories): .git\n',
  ]) {
    assert.equal(resolveCheckpointSourceCommit('/unused', throwing(processFailure({ status: 128, stderr }))), null);
  }
});

test('returns a strict immutable commit and applies bounded deterministic Git options', () => {
  let observed: { executable: string; args: string[]; timeout: number; maxBuffer: number; locale: string | undefined } | undefined;
  const commit = 'a'.repeat(40);
  const result = resolveCheckpointSourceCommit('/repository', (executable, args, options) => {
    observed = {
      executable,
      args,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      locale: options.env.LC_ALL,
    };
    return `${commit}\n`;
  });
  assert.equal(result, commit);
  assert.deepEqual(observed, {
    executable: 'git',
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    locale: 'C',
  });
  assert.equal(resolveCheckpointSourceCommit('/repository', () => 'b'.repeat(64)), 'b'.repeat(64));
});

test('rejects malformed successful Git output as an integrity failure', () => {
  for (const output of ['', 'deadbee\n', `${'A'.repeat(40)}\n`, `${'a'.repeat(40)}\nsecond-line\n`, `${'a'.repeat(40)} `]) {
    assert.throws(
      () => resolveCheckpointSourceCommit('/unused', () => output),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'INTEGRITY_ERROR'
        && (error as { message?: string }).message === 'Git checkpoint provenance is invalid',
    );
  }
});

test('propagates timeout, permission, and unexpected Git failures as typed failures', () => {
  const failures = [
    processFailure({ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT', killed: true }),
    processFailure({ status: undefined, signal: undefined, code: 'EACCES' }),
    processFailure({ status: 128, stderr: 'fatal: detected dubious ownership in repository\n' }),
    processFailure({ status: 128, stderr: 'fatal: Needed a single revision\nunexpected detail\n' }),
    new TypeError('programmer-bug-sentinel'),
  ];
  for (const failure of failures) {
    assert.throws(
      () => resolveCheckpointSourceCommit('/unused', throwing(failure)),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'SERVICE_UNAVAILABLE'
        && (error as { message?: string }).message === 'Git checkpoint provenance could not be resolved'
        && !(error as { message?: string }).message?.includes('sentinel'),
    );
  }
});
