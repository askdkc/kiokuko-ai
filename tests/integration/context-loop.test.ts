import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { OpenCodeTaskRunDriver } from '../fixtures/opencode-task-run-driver.js';
import { ContextBroker, readContextBrokerRunState } from '../../src/context/broker.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { canonicalEntryRevisionContentHash, canonicalJson } from '../../src/serialization/validate.js';
import { searchEntries } from '../../src/memory/retrieval.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import {
  externalSkillRefreshExpectation,
  importSkillSnapshot,
  listExternalSkills,
  refreshExternalSkillSnapshot,
  setExternalSkillState,
} from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRequirement } from '../../src/skills/types.js';
import { GENESIS_HASH, hashLedgerEvent } from '../../src/ledger/hash.js';
import { LedgerStore } from '../../src/ledger/store.js';
import type { JsonValue, Redaction } from '../../src/ledger/types.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-20T00:00:00.000Z';

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-loop-'));
  const value = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(value, migrations);
  return value;
}

function open(service: OpenCodeTaskRunDriver, workspace: string, hints: Record<string, unknown>) {
  return service.openRun({
    idempotencyKey: `open-${workspace}`,
    request: {
      workspace,
      client: { kind: 'context-test' },
      task: { title: 'Implement local context', query: 'Implement local context', profileHints: hints },
      captureProfile: 'standard',
      coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
      metadata: {},
    },
  });
}

const replayCandidate: SkillCandidate = {
  id: 'fixture:sveltejs/ai-tools:svelte-code-writer',
  provider: 'fixture',
  name: 'Svelte Code Writer',
  slug: 'svelte-code-writer',
  source: 'sveltejs/ai-tools',
  sourceType: 'github',
  installUrl: 'https://github.com/sveltejs/ai-tools',
  installs: 1,
  duplicate: false,
  officialStatus: 'catalog-verified',
};

const replayRequirement: SkillRequirement = {
  id: 'svelte',
  technology: 'Svelte',
  aliases: ['svelte'],
  queries: ['svelte'],
  owners: ['sveltejs'],
  repositories: ['sveltejs/ai-tools'],
  applicability: { frameworks: [{ name: 'Svelte', version: '>=5 <6' }] },
  signals: { packages: ['svelte'] },
  reason: 'context replay fixture',
};

function importReplaySkill(db: Awaited<ReturnType<typeof database>>) {
  const snapshot = validateSkillSnapshot({
    candidate: replayCandidate,
    sourceCommit: 'd'.repeat(40),
    files: [{
      path: 'skills/svelte-code-writer/SKILL.md',
      content: '---\nname: Svelte Code Writer\ndescription: Safe Svelte replay context\n---\n# Svelte Replay Guidance\n\nUse current Svelte evidence.',
      primary: true,
    }],
  });
  return importSkillSnapshot(db, snapshot, documentsFromSkillSnapshot(snapshot), replayRequirement, now);
}

