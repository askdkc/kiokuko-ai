import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicWriteTextIfUnchanged,
  AtomicCommittedMutationError,
  AtomicCommittedUnlinkError,
  readRegularFile,
  unlinkRegularFileIfUnchanged,
} from '../../src/agent-file/atomic-write.js';
import {
  AGENT_TEMPLATE_VERSION,
  renderAgentFile,
  renderManagedBlock,
} from '../../src/agent-file/render.js';
import { useRepository } from '../../src/commands/use.js';
import { openConnection } from '../../src/db/connection.js';
import { TransactionCommitUncertainError } from '../../src/db/transaction.js';

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-use-${prefix}-`));
  execFileSync('git', ['init', '-q', root]);
  return root;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function openConnectionWithCloseFailure(closeFailure: unknown): typeof openConnection {
  return (filePath, options) => {
    const database = openConnection(filePath, options);
    return new Proxy(database, {
      get(target, property) {
        if (property === 'close') {
          return () => {
            target.close();
            throw closeFailure;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}

function openConnectionWithCommittedCommitFailure(
  commitFailure: unknown,
  closeFailure?: unknown,
): typeof openConnection {
  return (filePath, options) => {
    const database = openConnection(filePath, options);
    return new Proxy(database, {
      get(target, property) {
        if (property === 'exec') {
          return (sql: string) => {
            target.exec(sql);
            if (/^\s*COMMIT\s*;?\s*$/u.test(sql)) throw commitFailure;
          };
        }
        if (property === 'close' && closeFailure !== undefined) {
          return () => {
            target.close();
            throw closeFailure;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}

test('use creates binding and AGENTS.md, then is unchanged on repeat', async () => {
  const root = await repository('create');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const first = await useRepository({ root, databasePath });
  assert.equal(first.agentFileAction, 'created');
  assert.equal(first.bindingAction, 'created');
  const bindingBefore = await readFile(path.join(root, '.kiokuko.json'), 'utf8');
  const agentBefore = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const second = await useRepository({ root, databasePath });
  assert.equal(second.agentFileAction, 'unchanged');
  assert.equal(second.bindingAction, 'unchanged');
  assert.equal(await readFile(path.join(root, '.kiokuko.json'), 'utf8'), bindingBefore);
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), agentBefore);
  await assert.rejects(access(path.join(root, '.gitignore')));
  await access(databasePath);
});

test('new-binding ignore policy appends .kiokuko.json while preserving content, line endings, and mode', async () => {
  const root = await repository('gitignore-create');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const gitignorePath = path.join(root, '.gitignore');
  await writeFile(gitignorePath, 'node_modules/\r\n.env', { mode: 0o640 });

  await useRepository({ root, databasePath, ensureNewBindingIgnored: true });

  assert.equal(
    await readFile(gitignorePath, 'utf8'),
    'node_modules/\r\n.env\r\n.kiokuko.json\r\n',
  );
  assert.equal((await stat(gitignorePath)).mode & 0o777, 0o640);

  await writeFile(gitignorePath, 'node_modules/\n');
  await useRepository({ root, databasePath, ensureNewBindingIgnored: true });
  assert.equal(await readFile(gitignorePath, 'utf8'), 'node_modules/\n');
});

test('new-binding ignore failure restores the binding and leaves user gitignore bytes unchanged', async () => {
  const root = await repository('gitignore-rollback');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const gitignorePath = path.join(root, '.gitignore');
  await writeFile(gitignorePath, 'dist/\n');

  await assert.rejects(
    useRepository({ root, databasePath, ensureNewBindingIgnored: true }, {
      atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
        if (path.basename(filePath) === '.gitignore') throw new Error('injected gitignore failure');
        return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
      },
    }),
    /injected gitignore failure/u,
  );

  assert.equal(await readFile(gitignorePath, 'utf8'), 'dist/\n');
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
});

test('new-binding ignore update is restored when the later agent-file write fails', async () => {
  const root = await repository('gitignore-later-rollback');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const gitignorePath = path.join(root, '.gitignore');
  await writeFile(gitignorePath, 'dist/\n');

  await assert.rejects(
    useRepository({ root, databasePath, ensureNewBindingIgnored: true }, {
      atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
        if (path.basename(filePath) === 'AGENTS.md') throw new Error('injected agent failure');
        return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
      },
    }),
    /injected agent failure/u,
  );

  assert.equal(await readFile(gitignorePath, 'utf8'), 'dist/\n');
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
});

test('use adopts one exact concurrent binding and converges on an exact agent-file result', async () => {
  const root = await repository('concurrent-convergence');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  await writeFile(agentPath, 'human header\n');
  let bindingAttempts = 0;
  let agentAttempts = 0;

  const result = await useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (mode === undefined) assert.fail('use must provide an explicit file mode');
      if (path.basename(filePath) === '.kiokuko.json') {
        bindingAttempts += 1;
        const proposed = JSON.parse(content) as Record<string, unknown>;
        await writeFile(filePath, `${JSON.stringify({
          ...proposed,
          repositoryId: 'repo_concurrent_winner',
          workspace: 'project:concurrent-winner',
        }, null, 2)}\n`, { mode });
        await chmod(filePath, mode);
      } else if (path.basename(filePath) === 'AGENTS.md') {
        agentAttempts += 1;
        const peerOutcome = await atomicWriteTextIfUnchanged(
          filePath,
          content,
          expectation,
          mode,
        );
        assert.deepEqual(peerOutcome.cleanupFailures, []);
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  });

  assert.equal(bindingAttempts, 1);
  assert.equal(agentAttempts, 1);
  assert.equal(result.repositoryId, 'repo_concurrent_winner');
  assert.equal(result.workspace, 'project:concurrent-winner');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as { repositoryId: string; workspace: string };
  assert.equal(binding.repositoryId, 'repo_concurrent_winner');
  assert.equal(binding.workspace, 'project:concurrent-winner');
  const agent = await readFile(agentPath, 'utf8');
  assert.match(agent, /^human header\n/);
  assert.equal((agent.match(/BEGIN KIOKUKO MANAGED BLOCK/g) ?? []).length, 1);
  assert.equal((agent.match(/END KIOKUKO MANAGED BLOCK/g) ?? []).length, 1);

  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT repository_id AS repositoryId FROM repositories').get<{ repositoryId: string }>()?.repositoryId, 'repo_concurrent_winner');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('binding convergence retries when the intended agent result replaces a stale observation', async () => {
  const root = await repository('concurrent-observation-retry');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const canonicalRoot = await realpath(root);
  await writeFile(agentPath, 'human header\n');
  const intendedAgent = renderAgentFile('human header\n', {
    repositoryId: 'repo_concurrent_observation',
    workspace: 'project:concurrent-observation',
    cliCommand: 'kiokuko-ai',
  }).content;
  const parent = await stat(canonicalRoot, { bigint: true });
  let bindingInjected = false;
  let observationRaceInjected = false;
  let agentReads = 0;

  const result = await useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!bindingInjected && path.basename(filePath) === '.kiokuko.json') {
        bindingInjected = true;
        const proposed = JSON.parse(content) as Record<string, unknown>;
        await writeFile(filePath, `${JSON.stringify({
          ...proposed,
          repositoryId: 'repo_concurrent_observation',
          workspace: 'project:concurrent-observation',
        }, null, 2)}\n`, { mode });
        if (mode !== undefined) await chmod(filePath, mode);
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
    readAgentFileForConvergence: async (filePath, options) => {
      const snapshot = await readRegularFile(filePath, options);
      if (path.basename(filePath) === 'AGENTS.md') {
        agentReads += 1;
        if (bindingInjected && !observationRaceInjected && snapshot !== undefined) {
          observationRaceInjected = true;
          const peerOutcome = await atomicWriteTextIfUnchanged(
            filePath,
            intendedAgent,
            {
              expected: snapshot,
              containmentRoot: canonicalRoot,
              expectedParentDirectory: { device: parent.dev, inode: parent.ino },
            },
            snapshot.mode,
          );
          assert.deepEqual(peerOutcome.cleanupFailures, []);
        }
      }
      return snapshot;
    },
  });

  assert.equal(bindingInjected, true);
  assert.equal(observationRaceInjected, true);
  assert.ok(agentReads >= 2);
  assert.equal(result.repositoryId, 'repo_concurrent_observation');
  assert.equal(result.workspace, 'project:concurrent-observation');
  assert.equal(await readFile(agentPath, 'utf8'), intendedAgent);
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as {
    repositoryId: string;
    workspace: string;
  };
  assert.equal(binding.repositoryId, 'repo_concurrent_observation');
  assert.equal(binding.workspace, 'project:concurrent-observation');
});

test('initial agent planning adopts a concurrent winner before binding convergence', async () => {
  const root = await repository('concurrent-agent-before-binding');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const originalAgent = 'human header\n';
  await writeFile(agentPath, originalAgent);
  const parent = await stat(root, { bigint: true });
  const winner = {
    schemaVersion: 1 as const,
    repositoryId: 'repo_concurrent_before_binding',
    workspace: 'project:concurrent-before-binding',
    agentFile: 'AGENTS.md',
    templateVersion: AGENT_TEMPLATE_VERSION,
  };
  const winnerBinding = `${JSON.stringify(winner, null, 2)}\n`;
  const winnerAgent = renderAgentFile(originalAgent, {
    repositoryId: winner.repositoryId,
    workspace: winner.workspace,
    cliCommand: 'kiokuko-ai',
    templateVersion: winner.templateVersion,
  }).content;
  const bindingPrepared = deferred();
  const releaseBinding = deferred();
  const agentQuarantine = deferred();
  const releaseAgent = deferred();
  let bindingWriter: ReturnType<typeof atomicWriteTextIfUnchanged> | undefined;
  let agentWriter: ReturnType<typeof atomicWriteTextIfUnchanged> | undefined;
  let bindingReads = 0;
  let agentReads = 0;

  const result = await useRepository({ root, databasePath }, {
    readBindingFileForConvergence: async (filePath, options) => {
      const snapshot = await readRegularFile(filePath, options);
      bindingReads += 1;
      if (bindingReads === 1) {
        bindingWriter = atomicWriteTextIfUnchanged(
          bindingPath,
          winnerBinding,
          {
            expected: undefined,
            containmentRoot: root,
            expectedParentDirectory: { device: parent.dev, inode: parent.ino },
          },
          0o644,
          {
            beforeCommit: async () => {
              bindingPrepared.resolve();
              await releaseBinding.promise;
            },
          },
        );
        void bindingWriter.catch(() => undefined);
        await bindingPrepared.promise;
      }
      return snapshot;
    },
    readAgentFileForConvergence: async (filePath, options) => {
      const snapshot = await readRegularFile(filePath, options);
      agentReads += 1;
      if (agentReads === 1) {
        releaseBinding.resolve();
        if (bindingWriter === undefined) assert.fail('concurrent binding writer did not start');
        await bindingWriter;
        agentWriter = atomicWriteTextIfUnchanged(
          agentPath,
          winnerAgent,
          {
            expected: snapshot,
            containmentRoot: root,
            expectedParentDirectory: { device: parent.dev, inode: parent.ino },
          },
          snapshot?.mode ?? 0o644,
          {
            afterRename: async () => {
              agentQuarantine.resolve();
              await releaseAgent.promise;
            },
          },
        );
        void agentWriter.catch(() => undefined);
        await agentQuarantine.promise;
        return snapshot;
      }
      if (agentReads === 3) {
        releaseAgent.resolve();
        if (agentWriter === undefined) assert.fail('concurrent agent writer did not start');
        await agentWriter;
        return readRegularFile(filePath, options);
      }
      return snapshot;
    },
  });

  assert.ok(bindingReads >= 2);
  assert.equal(result.repositoryId, winner.repositoryId);
  assert.equal(result.workspace, winner.workspace);
  assert.equal(await readFile(bindingPath, 'utf8'), winnerBinding);
  assert.equal(await readFile(agentPath, 'utf8'), winnerAgent);
  assert.equal((await readdir(root)).some((name) => name.includes('kiokuko.json.') || name.includes('AGENTS.md.')), false);
});

test('initial agent planning retries when a concurrent setup installs the intended result', async () => {
  const root = await repository('initial-agent-observation-retry');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const agentPath = path.join(root, 'AGENTS.md');
  const canonicalRoot = await realpath(root);
  const originalAgent = 'human header\n';
  const repositoryId = 'repo_initial_agent_observation';
  const workspace = 'project:initial-agent-observation';
  await writeFile(agentPath, originalAgent);
  const parent = await stat(canonicalRoot, { bigint: true });
  const intendedAgent = renderAgentFile(originalAgent, {
    repositoryId,
    workspace,
    cliCommand: 'kiokuko-ai',
    templateVersion: AGENT_TEMPLATE_VERSION,
  }).content;
  let injected = false;

  const result = await useRepository({
    root,
    databasePath,
    repositoryId,
    workspace,
  }, {
    readAgentFileForConvergence: async (filePath, options) => {
      const snapshot = await readRegularFile(filePath, options);
      if (!injected && path.basename(filePath) === 'AGENTS.md') {
        injected = true;
        if (snapshot === undefined) assert.fail('planned agent file is missing');
        const outcome = await atomicWriteTextIfUnchanged(
          filePath,
          intendedAgent,
          {
            expected: snapshot,
            containmentRoot: canonicalRoot,
            expectedParentDirectory: { device: parent.dev, inode: parent.ino },
          },
          snapshot.mode,
        );
        assert.deepEqual(outcome.cleanupFailures, []);
      }
      return snapshot;
    },
  });

  assert.equal(injected, true);
  assert.equal(result.repositoryId, repositoryId);
  assert.equal(result.workspace, workspace);
  assert.equal(result.agentFileAction, 'unchanged');
  assert.equal(await readFile(agentPath, 'utf8'), intendedAgent);
});

test('use rejects desired agent bytes written in place on the planned inode', async () => {
  const root = await repository('concurrent-in-place-agent');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  await writeFile(agentPath, 'human header\n');
  const plannedInode = (await stat(agentPath)).ino;
  let injected = false;

  await assert.rejects(useRepository({
    root,
    databasePath,
    repositoryId: 'repo_in_place_agent',
    workspace: 'project:in-place-agent',
  }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!injected && path.basename(filePath) === 'AGENTS.md') {
        injected = true;
        await writeFile(filePath, content, { mode });
        if (mode !== undefined) await chmod(filePath, mode);
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'CONFLICT'
    && /modified in place/u.test(error.message));

  assert.equal(injected, true);
  assert.equal((await stat(agentPath)).ino, plannedInode);
  assert.match(await readFile(agentPath, 'utf8'), /BEGIN KIOKUKO MANAGED BLOCK/u);
  await assert.rejects(access(bindingPath));
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('use waits for a concurrent binding to shed its temporary hard link before adoption', async () => {
  const root = await repository('concurrent-binding-link-transition');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  await writeFile(path.join(root, 'AGENTS.md'), 'human header\n');
  const linkedTargetReached = deferred();
  const releasePeer = deferred();
  let injected = false;
  let peerWrite: ReturnType<typeof atomicWriteTextIfUnchanged> | undefined;

  const result = await useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!injected && path.basename(filePath) === '.kiokuko.json') {
        injected = true;
        const proposed = JSON.parse(content) as Record<string, unknown>;
        const winner = `${JSON.stringify({
          ...proposed,
          repositoryId: 'repo_link_transition_winner',
          workspace: 'project:link-transition-winner',
        }, null, 2)}\n`;
        peerWrite = atomicWriteTextIfUnchanged(filePath, winner, expectation, mode, {
          afterLink: async () => {
            linkedTargetReached.resolve();
            await releasePeer.promise;
          },
        });
        void peerWrite.catch(() => undefined);
        await linkedTargetReached.promise;
        try {
          return await atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
        } finally {
          setTimeout(releasePeer.resolve, 30);
        }
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  });

  assert.equal(injected, true);
  if (peerWrite === undefined) assert.fail('concurrent binding writer did not start');
  await peerWrite;
  assert.equal(result.repositoryId, 'repo_link_transition_winner');
  assert.equal(result.workspace, 'project:link-transition-winner');
  assert.equal((await stat(bindingPath)).nlink, 1);
  assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /^human header\n/u);
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repositories')
        .get<{ repositoryId: string }>()?.repositoryId,
      'repo_link_transition_winner',
    );
  } finally {
    database.close();
  }
});

test('use starting after a concurrent binding link waits for its cleanup boundary', async () => {
  const root = await repository('initial-binding-link-transition');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  await writeFile(path.join(root, 'AGENTS.md'), 'human header\n');
  const parent = await stat(root, { bigint: true });
  const winner = `${JSON.stringify({
    schemaVersion: 1,
    repositoryId: 'repo_initial_link_winner',
    workspace: 'project:initial-link-winner',
    agentFile: 'AGENTS.md',
    templateVersion: 20,
  }, null, 2)}\n`;
  const linkedTargetReached = deferred();
  const releasePeer = deferred();
  const peerWrite = atomicWriteTextIfUnchanged(
    bindingPath,
    winner,
    {
      expected: undefined,
      containmentRoot: root,
      expectedParentDirectory: { device: parent.dev, inode: parent.ino },
    },
    0o644,
    {
      afterLink: async () => {
        linkedTargetReached.resolve();
        await releasePeer.promise;
      },
    },
  );
  void peerWrite.catch(() => undefined);
  await linkedTargetReached.promise;

  const concurrentUse = useRepository({ root, databasePath });
  void concurrentUse.catch(() => undefined);
  await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
  assert.equal((await stat(bindingPath)).nlink, 2);
  releasePeer.resolve();
  await peerWrite;
  const result = await concurrentUse;

  assert.equal(result.repositoryId, 'repo_initial_link_winner');
  assert.equal(result.workspace, 'project:initial-link-winner');
  assert.equal((await stat(bindingPath)).nlink, 1);
  assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /^human header\n/u);
});

test('use retries when a concurrent setup installs the binding after the initial read', async () => {
  const root = await repository('initial-binding-observation-race');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const originalAgent = 'human header\n';
  await writeFile(agentPath, originalAgent);
  const parent = await stat(root, { bigint: true });
  const winner = {
    schemaVersion: 1 as const,
    repositoryId: 'repo_initial_observation_winner',
    workspace: 'project:initial-observation-winner',
    agentFile: 'AGENTS.md',
    templateVersion: AGENT_TEMPLATE_VERSION,
  };
  const winnerBinding = `${JSON.stringify(winner, null, 2)}\n`;
  const winnerAgent = renderAgentFile(originalAgent, {
    repositoryId: winner.repositoryId,
    workspace: winner.workspace,
    cliCommand: 'kiokuko-ai',
    templateVersion: winner.templateVersion,
  }).content;
  let injected = false;

  const result = await useRepository({ root, databasePath }, {
    readBindingFileForConvergence: async (filePath, options) => {
      const snapshot = await readRegularFile(filePath, options);
      if (!injected) {
        injected = true;
        const bindingOutcome = await atomicWriteTextIfUnchanged(
          bindingPath,
          winnerBinding,
          {
            expected: snapshot,
            containmentRoot: root,
            expectedParentDirectory: { device: parent.dev, inode: parent.ino },
          },
          0o644,
        );
        assert.deepEqual(bindingOutcome.cleanupFailures, []);
        const plannedAgent = await readRegularFile(agentPath, { containmentRoot: root });
        if (plannedAgent === undefined) assert.fail('planned agent file is missing');
        const agentOutcome = await atomicWriteTextIfUnchanged(
          agentPath,
          winnerAgent,
          {
            expected: plannedAgent,
            containmentRoot: root,
            expectedParentDirectory: { device: parent.dev, inode: parent.ino },
          },
          plannedAgent.mode,
        );
        assert.deepEqual(agentOutcome.cleanupFailures, []);
      }
      return snapshot;
    },
  });

  assert.equal(injected, true);
  assert.equal(result.repositoryId, winner.repositoryId);
  assert.equal(result.workspace, winner.workspace);
  assert.equal(result.bindingAction, 'unchanged');
  assert.equal(result.agentFileAction, 'unchanged');
  assert.equal(await readFile(bindingPath, 'utf8'), winnerBinding);
  assert.equal(await readFile(agentPath, 'utf8'), winnerAgent);
});

test('use never adopts an existing binding with retained quarantine cleanup', async () => {
  const root = await repository('binding-retained-cleanup');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const agentPath = path.join(root, 'AGENTS.md');
  await writeFile(agentPath, 'human header\n');
  const initial = await useRepository({
    root,
    databasePath,
    repositoryId: 'repo_binding_cleanup_before',
    workspace: 'project:binding-cleanup-before',
    noAgentFile: true,
  });
  const bindingPath = path.join(initial.repositoryRoot, '.kiokuko.json');
  const planned = await readRegularFile(bindingPath, { containmentRoot: initial.repositoryRoot });
  if (planned === undefined) assert.fail('planned binding is missing');
  const parent = await stat(initial.repositoryRoot, { bigint: true });
  const winner = `${JSON.stringify({
    schemaVersion: 1,
    repositoryId: 'repo_binding_cleanup_after',
    workspace: 'project:binding-cleanup-after',
    agentFile: 'AGENTS.md',
    templateVersion: initial.templateVersion,
  }, null, 2)}\n`;
  const cleanupFailure = new Error('retained binding previous cleanup');
  const peerOutcome = await atomicWriteTextIfUnchanged(
    bindingPath,
    winner,
    {
      expected: planned,
      containmentRoot: initial.repositoryRoot,
      expectedParentDirectory: { device: parent.dev, inode: parent.ino },
    },
    planned.mode,
    {
      beforeCleanup: async (artifactPath) => {
        if (artifactPath.includes('.previous.')) throw cleanupFailure;
      },
    },
  );
  assert.equal(peerOutcome.cleanupFailures.length, 1);
  assert.equal((await stat(bindingPath)).nlink, 1);
  const retained = (await readdir(initial.repositoryRoot))
    .filter((name) => name.startsWith('...kiokuko.json.') && name.endsWith('.cleanup'));
  assert.equal(retained.length, 1);
  let registrationCalls = 0;

  await assert.rejects(
    useRepository({ root, databasePath }, {
      registerRepositoryAndLocation: () => {
        registrationCalls += 1;
        throw new Error('registration must not run with retained binding cleanup');
      },
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && /binding mutation did not settle/u.test(error.message),
  );
  assert.equal(registrationCalls, 0);
  assert.equal(await readFile(bindingPath, 'utf8'), winner);
  assert.equal(await readFile(agentPath, 'utf8'), 'human header\n');
  const retainedName = retained[0];
  if (retainedName === undefined) assert.fail('retained binding cleanup artifact is missing');
  await unlink(path.join(initial.repositoryRoot, retainedName));
});

test('use waits for an identical concurrent atomic agent write to leave its quarantine window', async () => {
  const root = await repository('concurrent-quarantine-convergence');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const agentPath = path.join(root, 'AGENTS.md');
  await writeFile(agentPath, 'human header\n');
  const quarantineReached = deferred();
  const releaseConcurrentWriter = deferred();
  const linkedTargetReached = deferred();
  const releaseLinkedTarget = deferred();
  let injected = false;
  let observationRaceInjected = false;
  let concurrentWrite: ReturnType<typeof atomicWriteTextIfUnchanged> | undefined;

  const result = await useRepository({
    root,
    databasePath,
    repositoryId: 'repo_concurrent_quarantine',
    workspace: 'project:concurrent-quarantine',
  }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!injected && path.basename(filePath) === 'AGENTS.md') {
        injected = true;
        concurrentWrite = atomicWriteTextIfUnchanged(filePath, content, expectation, mode, {
          afterRename: async () => {
            quarantineReached.resolve();
            await releaseConcurrentWriter.promise;
          },
          afterLink: async () => {
            linkedTargetReached.resolve();
            setTimeout(releaseLinkedTarget.resolve, 30);
            await releaseLinkedTarget.promise;
          },
        });
        void concurrentWrite.catch(() => undefined);
        await quarantineReached.promise;
        try {
          return await atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
        } finally {
          if (!observationRaceInjected) setTimeout(releaseConcurrentWriter.resolve, 30);
        }
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
    readAgentFileForConvergence: async (filePath, options) => {
      const snapshot = await readRegularFile(filePath, options);
      if (injected
        && !observationRaceInjected
        && path.basename(filePath) === 'AGENTS.md'
        && snapshot === undefined) {
        observationRaceInjected = true;
        releaseConcurrentWriter.resolve();
        await linkedTargetReached.promise;
      }
      return snapshot;
    },
  });

  assert.equal(injected, true);
  assert.equal(observationRaceInjected, true);
  if (concurrentWrite === undefined) assert.fail('concurrent writer did not start');
  await concurrentWrite;
  await linkedTargetReached.promise;
  assert.equal(result.repositoryId, 'repo_concurrent_quarantine');
  assert.equal(result.workspace, 'project:concurrent-quarantine');
  const agent = await readFile(agentPath, 'utf8');
  assert.match(agent, /^human header\n/u);
  assert.equal((agent.match(/BEGIN KIOKUKO MANAGED BLOCK/gu) ?? []).length, 1);
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('use never plans a missing agent file from another writer\'s quarantine window', async () => {
  const root = await repository('concurrent-planning-quarantine');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const initialAgentPath = path.join(root, 'AGENTS.md');
  await writeFile(initialAgentPath, 'human header\n');
  const initial = await useRepository({
    root,
    databasePath,
    repositoryId: 'repo_planning_quarantine',
    workspace: 'project:planning-quarantine',
    noAgentFile: true,
  });
  const agentPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const planned = await readRegularFile(agentPath, { containmentRoot: initial.repositoryRoot });
  if (planned === undefined) assert.fail('planned agent file is missing');
  const parent = await stat(initial.repositoryRoot, { bigint: true });
  const intended = renderAgentFile(planned.content, {
    repositoryId: initial.repositoryId,
    workspace: initial.workspace,
    cliCommand: 'kiokuko-ai',
    templateVersion: initial.templateVersion,
  }).content;
  const quarantineReached = deferred();
  const releasePeer = deferred();
  const peerWrite = atomicWriteTextIfUnchanged(
    agentPath,
    intended,
    {
      expected: planned,
      containmentRoot: initial.repositoryRoot,
      expectedParentDirectory: { device: parent.dev, inode: parent.ino },
    },
    planned.mode,
    {
      afterRename: async () => {
        quarantineReached.resolve();
        await releasePeer.promise;
      },
    },
  );
  void peerWrite.catch(() => undefined);
  await quarantineReached.promise;

  const concurrentUse = useRepository({ root, databasePath });
  void concurrentUse.catch(() => undefined);
  await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
  await assert.rejects(access(agentPath));
  releasePeer.resolve();
  await peerWrite;
  const result = await concurrentUse;

  assert.equal(result.repositoryId, initial.repositoryId);
  assert.equal(result.agentFileAction, 'unchanged');
  assert.match(await readFile(agentPath, 'utf8'), /^human header\n/u);
  assert.deepEqual(
    (await readdir(initial.repositoryRoot)).filter((name) => name.startsWith('.AGENTS.md.')),
    [],
  );
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('use never adopts a concurrent agent result with retained quarantine cleanup', async () => {
  const root = await repository('concurrent-retained-cleanup');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  await writeFile(path.join(root, 'AGENTS.md'), 'human header\n');
  const initial = await useRepository({
    root,
    databasePath,
    repositoryId: 'repo_retained_cleanup',
    workspace: 'project:retained-cleanup',
    noAgentFile: true,
  });
  const agentPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const planned = await readRegularFile(agentPath, { containmentRoot: initial.repositoryRoot });
  if (planned === undefined) assert.fail('planned agent file is missing');
  const parent = await stat(initial.repositoryRoot, { bigint: true });
  const intended = renderAgentFile(planned.content, {
    repositoryId: initial.repositoryId,
    workspace: initial.workspace,
    cliCommand: 'kiokuko-ai',
    templateVersion: initial.templateVersion,
  }).content;
  const cleanupFailure = new Error('retained previous cleanup');
  const peerOutcome = await atomicWriteTextIfUnchanged(
    agentPath,
    intended,
    {
      expected: planned,
      containmentRoot: initial.repositoryRoot,
      expectedParentDirectory: { device: parent.dev, inode: parent.ino },
    },
    planned.mode,
    {
      beforeCleanup: async (artifactPath) => {
        if (artifactPath.includes('.previous.')) throw cleanupFailure;
      },
    },
  );
  assert.equal(peerOutcome.cleanupFailures.length, 1);
  const retained = (await readdir(initial.repositoryRoot))
    .filter((name) => name.startsWith('..AGENTS.md.') && name.endsWith('.cleanup'));
  assert.equal(retained.length, 1);

  await assert.rejects(
    useRepository({ root, databasePath }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && /did not settle/u.test(error.message),
  );
  assert.equal(await readFile(agentPath, 'utf8'), intended);
  assert.match(await readFile(agentPath, 'utf8'), /^human header\n/u);
  const retainedName = retained[0];
  if (retainedName === undefined) assert.fail('retained cleanup artifact is missing');
  await unlink(path.join(initial.repositoryRoot, retainedName));
});

test('settled agent planning rejects an exact replacement during retained-cleanup wait', async () => {
  const root = await repository('concurrent-cleanup-identity-swap');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  await writeFile(path.join(root, 'AGENTS.md'), 'human header\n');
  const initial = await useRepository({
    root,
    databasePath,
    repositoryId: 'repo_cleanup_identity_swap',
    workspace: 'project:cleanup-identity-swap',
    noAgentFile: true,
  });
  const agentPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const planned = await readRegularFile(agentPath, { containmentRoot: initial.repositoryRoot });
  if (planned === undefined) assert.fail('planned agent file is missing');
  const parent = await stat(initial.repositoryRoot, { bigint: true });
  const intended = renderAgentFile(planned.content, {
    repositoryId: initial.repositoryId,
    workspace: initial.workspace,
    cliCommand: 'kiokuko-ai',
    templateVersion: initial.templateVersion,
  }).content;
  const peerOutcome = await atomicWriteTextIfUnchanged(
    agentPath,
    intended,
    {
      expected: planned,
      containmentRoot: initial.repositoryRoot,
      expectedParentDirectory: { device: parent.dev, inode: parent.ino },
    },
    planned.mode,
    {
      beforeCleanup: async (artifactPath) => {
        if (artifactPath.includes('.previous.')) throw new Error('retain cleanup for identity swap');
      },
    },
  );
  assert.equal(peerOutcome.cleanupFailures.length, 1);
  const retainedName = (await readdir(initial.repositoryRoot))
    .find((name) => name.startsWith('..AGENTS.md.') && name.endsWith('.cleanup'));
  if (retainedName === undefined) assert.fail('retained cleanup artifact is missing');
  const firstFinalInode = (await stat(agentPath)).ino;

  const concurrentUse = useRepository({ root, databasePath });
  void concurrentUse.catch(() => undefined);
  await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
  const replacementPath = path.join(initial.repositoryRoot, 'exact-replacement.md');
  await writeFile(replacementPath, intended, { mode: planned.mode });
  await chmod(replacementPath, planned.mode);
  await rename(replacementPath, agentPath);
  await unlink(path.join(initial.repositoryRoot, retainedName));

  await assert.rejects(
    concurrentUse,
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT',
  );
  assert.notEqual((await stat(agentPath)).ino, firstFinalInode);
  assert.equal(await readFile(agentPath, 'utf8'), intended);
});

test('post-CAS convergence rejects an exact agent result with retained cleanup', async () => {
  const root = await repository('post-cas-retained-cleanup');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  await writeFile(agentPath, 'human header\n');
  let injected = false;
  let peerCleanupFailures = 0;

  await assert.rejects(useRepository({
    root,
    databasePath,
    repositoryId: 'repo_post_cas_cleanup',
    workspace: 'project:post-cas-cleanup',
  }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!injected && path.basename(filePath) === 'AGENTS.md') {
        injected = true;
        const peerOutcome = await atomicWriteTextIfUnchanged(
          filePath,
          content,
          expectation,
          mode,
          {
            beforeCleanup: async (artifactPath) => {
              if (artifactPath.includes('.previous.')) {
                throw new Error('retain post-CAS previous cleanup');
              }
            },
          },
        );
        peerCleanupFailures = peerOutcome.cleanupFailures.length;
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'CONFLICT'
    && /target mutation did not settle/u.test(error.message));

  assert.equal(injected, true);
  assert.equal(peerCleanupFailures, 1);
  await assert.rejects(access(bindingPath));
  assert.match(await readFile(agentPath, 'utf8'), /^human header\n/u);
  const retained = (await readdir(root))
    .filter((name) => name.startsWith('..AGENTS.md.') && name.endsWith('.cleanup'));
  assert.equal(retained.length, 1);
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
  const retainedName = retained[0];
  if (retainedName === undefined) assert.fail('retained post-CAS cleanup artifact is missing');
  await unlink(path.join(root, retainedName));
});

test('use never adopts an exact concurrent agent target while a hard-link alias remains', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await repository('concurrent-hardlink-rejection');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const agentPath = path.join(root, 'AGENTS.md');
  const aliasPath = path.join(root, 'attacker-alias.md');
  await writeFile(agentPath, 'human header\n');
  let bindingInjected = false;
  let aliasInjected = false;

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (mode === undefined) assert.fail('use must provide an explicit file mode');
      if (!bindingInjected && path.basename(filePath) === '.kiokuko.json') {
        bindingInjected = true;
        const proposed = JSON.parse(content) as Record<string, unknown>;
        await writeFile(filePath, `${JSON.stringify({
          ...proposed,
          repositoryId: 'repo_concurrent_hardlink',
          workspace: 'project:concurrent-hardlink',
        }, null, 2)}\n`, { mode });
        await chmod(filePath, mode);
      } else if (!aliasInjected && path.basename(filePath) === 'AGENTS.md') {
        aliasInjected = true;
        await writeFile(filePath, content, { mode });
        await chmod(filePath, mode);
        await link(filePath, aliasPath);
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'SECURITY_REJECTION'
    && /hard-linked concurrent target/u.test(error.message));

  assert.equal(bindingInjected, true);
  assert.equal(aliasInjected, true);
  assert.equal(await readFile(agentPath, 'utf8'), await readFile(aliasPath, 'utf8'));
  assert.equal((await stat(agentPath)).nlink, 2);
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('use does not retry disappearance after a create-only agent CAS conflict', async () => {
  const root = await repository('concurrent-create-disappearance');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  let injected = false;

  await assert.rejects(useRepository({
    root,
    databasePath,
    repositoryId: 'repo_create_disappearance',
    workspace: 'project:create-disappearance',
  }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!injected && path.basename(filePath) === 'AGENTS.md') {
        injected = true;
        await writeFile(filePath, content, { mode });
        if (mode !== undefined) await chmod(filePath, mode);
        try {
          return await atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
        } catch (error) {
          await unlink(filePath);
          throw error;
        }
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'CONFLICT');

  assert.equal(injected, true);
  await assert.rejects(access(bindingPath));
  await assert.rejects(access(agentPath));
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('initial binding convergence never adopts a replacement repository-root identity', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await repository('concurrent-root-replacement');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  let replacementRoot = '';
  let displacedRoot = '';
  let winnerBinding = '';
  let bindingAttempts = 0;

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (path.basename(filePath) === '.kiokuko.json') {
        bindingAttempts += 1;
        replacementRoot = path.dirname(filePath);
        displacedRoot = `${replacementRoot}.displaced`;
        const proposed = JSON.parse(content) as Record<string, unknown>;
        winnerBinding = `${JSON.stringify({
          ...proposed,
          repositoryId: 'repo_replacement_root_winner',
          workspace: 'project:replacement-root-winner',
        }, null, 2)}\n`;
        await rename(replacementRoot, displacedRoot);
        execFileSync('git', ['init', '-q', replacementRoot]);
        await writeFile(filePath, winnerBinding, { mode });
        if (mode !== undefined) await chmod(filePath, mode);
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'CONFLICT');

  assert.equal(bindingAttempts, 1);
  assert.equal(await readFile(path.join(replacementRoot, '.kiokuko.json'), 'utf8'), winnerBinding);
  await assert.rejects(access(path.join(replacementRoot, 'AGENTS.md')));
  await assert.rejects(access(path.join(displacedRoot, '.kiokuko.json')));
  await assert.rejects(access(path.join(displacedRoot, 'AGENTS.md')));
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('initial binding convergence pins a custom agent-file parent across the retry', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await repository('concurrent-agent-parent-replacement');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const parentPath = path.join(root, 'nested');
  const displacedParent = path.join(root, 'nested-displaced');
  const bindingPath = path.join(root, '.kiokuko.json');
  await mkdir(parentPath);
  let bindingAttempts = 0;
  let winnerBinding = '';

  await assert.rejects(useRepository({ root, databasePath, agentFile: 'nested/AGENTS.md' }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (path.basename(filePath) === '.kiokuko.json') {
        bindingAttempts += 1;
        const proposed = JSON.parse(content) as Record<string, unknown>;
        winnerBinding = `${JSON.stringify({
          ...proposed,
          repositoryId: 'repo_replacement_agent_parent_winner',
          workspace: 'project:replacement-agent-parent-winner',
        }, null, 2)}\n`;
        await rename(parentPath, displacedParent);
        await mkdir(parentPath);
        await writeFile(filePath, winnerBinding, { mode });
        if (mode !== undefined) await chmod(filePath, mode);
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), /agentFile parent changed during concurrent binding convergence/i);

  assert.equal(bindingAttempts, 1);
  assert.equal(await readFile(bindingPath, 'utf8'), winnerBinding);
  await assert.rejects(access(path.join(parentPath, 'AGENTS.md')));
  await assert.rejects(access(path.join(displacedParent, 'AGENTS.md')));
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('use fails closed on a non-identical agent CAS after one binding convergence attempt', async () => {
  const root = await repository('concurrent-conflict');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  await writeFile(agentPath, 'human header\n');
  let bindingAttempts = 0;
  let agentAttempts = 0;

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (mode === undefined) assert.fail('use must provide an explicit file mode');
      if (path.basename(filePath) === '.kiokuko.json') {
        bindingAttempts += 1;
        const proposed = JSON.parse(content) as Record<string, unknown>;
        await writeFile(filePath, `${JSON.stringify({
          ...proposed,
          repositoryId: 'repo_concurrent_winner',
          workspace: 'project:concurrent-winner',
        }, null, 2)}\n`, { mode });
        await chmod(filePath, mode);
      } else if (path.basename(filePath) === 'AGENTS.md') {
        agentAttempts += 1;
        await writeFile(filePath, 'concurrent human edit\n', { mode });
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT');

  assert.equal(bindingAttempts, 1);
  assert.equal(agentAttempts, 1);
  assert.equal(await readFile(agentPath, 'utf8'), 'concurrent human edit\n');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as { repositoryId: string };
  assert.equal(binding.repositoryId, 'repo_concurrent_winner');
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('use never rolls back exact concurrent binding and agent-file results it does not own', async () => {
  const root = await repository('concurrent-unowned');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const registrationFailure = new Error('registration failed after exact convergence');
  await writeFile(agentPath, 'human header\n');

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (mode === undefined) assert.fail('use must provide an explicit file mode');
      if (path.basename(filePath) === '.kiokuko.json') {
        const proposed = JSON.parse(content) as Record<string, unknown>;
        await writeFile(filePath, `${JSON.stringify({
          ...proposed,
          repositoryId: 'repo_concurrent_owner',
          workspace: 'project:concurrent-owner',
        }, null, 2)}\n`, { mode });
        await chmod(filePath, mode);
      } else if (path.basename(filePath) === 'AGENTS.md') {
        const peerOutcome = await atomicWriteTextIfUnchanged(
          filePath,
          content,
          expectation,
          mode,
        );
        assert.deepEqual(peerOutcome.cleanupFailures, []);
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
    registerRepositoryAndLocation: () => { throw registrationFailure; },
  }), (error: unknown) => error === registrationFailure);

  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as { repositoryId: string };
  assert.equal(binding.repositoryId, 'repo_concurrent_owner');
  const agent = await readFile(agentPath, 'utf8');
  assert.match(agent, /^human header\n/);
  assert.equal((agent.match(/BEGIN KIOKUKO MANAGED BLOCK/g) ?? []).length, 1);
  assert.equal((agent.match(/END KIOKUKO MANAGED BLOCK/g) ?? []).length, 1);
});

test('use rejects noncanonical or broadly-permissioned concurrent bindings', { skip: process.platform === 'win32' }, async () => {
  for (const variant of ['noncanonical', 'broad-mode'] as const) {
    const root = await repository(`concurrent-${variant}`);
    const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
    const databasePath = path.join(data, 'kiokuko-ai.sqlite');
    const bindingPath = path.join(root, '.kiokuko.json');
    const agentPath = path.join(root, 'AGENTS.md');
    await writeFile(agentPath, 'human header\n');
    let bindingAttempts = 0;

    await assert.rejects(useRepository({ root, databasePath }, {
      atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
        if (path.basename(filePath) === '.kiokuko.json') {
          bindingAttempts += 1;
          const concurrent = {
            ...(JSON.parse(content) as Record<string, unknown>),
            repositoryId: 'repo_concurrent_incompatible',
            workspace: 'project:concurrent-incompatible',
          };
          const serialized = variant === 'noncanonical'
            ? `${JSON.stringify(concurrent)}\n`
            : `${JSON.stringify(concurrent, null, 2)}\n`;
          await writeFile(filePath, serialized, { mode });
          if (variant === 'broad-mode') await chmod(filePath, 0o666);
        }
        return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
      },
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && /incompatible/u.test(error.message));

    assert.equal(bindingAttempts, 1);
    assert.equal(await readFile(agentPath, 'utf8'), 'human header\n');
    const database = openConnection(databasePath);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
    } finally {
      database.close();
    }
    await access(bindingPath);
  }
});

test('use creates version-23 binding, result, and repository metadata', async () => {
  const root = await repository('version');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const result = await useRepository({ root, databasePath });
  const binding = JSON.parse(await readFile(path.join(root, '.kiokuko.json'), 'utf8')) as { templateVersion: number };
  assert.equal(result.templateVersion, 23);
  assert.equal(binding.templateVersion, 23);

  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT agent_template_version AS version FROM repositories WHERE repository_id = ?').get<{ version: number }>(result.repositoryId)?.version, 23);
  } finally {
    database.close();
  }
});


test('use upgrades a version-1 binding and managed block without changing identity or human bytes', async () => {
  const root = await repository('upgrade');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const first = await useRepository({ root, databasePath, workspace: 'upgrade-workspace' });
  const bindingPath = path.join(root, '.kiokuko.json');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as Record<string, unknown>;
  await writeFile(bindingPath, `${JSON.stringify({ ...binding, templateVersion: 1 }, null, 2)}\n`);
  const oldManagedBlock = [
    '<!-- BEGIN KIOKUKO MANAGED BLOCK -->',
    '<!-- kiokuko-template-version: 1 -->',
    'legacy managed content',
    '<!-- END KIOKUKO MANAGED BLOCK -->',
  ].join('\r\n');
  await writeFile(path.join(root, 'AGENTS.md'), `human before\r\n${oldManagedBlock}\r\nhuman after\r\n`);

  const upgraded = await useRepository({ root, databasePath });
  const upgradedAgent = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const upgradedBinding = JSON.parse(await readFile(bindingPath, 'utf8')) as { repositoryId: string; workspace: string; templateVersion: number };
  assert.equal(upgraded.agentFileAction, 'updated');
  assert.equal(upgraded.bindingAction, 'updated');
  assert.equal(upgraded.templateVersion, 23);
  assert.equal(upgradedBinding.repositoryId, first.repositoryId);
  assert.equal(upgradedBinding.workspace, 'upgrade-workspace');
  assert.equal(upgradedBinding.templateVersion, 23);
  assert.match(upgradedAgent, /^human before\r\n/);
  assert.match(upgradedAgent, /<!-- kiokuko-template-version: 23 -->/);
  assert.match(upgradedAgent, /\r\nhuman after\r\n$/);

  const repeatedAgent = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const repeated = await useRepository({ root, databasePath });
  assert.equal(repeated.agentFileAction, 'unchanged');
  assert.equal(repeated.bindingAction, 'unchanged');
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), repeatedAgent);

  const database = openConnection(databasePath);
  try {
    const row = database.prepare('SELECT repository_id AS repositoryId, workspace, agent_template_version AS version FROM repositories WHERE repository_id = ?').get<{ repositoryId: string; workspace: string; version: number }>(first.repositoryId);
    assert.equal(row?.repositoryId, first.repositoryId);
    assert.equal(row?.workspace, 'upgrade-workspace');
    assert.equal(row?.version, 23);
  } finally {
    database.close();
  }
});

test('use rejects a future binding version before mutating files or repository metadata', async () => {
  const root = await repository('future-binding-version');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const initial = await useRepository({ root, databasePath });
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as Record<string, unknown>;
  const futureBinding = `${JSON.stringify({ ...binding, templateVersion: 24 }, null, 2)}\n`;
  await writeFile(bindingPath, futureBinding);
  const agentBefore = await readFile(agentPath, 'utf8');

  await assert.rejects(
    useRepository({ root, databasePath }),
    /binding templateVersion 24 is newer than supported version 23/i,
  );

  assert.equal(await readFile(bindingPath, 'utf8'), futureBinding);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT agent_template_version AS version FROM repositories WHERE repository_id = ?')
        .get<{ version: number }>(initial.repositoryId)?.version,
       23,
    );
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
      initial.repositoryId,
    );
  } finally {
    database.close();
  }
});

test('use rejects future managed-block versions at current and retired agent paths without partial mutation', async () => {
  for (const target of ['current', 'retired'] as const) {
    const root = await repository(`future-managed-block-${target}`);
    const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
    const databasePath = path.join(data, 'kiokuko-ai.sqlite');
    const initial = await useRepository({ root, databasePath });
    const bindingPath = path.join(root, '.kiokuko.json');
    const oldAgentPath = path.join(root, 'AGENTS.md');
    const newAgentPath = path.join(root, 'nested', 'AGENTS.md');
    const futureAgent = renderManagedBlock({
      repositoryId: initial.repositoryId,
      workspace: initial.workspace,
      cliCommand: 'kiokuko-ai',
      templateVersion: 24,
    });
    await writeFile(oldAgentPath, futureAgent);
    if (target === 'retired') await mkdir(path.dirname(newAgentPath));
    const bindingBefore = await readFile(bindingPath, 'utf8');

    await assert.rejects(
      useRepository({
        root,
        databasePath,
        ...(target === 'retired' ? { agentFile: 'nested/AGENTS.md' } : {}),
      }),
      /agentFile uses managed template version 24, newer than supported version 23/i,
    );

    assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
    assert.equal(await readFile(oldAgentPath, 'utf8'), futureAgent);
    await assert.rejects(access(newAgentPath));
    const database = openConnection(databasePath);
    try {
      assert.equal(
        database.prepare('SELECT agent_template_version AS version FROM repositories WHERE repository_id = ?')
          .get<{ version: number }>(initial.repositoryId)?.version,
         23,
      );
      assert.equal(
        database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
          .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
        initial.repositoryId,
      );
    } finally {
      database.close();
    }
  }
});

test('use rejects a managed block with no version declaration without partial mutation', async () => {
  const root = await repository('missing-managed-block-version');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const initial = await useRepository({ root, databasePath });
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const unversionedAgent = (await readFile(agentPath, 'utf8'))
    .replace(/^<!-- kiokuko-template-version: [1-9][0-9]* -->\n/mu, '');
  await writeFile(agentPath, unversionedAgent);

  await assert.rejects(useRepository({ root, databasePath }), /missing.*template-version declaration/i);

  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), unversionedAgent);
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT agent_template_version AS version FROM repositories WHERE repository_id = ?')
        .get<{ version: number }>(initial.repositoryId)?.version,
       23,
    );
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
      initial.repositoryId,
    );
  } finally {
    database.close();
  }
});

test('use rejects future database version metadata and restores force-rebind file writes', async () => {
  const root = await repository('future-database-version');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const initial = await useRepository({ root, databasePath });
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const agentBefore = await readFile(agentPath, 'utf8');
  const database = openConnection(databasePath);
  try {
    database.prepare('UPDATE repositories SET agent_template_version = 24 WHERE repository_id = ?')
      .run(initial.repositoryId);
  } finally {
    database.close();
  }

  await assert.rejects(
    useRepository({ root, databasePath }),
    /newer binding or agent-template version/i,
  );
  await assert.rejects(useRepository({
    root,
    databasePath,
    forceRebind: true,
    repositoryId: 'repo_future_database_target',
    workspace: 'project:future-database-target',
  }), /newer binding or agent-template version/i);

  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);
  const verified = openConnection(databasePath);
  try {
    const repositories = verified.prepare(`
          SELECT repository_id AS repositoryId, workspace,
                 agent_template_version AS agentTemplateVersion
          FROM repositories
          ORDER BY repository_id
        `).all<{
      repositoryId: string;
      workspace: string;
      agentTemplateVersion: number;
    }>();
    assert.equal(repositories.length, 1);
    assert.equal(repositories[0]?.repositoryId, initial.repositoryId);
    assert.equal(repositories[0]?.workspace, initial.workspace);
    assert.equal(repositories[0]?.agentTemplateVersion, 24);
    assert.equal(
      verified.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
      initial.repositoryId,
    );
  } finally {
    verified.close();
  }
});


test('use dry-run does not create database or repository files', async () => {
  const root = await repository('dry-run');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const result = await useRepository({ root, databasePath, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.templateVersion, 23);
  assert.equal(result.bindingAction, 'planned');
  assert.equal(result.agentFileAction, 'created');
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
  await assert.rejects(access(databasePath));
});

test('no-agent-file still upgrades version metadata without creating AGENTS.md', async () => {
  const root = await repository('no-agent-file');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const result = await useRepository({ root, databasePath, noAgentFile: true });
  const binding = JSON.parse(await readFile(path.join(root, '.kiokuko.json'), 'utf8')) as { templateVersion: number };
  assert.equal(result.templateVersion, 23);
  assert.equal(result.agentFile, null);
  assert.equal(result.agentFileAction, 'skipped');
  assert.equal(result.bindingAction, 'created');
  assert.equal(binding.templateVersion, 23);
  await assert.rejects(access(path.join(root, 'AGENTS.md')));

  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT agent_template_version AS version FROM repositories WHERE repository_id = ?').get<{ version: number }>(result.repositoryId)?.version, 23);
  } finally {
    database.close();
  }
});


test('use preserves human content and rejects malformed markers', async () => {
  const root = await repository('preserve');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(root, 'AGENTS.md'), 'human\n'));
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  await useRepository({ root, databasePath: path.join(data, 'db.sqlite3') });
  const agent = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agent, /^human\n/);
  const bindingPath = path.join(root, '.kiokuko.json');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const malformed = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n';
  await writeFile(path.join(root, 'AGENTS.md'), malformed);
  await assert.rejects(useRepository({ root, databasePath: path.join(data, 'db.sqlite3') }), /malformed/i);
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), malformed);
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
});

test('use rejects duplicate binding keys before database or agent-file mutation', async () => {
  const root = await repository('duplicate-binding');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const duplicateBinding = '{"schemaVersion":1,"repositoryId":"repo_first","repositoryId":"repo_second","workspace":"project:duplicate","agentFile":"AGENTS.md","templateVersion":8}\n';
  await writeFile(bindingPath, duplicateBinding);
  await writeFile(agentPath, 'human bytes\n');

  await assert.rejects(
    useRepository({ root, databasePath }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'VALIDATION_ERROR'
      && /unique keys/u.test(error.message),
  );
  assert.equal(await readFile(bindingPath, 'utf8'), duplicateBinding);
  assert.equal(await readFile(agentPath, 'utf8'), 'human bytes\n');
  await assert.rejects(access(databasePath));
});

test('use exposes the initiating failure and every failed restore after attempting them all', async () => {
  const root = await repository('restore-failures');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const initiatingFailure = new Error('initiating-write-sensitive-detail');
  const bindingRestoreFailure = new Error('binding-restore-sensitive-detail');
  const restoreAttempts: string[] = [];

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (path.basename(filePath) === 'AGENTS.md') throw initiatingFailure;
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
    unlinkRegularFileIfUnchanged: async (filePath) => {
      const restoredPath = String(filePath);
      restoreAttempts.push(restoredPath);
      throw bindingRestoreFailure;
    },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'Repository setup failed and file restoration also failed');
    assert.doesNotMatch(error.message, /sensitive|AGENTS|kiokuko/u);
    assert.equal(error.errors[0], initiatingFailure);
    assert.equal(error.errors[1], bindingRestoreFailure);
    return true;
  });

  assert.deepEqual(restoreAttempts.map((filePath) => path.basename(filePath)), [
    '.kiokuko.json',
  ]);
});

test('use rejects non-canonical or binding-alias agent-file paths before any persistent side effect, repeatedly', async () => {
  for (const requested of [
    '../AGENTS.md',
    '/tmp/absolute-agents.md',
    '.kiokuko.json',
    '.KIOKUKO.JSON',
    '.kiokuko.json/AGENTS.md',
    'nested/',
    'nested//AGENTS.md',
  ]) {
    const root = await repository('invalid-agent-path');
    const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
    const databasePath = path.join(data, 'db.sqlite3');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        useRepository({ root, databasePath, agentFile: requested }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
      );
    }
    await assert.rejects(access(path.join(root, '.kiokuko.json')));
    await assert.rejects(access(databasePath));
  }
});

test('use requires a nested agent-file parent to preexist in dry-run and live modes without partial mutation', async () => {
  const root = await repository('missing-agent-parent');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const bindingPath = path.join(root, '.kiokuko.json');
  const oldAgentPath = path.join(root, 'AGENTS.md');
  const missingParent = path.join(root, 'missing', 'nested');
  const missingAgentPath = path.join(missingParent, 'AGENTS.md');
  const initial = await useRepository({ root, databasePath });
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const agentBefore = await readFile(oldAgentPath, 'utf8');

  for (const dryRun of [true, false]) {
    await assert.rejects(
      useRepository({ root, databasePath, agentFile: 'missing/nested/AGENTS.md', dryRun }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'VALIDATION_ERROR'
        && /parent directory must already exist/iu.test(error.message),
    );
    assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
    assert.equal(await readFile(oldAgentPath, 'utf8'), agentBefore);
    await assert.rejects(access(missingParent));
    await assert.rejects(access(missingAgentPath));
  }

  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
      initial.repositoryId,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('use rejects an intermediate symlink escape before writing outside the repository', { skip: process.platform === 'win32' }, async () => {
  const root = await repository('agent-symlink');
  const outside = await mkdtemp(path.join(tmpdir(), 'kiokuko-use-outside-'));
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  await symlink(outside, path.join(root, 'linked'));

  await assert.rejects(
    useRepository({ root, databasePath, agentFile: 'linked/AGENTS.md' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SECURITY_REJECTION',
  );
  await assert.rejects(access(path.join(outside, 'AGENTS.md')));
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(databasePath));
});

test('use rejects a replaced or symlinked planned agent parent and rolls back every owned file', {
  skip: process.platform === 'win32',
}, async () => {
  for (const variant of ['directory', 'symlink'] as const) {
    const root = await repository(`agent-parent-race-${variant}`);
    const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-parent-outside-'));
    const databasePath = path.join(data, 'db.sqlite3');
    const initial = await useRepository({ root, databasePath });
    const bindingPath = path.join(initial.repositoryRoot, '.kiokuko.json');
    const oldAgentPath = path.join(initial.repositoryRoot, 'AGENTS.md');
    const parentPath = path.join(initial.repositoryRoot, 'nested');
    const displacedParent = path.join(initial.repositoryRoot, 'nested-displaced');
    const newAgentPath = path.join(parentPath, 'AGENTS.md');
    await mkdir(parentPath);
    const bindingBefore = await readFile(bindingPath, 'utf8');
    const agentBefore = await readFile(oldAgentPath, 'utf8');
    let replaced = false;

    await assert.rejects(useRepository({ root, databasePath, agentFile: 'nested/AGENTS.md' }, {
      atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
        if (!replaced && path.resolve(filePath) === newAgentPath) {
          replaced = true;
          await rename(parentPath, displacedParent);
          if (variant === 'directory') {
            await mkdir(parentPath);
            await writeFile(path.join(parentPath, 'concurrent.txt'), 'concurrent owner\n');
          } else {
            await symlink(outside, parentPath);
          }
        }
        return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
      },
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === (variant === 'directory' ? 'CONFLICT' : 'SECURITY_REJECTION'));

    assert.equal(replaced, true);
    assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
    assert.equal(await readFile(oldAgentPath, 'utf8'), agentBefore);
    await assert.rejects(access(path.join(displacedParent, 'AGENTS.md')));
    await assert.rejects(access(newAgentPath));
    if (variant === 'directory') {
      assert.equal(await readFile(path.join(parentPath, 'concurrent.txt'), 'utf8'), 'concurrent owner\n');
    } else {
      await assert.rejects(access(path.join(outside, 'AGENTS.md')));
    }
    const database = openConnection(databasePath);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 1);
    } finally {
      database.close();
    }
  }
});

test('use rejects an agentFile hard-link alias of the repository binding', { skip: process.platform === 'win32' }, async () => {
  const root = await repository('agent-binding-hardlink');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const aliasPath = path.join(root, 'BINDING.md');
  await useRepository({ root, databasePath });
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const agentBefore = await readFile(agentPath, 'utf8');
  await link(bindingPath, aliasPath);

  await assert.rejects(
    useRepository({ root, databasePath, agentFile: 'BINDING.md' }),
    /binding file/i,
  );
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(aliasPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);
});

test('use rejects a previous agentFile hard-link alias of the repository binding before relocation', { skip: process.platform === 'win32' }, async () => {
  const root = await repository('previous-agent-binding-hardlink');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const bindingPath = path.join(root, '.kiokuko.json');
  const originalAgentPath = path.join(root, 'AGENTS.md');
  const aliasPath = path.join(root, 'BINDING.md');
  const replacementPath = path.join(root, 'replacement', 'AGENTS.md');
  await useRepository({ root, databasePath });
  const originalAgent = await readFile(originalAgentPath, 'utf8');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as Record<string, unknown>;
  const aliasedBinding = `${JSON.stringify({ ...binding, agentFile: 'BINDING.md' }, null, 2)}\n`;
  await writeFile(bindingPath, aliasedBinding);
  await link(bindingPath, aliasPath);
  await mkdir(path.dirname(replacementPath));

  await assert.rejects(
    useRepository({ root, databasePath, agentFile: 'replacement/AGENTS.md' }),
    /hard-linked repository binding file/i,
  );
  assert.equal(await readFile(bindingPath, 'utf8'), aliasedBinding);
  assert.equal(await readFile(aliasPath, 'utf8'), aliasedBinding);
  assert.equal(await readFile(originalAgentPath, 'utf8'), originalAgent);
  await assert.rejects(access(replacementPath));
});

test('agent relocation rejects a previous target inside another atomic quarantine', async () => {
  const root = await repository('previous-agent-quarantine');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  await writeFile(path.join(root, 'AGENTS.md'), 'human header\n');
  const initial = await useRepository({
    root,
    databasePath,
    repositoryId: 'repo_previous_quarantine',
    workspace: 'project:previous-quarantine',
  });
  const bindingPath = path.join(initial.repositoryRoot, '.kiokuko.json');
  const previousPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const replacementPath = path.join(initial.repositoryRoot, 'NEW.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const planned = await readRegularFile(previousPath, { containmentRoot: initial.repositoryRoot });
  if (planned === undefined) assert.fail('previous agent file is missing');
  const parent = await stat(initial.repositoryRoot, { bigint: true });
  const quarantineReached = deferred();
  const releasePeer = deferred();
  const peerContent = `${planned.content}\npeer-owned edit\n`;
  const peerWrite = atomicWriteTextIfUnchanged(
    previousPath,
    peerContent,
    {
      expected: planned,
      containmentRoot: initial.repositoryRoot,
      expectedParentDirectory: { device: parent.dev, inode: parent.ino },
    },
    planned.mode,
    {
      afterRename: async () => {
        quarantineReached.resolve();
        await releasePeer.promise;
      },
    },
  );
  void peerWrite.catch(() => undefined);
  await quarantineReached.promise;

  await assert.rejects(
    useRepository({
      root,
      databasePath,
      agentFile: 'NEW.md',
      workspace: 'project:previous-quarantine-next',
      forceRebind: true,
    }),
    /Previous agentFile has a concurrent atomic mutation/u,
  );
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  await assert.rejects(access(previousPath));
  await assert.rejects(access(replacementPath));
  releasePeer.resolve();
  const peerOutcome = await peerWrite;
  assert.deepEqual(peerOutcome.cleanupFailures, []);
  assert.equal(await readFile(previousPath, 'utf8'), peerContent);
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
      initial.repositoryId,
    );
  } finally {
    database.close();
  }
});

test('use leaves no repository or location rows when agent installation fails', async () => {
  const root = await repository('file-failure-db');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const failure = new Error('agent installation failed');

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (path.basename(filePath) === 'AGENTS.md') throw failure;
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error === failure);

  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
});

test('use preserves committed files when database close fails after registration', async () => {
  const root = await repository('post-registration-close');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const closeFailure = new Error('post-commit-close-sentinel');

  await assert.rejects(useRepository({ root, databasePath }, {
    openConnection: openConnectionWithCloseFailure(closeFailure),
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.name, 'CommittedRegistrationCloseError');
    assert.equal(error.message, 'Repository registration committed, but closing the database connection failed');
    assert.deepEqual(error.errors, [closeFailure]);
    return true;
  });

  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as {
    repositoryId: string;
    workspace: string;
  };
  assert.match(await readFile(agentPath, 'utf8'), new RegExp(binding.repositoryId, 'u'));
  const database = openConnection(databasePath);
  try {
    const registration = database.prepare(`
        SELECT r.repository_id AS repositoryId, r.workspace AS workspace
        FROM repositories r
        JOIN repository_locations l ON l.repository_id = r.repository_id
      `).get<{ repositoryId: string; workspace: string }>();
    assert.equal(registration?.repositoryId, binding.repositoryId);
    assert.equal(registration?.workspace, binding.workspace);
  } finally {
    database.close();
  }
});

test('use preserves files when COMMIT succeeds but reports an uncertain transaction outcome', async () => {
  const root = await repository('uncertain-registration-commit');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const commitFailure = new Error('post-commit-transport-sentinel');

  await assert.rejects(useRepository({ root, databasePath }, {
    openConnection: openConnectionWithCommittedCommitFailure(commitFailure),
  }), (error: unknown) => {
    assert.ok(error instanceof TransactionCommitUncertainError);
    assert.equal(error.commitError, commitFailure);
    return true;
  });

  const binding = JSON.parse(await readFile(path.join(root, '.kiokuko.json'), 'utf8')) as {
    repositoryId: string;
    workspace: string;
  };
  assert.match(
    await readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    new RegExp(binding.repositoryId, 'u'),
  );
  const database = openConnection(databasePath);
  try {
    const registration = database.prepare(`
        SELECT r.repository_id AS repositoryId, r.workspace AS workspace
        FROM repositories r
        JOIN repository_locations l ON l.repository_id = r.repository_id
        WHERE r.repository_id = ?
      `).get<{ repositoryId: string; workspace: string }>(binding.repositoryId);
    assert.equal(registration?.repositoryId, binding.repositoryId);
    assert.equal(registration?.workspace, binding.workspace);
  } finally {
    database.close();
  }
});

test('use preserves files and aggregates close failure after an uncertain COMMIT outcome', async () => {
  const root = await repository('uncertain-registration-close');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const commitFailure = new Error('post-commit-transport-sentinel');
  const closeFailure = new Error('uncertain-close-sentinel');

  await assert.rejects(useRepository({ root, databasePath }, {
    openConnection: openConnectionWithCommittedCommitFailure(commitFailure, closeFailure),
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.name, 'UncertainRegistrationCloseError');
    assert.equal(
      error.message,
      'Repository registration may have committed, and closing the database connection also failed',
    );
    const registrationError = error.errors[0];
    assert.ok(registrationError instanceof TransactionCommitUncertainError);
    assert.equal(registrationError.commitError, commitFailure);
    assert.equal(error.errors[1], closeFailure);
    return true;
  });

  const binding = JSON.parse(await readFile(path.join(root, '.kiokuko.json'), 'utf8')) as {
    repositoryId: string;
    workspace: string;
  };
  assert.match(
    await readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    new RegExp(binding.repositoryId, 'u'),
  );
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE repository_id = ?')
        .get<{ repositoryId: string }>(binding.repositoryId)?.repositoryId,
      binding.repositoryId,
    );
  } finally {
    database.close();
  }
});

test('use aggregates registration and close failures before compensating every owned file', async () => {
  const root = await repository('registration-and-close-failure');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const registrationFailure = new Error('registration-failure-sentinel');
  const closeFailure = new Error('pre-commit-close-sentinel');

  await assert.rejects(useRepository({ root, databasePath }, {
    openConnection: openConnectionWithCloseFailure(closeFailure),
    registerRepositoryAndLocation: () => { throw registrationFailure; },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'Repository registration failed and closing the database connection also failed');
    assert.deepEqual(error.errors, [registrationFailure, closeFailure]);
    return true;
  });

  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('use rollback preserves a byte-identical binding replaced by another actor', async () => {
  const root = await repository('rollback-aba');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const bindingPath = path.join(root, '.kiokuko.json');
  const displacedPath = path.join(root, '.kiokuko.displaced');
  const laterFailure = new Error('later write failed');

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (path.basename(filePath) === 'AGENTS.md') {
        const identical = await readFile(bindingPath, 'utf8');
        await rename(bindingPath, displacedPath);
        await writeFile(bindingPath, identical);
        throw laterFailure;
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], laterFailure);
    assert.equal(error.errors[1] instanceof Error && 'code' in error.errors[1] && error.errors[1].code, 'CONFLICT');
    return true;
  });

  assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).schemaVersion, 1);
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('use rejects repository identity injection before database or file mutation', async () => {
  const root = await repository('identity-injection');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  await assert.rejects(
    useRepository({ root, databasePath, repositoryId: 'repo`\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(databasePath));
});

