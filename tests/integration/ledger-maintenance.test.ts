import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import {
  inspectLedger,
  purgeLedgerTarget,
  LEDGER_CHECK_NAMES,
  type LedgerIntegrityReport,
} from '../../src/ledger/maintenance.js';
import { recordNudgeDeliveryInTransaction } from '../../src/context/nudge-store.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-ledger-maintenance-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

function emptyCounts(report: LedgerIntegrityReport) {
  return report.counts;
}

function runInput(runId = 'run-1', workspace = 'workspace-a') {
  return {
    runId,
    workspace,
    protocolVersion: '1' as const,
    client: { kind: 'generic', version: '1.0.0' },
    captureProfile: 'standard' as const,
    coverage: { run: 'complete' as const, tool: 'best_effort' as const, command: 'declared' as const, file: 'unavailable' as const, approval: 'unavailable' as const },
    task: { title: 'Task', query: 'Run tests', profileHints: { taskType: 'build' as const, target: null, expected: 'pass', constraints: null } },
    metadata: { safe: true },
    startedAt: '2026-08-20T00:00:00.000Z',
  };
}

test('reports a healthy run and event chain with deterministic selected counts', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun(runInput());
    store.appendBatch('run-1', {
      events: [{ eventId: 'event-1', sourceEventId: 'source-1', sourceSequence: 4, eventType: 'run.started', actor: 'agent', payload: {} }],
    });

    const report = inspectLedger(database, { workspace: 'workspace-a' });

    assert.equal(report.ok, true);
    assert.equal(report.workspace, 'workspace-a');
    assert.deepEqual(report.counts, {
      runs: 1,
      events: 1,
      evidence: 0,
      deliveries: 0,
      deliveryEntries: 0,
      nudgeDeliveries: 0,
      intakeFeedback: 0,
      contextFeedback: 0,
      runFeedback: 0,
      memoryLinks: 0,
      tombstones: 0,
    });
    assert.equal(report.checks.runs.ok, true);
    assert.equal(report.checks.runs.count, 1);
    assert.equal(report.checks.eventIdentity.ok, true);
    assert.equal(report.checks.eventHashChain.ok, true);
    assert.equal(report.checks.eventHashChain.count, 1);
    assert.equal(report.checks.runCursors.ok, true);
    assert.equal(report.findingCount, 0);
  } finally {
    database.close();
  }
});

test('accepts context delivery selection reasons as a JSON array', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const { recordEntry } = await import('../../src/memory/entries.js');
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun(runInput());
    store.appendBatch('run-1', { events: [{ eventId: 'event-selection-reasons', eventType: 'run.started', actor: 'agent', payload: {} }] });
    const entry = recordEntry(database, {
      workspace: 'workspace-a',
      kind: 'lesson',
      title: 'Selection reasons',
      body: 'Selection reasons are stored as an ordered array.',
      createdBy: 'test',
      actor: 'test',
    }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => 'entry-selection-reasons' });
    database.prepare(`
      INSERT INTO context_deliveries (delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash, policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at)
      VALUES ('delivery-selection-reasons', 'run-1', 1, NULL, ?, ?, 'v1', 'not-json-legacy-artifact', 100, 10, 0, ?)
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO context_delivery_entries (delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json)
      VALUES ('delivery-selection-reasons', ?, 1, 1, '{}', '["project_origin","candidate"]')
    `).run(entry.id);

    const report = inspectLedger(database, { workspace: 'workspace-a' });

    assert.equal(report.ok, true);
    assert.equal(report.findingCount, 0);
  } finally {
    database.close();
  }
});