function rewriteLastEventPayload(
  db: Awaited<ReturnType<typeof database>>,
  runId: string,
  payload: JsonValue,
): void {
  const row = new LedgerStore(db).readEvents(runId).at(-1);
  assert.ok(row);
  const redaction = JSON.parse(row.redaction_json) as Redaction[];
  const eventHash = hashLedgerEvent({
    runId,
    sequence: row.sequence,
    eventId: row.event_id,
    previousHash: row.previous_hash ?? GENESIS_HASH,
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
  db.prepare('UPDATE ledger_events SET payload_json = ?, event_hash = ? WHERE event_id = ?')
    .run(canonicalJson(payload), eventHash, row.event_id);
}

test('context broker returns no context for needs_answer', async () => {
  const db = await database();
  const service = new OpenCodeTaskRunDriver(db, { now: () => now });
  const opened = open(service, 'needs-answer', { taskType: 'build' });
  const broker = new ContextBroker(db);
  const result = await broker.query({ workspace: 'needs-answer', runId: opened.runId });
  assert.equal(result.status, 'needs_answer');
  assert.equal(result.context, null);
});

test('needs_answer broker fails closed when intake finalizes after preparation', async () => {
  const db = await database();
  try {
    const service = new OpenCodeTaskRunDriver(db, { now: () => now });
    const opened = open(service, 'needs-answer-finalization-race', { taskType: 'build' });
    assert.equal(opened.intakeStatus, 'needs_answer');
    assert.equal(opened.currentQuestion?.id, 'target');
    const broker = new ContextBroker(db);

    await assert.rejects(
      broker.queryGated(
        { workspace: 'needs-answer-finalization-race', runId: opened.runId },
        (candidate) => {
          assert.equal(candidate.status, 'needs_answer');
          assert.equal(candidate.context, null);
          const withTarget = service.answerIntake({
            runId: opened.runId,
            idempotencyKey: 'needs-answer-race-target',
            request: { questionId: 'target', value: 'src/race.ts' },
          });
          assert.equal(withTarget.currentQuestion?.id, 'expected');
          const finalized = service.answerIntake({
            runId: opened.runId,
            idempotencyKey: 'needs-answer-race-expected',
            request: { questionId: 'expected', value: 'focused tests pass' },
          });
          assert.equal(finalized.intakeStatus, 'ready');
          return { persist: false, value: 'stale-needs-answer' as const };
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context delivery conflicts with current run state',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);
    assert.equal(service.readRun({ runId: opened.runId }).status, 'active');
  } finally {
    db.close();
  }
});

test('active intake derives current tags without rejecting its intentionally stale link snapshot', async () => {
  const db = await database();
  try {
    const service = new OpenCodeTaskRunDriver(db, { now: () => now });
    const opened = service.openRun({
      idempotencyKey: 'open-active-derived-tags',
      request: {
        workspace: 'active-derived-tags',
        client: { kind: 'context-test' },
        task: { title: 'Opaque request', query: 'Opaque request', profileHints: {} },
        captureProfile: 'standard',
        coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
        metadata: {},
      },
    });
    assert.equal(opened.currentQuestion?.id, 'taskType');
    const answered = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'answer-active-derived-tags-task-type',
      request: { questionId: 'taskType', value: 'build' },
    });
    assert.equal(answered.intakeStatus, 'needs_answer');
    assert.equal(answered.currentQuestion?.id, 'target');
    assert.equal(db.prepare('SELECT recommended_tags_json AS value FROM run_intakes WHERE run_id = ?')
      .get<{ value: string }>(opened.runId)?.value, canonicalJson(['bot:common']));

    const runState = readContextBrokerRunState(db, opened.runId);
    assert.deepEqual(runState.recommendedTags, ['bot:builder', 'skill:tdd']);
    const result = await new ContextBroker(db).query({ workspace: 'active-derived-tags', runId: opened.runId });
    assert.equal(result.status, 'needs_answer');
    assert.equal(result.context, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);
  } finally {
    db.close();
  }
});

test('ready context is local-first, stores one deterministic delivery, and suppresses the retry', async () => {
  const db = await database();
  const service = new OpenCodeTaskRunDriver(db, { now: () => now });
  const opened = open(service, 'ready-local', { taskType: 'build', target: 'src/app.ts', expected: 'tests pass' });
  recordEntry(db, {
    workspace: 'ready-local', kind: 'reference', title: 'Implement local context src/app.ts tests pass',
    body: 'Local 🧠 context data.', summary: 'Implement local context src/app.ts tests pass 🙂',
    tags: ['bot:builder', 'skill:test-driven-development'], createdBy: 'test', actor: 'test',
  }, { now });
  const broker = new ContextBroker(db);
  const first = await broker.query({ workspace: 'ready-local', runId: opened.runId, limit: 1 });
  const second = await broker.query({ workspace: 'ready-local', runId: opened.runId, limit: 1 });
  assert.equal(first.status, 'ready');
  assert.ok(first.context);
  assert.equal(first.context?.items.length, 1);
  assert.equal(second.context?.deliveryId, first.context?.deliveryId);
  assert.deepEqual(second.context?.items.map((item) => [item.entryId, item.entryRevision, item.content]), first.context?.items.map((item) => [item.entryId, item.entryRevision, item.content]));
  const count = db.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>();
  assert.equal(count?.count, 1);
});

test('generic broker binds selection state to registered federation or the requested workspace only', async () => {
  const db = await database();
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-selection-project-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  try {
    const project = await resolveProjectWorkspace(db, root);
    assert.ok(project);
    const registered = open(new OpenCodeTaskRunDriver(db, { now: () => now }), project.workspace, {
      taskType: 'build', target: 'registered selection sentinel', expected: 'scoped replay',
    });
    const broker = new ContextBroker(db);
    const registeredInput = { workspace: project.workspace, runId: registered.runId, limit: 10 };
    const initial = await broker.query(registeredInput);
    assert.deepEqual(initial.context?.items, []);

    recordEntry(db, {
      workspace: 'project:unrelated-generic-selection',
      kind: 'lesson',
      status: 'verified',
      title: 'registered selection sentinel unrelated',
      body: 'This unrelated project must not rotate a registered delivery.',
      tags: ['registered', 'selection', 'sentinel'],
    }, { now });
    const unrelated = await broker.query(registeredInput);
    assert.equal(unrelated.context?.queryHash, initial.context?.queryHash);
    assert.equal(unrelated.context?.deliveryId, initial.context?.deliveryId);

    const global = recordEntry(db, {
      workspace: 'global',
      kind: 'lesson',
      status: 'verified',
      title: 'registered selection sentinel global',
      body: 'Global ordinary memory is relevant to a registered project.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        portableReason: 'This broker behavior applies across repositories.',
      }),
      tags: ['registered', 'selection', 'sentinel'],
    }, { now: '2026-08-20T00:01:00.000Z' });
    const globalResult = await broker.query(registeredInput);
    assert.notEqual(globalResult.context?.queryHash, unrelated.context?.queryHash);
    assert.notEqual(globalResult.context?.deliveryId, unrelated.context?.deliveryId);
    assert.equal(globalResult.context?.items.some((item) => item.entryId === global.id), true);

    const unregisteredWorkspace = 'unregistered-selection-workspace';
    const unregistered = open(new OpenCodeTaskRunDriver(db, { now: () => now }), unregisteredWorkspace, {
      taskType: 'build', target: 'unregistered selection sentinel', expected: 'local-only replay',
    });
    const unregisteredInput = { workspace: unregisteredWorkspace, runId: unregistered.runId, limit: 10 };
    const localInitial = await broker.query(unregisteredInput);
    assert.deepEqual(localInitial.context?.items, []);
    recordEntry(db, {
      workspace: 'global',
      kind: 'lesson',
      status: 'verified',
      title: 'unregistered selection sentinel global',
      body: 'An unregistered workspace cannot retrieve this global entry.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        portableReason: 'This entry is globally portable but requires a registered project binding.',
      }),
      tags: ['unregistered', 'selection', 'sentinel'],
    }, { now: '2026-08-20T00:02:00.000Z' });
    const globalIgnored = await broker.query(unregisteredInput);
    assert.equal(globalIgnored.context?.queryHash, localInitial.context?.queryHash);
    assert.equal(globalIgnored.context?.deliveryId, localInitial.context?.deliveryId);

    const local = recordEntry(db, {
      workspace: unregisteredWorkspace,
      kind: 'lesson',
      status: 'verified',
      title: 'unregistered selection sentinel local',
      body: 'Requested-workspace ordinary memory must invalidate the local-only snapshot.',
      tags: ['unregistered', 'selection', 'sentinel'],
    }, { now: '2026-08-20T00:03:00.000Z' });
    const localResult = await broker.query(unregisteredInput);
    assert.notEqual(localResult.context?.queryHash, globalIgnored.context?.queryHash);
    assert.notEqual(localResult.context?.deliveryId, globalIgnored.context?.deliveryId);
    assert.equal(localResult.context?.items.some((item) => item.entryId === local.id), true);
  } finally {
    db.close();
  }
});

