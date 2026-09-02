import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { CURRENT_MIGRATION_VERSIONS } from '../fixtures/current-migrations.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const migrationsDirectory = path.join(repositoryRoot, 'migrations');

const gatewayTables = [
  'ledger_runs',
  'run_intakes',
  'intake_feedback',
  'ledger_events',
  'ledger_evidence',
  'context_deliveries',
  'context_delivery_entries',
  'context_feedback',
  'run_feedback',
  'ledger_memory_links',
  'ledger_purge_audit',
  'gateway_idempotency',
  'nudge_deliveries',
] as const;

const gatewayIndexes = [
  'idx_ledger_runs_workspace_status_created_at',
  'idx_ledger_runs_parent',
  'idx_run_intakes_session',
  'idx_intake_feedback_run_created_at',
  'idx_ledger_events_run_sequence',
  'idx_ledger_events_run_source',
  'idx_ledger_evidence_run_created_at',
  'idx_context_deliveries_run_created_at',
  'idx_context_delivery_entries_entry',
  'idx_context_feedback_run',
  'idx_run_feedback_run_created_at',
  'idx_ledger_memory_links_run',
  'idx_ledger_memory_links_entry',
  'idx_ledger_purge_audit_target',
  'idx_gateway_idempotency_created_at',
  'nudge_deliveries_run_code_sequence',
  'nudge_deliveries_run_sequence',
  'nudge_deliveries_run_checkpoint',
] as const;

const now = '2026-08-20T00:00:00.000Z';

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

function exists(database: ReturnType<typeof openConnection>, type: 'table' | 'index', name: string): boolean {
  return Boolean(
    database
      .prepare('SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?')
      .get<{ present: number }>(type, name),
  );
}

