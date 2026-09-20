import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { loadMigrationSnapshot, migrateDatabase } from '../../src/db/migrate.js';
import { CURRENT_MIGRATION_VERSIONS, CURRENT_SCHEMA_VERSION } from '../fixtures/current-migrations.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { executeTaskRequest } from '../../src/task-run/idempotency.js';

test('the current database has canonical migrations and is idempotent', () => {
  const database = openConnection(':memory:');
  try {
    const first = migrateDatabase(database);
    assert.deepEqual(first.applied, CURRENT_MIGRATION_VERSIONS);
    assert.equal(first.currentVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(migrateDatabase(database).applied, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, CURRENT_MIGRATION_VERSIONS.length);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'entries'").get()?.['1'], 1);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'enno_opencode_continuation_receipts'").get()?.['1'], 1);
    assert.equal(database.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version, CURRENT_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});
test('a future migration remains a generic, checksum-bound migration concern', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-migration-future-'));
  const migrations = path.join(root, 'migrations');
  await mkdir(migrations);
  await writeFile(path.join(migrations, '001_initial.sql'), 'CREATE TABLE baseline (id INTEGER PRIMARY KEY);\n');
  const database = openConnection(path.join(root, 'database.sqlite3'));
  try {
    assert.deepEqual(migrateDatabase(database, migrations).applied, [1]);
    await writeFile(path.join(migrations, '002_feature.sql'), 'ALTER TABLE baseline ADD COLUMN feature TEXT;\n');
    assert.deepEqual(loadMigrationSnapshot(migrations).migrations.map(({ version }) => version), [1, 2]);
    assert.deepEqual(migrateDatabase(database, migrations).applied, [2]);
    assert.equal(database.prepare("SELECT name FROM pragma_table_info('baseline') WHERE name = 'feature'").get<{ name: string }>()?.name, 'feature');
  } finally {
    database.close();
  }
});

test('receipt-run migration backfills legacy task receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-migration-receipts-'));
  const partial = path.join(root, 'migrations');
  await mkdir(partial);
  const snapshot = loadMigrationSnapshot();
  for (const migration of snapshot.migrations.slice(0, 8)) {
    await copyFile(path.resolve(import.meta.dirname, '../../migrations', migration.name), path.join(partial, migration.name));
  }
  const database = openConnection(path.join(root, 'database.sqlite3'));
  try {
    migrateDatabase(database, partial);
    new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' }).createRun({
      runId: 'legacy-run',
      workspace: 'workspace-a',
      protocolVersion: '1',
      client: { kind: 'opencode', version: '1.0.0' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Task', query: 'Run tests', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      metadata: {},
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' }).createRun({
      runId: 'purged-legacy-run',
      workspace: 'workspace-a',
      protocolVersion: '1',
      client: { kind: 'opencode', version: '1.0.0' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Task', query: 'Run tests', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      metadata: {},
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    const purgedReceiptInput = {
      scope: 'opencode.task.create',
      key: 'purged-legacy-request',
      request: { task: 'purged' },
      createdAt: '2026-08-20T00:00:00.000Z',
    };
    executeTaskRequest(database, purgedReceiptInput, () => ({ runId: 'purged-legacy-run' }));
    database.prepare('DELETE FROM ledger_runs WHERE run_id = ?').run('purged-legacy-run');
    database.prepare(`
      INSERT INTO task_request_receipts (scope, key_hash, request_hash, response_json, created_at)
      VALUES ('opencode.task.create', ?, ?, '{"runId":"legacy-run"}', ?)
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO task_request_receipts (scope, key_hash, request_hash, response_json, created_at)
      VALUES ('other.operation', ?, ?, '{"runId":"legacy-run"}', ?)
    `).run('c'.repeat(64), 'd'.repeat(64), '2026-08-20T00:00:00.000Z');
    const latest = snapshot.migrations[8]!;
    await copyFile(path.resolve(import.meta.dirname, '../../migrations', latest.name), path.join(partial, latest.name));

    assert.deepEqual(migrateDatabase(database, partial).applied, [9]);
    assert.deepEqual({ ...database.prepare(`
      SELECT run_id, purged_at
        FROM task_request_receipts
       WHERE scope = 'opencode.task.create' AND response_json != 'null'
    `).get() }, {
      run_id: 'legacy-run',
      purged_at: null,
    });
    assert.deepEqual({ ...database.prepare(`
      SELECT run_id, response_json, purged_at
        FROM task_request_receipts
       WHERE response_json = 'null'
    `).get() }, {
      run_id: null,
      response_json: 'null',
      purged_at: '2026-08-20T00:00:00.000Z',
    });
    assert.deepEqual({ ...database.prepare(`
      SELECT run_id, response_json, purged_at
        FROM task_request_receipts
       WHERE scope = 'other.operation'
    `).get() }, {
      run_id: null,
      response_json: '{"runId":"legacy-run"}',
      purged_at: null,
    });
    assert.throws(
      () => executeTaskRequest(database, purgedReceiptInput, () => ({ runId: 'replacement' })),
      /purged/iu,
    );
  } finally {
    database.close();
  }
});
