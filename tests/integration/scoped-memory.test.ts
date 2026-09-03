import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { checkpointScopedMemory, recallScopedMemory } from '../../src/memory/scoped-memory.js';
import { ensureGlobalWorkspace, resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { recordContextDelivery } from '../../src/context/delivery.js';
import { finalizeRunIntakeLink, insertAkinatorSession, insertRunIntakeLink } from '../../src/akinator/store.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';

async function gitRepository(prefix: string, remote?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-scope-${prefix}-`));
  execFileSync('git', ['init', '-q', root]);
  if (remote) execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  return root;
}

async function databasePath(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-scope-db-${prefix}-`));
  const filePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath: filePath });
  return filePath;
}

function seedCheckpointRun(
  database: ReturnType<typeof openConnection>,
  runId: string,
  workspace: string,
  now = '2026-08-25T00:00:00.000Z',
): { sessionId: string; profileHash: string } {
  const sessionId = `session-${runId}`;
  const profile = { taskType: 'build' as const, target: 'memory', expected: 'checkpoint', constraints: null };
  const profileHash = canonicalContentHash(profile);
  insertAkinatorSession(database, {
    id: sessionId,
    workspace,
    task: 'checkpoint',
    profile,
    status: 'ready',
    questionCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
      protocol_version, capture_profile, coverage_json, status, title, task_hash,
      metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'opencode', '1', ?, NULL, '1', 'standard', '{"approval":"unavailable","command":"unavailable","file":"unavailable","run":"declared","tool":"unavailable"}', 'active', 'checkpoint', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
  `).run(runId, workspace, sessionId, now, now, now);
  insertRunIntakeLink(database, {
    runId,
    sessionId,
    workspace,
    policyVersion: 'v2',
    profileSchemaVersion: 1,
    profileSources: { taskType: 'inferred', target: 'inferred', expected: 'inferred', constraints: 'inferred' },
    initialProfileHash: null,
    recommendedTags: ['bot:builder', 'skill:tdd'],
    linkedAt: now,
    finalizedAt: null,
  });
  finalizeRunIntakeLink(database, {
    workspace,
    runId,
    profileHash,
    recommendedTags: ['bot:builder', 'skill:tdd'],
    finalizedAt: now,
  });
  return { sessionId, profileHash };
}

function seedEmptyCheckpointDelivery(
  database: ReturnType<typeof openConnection>,
  workspace: string,
  runId: string,
  deliveryId: string,
  now = '2026-08-25T00:00:00.000Z',
): void {
  const run = seedCheckpointRun(database, runId, workspace, now);
  recordContextDelivery(database, {
    workspace,
    deliveryId,
    runId,
    throughSequence: 0,
    intakeSessionId: run.sessionId,
    taskProfileHash: run.profileHash,
    queryHash: 'b'.repeat(64),
    policyVersion: 'context-ranking-v1+recommendations.v1',
    charBudget: 1,
    charCount: 0,
    truncated: false,
    createdAt: now,
    items: [],
  });
}

function checkpointMutationSnapshot(database: ReturnType<typeof openConnection>): Record<string, unknown> {
  return {
    repositories: database.prepare(`
      SELECT repository_id, workspace, display_name, remote_fingerprint,
             binding_schema_version, agent_template_version, created_at, last_used_at
        FROM repositories ORDER BY repository_id
    `).all(),
    locations: database.prepare(`
      SELECT repository_id, canonical_root, first_seen_at, last_seen_at
        FROM repository_locations ORDER BY repository_id, canonical_root
    `).all(),
    entries: database.prepare('SELECT id, workspace, status, current_revision FROM entries ORDER BY id').all(),
    events: database.prepare('SELECT event_id, run_id, sequence, event_type FROM ledger_events ORDER BY run_id, sequence').all(),
    evidence: database.prepare('SELECT evidence_id, run_id, event_id FROM ledger_evidence ORDER BY evidence_id').all(),
    links: database.prepare('SELECT link_id, run_id, delivery_id, entry_id FROM ledger_memory_links ORDER BY link_id').all(),
    feedback: database.prepare('SELECT feedback_id, delivery_id, entry_id, run_id FROM context_feedback ORDER BY feedback_id').all(),
    runs: database.prepare('SELECT run_id, status, last_sequence, updated_at FROM ledger_runs ORDER BY run_id').all(),
  };
}

test('auto resolution is stable and does not write repository files', async () => {
  const root = await gitRepository('stable');
  const filePath = await databasePath('stable');
  const database = openConnection(filePath);
  try {
    const first = await resolveProjectWorkspace(database, root);
    const second = await resolveProjectWorkspace(database, root);
    assert.ok(first);
    assert.deepEqual(second, { ...first, source: 'location' });
    assert.match(first.repositoryId, /^repo_local_[a-f0-9]{12}$/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
});

test('two working copies with the same remote share a workspace', async () => {
  const remote = 'git@github.com:example/kiokuko-scope-test.git';
  const firstRoot = await gitRepository('remote-a', remote);
  const secondRoot = await gitRepository('remote-b', remote);
  const filePath = await databasePath('remote');
  const database = openConnection(filePath);
  try {
    const first = await resolveProjectWorkspace(database, firstRoot);
    const second = await resolveProjectWorkspace(database, secondRoot);
    assert.equal(second?.repositoryId, first?.repositoryId);
    assert.equal(second?.workspace, first?.workspace);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 2);
  } finally {
    database.close();
  }
});

test('auto recall returns current-project and global memory but never another project', async () => {
  const firstRoot = await gitRepository('isolation-a');
  const secondRoot = await gitRepository('isolation-b');
  const filePath = await databasePath('isolation');
  const database = openConnection(filePath);
  try {
    await checkpointScopedMemory(database, {
      cwd: firstRoot,
      memories: [
        { kind: 'decision', title: 'Alpha durable beacon', body: 'durable-beacon belongs only to alpha' },
        {
          kind: 'preference',
          title: 'Global durable beacon',
          body: 'durable-beacon applies everywhere',
          scope: 'global',
          portableReason: 'The preference applies independently of repository technology.',
        },
      ],
    });
    const fromFirst = await recallScopedMemory(database, { cwd: firstRoot, query: 'durable beacon' });
    assert.equal(fromFirst.project?.memory.items.length, 1);
    assert.equal(fromFirst.global?.items.length, 1);

    const fromSecond = await recallScopedMemory(database, { cwd: secondRoot, query: 'durable beacon' });
    assert.equal(fromSecond.project?.memory.items.length, 0);
    assert.equal(fromSecond.global?.items.length, 1);
    assert.doesNotMatch(JSON.stringify(fromSecond), /belongs only to alpha/);
    assert.match(fromSecond.securityNotice, /untrusted data/);
  } finally {
    database.close();
  }
});

test('global checkpoint preferences require explicit portability metadata', async () => {
  const root = await gitRepository('global-portability');
  const filePath = await databasePath('global-portability');
  const database = openConnection(filePath);
  try {
    await assert.rejects(
      checkpointScopedMemory(database, {
        cwd: root,
        memories: [
          { kind: 'decision', title: 'Must roll back', body: 'This project entry must not survive a rejected batch.' },
          { kind: 'preference', title: 'Unscoped global preference', body: 'No portability evidence.', scope: 'global' },
        ],
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);

    const withApplicability = await checkpointScopedMemory(database, {
      cwd: root,
      memories: [{
        kind: 'preference',
        title: 'Scoped global preference',
        body: 'Applies to TypeScript projects.',
        scope: 'global',
        applicability: { languages: ['TypeScript'] },
      }],
    });
    assert.equal(withApplicability.entries.length, 1);
    const scopeRow = database.prepare('SELECT scope_json AS scope FROM entry_revisions WHERE entry_id = ? AND revision = ?')
      .get<{ scope: string }>(withApplicability.entries[0]!.id, withApplicability.entries[0]!.revision);
    assert.ok(scopeRow);
    assert.equal(Object.hasOwn(JSON.parse(scopeRow.scope) as Record<string, unknown>, 'portableReason'), false);
  } finally {
    database.close();
  }
});

test('checkpoint provenance stores the repository HEAD commit', async () => {
  const root = await gitRepository('provenance');
  await writeFile(path.join(root, 'checkpoint.txt'), 'checkpoint provenance\n');
  execFileSync('git', ['-C', root, 'add', 'checkpoint.txt']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Kiokuko Test', '-c', 'user.email=kiokuko@example.invalid', 'commit', '-q', '-m', 'checkpoint provenance']);
  const expected = execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim();
  const filePath = await databasePath('provenance');
  const database = openConnection(filePath);
  try {
    const checkpoint = await checkpointScopedMemory(database, {
      cwd: root,
      memories: [{ kind: 'decision', title: 'Commit-bound decision', body: 'Bound to the current repository commit.' }],
    });
    const entry = checkpoint.entries[0]!;
    const row = database.prepare('SELECT provenance_json AS provenance FROM entry_revisions WHERE entry_id = ? AND revision = ?')
      .get<{ provenance: string }>(entry.id, entry.revision);
    assert.ok(row);
    assert.equal((JSON.parse(row.provenance) as { sourceCommit?: string }).sourceCommit, expected);
  } finally {
    database.close();
  }
});

test('checkpoint validates delivery ownership before mutating memory or ledger state', async () => {
  const firstRoot = await gitRepository('delivery-owner-a');
  const secondRoot = await gitRepository('delivery-owner-b');
  const filePath = await databasePath('delivery-owner');
  const database = openConnection(filePath);
  try {
    const first = await resolveProjectWorkspace(database, firstRoot);
    const second = await resolveProjectWorkspace(database, secondRoot);
    assert.ok(first);
    assert.ok(second);
    const now = '2026-08-25T00:00:00.000Z';
    seedEmptyCheckpointDelivery(database, first.workspace, 'run-delivery-owner-a', 'delivery-owner-a', now);
    seedCheckpointRun(database, 'run-delivery-owner-b', second.workspace, now);
    const before = {
      entries: database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()!.count,
      events: database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()!.count,
      links: database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()!.count,
    };

    await assert.rejects(
      checkpointScopedMemory(database, {
        cwd: firstRoot,
        deliveryId: 'delivery-owner-a',
        memories: [{ kind: 'lesson', title: 'Must not persist', body: 'delivery without run' }],
      }),
      (error: unknown) => (error as { code?: unknown }).code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      checkpointScopedMemory(database, {
        cwd: secondRoot,
        runId: 'run-delivery-owner-b',
        deliveryId: 'delivery-owner-a',
        memories: [{ kind: 'lesson', title: 'Delivery ownership sentinel', body: 'This must not persist.' }],
        outcome: 'completed',
      }),
      (error: unknown) => (error as { code?: unknown }).code === 'NOT_FOUND',
    );
    assert.deepEqual({
      entries: database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()!.count,
      events: database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()!.count,
      links: database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()!.count,
    }, before);
  } finally {
    database.close();
  }
});

test('checkpoint validates all input and exact feedback targets before workspace mutation', async () => {
  const root = await gitRepository('prevalidation-no-mutation');
  const filePath = await databasePath('prevalidation-no-mutation');
  const database = openConnection(filePath);
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    ensureGlobalWorkspace(database, '2026-08-24T00:00:00.000Z');
    seedEmptyCheckpointDelivery(
      database,
      project.workspace,
      'run-checkpoint-prevalidation',
      'delivery-checkpoint-prevalidation',
    );
    const timestampSentinel = '2001-02-03T04:05:06.000Z';
    database.prepare('UPDATE repositories SET last_used_at = ?').run(timestampSentinel);
    database.prepare('UPDATE repository_locations SET last_seen_at = ?').run(timestampSentinel);
    const before = checkpointMutationSnapshot(database);
    const rejectsWithoutMutation = async (
      input: Parameters<typeof checkpointScopedMemory>[1],
      code: string,
    ): Promise<void> => {
      await assert.rejects(
        checkpointScopedMemory(database, input),
        (error: unknown) => (error as { code?: unknown }).code === code,
      );
      assert.deepEqual(checkpointMutationSnapshot(database), before);
    };

    await rejectsWithoutMutation({
      cwd: root,
      memories: [{ kind: 'lesson', title: 'Invalid evidence sentinel', body: 'Must not be persisted.' }],
      evidence: { changedPaths: ['../outside-repository'] },
    }, 'VALIDATION_ERROR');
    await rejectsWithoutMutation({
      cwd: root,
      memories: [{ kind: 'removed-kind' as never, title: 'Invalid memory sentinel', body: 'Must not be persisted.' }],
    }, 'VALIDATION_ERROR');
    await rejectsWithoutMutation({
      cwd: root,
      memories: [{
        kind: 'lesson',
        title: 'Unretrievable ecosystem sentinel',
        body: 'An explicit ecosystem scope requires applicability.',
        retrievalScope: 'ecosystem',
      }],
    }, 'VALIDATION_ERROR');
    await rejectsWithoutMutation({
      cwd: root,
      runId: 'run-checkpoint-prevalidation',
      deliveryId: 'delivery-checkpoint-prevalidation',
      memories: [],
      outcome: 'completed',
      feedback: [{ entryId: 'missing-entry', entryRevision: 1, verdict: 'unknown-verdict' }],
    }, 'VALIDATION_ERROR');
    await rejectsWithoutMutation({
      cwd: root,
      runId: 'run-checkpoint-prevalidation',
      deliveryId: 'delivery-checkpoint-prevalidation',
      memories: [],
      outcome: 'completed',
      feedback: [{ entryId: 'missing-entry', entryRevision: 1, verdict: 'helpful' }],
    }, 'NOT_FOUND');
  } finally {
    database.close();
  }
});

test('checkpoint rechecks run status at transaction time and performs no mutation after a terminal transition', async () => {
  const root = await gitRepository('transaction-status-race');
  const filePath = await databasePath('transaction-status-race');
  const database = openConnection(filePath);
  const competing = openConnection(filePath);
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    seedCheckpointRun(database, 'run-transaction-status-race', project.workspace);
    const runId = 'run-transaction-status-race';
    const snapshot = () => ({
      entries: database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count ?? 0,
      events: database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? 0,
      evidence: database.prepare('SELECT COUNT(*) AS count FROM ledger_evidence WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? 0,
      links: database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? 0,
      feedback: database.prepare('SELECT COUNT(*) AS count FROM context_feedback WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? 0,
      reasoningPaths: database.prepare('SELECT COUNT(*) AS count FROM akinator_reasoning_paths WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? 0,
    });
    const before = snapshot();
    const originalExec = database.exec.bind(database);
    let resolverCommitted = false;
    let transitioned = false;
    database.exec = (sql: string) => {
      if (sql === 'COMMIT') {
        resolverCommitted = true;
        originalExec(sql);
        return;
      }
      if (resolverCommitted && !transitioned && sql === 'BEGIN IMMEDIATE') {
        competing.prepare('UPDATE ledger_runs SET status = ?, ended_at = ?, updated_at = ? WHERE run_id = ?')
          .run('completed', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z', runId);
        transitioned = true;
      }
      originalExec(sql);
    };

    await assert.rejects(
      checkpointScopedMemory(database, {
        cwd: root,
        runId,
        memories: [{ kind: 'lesson', title: 'Must not persist after race', body: 'The transaction-time status guard must reject this.' }],
        evidence: { changedPaths: ['src/race.ts'], verification: { outcome: 'fresh' } },
        outcome: 'completed',
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'CONFLICT');
        assert.deepEqual((error as { details?: unknown }).details, {
          checkpointEligibility: {
            allowed: false,
            reason: 'run_terminal',
            nextAction: 'stop',
            retryableAfterStateChange: false,
          },
          runStatus: 'completed',
        });
        return true;
      },
    );
    assert.equal(transitioned, true);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(runId)?.status, 'completed');
    assert.deepEqual(snapshot(), before);
  } finally {
    competing.close();
    database.close();
  }
});
