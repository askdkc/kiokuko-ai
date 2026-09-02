import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalDirectory, detectRepositoryRoot } from '../../src/repository/detect-root.js';
import { KiokukoError } from '../../src/errors.js';
import { createRepositoryIdentity } from '../../src/repository/identity.js';
import { fingerprintRemoteUrl, normalizeRemoteUrl } from '../../src/repository/remote-url.js';

async function temp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`)));
}

test('detects a realpath-normalized git root from a subdirectory', async () => {
  const root = await temp('root');
  await mkdir(path.join(root, '.git'));
  const nested = path.join(root, 'src', 'deep');
  await mkdir(nested, { recursive: true });
  const link = `${root}-link`;
  await symlink(root, link);
  assert.equal(detectRepositoryRoot({ cwd: nested }).root, root);
  assert.equal(detectRepositoryRoot({ cwd: path.join(link, 'src') }).root, root);
});

test('prefers an ancestor binding over a git root', async () => {
  const root = await temp('binding-root');
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.kiokuko.json'), '{}');
  const nested = path.join(root, 'packages', 'app');
  await mkdir(nested, { recursive: true });
  assert.equal(detectRepositoryRoot({ cwd: nested }).source, 'binding');
  assert.equal(detectRepositoryRoot({ cwd: nested }).root, root);
});

test('requires allowDirectory when no binding or git root exists', async () => {
  const directory = await temp('directory');
  assert.throws(() => detectRepositoryRoot({ cwd: directory }), /allow-directory|repository root/i);
  assert.equal(detectRepositoryRoot({ cwd: directory, allowDirectory: true }).root, directory);
});

test('canonical directory rejects relative and missing paths with typed failures', async () => {
  const directory = await temp('canonical-directory');
  const missing = path.join(directory, 'missing');
  const file = path.join(directory, 'file');
  await writeFile(file, 'not a directory');

  assert.throws(
    () => canonicalDirectory('relative/repository'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => canonicalDirectory(missing),
    (error: unknown) => error instanceof KiokukoError && error.code === 'NOT_FOUND',
  );
  assert.throws(
    () => canonicalDirectory(path.join(file, 'child')),
    (error: unknown) => error instanceof KiokukoError && error.code === 'NOT_FOUND',
  );
});

test('normalizes HTTPS and SCP-like SSH remotes without credentials', () => {
  const https = normalizeRemoteUrl('https://user:secret@GitHub.COM/org/repo.git?token=hidden#frag');
  const ssh = normalizeRemoteUrl('git@github.com:org/repo.git');
  const sshUrl = normalizeRemoteUrl('ssh://git@github.com/org/repo.git');
  assert.equal(https, 'github.com/org/repo');
  assert.equal(ssh, https);
  assert.equal(sshUrl, https);
  assert.doesNotMatch(https, /secret|token|user|@/i);
  assert.equal(fingerprintRemoteUrl('https://github.com/org/repo.git'), fingerprintRemoteUrl('git@github.com:org/repo.git'));
});

test('derives stable IDs and collision-resistant workspaces', () => {
  const first = createRepositoryIdentity({
    repositoryRoot: '/tmp/sample-app',
    remoteUrl: 'https://github.com/acme/sample-app.git',
  });
  const second = createRepositoryIdentity({
    repositoryRoot: '/tmp/sample-app',
    remoteUrl: 'https://github.com/other/sample-app.git',
  });
  assert.match(first.repositoryId, /^repo_[a-f0-9]+$/);
  assert.equal(first.repositoryId, `repo_${fingerprintRemoteUrl('https://github.com/acme/sample-app.git').slice(7, 19)}`);
  assert.notEqual(first.repositoryId, second.repositoryId);
  assert.notEqual(first.workspace, second.workspace);
  assert.match(first.workspace, /^project:sample-app-[a-f0-9]+$/);
});

test('keeps an origin-less UUID identity when a binding is supplied', () => {
  const first = createRepositoryIdentity({ repositoryRoot: '/tmp/local-project' });
  const second = createRepositoryIdentity({
    repositoryRoot: '/tmp/moved-local-project',
    existingBinding: { repositoryId: first.repositoryId, workspace: first.workspace },
  });
  assert.match(first.repositoryId, /^repo_[0-9a-f-]{36}$/);
  assert.equal(second.repositoryId, first.repositoryId);
  assert.equal(second.workspace, first.workspace);
});
