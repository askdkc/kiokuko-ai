import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { OpenCodeTaskRunDriver } from '../fixtures/opencode-task-run-driver.js';
import { queryScopedContext, queryScopedContextGated } from '../../src/context/scoped-broker.js';
import { readContextDelivery } from '../../src/context/delivery.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { supersedeEntry } from '../../src/memory/lifecycle.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { canonicalEntryRevisionContentHash, canonicalJson } from '../../src/serialization/validate.js';
import { CONTEXT_SELECTION_STATE_MAX_ENTRIES } from '../../src/context/selection-state.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { importSkillSnapshot, setExternalSkillState } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRequirement } from '../../src/skills/types.js';
import { hashLedgerEvent } from '../../src/ledger/hash.js';
import { LedgerStore } from '../../src/ledger/store.js';
import type { JsonValue, Redaction } from '../../src/ledger/types.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { readContextRunRetrievalState } from '../../src/context/run-state.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-25T00:00:00.000Z';

const scopedSkillCandidate: SkillCandidate = {
  id: 'fixture:microsoft/typescript:typescript-context',
  provider: 'fixture',
  name: 'TypeScript Context',
  slug: 'typescript-context',
  source: 'microsoft/typescript',
  sourceType: 'github',
  installUrl: 'https://github.com/microsoft/typescript',
  installs: 1,
  duplicate: false,
  officialStatus: 'catalog-verified',
};

const scopedSkillRequirement: SkillRequirement = {
  id: 'typescript',
  technology: 'TypeScript',
  aliases: ['typescript'],
  queries: ['typescript'],
  owners: ['microsoft'],
  repositories: ['microsoft/typescript'],
  applicability: { languages: ['TypeScript'] },
  signals: { packages: ['typescript'] },
  reason: 'scoped replay fixture',
};

async function importScopedSkill(database: Awaited<ReturnType<typeof openConnection>>) {
  const snapshot = validateSkillSnapshot({
    candidate: scopedSkillCandidate,
    sourceCommit: 'c'.repeat(40),
    files: [{
      path: 'skills/typescript-context/SKILL.md',
      content: '---\nname: TypeScript Context\ndescription: Exact scoped TypeScript context\n---\n# TypeScript Context Sentinel\n\nUse strict TypeScript evidence.',
      primary: true,
    }],
  });
  const authorization = await authorizeSkillMaterialization({
    id: scopedSkillCandidate.provider,
    search: async () => ({ provider: scopedSkillCandidate.provider, experimental: false, candidates: [] }),
    audit: async () => ({ status: 'passed' as const }),
  }, scopedSkillCandidate);
  assert.equal(authorization.status, 'passed');
  if (authorization.status !== 'passed') throw new Error('Scoped test provider did not authorize materialization');
  return importSkillSnapshot(
    database,
    snapshot,
    documentsFromSkillSnapshot(snapshot),
    scopedSkillRequirement,
    now,
    authorization.authorization,
  );
}

function rewriteScopedLastEventPayload(
  database: Awaited<ReturnType<typeof openConnection>>,
  runId: string,
  payload: JsonValue,
): void {
  const row = new LedgerStore(database).readEvents(runId).at(-1);
  assert.ok(row);
  const redaction = JSON.parse(row.redaction_json) as Redaction[];
  const eventHash = hashLedgerEvent({
    runId,
    sequence: row.sequence,
    eventId: row.event_id,
    previousHash: row.previous_hash,
    eventType: row.event_type,
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    ...(row.source_sequence === null ? {} : { sourceSequence: row.source_sequence }),
    ...(row.source_type === null ? {} : { sourceType: row.source_type }),
    actor: row.actor,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at }),
    ingestedAt: row.ingested_at,
    payload,
    redaction,
  });
  database.prepare('UPDATE ledger_events SET payload_json = ?, event_hash = ? WHERE event_id = ?')
    .run(canonicalJson(payload), eventHash, row.event_id);
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

async function fixture(target = 'budget sentinel', expected = 'bounded context') {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-scoped-budget-root-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-scoped-budget-db-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database, migrations);
  const project = await resolveProjectWorkspace(database, root);
  assert.ok(project);
  const service = new OpenCodeTaskRunDriver(database, { now: () => now });
  const opened = service.openRun({
    idempotencyKey: 'scoped-budget-run',
    request: {
      apiVersion: '1',
      workspace: project.workspace,
      client: { kind: 'scoped-budget-test' },
      task: {
        title: 'Use budget sentinel context',
        query: 'Use budget sentinel context',
        profileHints: { taskType: 'build', target, expected, constraints: null },
      },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      metadata: {},
    },
  });
  return { database, databasePath, project, runId: opened.runId };
}

