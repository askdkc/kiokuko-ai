import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, lstat, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { atomicReplaceTextWithGuard, readRegularFile } from '../../src/agent-file/atomic-write.js';
import { withManagedFileLock } from '../../src/managed-files/coordinator.js';

const COORDINATOR = path.resolve('src/managed-files/coordinator.ts');
const ATOMIC_WRITE = path.resolve('src/agent-file/atomic-write.ts');

function spawnScript(script: string, env: NodeJS.ProcessEnv): { child: ReturnType<typeof spawn>; stderr: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  return { child, stderr: () => output };
}

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

test('a force-terminated lock holder releases the lock and persists no edit intent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-crash-'));
  const data = path.join(root, 'data');
  await mkdir(data);
  const target = path.join(root, 'AGENTS.md');
  await writeFile(target, 'old\n');
  const entered = path.join(root, 'entered');
  const done = path.join(root, 'done');
  const environment = { ...process.env, KIOKUKO_DATA_DIR: data };
  const holderScript = `import { withManagedFileLock } from ${JSON.stringify(COORDINATOR)};
import { writeFile } from 'node:fs/promises';
await withManagedFileLock(${JSON.stringify(target)}, async () => {
  await writeFile(${JSON.stringify(entered)}, '');
  for (;;) await new Promise((resolve) => setTimeout(resolve, 25));
});`;
  const holder = spawnScript(holderScript, environment);
  try {
    await waitForFile(entered);
    holder.child.kill('SIGKILL');
    const exit = await waitForExit(holder.child);
    assert.equal(exit.signal, 'SIGKILL');
    const nextScript = `import { withManagedFileLock } from ${JSON.stringify(COORDINATOR)};
import { writeFile } from 'node:fs/promises';
await withManagedFileLock(${JSON.stringify(target)}, async () => {
  await writeFile(${JSON.stringify(done)}, '');
});`;
    const next = spawnScript(nextScript, environment);
    const nextExit = await waitForExit(next.child);
    assert.equal(nextExit.code, 0, `next process failed: ${next.stderr()}`);
    await access(done);
    const database = new DatabaseSync(path.join(data, 'managed-files.sqlite'), { readOnly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    database.close();
    assert.deepEqual(tables, []);
  } finally {
    holder.child.kill();
  }
});

test('a zero-length lock database left by interrupted initialization is usable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-crash-'));
  const data = path.join(root, 'data');
  await mkdir(data);
  await writeFile(path.join(data, 'managed-files.sqlite'), '');
  const target = path.join(root, 'AGENTS.md');
  await writeFile(target, 'old\n');
  const done = path.join(root, 'done');
  const script = `import { withManagedFileLock } from ${JSON.stringify(COORDINATOR)};
import { writeFile } from 'node:fs/promises';
await withManagedFileLock(${JSON.stringify(target)}, async () => {
  await writeFile(${JSON.stringify(done)}, '');
});`;
  const child = spawnScript(script, { ...process.env, KIOKUKO_DATA_DIR: data });
  const exit = await waitForExit(child.child);
  assert.equal(exit.code, 0, child.stderr());
  await access(done);
});

test('a crash before publication keeps the previous version and does not adopt leftovers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-crash-'));
  const data = path.join(root, 'data');
  await mkdir(data);
  const target = path.join(root, 'AGENTS.md');
  await writeFile(target, 'old\n');
  const orphan = path.join(root, '.AGENTS.md.crash.managed.tmp');
  const ready = path.join(root, 'ready');
  const go = path.join(root, 'go');
  const script = `import { withManagedFileLock } from ${JSON.stringify(COORDINATOR)};
import { access, writeFile } from 'node:fs/promises';
const lock = withManagedFileLock(${JSON.stringify(target)}, async () => {
  await writeFile(${JSON.stringify(orphan)}, 'partial');
  await writeFile(${JSON.stringify(ready)}, '');
  for (;;) { try { await access(${JSON.stringify(go)}); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
  process.kill(process.pid, 'SIGKILL');
});
await lock;`;
  const child = spawnScript(script, { ...process.env, KIOKUKO_DATA_DIR: data });
  try {
    await waitForFile(ready);
    await writeFile(go, '');
    const exit = await waitForExit(child.child);
    assert.equal(exit.signal, 'SIGKILL');
    assert.equal(await readFile(target, 'utf8'), 'old\n');
    assert.equal(await readFile(orphan, 'utf8'), 'partial');
    const environment = { env: { ...process.env, KIOKUKO_DATA_DIR: data } };
    const latest = await readRegularFile(target, { containmentRoot: root });
    assert.ok(latest);
    const parent = await lstat(root, { bigint: true });
    const result = await withManagedFileLock(
      target,
      (guard) => atomicReplaceTextWithGuard(
        target,
        'new\n',
        guard,
        latest,
        { device: parent.dev, inode: parent.ino },
        latest.mode,
        root,
      ),
      environment,
    );
    assert.equal(result.installed.content, 'new\n');
    assert.equal(await readFile(target, 'utf8'), 'new\n');
    assert.equal(await readFile(orphan, 'utf8'), 'partial');
  } finally {
    child.child.kill();
  }
});

test('a crash after publication keeps the complete new version and a reusable lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-crash-'));
  const data = path.join(root, 'data');
  await mkdir(data);
  const target = path.join(root, 'AGENTS.md');
  await writeFile(target, 'old\n');
  const published = path.join(root, 'published');
  const script = `import { withManagedFileLock } from ${JSON.stringify(COORDINATOR)};
import { atomicReplaceTextWithGuard, readRegularFile } from ${JSON.stringify(ATOMIC_WRITE)};
import { lstat, writeFile } from 'node:fs/promises';
const root = ${JSON.stringify(root)};
const target = ${JSON.stringify(target)};
const lock = withManagedFileLock(target, async (guard) => {
  const expected = await readRegularFile(target, { containmentRoot: root });
  const parent = await lstat(root, { bigint: true });
  await atomicReplaceTextWithGuard(target, 'new\\n', guard, expected, { device: parent.dev, inode: parent.ino }, expected.mode, root);
  await writeFile(${JSON.stringify(published)}, '');
  process.kill(process.pid, 'SIGKILL');
});
await lock;`;
  const child = spawnScript(script, { ...process.env, KIOKUKO_DATA_DIR: data });
  try {
    await waitForFile(published);
    const exit = await waitForExit(child.child);
    assert.equal(exit.signal, 'SIGKILL');
    assert.equal(await readFile(target, 'utf8'), 'new\n');
    const environment = { env: { ...process.env, KIOKUKO_DATA_DIR: data } };
    await withManagedFileLock(target, async () => {
      assert.equal(await readFile(target, 'utf8'), 'new\n');
    }, environment);
  } finally {
    child.child.kill();
  }
});
