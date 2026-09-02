import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { answerAgentTask, prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { setupGlobalClients } from '../../src/commands/setup.js';
import { recordContextFeedback } from '../../src/context/feedback.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { CheckpointService } from '../../src/gateway/checkpoint-service.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { GLOBAL_WORKSPACE, resolveProjectWorkspace } from '../../src/memory/workspaces.js';

const SOUL_CAPABILITY = { kind: 'skill', name: 'kiokuko-soul' } as const;
const NO_MEMORY_POLICY = { memoryReasoningRequired: false, contextWithheld: false, withheldReason: null } as const;
const AVAILABLE_MEMORY_POLICY = { memoryReasoningRequired: true, contextWithheld: false, withheldReason: null } as const;
const MISSING_MEMORY_POLICY = {
  memoryReasoningRequired: true,
  contextWithheld: true,
  withheldReason: 'memory_reasoning_missing',
} as const;
const MISSING_MEMORY_POLICY_WITH_ONE_STORED_ENTRY = {
  ...MISSING_MEMORY_POLICY,
  deliveryEmpty: true,
  storedEntryCount: 1,
} as const;

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-memory-policy-${prefix}-`));
  execFileSync('git', ['init', '-q', root]);
  return root;
}

async function createDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-memory-policy-db-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  return openConnection(databasePath);
}

async function createDatabasePair(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-memory-policy-db-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  return {
    database: openConnection(databasePath),
    concurrent: openConnection(databasePath),
  };
}

function exposeRepositoryBindingMutation(
  database: SqliteDatabase,
  repositoryId: string,
  repositoryRoot: string,
): void {
  database.prepare('UPDATE repositories SET last_used_at = ? WHERE repository_id = ?')
    .run('2000-01-01T00:00:00.000Z', repositoryId);
  database.prepare('UPDATE repository_locations SET last_seen_at = ? WHERE repository_id = ? AND canonical_root = ?')
    .run('2000-01-01T00:00:00.000Z', repositoryId, repositoryRoot);
  const sentinel = database.prepare(`
    SELECT r.last_used_at AS lastUsedAt, l.last_seen_at AS lastSeenAt
    FROM repositories AS r
    JOIN repository_locations AS l ON l.repository_id = r.repository_id
    WHERE r.repository_id = ? AND l.canonical_root = ?
  `).get<{ lastUsedAt: unknown; lastSeenAt: unknown }>(repositoryId, repositoryRoot);
  assert.equal(sentinel?.lastUsedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(sentinel?.lastSeenAt, '2000-01-01T00:00:00.000Z');
}

function rejectedAnswerState(database: SqliteDatabase): Record<string, unknown> {
  const rows = (table: string): Record<string, unknown>[] => database.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`)
    .all<Record<string, unknown>>();
  return {
    repositories: rows('repositories'),
    repositoryLocations: rows('repository_locations'),
    repositoryFingerprints: rows('repository_fingerprints'),
    sessions: rows('akinator_sessions'),
    answers: rows('akinator_answers'),
    runs: rows('ledger_runs'),
    runIntakes: rows('run_intakes'),
    events: rows('ledger_events'),
    idempotency: rows('gateway_idempotency'),
    deliveries: rows('context_deliveries'),
  };
}

function rejectedAnswerStateWithoutLocations(database: SqliteDatabase): Record<string, unknown> {
  const state = rejectedAnswerState(database);
  delete state.repositoryLocations;
  return state;
}

function svelteDiscoveryFetch(onRequest?: (url: URL) => void | Promise<void>): typeof fetch {
  const commit = 'd'.repeat(40);
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const textResponse = (value: string) => new Response(value, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
  return async (raw) => {
    const url = new URL(String(raw));
    await onRequest?.(url);
    if (url.hostname === 'skills.sh') {
      return jsonResponse({ skills: [{
        id: 'sveltejs/ai-tools/svelte-code-writer',
        source: 'sveltejs/ai-tools',
        name: 'svelte-code-writer',
        installs: 3,
      }] });
    }
    if (url.pathname === '/repos/sveltejs/ai-tools') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: commit });
    if (url.pathname.includes(`/git/trees/${commit}`)) return jsonResponse({
      truncated: false,
      tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }],
    });
    if (url.pathname.endsWith('/SKILL.md')) {
      return textResponse('---\nname: Svelte Code Writer\ndescription: Safe Svelte references\n---\n# Svelte\n\nVerify the current repository.');
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
}

test('withholds actionable memory but continues the repair task when memory-reasoning is unavailable', async () => {
  const root = await repository('required');
  const database = await createDatabase('required');
  try {
    const seed = await prepareAgentTask(database, {
      requestId: 'memory-policy-required-seed',
      cwd: root,
      task: 'Implement repository tests for the beacon',
      profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'seed' },
      skillDiscoveryMode: 'off',
    });
    recordEntry(database, {
      workspace: seed.project.workspace,
      kind: 'lesson',
      title: 'Beacon test workflow',
      body: 'Implement repository tests for the beacon before changing production code.',
      tags: ['testing'],
    });

    const missing = await prepareAgentTask(database, {
      requestId: 'memory-policy-required-missing',
      cwd: root,
      task: 'Implement repository tests for the beacon',
      profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'missing' },
      skillDiscoveryMode: 'off',
    });
    const missingRecommendation = missing.capabilities.recommendations.find((item) => item.name === 'memory-reasoning');
    assert.equal(missingRecommendation?.name, 'memory-reasoning');
    assert.equal(missingRecommendation?.availability, 'missing');
    assert.deepEqual(missing.memoryPolicy, MISSING_MEMORY_POLICY_WITH_ONE_STORED_ENTRY);
    assert.equal(missing.nextAction, 'proceed');
    assert.equal(missing.context, null);
    assert.equal('memory' in missing, false);
    assert.equal('references' in missing, false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(missing.run.runId)?.count, 0);

    const available = await prepareAgentTask(database, {
      requestId: 'memory-policy-required-available',
      cwd: root,
      task: 'Implement repository tests for the beacon',
      profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY, { kind: 'skill', name: 'memory-reasoning' }],
      client: { kind: 'test', sessionId: 'available' },
      skillDiscoveryMode: 'off',
    });
    const availableRecommendation = available.capabilities.recommendations.find((item) => item.name === 'memory-reasoning');
    assert.equal(availableRecommendation?.availability, 'available');
    assert.deepEqual(available.memoryPolicy, AVAILABLE_MEMORY_POLICY);
    assert.equal(available.nextAction, 'proceed');
    assert.notEqual(available.context, null);
  } finally {
    database.close();
  }
});

