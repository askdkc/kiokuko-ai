import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
