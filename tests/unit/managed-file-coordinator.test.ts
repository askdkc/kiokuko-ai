import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withManagedFileLock } from '../../src/managed-files/coordinator.js';
import { atomicReplaceTextWithGuard } from '../../src/agent-file/atomic-write.js';
import { readRegularFile } from '../../src/agent-file/atomic-write.js';

test('serializes same-process operations for one physical resource', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-lock-'));
  const target = path.join(root, 'AGENTS.md');
  await writeFile(target, '');
  const events: string[] = [];
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withManagedFileLock(target, async () => {
    events.push('first-enter');
    entered();
    await gate;
    events.push('first-exit');
  });
  await enteredPromise;
  assert.deepEqual(events, ['first-enter']);
  let secondEntered!: () => void;
  const secondEnteredPromise = new Promise<void>((resolve) => { secondEntered = resolve; });
  const second = withManagedFileLock(target, async () => {
    events.push('second-enter');
    secondEntered();
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['first-enter']);
  release();
  await secondEnteredPromise;
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter']);
  assert.equal(await readFile(target, 'utf8'), '');
});

test('guarded replacement publishes once and creates without clobbering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-replace-'));
  const target = path.join(root, 'AGENTS.md');
  const parent = await lstat(root, { bigint: true });
  const result = await withManagedFileLock(target, async (guard) => atomicReplaceTextWithGuard(
    target,
    'managed\n',
    guard,
    undefined,
    { device: parent.dev, inode: parent.ino },
    0o640,
    root,
  ));
  assert.equal(result.installed.content, 'managed\n');
  assert.equal((await lstat(target, { bigint: true })).nlink, 1n);
  const expected = await readRegularFile(target, { containmentRoot: root });
  assert.ok(expected);
  await assert.rejects(
    withManagedFileLock(target, async (guard) => atomicReplaceTextWithGuard(
      target,
      'other\n',
      guard,
      undefined,
      { device: parent.dev, inode: parent.ino },
      0o640,
      root,
    )),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
  assert.deepEqual(await readRegularFile(target, { containmentRoot: root }), expected);
});

test('path aliases converge on one lock for the same physical resource', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-alias-'));
  const real = path.join(root, 'real');
  await mkdir(real);
  const link = path.join(root, 'link');
  await symlink(real, link);
  const target = path.join(real, 'AGENTS.md');
  await writeFile(target, '');
  const alias = path.join(link, 'AGENTS.md');
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withManagedFileLock(target, async () => {
    entered();
    await gate;
  });
  await enteredPromise;
  let secondEntered = false;
  const second = withManagedFileLock(alias, async () => { secondEntered = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(secondEntered, false);
  release();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});

test('an aborted signal rejects the queued operation before it enters the critical section', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-abort-'));
  const target = path.join(root, 'AGENTS.md');
  await writeFile(target, '');
  const controller = new AbortController();
  let entered = false;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withManagedFileLock(target, async () => { await firstGate; });
  const second = withManagedFileLock(target, async () => { entered = true; }, { signal: controller.signal });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  controller.abort();
  releaseFirst();
  await first;
  await assert.rejects(second, (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT');
  assert.equal(entered, false);
  assert.equal(await readFile(target, 'utf8'), '');
});