test('fresh default setup supplies the exact memory capability that unlocks build and debug delivery', async () => {
  const root = await repository('default-setup');
  const environmentRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-memory-policy-setup-'));
  const home = path.join(environmentRoot, 'home');
  const config = path.join(environmentRoot, 'config');
  const data = path.join(environmentRoot, 'data');
  const databasePath = path.join(data, 'kiokuko', 'kiokuko-ai.sqlite');
  await mkdir(home, { recursive: true });

  const setup = await setupGlobalClients({
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
    databasePath,
  });
  const installedSkillPath = path.join(config, 'opencode', 'skills', 'memory-reasoning', 'SKILL.md');
  const installedSkill = await readFile(installedSkillPath, 'utf8');
  const frontmatterName = /^name:\s*([^\s]+)\s*$/mu.exec(installedSkill)?.[1];
  assert.equal(frontmatterName, 'memory-reasoning');
  assert.equal(setup.files.some((file) => file.path === installedSkillPath && file.action === 'created'), true);

  const installedCapability = { kind: 'skill', name: frontmatterName } as const;
  const database = openConnection(databasePath);
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);

    for (const [taskType, target] of [
      ['build', 'src/setup-build-beacon.ts'],
      ['debug', 'src/setup-debug-beacon.ts'],
    ] as const) {
      const entry = recordEntry(database, {
        workspace: project.workspace,
        kind: 'lesson',
        title: `${taskType} setup delivery beacon`,
        body: `Use the ${taskType} setup delivery beacon to verify exact memory capability delivery.`,
        tags: ['memory-policy', taskType],
      });
      const task = `Repair the ${taskType} setup delivery beacon`;
      const profileHints = {
        taskType,
        target,
        expected: 'the exact saved beacon memory is delivered once',
        constraints: null,
      } as const;

      const missing = await prepareAgentTask(database, {
        requestId: `default-setup-${taskType}-missing`,
        cwd: root,
        task,
        profileHints,
        capabilities: [SOUL_CAPABILITY],
        client: { kind: 'test', sessionId: `default-setup-${taskType}-missing` },
        skillDiscoveryMode: 'off',
      });
      assert.equal(missing.context, null);
      assert.deepEqual(missing.memoryPolicy, {
        ...MISSING_MEMORY_POLICY,
        deliveryEmpty: true,
        storedEntryCount: taskType === 'build' ? 1 : 2,
      });
      assert.equal(missing.nextAction, 'proceed');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(missing.run.runId)?.count, 0);

      const availableInput = {
        requestId: `default-setup-${taskType}-available`,
        cwd: root,
        task,
        profileHints,
        capabilities: [SOUL_CAPABILITY, installedCapability],
        client: { kind: 'test', sessionId: `default-setup-${taskType}-available` },
        skillDiscoveryMode: 'off' as const,
      };
      const available = await prepareAgentTask(database, availableInput);
      assert.deepEqual(available.memoryPolicy, AVAILABLE_MEMORY_POLICY);
      assert.equal(available.nextAction, 'proceed');
      assert.equal(available.context?.items.some((item) => item.entryId === entry.id), true);
      assert.ok(available.context?.deliveryId);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(available.run.runId)?.count, 1);

      const replay = await prepareAgentTask(database, availableInput);
      assert.equal(replay.run.runId, available.run.runId);
      assert.equal(replay.context?.deliveryId, available.context.deliveryId);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(available.run.runId)?.count, 1);
    }
  } finally {
    database.close();
  }
});

test('does not require memory-reasoning when only a managed curator global memory is actionable', async () => {
  const root = await repository('trusted-curator-global');
  const database = await createDatabase('trusted-curator-global');
  const now = '2026-08-26T00:00:00.000Z';
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    const curated = recordEntry(database, {
      workspace: GLOBAL_WORKSPACE,
      kind: 'lesson',
      status: 'verified',
      title: 'Kiokuko intake capability repair workflow',
      body: 'Repair Kiokuko intake capability failures with focused regression tests.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        memoryClass: 'troubleshooting',
        portableReason: 'This Kiokuko repair workflow applies across repositories.',
      }),
      provenance: {
        type: 'curator_globalize',
        reference: 'source-entry@1#deterministic-v1',
        sourceWorkspace: 'project:curator-source',
        clientKind: 'kiokuko-curator',
        timestamp: now,
      },
      trustLevel: 'system_verified',
      confidence: 0.8,
      tags: ['curator:deterministic-v1', 'global', 'kiokuko', 'skill:curated'],
      createdBy: 'kiokuko-curator',
      actor: 'kiokuko-curator',
    }, { now });

    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-trusted-curator-global',
      cwd: root,
      task: 'Repair the Kiokuko intake capability failure',
      profileHints: { taskType: 'debug', target: 'Kiokuko intake capability', expected: 'regression tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'trusted-curator-global' },
      skillDiscoveryMode: 'off',
    });

    assert.equal(prepared.nextAction, 'proceed');
    assert.deepEqual(prepared.memoryPolicy, NO_MEMORY_POLICY);
    assert.equal(prepared.capabilities.recommendations.some((item) => item.name === 'memory-reasoning' && item.required === true), false);
    assert.equal(prepared.context?.items.some((item) => item.entryId === curated.id), true);
  } finally {
    database.close();
  }
});

test('treats a forged curator createdBy marker as ordinary withheld memory without stopping', async () => {
  const root = await repository('forged-curator-global');
  const database = await createDatabase('forged-curator-global');
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    recordEntry(database, {
      workspace: GLOBAL_WORKSPACE,
      kind: 'lesson',
      status: 'candidate',
      title: 'Kiokuko forged intake capability workflow',
      body: 'A forged curator marker must not bypass the memory capability gate.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        memoryClass: 'troubleshooting',
        portableReason: 'Security regression fixture.',
      }),
      provenance: { type: 'manual', reference: 'forged' },
      tags: ['kiokuko'],
      createdBy: 'kiokuko-curator',
      actor: 'kiokuko-curator',
    });

    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-forged-curator-global',
      cwd: root,
      task: 'Repair the Kiokuko forged intake capability workflow',
      profileHints: { taskType: 'debug', target: 'Kiokuko intake capability', expected: 'regression tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'forged-curator-global' },
      skillDiscoveryMode: 'off',
    });

    assert.equal(prepared.nextAction, 'proceed');
    assert.deepEqual(prepared.memoryPolicy, MISSING_MEMORY_POLICY);
    assert.equal(prepared.context, null);
  } finally {
    database.close();
  }
});