test('reports an unknown delivery origin as corruption instead of treating it as project scope', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const { recordEntry } = await import('../../src/memory/entries.js');
    new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' }).createRun(runInput());
    const entry = recordEntry(database, {
      workspace: 'workspace-a', kind: 'lesson', title: 'Origin corruption', body: 'Detect unknown origin values.',
    }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => 'entry-origin-corruption' });
    database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash,
        query_hash, policy_version, external_sync_summary_json, char_budget,
        char_count, truncated, created_at
      ) VALUES ('delivery-origin-corruption', 'run-1', 0, NULL, ?, ?, 'v3', '{}', 100, 0, 0, ?)
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json,
        selection_reason_json, origin_scope
      ) VALUES ('delivery-origin-corruption', ?, 1, 1, '{}', '[]', 'project')
    `).run(entry.id);
    database.exec('PRAGMA ignore_check_constraints = ON');
    database.prepare('UPDATE context_delivery_entries SET origin_scope = ? WHERE delivery_id = ?').run('unknown-origin', 'delivery-origin-corruption');
    database.exec('PRAGMA ignore_check_constraints = OFF');

    const report = inspectLedger(database, { workspace: 'workspace-a' });
    assert.ok(report.findings.some((finding) => finding.kind === 'invalid_enum'));
    assert.ok(report.findings.some((finding) => finding.kind === 'orphan_delivery_entry_reference'));
  } finally {
    database.close();
  }
});

test('reports tampered sequence, hash, malformed JSON, and secret residue without exposing content', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun(runInput());
    store.appendBatch('run-1', {
      events: [
        { eventId: 'event-1', eventType: 'run.started', actor: 'agent', payload: {} },
        { eventId: 'event-2', eventType: 'run.closed', actor: 'agent', payload: {} },
      ],
    });
    const secret = 'password = leaked-maintenance-secret-12345';
    database.prepare('UPDATE ledger_runs SET last_sequence = ? WHERE run_id = ?').run(99, 'run-1');
    database.prepare('UPDATE ledger_events SET event_hash = ?, payload_json = ? WHERE event_id = ?').run(
      'not-a-hash',
      JSON.stringify({ note: secret }),
      'event-2',
    );

    const report = inspectLedger(database, { workspace: 'workspace-a' });

    assert.equal(report.ok, false);
    assert.equal(report.checks.runCursors.ok, false);
    assert.equal(report.checks.eventHashChain.ok, false);
    assert.equal(report.checks.storedValues.ok, false);
    assert.equal(report.checks.secretResidue.ok, false);
    assert.ok(report.findingCount >= 3);
    assert.equal(report.findings.some((finding: LedgerIntegrityReport['findings'][number]) => JSON.stringify(finding).includes(secret)), false);
    assert.equal(report.findings.some((finding: LedgerIntegrityReport['findings'][number]) => finding.category === 'ledger_events' && finding.kind === 'hash_mismatch'), true);
  } finally {
    database.close();
  }
});

test('reports invalid child enum, timestamp, rating, and context hash values without exposing rows', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const { recordEntry } = await import('../../src/memory/entries.js');
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun(runInput());
    store.appendBatch('run-1', { events: [{ eventId: 'event-child-1', eventType: 'run.started', actor: 'agent', payload: {} }] });
    const entry = recordEntry(database, { workspace: 'workspace-a', kind: 'lesson', title: 'Child title', body: 'Child body', createdBy: 'test', actor: 'test' }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => 'entry-child-1' });
    database.prepare(`
      INSERT INTO ledger_evidence (evidence_id, run_id, event_id, kind, locator, summary, created_at)
      VALUES ('evidence-child-1', 'run-1', 'event-child-1', 'test', 'tests/x', 'safe', ?)
    `).run('2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO context_deliveries (delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash, policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at)
      VALUES ('delivery-child-1', 'run-1', 1, NULL, ?, ?, 'v1', '{}', 100, 10, 0, ?)
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO context_delivery_entries (delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json)
      VALUES ('delivery-child-1', ?, 1, 1, '{}', '{}')
    `).run(entry.id);
    database.prepare(`
      INSERT INTO context_feedback (feedback_id, delivery_id, entry_id, run_id, verdict, comment, actor, idempotency_key, created_at)
      VALUES ('context-feedback-child-1', 'delivery-child-1', ?, 'run-1', 'helpful', NULL, 'operator', 'key', ?)
    `).run(entry.id, '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO run_feedback (feedback_id, run_id, outcome, recommendation_code, recommendation_verdict, rating, comment, actor, idempotency_key, created_at)
      VALUES ('run-feedback-child-1', 'run-1', 'ok', 'VERIFY_AFTER_MUTATION', 'accepted', 5, NULL, 'operator', 'key', ?)
    `).run('2026-08-20T00:00:00.000Z');

    database.exec('PRAGMA ignore_check_constraints = ON');
    database.prepare('UPDATE ledger_evidence SET kind = ?, created_at = ? WHERE evidence_id = ?').run('unknown-kind', 'not-a-timestamp', 'evidence-child-1');
    database.prepare('UPDATE context_deliveries SET task_profile_hash = ? WHERE delivery_id = ?').run('not-a-hash', 'delivery-child-1');
    database.prepare('UPDATE context_feedback SET verdict = ?, created_at = ? WHERE feedback_id = ?').run('unknown-verdict', 'not-a-timestamp', 'context-feedback-child-1');
    database.prepare('UPDATE run_feedback SET recommendation_verdict = ?, rating = ? WHERE feedback_id = ?').run('unknown-verdict', 99, 'run-feedback-child-1');
    database.exec('PRAGMA ignore_check_constraints = OFF');

    const report = inspectLedger(database, { workspace: 'workspace-a' });

    assert.equal(report.ok, false);
    assert.equal(report.findings.some((finding: LedgerIntegrityReport['findings'][number]) => finding.kind === 'invalid_enum' && finding.category === 'ledger_evidence'), true);
    assert.equal(report.findings.some((finding: LedgerIntegrityReport['findings'][number]) => finding.kind === 'invalid_timestamp' && finding.category === 'ledger_evidence'), true);
    assert.equal(report.findings.some((finding: LedgerIntegrityReport['findings'][number]) => finding.kind === 'invalid_hash_shape' && finding.category === 'context_deliveries'), true);
    assert.equal(report.findings.some((finding: LedgerIntegrityReport['findings'][number]) => finding.kind === 'invalid_feedback_verdict' && finding.category === 'context_feedback'), true);
    assert.equal(report.findings.some((finding: LedgerIntegrityReport['findings'][number]) => finding.kind === 'invalid_rating' && finding.category === 'run_feedback'), true);
    assert.equal(JSON.stringify(report).includes('unknown-verdict'), false);
  } finally {
    database.close();
  }
});

test('treats the workspace filter as a hard boundary for counts and findings', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun(runInput('run-a', 'workspace-a'));
    store.createRun(runInput('run-b', 'workspace-b'));
    store.appendBatch('run-a', { events: [{ eventId: 'event-a', eventType: 'run.started', actor: 'agent', payload: {} }] });
    store.appendBatch('run-b', { events: [{ eventId: 'event-b', eventType: 'run.started', actor: 'agent', payload: { foreign: 'password = foreign-secret-12345' } }] });

    const report = inspectLedger(database, { workspace: 'workspace-a' });

    assert.equal(report.ok, true);
    assert.deepEqual(report.counts, {
      runs: 1,
      events: 1,
      evidence: 0,
      deliveries: 0,
      deliveryEntries: 0,
      nudgeDeliveries: 0,
      intakeFeedback: 0,
      contextFeedback: 0,
      runFeedback: 0,
      memoryLinks: 0,
      tombstones: 0,
    });
    assert.equal(report.findingCount, 0);
    assert.equal(JSON.stringify(report).includes('foreign-secret-12345'), false);
  } finally {
    database.close();
  }
});


test('requires explicit purge confirmation before changing any row', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    new LedgerStore(database).createRun(runInput());
    assert.throws(() => purgeLedgerTarget(database, {
      workspace: 'workspace-a',
      targetType: 'run',
      targetId: 'run-1',
      actor: 'operator',
      createdAt: '2026-08-20T00:00:00.000Z',
      purgeId: 'purge-1',
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.equal((error as Error).message, 'Explicit purge confirmation is required');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_purge_audit').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects single-event purge with a fixed conflict and preserves the hash chain', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun(runInput());
    store.appendBatch('run-1', { events: [{ eventId: 'event-1', eventType: 'run.started', actor: 'agent', payload: {} }] });
    assert.throws(() => purgeLedgerTarget(database, {
      workspace: 'workspace-a', targetType: 'event', targetId: 'event-1', actor: 'operator',
      createdAt: '2026-08-20T00:00:00.000Z', purgeId: 'purge-event-1', confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      assert.equal((error as Error).message, 'Single-event purge is not permitted because it would corrupt the hash chain');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_purge_audit').get<{ count: number }>()?.count, 0);
    assert.equal(new LedgerStore(database).verifyChain('run-1'), true);
  } finally {
    database.close();
  }
});

test('run purge removes ledger and intake graph but preserves curated memory and leaves a content-free tombstone', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const { recordEntry } = await import('../../src/memory/entries.js');
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun(runInput());
    database.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES ('session-1', 'workspace-a', 'Task', '{"taskType":"build","target":null,"expected":null,"constraints":null}', 'active', 0, ?, ?)
    `).run('2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO run_intakes (run_id, session_id, policy_version, profile_schema_version, profile_sources_json, recommended_tags_json, linked_at)
      VALUES ('run-1', 'session-1', 'v1', 1, '{"taskType":"inferred"}', '[]', ?)
    `).run('2026-08-20T00:00:00.000Z');
    store.appendBatch('run-1', { events: [{ eventId: 'event-1', eventType: 'run.started', actor: 'agent', payload: { safe: 'payload' } }] });
    recordNudgeDeliveryInTransaction(database, {
      runId: 'run-1',
      policyVersion: 'nudges.v1',
      code: 'UNRESOLVED_FAILURE',
      occurrenceId: 'purge-nudge-occurrence',
      checkpointId: 'purge-nudge-checkpoint',
      throughSequence: 1,
      priority: 3,
      evidenceEventIds: ['event-1'],
      referenceIds: [],
      deliveredAt: '2026-08-20T00:00:00.000Z',
    });
    const entry = recordEntry(database, { workspace: 'workspace-a', kind: 'lesson', title: 'Curated title', body: 'Curated body', createdBy: 'test', actor: 'test' }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => 'entry-1' });
    database.prepare(`
      INSERT INTO ledger_evidence (evidence_id, run_id, event_id, kind, locator, summary, created_at)
      VALUES ('evidence-1', 'run-1', 'event-1', 'test', 'tests/x', 'safe evidence', ?)
    `).run('2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO context_deliveries (delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash, policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at)
      VALUES ('delivery-1', 'run-1', 1, 'session-1', ?, ?, 'v1', '{}', 100, 10, 0, ?)
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO context_delivery_entries (delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json)
      VALUES ('delivery-1', ?, 1, 1, '{}', '{}')
    `).run(entry.id);
    database.prepare(`
      INSERT INTO ledger_memory_links (link_id, run_id, event_id, entry_id, created_at)
      VALUES ('link-1', 'run-1', 'event-1', ?, ?)
    `).run(entry.id, '2026-08-20T00:00:00.000Z');

    const result = purgeLedgerTarget(database, {
      workspace: 'workspace-a', targetType: 'run', targetId: 'run-1', actor: 'operator',
      reason: 'privacy request', createdAt: '2026-08-20T00:00:00.000Z', purgeId: 'purge-run-1', confirmed: true,
    });

    assert.equal(result.replayed, false);
    assert.equal(result.deletedCount, 9);
    assert.equal(result.tombstone.targetId, 'run-1');
    assert.equal(result.tombstone.runId, null);
    assert.equal(result.tombstone.reason, 'privacy request');
    assert.equal(result.backupWarning, 'Backups may retain purged content and must be managed separately.');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM nudge_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries WHERE id = ?').get<{ count: number }>('entry-1')?.count, 1);
    const audit = database.prepare('SELECT * FROM ledger_purge_audit WHERE purge_id = ?').get<Record<string, unknown>>('purge-run-1');
    assert.equal(audit?.target_id, 'run-1');
    assert.equal(JSON.stringify(audit).includes('Curated body'), false);
    assert.equal(inspectLedger(database, {}).ok, true);
    assert.equal(inspectLedger(database, {}).tombstoneCount, 1);
  } finally {
    database.close();
  }
});


