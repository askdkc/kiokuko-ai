import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';

const profileHints = {
  taskType: 'build' as const,
  target: 'tests',
  expected: 'Focused tests pass',
  constraints: null,
};

async function database(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-execution-context-db-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  return openConnection(databasePath);
}

async function prepare(cwd: string, requestId: string, connection: ReturnType<typeof openConnection>) {
  return prepareAgentTask(connection, {
    requestId,
    cwd,
    task: 'Add repository tests using the canonical project root',
    profileHints,
    capabilities: [],
    client: { kind: 'test' },
    skillDiscoveryMode: 'off',
  });
}

test('task preparation exposes the launch repository as the canonical absolute path base', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-execution-context-root-'));
  execFileSync('git', ['init', '-q', root]);
  const connection = await database('root');
  try {
    const canonicalRoot = await realpath(root);
    const prepared = await prepare(root, 'execution-context-root', connection);
    assert.deepEqual(prepared.executionContext, {
      canonicalCwd: canonicalRoot,
      repositoryRoot: canonicalRoot,
      cwdIsRepositoryRoot: true,
      pathPolicy: 'canonical_absolute_under_repository_root',
    });
    assert.equal(prepared.project.repositoryRoot, prepared.executionContext.repositoryRoot);
    assert.match(prepared.securityNotice, /Use executionContext\.repositoryRoot as the canonical base/u);
  } finally {
    connection.close();
  }
});

test('task preparation distinguishes a nested cwd while retaining the canonical repository root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-execution-context-nested-'));
  execFileSync('git', ['init', '-q', root]);
  const nested = path.join(root, 'packages', 'feature');
  await mkdir(nested, { recursive: true });
  const connection = await database('nested');
  try {
    const canonicalRoot = await realpath(root);
    const canonicalNested = await realpath(nested);
    const prepared = await prepare(nested, 'execution-context-nested', connection);
    assert.deepEqual(prepared.executionContext, {
      canonicalCwd: canonicalNested,
      repositoryRoot: canonicalRoot,
      cwdIsRepositoryRoot: false,
      pathPolicy: 'canonical_absolute_under_repository_root',
    });
  } finally {
    connection.close();
  }
});

test('task preparation treats a Git worktree with a .git file as its canonical repository root', async () => {
  const main = await mkdtemp(path.join(tmpdir(), 'kiokuko-execution-context-main-'));
  execFileSync('git', ['init', '-q', main]);
  await writeFile(path.join(main, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', main, 'add', 'README.md']);
  execFileSync('git', ['-C', main, '-c', 'user.name=Kiokuko Test', '-c', 'user.email=kiokuko@example.invalid', 'commit', '-qm', 'fixture']);
  const worktreeParent = await mkdtemp(path.join(tmpdir(), 'kiokuko-execution-context-worktree-parent-'));
  const worktree = path.join(worktreeParent, 'worktree');
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'execution-context-fixture', worktree]);
  assert.equal((await stat(path.join(worktree, '.git'))).isFile(), true);

  const connection = await database('worktree');
  try {
    const canonicalWorktree = await realpath(worktree);
    const prepared = await prepare(worktree, 'execution-context-worktree', connection);
    assert.deepEqual(prepared.executionContext, {
      canonicalCwd: canonicalWorktree,
      repositoryRoot: canonicalWorktree,
      cwdIsRepositoryRoot: true,
      pathPolicy: 'canonical_absolute_under_repository_root',
    });
    assert.equal(prepared.project.repositoryRoot, canonicalWorktree);
  } finally {
    connection.close();
  }
});