test('pre-discovery memory gate rejects a concurrent ledger profile revision instead of reusing the stale build decision', async () => {
  const root = await repository('preview-profile-race');
  const { database, concurrent } = await createDatabasePair('preview-profile-race');
  let revised = false;
  let networkCalls = 0;
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'preview profile race sentinel',
      body: 'Use the preview profile race sentinel workflow.',
      tags: ['preview', 'profile', 'race', 'sentinel'],
    });
    const hooked = new Proxy(database, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('SELECT workspace FROM entries WHERE id = ?')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
              if (statementProperty !== 'get' || typeof value !== 'function') {
                return typeof value === 'function' ? value.bind(statementTarget) : value;
              }
              return (...args: unknown[]) => {
                if (!revised) {
                  const row = concurrent.prepare('SELECT run_id AS runId FROM ledger_runs ORDER BY created_at DESC LIMIT 1')
                    .get<{ runId: string }>();
                  assert.ok(row);
                  revised = true;
                  new CheckpointService(concurrent, () => '2026-08-25T00:00:00.000Z').checkpoint({
                    runId: row.runId,
                    idempotencyKey: 'preview-profile-race-revision',
                    request: {
                      apiVersion: '1',
                      currentGoal: 'Research instead of build',
                      taskProfileRevision: { taskType: 'research' },
                    },
                  });
                }
                return Reflect.apply(value, statementTarget, args);
              };
            },
          });
        };
      },
    });

    await assert.rejects(
      prepareAgentTask(hooked, {
        requestId: 'memory-policy-preview-profile-race',
        cwd: root,
        task: 'Implement the preview profile race sentinel',
        profileHints: { taskType: 'build', target: 'preview profile race sentinel', expected: 'tests pass', constraints: null },
        capabilities: [SOUL_CAPABILITY],
        client: { kind: 'test', sessionId: 'preview-profile-race' },
        skillDiscoveryMode: 'official',
        fetchImpl: async () => { networkCalls += 1; throw new Error('discovery must remain behind the memory gate'); },
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Scoped context run changed before persistence',
    );
    assert.equal(revised, true);
    assert.equal(networkCalls, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
  } finally {
    concurrent.close();
    database.close();
  }
});

test('task_answer rejects a replacement capability catalog before mutating intake', async () => {
  const root = await repository('catalog-binding');
  const database = await createDatabase('catalog-binding');
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-catalog-binding',
      cwd: root,
      task: 'Implement the catalog-bound beacon',
      profileHints: { taskType: 'build' },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'catalog-binding' },
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.intake.question?.id, 'target');
    exposeRepositoryBindingMutation(database, prepared.project.repositoryId, prepared.project.repositoryRoot);
    const before = rejectedAnswerState(database);
    await assert.rejects(answerAgentTask(database, {
      cwd: root,
      runId: prepared.run.runId,
      sessionId: prepared.intake.sessionId,
      questionId: 'target',
      value: 'src/beacon.ts',
      capabilities: [SOUL_CAPABILITY, { kind: 'skill', name: 'memory-reasoning' }],
      skillDiscoveryMode: 'off',
    }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT');
    assert.deepEqual(rejectedAnswerState(database), before);
  } finally {
    database.close();
  }
});

test('task_answer rejects a changed manifest before mutating the bound intake run', async () => {
  const root = await repository('manifest-binding');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const database = await createDatabase('manifest-binding');
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-manifest-binding',
      cwd: root,
      task: 'Implement the manifest-bound component',
      profileHints: { taskType: 'build' },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'manifest-binding' },
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.intake.question?.id, 'target');
    exposeRepositoryBindingMutation(database, prepared.project.repositoryId, prepared.project.repositoryRoot);
    const before = rejectedAnswerState(database);
    const beforeSession = database.prepare(`
      SELECT profile_json AS profileJson, status, question_count AS questionCount, updated_at AS updatedAt
      FROM akinator_sessions
      WHERE id = ?
    `).get<Record<string, unknown>>(prepared.intake.sessionId);
    const beforeRun = database.prepare(`
      SELECT status, last_sequence AS lastSequence, updated_at AS updatedAt
      FROM ledger_runs
      WHERE run_id = ?
    `).get<Record<string, unknown>>(prepared.run.runId);
    const beforeAnswers = database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?')
      .get<{ count: number }>(prepared.intake.sessionId)?.count;

    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
    await assert.rejects(answerAgentTask(database, {
      cwd: root,
      runId: prepared.run.runId,
      sessionId: prepared.intake.sessionId,
      questionId: 'target',
      value: 'src/component.ts',
      capabilities: [SOUL_CAPABILITY],
      skillDiscoveryMode: 'off',
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && error.message === 'Project manifest differs from the snapshot bound when the run was opened');

    assert.deepEqual(database.prepare(`
      SELECT profile_json AS profileJson, status, question_count AS questionCount, updated_at AS updatedAt
      FROM akinator_sessions
      WHERE id = ?
    `).get<Record<string, unknown>>(prepared.intake.sessionId), beforeSession);
    assert.deepEqual(database.prepare(`
      SELECT status, last_sequence AS lastSequence, updated_at AS updatedAt
      FROM ledger_runs
      WHERE run_id = ?
    `).get<Record<string, unknown>>(prepared.run.runId), beforeRun);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?')
      .get<{ count: number }>(prepared.intake.sessionId)?.count, beforeAnswers);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_fingerprints').get<{ count: number }>()?.count, 0);
    assert.deepEqual(rejectedAnswerState(database), before);
  } finally {
    database.close();
  }
});