test('replays an exact purge without a duplicate tombstone and conflicts on changed body', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    new LedgerStore(database).createRun(runInput());
    const input = {
      workspace: 'workspace-a', targetType: 'run' as const, targetId: 'run-1', actor: 'operator',
      reason: 'privacy request', createdAt: '2026-08-20T00:00:00.000Z', purgeId: 'purge-replay-1', confirmed: true,
    };
    const first = purgeLedgerTarget(database, input);
    const replay = purgeLedgerTarget(database, input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.deletedCount, 0);
    assert.deepEqual(replay.tombstone, first.tombstone);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_purge_audit').get<{ count: number }>()?.count, 1);
    assert.throws(() => purgeLedgerTarget(database, { ...input, reason: 'changed request' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      assert.equal((error as Error).message, 'Ledger purge conflicts with an existing purge');
      return true;
    });
  } finally {
    database.close();
  }
});

test('does not disclose or purge a target outside the requested workspace', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    new LedgerStore(database).createRun(runInput('run-b', 'workspace-b'));
    assert.throws(() => purgeLedgerTarget(database, {
      workspace: 'workspace-a', targetType: 'run', targetId: 'run-b', actor: 'operator',
      createdAt: '2026-08-20T00:00:00.000Z', purgeId: 'purge-cross-workspace', confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_FOUND');
      assert.equal((error as Error).message, 'Ledger purge target was not found');
      assert.equal((error as Error).message.includes('workspace-b'), false);
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_purge_audit').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('delivery purge removes delivery-owned ledger rows but preserves curated memory', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    const { recordEntry } = await import('../../src/memory/entries.js');
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun(runInput());
    store.appendBatch('run-1', { events: [{ eventId: 'event-1', eventType: 'run.started', actor: 'agent', payload: {} }] });
    const entry = recordEntry(database, { workspace: 'workspace-a', kind: 'lesson', title: 'Keep title', body: 'Keep body', createdBy: 'test', actor: 'test' }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => 'entry-delivery-1' });
    database.prepare(`
      INSERT INTO context_deliveries (delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash, policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at)
      VALUES ('delivery-purge-1', 'run-1', 1, NULL, ?, ?, 'v1', '{}', 100, 10, 0, ?)
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO context_delivery_entries (delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json)
      VALUES ('delivery-purge-1', ?, 1, 1, '{}', '{}')
    `).run(entry.id);
    database.prepare(`
      INSERT INTO ledger_memory_links (link_id, run_id, event_id, delivery_id, entry_id, created_at)
      VALUES ('link-delivery-1', 'run-1', 'event-1', 'delivery-purge-1', ?, ?)
    `).run(entry.id, '2026-08-20T00:00:00.000Z');

    const result = purgeLedgerTarget(database, {
      workspace: 'workspace-a', targetType: 'delivery', targetId: 'delivery-purge-1', actor: 'operator',
      createdAt: '2026-08-20T00:00:00.000Z', purgeId: 'purge-delivery-1', confirmed: true,
    });

    assert.equal(result.tombstone.deliveryId, null);
    assert.equal(result.tombstone.targetId, 'delivery-purge-1');
    assert.ok(result.deletedCount >= 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries WHERE id = ?').get<{ count: number }>(entry.id)?.count, 1);
    assert.equal(inspectLedger(database, { workspace: 'workspace-a' }).ok, true);
  } finally {
    database.close();
  }
});

test('reports a fixed healthy schema for an empty ledger without mutating the database', async () => {
  const database = await setup();
  try {
    const before = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM ledger_runs) AS runs,
        (SELECT COUNT(*) FROM ledger_events) AS events,
        (SELECT COUNT(*) FROM ledger_purge_audit) AS tombstones
    `).get<{ runs: number; events: number; tombstones: number }>();

    const report = inspectLedger(database, {});

    assert.equal(report.ok, true);
    assert.equal(report.workspace, null);
    assert.deepEqual(emptyCounts(report), {
      runs: 0,
      events: 0,
      evidence: 0,
      deliveries: 0,
      deliveryEntries: 0,
      nudgeDeliveries: 0,
      intakeFeedback: 0,
      contextFeedback: 0,
      runFeedback: 0,
      memoryLinks: 0,
      tombstones: 0,
    });
    assert.deepEqual(Object.keys(report.checks), [...LEDGER_CHECK_NAMES]);
    for (const name of LEDGER_CHECK_NAMES) {
      assert.deepEqual(report.checks[name], {
        ok: true,
        count: 0,
        findingCount: 0,
        findings: [],
        truncated: false,
      });
    }
    assert.deepEqual(report.findings, []);
    assert.equal(report.findingCount, 0);
    assert.equal(report.findingsTruncated, false);
    assert.equal(report.tombstoneCount, 0);
    assert.deepEqual(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM ledger_runs) AS runs,
        (SELECT COUNT(*) FROM ledger_events) AS events,
        (SELECT COUNT(*) FROM ledger_purge_audit) AS tombstones
    `).get<{ runs: number; events: number; tombstones: number }>(), before);
  } finally {
    database.close();
  }
});