test('use compensates a committed write and exposes post-commit cleanup failure', async () => {
  const root = await repository('cleanup-partial-commit');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  let injected = false;

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!injected) {
        injected = true;
        return atomicWriteTextIfUnchanged(filePath, content, expectation, mode, {
          beforeCleanup: async () => { throw new Error('cleanup-sentinel'); },
        });
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error instanceof AggregateError
    && error.message === 'File mutation committed, but committed-artifact cleanup failed');

  assert.equal(injected, true);
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('use compensates a target committed before post-install validation fails', async () => {
  const root = await repository('post-install-partial-commit');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const sentinel = new Error('post-install-sentinel');
  let injected = false;

  await assert.rejects(useRepository({ root, databasePath }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!injected) {
        injected = true;
        return atomicWriteTextIfUnchanged(filePath, content, expectation, mode, {
          afterInstall: async () => { throw sentinel; },
        });
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
  }), (error: unknown) => error instanceof AtomicCommittedMutationError
    && error.operationError === sentinel);

  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('use rejects either reserved global identity before database or file mutation', async () => {
  for (const identity of [
    { workspace: 'global' },
    { repositoryId: 'kiokuko_global' },
  ]) {
    const root = await repository('reserved-global');
    const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
    const databasePath = path.join(data, 'db.sqlite3');
    await assert.rejects(
      useRepository({ root, databasePath, ...identity }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'VALIDATION_ERROR'
        && /reserved global/iu.test(error.message),
    );
    await assert.rejects(access(path.join(root, '.kiokuko.json')));
    await assert.rejects(access(path.join(root, 'AGENTS.md')));
    await assert.rejects(access(databasePath));
  }
});

test('force-rebind replaces the exact existing identity and rejects no-op force', async () => {
  const root = await repository('force-rebind');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const initial = await useRepository({
    root,
    databasePath,
    workspace: 'project:rebind-before',
  });
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const agentBefore = await readFile(agentPath, 'utf8');

  await assert.rejects(
    useRepository({ root, databasePath, forceRebind: true }),
    /requires a different target identity/i,
  );
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);

  await assert.rejects(
    useRepository({ root, databasePath, repositoryId: 'repo_unforced_replacement' }),
    /force-rebind/i,
  );
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);

  await assert.rejects(
    useRepository({
      root,
      databasePath,
      repositoryId: initial.repositoryId,
      workspace: 'project:rebind-after',
      forceRebind: true,
    }),
    /both a different repository ID and a different workspace/i,
  );
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);

  const rebound = await useRepository({
    root,
    databasePath,
    workspace: 'project:rebind-after',
    forceRebind: true,
  });
  assert.notEqual(rebound.repositoryId, initial.repositoryId);
  assert.equal(rebound.workspace, 'project:rebind-after');
  assert.equal(rebound.bindingAction, 'updated');
  assert.equal(rebound.agentFileAction, 'updated');
  assert.match(await readFile(agentPath, 'utf8'), /Workspace: `project:rebind-after`/u);
  assert.doesNotMatch(await readFile(agentPath, 'utf8'), /project:rebind-before/u);

  const database = openConnection(databasePath);
  try {
    const registered = database.prepare(`
        SELECT r.repository_id AS repositoryId, r.workspace AS workspace
        FROM repositories r
        JOIN repository_locations l ON l.repository_id = r.repository_id
        WHERE l.canonical_root = ?
      `).get<{ repositoryId: string; workspace: string }>(initial.repositoryRoot);
    assert.equal(registered?.repositoryId, rebound.repositoryId);
    assert.equal(registered?.workspace, 'project:rebind-after');
    assert.equal(
      database.prepare('SELECT workspace FROM repositories WHERE repository_id = ?')
        .get<{ workspace: string }>(initial.repositoryId)?.workspace,
      'project:rebind-before',
    );
  } finally {
    database.close();
  }

  const otherRoot = await repository('force-rebind-old-namespace');
  await assert.rejects(
    useRepository({ root: otherRoot, databasePath, workspace: 'project:rebind-before' }),
    /workspace.*another repository/i,
  );
  await assert.rejects(access(path.join(otherRoot, '.kiokuko.json')));
  await assert.rejects(access(path.join(otherRoot, 'AGENTS.md')));
});