test('task_answer rejects a changed discovery request before mutation or network access', async () => {
  const root = await repository('discovery-binding');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const database = await createDatabase('discovery-binding');
  let networkCalls = 0;
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-discovery-binding',
      cwd: root,
      task: 'Implement the discovery-bound component',
      profileHints: { taskType: 'build' },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'discovery-binding' },
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.intake.question?.id, 'target');
    exposeRepositoryBindingMutation(database, prepared.project.repositoryId, prepared.project.repositoryRoot);
    const before = rejectedAnswerState(database);
    const beforeSession = database.prepare(`
      SELECT profile_json AS profileJson, status, question_count AS questionCount, updated_at AS updatedAt
      FROM akinator_sessions
      WHERE id = ?
    `).get<Record<string, unknown>>(prepared.intake.sessionId);
    const beforeRun = database.prepare(`
      SELECT status, last_sequence AS lastSequence, updated_at AS updatedAt
      FROM ledger_runs
      WHERE run_id = ?
    `).get<Record<string, unknown>>(prepared.run.runId);

    await assert.rejects(answerAgentTask(database, {
      cwd: root,
      runId: prepared.run.runId,
      sessionId: prepared.intake.sessionId,
      questionId: 'target',
      value: 'src/component.ts',
      capabilities: [SOUL_CAPABILITY],
      skillDiscoveryMode: 'official',
      fetchImpl: async () => { networkCalls += 1; throw new Error('discovery must not run'); },
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && error.message === 'Skill discovery request differs from the request bound when the run was opened');

    assert.deepEqual(database.prepare(`
      SELECT profile_json AS profileJson, status, question_count AS questionCount, updated_at AS updatedAt
      FROM akinator_sessions
      WHERE id = ?
    `).get<Record<string, unknown>>(prepared.intake.sessionId), beforeSession);
    assert.deepEqual(database.prepare(`
      SELECT status, last_sequence AS lastSequence, updated_at AS updatedAt
      FROM ledger_runs
      WHERE run_id = ?
    `).get<Record<string, unknown>>(prepared.run.runId), beforeRun);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?')
      .get<{ count: number }>(prepared.intake.sessionId)?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_fingerprints').get<{ count: number }>()?.count, 0);
    assert.equal(networkCalls, 0);
    assert.deepEqual(rejectedAnswerState(database), before);
  } finally {
    database.close();
  }
});

