import assert from 'node:assert/strict';
import { CURRENT_MIGRATION_VERSIONS, CURRENT_SCHEMA_VERSION } from '../fixtures/current-migrations.js';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const migrationsDirectory = path.join(repositoryRoot, 'migrations');
const NOW = '2026-09-06T08:00:00.000Z';

function insertJob(database: ReturnType<typeof openConnection>, overrides: Record<string, string | number | null> = {}): void {
  database.prepare(`
    INSERT INTO orchestration_jobs (
      job_id, kind, run_id, input_digest, payload_json, state, attempts,
      available_at, lease_owner, lease_expires_at, result_digest, error_code,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.job_id ?? 'job-1',
    overrides.kind ?? 'semantic_context',
    overrides.run_id ?? null,
    overrides.input_digest ?? 'a'.repeat(64),
    overrides.payload_json ?? '{"scope":"x"}',
    overrides.state ?? 'pending',
    overrides.attempts ?? 0,
    overrides.available_at ?? NOW,
    overrides.lease_owner ?? null,
    overrides.lease_expires_at ?? null,
    overrides.result_digest ?? null,
    overrides.error_code ?? null,
    overrides.created_at ?? NOW,
    overrides.updated_at ?? NOW,
    overrides.completed_at ?? null,
  );
}

test('trace migrations apply on a fresh database with current trace tables', async () => {
  const database = openConnection(':memory:');
  try {
    const first = migrateDatabase(database);
    assert.deepEqual(first.applied, CURRENT_MIGRATION_VERSIONS);
    assert.equal(first.currentVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(database.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version, CURRENT_SCHEMA_VERSION);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'orcareplay_trace_cursors'").get()?.['1'], 1);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'orcareplay_trace_context'").get()?.['1'], 1);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'idx_orchestration_jobs_ready'").get()?.['1'], 1);
    insertJob(database, { kind: 'trace_ingestion', job_id: 'job-trace' });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orchestration_jobs WHERE kind = 'trace_ingestion'").get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('migration 003 rebuild preserves existing orchestration_jobs rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-migration-003-'));
  const migrations = path.join(root, 'migrations');
  try {
    await cp(path.join(migrationsDirectory, '001_initial.sql'), path.join(migrations, '001_initial.sql'));
    await cp(path.join(migrationsDirectory, '002_non_blocking_orchestration.sql'), path.join(migrations, '002_non_blocking_orchestration.sql'));
    const database = openConnection(path.join(root, 'database.sqlite3'));
    try {
      assert.deepEqual(migrateDatabase(database, migrations).applied, [1, 2]);
      insertJob(database, { job_id: 'job-before', kind: 'semantic_context', input_digest: 'b'.repeat(64) });
      await cp(path.join(migrationsDirectory, '003_orcareplay_trace.sql'), path.join(migrations, '003_orcareplay_trace.sql'));
      assert.deepEqual(migrateDatabase(database, migrations).applied, [3]);
      const preserved = database.prepare('SELECT job_id, kind, state, attempts FROM orchestration_jobs WHERE job_id = ?').get<{ job_id: string; kind: string; state: string; attempts: number }>('job-before');
      assert.deepEqual({ ...preserved }, { job_id: 'job-before', kind: 'semantic_context', state: 'pending', attempts: 0 });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orchestration_jobs').get<{ count: number }>()?.count, 1);
      assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'orchestration_jobs_v2'").get()?.['1'], undefined);
      assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration 003 enforces cursor and context constraints', async () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const cursorInsert = database.prepare(`
      INSERT INTO orcareplay_trace_cursors (directory, trace_run_id, last_seq, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    cursorInsert.run('/tmp/orca', 'run_abcdef123456', 0, 'active', NOW, NOW);
    assert.throws(
      () => cursorInsert.run('/tmp/orca', 'run_abcdef123457', -2, 'active', NOW, NOW),
      /CHECK|constraint|trace_context_too_large/i,
    );
    assert.throws(
      () => cursorInsert.run('/tmp/orca', 'run_abcdef123458', 0, 'bogus', NOW, NOW),
      /CHECK|constraint|trace_context_too_large/i,
    );

    const contextInsert = database.prepare(`
      INSERT INTO orcareplay_trace_context (directory, trace_run_id, digest, context_json, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    contextInsert.run('/tmp/orca', 'run_abcdef123456', 'c'.repeat(64), '{"ok":true}', 'orcareplay', NOW, NOW);
    assert.throws(
      () => contextInsert.run('/tmp/orca', 'run_abcdef123459', 'not-a-digest', '{}', 'orcareplay', NOW, NOW),
      /CHECK|constraint|trace_context_too_large/i,
    );
    assert.throws(
      () => contextInsert.run('/tmp/orca', 'run_abcdef123459', 'd'.repeat(64), '{not json', 'orcareplay', NOW, NOW),
      /CHECK|constraint|trace_context_too_large/i,
    );
    assert.throws(
      () => contextInsert.run('/tmp/orca', 'run_abcdef123459', 'e'.repeat(64), `{"pad":"${'x'.repeat(4100)}"}`, 'orcareplay', NOW, NOW),
      /CHECK|constraint|trace_context_too_large/i,
    );
    assert.throws(
      () => contextInsert.run('/tmp/orca', 'run_abcdef123459', 'f'.repeat(64), '{}', 'other', NOW, NOW),
      /CHECK|constraint|trace_context_too_large/i,
    );
  } finally {
    database.close();
  }
});

test('migration 003 keeps job kind deduplication and cascade behavior', async () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, protocol_version, capture_profile, coverage_json,
        status, title, metadata_json, last_sequence, started_at, created_at, updated_at
      ) VALUES ('run-1', 'workspace', 'opencode', '1', 'minimal', '{}', 'active', 'Task', '{}', 0, ?, ?, ?)
    `).run(NOW, NOW, NOW);
    insertJob(database, { job_id: 'job-cascade', kind: 'trace_ingestion', run_id: 'run-1', input_digest: '0'.repeat(64) });
    assert.throws(
      () => insertJob(database, { job_id: 'job-dup', kind: 'trace_ingestion', input_digest: '0'.repeat(64) }),
      /UNIQUE|constraint/i,
    );
    database.prepare('DELETE FROM ledger_runs WHERE run_id = ?').run('run-1');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orchestration_jobs WHERE job_id = ?').get<{ count: number }>('job-cascade')?.count, 0);
  } finally {
    database.close();
  }
});

