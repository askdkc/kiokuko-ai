import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claimTaskSkillDiscoveryAttempt, completeTaskSkillDiscoveryAttempt, failTaskSkillDiscoveryAttempt, readTaskSkillDiscoveryAttempt } from '../../src/akinator/skill-discovery-attempt.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { SkillProviderError } from '../../src/skills/providers/schema.js';
import type { SkillDiscoverySummary } from '../../src/skills/types.js';
import { LedgerStore } from '../../src/ledger/store.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  migrateDatabase(database);
  new LedgerStore(database, { now: () => '2026-08-28T00:00:00.000Z' }).createRun({
    runId: 'discovery-budget-run',
    workspace: 'workspace:discovery-budget',
    protocolVersion: '1',
    client: { kind: 'opencode' as const },
    captureProfile: 'minimal',
    coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
    task: {
      title: 'Exercise discovery budget',
      query: 'Exercise discovery budget',
      profileHints: { taskType: 'build', target: null, expected: null, constraints: null },
    },
    startedAt: '2026-08-28T00:00:00.000Z',
  });
  return database;
}

function identity(requestDigest: string, phase: 'intake' | 'zenki' = 'intake') {
  return {
    runId: 'discovery-budget-run',
    phase,
    requestDigest,
    mode: 'official' as const,
  };
}

function selected(skillId: string): SkillDiscoverySummary['selected'][number] {
  return {
    skillId,
    name: `Skill ${skillId}`,
    source: 'example/skills',
    officialStatus: 'catalog-verified',
    imported: true,
    updated: false,
  };
}

function summary(queries: string[], selectedSkills: SkillDiscoverySummary['selected'] = []): SkillDiscoverySummary {
  return {
    attempted: queries.length > 0,
    mode: 'official',
    requirements: queries.length > 0 ? ['svelte'] : [],
    queries,
    cacheHits: 0,
    candidates: selectedSkills.length,
    selected: selectedSkills,
    failures: [],
  };
}

test('discovery attempts distinguish digest replay, reserve active work, and consume a run-wide budget', async () => {
  const database = await temporaryDatabase('discovery-budget');
  try {
    const first = identity('a'.repeat(64));
    assert.deepEqual(claimTaskSkillDiscoveryAttempt(database, first), {
      kind: 'execute', queryBudget: 3, selectionBudget: 2,
    });
    const firstSummary = summary(['svelte']);
    assert.deepEqual(completeTaskSkillDiscoveryAttempt(database, first, firstSummary), firstSummary);
    assert.deepEqual(claimTaskSkillDiscoveryAttempt(database, first), { kind: 'replay', summary: firstSummary });
    assert.deepEqual(readTaskSkillDiscoveryAttempt(database, first), { kind: 'replay', summary: firstSummary });

    const second = identity('b'.repeat(64), 'zenki');
    assert.deepEqual(claimTaskSkillDiscoveryAttempt(database, second), {
      kind: 'execute', queryBudget: 2, selectionBudget: 2,
    });
    assert.throws(() => claimTaskSkillDiscoveryAttempt(database, identity('c'.repeat(64), 'zenki')), /already in progress/iu);
    assert.throws(() => claimTaskSkillDiscoveryAttempt(database, second), /already in progress/iu);

    const secondSummary = summary(['svelte', 'sveltekit'], [selected('one'), selected('two')]);
    assert.deepEqual(completeTaskSkillDiscoveryAttempt(database, second, secondSummary), secondSummary);
    const exhausted = identity('c'.repeat(64), 'zenki');
    assert.deepEqual(claimTaskSkillDiscoveryAttempt(database, exhausted), {
      kind: 'execute', queryBudget: 0, selectionBudget: 0,
    });
    const empty = summary([]);
    assert.deepEqual(completeTaskSkillDiscoveryAttempt(database, exhausted, empty), empty);
    assert.deepEqual(readTaskSkillDiscoveryAttempt(database, exhausted), { kind: 'replay', summary: empty });
    assert.deepEqual(database.prepare(`
      SELECT phase, request_digest AS requestDigest,
             reserved_query_count AS reservedQueries, reserved_selection_count AS reservedSelections,
             consumed_query_count AS consumedQueries, consumed_selection_count AS consumedSelections
      FROM task_skill_discovery_attempts
      WHERE run_id = ? ORDER BY request_digest
    `).all('discovery-budget-run').map((row) => ({ ...row })), [
      {
        phase: 'intake', requestDigest: 'a'.repeat(64),
        reservedQueries: 3, reservedSelections: 2, consumedQueries: 1, consumedSelections: 0,
      },
      {
        phase: 'zenki', requestDigest: 'b'.repeat(64),
        reservedQueries: 2, reservedSelections: 2, consumedQueries: 2, consumedSelections: 2,
      },
      {
        phase: 'zenki', requestDigest: 'c'.repeat(64),
        reservedQueries: 0, reservedSelections: 0, consumedQueries: 0, consumedSelections: 0,
      },
    ]);
  } finally {
    database.close();
  }
});