test('reordered capability descriptors replay the same task run', async () => {
  const root = await repository('capability-order');
  const database = await createDatabase('capability-order');
  const request = {
    requestId: 'memory-policy-capability-order',
    cwd: root,
    task: 'Research the capability-order boundary',
    profileHints: { taskType: 'research' as const, target: 'capability ordering', expected: 'one run', constraints: null },
    client: { kind: 'test', sessionId: 'capability-order' },
    skillDiscoveryMode: 'off' as const,
  };
  const firstCatalog = [
    SOUL_CAPABILITY,
    { kind: 'skill', name: 'memory-reasoning', description: 'Reason about stored memory.' },
    { kind: 'skill', name: 'kiokuko-ui-design-soul', description: 'Review UI design.' },
  ];
  try {
    const first = await prepareAgentTask(database, { ...request, capabilities: firstCatalog });
    const replayed = await prepareAgentTask(database, { ...request, capabilities: [...firstCatalog].reverse() });

    assert.equal(replayed.run.runId, first.run.runId);
    assert.equal(replayed.context?.deliveryId, first.context?.deliveryId);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('requestId identifies one logical task request and conflicts on changed bound input', async () => {
  const root = await repository('request-identity');
  const database = await createDatabase('request-identity');
  const request = {
    requestId: 'memory-policy-logical-request-a',
    cwd: root,
    task: 'Research the request identity boundary',
    profileHints: { taskType: 'research' as const, target: 'request identity', expected: 'one run per logical request', constraints: null },
    capabilities: [SOUL_CAPABILITY] as unknown[],
    client: { kind: 'test', sessionId: 'request-identity' },
    skillDiscoveryMode: 'off' as const,
  };
  try {
    const first = await prepareAgentTask(database, request);
    const exactRetry = await prepareAgentTask(database, request);
    const normalizedDefaultRetry = await prepareAgentTask(database, {
      ...request,
      maxContextChars: 8_000,
    });
    const distinctRequest = await prepareAgentTask(database, {
      ...request,
      requestId: 'memory-policy-logical-request-b',
    });

    assert.equal(exactRetry.run.runId, first.run.runId);
    assert.equal(normalizedDefaultRetry.run.runId, first.run.runId);
    assert.notEqual(distinctRequest.run.runId, first.run.runId);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 2);
    assert.equal(
      JSON.stringify(database.prepare('SELECT * FROM gateway_idempotency').all()).includes('memory-policy-logical-request'),
      false,
    );

    await assert.rejects(prepareAgentTask(database, {
      ...request,
      task: 'Research a changed request identity boundary',
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT');
    await assert.rejects(prepareAgentTask(database, {
      ...request,
      maxContextChars: 4_000,
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 2);
  } finally {
    database.close();
  }
});

test('task_answer rejects a changed bound context budget before mutating intake', async () => {
  const root = await repository('answer-context-budget');
  const database = await createDatabase('answer-context-budget');
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-answer-context-budget',
      cwd: root,
      task: 'Implement the context-budget beacon',
      profileHints: { taskType: 'build' },
      capabilities: [SOUL_CAPABILITY],
      maxContextChars: 4_000,
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.intake.question?.id, 'target');
    exposeRepositoryBindingMutation(database, prepared.project.repositoryId, prepared.project.repositoryRoot);
    const before = rejectedAnswerState(database);

    await assert.rejects(answerAgentTask(database, {
      cwd: root,
      runId: prepared.run.runId,
      sessionId: prepared.intake.sessionId,
      questionId: 'target',
      value: 'src/beacon.ts',
      capabilities: [SOUL_CAPABILITY],
      maxContextChars: 4_001,
      skillDiscoveryMode: 'off',
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && error.message === 'Task context request differs from the request bound when the run was opened');
    assert.deepEqual(rejectedAnswerState(database), before);

    const answered = await answerAgentTask(database, {
      cwd: root,
      runId: prepared.run.runId,
      sessionId: prepared.intake.sessionId,
      questionId: 'target',
      value: 'src/beacon.ts',
      capabilities: [SOUL_CAPABILITY],
      maxContextChars: 4_000,
      skillDiscoveryMode: 'off',
    });
    assert.equal(answered.intake.question?.id, 'expected');
  } finally {
    database.close();
  }
});

test('task_answer rejects an unregistered cwd without registering or touching either project', async () => {
  const root = await repository('answer-unregistered-bound');
  const unregisteredRoot = await repository('answer-unregistered-candidate');
  const database = await createDatabase('answer-unregistered');
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-answer-unregistered',
      cwd: root,
      task: 'Implement the cwd-bound beacon',
      profileHints: { taskType: 'build' },
      capabilities: [SOUL_CAPABILITY],
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.intake.question?.id, 'target');
    exposeRepositoryBindingMutation(database, prepared.project.repositoryId, prepared.project.repositoryRoot);
    const before = rejectedAnswerState(database);

    await assert.rejects(answerAgentTask(database, {
      cwd: unregisteredRoot,
      runId: prepared.run.runId,
      sessionId: prepared.intake.sessionId,
      questionId: 'target',
      value: 'src/beacon.ts',
      capabilities: [SOUL_CAPABILITY],
      skillDiscoveryMode: 'off',
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'NOT_FOUND'
      && error.message === 'Task project location is not registered');
    assert.deepEqual(rejectedAnswerState(database), before);
  } finally {
    database.close();
  }
});

test('task_answer rejects a cwd rebound to another repository without touching either binding', async () => {
  const root = await repository('answer-rebound');
  const database = await createDatabase('answer-rebound');
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-answer-rebound',
      cwd: root,
      task: 'Implement the rebound-safe beacon',
      profileHints: { taskType: 'build' },
      capabilities: [SOUL_CAPABILITY],
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.intake.question?.id, 'target');
    const reboundRepositoryId = 'repo_rebound_answer_fixture';
    const reboundWorkspace = 'project:rebound-answer-fixture';
    database.prepare(`
      INSERT INTO repositories (
        repository_id, workspace, display_name, remote_fingerprint,
        binding_schema_version, agent_template_version, created_at, last_used_at
      ) VALUES (?, ?, ?, NULL, 1, 0, ?, ?)
    `).run(
      reboundRepositoryId,
      reboundWorkspace,
      'Rebound answer fixture',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    );
    database.prepare(`
      UPDATE repository_locations
      SET repository_id = ?, last_seen_at = ?
      WHERE canonical_root = ?
    `).run(reboundRepositoryId, '2000-01-01T00:00:00.000Z', prepared.project.repositoryRoot);
    const reboundLocation = database.prepare(`
      SELECT repository_id AS repositoryId, last_seen_at AS lastSeenAt
      FROM repository_locations
      WHERE canonical_root = ?
    `).get<{ repositoryId: unknown; lastSeenAt: unknown }>(prepared.project.repositoryRoot);
    assert.equal(reboundLocation?.repositoryId, reboundRepositoryId);
    assert.equal(reboundLocation?.lastSeenAt, '2000-01-01T00:00:00.000Z');
    const before = rejectedAnswerState(database);

    await assert.rejects(answerAgentTask(database, {
      cwd: root,
      runId: prepared.run.runId,
      sessionId: prepared.intake.sessionId,
      questionId: 'target',
      value: 'src/beacon.ts',
      capabilities: [SOUL_CAPABILITY],
      skillDiscoveryMode: 'off',
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'NOT_FOUND'
      && error.message === 'Task run was not found for the intake session');
    assert.deepEqual(rejectedAnswerState(database), before);
  } finally {
    database.close();
  }
});

test('task_answer rechecks the cwd binding inside the intake mutation transaction', async () => {
  const root = await repository('answer-rebound-race');
  const { database, concurrent } = await createDatabasePair('answer-rebound-race');
  let rebound = false;
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-answer-rebound-race',
      cwd: root,
      task: 'Implement the rebound-race-safe beacon',
      profileHints: { taskType: 'build' },
      capabilities: [SOUL_CAPABILITY],
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.intake.question?.id, 'target');
    exposeRepositoryBindingMutation(database, prepared.project.repositoryId, prepared.project.repositoryRoot);
    const reboundRepositoryId = 'repo_rebound_answer_race_fixture';
    const reboundWorkspace = 'project:rebound-answer-race-fixture';
    concurrent.prepare(`
      INSERT INTO repositories (
        repository_id, workspace, display_name, remote_fingerprint,
        binding_schema_version, agent_template_version, created_at, last_used_at
      ) VALUES (?, ?, ?, NULL, 1, 0, ?, ?)
    `).run(
      reboundRepositoryId,
      reboundWorkspace,
      'Rebound answer race fixture',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    );
    const before = rejectedAnswerStateWithoutLocations(database);
    const hooked: SqliteDatabase = new Proxy(database, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => {
          if (!rebound && sql.includes('SELECT lr.run_id AS runId FROM ledger_runs AS lr JOIN run_intakes')) {
            concurrent.prepare(`
              UPDATE repository_locations
              SET repository_id = ?, last_seen_at = ?
              WHERE canonical_root = ?
            `).run(reboundRepositoryId, '2000-01-01T00:00:00.000Z', prepared.project.repositoryRoot);
            rebound = true;
          }
          return target.prepare(sql);
        };
      },
    });

    await assert.rejects(answerAgentTask(hooked, {
      cwd: root,
      runId: prepared.run.runId,
      sessionId: prepared.intake.sessionId,
      questionId: 'target',
      value: 'src/beacon.ts',
      capabilities: [SOUL_CAPABILITY],
      skillDiscoveryMode: 'off',
    }), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && error.message === 'Task project location binding changed');

    assert.equal(rebound, true);
    assert.deepEqual(rejectedAnswerStateWithoutLocations(database), before);
    const location = database.prepare(`
      SELECT repository_id AS repositoryId, last_seen_at AS lastSeenAt
      FROM repository_locations
      WHERE canonical_root = ?
    `).get<{ repositoryId: unknown; lastSeenAt: unknown }>(prepared.project.repositoryRoot);
    assert.equal(location?.repositoryId, reboundRepositoryId);
    assert.equal(location?.lastSeenAt, '2000-01-01T00:00:00.000Z');
  } finally {
    concurrent.close();
    database.close();
  }
});

test('requestId rejects empty, padded, control-bearing, and oversized values before opening a run', async () => {
  const root = await repository('request-id-validation');
  const database = await createDatabase('request-id-validation');
  try {
    for (const requestId of ['', ' padded ', 'line\nbreak', 'x'.repeat(257)]) {
      await assert.rejects(prepareAgentTask(database, {
        requestId,
        cwd: root,
        task: 'Research request ID validation',
        profileHints: { taskType: 'research', target: 'request ID', expected: 'validation', constraints: null },
        capabilities: [SOUL_CAPABILITY],
        skillDiscoveryMode: 'off',
      }), (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'VALIDATION_ERROR');
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('does not require memory-reasoning for a ready repair task without actionable memory', async () => {
  const root = await repository('none');
  const database = await createDatabase('none');
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-no-actionable-memory',
      cwd: root,
      task: 'Implement a new beacon',
      profileHints: { taskType: 'build', target: 'src/beacon.ts', expected: 'tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'empty' },
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.context?.items.length, 0);
    assert.equal(prepared.context?.deliveryId, null);
    assert.equal(prepared.capabilities.recommendations.some((item) => item.name === 'memory-reasoning' && item.required === true), false);
    assert.deepEqual(prepared.memoryPolicy, NO_MEMORY_POLICY);
    assert.equal(prepared.nextAction, 'proceed');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(prepared.run.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('reports a machine-readable empty delivery when retrievable project memory exists', async () => {
  const root = await repository('empty-delivery');
  const database = await createDatabase('empty-delivery');
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'fact',
      title: '陶磁器の焼成記録',
      body: '釉薬の発色条件を保存する。',
    });

    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-empty-delivery',
      cwd: root,
      task: '量子暗号通信の研究計画を整理する',
      profileHints: { taskType: 'research', target: '量子暗号通信', expected: '研究計画', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'empty-delivery' },
      skillDiscoveryMode: 'off',
    });

    assert.equal(prepared.context?.items.length, 0);
    assert.deepEqual(prepared.memoryPolicy, {
      ...NO_MEMORY_POLICY,
      deliveryEmpty: true,
      storedEntryCount: 1,
    });
  } finally {
    database.close();
  }
});

test('delivers a Japanese checkpoint policy to a Japanese-only migration task', async () => {
  const root = await repository('cjk-delivery');
  const database = await createDatabase('cjk-delivery');
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    const entry = recordEntry(database, {
      workspace: project.workspace,
      kind: 'decision',
      status: 'verified',
      title: 'マイグレーション履歴の保全方針',
      body: '過去のマイグレーションファイルは直接編集しない。変更は新しいファイルを追加して前方移行する。',
      tags: ['agent-checkpoint'],
    });

    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-cjk-delivery',
      cwd: root,
      task: '開発環境に既存データがなく、過去のマイグレーションファイルを直接編集することを明示的に承認しているため、テーブルにカラムを追加する。',
      profileHints: {
        taskType: 'build',
        target: 'データベースのマイグレーション',
        expected: '履歴を壊さずにカラムを追加する',
        constraints: null,
      },
      capabilities: [SOUL_CAPABILITY, { kind: 'skill', name: 'memory-reasoning' }],
      client: { kind: 'test', sessionId: 'cjk-delivery' },
      skillDiscoveryMode: 'off',
    });

    assert.equal(prepared.context?.items.some((item) => item.entryId === entry.id), true);
    assert.ok(prepared.context?.deliveryId);
    assert.deepEqual(prepared.memoryPolicy, AVAILABLE_MEMORY_POLICY);
    const delivery = database.prepare(`
      SELECT char_count AS charCount
      FROM context_deliveries
      WHERE delivery_id = ?
    `).get<{ charCount: number }>(prepared.context.deliveryId);
    assert.ok((delivery?.charCount ?? 0) > 0);
  } finally {
    database.close();
  }
});

test('withholds actionable memory before external Skill discovery and continues the task', async () => {
  const root = await repository('no-external-fallback');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const database = await createDatabase('no-external-fallback');
  try {
    const seed = await prepareAgentTask(database, {
      requestId: 'memory-policy-no-external-seed',
      cwd: root,
      task: 'Implement a Svelte component using the beacon workflow',
      profileHints: { taskType: 'build', target: 'Svelte beacon component', expected: 'tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'seed-no-external-fallback' },
      skillDiscoveryMode: 'off',
    });
    recordEntry(database, {
      workspace: seed.project.workspace,
      kind: 'lesson',
      title: 'Svelte beacon workflow',
      body: 'Implement the Svelte beacon workflow with a focused regression test.',
      tags: ['svelte', 'beacon'],
    });

    let networkCalls = 0;
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-no-external-missing',
      cwd: root,
      task: 'Implement a Svelte component using the beacon workflow',
      profileHints: { taskType: 'build', target: 'Svelte beacon component', expected: 'tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'missing-no-external-fallback' },
      skillDiscoveryMode: 'official',
      fetchImpl: async () => { networkCalls += 1; throw new Error('external discovery must not run'); },
    });

    assert.equal(prepared.nextAction, 'proceed');
    assert.equal(prepared.skillDiscovery.attempted, false);
    assert.deepEqual(prepared.skillDiscovery.selected, []);
    assert.equal(networkCalls, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('exact task_prepare replay uses current helpful feedback for the bound weak delivery', async () => {
  const root = await repository('same-run-helpful-replay');
  const database = await createDatabase('same-run-helpful-replay');
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    const entry = recordEntry(database, {
      workspace: project.workspace,
      kind: 'reference',
      title: 'xxbeaconzz historical note',
      body: 'A prior observation with no actionable lexical token.',
      tags: [],
    });
    const request = {
      requestId: 'memory-policy-same-run-helpful-replay',
      cwd: root,
      task: 'beacon',
      profileHints: { taskType: 'build' as const, target: 'src/new.ts', expected: 'passes', constraints: null },
      capabilities: [SOUL_CAPABILITY] as unknown[],
      client: { kind: 'test', sessionId: 'same-run-helpful-replay' },
      skillDiscoveryMode: 'off' as const,
    };
    const first = await prepareAgentTask(database, request);
    const delivered = first.context?.items.find((item) => item.entryId === entry.id);
    assert.ok(delivered);
    assert.equal(delivered.selectionReasons.includes('literal_fallback_match'), true);
    assert.equal(first.nextAction, 'proceed');
    assert.ok(first.context?.deliveryId);

    recordContextFeedback(database, {
      workspace: project.workspace,
      feedbackId: 'same-run-helpful-feedback',
      deliveryId: first.context.deliveryId,
      entryId: entry.id,
      runId: first.run.runId,
      verdict: 'helpful',
      comment: null,
      actor: 'test',
      idempotencyKey: 'same-run-helpful-feedback-key',
      createdAt: '2026-08-25T00:00:00.000Z',
    });

    const replay = await prepareAgentTask(database, request);
    assert.equal(replay.run.runId, first.run.runId);
    assert.equal(replay.nextAction, 'proceed');
    assert.equal(replay.context, null);
    assert.ok(replay.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
      && item.required === true
      && item.availability === 'missing'));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(first.run.runId)?.count, 1);
  } finally {
    database.close();
  }
});

test('exact task_prepare replay reranks when new actionable ordinary memory appears', async () => {
  const root = await repository('same-run-new-memory-replay');
  const database = await createDatabase('same-run-new-memory-replay');
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'reference',
      title: 'xxbeaconzz historical note',
      body: 'A prior observation with no actionable lexical token.',
      tags: [],
    });
    const request = {
      requestId: 'memory-policy-same-run-new-memory-replay',
      cwd: root,
      task: 'beacon',
      profileHints: { taskType: 'build' as const, target: 'src/new.ts', expected: 'passes', constraints: null },
      capabilities: [SOUL_CAPABILITY] as unknown[],
      client: { kind: 'test', sessionId: 'same-run-new-memory-replay' },
      skillDiscoveryMode: 'off' as const,
    };
    const first = await prepareAgentTask(database, request);
    assert.equal(first.nextAction, 'proceed');
    assert.ok(first.context?.deliveryId);

    const actionable = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'beacon exact repair workflow',
      body: 'Use the beacon exact repair workflow before changing production code.',
      tags: ['beacon', 'repair'],
    });
    const replay = await prepareAgentTask(database, request);
    assert.equal(replay.run.runId, first.run.runId);
    assert.equal(replay.nextAction, 'proceed');
    assert.equal(replay.context, null);
    assert.ok(replay.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
      && item.required === true
      && item.availability === 'missing'));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(first.run.runId)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries WHERE entry_id = ?')
      .get<{ count: number }>(actionable.id)?.count, 0);
  } finally {
    database.close();
  }
});