test('generic broker binds the exact project fingerprint through ranking and replay', async () => {
  const db = await database();
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-fingerprint-project-'));
  execFileSync('git', ['init', '-q', root]);
  const manifest = path.join(root, 'package.json');
  await writeFile(manifest, JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  try {
    const project = await resolveProjectWorkspace(db, root);
    assert.ok(project);
    const imported = importReplaySkill(db);
    const importedEntry = imported.entries[0];
    assert.ok(importedEntry);
    const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), project.workspace, {
      taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass',
    });
    const broker = new ContextBroker(db);
    const input = { workspace: project.workspace, runId: opened.runId, limit: 1 };

    await assert.rejects(
      broker.queryGated(input, (candidate) => {
        assert.equal(candidate.context?.items[0]?.entryId, importedEntry.id);
        writeFileSync(manifest, JSON.stringify({ dependencies: { react: '^19.0.0' } }));
        return { persist: true, value: 'stale-fingerprint' as const };
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context project state changed after ranking',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);

    writeFileSync(manifest, JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
    const svelte = await broker.query(input);
    assert.equal(svelte.context?.items[0]?.entryId, importedEntry.id);
    writeFileSync(manifest, JSON.stringify({ dependencies: { react: '^19.0.0' } }));
    const react = await broker.query(input);
    assert.notEqual(react.context?.queryHash, svelte.context?.queryHash);
    assert.notEqual(react.context?.deliveryId, svelte.context?.deliveryId);
    assert.deepEqual(react.context?.items, []);
  } finally {
    db.close();
  }
});

test('an empty generic delivery is invalidated when a matching external Skill is imported', async () => {
  const db = await database();
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-empty-skill-import-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  try {
    const project = await resolveProjectWorkspace(db, root);
    assert.ok(project);
    const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), project.workspace, {
      taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass',
    });
    const broker = new ContextBroker(db);
    const input = { workspace: project.workspace, runId: opened.runId, limit: 10 };
    const empty = await broker.query(input);
    assert.deepEqual(empty.context?.items, []);

    const imported = importReplaySkill(db);
    const refreshed = await broker.query(input);
    assert.notEqual(refreshed.context?.queryHash, empty.context?.queryHash);
    assert.notEqual(refreshed.context?.deliveryId, empty.context?.deliveryId);
    assert.equal(refreshed.context?.items.some((item) => imported.entries.some((entry) => entry.id === item.entryId)), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 2);
  } finally {
    db.close();
  }
});

test('an empty generic delivery is invalidated by matching portable ordinary ecosystem memory', async () => {
  const db = await database();
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-empty-ordinary-ecosystem-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  try {
    const project = await resolveProjectWorkspace(db, root);
    assert.ok(project);
    const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), project.workspace, {
      taskType: 'build', target: 'portable Svelte ecosystem memory', expected: 'tests pass',
    });
    const broker = new ContextBroker(db);
    const input = { workspace: project.workspace, runId: opened.runId, limit: 10 };
    const empty = await broker.query(input);
    assert.deepEqual(empty.context?.items, []);

    const added = recordEntry(db, {
      workspace: 'project:portable-svelte-source',
      kind: 'lesson',
      status: 'verified',
      title: 'portable Svelte ecosystem memory',
      body: 'Use the reusable Svelte ecosystem workflow.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        applicability: { frameworks: [{ name: 'Svelte', version: '>=5 <6' }] },
        signals: { packages: ['svelte'] },
      }),
      tags: ['svelte', 'portable'],
    }, { now: '2026-08-20T00:01:00.000Z' });
    const refreshed = await broker.query(input);
    assert.notEqual(refreshed.context?.queryHash, empty.context?.queryHash);
    assert.notEqual(refreshed.context?.deliveryId, empty.context?.deliveryId);
    assert.equal(refreshed.context?.items.some((item) => item.entryId === added.id), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 2);
  } finally {
    db.close();
  }
});

