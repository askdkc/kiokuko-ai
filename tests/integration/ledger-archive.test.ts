import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { exportWorkspace } from '../../src/commands/export.js';
import {
  exportLedgerArchive,
  importLedgerArchive,
  MAX_ARCHIVE_LINE_BYTES,
  MAX_ARCHIVE_LINE_COUNT,
  MAX_ARCHIVE_TOTAL_BYTES,
} from '../../src/ledger/archive.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { finalizeRunIntakeLink, insertAkinatorAnswer, insertAkinatorSession, insertRunIntakeLink } from '../../src/akinator/store.js';
import { recordEntry } from '../../src/memory/entries.js';
import { canonicalContentHash, canonicalJson } from '../../src/serialization/validate.js';
import { recordContextFeedback } from '../../src/context/feedback.js';
import { readContextDelivery, recordContextDelivery, type ContextDeliveryInput } from '../../src/context/delivery.js';
import { inspectLedger } from '../../src/ledger/maintenance.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { recordNudgeDeliveryInTransaction } from '../../src/context/nudge-store.js';

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-ledger-archive-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, path.resolve(import.meta.dirname, '../../migrations'));
  return database;
}

const fixedNow = '2026-08-20T00:00:00.000Z';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const genericDeliveryPolicyVersion = 'context-ranking-v1+recommendations.v1';