test('exact task_prepare replay gates the current ledger-revised profile', async () => {
  const root = await repository('current-profile-replay');
  const database = await createDatabase('current-profile-replay');
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'current profile replay sentinel',
      body: 'Use the current profile replay sentinel workflow.',
      tags: ['current', 'profile', 'replay', 'sentinel'],
    });
    const request = {
      requestId: 'memory-policy-current-profile-replay',
      cwd: root,
      task: 'Research the current profile replay sentinel',
      profileHints: { taskType: 'research' as const, target: 'current profile replay sentinel', expected: 'verified result', constraints: null },
      capabilities: [SOUL_CAPABILITY] as unknown[],
      client: { kind: 'test', sessionId: 'current-profile-replay' },
      skillDiscoveryMode: 'off' as const,
    };
    const first = await prepareAgentTask(database, request);
    assert.equal(first.nextAction, 'proceed');
    assert.ok(first.context?.deliveryId);

    new CheckpointService(database, () => '2026-08-25T00:00:00.000Z').checkpoint({
      runId: first.run.runId,
      idempotencyKey: 'current-profile-replay-revision',
      request: {
        apiVersion: '1',
        currentGoal: 'Build the current profile replay sentinel',
        taskProfileRevision: { taskType: 'build' },
      },
    });

    const replay = await prepareAgentTask(database, request);
    assert.equal(replay.run.runId, first.run.runId);
    assert.equal(replay.intake.profile.taskType, 'build');
    assert.equal(replay.nextAction, 'proceed');
    assert.equal(replay.context, null);
    assert.ok(replay.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'
      && item.required === true
      && item.availability === 'missing'));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(first.run.runId)?.count, 1);
  } finally {
    database.close();
  }
});