test('rejects a scoped task profile that is not bound to the authoritative run before ranking or mutation', async () => {
  const { database, project, runId } = await fixture();
  let gateCalls = 0;
  const counts = () => ({
    deliveries: database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()!.count,
    fingerprints: database.prepare('SELECT COUNT(*) AS count FROM repository_fingerprints').get<{ count: number }>()!.count,
    globalRepositories: database.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repository_id = ?').get<{ count: number }>('kiokuko_global')!.count,
    repositoryUse: database.prepare('SELECT last_used_at AS lastUsedAt FROM repositories WHERE repository_id = ?')
      .get<{ lastUsedAt: string }>(project.repositoryId),
    locationUse: database.prepare('SELECT last_seen_at AS lastSeenAt FROM repository_locations WHERE repository_id = ? AND canonical_root = ?')
      .get<{ lastSeenAt: string }>(project.repositoryId, project.repositoryRoot),
  });
  const before = counts();
  try {
    await assert.rejects(
      queryScopedContextGated(database, {
        cwd: project.repositoryRoot,
        runId,
        task: 'Use budget sentinel context',
        taskProfile: { taskType: 'research', target: 'forged target', expected: 'forged outcome', constraints: null },
      }, () => {
        gateCalls += 1;
        return { persist: true, value: null };
      }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT'
        && (error as Error).message === 'Scoped context task profile does not match its run',
    );
    assert.equal(gateCalls, 0);
    assert.deepEqual(counts(), before);
  } finally {
    database.close();
  }
});

test('counts multibyte title, summary, and body preview exactly and gives each budget its own stable delivery', async () => {
  const { database, project, runId } = await fixture();
  const title = '🧠題 budget sentinel';
  const summary = '要約🙂';
  const body = '本文🚀終';
  try {
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'reference',
      status: 'verified',
      title,
      summary,
      body,
      tags: ['budget', 'sentinel'],
    }, { now });
    const metadataCost = codePoints(title) + codePoints(summary);
    const fullCost = metadataCost + codePoints(body);
    const query = {
      project,
      task: 'Use budget sentinel context',
      taskProfile: { taskType: 'build' as const, target: 'budget sentinel', expected: 'bounded context', constraints: null },
      runId,
      limit: 1,
    };

    const exact = await queryScopedContext(database, { ...query, characterBudget: fullCost });
    assert.equal(exact.items[0]?.title, title);
    assert.equal(exact.items[0]?.summary, summary);
    assert.equal(exact.items[0]?.bodyPreview, body);
    assert.equal(exact.truncated, false);
    assert.equal(database.prepare('SELECT char_count AS count FROM context_deliveries WHERE delivery_id = ?').get<{ count: number }>(exact.deliveryId!)?.count, fullCost);

    const exactReplay = await queryScopedContext(database, { ...query, characterBudget: fullCost });
    assert.equal(exactReplay.deliveryId, exact.deliveryId);
    assert.deepEqual(exactReplay.items, exact.items);

    const oneUnder = await queryScopedContext(database, { ...query, characterBudget: fullCost - 1 });
    assert.notEqual(oneUnder.deliveryId, exact.deliveryId);
    assert.equal(oneUnder.items[0]?.title, title);
    assert.equal(oneUnder.items[0]?.summary, summary);
    assert.equal(oneUnder.items[0]?.bodyPreview, Array.from(body).slice(0, -1).join(''));
    assert.equal(oneUnder.truncated, true);
    assert.equal(database.prepare('SELECT char_count AS count FROM context_deliveries WHERE delivery_id = ?').get<{ count: number }>(oneUnder.deliveryId!)?.count, fullCost - 1);

    const widerLimit = await queryScopedContext(database, { ...query, limit: 2, characterBudget: fullCost });
    assert.notEqual(widerLimit.deliveryId, exact.deliveryId);
    assert.deepEqual(widerLimit.items, exact.items);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, 3);

    database.prepare('UPDATE context_deliveries SET truncated = 1 WHERE delivery_id = ?').run(exact.deliveryId);
    await assert.rejects(
      queryScopedContext(database, { ...query, characterBudget: fullCost }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR'
        && (error as Error).message === 'Stored scoped context character accounting is invalid',
    );
  } finally {
    database.close();
  }
});