test('force-rebind with no-agent-file rejects a stale managed block before any mutation', async () => {
  const root = await repository('force-rebind-no-agent-stale');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const initial = await useRepository({
    root,
    databasePath,
    workspace: 'project:no-agent-before',
  });
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const agentBefore = await readFile(agentPath, 'utf8');

  await assert.rejects(useRepository({
    root,
    databasePath,
    workspace: 'project:no-agent-after',
    forceRebind: true,
    noAgentFile: true,
  }), /no-agent-file.*managed block/i);

  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
      initial.repositoryId,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('no-agent-file accepts only a managed block already exact for the planned binding', async () => {
  const root = await repository('no-agent-exact');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  await useRepository({ root, databasePath });
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const agentBefore = await readFile(agentPath, 'utf8');

  const result = await useRepository({ root, databasePath, noAgentFile: true });

  assert.equal(result.bindingAction, 'unchanged');
  assert.equal(result.agentFileAction, 'skipped');
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);
});

test('no-agent-file rejects a stale managed block at a prospective relocation target before mutation', async () => {
  for (const variant of ['ordinary', 'force'] as const) {
    const root = await repository(`no-agent-stale-relocation-${variant}`);
    const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
    const databasePath = path.join(data, 'db.sqlite3');
    const initial = await useRepository({
      root,
      databasePath,
      workspace: `project:no-agent-relocate-before-${variant}`,
    });
    const bindingPath = path.join(initial.repositoryRoot, '.kiokuko.json');
    const oldAgentPath = path.join(initial.repositoryRoot, 'AGENTS.md');
    const prospectivePath = path.join(initial.repositoryRoot, 'OTHER.md');
    const bindingBefore = await readFile(bindingPath, 'utf8');
    const oldAgentBefore = await readFile(oldAgentPath, 'utf8');
    const prospectiveBefore = variant === 'force'
      ? oldAgentBefore
      : oldAgentBefore.replace(
          `Workspace: \`${initial.workspace}\``,
          'Workspace: `project:foreign-managed-block`',
        );
    if (variant === 'ordinary') {
      assert.notEqual(prospectiveBefore, oldAgentBefore);
    } else {
      assert.equal(prospectiveBefore, oldAgentBefore);
    }
    await writeFile(prospectivePath, prospectiveBefore);

    await assert.rejects(useRepository({
      root,
      databasePath,
      agentFile: 'OTHER.md',
      noAgentFile: true,
      ...(variant === 'force'
        ? { forceRebind: true, workspace: 'project:no-agent-relocate-after' }
        : {}),
    }), /no-agent-file.*stale managed block/i);

    assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
    assert.equal(await readFile(oldAgentPath, 'utf8'), oldAgentBefore);
    assert.equal(await readFile(prospectivePath, 'utf8'), prospectiveBefore);
    const database = openConnection(databasePath);
    try {
      assert.equal(
        database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
          .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
        initial.repositoryId,
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 1);
    } finally {
      database.close();
    }
  }
});

test('existing-binding transitions reject byte-identical concurrent agent replacement before registration', async () => {
  const root = await repository('rebind-exact-agent-cas');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const initial = await useRepository({
    root,
    databasePath,
    workspace: 'project:exact-agent-before',
  });
  const bindingPath = path.join(root, '.kiokuko.json');
  const agentPath = path.join(root, 'AGENTS.md');
  const plannedAgentPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  let replaced = false;
  let registrationCalls = 0;

  await assert.rejects(useRepository({
    root,
    databasePath,
    workspace: 'project:exact-agent-after',
    forceRebind: true,
  }, {
    atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
      if (!replaced && path.resolve(filePath) === plannedAgentPath) {
        replaced = true;
        await writeFile(filePath, content);
        if (mode !== undefined) await chmod(filePath, mode);
      }
      return atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
    },
    registerRepositoryAndLocation: () => {
      registrationCalls += 1;
      throw new Error('registration must not run after an agent CAS conflict');
    },
  }), (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'CONFLICT');

  assert.equal(replaced, true);
  assert.equal(registrationCalls, 0);
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.match(await readFile(agentPath, 'utf8'), /Workspace: `project:exact-agent-after`/u);
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT workspace FROM repositories WHERE repository_id = ?')
        .get<{ workspace: string }>(initial.repositoryId)?.workspace,
      'project:exact-agent-before',
    );
  } finally {
    database.close();
  }
});