test('generic broker binds title, coverage, and valid same-sequence event state through persistence', async () => {
  const mutations: Array<{ name: string; apply: (db: Awaited<ReturnType<typeof database>>, runId: string) => void }> = [
    {
      name: 'title',
      apply: (db, runId) => {
        db.prepare('UPDATE ledger_runs SET title = ? WHERE run_id = ?').run('mutated title at the same sequence', runId);
      },
    },
    {
      name: 'coverage',
      apply: (db, runId) => {
        db.prepare('UPDATE ledger_runs SET coverage_json = ? WHERE run_id = ?').run(canonicalJson({
          run: 'best_effort', tool: 'best_effort', command: 'best_effort', file: 'best_effort', approval: 'best_effort',
        }), runId);
      },
    },
    {
      name: 'event',
      apply: (db, runId) => rewriteLastEventPayload(db, runId, { sameSequenceMutation: true }),
    },
  ];
  for (const mutation of mutations) {
    const db = await database();
    try {
      const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), `run-state-${mutation.name}`, {
        taskType: 'build', target: `run state ${mutation.name}`, expected: 'tests pass',
      });
      const sequence = db.prepare('SELECT last_sequence AS value FROM ledger_runs WHERE run_id = ?')
        .get<{ value: number }>(opened.runId)?.value;
      assert.ok(sequence !== undefined && sequence > 0);
      await assert.rejects(
        new ContextBroker(db).queryGated(
          { workspace: `run-state-${mutation.name}`, runId: opened.runId },
          () => {
            mutation.apply(db, opened.runId);
            assert.equal(db.prepare('SELECT last_sequence AS value FROM ledger_runs WHERE run_id = ?')
              .get<{ value: number }>(opened.runId)?.value, sequence);
            return { persist: true, value: 'stale' as const };
          },
        ),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === 'CONFLICT'
          && error.message === 'Context delivery conflicts with current run state',
        mutation.name,
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(opened.runId)?.count, 0);
    } finally {
      db.close();
    }
  }
});

test('generic broker rejects a missing ledger event and every terminal run before retrieval', async () => {
  const missingDb = await database();
  try {
    const opened = open(new OpenCodeTaskRunDriver(missingDb, { now: () => now }), 'missing-ledger-event', {
      taskType: 'build', target: 'missing ledger event', expected: 'explicit integrity failure',
    });
    const lastSequence = missingDb.prepare('SELECT last_sequence AS value FROM ledger_runs WHERE run_id = ?')
      .get<{ value: number }>(opened.runId)?.value;
    assert.ok(lastSequence !== undefined && lastSequence > 0);
    missingDb.prepare('DELETE FROM ledger_events WHERE run_id = ? AND sequence = ?').run(opened.runId, lastSequence);
    await assert.rejects(
      new ContextBroker(missingDb).query({ workspace: 'missing-ledger-event', runId: opened.runId }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context ledger sequence is invalid',
    );
  } finally {
    missingDb.close();
  }

  const mismatchedDb = await database();
  try {
    const opened = open(new OpenCodeTaskRunDriver(mismatchedDb, { now: () => now }), 'active-run-active-intake', { taskType: 'build' });
    assert.equal(opened.intakeStatus, 'needs_answer');
    new LedgerStore(mismatchedDb, { now: () => '2026-08-20T00:01:00.000Z' })
      .updateRunStatus(opened.runId, 'active');
    await assert.rejects(
      new ContextBroker(mismatchedDb).query({ workspace: 'active-run-active-intake', runId: opened.runId }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Context run status does not match its intake state',
    );
    assert.equal(mismatchedDb.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);
  } finally {
    mismatchedDb.close();
  }

  const terminalDb = await database();
  try {
    const opened = open(new OpenCodeTaskRunDriver(terminalDb, { now: () => now }), 'terminal-active-intake', { taskType: 'build' });
    assert.equal(opened.intakeStatus, 'needs_answer');
    new LedgerStore(terminalDb, { now: () => '2026-08-20T00:01:00.000Z' })
      .updateRunStatus(opened.runId, 'cancelled');
    await assert.rejects(
      new ContextBroker(terminalDb).query({ workspace: 'terminal-active-intake', runId: opened.runId }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Task run is terminal',
    );
    assert.equal(terminalDb.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);
  } finally {
    terminalDb.close();
  }
});

test('generic broker rejects noncanonical and hash-invalid ledger events before projection', async () => {
  const cases = [
    {
      name: 'noncanonical payload',
      message: 'Stored context ledger event is invalid',
      mutate: (db: Awaited<ReturnType<typeof database>>, eventId: string, payloadJson: string) => {
        db.prepare('UPDATE ledger_events SET payload_json = ? WHERE event_id = ?').run(` ${payloadJson}`, eventId);
      },
    },
    {
      name: 'invalid hash chain',
      message: 'Stored context ledger hash chain is invalid',
      mutate: (db: Awaited<ReturnType<typeof database>>, eventId: string) => {
        db.prepare('UPDATE ledger_events SET event_hash = ? WHERE event_id = ?').run('f'.repeat(64), eventId);
      },
    },
  ];
  for (const testCase of cases) {
    const db = await database();
    try {
      const workspace = `invalid-ledger-${testCase.name.replaceAll(' ', '-')}`;
      const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), workspace, {
        taskType: 'build', target: testCase.name, expected: 'explicit integrity failure',
      });
      const event = new LedgerStore(db).readEvents(opened.runId).at(-1);
      assert.ok(event);
      testCase.mutate(db, event.event_id, event.payload_json);
      await assert.rejects(
        new ContextBroker(db).query({ workspace, runId: opened.runId }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === 'INTEGRITY_ERROR'
          && error.message === testCase.message,
        testCase.name,
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(opened.runId)?.count, 0);
    } finally {
      db.close();
    }
  }
});

test('generic broker rejects non-current or injected intake ranking metadata before selection', async () => {
  const cases: Array<{
    name: string;
    mutate: (db: Awaited<ReturnType<typeof database>>, runId: string) => void;
  }> = [
    {
      name: 'obsolete policy',
      mutate: (db, runId) => {
        db.prepare('UPDATE run_intakes SET policy_version = ? WHERE run_id = ?').run('v999', runId);
      },
    },
    {
      name: 'unknown profile schema',
      mutate: (db, runId) => {
        db.prepare('UPDATE run_intakes SET profile_schema_version = ? WHERE run_id = ?').run(2, runId);
      },
    },
    {
      name: 'injected recommended tag',
      mutate: (db, runId) => {
        db.prepare('UPDATE run_intakes SET recommended_tags_json = ? WHERE run_id = ?')
          .run(canonicalJson(['bot:builder', 'skill:tdd', 'injected-ranking-sentinel']), runId);
      },
    },
    {
      name: 'reordered recommended tags',
      mutate: (db, runId) => {
        db.prepare('UPDATE run_intakes SET recommended_tags_json = ? WHERE run_id = ?')
          .run(canonicalJson(['skill:tdd', 'bot:builder']), runId);
      },
    },
  ];
  for (const testCase of cases) {
    const db = await database();
    try {
      const workspace = `intake-ranking-${testCase.name.replaceAll(' ', '-')}`;
      const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), workspace, {
        taskType: 'build', target: 'unrelated target', expected: 'focused tests pass',
      });
      assert.equal(opened.intakeStatus, 'ready');
      const candidate = recordEntry(db, {
        workspace,
        kind: 'lesson',
        status: 'verified',
        title: 'injected-ranking-sentinel',
        body: 'This entry must never be selected through corrupted intake ranking metadata.',
        tags: ['injected-ranking-sentinel'],
      }, { now: '2026-08-20T00:01:00.000Z' });
      assert.equal(searchEntries(db, { workspace, query: 'injected-ranking-sentinel', limit: 10 })
        .items.some((item) => item.id === candidate.id), true);

      testCase.mutate(db, opened.runId);
      let selectionExposed = false;
      await assert.rejects(
        new ContextBroker(db).queryGated(
          { workspace, runId: opened.runId, limit: 10 },
          () => {
            selectionExposed = true;
            return { persist: true, value: 'unexpected-selection' as const };
          },
        ),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === 'INTEGRITY_ERROR'
          && error.message === 'Stored context run intake state is invalid',
        testCase.name,
      );
      assert.equal(selectionExposed, false, testCase.name);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(opened.runId)?.count, 0, testCase.name);
    } finally {
      db.close();
    }
  }
});