function insertRun(
  database: ReturnType<typeof openConnection>,
  runId = 'run-1',
  workspace = 'workspace-1',
): void {
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
      protocol_version, capture_profile, coverage_json, status, title, task_hash,
      metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'generic', '1.0.0', NULL, NULL, '1', 'standard', '{}', 'intake', 'Task', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
  `).run(runId, workspace, now, now, now);
}

function insertSession(
  database: ReturnType<typeof openConnection>,
  sessionId = 'session-1',
  workspace = 'workspace-1',
): void {
  database.prepare(`
    INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
    VALUES (?, ?, 'Task', '{"taskType":"build","target":null,"expected":null,"constraints":null}', 'active', 0, ?, ?)
  `).run(sessionId, workspace, now, now);
}

function insertIntake(database: ReturnType<typeof openConnection>, runId = 'run-1', sessionId = 'session-1'): void {
  database.prepare(`
    INSERT INTO run_intakes (
      run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
      initial_profile_hash, recommended_tags_json, linked_at, finalized_at
    ) VALUES (?, ?, 'v1', 1, '{"taskType":"inferred"}', NULL, '[]', ?, NULL)
  `).run(runId, sessionId, now);
}

function seedGateway(database: ReturnType<typeof openConnection>, workspace = 'workspace-1'): void {
  insertRun(database, 'run-1', workspace);
  insertSession(database, 'session-1', workspace);
  insertIntake(database);
}

test('fresh migration applies the current schema and every gateway table and index', async () => {
  const directory = await temporaryDirectory('gateway-fresh');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    assert.deepEqual(migrateDatabase(database, migrationsDirectory).applied, CURRENT_MIGRATION_VERSIONS);
    assert.deepEqual(
      gatewayTables.filter((table) => !exists(database, 'table', table)),
      [],
    );
    assert.deepEqual(
      gatewayIndexes.filter((index) => !exists(database, 'index', index)),
      [],
    );
  } finally {
    database.close();
  }
});

test('fresh migration uses immutable revisions and no mutable entry shape', async () => {
  const directory = await temporaryDirectory('gateway-revision-schema');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(database, migrationsDirectory);
    assert.deepEqual(database.prepare('PRAGMA table_info(entries)').all<{ name: string }>().map((column) => column.name), [
      'id', 'workspace', 'status', 'trust_level', 'confidence', 'current_revision', 'superseded_by',
      'created_by', 'created_at', 'updated_at', 'verified_at',
    ]);
    assert.deepEqual(database.prepare('PRAGMA table_info(entry_revisions)').all<{ name: string }>().map((column) => column.name), [
      'entry_id', 'workspace', 'revision', 'kind', 'title', 'body', 'summary', 'scope_json',
      'provenance_json', 'content_hash', 'created_by', 'created_at',
    ]);
  } finally {
    database.close();
  }
});

test('run_intakes enforces one-to-one links, foreign keys, and workspace consistency', async () => {
  const directory = await temporaryDirectory('gateway-intake-link');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(database, migrationsDirectory);
    seedGateway(database);

    assert.throws(() => insertIntake(database), /UNIQUE|constraint/i);
    insertRun(database, 'run-2', 'workspace-1');
    assert.throws(() => insertIntake(database, 'run-2', 'session-1'), /UNIQUE|constraint/i);

    insertSession(database, 'session-2', 'workspace-2');
    assert.throws(() => insertIntake(database, 'run-2', 'session-2'), /workspace|constraint/i);
    assert.throws(() => database.prepare(`
      UPDATE run_intakes SET session_id = 'session-2' WHERE run_id = 'run-1'
    `).run(), /workspace|constraint/i);
    assert.equal(database.prepare('SELECT session_id FROM run_intakes WHERE run_id = ?').get<{ session_id: string }>('run-1')?.session_id, 'session-1');
    assert.throws(() => database.prepare(`
      INSERT INTO ledger_events (
        event_id, run_id, sequence, source_event_id, source_sequence, event_type, source_type,
        actor, outcome, occurred_at, ingested_at, payload_json, redaction_json, previous_hash, event_hash
      ) VALUES ('event-missing-run', 'missing-run', 1, NULL, NULL, 'source.event', 'generic', 'agent', NULL, ?, ?, '{}', '{}', '0', '1')
    `).run(now, now), /FOREIGN KEY|constraint/i);
  } finally {
    database.close();
  }
});

test('intake feedback enforces exactly one target and idempotency uniqueness', async () => {
  const directory = await temporaryDirectory('gateway-feedback');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(database, migrationsDirectory);
    seedGateway(database);
    const insertFeedback = (questionId: string | null, profileField: string | null, actor = 'user', key = 'feedback-1') => database.prepare(`
      INSERT INTO intake_feedback (
        feedback_id, run_id, session_id, question_id, profile_field, verdict, comment, actor, idempotency_key, created_at
      ) VALUES (?, 'run-1', 'session-1', ?, ?, 'helpful', NULL, ?, ?, ?)
    `).run(`${actor}-${key}-${questionId ?? profileField}`, questionId, profileField, actor, key, now);

    insertFeedback('target', null);
    insertFeedback(null, 'expected', 'user-2', 'feedback-2');
    assert.throws(() => insertFeedback(null, null, 'user-3', 'feedback-3'), /CHECK|constraint/i);
    assert.throws(() => insertFeedback('target', 'expected', 'user-4', 'feedback-4'), /CHECK|constraint/i);
    assert.throws(() => insertFeedback('target', null), /UNIQUE|constraint/i);
  } finally {
    database.close();
  }
});

test('gateway foreign keys prevent orphaned child rows', async () => {
  const directory = await temporaryDirectory('gateway-foreign-keys');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(database, migrationsDirectory);
    assert.equal(database.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys, 1);
    assert.throws(() => database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
        policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at
      ) VALUES ('delivery-1', 'missing-run', 0, NULL, 'hash', 'query', 'v1', '{}', 8000, 0, 0, ?)
    `).run(now), /FOREIGN KEY|constraint/i);
    assert.throws(() => database.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json
      ) VALUES ('missing-delivery', 'missing-entry', 1, 1, '{}', '{}')
    `).run(), /FOREIGN KEY|constraint/i);
  } finally {
    database.close();
  }
});

test('migration asset is present and checksum remains file-based', async () => {
  const sql = await readFile(path.join(migrationsDirectory, '001_initial.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE ledger_runs/);
  assert.match(sql, /CREATE TABLE ledger_events/);
});

test('idempotency schema has composite uniqueness, bounded hash checks, and no raw key/request columns', async () => {
  const directory = await temporaryDirectory('gateway-idempotency-schema');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(database, migrationsDirectory);
    const columns = database.prepare('PRAGMA table_info(gateway_idempotency)').all<{ name: string; pk: number }>();
    assert.deepEqual(columns.map(({ name }) => name), ['scope', 'key_hash', 'request_hash', 'response_json', 'created_at']);
    assert.deepEqual(columns.map(({ pk }) => pk), [1, 2, 0, 0, 0]);
    assert.deepEqual(
      database.prepare('PRAGMA index_info(idx_gateway_idempotency_created_at)').all<{ name: string }>().map(({ name }) => name),
      ['created_at'],
    );
    const hash = 'a'.repeat(64);
    const requestHash = 'b'.repeat(64);
    const insert = database.prepare(`
      INSERT INTO gateway_idempotency (scope, key_hash, request_hash, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('schema-scope', hash, requestHash, '{"ok":true}', now);
    assert.throws(() => insert.run('schema-scope', hash, requestHash, '{"ok":true}', now), /UNIQUE|constraint/i);
    insert.run('other-schema-scope', hash, requestHash, '{"ok":true}', now);
    assert.throws(() => insert.run('schema-scope-2', 'bad-hash', requestHash, '{}', now), /CHECK|constraint/i);
    assert.throws(() => insert.run('schema-scope-3', hash, 'BAD-HASH', '{}', now), /CHECK|constraint/i);
  } finally {
    database.close();
  }
});