test('failed discovery consumes its reserved budget while a changed digest can use only what remains', async () => {
  const database = await temporaryDatabase('discovery-failure-budget');
  try {
    const failed = identity('d'.repeat(64), 'zenki');
    assert.deepEqual(claimTaskSkillDiscoveryAttempt(database, failed, { queryBudget: 1, selectionBudget: 1 }), {
      kind: 'execute', queryBudget: 1, selectionBudget: 1,
    });
    assert.throws(
      () => failTaskSkillDiscoveryAttempt(database, failed, new KiokukoError('CONFLICT', 'provider failed')),
      /External Skill discovery failed closed/iu,
    );
    const failedRow = database.prepare(`
      SELECT state, reserved_query_count AS reservedQueries, reserved_selection_count AS reservedSelections,
             consumed_query_count AS consumedQueries, consumed_selection_count AS consumedSelections
      FROM task_skill_discovery_attempts WHERE run_id = ? AND phase = ?
    `).get('discovery-budget-run', 'zenki');
    assert.deepEqual(failedRow === undefined ? undefined : { ...failedRow }, {
      state: 'failed', reservedQueries: 1, reservedSelections: 1, consumedQueries: 1, consumedSelections: 1,
    });
    assert.throws(() => claimTaskSkillDiscoveryAttempt(database, failed), /External Skill discovery failed closed/iu);

    const retry = identity('e'.repeat(64), 'zenki');
    assert.deepEqual(claimTaskSkillDiscoveryAttempt(database, retry), {
      kind: 'execute', queryBudget: 2, selectionBudget: 1,
    });
    completeTaskSkillDiscoveryAttempt(database, retry, summary([]));
  } finally {
    database.close();
  }
});

test('generic attempt replay preserves typed provider failures and rejects unknown stored codes', async () => {
  const database = await temporaryDatabase('discovery-provider-failure-boundary');
  try {
    const malformed = identity('f'.repeat(64), 'zenki');
    claimTaskSkillDiscoveryAttempt(database, malformed, { queryBudget: 1, selectionBudget: 1 });
    assert.throws(
      () => failTaskSkillDiscoveryAttempt(database, malformed, new SkillProviderError('registry_invalid_response')),
      (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response',
    );
    assert.throws(
      () => readTaskSkillDiscoveryAttempt(database, malformed),
      (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response',
    );

    const unknown = identity('0'.repeat(64), 'intake');
    database.prepare(`
      INSERT INTO task_skill_discovery_attempts (
        run_id, phase, request_digest,
        reserved_query_count, reserved_selection_count,
        consumed_query_count, consumed_selection_count,
        state, summary_json, failure_json, started_at, finished_at
      ) VALUES (?, ?, ?, 0, 0, 0, 0, 'failed', NULL, ?, ?, ?)
    `).run(
      unknown.runId,
      unknown.phase,
      unknown.requestDigest,
      '{"code":"registry_future_failure","kind":"skill_provider","retryAfterSeconds":null}',
      '2026-08-28T00:00:00.000Z',
      '2026-08-28T00:00:00.000Z',
    );
    assert.throws(
      () => readTaskSkillDiscoveryAttempt(database, unknown),
      (error: unknown) => error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR',
    );
  } finally {
    database.close();
  }
});