test('migration 003 checksums remain file-based and the migration list is contiguous', async () => {
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  assert.deepEqual(files, ['001_initial.sql', '002_non_blocking_orchestration.sql', '003_orcareplay_trace.sql', '004_orcareplay_pipeline.sql', '005_execution_selection.sql']);
});

test('execution migration marks existing runs legacy and never opts them into the new selection protocol', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-migration-execution-'));
  const directory = path.join(root, 'migrations');
  const database = openConnection(':memory:');
  try {
    for (const file of ['001_initial.sql', '002_non_blocking_orchestration.sql', '003_orcareplay_trace.sql', '004_orcareplay_pipeline.sql']) {
      await cp(path.join(migrationsDirectory, file), path.join(directory, file));
    }
    migrateDatabase(database, directory);
    database.prepare(`INSERT INTO ledger_runs(run_id,workspace,client_kind,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,created_at,updated_at)
      VALUES ('old-run','project:fixture','opencode','1','minimal','{}','active','{}',?,?,?)`).run(NOW,NOW,NOW);
    await cp(path.join(migrationsDirectory, '005_execution_selection.sql'), path.join(directory, '005_execution_selection.sql'));
    assert.deepEqual(migrateDatabase(database, directory).applied, [5]);
    assert.equal(database.prepare("SELECT choice FROM task_execution_selections WHERE run_id = 'old-run'").get()?.choice, 'legacy');
    const { initializeExecution, executionView } = await import('../../src/execution/store.js');
    initializeExecution(database, 'old-run', { mode: 'off', candidates: [] });
    assert.equal(executionView(database, 'old-run'), null);
    assert.equal(database.prepare("SELECT status FROM ledger_runs WHERE run_id = 'old-run'").get()?.status, 'active');
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