test('fails closed when an exact replay sequence is altered or its delivery disappears inside the gate', async () => {
  const db = await database();
  try {
    const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), 'replay-header-integrity', {
      taskType: 'build', target: 'replay header sentinel', expected: 'tests pass',
    });
    recordEntry(db, {
      workspace: 'replay-header-integrity',
      kind: 'lesson',
      status: 'verified',
      title: 'replay header sentinel',
      body: 'Use the replay header sentinel workflow.',
      tags: ['replay', 'header', 'sentinel'],
    }, { now });
    const broker = new ContextBroker(db);
    const input = { workspace: 'replay-header-integrity', runId: opened.runId, limit: 1 };
    const delivered = await broker.query(input);
    assert.ok(delivered.context?.deliveryId);
    assert.ok(delivered.acceptedThrough > 0);

    db.prepare('UPDATE context_deliveries SET through_sequence = ? WHERE delivery_id = ?')
      .run(delivered.acceptedThrough - 1, delivered.context.deliveryId);
    await assert.rejects(
      broker.query(input),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context delivery sequence is invalid',
    );
    db.prepare('UPDATE context_deliveries SET through_sequence = ? WHERE delivery_id = ?')
      .run(delivered.acceptedThrough, delivered.context.deliveryId);

    await assert.rejects(
      broker.queryGated(input, (candidate) => {
        assert.equal(candidate.context?.deliveryId, delivered.context?.deliveryId);
        db.prepare('DELETE FROM context_deliveries WHERE delivery_id = ?').run(delivered.context!.deliveryId!);
        return { persist: true, value: 'proceed' as const };
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context delivery disappeared during replay',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);
  } finally {
    db.close();
  }
});

test('fails closed when a replayed delivery loses its referenced current entry', async () => {
  const db = await database();
  try {
    const service = new OpenCodeTaskRunDriver(db, { now: () => now });
    const opened = open(service, 'missing-replayed-entry', {
      taskType: 'build', target: 'missing replayed entry sentinel', expected: 'tests pass',
    });
    const selected = recordEntry(db, {
      workspace: 'missing-replayed-entry',
      kind: 'lesson',
      status: 'verified',
      title: 'missing replayed entry sentinel',
      body: 'Use the missing replayed entry sentinel workflow.',
      tags: ['missing', 'replayed', 'entry', 'sentinel'],
    }, { now });
    const broker = new ContextBroker(db);
    const input = { workspace: 'missing-replayed-entry', runId: opened.runId, limit: 1 };
    const delivered = await broker.query(input);
    assert.equal(delivered.context?.items[0]?.entryId, selected.id);

    await assert.rejects(
      broker.queryGated(input, (candidate) => {
        assert.equal(candidate.context?.deliveryId, delivered.context?.deliveryId);
        db.exec('PRAGMA foreign_keys = OFF');
        db.prepare('DELETE FROM entries WHERE id = ?').run(selected.id);
        return { persist: true, value: 'proceed' as const };
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context entry is missing',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 1);
  } finally {
    db.close();
  }
});

test('fails closed when prior delivery history exceeds the broker policy bound', async () => {
  const db = await database();
  try {
    const service = new OpenCodeTaskRunDriver(db, { now: () => now });
    const opened = open(service, 'history-bound', {
      taskType: 'build', target: 'src/history.ts', expected: 'tests pass',
    });
    const broker = new ContextBroker(db);
    const baseline = await broker.query({ workspace: 'history-bound', runId: opened.runId });
    assert.ok(baseline.context);
    const insert = db.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
        policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at,
        score_schema_version
      )
      SELECT ?, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
             policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at,
             score_schema_version
        FROM context_deliveries
       WHERE delivery_id = ?
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < 1_000; index += 1) {
        insert.run(`history-${String(index).padStart(4, '0')}`, baseline.context.deliveryId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    await assert.rejects(
      broker.query({ workspace: 'history-bound', runId: opened.runId }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Context delivery history exceeds the broker policy bound',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 1_001);
  } finally {
    db.close();
  }
});

test('replays a valid ecosystem delivery and fails closed on an obsolete stored policy', async () => {
  const db = await database();
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-loop-project-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const project = await resolveProjectWorkspace(db, root);
  assert.ok(project);
  const imported = importReplaySkill(db);
  const importedEntry = imported.entries[0];
  assert.ok(importedEntry);
  const service = new OpenCodeTaskRunDriver(db, { now: () => now });
  const opened = open(service, project.workspace, {
    taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass',
  });
  const broker = new ContextBroker(db);
  const input = { workspace: project.workspace, runId: opened.runId, limit: 1 };

  const first = await broker.query(input);
  assert.equal(first.context?.items[0]?.entryId, importedEntry.id);
  assert.equal(first.context?.items[0]?.origin, 'ecosystem');
  const replay = await broker.query(input);
  assert.equal(replay.context?.deliveryId, first.context?.deliveryId);
  assert.deepEqual(replay.context?.items, first.context?.items);

  db.prepare('UPDATE context_deliveries SET policy_version = ? WHERE delivery_id = ?')
    .run('obsolete-context-policy', first.context!.deliveryId);
  await assert.rejects(
    broker.query(input),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'INTEGRITY_ERROR'
      && error.message === 'Stored context delivery is invalid',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 1);
});

test('fails closed when a replayed global entry has same-revision scope corruption', async () => {
  const db = await database();
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-loop-global-corruption-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  try {
    const project = await resolveProjectWorkspace(db, root);
    assert.ok(project);
    const globalEntry = recordEntry(db, {
      workspace: 'global',
      kind: 'lesson',
      status: 'verified',
      title: 'global replay scope corruption sentinel',
      body: 'Use the global replay scope corruption sentinel workflow.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        portableReason: 'This workflow applies across repositories.',
      }),
      tags: ['global', 'replay', 'scope', 'corruption', 'sentinel'],
    }, { now });
    const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), project.workspace, {
      taskType: 'build', target: 'global replay scope corruption sentinel', expected: 'tests pass',
    });
    const broker = new ContextBroker(db);
    const input = { workspace: project.workspace, runId: opened.runId, limit: 1 };

    const delivered = await broker.query(input);
    assert.equal(delivered.context?.items[0]?.entryId, globalEntry.id);
    assert.equal(delivered.context?.items[0]?.origin, 'global');

    const corruptScope = buildStructuredScope({ visibility: 'project' });
    const corruptHash = canonicalEntryRevisionContentHash({ ...globalEntry, scope: corruptScope });
    db.exec('DROP TRIGGER entry_revisions_immutable_update');
    db.prepare('UPDATE entry_revisions SET scope_json = ?, content_hash = ? WHERE entry_id = ? AND revision = ?')
      .run(canonicalJson(corruptScope), corruptHash, globalEntry.id, globalEntry.revision);

    await assert.rejects(
      broker.query(input),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context entry scope is invalid',
    );
    await assert.rejects(
      broker.query({ ...input, changedPaths: ['src/different-query.ts'] }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context entry scope is invalid',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 1);
  } finally {
    db.close();
  }
});

test('fails closed on a corrupt delivered historical scope after the current revision advances', async () => {
  const db = await database();
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-loop-historical-corruption-'));
  execFileSync('git', ['init', '-q', root]);
  try {
    const project = await resolveProjectWorkspace(db, root);
    assert.ok(project);
    const first = recordEntry(db, {
      workspace: 'global',
      kind: 'lesson',
      title: 'historical global scope corruption sentinel',
      body: 'Use the historical global scope corruption sentinel workflow.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        portableReason: 'This workflow applies across repositories.',
      }),
      tags: ['historical', 'global', 'scope', 'corruption', 'sentinel'],
    }, { now });
    const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), project.workspace, {
      taskType: 'build', target: 'historical global scope corruption sentinel', expected: 'tests pass',
    });
    const broker = new ContextBroker(db);
    const input = { workspace: project.workspace, runId: opened.runId, limit: 1 };
    const delivered = await broker.query(input);
    assert.equal(delivered.context?.items[0]?.entryId, first.id);

    const second = updateCandidateEntry(db, {
      workspace: first.workspace,
      entryId: first.id,
      expectedRevision: first.revision,
      kind: first.kind,
      title: first.title,
      body: `${first.body} Current revision two.`,
      scope: first.scope,
      tags: first.tags,
      now: '2026-08-20T00:01:00.000Z',
    });
    assert.equal(second.revision, 2);
    const corruptScope = buildStructuredScope({ visibility: 'project' });
    const corruptHash = canonicalEntryRevisionContentHash({ ...first, scope: corruptScope });
    db.exec('DROP TRIGGER entry_revisions_immutable_update');
    db.prepare('UPDATE entry_revisions SET scope_json = ?, content_hash = ? WHERE entry_id = ? AND revision = ?')
      .run(canonicalJson(corruptScope), corruptHash, first.id, first.revision);

    await assert.rejects(
      broker.query(input),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context entry scope is invalid',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 1);
  } finally {
    db.close();
  }
});

test('does not replay a managed external reference after the skill is disabled', async () => {
  const db = await database();
  const imported = importReplaySkill(db);
  const importedEntry = imported.entries[0];
  assert.ok(importedEntry);
  const service = new OpenCodeTaskRunDriver(db, { now: () => now });
  const opened = open(service, imported.sourceWorkspace, {
    taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass',
  });
  const broker = new ContextBroker(db);
  const input = { workspace: imported.sourceWorkspace, runId: opened.runId, limit: 1 };

  assert.equal(searchEntries(db, { workspace: imported.sourceWorkspace, query: 'Svelte replay guidance', limit: 1 }).items[0]?.id, importedEntry.id);
  const first = await broker.query(input);
  assert.equal(first.context?.items[0]?.entryId, importedEntry.id);

  setExternalSkillState(db, imported.skillId, 'disabled', '2026-08-20T01:00:00.000Z');
  const replacement = await broker.query(input);
  assert.notEqual(replacement.context?.deliveryId, first.context?.deliveryId);
  assert.equal(replacement.context?.items.some((item) => item.entryId === importedEntry.id), false);

  const replay = await broker.query(input);
  assert.equal(replay.context?.deliveryId, replacement.context?.deliveryId);
  assert.deepEqual(replay.context?.items, replacement.context?.items);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 2);
});