test('exact task_prepare replay rejects a run completed by memory_checkpoint', async () => {
  const root = await repository('terminal-replay');
  const database = await createDatabase('terminal-replay');
  const request = {
    requestId: 'memory-policy-terminal-replay',
    cwd: root,
    task: 'Research the terminal replay boundary',
    profileHints: { taskType: 'research' as const, target: 'terminal replay', expected: 'one active run', constraints: null },
    capabilities: [SOUL_CAPABILITY] as unknown[],
    client: { kind: 'test', sessionId: 'terminal-replay' },
    skillDiscoveryMode: 'off' as const,
  };
  try {
    const first = await prepareAgentTask(database, request);
    await checkpointScopedMemory(database, {
      cwd: root,
      memories: [],
      runId: first.run.runId,
      outcome: 'completed',
      evidence: { verification: { outcome: 'fresh' } },
    });
    const deliveries = database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(first.run.runId)?.count;

    await assert.rejects(prepareAgentTask(database, request), (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && error.message === 'Task run is terminal');
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(first.run.runId)?.status, 'completed');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(first.run.runId)?.count, deliveries);
  } finally {
    database.close();
  }
});

test('missing memory-reasoning still discovers reference-only external skills when ordinary memory is absent', async () => {
  const root = await repository('external-reference-not-memory');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const database = await createDatabase('external-reference-not-memory');
  const commit = 'd'.repeat(40);
  let networkCalls = 0;
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const textResponse = (value: string) => new Response(value, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
  const fetchImpl: typeof fetch = async (raw) => {
    networkCalls += 1;
    const url = new URL(String(raw));
    if (url.hostname === 'skills.sh') {
      return jsonResponse({ skills: [{
        id: 'sveltejs/ai-tools/svelte-code-writer',
        source: 'sveltejs/ai-tools',
        name: 'svelte-code-writer',
        installs: 3,
      }] });
    }
    if (url.pathname === '/repos/sveltejs/ai-tools') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: commit });
    if (url.pathname.includes(`/git/trees/${commit}`)) return jsonResponse({
      truncated: false,
      tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }],
    });
    if (url.pathname.endsWith('/SKILL.md')) {
      return textResponse('---\nname: Svelte Code Writer\ndescription: Safe Svelte references\n---\n# Svelte\n\nVerify the current repository.');
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-external-reference-not-memory',
      cwd: root,
      task: 'Implement a Svelte component',
      profileHints: { taskType: 'build', target: 'Svelte component', expected: 'tests pass', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'external-reference-not-memory' },
      skillDiscoveryMode: 'official',
      fetchImpl,
    });

    assert.ok(networkCalls > 0);
    assert.equal(prepared.skillDiscovery.attempted, true);
    assert.ok(prepared.skillDiscovery.selected.length > 0, JSON.stringify(prepared.skillDiscovery));
    assert.equal(prepared.nextAction, 'proceed', JSON.stringify(prepared));
    assert.notEqual(prepared.context, null);
    assert.ok((prepared.context?.items.length ?? 0) > 0);
    assert.equal(prepared.capabilities.recommendations.some((item) => item.name === 'memory-reasoning'), false);
    assert.deepEqual(prepared.memoryPolicy, NO_MEMORY_POLICY);
    assert.ok(prepared.context?.items.every((item) => item.origin === 'ecosystem'));
  } finally {
    database.close();
  }
});