test('force-rebind rolls repository files back when the exact database rebind conflicts', async () => {
  const sourceRoot = await repository('force-rebind-source');
  const targetRoot = await repository('force-rebind-target');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const source = await useRepository({
    root: sourceRoot,
    databasePath,
    workspace: 'project:source-owner',
  });
  const target = await useRepository({
    root: targetRoot,
    databasePath,
    workspace: 'project:occupied-target',
  });
  const bindingPath = path.join(sourceRoot, '.kiokuko.json');
  const agentPath = path.join(sourceRoot, 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const agentBefore = await readFile(agentPath, 'utf8');

  await assert.rejects(
    useRepository({
      root: sourceRoot,
      databasePath,
      workspace: target.workspace,
      forceRebind: true,
    }),
    /workspace.*another repository/i,
  );
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore);

  const database = openConnection(databasePath);
  try {
    const registered = database.prepare(`
        SELECT r.repository_id AS repositoryId, r.workspace AS workspace
        FROM repositories r
        JOIN repository_locations l ON l.repository_id = r.repository_id
        WHERE l.canonical_root = ?
      `).get<{ repositoryId: string; workspace: string }>(source.repositoryRoot);
    assert.equal(registered?.repositoryId, source.repositoryId);
    assert.equal(registered?.workspace, source.workspace);
    assert.equal(
      database.prepare('SELECT workspace FROM repositories WHERE repository_id = ?')
        .get<{ workspace: string }>(target.repositoryId)?.workspace,
      target.workspace,
    );
  } finally {
    database.close();
  }
});

