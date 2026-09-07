import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { withManagedFileLock } from '../../src/managed-files/coordinator.js';

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`barrier did not arrive: ${filePath}`);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function releaseAndReap(child: ReturnType<typeof spawn>, barrier: string): Promise<void> {
  await writeFile(barrier, '');
  if (child.exitCode !== null || child.signalCode !== null) return;
  const raced = await Promise.race([
    waitForExit(child),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
  ]);
  if (raced === null) {
    child.kill();
    await waitForExit(child);
  }
}

test('separate processes serialize one physical managed resource', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-process-'));
  const data = path.join(root, 'data');
  await mkdir(data);
  const target = path.join(root, 'AGENTS.md');
  await writeFile(target, '');
  const entered = path.join(root, 'entered');
  const acquired = path.join(root, 'acquired');
  const release = path.join(root, 'release');
  const modulePath = path.resolve('src/managed-files/coordinator.ts');
  const script = `import { withManagedFileLock } from ${JSON.stringify(modulePath)};
import { access, writeFile } from 'node:fs/promises';
const target = ${JSON.stringify(target)};
const entered = ${JSON.stringify(entered)};
const acquired = ${JSON.stringify(acquired)};
const release = ${JSON.stringify(release)};
const lock = withManagedFileLock(target, async () => {
  await writeFile(process.env.ROLE === 'second' ? acquired : entered, '');
  for (;;) { try { await access(release); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
});
await lock;`;
  const environment = { ...process.env, KIOKUKO_DATA_DIR: data, ROLE: 'first' };
  const first = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let second: ReturnType<typeof spawn> | undefined;
  try {
    await waitForFile(entered);
    second = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: path.resolve('.'),
      env: { ...environment, ROLE: 'second' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await assert.rejects(access(acquired));
    await writeFile(release, '');
    await waitForFile(acquired);
    await Promise.all([
      waitForExit(first),
      waitForExit(second),
    ]);
  } finally {
    first.kill();
    second?.kill();
  }
});

test('readers observe only complete versions during coordinated replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-reader-'));
  const data = path.join(root, 'data');
  await mkdir(data);
  const target = path.join(root, 'AGENTS.md');
  const oldContent = 'old\n'.repeat(512);
  const newContent = 'new\n'.repeat(512);
  await writeFile(target, oldContent);
  const modulePath = path.resolve('src/managed-files/coordinator.ts');
  const atomicPath = path.resolve('src/agent-file/atomic-write.ts');
  const script = `import { withManagedFileLock } from ${JSON.stringify(modulePath)};
import { atomicReplaceTextWithGuard, readRegularFile } from ${JSON.stringify(atomicPath)};
import { lstat } from 'node:fs/promises';
const root = ${JSON.stringify(root)};
const target = ${JSON.stringify(target)};
await withManagedFileLock(target, async (guard) => {
  const expected = await readRegularFile(target, { containmentRoot: root });
  const parent = await lstat(root, { bigint: true });
  await atomicReplaceTextWithGuard(target, ${JSON.stringify(newContent)}, guard, expected, { device: parent.dev, inode: parent.ino }, expected.mode, root);
});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env: { ...process.env, KIOKUKO_DATA_DIR: data },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const observed = new Set<string>();
  let missing = 0;
  try {
    for (;;) {
      try {
        observed.add(await readFile(target, 'utf8'));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') missing += 1;
        else throw error;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, stderr);
  } finally {
    child.kill();
  }
  assert.equal(missing, 0);
  for (const content of observed) {
    assert.ok(
      content === oldContent || content === newContent,
      `reader observed a partial version: ${JSON.stringify(content.slice(0, 40))}`,
    );
  }
  assert.ok(observed.has(newContent));
});

test('lock wait timeout rejects without invoking the operation or mutating target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-timeout-'));
  const data = path.join(root, 'data');
  await mkdir(data);
  const target = path.join(root, 'AGENTS.md');
  const content = 'before\n';
  await writeFile(target, content);
  const barrier = path.join(root, 'barrier');
  const acquired = path.join(root, 'acquired');
  const modulePath = path.resolve('src/managed-files/coordinator.ts');
  const script = `import { withManagedFileLock } from ${JSON.stringify(modulePath)};
import { access, writeFile } from 'node:fs/promises';
const target = ${JSON.stringify(target)};
const acquired = ${JSON.stringify(acquired)};
const barrier = ${JSON.stringify(barrier)};
await withManagedFileLock(target, async () => {
  await writeFile(acquired, '');
  for (;;) { try { await access(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env: { ...process.env, KIOKUKO_DATA_DIR: data },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stderr.on('data', (chunk: Buffer) => { childErr += chunk.toString(); });
  let invoked = false;
  const previousDataDir = process.env.KIOKUKO_DATA_DIR;
  process.env.KIOKUKO_DATA_DIR = data;
  try {
    await waitForFile(acquired);
    const t0 = performance.now();
    await assert.rejects(
      withManagedFileLock(target, async () => {
        invoked = true;
        await writeFile(target, 'should-not-write\n');
      }),
      (error: unknown) => error instanceof Error && /lock|timeout/i.test(error.message),
    );
    assert.ok(performance.now() - t0 < 3500, 'timeout fired far beyond the configured limit');
  } finally {
    process.env.KIOKUKO_DATA_DIR = previousDataDir;
    await releaseAndReap(child, barrier);
  }
  assert.equal(invoked, false);
  assert.equal(await readFile(target, 'utf8'), content);
  const exit = await waitForExit(child);
  assert.equal(exit.code, 0, childErr);
});