test('unbound broker rejects an external Skill disable after asynchronous ranking', async () => {
  const db = await database();
  try {
    const imported = importReplaySkill(db);
    const importedEntry = imported.entries[0];
    assert.ok(importedEntry);
    await assert.rejects(
      new ContextBroker(db).queryGated(
        {
          workspace: imported.sourceWorkspace,
          task: 'Svelte replay guidance',
          taskProfile: { taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass', constraints: null },
          limit: 10,
        },
        (candidate) => {
          assert.equal(candidate.context?.items.some((item) => item.entryId === importedEntry.id), true);
          setExternalSkillState(db, imported.skillId, 'disabled', '2026-08-20T01:00:00.000Z');
          return { persist: true, value: 'stale-unbound-selection' as const };
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context selection state changed after ranking',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
  } finally {
    db.close();
  }
});

test('bound broker rejects a valid external Skill refresh after asynchronous ranking', async () => {
  const db = await database();
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-skill-refresh-race-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  try {
    const project = await resolveProjectWorkspace(db, root);
    assert.ok(project);
    const imported = importReplaySkill(db);
    const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), project.workspace, {
      taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass',
    });
    const current = listExternalSkills(db).find((skill) => skill.skillId === imported.skillId);
    assert.ok(current);
    const refreshedSnapshot = validateSkillSnapshot({
      candidate: replayCandidate,
      sourceCommit: 'e'.repeat(40),
      files: [{
        path: 'skills/svelte-code-writer/SKILL.md',
        content: '---\nname: Svelte Code Writer\ndescription: Refreshed Svelte replay context\n---\n# Svelte Replay Guidance\n\nUse refreshed current Svelte evidence.',
        primary: true,
      }],
    });
    await assert.rejects(
      new ContextBroker(db).queryGated(
        { workspace: project.workspace, runId: opened.runId, limit: 10 },
        (candidate) => {
          assert.equal(candidate.context?.items.some((item) => imported.entries.some((entry) => entry.id === item.entryId)), true);
          refreshExternalSkillSnapshot(
            db,
            imported.skillId,
            refreshedSnapshot,
            documentsFromSkillSnapshot(refreshedSnapshot),
            replayRequirement,
            externalSkillRefreshExpectation(current),
            '2026-08-20T01:00:00.000Z',
          );
          return { persist: true, value: 'stale-refreshed-context' as const };
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context delivery selection changed before return',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);
  } finally {
    db.close();
  }
});

test('fails closed when a replayed managed external reference has a corrupt source commit', async () => {
  const db = await database();
  const imported = importReplaySkill(db);
  const importedEntry = imported.entries[0];
  assert.ok(importedEntry);
  const service = new OpenCodeTaskRunDriver(db, { now: () => now });
  const opened = open(service, imported.sourceWorkspace, {
    taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass',
  });
  const broker = new ContextBroker(db);
  const input = { workspace: imported.sourceWorkspace, runId: opened.runId, limit: 1 };

  assert.equal(searchEntries(db, { workspace: imported.sourceWorkspace, query: 'Svelte replay guidance', limit: 1 }).items[0]?.id, importedEntry.id);
  const first = await broker.query(input);
  assert.equal(first.context?.items[0]?.entryId, importedEntry.id);
  assert.equal(db.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 1);

  db.prepare('UPDATE external_skills SET source_commit = ? WHERE skill_id = ?').run('e'.repeat(40), imported.skillId);
  await assert.rejects(
    broker.query(input),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'INTEGRITY_ERROR'
      && error.message === 'Managed external skill entry is invalid',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 1);
});

test('fails closed when a delivered managed external reference loses every mapping', async () => {
  const db = await database();
  try {
    const imported = importReplaySkill(db);
    const importedEntry = imported.entries[0];
    assert.ok(importedEntry);
    const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), imported.sourceWorkspace, {
      taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass',
    });
    const broker = new ContextBroker(db);
    const input = { workspace: imported.sourceWorkspace, runId: opened.runId, limit: 1 };
    const delivered = await broker.query(input);
    assert.equal(delivered.context?.items[0]?.entryId, importedEntry.id);

    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM external_skill_entries WHERE entry_id = ?').run(importedEntry.id);
    await assert.rejects(
      broker.query(input),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context external entry mapping is missing',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 1);
  } finally {
    db.close();
  }
});

test('delivery commit rejects concurrent external disable, stale, and corrupt source transitions', async () => {
  const transitions: Array<{
    name: string;
    apply: (db: Awaited<ReturnType<typeof database>>, skillId: string) => void;
    code: 'CONFLICT' | 'INTEGRITY_ERROR';
    message: string;
  }> = [
    {
      name: 'disabled',
      code: 'CONFLICT',
      message: 'Context delivery selection changed before return',
      apply: (db, skillId) => {
        db.prepare("UPDATE external_skills SET state = 'disabled', disabled_at = ? WHERE skill_id = ?").run('2026-08-20T00:00:01.000Z', skillId);
        db.prepare('UPDATE external_skill_entries SET active = 0 WHERE skill_id = ?').run(skillId);
      },
    },
    {
      name: 'stale',
      code: 'CONFLICT',
      message: 'Context delivery selection changed before return',
      apply: (db, skillId) => {
        db.prepare("UPDATE external_skills SET state = 'stale' WHERE skill_id = ?").run(skillId);
        db.prepare('UPDATE external_skill_entries SET active = 0 WHERE skill_id = ?').run(skillId);
      },
    },
    {
      name: 'corrupt-source-commit',
      code: 'INTEGRITY_ERROR',
      message: 'Managed external skill entry is invalid',
      apply: (db, skillId) => {
        db.prepare('UPDATE external_skills SET source_commit = ? WHERE skill_id = ?').run('e'.repeat(40), skillId);
      },
    },
  ];

  for (const transition of transitions) {
    const db = await database();
    try {
      const root = await mkdtemp(path.join(tmpdir(), `kiokuko-context-commit-${transition.name}-`));
      execFileSync('git', ['init', '-q', root]);
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
      const project = await resolveProjectWorkspace(db, root);
      assert.ok(project);
      const imported = importReplaySkill(db);
      const mappedIds = imported.entries.map((entry) => entry.id);
      const opened = open(new OpenCodeTaskRunDriver(db, { now: () => now }), project.workspace, {
        taskType: 'build', target: 'Svelte replay guidance', expected: 'tests pass',
      });
      const broker = new ContextBroker(db);

      await assert.rejects(
        broker.queryGated(
          { workspace: project.workspace, runId: opened.runId, limit: 10 },
          (candidate) => {
            assert.ok(candidate.context?.items.some((item) => mappedIds.includes(item.entryId)));
            return { persist: true, value: 'proceed' as const };
          },
          {
            enqueueWrite: (operation) => {
              transition.apply(db, imported.skillId);
              return operation();
            },
          },
        ),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === transition.code
          && error.message === transition.message,
        transition.name,
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    } finally {
      db.close();
    }
  }
});

test('unbound broker remains retrieval-only when local context is empty', async () => {
  const db = await database();
  const broker = new ContextBroker(db);
  const result = await broker.query({
    workspace: 'external-disabled',
    task: 'Implement external context',
    taskProfile: { taskType: 'build', target: 'src/external.ts', expected: 'tests pass', constraints: null },
    limit: 1,
  });

  assert.equal(result.context?.items.length, 0);
  assert.equal('externalSyncSummary' in result, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entries WHERE workspace = ?').get<{ count: number }>('external-disabled')?.count, 0);
});