test('fails explicitly when the ordinary context selection corpus exceeds its bounded policy', async () => {
  const { database, project, runId } = await fixture('bounded selection corpus', 'explicit failure');
  try {
    database.prepare(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ), numbers(value) AS (
        SELECT ((((a.value * 10) + b.value) * 10 + c.value) * 10 + d.value) * 10 + e.value
          FROM digits AS a, digits AS b, digits AS c, digits AS d, digits AS e
         LIMIT ?
      )
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      )
      SELECT printf('selection-overflow-%05d', value), ?, 'candidate', 'user_asserted', 0.5, 1,
             NULL, 'test', ?, ?, NULL
        FROM numbers
    `).run(CONTEXT_SELECTION_STATE_MAX_ENTRIES + 1, project.workspace, now, now);

    await assert.rejects(
      queryScopedContext(database, {
        project,
        task: 'bounded selection corpus',
        taskProfile: { taskType: 'build', target: 'bounded selection corpus', expected: 'explicit failure', constraints: null },
        runId,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Context selection state exceeds the policy bound',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('does not count external references or superseded entries toward the ordinary selection bound', async () => {
  const { database, project, runId } = await fixture('zero ordinary selection sentinel', 'empty bounded context');
  const excludedCount = CONTEXT_SELECTION_STATE_MAX_ENTRIES + 1;
  try {
    database.prepare(`
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      ) VALUES ('excluded-selection-replacement', 'project:excluded-selection-replacement',
        'candidate', 'user_asserted', 0.5, 1, NULL, 'test', ?, ?, NULL)
    `).run(now, now);
    database.prepare(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ), numbers(value) AS (
        SELECT ((((a.value * 10) + b.value) * 10 + c.value) * 10 + d.value) * 10 + e.value
          FROM digits AS a, digits AS b, digits AS c, digits AS d, digits AS e
         LIMIT ?
      )
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      )
      SELECT printf('excluded-superseded-%05d', value), ?, 'superseded', 'user_asserted', 0.5, 1,
             'excluded-selection-replacement', 'test', ?, ?, NULL
        FROM numbers
    `).run(excludedCount, project.workspace, now, now);

    database.prepare('INSERT INTO external_skill_generation_tokens DEFAULT VALUES').run();
    const generation = database.prepare('SELECT generation FROM external_skill_generation_tokens ORDER BY generation DESC LIMIT 1')
      .get<{ generation: number }>()?.generation;
    assert.ok(Number.isSafeInteger(generation));
    database.prepare(`
      INSERT INTO external_skills (
        skill_id, generation, provider, source_type, source_locator, slug, name, install_url,
        official_status, duplicate, installs, state, source_workspace, source_commit, snapshot_hash,
        metadata_json, first_seen_at, last_seen_at, last_checked_at, disabled_at
      ) VALUES (
        'excluded-overflow-skill', ?, 'fixture', 'github', 'fixture/excluded-overflow',
        'excluded-overflow', 'Excluded overflow', NULL, 'catalog-verified', 0, 0, 'imported',
        ?, ?, ?, '{}', ?, ?, ?, NULL
      )
    `).run(generation!, project.workspace, 'a'.repeat(40), 'b'.repeat(64), now, now, now);
    database.prepare(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ), numbers(value) AS (
        SELECT ((((a.value * 10) + b.value) * 10 + c.value) * 10 + d.value) * 10 + e.value
          FROM digits AS a, digits AS b, digits AS c, digits AS d, digits AS e
         LIMIT ?
      )
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      )
      SELECT printf('excluded-external-%05d', value), ?, 'candidate', 'source_verified', 1.0, 1,
             NULL, 'kiokuko-skill-discovery', ?, ?, ?
        FROM numbers
    `).run(excludedCount, project.workspace, now, now, now);
    database.prepare(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ), numbers(value) AS (
        SELECT ((((a.value * 10) + b.value) * 10 + c.value) * 10 + d.value) * 10 + e.value
          FROM digits AS a, digits AS b, digits AS c, digits AS d, digits AS e
         LIMIT ?
      )
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, summary, scope_json,
        provenance_json, content_hash, created_by, created_at
      )
      SELECT printf('excluded-external-%05d', value), ?, 1, 'reference',
             printf('excluded overflow reference %05d', value), 'excluded overflow body', NULL,
             '{}', '{"type":"external_skill"}', printf('%064x', value + 1),
             'kiokuko-skill-discovery', ?
        FROM numbers
    `).run(excludedCount, project.workspace, now);
    database.prepare(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ), numbers(value) AS (
        SELECT ((((a.value * 10) + b.value) * 10 + c.value) * 10 + d.value) * 10 + e.value
          FROM digits AS a, digits AS b, digits AS c, digits AS d, digits AS e
         LIMIT ?
      )
      INSERT INTO external_skill_entries (
        skill_id, source_path, chunk_index, entry_id, entry_revision, content_hash,
        primary_document, active, imported_at
      )
      SELECT 'excluded-overflow-skill', printf('docs/excluded-%05d.md', value), 0,
             printf('excluded-external-%05d', value), 1, printf('%064x', value + 1),
             CASE value WHEN 0 THEN 1 ELSE 0 END, 0, ?
        FROM numbers
    `).run(excludedCount, now);

    const result = await queryScopedContext(database, {
      project,
      task: 'zero ordinary selection sentinel',
      taskProfile: { taskType: 'build', target: 'zero ordinary selection sentinel', expected: 'empty bounded context', constraints: null },
      runId,
    });
    assert.deepEqual(result.items, []);
    assert.ok(result.deliveryId);
  } finally {
    database.close();
  }
});

test('selection state ignores unrelated projects and invalidates on current or global ordinary memory', async () => {
  const { database, project, runId } = await fixture('workspace selection sentinel', 'scoped invalidation');
  const otherRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-scoped-budget-other-root-'));
  execFileSync('git', ['init', '-q', otherRoot]);
  await writeFile(path.join(otherRoot, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  try {
    const otherProject = await resolveProjectWorkspace(database, otherRoot);
    assert.ok(otherProject);
    const query = {
      project,
      task: 'workspace selection sentinel',
      taskProfile: { taskType: 'build' as const, target: 'workspace selection sentinel', expected: 'scoped invalidation', constraints: null },
      runId,
      limit: 10,
      characterBudget: 1_000,
    };
    const initial = await queryScopedContext(database, query);
    assert.deepEqual(initial.items, []);

    recordEntry(database, {
      workspace: otherProject.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'workspace selection sentinel unrelated',
      body: 'This entry belongs to a different project.',
      tags: ['workspace', 'selection', 'sentinel'],
    }, { now });
    const unrelated = await queryScopedContext(database, query);
    assert.equal(unrelated.queryHash, initial.queryHash);
    assert.equal(unrelated.deliveryId, initial.deliveryId);
    assert.deepEqual(unrelated.items, []);

    const current = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'workspace selection sentinel current',
      body: 'Current-project ordinary memory must invalidate the selection snapshot.',
      tags: ['workspace', 'selection', 'sentinel'],
    }, { now: '2026-08-25T00:01:00.000Z' });
    const currentResult = await queryScopedContext(database, query);
    assert.notEqual(currentResult.queryHash, unrelated.queryHash);
    assert.notEqual(currentResult.deliveryId, unrelated.deliveryId);
    assert.equal(currentResult.items.some((item) => item.entryId === current.id), true);

    const global = recordEntry(database, {
      workspace: 'global',
      kind: 'lesson',
      status: 'verified',
      title: 'workspace selection sentinel global',
      body: 'Global ordinary memory must invalidate the selection snapshot.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        portableReason: 'This selection-state behavior applies across repositories.',
      }),
      tags: ['workspace', 'selection', 'sentinel'],
    }, { now: '2026-08-25T00:02:00.000Z' });
    const globalResult = await queryScopedContext(database, query);
    assert.notEqual(globalResult.queryHash, currentResult.queryHash);
    assert.notEqual(globalResult.deliveryId, currentResult.deliveryId);
    assert.equal(globalResult.items.some((item) => item.entryId === global.id), true);
  } finally {
    database.close();
  }
});

test('an empty scoped delivery is invalidated when a matching external Skill is imported', async () => {
  const { database, project, runId } = await fixture('TypeScript Context Sentinel', 'strict evidence');
  try {
    const query = {
      project,
      task: 'Use the TypeScript Context Sentinel workflow',
      taskProfile: { taskType: 'build' as const, target: 'TypeScript Context Sentinel', expected: 'strict evidence', constraints: null },
      runId,
      limit: 10,
      characterBudget: 1_000,
    };
    const empty = await queryScopedContext(database, query);
    assert.deepEqual(empty.items, []);
    const imported = await importScopedSkill(database);

    const refreshed = await queryScopedContext(database, query);
    assert.notEqual(refreshed.queryHash, empty.queryHash);
    assert.notEqual(refreshed.deliveryId, empty.deliveryId);
    assert.equal(refreshed.items.some((item) => imported.entries.some((entry) => entry.id === item.entryId)), true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, 2);
  } finally {
    database.close();
  }
});

test('scoped context binds the exact project fingerprint through ranking and replay', async () => {
  const { database, project, runId } = await fixture('TypeScript Context Sentinel', 'strict evidence');
  const manifest = path.join(project.repositoryRoot, 'package.json');
  try {
    const imported = await importScopedSkill(database);
    const importedEntry = imported.entries[0];
    assert.ok(importedEntry);
    const query = {
      project,
      task: 'Use the TypeScript Context Sentinel workflow',
      taskProfile: { taskType: 'build' as const, target: 'TypeScript Context Sentinel', expected: 'strict evidence', constraints: null },
      runId,
      limit: 1,
      characterBudget: 1_000,
    };

    await assert.rejects(
      queryScopedContextGated(database, query, (candidate) => {
        assert.equal(candidate.items[0]?.entryId, importedEntry.id);
        writeFileSync(manifest, JSON.stringify({ dependencies: { react: '^19.0.0' } }));
        return { persist: true, value: 'stale-scoped-fingerprint' as const };
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Scoped context project state changed after ranking',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, 0);

    writeFileSync(manifest, JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
    const typescript = await queryScopedContext(database, query);
    assert.equal(typescript.items[0]?.entryId, importedEntry.id);
    writeFileSync(manifest, JSON.stringify({ dependencies: { react: '^19.0.0' } }));
    const react = await queryScopedContext(database, query);
    assert.notEqual(react.queryHash, typescript.queryHash);
    assert.notEqual(react.deliveryId, typescript.deliveryId);
    assert.deepEqual(react.items, []);
  } finally {
    database.close();
  }
});

test('an empty scoped delivery and capability hash track portable ordinary ecosystem memory', async () => {
  const { database, project, runId } = await fixture('portable TypeScript ecosystem memory', 'strict evidence');
  try {
    const query = {
      project,
      task: 'Use portable TypeScript ecosystem memory',
      taskProfile: { taskType: 'build' as const, target: 'portable TypeScript ecosystem memory', expected: 'strict evidence', constraints: null },
      runId,
      limit: 10,
      characterBudget: 1_000,
    };
    const initial = await queryScopedContextGated(database, query, (candidate) => ({
      persist: false,
      value: candidate,
    }));
    assert.deepEqual(initial.value.items, []);

    await importScopedSkill(database);
    const externalOnly = await queryScopedContextGated(database, query, (candidate) => ({
      persist: false,
      value: candidate,
    }));
    assert.equal(externalOnly.selectionStateHash, initial.selectionStateHash);

    const added = recordEntry(database, {
      workspace: 'project:portable-typescript-source',
      kind: 'lesson',
      status: 'verified',
      title: 'portable TypeScript ecosystem memory',
      body: 'Use the reusable TypeScript ecosystem workflow.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        applicability: { tools: ['TypeScript'] },
        signals: { packages: ['typescript'] },
      }),
      tags: ['typescript', 'portable'],
    }, { now: '2026-08-25T00:01:00.000Z' });
    const refreshed = await queryScopedContextGated(database, query, (candidate) => ({
      persist: false,
      value: candidate,
    }));
    assert.notEqual(refreshed.selectionStateHash, externalOnly.selectionStateHash);
    assert.notEqual(refreshed.value.queryHash, externalOnly.value.queryHash);
    assert.equal(refreshed.value.items.some((item) => item.entryId === added.id), true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('scoped context binds full run title, coverage, and valid same-sequence event state', async () => {
  const mutations: Array<{
    name: string;
    apply: (database: Awaited<ReturnType<typeof openConnection>>, runId: string) => void;
  }> = [
    {
      name: 'title',
      apply: (database, runId) => {
        database.prepare('UPDATE ledger_runs SET title = ? WHERE run_id = ?').run('scoped title mutation', runId);
      },
    },
    {
      name: 'coverage',
      apply: (database, runId) => {
        database.prepare('UPDATE ledger_runs SET coverage_json = ? WHERE run_id = ?').run(canonicalJson({
          run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete',
        }), runId);
      },
    },
    {
      name: 'event',
      apply: (database, runId) => rewriteScopedLastEventPayload(database, runId, { scopedSameSequenceMutation: true }),
    },
  ];
  for (const mutation of mutations) {
    const { database, project, runId } = await fixture(`scoped run state ${mutation.name}`, 'fail closed');
    try {
      const sequence = database.prepare('SELECT last_sequence AS value FROM ledger_runs WHERE run_id = ?')
        .get<{ value: number }>(runId)?.value;
      assert.ok(sequence !== undefined && sequence > 0);
      await assert.rejects(
        queryScopedContextGated(database, {
          project,
          task: `scoped run state ${mutation.name}`,
          taskProfile: { taskType: 'build', target: `scoped run state ${mutation.name}`, expected: 'fail closed', constraints: null },
          runId,
        }, () => {
          mutation.apply(database, runId);
          assert.equal(database.prepare('SELECT last_sequence AS value FROM ledger_runs WHERE run_id = ?')
            .get<{ value: number }>(runId)?.value, sequence);
          return { persist: true, value: 'stale' as const };
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === 'CONFLICT'
          && error.message === 'Scoped context run changed before persistence',
        mutation.name,
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(runId)?.count, 0);
    } finally {
      database.close();
    }
  }
});

test('scoped context rejects an external Skill disable after ranking without persisting stale context', async () => {
  const { database, project, runId } = await fixture('TypeScript Context Sentinel', 'strict evidence');
  try {
    const imported = await importScopedSkill(database);
    await assert.rejects(
      queryScopedContextGated(database, {
        project,
        task: 'Use the TypeScript Context Sentinel workflow',
        taskProfile: { taskType: 'build', target: 'TypeScript Context Sentinel', expected: 'strict evidence', constraints: null },
        runId,
      }, (candidate) => {
        assert.equal(candidate.items.some((item) => imported.entries.some((entry) => entry.id === item.entryId)), true);
        setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T00:01:00.000Z');
        return { persist: true, value: 'stale-external-context' as const };
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Scoped context selection changed before return',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('reserves complete title and summary before the body and fails without writing when metadata cannot fit', async () => {
  const { database, project, runId } = await fixture();
  const title = '🧠 long-title budget sentinel';
  const summary = '完全な要約🙂';
  const body = 'body must be omitted';
  try {
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'reference',
      status: 'verified',
      title,
      summary,
      body,
      tags: ['budget', 'sentinel'],
    }, { now });
    const metadataCost = codePoints(title) + codePoints(summary);
    const query = {
      project,
      task: 'Use budget sentinel context',
      taskProfile: { taskType: 'build' as const, target: 'budget sentinel', expected: 'bounded context', constraints: null },
      runId,
      limit: 1,
    };

    const metadataOnly = await queryScopedContext(database, { ...query, characterBudget: metadataCost });
    assert.equal(metadataOnly.items[0]?.title, title);
    assert.equal(metadataOnly.items[0]?.summary, summary);
    assert.equal(metadataOnly.items[0]?.bodyPreview, '');
    assert.equal(metadataOnly.truncated, true);
    assert.equal(database.prepare('SELECT char_count AS count FROM context_deliveries WHERE delivery_id = ?').get<{ count: number }>(metadataOnly.deliveryId!)?.count, metadataCost);

    await assert.rejects(
      queryScopedContext(database, { ...query, characterBudget: metadataCost - 1 }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
        && (error as Error).message === 'Scoped context character budget cannot fit candidate metadata',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, 1);

    database.prepare('UPDATE context_deliveries SET truncated = 0 WHERE delivery_id = ?').run(metadataOnly.deliveryId);
    await assert.rejects(
      queryScopedContext(database, { ...query, characterBudget: metadataCost }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR'
        && (error as Error).message === 'Stored scoped context character accounting is invalid',
    );
  } finally {
    database.close();
  }
});

test('replays a delivery truncated only by the item limit', async () => {
  const { database, project, runId } = await fixture('limit replay sentinel', 'bounded context');
  try {
    for (const [id, suffix] of [['entry-limit-a', 'alpha'], ['entry-limit-b', 'beta']] as const) {
      recordEntry(database, {
        workspace: project.workspace,
        kind: 'lesson',
        status: 'verified',
        title: `limit replay sentinel ${suffix}`,
        body: `Use the limit replay sentinel ${suffix} workflow.`,
        tags: ['limit', 'sentinel'],
      }, { idFactory: () => id, now });
    }
    const query = {
      project,
      task: 'Use the limit replay sentinel workflow',
      taskProfile: { taskType: 'build' as const, target: 'limit replay sentinel', expected: 'bounded context', constraints: null },
      runId,
      limit: 1,
      characterBudget: 200,
    };

    const delivered = await queryScopedContext(database, query);
    assert.equal(delivered.items.length, 1);
    assert.equal(delivered.truncated, true);

    const replayed = await queryScopedContext(database, query);
    assert.equal(replayed.deliveryId, delivered.deliveryId);
    assert.deepEqual(replayed.items, delivered.items);
    assert.equal(replayed.truncated, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, 1);
  } finally {
    database.close();
  }
});

test('fails closed when a scoped replay delivery disappears inside the gate', async () => {
  const { database, project, runId } = await fixture('scoped replay disappearance sentinel', 'bounded context');
  try {
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'scoped replay disappearance sentinel',
      body: 'Use the scoped replay disappearance sentinel workflow.',
      tags: ['scoped', 'replay', 'disappearance', 'sentinel'],
    }, { now });
    const query = {
      project,
      task: 'Use the scoped replay disappearance sentinel workflow',
      taskProfile: { taskType: 'build' as const, target: 'scoped replay disappearance sentinel', expected: 'bounded context', constraints: null },
      runId,
      limit: 1,
      characterBudget: 300,
    };
    const delivered = await queryScopedContext(database, query);
    assert.ok(delivered.deliveryId);

    await assert.rejects(
      queryScopedContextGated(database, query, (candidate) => {
        assert.equal(candidate.deliveryId, delivered.deliveryId);
        database.prepare('DELETE FROM context_deliveries WHERE delivery_id = ?').run(delivered.deliveryId!);
        return { persist: true, value: 'proceed' as const };
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored scoped context delivery disappeared during replay',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('replaces a scoped delivery after an ordinary entry is superseded', async () => {
  const { database, project, runId } = await fixture('superseded replay sentinel', 'bounded context');
  try {
    const original = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'superseded replay sentinel',
      body: 'Use the superseded replay sentinel workflow.',
      tags: ['superseded', 'sentinel'],
    }, { now });
    const query = {
      project,
      task: 'Use the superseded replay sentinel workflow',
      taskProfile: { taskType: 'build' as const, target: 'superseded replay sentinel', expected: 'bounded context', constraints: null },
      runId,
      limit: 1,
      characterBudget: 200,
    };
    const delivered = await queryScopedContext(database, query);
    assert.equal(delivered.items[0]?.entryId, original.id);

    const replacement = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'unrelated replacement',
      body: 'Unrelated material.',
      tags: ['unrelated'],
    }, { now: '2026-08-25T00:01:00.000Z' });
    supersedeEntry(database, {
      workspace: project.workspace,
      oldEntryId: original.id,
      replacementEntryId: replacement.id,
      expectedRevision: original.revision,
    });

    const refreshed = await queryScopedContext(database, query);
    assert.notEqual(refreshed.deliveryId, delivered.deliveryId);
    assert.equal(refreshed.items.some((item) => item.entryId === original.id), false);
    const replay = await queryScopedContext(database, query);
    assert.equal(replay.deliveryId, refreshed.deliveryId);
    assert.deepEqual(replay.items, refreshed.items);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, 2);
  } finally {
    database.close();
  }
});

test('fails closed when a scoped replay global entry has same-revision scope corruption', async () => {
  const { database, project, runId } = await fixture('scoped global replay scope corruption sentinel', 'bounded context');
  try {
    const globalEntry = recordEntry(database, {
      workspace: 'global',
      kind: 'lesson',
      status: 'verified',
      title: 'scoped global replay scope corruption sentinel',
      body: 'Use the scoped global replay scope corruption sentinel workflow.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        portableReason: 'This workflow applies across repositories.',
      }),
      tags: ['scoped', 'global', 'replay', 'scope', 'corruption', 'sentinel'],
    }, { now });
    const query = {
      project,
      task: 'Use the scoped global replay scope corruption sentinel workflow',
      taskProfile: { taskType: 'build' as const, target: 'scoped global replay scope corruption sentinel', expected: 'bounded context', constraints: null },
      runId,
      limit: 1,
      characterBudget: 300,
    };

    const delivered = await queryScopedContext(database, query);
    assert.equal(delivered.items[0]?.entryId, globalEntry.id);
    assert.equal(delivered.items[0]?.origin, 'global');

    const corruptScope = buildStructuredScope({ visibility: 'project' });
    const corruptHash = canonicalEntryRevisionContentHash({ ...globalEntry, scope: corruptScope });
    database.exec('DROP TRIGGER entry_revisions_immutable_update');
    database.prepare('UPDATE entry_revisions SET scope_json = ?, content_hash = ? WHERE entry_id = ? AND revision = ?')
      .run(canonicalJson(corruptScope), corruptHash, globalEntry.id, globalEntry.revision);

    await assert.rejects(
      queryScopedContext(database, query),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored global memory scope is invalid',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, 1);
  } finally {
    database.close();
  }
});

test('gated scoped context rejects an ordinary entry committed from a second connection after ranking', async () => {
  const { database, databasePath, project, runId } = await fixture('late gated memory sentinel', 'bounded context');
  const concurrent = openConnection(databasePath);
  try {
    const query = {
      project,
      task: 'Use a late gated memory sentinel',
      taskProfile: { taskType: 'build' as const, target: 'late gated memory sentinel', expected: 'bounded context', constraints: null },
      runId,
      limit: 10,
      characterBudget: 500,
    };
    await assert.rejects(
      queryScopedContextGated(database, query, (candidate) => {
        assert.deepEqual(candidate.items, []);
        recordEntry(concurrent, {
          workspace: project.workspace,
          kind: 'lesson',
          status: 'verified',
          title: 'late gated memory sentinel',
          body: 'This actionable memory appeared only after the immutable candidate was ranked.',
          tags: ['late', 'gated', 'sentinel'],
        }, { now: '2026-08-25T00:01:00.000Z' });
        return { persist: true, value: 'proceed' as const };
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Scoped context catalog changed after ranking',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, 0);
  } finally {
    concurrent.close();
    database.close();
  }
});

test('gated scoped context rechecks after its persistence assertion and rolls back catalog mutation', async () => {
  const { database, project, runId } = await fixture('scoped gate assertion mutation sentinel', 'fail closed');
  try {
    const selected = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'scoped gate assertion mutation sentinel',
      body: 'The scoped broker must recheck state after the persistence assertion returns.',
      tags: ['scoped', 'gate', 'assertion', 'mutation', 'sentinel'],
    }, { now });
    const signalsBefore = database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals WHERE entry_id = ?')
      .get<{ count: number }>(selected.id)?.count ?? 0;
    assert.ok(signalsBefore > 0);

    await assert.rejects(
      queryScopedContextGated(database, {
        project,
        task: 'Use the scoped gate assertion mutation sentinel',
        taskProfile: {
          taskType: 'build',
          target: 'scoped gate assertion mutation sentinel',
          expected: 'fail closed',
          constraints: null,
        },
        runId,
      }, (candidate) => {
        assert.equal(candidate.items[0]?.entryId, selected.id);
        return {
          persist: true,
          value: 'hostile-scoped-assertion' as const,
          assertBeforePersist: () => {
            database.prepare('DELETE FROM entry_search_signals WHERE entry_id = ?').run(selected.id);
          },
        };
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Scoped context catalog changed after ranking',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals WHERE entry_id = ?')
      .get<{ count: number }>(selected.id)?.count, signalsBefore);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('rejected and throwing scoped context gates write and return no delivery', async () => {
  const { database, project, runId } = await fixture('rejected gated memory sentinel', 'bounded context');
  const query = {
    project,
    task: 'Use a rejected gated memory sentinel',
    taskProfile: { taskType: 'build' as const, target: 'rejected gated memory sentinel', expected: 'bounded context', constraints: null },
    runId,
    limit: 10,
    characterBudget: 500,
  };
  try {
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'rejected gated memory sentinel',
      body: 'Reject this actionable memory before persistence.',
      tags: ['rejected', 'gated', 'sentinel'],
    }, { now });

    let accessorReads = 0;
    await assert.rejects(
      queryScopedContextGated(database, query, () => Object.defineProperties({}, {
        persist: {
          enumerable: true,
          get: () => {
            accessorReads += 1;
            return accessorReads > 1;
          },
        },
        value: { enumerable: true, value: 'nominally-rejected' },
      }) as { persist: boolean; value: string }),
      (error: unknown) => error instanceof TypeError
        && error.message === 'Scoped context gate returned an invalid decision',
    );
    assert.equal(accessorReads, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, 0);

    const rejected = await queryScopedContextGated(database, query, (candidate) => {
      assert.equal(candidate.items.length, 1);
      return { persist: false, value: 'required_capability_unavailable' as const };
    });
    assert.equal(rejected.value, 'required_capability_unavailable');
    assert.equal(rejected.context, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, 0);

    await assert.rejects(
      queryScopedContextGated(database, { ...query, task: `${query.task} throwing` }, () => {
        throw new Error('gate failed');
      }),
      /gate failed/u,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, 0);
  } finally {
    database.close();
  }
});