test('inspection preserves programmer and schema faults but classifies SQLite corruption', () => {
  const failingDatabase = (failure: Error): SqliteDatabase => ({
    filePath: ':memory:',
    exec: () => undefined,
    prepare: () => { throw failure; },
    close: () => undefined,
  });
  const programmerError = new TypeError('maintenance programmer sentinel');
  assert.throws(() => inspectLedger(failingDatabase(programmerError)), (error: unknown) => error === programmerError);

  const schemaError = Object.assign(new Error('schema changed sentinel'), { code: 'ERR_SQLITE_ERROR', errcode: 17 });
  assert.throws(() => inspectLedger(failingDatabase(schemaError)), (error: unknown) => error === schemaError);

  for (const errcode of [11, 26]) {
    const corruption = Object.assign(new Error('maintenance corruption secret sentinel'), { code: 'ERR_SQLITE_ERROR', errcode });
    assert.throws(
      () => inspectLedger(failingDatabase(corruption)),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INTEGRITY_ERROR');
        assert.doesNotMatch((error as Error).message, /maintenance corruption secret sentinel/u);
        return true;
      },
    );
  }
});

test('purge propagates an unexpected trigger failure without reclassifying its text', async () => {
  const database = await setup();
  try {
    const { LedgerStore } = await import('../../src/ledger/store.js');
    new LedgerStore(database).createRun(runInput());
    database.exec(`
      CREATE TRIGGER purge_conflict_spoof
      BEFORE INSERT ON ledger_purge_audit
      BEGIN
        SELECT RAISE(ABORT, 'UNIQUE constraint failed: ledger_purge_audit.purge_id');
      END;
    `);

    assert.throws(
      () => purgeLedgerTarget(database, {
        workspace: 'workspace-a', targetType: 'run', targetId: 'run-1', actor: 'operator',
        createdAt: '2026-08-20T00:00:00.000Z', purgeId: 'purge-trigger-spoof', confirmed: true,
      }),
      (error: unknown) => {
        const sqlite = error as { code?: unknown; errcode?: unknown };
        assert.equal(sqlite.code, 'ERR_SQLITE_ERROR');
        assert.equal(sqlite.errcode, 1811);
        return true;
      },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_purge_audit').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});
