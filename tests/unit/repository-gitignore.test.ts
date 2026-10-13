import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile, truncate, link, unlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PROJECT_BINDING_IGNORE_ENTRY,
  renderProjectGitignore,
  renderAgenticReplayGitignore,
  ensureAgenticReplayIgnored,
} from '../../src/repository/gitignore.js';

test('AgenticReplay ignore renderer preserves supported entries and overrides later negations', () => {
  assert.deepEqual(renderAgenticReplayGitignore(undefined), { content: '.agenticreplay/\n', action: 'created' });
  for (const entry of ['.agenticreplay', '.agenticreplay/']) {
    const existing = `${entry}\r\nnode_modules/\r\n`;
    assert.deepEqual(renderAgenticReplayGitignore(existing), { content: existing, action: 'unchanged' });
  }
  for (const existing of ['/.agenticreplay\n', '/.agenticreplay/\n', '!.agenticreplay/\n', '# .agenticreplay/\n', '.agenticreplay/\n!**/api.json\n', 'node_modules/\r\n.env']) {
    const result = renderAgenticReplayGitignore(existing);
    assert.equal(result.action, 'updated');
    assert.ok(result.content.startsWith(existing));
    assert.equal(renderAgenticReplayGitignore(result.content).action, 'unchanged');
  }
});

test('concurrent ignore updates create one rule and Git excludes all trace data', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'trace-ignore-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), '/.agenticreplay/\n');
  await Promise.all([ensureAgenticReplayIgnored(root), ensureAgenticReplayIgnored(root)]);
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), '/.agenticreplay/\n.agenticreplay/\n');
  assert.equal(execFileSync('git', ['check-ignore', '.agenticreplay/runs/api.json', 'nested/.agenticreplay/blobs/body'], { cwd: root, encoding: 'utf8' }), '.agenticreplay/runs/api.json\nnested/.agenticreplay/blobs/body\n');
});

test('ignore updates reject symlinks without changing their target', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'trace-ignore-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'user-ignore');
  await writeFile(target, 'user content\n');
  await symlink(target, path.join(root, '.gitignore'));
  await assert.rejects(ensureAgenticReplayIgnored(root), { code: 'SECURITY_REJECTION' });
  assert.equal(await readFile(target, 'utf8'), 'user content\n');
});

test('project binding ignore renderer creates the canonical entry', () => {
  assert.deepEqual(renderProjectGitignore(undefined), {
    content: `${PROJECT_BINDING_IGNORE_ENTRY}\n`,
    action: 'created',
  });
});

test('project binding ignore renderer appends without changing existing bytes or line endings', () => {
  assert.deepEqual(renderProjectGitignore('node_modules/\n.env'), {
    content: `node_modules/\n.env\n${PROJECT_BINDING_IGNORE_ENTRY}\n`,
    action: 'updated',
  });
  assert.deepEqual(renderProjectGitignore('node_modules/\r\n'), {
    content: `node_modules/\r\n${PROJECT_BINDING_IGNORE_ENTRY}\r\n`,
    action: 'updated',
  });
});

test('project binding ignore renderer accepts canonical root entries and rejects negation as coverage', () => {
  for (const existing of [
    `${PROJECT_BINDING_IGNORE_ENTRY}\n`,
    `/${PROJECT_BINDING_IGNORE_ENTRY}\r\n`,
  ]) {
    assert.deepEqual(renderProjectGitignore(existing), {
      content: existing,
      action: 'unchanged',
    });
  }
  assert.deepEqual(renderProjectGitignore(`!${PROJECT_BINDING_IGNORE_ENTRY}\n`), {
    content: `!${PROJECT_BINDING_IGNORE_ENTRY}\n${PROJECT_BINDING_IGNORE_ENTRY}\n`,
    action: 'updated',
  });
});

test('a bounded read that changes underneath its descriptor is a typed retryable conflict',async t=>{
 const {AtomicReadChangedError,readRegularFile}=await import('../../src/agent-file/atomic-write.js');
 const root=await mkdtemp(path.join(tmpdir(),'trace-ignore-read-race-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'.gitignore');await writeFile(file,'user bytes\n');
 await assert.rejects(readRegularFile(file,{maxBytes:1024,afterOpen:async(_file,handle)=>{
  const read=handle.read.bind(handle);handle.read=(async(...args:Parameters<typeof read>)=>{const result=await read(...args);await truncate(file,0);return result;}) as typeof handle.read;
 }}),error=>error instanceof AtomicReadChangedError&&error.code==='INTEGRITY_ERROR');
});

test('queued concurrent ignore updates preserve user bytes and converge once', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'trace-ignore-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.gitignore');
  for (let round = 0; round < 4; round++) {
    const original = `# user round ${round}\r\nnode_modules/\r\n/.agenticreplay/\r\n`;
    await writeFile(file, original);
    await Promise.all(Array.from({ length: 32 }, (_, index) =>
      ensureAgenticReplayIgnored(index % 2 === 0 ? root : path.join(root, '.'))));
    assert.equal(await readFile(file, 'utf8'), `${original}.agenticreplay/\r\n`);
    assert.deepEqual(await readdir(root), ['.gitignore']);
  }
});

test('queued failures remain visible and do not poison later ignore updates', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'trace-ignore-queue-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.gitignore');
  const victim = path.join(root, 'user-ignore');
  await writeFile(victim, 'private user content\n');
  await symlink(victim, file);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => ensureAgenticReplayIgnored(root)));
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.code, 'SECURITY_REJECTION');
  }
  assert.equal(await readFile(victim, 'utf8'), 'private user content\n');
  await rm(file);
  await ensureAgenticReplayIgnored(root);
  assert.equal(await readFile(file, 'utf8'), '.agenticreplay/\n');
});

test('hardlink cleanup during a bounded read remains a typed conflict', async (t) => {
  const { AtomicReadChangedError, readRegularFile } = await import('../../src/agent-file/atomic-write.js');
  const root = await mkdtemp(path.join(tmpdir(), 'trace-ignore-link-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.gitignore');
  const temporary = path.join(root, 'owned-temporary');
  const content = '.agenticreplay/\n';
  await writeFile(temporary, content);
  await link(temporary, file);
  const before = await stat(file);
  assert.equal(before.nlink, 2);
  await assert.rejects(readRegularFile(file, {
    maxBytes: 1024,
    afterOpen: async (_file, handle) => {
      const read = handle.read.bind(handle);
      handle.read = (async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        await unlink(temporary);
        return result;
      }) as typeof handle.read;
    },
  }), error => error instanceof AtomicReadChangedError);
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 1);
  assert.equal(await readFile(file, 'utf8'), content);
});