test('discovery rolls back external imports when the task run becomes terminal during source fetch', async () => {
  const root = await repository('terminal-during-discovery');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const { database, concurrent } = await createDatabasePair('terminal-during-discovery');
  let terminalized = false;
  const fetchImpl = svelteDiscoveryFetch(async (url) => {
    if (terminalized || !url.pathname.endsWith('/SKILL.md')) return;
    const row = concurrent.prepare('SELECT run_id AS runId FROM ledger_runs ORDER BY created_at DESC LIMIT 1')
      .get<{ runId: string }>();
    assert.ok(row);
    terminalized = true;
    await checkpointScopedMemory(concurrent, {
      cwd: root,
      memories: [],
      runId: row.runId,
      outcome: 'completed',
      evidence: { verification: { outcome: 'fresh' } },
    });
  });
  try {
    await assert.rejects(
      prepareAgentTask(database, {
        requestId: 'memory-policy-terminal-during-discovery',
        cwd: root,
        task: 'Implement a Svelte component',
        profileHints: { taskType: 'build', target: 'Svelte component', expected: 'tests pass', constraints: null },
        capabilities: [SOUL_CAPABILITY],
        client: { kind: 'test', sessionId: 'terminal-during-discovery' },
        skillDiscoveryMode: 'official',
        fetchImpl,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'External Skill discovery failed closed',
    );
    assert.equal(terminalized, true);
    assert.equal(database.prepare('SELECT status FROM ledger_runs').get<{ status: string }>()?.status, 'completed');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries WHERE created_by = 'kiokuko-skill-discovery'")
      .get<{ count: number }>()?.count, 0);
  } finally {
    concurrent.close();
    database.close();
  }
});

test('discovery rolls back external imports when the live manifest changes during fetch', async () => {
  const root = await repository('manifest-during-discovery');
  const manifestPath = path.join(root, 'package.json');
  await writeFile(manifestPath, JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const database = await createDatabase('manifest-during-discovery');
  let changed = false;
  const fetchImpl = svelteDiscoveryFetch(async (url) => {
    if (changed || url.hostname !== 'skills.sh') return;
    changed = true;
    await writeFile(manifestPath, JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  });
  try {
    await assert.rejects(
      prepareAgentTask(database, {
        requestId: 'memory-policy-manifest-during-discovery',
        cwd: root,
        task: 'Implement a Svelte component',
        profileHints: { taskType: 'build', target: 'Svelte component', expected: 'tests pass', constraints: null },
        capabilities: [SOUL_CAPABILITY],
        client: { kind: 'test', sessionId: 'manifest-during-discovery' },
        skillDiscoveryMode: 'official',
        fetchImpl,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'External Skill discovery failed closed',
    );
    assert.equal(changed, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('defers malformed manifest parsing while intake needs an answer and canonicalizes the effective MCP client', async () => {
  const root = await repository('deferred-manifest');
  await writeFile(path.join(root, 'package.json'), '{');
  const database = await createDatabase('deferred-manifest');
  let networkCalls = 0;
  const request = {
    requestId: 'memory-policy-deferred-manifest',
    cwd: root,
    task: 'Implement the requested change',
    capabilities: [SOUL_CAPABILITY] as unknown[],
    skillDiscoveryMode: 'official' as const,
    fetchImpl: async () => { networkCalls += 1; throw new Error('discovery must wait for intake'); },
  };
  try {
    const omittedClient = await prepareAgentTask(database, request);
    const explicitDefaultClient = await prepareAgentTask(database, { ...request, client: { kind: 'mcp' } });

    assert.equal(omittedClient.intake.status, 'needs_answer');
    assert.equal(omittedClient.context, null);
    assert.equal(omittedClient.skillDiscovery.attempted, false);
    assert.equal(explicitDefaultClient.run.runId, omittedClient.run.runId);
    assert.equal(networkCalls, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_fingerprints').get<{ count: number }>()?.count, 0);

    await assert.rejects(
      prepareAgentTask(database, {
        ...request,
        requestId: 'memory-policy-deferred-manifest-ready',
        profileHints: { taskType: 'build', target: 'src/change.ts', expected: 'tests pass', constraints: null },
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'VALIDATION_ERROR'
        && error.message === 'Supported project manifest is invalid',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_fingerprints').get<{ count: number }>()?.count, 0);
    assert.equal(networkCalls, 0);
  } finally {
    database.close();
  }
});

test('exposes only code-point-bounded scoped context for prepared memory', async () => {
  const root = await repository('unicode-reference-budget');
  const database = await createDatabase('unicode-reference-budget');
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'reference',
      status: 'verified',
      title: 'abc',
      body: '🙂🚀終🧪',
    }, { idFactory: () => 'entry-agent-unicode-reference' });

    const prepared = await prepareAgentTask(database, {
      requestId: 'memory-policy-unicode-budget',
      cwd: root,
      task: 'abc',
      profileHints: { taskType: 'research', target: 'abc', expected: 'bounded reference', constraints: null },
      capabilities: [SOUL_CAPABILITY],
      maxContextChars: 5,
      client: { kind: 'test', sessionId: 'unicode-reference-budget' },
      skillDiscoveryMode: 'off',
    });

    assert.equal(prepared.context?.items[0]?.bodyPreview, '🙂🚀');
    assert.equal(Array.from(prepared.context?.items[0]?.bodyPreview ?? '').length, 2);
    assert.equal('memory' in prepared, false);
    assert.equal('references' in prepared, false);
  } finally {
    database.close();
  }
});