function seedCompleteGraph(database: ReturnType<typeof openConnection>, workspace: string, entryId: string) {
  const sessionId = `${workspace}-session`;
  const runId = `${workspace}-run`;
  const eventId = `${workspace}-event`;
  const deliveryId = `${workspace}-delivery`;
  const profile = { taskType: 'build' as const, target: 'src', expected: 'pass', constraints: null };
  const taskProfileHash = canonicalContentHash(profile);
  insertAkinatorSession(database, {
    id: sessionId,
    workspace,
    task: 'Archive linked intake',
    profile,
    status: 'ready',
    questionCount: 1,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  });
  insertAkinatorAnswer(database, { workspace, sessionId, questionId: 'target', answer: 'src', createdAt: fixedNow });
  const store = new LedgerStore(database, { now: () => fixedNow });
  store.createRun({
    runId,
    workspace,
    protocolVersion: '1',
    client: { kind: 'generic', version: '1.0.0', sessionId },
    captureProfile: 'standard',
    coverage: { run: 'complete', tool: 'best_effort', command: 'declared', file: 'unavailable', approval: 'unavailable' },
    task: { title: 'Archive run', query: 'Archive graph', profileHints: { taskType: 'build', target: 'src', expected: 'pass', constraints: null } },
    metadata: { z: true, a: 'metadata' },
    startedAt: fixedNow,
  });
  store.appendBatch(runId, { events: [{ eventId, eventType: 'run.started', actor: 'agent', payload: { z: 1, a: 'payload' } }] });
  insertRunIntakeLink(database, {
    runId,
    sessionId,
    workspace,
    policyVersion: 'policy-v1',
    profileSchemaVersion: 1,
    profileSources: { taskType: 'inferred', target: 'user_answer' },
    initialProfileHash: null,
    recommendedTags: ['archive', 'ledger'],
    linkedAt: fixedNow,
    finalizedAt: null,
  });
  finalizeRunIntakeLink(database, { workspace, runId, profileHash: taskProfileHash, recommendedTags: ['archive', 'ledger'], finalizedAt: fixedNow });
  store.updateRunStatus(runId, 'active', fixedNow);
  database.prepare(`INSERT INTO intake_feedback (feedback_id, run_id, session_id, question_id, profile_field, verdict, comment, actor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-intake-feedback`, runId, sessionId, 'target', null, 'helpful', 'clear question', 'user', digest('intake-key'), fixedNow);
  database.prepare(`INSERT INTO ledger_evidence (evidence_id, run_id, event_id, kind, locator, digest_algorithm, digest, byte_size, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-evidence`, runId, eventId, 'test', 'tests/archive.test.ts', 'sha256', 'b'.repeat(64), 10, 'passed', fixedNow);
  database.prepare(`INSERT INTO context_deliveries (delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash, policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(deliveryId, runId, 1, sessionId, taskProfileHash, 'd'.repeat(64), genericDeliveryPolicyVersion, '{"fixture_marker":"must-not-export"}', 1000, 100, 0, fixedNow);
  database.prepare(`INSERT INTO context_delivery_entries (delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(deliveryId, entryId, 1, 1, '{"semantic":0.9,"trust":0.8}', '["matching_task"]');
  database.prepare(`INSERT INTO context_feedback (feedback_id, delivery_id, entry_id, run_id, verdict, comment, actor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-context-feedback`, deliveryId, entryId, runId, 'helpful', 'useful', 'user', digest('context-key'), fixedNow);
  database.prepare(`INSERT INTO run_feedback (feedback_id, run_id, outcome, recommendation_code, recommendation_verdict, rating, comment, actor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-run-feedback`, runId, 'completed', 'VERIFY_AFTER_MUTATION', 'accepted', 5, 'good run', 'user', digest('run-key'), fixedNow);
  database.prepare(`INSERT INTO ledger_memory_links (link_id, run_id, event_id, delivery_id, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-memory-link`, runId, eventId, deliveryId, entryId, fixedNow);
  database.prepare(`INSERT INTO ledger_purge_audit (purge_id, run_id, event_id, delivery_id, entry_id, target_type, target_id, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${workspace}-purge`, runId, eventId, deliveryId, entryId, 'run', runId, 'operator', 'privacy request', fixedNow);
  return { sessionId, runId, eventId, deliveryId };
}

function rebuildArchive(content: string, mutate: (lines: Array<Record<string, unknown>>) => void): string {
  const lines = content.trimEnd().split('\n').slice(1).map((line: string) => JSON.parse(line) as Record<string, unknown>);
  mutate(lines);
  const payload = `${lines.map((line) => canonicalJson(line)).join('\n')}\n`;
  return `${canonicalJson({ type: 'checksum', sha256: createHash('sha256').update(payload).digest('hex') })}\n${payload}`;
}

function seedSingleRun(database: ReturnType<typeof openConnection>, workspace = 'workspace:validation') {
  const store = new LedgerStore(database, { now: () => fixedNow });
  store.createRun({
    runId: `${workspace}-run`, workspace, protocolVersion: '1', client: { kind: 'generic' }, captureProfile: 'minimal',
    coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
    task: { title: 'Validation', query: 'Validate archive', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } }, startedAt: fixedNow,
  });
  store.appendBatch(`${workspace}-run`, { events: [{ eventId: `${workspace}-event`, eventType: 'run.started', actor: 'agent', payload: { ok: true } }] });
  return exportLedgerArchive(database, { workspace }).content;
}

test('exports an empty workspace as a deterministic ledger manifest without memory ledger leakage', async () => {
  const database = await setup();
  try {
    const before = exportWorkspace(database, { workspace: 'workspace:empty' }).content;
    const first = exportLedgerArchive(database, { workspace: 'workspace:empty' });
    const second = exportLedgerArchive(database, { workspace: 'workspace:empty' });
    const after = exportWorkspace(database, { workspace: 'workspace:empty' }).content;

    assert.equal(first.content, second.content);
    assert.equal(first.content, `${first.content}`);
    assert.equal(first.workspace, 'workspace:empty');
    assert.deepEqual(first.counts, {
      runs: 0,
      sessions: 0,
      answers: 0,
      runIntakes: 0,
      intakeFeedback: 0,
      events: 0,
      evidence: 0,
      deliveries: 0,
      deliveryEntries: 0,
      nudgeDeliveries: 0,
      contextFeedback: 0,
      runFeedback: 0,
      memoryLinks: 0,
      purgeAudit: 0,
    });
    assert.equal(before, after);
    assert.equal(before.includes('ledger_runs'), false);
    assert.equal(before.includes('ledger_events'), false);
    assert.equal(first.content.split('\n').length, 3);
    assert.match(first.content, /"type":"checksum"/);
    assert.match(first.content, /"archiveVersion":1/);
    assert.match(first.content, /"format":"kiokuko-ledger-jsonl"/);
  } finally {
    database.close();
  }
});


test('exports runs and events with stable allowlisted records and canonical stored JSON', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun({
      runId: 'run-archive-1',
      workspace: 'workspace:archive',
      protocolVersion: '1',
      client: { kind: 'generic', version: '1.0.0' },
      captureProfile: 'standard',
      coverage: { run: 'complete', tool: 'best_effort', command: 'declared', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Archive', query: 'Export', profileHints: { taskType: 'build', target: null, expected: 'pass', constraints: null } },
      metadata: { z: true, a: 'stable' },
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    store.appendBatch('run-archive-1', {
      events: [{ eventId: 'event-archive-1', eventType: 'run.started', actor: 'agent', payload: { z: 1, a: 'two' } }],
    });

    const archive = exportLedgerArchive(database, { workspace: 'workspace:archive' });
    const lines = archive.content.trimEnd().split('\n').map((line: string) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.slice(1).map((line: Record<string, unknown>) => line.type), ['manifest', 'run', 'event']);
    assert.deepEqual(archive.counts, { runs: 1, sessions: 0, answers: 0, runIntakes: 0, intakeFeedback: 0, events: 1, evidence: 0, deliveries: 0, deliveryEntries: 0, nudgeDeliveries: 0, contextFeedback: 0, runFeedback: 0, memoryLinks: 0, purgeAudit: 0 });
    assert.equal((lines[2]?.coverage_json as string), '{"approval":"unavailable","command":"declared","file":"unavailable","run":"complete","tool":"best_effort"}');
    assert.equal((lines[2]?.metadata_json as string), '{"a":"stable","z":true}');
    assert.equal((lines[3]?.payload_json as string), '{"a":"two","z":1}');
  } finally {
    database.close();
  }
});

test('rejects an empty workspace value before querying the database', async () => {
  const database = await setup();
  try {
    assert.throws(
      () => exportLedgerArchive(database, { workspace: '' }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  } finally {
    database.close();
  }
});

test('imports a ledger graph transactionally and re-imports identical rows as no-ops', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const store = new LedgerStore(source, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun({
      runId: 'run-import-1', workspace: 'workspace:import', protocolVersion: '1',
      client: { kind: 'generic' }, captureProfile: 'minimal',
      coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Import', query: 'Round trip', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    store.appendBatch('run-import-1', { events: [{ eventId: 'event-import-1', eventType: 'run.started', actor: 'agent', payload: { ok: true } }] });
    const archive = exportLedgerArchive(source, { workspace: 'workspace:import' });

    const imported = importLedgerArchive(target, { content: archive.content });
    assert.equal(imported.dryRun, false);
    assert.equal(imported.imported.runs, 1);
    assert.equal(imported.imported.events, 1);
    assert.equal(exportLedgerArchive(target, { workspace: 'workspace:import' }).content, archive.content);

    const duplicate = importLedgerArchive(target, { content: archive.content });
    assert.equal(duplicate.imported.runs, 0);
    assert.equal(duplicate.imported.events, 0);
    assert.equal(duplicate.duplicates.runs, 1);
    assert.equal(duplicate.duplicates.events, 1);
  } finally {
    source.close();
    target.close();
  }
});

function seedNudgeRateLimitArchive(database: ReturnType<typeof openConnection>, workspace: string): string {
  const runId = `${workspace}-run`;
  const store = new LedgerStore(database, { now: () => fixedNow });
  store.createRun({
    runId,
    workspace,
    protocolVersion: '1',
    client: { kind: 'generic' },
    captureProfile: 'minimal',
    coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
    task: { title: 'Nudge limits', query: 'Validate nudge limits', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
    startedAt: fixedNow,
  });
  store.appendBatch(runId, {
    events: Array.from({ length: 10 }, (_, index) => ({
      eventId: `${workspace}-event-${index + 1}`,
      eventType: index === 0 ? 'run.started' as const : 'step.completed' as const,
      actor: 'agent',
      payload: {},
    })),
  });
  for (const [index, throughSequence] of [1, 4].entries()) {
    recordNudgeDeliveryInTransaction(database, {
      runId,
      policyVersion: 'nudges.v1',
      code: 'UNRESOLVED_FAILURE',
      occurrenceId: `${workspace}-occurrence-${index + 1}`,
      checkpointId: `${workspace}-checkpoint-${index + 1}`,
      throughSequence,
      priority: 3,
      evidenceEventIds: [],
      referenceIds: [],
      deliveredAt: fixedNow,
    });
  }
  return exportLedgerArchive(database, { workspace }).content;
}

function nudgeArchiveRecord(workspace: string, index: number, throughSequence: number): Record<string, unknown> {
  return {
    type: 'nudge_delivery',
    id: `${workspace}-extra-id-${index}`,
    run_id: `${workspace}-run`,
    policy_version: 'nudges.v1',
    code: 'UNRESOLVED_FAILURE',
    occurrence_id: `${workspace}-extra-occurrence-${index}`,
    checkpoint_id: `${workspace}-extra-checkpoint-${index}`,
    through_sequence: throughSequence,
    priority: 3,
    evidence_event_ids_json: '[]',
    reference_ids_json: '[]',
    delivered_at: fixedNow,
  };
}

test('rejects archive histories over the run cap and within the code cooldown, but accepts valid distance', async () => {
  const source = await setup();
  const validTarget = await setup();
  const capTarget = await setup();
  const cooldownTarget = await setup();
  try {
    const valid = seedNudgeRateLimitArchive(source, 'workspace:nudge-limits');
    const imported = importLedgerArchive(validTarget, { content: valid });
    assert.equal(imported.imported.nudgeDeliveries, 2);

    const overCap = rebuildArchive(valid, (lines) => {
      const manifest = lines[0]!;
      const counts = manifest.counts as Record<string, number>;
      manifest.counts = { ...counts, nudgeDeliveries: 4 };
      lines.push(nudgeArchiveRecord('workspace:nudge-limits', 3, 7));
      lines.push(nudgeArchiveRecord('workspace:nudge-limits', 4, 10));
    });
    assert.throws(
      () => importLedgerArchive(capTarget, { content: overCap }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );

    const cooldown = rebuildArchive(valid, (lines) => {
      const second = lines.find((line) => line.type === 'nudge_delivery' && line.occurrence_id === 'workspace:nudge-limits-occurrence-2');
      assert.ok(second);
      second.through_sequence = 2;
    });
    assert.throws(
      () => importLedgerArchive(cooldownTarget, { content: cooldown }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
  } finally {
    source.close();
    validTarget.close();
    capTarget.close();
    cooldownTarget.close();
  }
});

test('archives the complete linked ledger graph without curated memory bodies or unrelated workspaces', async () => {
  const source = await setup();
  const target = await setup();
  const workspace = 'workspace:complete';
  const memoryBody = 'curated-body-must-not-be-archived';
  try {
    const sourceEntry = recordEntry(source, {
      workspace,
      kind: 'reference',
      title: 'curated-title-must-not-be-archived',
      body: memoryBody,
      summary: 'curated-summary-must-not-be-archived',
      tags: ['curated'],
    }, { idFactory: () => 'entry-complete-1', now: fixedNow });
    const memoryBefore = exportWorkspace(source, { workspace }).content;
    const graph = seedCompleteGraph(source, workspace, sourceEntry.id);
    recordNudgeDeliveryInTransaction(source, {
      runId: graph.runId,
      policyVersion: 'nudges.v1',
      code: 'UNRESOLVED_FAILURE',
      occurrenceId: 'archive-nudge-occurrence',
      checkpointId: 'archive-nudge-checkpoint',
      throughSequence: 1,
      priority: 3,
      evidenceEventIds: [graph.eventId],
      referenceIds: [],
      deliveredAt: fixedNow,
    });
    const unrelated = new LedgerStore(source, { now: () => fixedNow });
    unrelated.createRun({
      runId: 'unrelated-run', workspace: 'workspace:other', protocolVersion: '1', client: { kind: 'generic' }, captureProfile: 'minimal',
      coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Other', query: 'Other', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } }, startedAt: fixedNow,
    });
    const archive = exportLedgerArchive(source, { workspace });
    const memoryAfter = exportWorkspace(source, { workspace }).content;

    assert.equal(memoryBefore, memoryAfter);
    assert.equal(memoryAfter.includes('ledger_runs'), false);
    assert.equal(archive.content.includes(memoryBody), false);
    assert.equal(archive.content.includes('curated-title-must-not-be-archived'), false);
    assert.equal(archive.content.includes('must-not-export'), false);
    assert.equal(archive.content.includes('external_sync_summary_json'), false);
    assert.equal(archive.content.includes('unrelated-run'), false);
    assert.deepEqual(archive.counts, {
      runs: 1, sessions: 1, answers: 1, runIntakes: 1, intakeFeedback: 1, events: 1, evidence: 1,
      deliveries: 1, deliveryEntries: 1, nudgeDeliveries: 1, contextFeedback: 1, runFeedback: 1, memoryLinks: 1, purgeAudit: 1,
    });
    const lines = archive.content.trimEnd().split('\n').map((line: string) => JSON.parse(line) as Record<string, unknown>);
    const delivery = lines.find((line: Record<string, unknown>) => line.type === 'delivery');
    assert.ok(delivery);
    assert.equal('external_sync_summary_json' in delivery, false);
    assert.equal(delivery.score_schema_version, 1);
    const nudge = lines.find((line: Record<string, unknown>) => line.type === 'nudge_delivery');
    assert.ok(nudge);
    assert.equal(nudge.code, 'UNRESOLVED_FAILURE');
    assert.equal(nudge.evidence_event_ids_json, `["${graph.eventId}"]`);
    const deliveryEntry = lines.find((line: Record<string, unknown>) => line.type === 'delivery_entry');
    assert.ok(deliveryEntry);
    assert.deepEqual(Object.keys(deliveryEntry).sort(), ['delivery_id', 'entry_id', 'entry_revision', 'origin_scope', 'rank', 'score_components_json', 'selection_reason_json', 'type'].sort());
    assert.equal((deliveryEntry.score_components_json as string), '{"semantic":0.9,"trust":0.8}');
    assert.equal((deliveryEntry.selection_reason_json as string), '["matching_task"]');

    recordEntry(target, {
      workspace,
      kind: 'reference',
      title: 'curated-title-must-not-be-archived',
      body: memoryBody,
      summary: 'curated-summary-must-not-be-archived',
      tags: ['curated'],
    }, { idFactory: () => sourceEntry.id, now: fixedNow });
    importLedgerArchive(target, { content: archive.content });
    assert.equal(exportLedgerArchive(target, { workspace }).content, archive.content);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs WHERE workspace = ?').get<{ count: number }>(workspace)?.count, 1);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM akinator_answers').get<{ count: number }>()?.count, 1);
    assert.equal(target.prepare('SELECT external_sync_summary_json FROM context_deliveries WHERE delivery_id = ?').get<{ external_sync_summary_json: string }>(graph.deliveryId)?.external_sync_summary_json, '{}');
    assert.equal(target.prepare('SELECT score_schema_version FROM context_deliveries WHERE delivery_id = ?').get<{ score_schema_version: number }>(graph.deliveryId)?.score_schema_version, 1);
    assert.equal(graph.runId, `${workspace}-run`);
  } finally {
    source.close();
    target.close();
  }
});

test('round-trips ecosystem delivery feedback without rewriting the source workspace or revision', async () => {
  const source = await setup();
  const target = await setup();
  const invalidTarget = await setup();
  const runWorkspace = 'workspace:ecosystem-run';
  const sourceWorkspace = 'workspace:ecosystem-source';
  const entryId = 'entry-ecosystem-archive';
  try {
    const seedEntry = (database: ReturnType<typeof openConnection>) => recordEntry(database, {
      workspace: sourceWorkspace,
      kind: 'lesson',
      title: 'Portable ecosystem archive lesson',
      body: 'Use the portable archive contract.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        applicability: { languages: ['TypeScript'] },
      }),
    }, { idFactory: () => entryId, now: fixedNow });
    seedEntry(source);
    seedEntry(target);
    seedEntry(invalidTarget);
    const store = new LedgerStore(source, { now: () => fixedNow });
    const sessionId = 'session-ecosystem-archive';
    const profile = { taskType: 'build' as const, target: 'context', expected: 'round trip', constraints: null };
    const taskProfileHash = canonicalContentHash(profile);
    insertAkinatorSession(source, {
      id: sessionId,
      workspace: runWorkspace,
      task: 'Ecosystem archive',
      profile,
      status: 'ready',
      questionCount: 0,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    store.createRun({
      runId: 'run-ecosystem-archive', workspace: runWorkspace, protocolVersion: '1',
      client: { kind: 'generic', sessionId }, captureProfile: 'minimal',
      coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Ecosystem archive', query: 'Round trip ecosystem context', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      startedAt: fixedNow,
    });
    insertRunIntakeLink(source, {
      runId: 'run-ecosystem-archive',
      sessionId,
      workspace: runWorkspace,
      policyVersion: 'v2',
      profileSchemaVersion: 1,
      profileSources: { taskType: 'inferred', target: 'inferred', expected: 'inferred', constraints: 'inferred' },
      initialProfileHash: null,
      recommendedTags: ['bot:builder', 'skill:tdd'],
      linkedAt: fixedNow,
      finalizedAt: null,
    });
    finalizeRunIntakeLink(source, {
      workspace: runWorkspace,
      runId: 'run-ecosystem-archive',
      profileHash: taskProfileHash,
      recommendedTags: ['bot:builder', 'skill:tdd'],
      finalizedAt: fixedNow,
    });
    store.updateRunStatus('run-ecosystem-archive', 'active', fixedNow);
    const deliveryBody = {
      workspace: runWorkspace,
      runId: 'run-ecosystem-archive',
      throughSequence: 0,
      intakeSessionId: sessionId,
      taskProfileHash,
      queryHash: 'b'.repeat(64),
       policyVersion: 'context-ranking-v6',
      scoreSchemaVersion: 2,
      charBudget: 1000,
      charCount: 100,
      truncated: false,
      createdAt: fixedNow,
      items: [{
        entryId,
        entryRevision: 1,
        rank: 1,
        scoreComponents: {
          status: 40,
          trust: 0,
          confidence: 14,
          retrieval: 0,
          taskAffinity: 0,
          recommendedTags: 0,
          scopeAffinity: 0,
          applicability: 0,
          pathOverlap: 0,
          errorSignature: 0,
          exactSignal: 0,
          feedback: 0,
          recency: 0,
          contradiction: 0,
        },
        selectionReasons: ['ecosystem_origin', 'candidate'],
        origin: 'ecosystem',
      }],
    } satisfies Omit<ContextDeliveryInput, 'deliveryId'>;
    const deliveryId = `context-${canonicalContentHash({ kind: 'scoped-context-delivery-v1', ...deliveryBody })}`;
    recordContextDelivery(source, { ...deliveryBody, deliveryId });
    assert.throws(
      () => recordContextFeedback(source, {
        workspace: runWorkspace,
        feedbackId: 'feedback-ecosystem-wrong-revision',
        deliveryId,
        entryId,
        entryRevision: 2,
        runId: 'run-ecosystem-archive',
        verdict: 'helpful',
        actor: 'user',
        idempotencyKey: 'ecosystem-wrong-revision-key',
        createdAt: fixedNow,
      }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    recordContextFeedback(source, {
      workspace: runWorkspace,
      feedbackId: 'feedback-ecosystem-archive',
      deliveryId,
      entryId,
      entryRevision: 1,
      runId: 'run-ecosystem-archive',
      verdict: 'helpful',
      actor: 'user',
      idempotencyKey: 'ecosystem-archive-feedback-key',
      createdAt: fixedNow,
    });

    const archive = exportLedgerArchive(source, { workspace: runWorkspace });
    const imported = importLedgerArchive(target, { content: archive.content });
    assert.equal(imported.imported.deliveryEntries, 1);
    assert.equal(imported.imported.contextFeedback, 1);
    assert.equal(target.prepare('SELECT workspace FROM entries WHERE id = ?').get<{ workspace: string }>(entryId)?.workspace, sourceWorkspace);
    assert.equal(target.prepare('SELECT entry_revision FROM context_delivery_entries WHERE entry_id = ?').get<{ entry_revision: number }>(entryId)?.entry_revision, 1);
    assert.equal(target.prepare('SELECT score_schema_version FROM context_deliveries WHERE delivery_id = ?').get<{ score_schema_version: number }>(deliveryId)?.score_schema_version, 2);
    assert.deepEqual(
      readContextDelivery(target, { workspace: runWorkspace, deliveryId }).items.map((item) => ({
        entryId: item.entryId,
        entryRevision: item.entryRevision,
        origin: item.origin,
      })),
      [{ entryId, entryRevision: 1, origin: 'ecosystem' }],
    );
    target.prepare('UPDATE context_deliveries SET task_profile_hash = ? WHERE delivery_id = ?')
      .run('f'.repeat(64), deliveryId);
    assert.throws(
      () => readContextDelivery(target, { workspace: runWorkspace, deliveryId }),
      (error: unknown) => (error as { code?: unknown }).code === 'INTEGRITY_ERROR',
    );
    target.prepare('UPDATE context_deliveries SET task_profile_hash = ? WHERE delivery_id = ?')
      .run(taskProfileHash, deliveryId);
    assert.equal(inspectLedger(target, { workspace: runWorkspace }).findingCount, 0);
    assert.equal(exportLedgerArchive(target, { workspace: runWorkspace }).content, archive.content);
    const replay = importLedgerArchive(target, { content: archive.content });
    assert.equal(replay.duplicates.deliveryEntries, 1);
    assert.equal(replay.duplicates.contextFeedback, 1);

    const wrongOrigin = rebuildArchive(archive.content, (lines) => {
      lines.find((line) => line.type === 'delivery_entry')!.origin_scope = 'project';
    });
    assert.throws(
      () => importLedgerArchive(invalidTarget, { content: wrongOrigin }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    assert.equal(invalidTarget.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);

    const nullOrigin = rebuildArchive(archive.content, (lines) => {
      lines.find((line) => line.type === 'delivery_entry')!.origin_scope = null;
    });
    assert.throws(
      () => importLedgerArchive(invalidTarget, { content: nullOrigin }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
    assert.equal(invalidTarget.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);

    const missingRevision = rebuildArchive(archive.content, (lines) => {
      lines.find((line) => line.type === 'delivery_entry')!.entry_revision = 2;
    });
    assert.throws(
      () => importLedgerArchive(invalidTarget, { content: missingRevision }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
    );
    assert.equal(invalidTarget.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);

    const assertRejectedTuple = async (input: {
      entryWorkspace: string;
      origin: string;
      revisionWorkspace?: string;
      expectedCode: 'CONFLICT' | 'VALIDATION_ERROR';
    }): Promise<void> => {
      const tupleTarget = await setup();
      try {
        recordEntry(tupleTarget, {
          workspace: input.revisionWorkspace ?? input.entryWorkspace,
          kind: 'lesson',
          title: 'Portable ecosystem archive lesson',
          body: 'Use the portable archive contract.',
          scope: buildStructuredScope({
            visibility: 'project',
            retrievalScope: 'ecosystem',
            applicability: { languages: ['TypeScript'] },
          }),
        }, { idFactory: () => entryId, now: fixedNow });
        if (input.revisionWorkspace !== undefined) {
          tupleTarget.exec('PRAGMA foreign_keys = OFF');
          tupleTarget.prepare('UPDATE entries SET workspace = ? WHERE id = ?').run(input.entryWorkspace, entryId);
          tupleTarget.exec('PRAGMA foreign_keys = ON');
        }
        const invalidArchive = rebuildArchive(archive.content, (lines) => {
          lines.find((line) => line.type === 'delivery_entry')!.origin_scope = input.origin;
        });
        assert.throws(
          () => importLedgerArchive(tupleTarget, { content: invalidArchive }),
          (error: unknown) => (error as { code?: string }).code === input.expectedCode,
        );
        assert.equal(tupleTarget.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
      } finally {
        tupleTarget.close();
      }
    };

    await assertRejectedTuple({ entryWorkspace: runWorkspace, origin: 'ecosystem', expectedCode: 'CONFLICT' });
    await assertRejectedTuple({ entryWorkspace: 'global', origin: 'ecosystem', expectedCode: 'CONFLICT' });
    await assertRejectedTuple({ entryWorkspace: sourceWorkspace, origin: 'global', expectedCode: 'CONFLICT' });
    await assertRejectedTuple({
      entryWorkspace: sourceWorkspace,
      revisionWorkspace: 'workspace:revision-mismatch',
      origin: 'ecosystem',
      expectedCode: 'CONFLICT',
    });
    await assertRejectedTuple({ entryWorkspace: sourceWorkspace, origin: 'unknown', expectedCode: 'VALIDATION_ERROR' });
  } finally {
    source.close();
    target.close();
    invalidTarget.close();
  }
});

test('rejects checksum/count/schema/version corruption with fixed typed errors and no mutation', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const archive = seedSingleRun(source);
    const corrupted = archive.replace('true', 'false');
    assert.throws(() => importLedgerArchive(target, { content: corrupted }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);

    const countMismatch = rebuildArchive(archive, (lines) => { const manifest = lines[0]!; const counts = manifest.counts as Record<string, number>; manifest.counts = { ...counts, events: Number(counts.events) + 1 }; });
    assert.throws(() => importLedgerArchive(target, { content: countMismatch }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    const unknownField = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'run')!.unknown = 'sentinel'; });
    assert.throws(() => importLedgerArchive(target, { content: unknownField }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const unknownType = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'event')!.type = 'unknown_record'; });
    assert.throws(() => importLedgerArchive(target, { content: unknownType }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const duplicateManifest = rebuildArchive(archive, (lines) => { lines.push({ ...lines[0]! }); });
    assert.throws(() => importLedgerArchive(target, { content: duplicateManifest }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    const unsupported = rebuildArchive(archive, (lines) => { lines[0]!.archiveVersion = 2; });
    assert.throws(() => importLedgerArchive(target, { content: unsupported }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const nonCanonicalNestedJson = rebuildArchive(archive, (lines) => {
      lines.find((line) => line.type === 'run')!.metadata_json = '{ "nested":true}';
    });
    assert.throws(
      () => importLedgerArchive(target, { content: nonCanonicalNestedJson }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
  } finally {
    source.close();
    target.close();
  }
});

test('validates hash chain, run cursor, delivery cursor, dry-run, missing memory, and override before writing', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const archive = seedSingleRun(source);
    const badHash = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'event')!.event_hash = 'f'.repeat(64); });
    assert.throws(() => importLedgerArchive(target, { content: badHash }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    const badSequence = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'event')!.sequence = 2; });
    assert.throws(() => importLedgerArchive(target, { content: badSequence }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    const badCursor = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'run')!.last_sequence = 2; });
    assert.throws(() => importLedgerArchive(target, { content: badCursor }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);

    const dryRun = importLedgerArchive(target, { content: archive, dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.imported.runs, 1);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
    assert.throws(() => importLedgerArchive(target, { content: archive, workspace: 'workspace:other' }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');

    const completeSource = await setup();
    try {
      const entry = recordEntry(completeSource, { workspace: 'workspace:missing', kind: 'fact', title: 'ref', body: 'ref' }, { idFactory: () => 'missing-entry', now: fixedNow });
      const completeGraph = seedCompleteGraph(completeSource, 'workspace:missing', entry.id);
      recordNudgeDeliveryInTransaction(completeSource, {
        runId: completeGraph.runId,
        policyVersion: 'nudges.v1',
        code: 'UNRESOLVED_FAILURE',
        occurrenceId: 'missing-nudge-occurrence',
        checkpointId: 'missing-nudge-checkpoint',
        throughSequence: 1,
        priority: 3,
        evidenceEventIds: [completeGraph.eventId],
        referenceIds: [],
        deliveredAt: fixedNow,
      });
      const completeArchive = exportLedgerArchive(completeSource, { workspace: 'workspace:missing' });
      const badDeliveryCursor = rebuildArchive(completeArchive.content, (lines) => { lines.find((line) => line.type === 'delivery')!.through_sequence = 2; });
      assert.throws(() => importLedgerArchive(target, { content: badDeliveryCursor }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
      const badScoreSchema = rebuildArchive(completeArchive.content, (lines) => { lines.find((line) => line.type === 'delivery')!.score_schema_version = 3; });
      assert.throws(() => importLedgerArchive(target, { content: badScoreSchema }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
      const badNudgePolicy = rebuildArchive(completeArchive.content, (lines) => { lines.find((line) => line.type === 'nudge_delivery')!.policy_version = 'nudges.v2'; });
      assert.throws(() => importLedgerArchive(target, { content: badNudgePolicy }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
      const badNudgePriority = rebuildArchive(completeArchive.content, (lines) => { lines.find((line) => line.type === 'nudge_delivery')!.priority = 999; });
      assert.throws(() => importLedgerArchive(target, { content: badNudgePriority }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
      const badNudgeEvidence = rebuildArchive(completeArchive.content, (lines) => { lines.find((line) => line.type === 'nudge_delivery')!.evidence_event_ids_json = '["missing-event"]'; });
      assert.throws(() => importLedgerArchive(target, { content: badNudgeEvidence }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
      assert.throws(() => importLedgerArchive(target, { content: completeArchive.content }), (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
      assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
    } finally {
      completeSource.close();
    }
  } finally {
    source.close();
    target.close();
  }
});

test('rejects persisted hash-chain and secret residue on export without echoing sentinel values', async () => {
  const corrupted = await setup();
  const secretDatabase = await setup();
  const missingRevisionDatabase = await setup();
  const nonCanonicalDatabase = await setup();
  try {
    seedSingleRun(corrupted);
    corrupted.prepare('UPDATE ledger_events SET event_hash = ?').run('f'.repeat(64));
    assert.throws(() => exportLedgerArchive(corrupted, { workspace: 'workspace:validation' }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');

    seedSingleRun(secretDatabase);
    const sentinel = 'password=secret-sentinel-value-12345';
    secretDatabase.prepare('UPDATE ledger_runs SET metadata_json = ?').run(JSON.stringify({ note: sentinel }));
    assert.throws(() => exportLedgerArchive(secretDatabase, { workspace: 'workspace:validation' }), (error: unknown) => {
      const typed = error as { code?: string; message?: string; details?: unknown };
      assert.equal(typed.code, 'SECURITY_REJECTION');
      assert.equal(String(typed.message).includes(sentinel), false);
      assert.equal(JSON.stringify(typed.details).includes(sentinel), false);
      return true;
    });

    const missingEntry = recordEntry(missingRevisionDatabase, {
      workspace: 'workspace:missing-export-revision',
      kind: 'lesson',
      title: 'Missing export revision',
      body: 'A delivery must never disappear from an archive when its exact revision is missing.',
    }, { idFactory: () => 'entry-missing-export-revision', now: fixedNow });
    seedCompleteGraph(missingRevisionDatabase, 'workspace:missing-export-revision', missingEntry.id);
    missingRevisionDatabase.exec('PRAGMA foreign_keys = OFF');
    missingRevisionDatabase.prepare('DELETE FROM entry_revisions WHERE entry_id = ? AND revision = 1').run(missingEntry.id);
    missingRevisionDatabase.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () => exportLedgerArchive(missingRevisionDatabase, { workspace: 'workspace:missing-export-revision' }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
    );

    const malformed = await setup();
    try {
      seedSingleRun(malformed);
      const rawJson = 'not-json-sentinel';
      malformed.prepare('UPDATE ledger_runs SET metadata_json = ?').run(rawJson);
      assert.throws(() => exportLedgerArchive(malformed, { workspace: 'workspace:validation' }), (error: unknown) => {
        const typed = error as { code?: string; message?: string };
        assert.equal(typed.code, 'INTEGRITY_ERROR');
        assert.equal(String(typed.message).includes(rawJson), false);
        return true;
      });
    } finally {
      malformed.close();
    }

    seedSingleRun(nonCanonicalDatabase, 'workspace:noncanonical-export');
    nonCanonicalDatabase.prepare('UPDATE ledger_runs SET metadata_json = ? WHERE workspace = ?')
      .run('{ "nested":true}', 'workspace:noncanonical-export');
    assert.throws(
      () => exportLedgerArchive(nonCanonicalDatabase, { workspace: 'workspace:noncanonical-export' }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
  } finally {
    corrupted.close();
    secretDatabase.close();
    missingRevisionDatabase.close();
    nonCanonicalDatabase.close();
  }
});

test('rejects same-identity different content atomically and enforces archive bounds', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const archive = seedSingleRun(source);
    importLedgerArchive(target, { content: archive });
    const changed = rebuildArchive(archive, (lines) => { lines.find((line) => line.type === 'run')!.title = 'different-content'; });
    assert.throws(() => importLedgerArchive(target, { content: changed }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    const dryConflict = importLedgerArchive(target, { content: changed, dryRun: true });
    assert.equal(dryConflict.dryRun, true);
    assert.equal(dryConflict.conflicts, 1);
    assert.equal(dryConflict.imported.runs, 0);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 1);
    assert.equal(target.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys, 1);

    const tooManyLines = `${Array.from({ length: MAX_ARCHIVE_LINE_COUNT + 1 }, () => '{}').join('\\n')}\\n`;
    assert.throws(() => importLedgerArchive(target, { content: tooManyLines }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const tooLongLine = `${'x'.repeat(MAX_ARCHIVE_LINE_BYTES)}\\n`;
    assert.throws(() => importLedgerArchive(target, { content: tooLongLine }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    const tooManyBytes = `${'x'.repeat(MAX_ARCHIVE_TOTAL_BYTES)}\\n`;
    assert.throws(() => importLedgerArchive(target, { content: tooManyBytes }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
  } finally {
    source.close();
    target.close();
  }
});

test('does not let trigger text spoof an archive identity conflict', async () => {
  const source = await setup();
  const target = await setup();
  try {
    const archive = seedSingleRun(source, 'workspace:trigger-spoof');
    target.exec(`
      CREATE TRIGGER archive_conflict_spoof
      BEFORE INSERT ON ledger_runs
      BEGIN
        SELECT RAISE(ABORT, 'UNIQUE constraint failed: ledger_runs.run_id');
      END;
    `);

    assert.throws(
      () => importLedgerArchive(target, { content: archive }),
      (error: unknown) => {
        const sqlite = error as { code?: unknown; errcode?: unknown };
        assert.equal(sqlite.code, 'ERR_SQLITE_ERROR');
        assert.equal(sqlite.errcode, 1811);
        assert.notEqual(sqlite.code, 'CONFLICT');
        return true;
      },
    );
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
  } finally {
    source.close();
    target.close();
  }
});

test('archive database boundaries preserve programmer faults and classify only SQLite corruption', async () => {
  const source = await setup();
  try {
    const archive = seedSingleRun(source, 'workspace:database-failclose');
    const failingDatabase = (failure: Error): SqliteDatabase => ({
      filePath: ':memory:',
      exec: () => undefined,
      prepare: () => { throw failure; },
      close: () => undefined,
    });
    const programmerError = new TypeError('archive programmer constraint sentinel');
    assert.throws(
      () => importLedgerArchive(failingDatabase(programmerError), { content: archive }),
      (error: unknown) => error === programmerError,
    );

    for (const errcode of [11, 26]) {
      const corruption = Object.assign(new Error('database-secret-corruption-sentinel'), { code: 'ERR_SQLITE_ERROR', errcode });
      assert.throws(
        () => importLedgerArchive(failingDatabase(corruption), { content: archive }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'INTEGRITY_ERROR');
          assert.doesNotMatch((error as Error).message, /database-secret-corruption-sentinel/u);
          return true;
        },
      );
    }
  } finally {
    source.close();
  }
});