test('force-rebind can move one exact location to an existing repository identity', async () => {
  const sourceRoot = await repository('force-rebind-existing-source');
  const targetRoot = await repository('force-rebind-existing-target');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const source = await useRepository({
    root: sourceRoot,
    databasePath,
    workspace: 'project:existing-source',
  });
  const target = await useRepository({
    root: targetRoot,
    databasePath,
    workspace: 'project:existing-target',
  });

  const rebound = await useRepository({
    root: sourceRoot,
    databasePath,
    repositoryId: target.repositoryId,
    workspace: target.workspace,
    forceRebind: true,
  });
  assert.equal(rebound.repositoryId, target.repositoryId);
  assert.equal(rebound.workspace, target.workspace);
  assert.match(await readFile(path.join(sourceRoot, 'AGENTS.md'), 'utf8'), new RegExp(target.repositoryId, 'u'));

  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(source.repositoryRoot)?.repositoryId,
      target.repositoryId,
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repository_id = ?')
        .get<{ count: number }>(source.repositoryId)?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test('changing agentFile removes only the old managed block and preserves human bytes and mode', { skip: process.platform === 'win32' }, async () => {
  const root = await repository('agent-relocate-human');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const oldPath = path.join(root, 'AGENTS.md');
  const newPath = path.join(root, 'config', 'AGENTS.md');
  await writeFile(oldPath, 'human-owned\n');
  await useRepository({ root, databasePath });
  await chmod(oldPath, 0o600);
  await mkdir(path.dirname(newPath));
  await writeFile(newPath, 'new-target-human-owned\n');
  await chmod(newPath, 0o640);

  const moved = await useRepository({ root, databasePath, agentFile: 'config/AGENTS.md' });
  assert.equal(moved.bindingAction, 'updated');
  assert.equal(moved.agentFileAction, 'created');
  assert.equal(await readFile(oldPath, 'utf8'), 'human-owned\n\n\n');
  assert.equal((await stat(oldPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(oldPath, 'utf8'), /KIOKUKO MANAGED BLOCK/u);
  assert.match(await readFile(newPath, 'utf8'), /^new-target-human-owned\n/u);
  assert.equal((await stat(newPath)).mode & 0o777, 0o640);
  assert.equal((await readFile(newPath, 'utf8').then((content) => content.match(/BEGIN KIOKUKO MANAGED BLOCK/g) ?? [])).length, 1);
  assert.equal(
    (JSON.parse(await readFile(path.join(root, '.kiokuko.json'), 'utf8')) as { agentFile: string }).agentFile,
    'config/AGENTS.md',
  );

  const repeated = await useRepository({ root, databasePath });
  assert.equal(repeated.bindingAction, 'unchanged');
  assert.equal(repeated.agentFile, path.join(repeated.repositoryRoot, 'config', 'AGENTS.md'));
  assert.equal(await readFile(oldPath, 'utf8'), 'human-owned\n\n\n');
});

test('changing agentFile deletes a managed-only old file and restores it on later failure', { skip: process.platform === 'win32' }, async () => {
  const root = await repository('agent-relocate-delete');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const bindingPath = path.join(root, '.kiokuko.json');
  const oldPath = path.join(root, 'AGENTS.md');
  const newPath = path.join(root, 'nested', 'AGENTS.md');
  await useRepository({ root, databasePath });
  await chmod(oldPath, 0o600);
  await mkdir(path.dirname(newPath));
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const oldBefore = await readFile(oldPath, 'utf8');
  const registrationFailure = new Error('rebind registration sentinel');

  await assert.rejects(useRepository({
    root,
    databasePath,
    agentFile: 'nested/AGENTS.md',
  }, {
    registerRepositoryAndLocation: () => { throw registrationFailure; },
  }), (error: unknown) => error === registrationFailure);
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(oldPath, 'utf8'), oldBefore);
  assert.equal((await stat(oldPath)).mode & 0o777, 0o600);
  await assert.rejects(access(newPath));

  await useRepository({ root, databasePath, agentFile: 'nested/AGENTS.md' });
  await assert.rejects(access(oldPath));
  assert.match(await readFile(newPath, 'utf8'), /BEGIN KIOKUKO MANAGED BLOCK/u);
});

test('changing agentFile restores an old managed-only file after a committed unlink error', async () => {
  const root = await repository('agent-relocate-committed-unlink');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const initial = await useRepository({ root, databasePath });
  const bindingPath = path.join(initial.repositoryRoot, '.kiokuko.json');
  const oldPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const newPath = path.join(initial.repositoryRoot, 'nested', 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const oldBefore = await readFile(oldPath, 'utf8');
  const postUnlinkFailure = new Error('post-unlink-validation-sentinel');
  let injected = false;
  await mkdir(path.dirname(newPath));

  await assert.rejects(useRepository({
    root,
    databasePath,
    agentFile: 'nested/AGENTS.md',
  }, {
    unlinkRegularFileIfUnchanged: async (filePath, expectation, dependencies) => {
      const outcome = await unlinkRegularFileIfUnchanged(filePath, expectation, dependencies);
      if (!injected && path.resolve(filePath) === oldPath) {
        injected = true;
        throw new AtomicCommittedUnlinkError(outcome, postUnlinkFailure);
      }
      return outcome;
    },
  }), (error: unknown) => error instanceof AtomicCommittedUnlinkError
    && error.operationError === postUnlinkFailure);

  assert.equal(injected, true);
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(oldPath, 'utf8'), oldBefore);
  await assert.rejects(access(newPath));
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
      initial.repositoryId,
    );
  } finally {
    database.close();
  }
});

test('changing agentFile with no-agent-file still removes the retired managed-only target', async () => {
  const root = await repository('agent-relocate-no-agent');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const oldPath = path.join(root, 'AGENTS.md');
  const skippedPath = path.join(root, 'SKIPPED.md');
  await useRepository({ root, databasePath });

  const moved = await useRepository({
    root,
    databasePath,
    agentFile: 'SKIPPED.md',
    noAgentFile: true,
  });
  assert.equal(moved.agentFile, null);
  assert.equal(moved.agentFileAction, 'skipped');
  await assert.rejects(access(oldPath));
  await assert.rejects(access(skippedPath));
  assert.equal(
    (JSON.parse(await readFile(path.join(root, '.kiokuko.json'), 'utf8')) as { agentFile: string }).agentFile,
    'SKIPPED.md',
  );
});

test('no-agent-file validates the prospective target after retiring the old managed file', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await repository('agent-relocate-no-agent-final-cas');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const initial = await useRepository({ root, databasePath });
  const bindingPath = path.join(initial.repositoryRoot, '.kiokuko.json');
  const oldPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const prospectivePath = path.join(initial.repositoryRoot, 'SKIPPED.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const oldBefore = await readFile(oldPath, 'utf8');
  let aliasCreated = false;

  await assert.rejects(useRepository({
    root,
    databasePath,
    agentFile: 'SKIPPED.md',
    noAgentFile: true,
  }, {
    unlinkRegularFileIfUnchanged: async (filePath, expectation, dependencies) => {
      if (!aliasCreated && path.resolve(filePath) === oldPath) {
        aliasCreated = true;
        await link(oldPath, prospectivePath);
      }
      return unlinkRegularFileIfUnchanged(filePath, expectation, dependencies);
    },
  }), (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'CONFLICT');

  assert.equal(aliasCreated, true);
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(oldPath, 'utf8'), oldBefore);
  assert.equal(await readFile(prospectivePath, 'utf8'), oldBefore);
  const database = openConnection(databasePath);
  try {
    assert.equal(
      database.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(initial.repositoryRoot)?.repositoryId,
      initial.repositoryId,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('changing agentFile reports old-file cleanup failure and restores every owned target', async () => {
  const root = await repository('agent-relocate-cleanup');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const initial = await useRepository({ root, databasePath });
  const bindingPath = path.join(root, '.kiokuko.json');
  const oldPath = path.join(root, 'AGENTS.md');
  const plannedOldPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const newPath = path.join(root, 'next', 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const oldBefore = await readFile(oldPath, 'utf8');
  let cleanupInjected = false;
  await mkdir(path.dirname(newPath));

  await assert.rejects(useRepository({
    root,
    databasePath,
    agentFile: 'next/AGENTS.md',
  }, {
    unlinkRegularFileIfUnchanged: async (filePath, expectation) => {
      if (path.resolve(filePath) !== plannedOldPath) {
        return unlinkRegularFileIfUnchanged(filePath, expectation);
      }
      return unlinkRegularFileIfUnchanged(filePath, expectation, {
        beforeCleanup: async () => {
          if (!cleanupInjected) {
            cleanupInjected = true;
            throw new Error('old-agent-cleanup-sentinel');
          }
        },
      });
    },
  }), (error: unknown) => error instanceof AggregateError
    && error.message === 'File mutation committed, but committed-artifact cleanup failed');

  assert.equal(cleanupInjected, true);
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(oldPath, 'utf8'), oldBefore);
  await assert.rejects(access(newPath));
});

test('changing agentFile fails closed on a concurrent old-file edit and rolls back owned writes', async () => {
  const root = await repository('agent-relocate-cas');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'db.sqlite3');
  const bindingPath = path.join(root, '.kiokuko.json');
  const oldPath = path.join(root, 'AGENTS.md');
  const newPath = path.join(root, 'next', 'AGENTS.md');
  const initial = await useRepository({ root, databasePath });
  const plannedOldPath = path.join(initial.repositoryRoot, 'AGENTS.md');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  let changed = false;
  await mkdir(path.dirname(newPath));

  await assert.rejects(useRepository({
    root,
    databasePath,
    agentFile: 'next/AGENTS.md',
  }, {
    unlinkRegularFileIfUnchanged: async (filePath, expectation, dependencies) => {
      if (!changed && path.resolve(filePath) === plannedOldPath) {
        changed = true;
        await writeFile(oldPath, 'concurrent human replacement\n');
      }
      return unlinkRegularFileIfUnchanged(filePath, expectation, dependencies);
    },
  }), (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'CONFLICT');

  assert.equal(changed, true);
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
  assert.equal(await readFile(oldPath, 'utf8'), 'concurrent human replacement\n');
  await assert.rejects(access(newPath));
});

test('changing agentFile rejects malformed or symlinked old ownership before mutation', { skip: process.platform === 'win32' }, async () => {
  for (const variant of ['malformed', 'symlink'] as const) {
    const root = await repository(`agent-relocate-${variant}`);
    const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
    const databasePath = path.join(data, 'db.sqlite3');
    const bindingPath = path.join(root, '.kiokuko.json');
    const oldPath = path.join(root, 'AGENTS.md');
    const newPath = path.join(root, 'replacement', 'AGENTS.md');
    await useRepository({ root, databasePath });
    await mkdir(path.dirname(newPath));
    const bindingBefore = await readFile(bindingPath, 'utf8');
    if (variant === 'malformed') {
      await writeFile(oldPath, '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\ntruncated\n');
    } else {
      const outside = path.join(data, 'outside.md');
      await writeFile(outside, 'outside-owned\n');
      await unlink(oldPath);
      await symlink(outside, oldPath);
    }

    await assert.rejects(
      useRepository({ root, databasePath, agentFile: 'replacement/AGENTS.md' }),
      variant === 'malformed' ? /malformed/i : /symbolic link|symlink/i,
    );
    assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
    await assert.rejects(access(newPath));
    if (variant === 'symlink') {
      assert.equal(await readFile(path.join(data, 'outside.md'), 'utf8'), 'outside-owned\n');
    }
  }
});
