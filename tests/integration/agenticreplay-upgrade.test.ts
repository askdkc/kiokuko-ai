import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { CURRENT_MIGRATION_SNAPSHOT } from '../fixtures/current-migrations.js';
import { enqueueOrchestrationJob } from '../../src/orchestration/jobs.js';
import { readTraceAdvisory } from '../../src/trace/advisory.js';
import { syncTraceStore } from '../../src/trace/sync.js';

test('migration 010 preserves legacy data, retires legacy jobs and isolates the active recorder atomically', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agenticreplay-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const migrations = path.join(root, 'migrations');
  await mkdir(migrations);
  for (const migration of CURRENT_MIGRATION_SNAPSHOT.migrations.filter(m => m.version < 10)) {
    await copyFile(path.resolve('migrations', migration.name), path.join(migrations, migration.name));
  }
  const db = openConnection(path.join(root, 'db.sqlite'));
  t.after(() => db.close());
  migrateDatabase(db, migrations);
  const legacy = path.join(root, '.orca', 'runs');
  db.prepare("INSERT INTO orcareplay_trace_stores(directory,repository_root,capture_cwd,state) VALUES(?,?,?,'present')").run(legacy, root, root);
  db.prepare("INSERT INTO orcareplay_trace_cursors(directory,trace_run_id,created_at,updated_at) VALUES(?,'run_abcdef','time','time')").run(legacy);
  db.prepare("INSERT INTO orcareplay_trace_context(directory,trace_run_id,digest,context_json,source,created_at,updated_at) VALUES(?,'run_abcdef',?,'{}','orcareplay','time','time')").run(legacy, 'a'.repeat(64));
  const jobs = [
    enqueueOrchestrationJob(db, { kind: 'trace_ingestion', payload: { directory: legacy, traceRunId: 'run_abcdef' } }),
    enqueueOrchestrationJob(db, { kind: 'skill_discovery', payload: { source: 'orcareplay', directory: legacy } }),
    enqueueOrchestrationJob(db, { kind: 'memory_promotion', payload: { source: 'orcareplay', directory: legacy } }),
  ];
  const unrelated = enqueueOrchestrationJob(db, { kind: 'memory_promotion', payload: { source: 'user' } });
  const tables = ['orcareplay_trace_stores', 'orcareplay_trace_cursors', 'orcareplay_trace_context', 'entries', 'entry_revisions', 'task_context_revisions'];
  const before = tables.map(name => db.prepare(`SELECT * FROM ${name}`).all());
  const history = db.prepare('SELECT * FROM schema_migrations').all();
  await copyFile(path.resolve('migrations/010_agenticreplay_trace.sql'), path.join(migrations, '010_agenticreplay_trace.sql'));
  assert.throws(() => migrateDatabase(db, migrations, { beforeMarkApplied: () => { throw Error('rollback'); } }), /rollback/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='agenticreplay_trace_context'").get(), undefined);
  for (const job of jobs) assert.equal(db.prepare('SELECT state FROM orchestration_jobs WHERE job_id=?').get<{state: string}>(job.jobId)?.state, 'pending');
  assert.deepEqual(migrateDatabase(db, migrations).applied, [10]);
  tables.forEach((name, i) => assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(), before[i]));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<10').all(), history);
  for (const job of jobs) assert.deepEqual({ ...db.prepare('SELECT state,error_code FROM orchestration_jobs WHERE job_id=?').get(job.jobId) }, { state: 'completed', error_code: 'trace_recorder_superseded' });
  assert.equal(db.prepare('SELECT state FROM orchestration_jobs WHERE job_id=?').get<{state: string}>(unrelated.jobId)?.state, 'pending');
  assert.deepEqual(readTraceAdvisory(db, root, root), { rejected: false });
  const sync = await syncTraceStore(db, { captureCwd: root });
  assert.equal(sync.exitCode, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agenticreplay_trace_cursors').get<{n: number}>()?.n, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.throws(() => db.prepare("INSERT INTO agenticreplay_trace_context(directory,trace_run_id,digest,context_json,source,created_at,updated_at) VALUES(?,'run_abcdef',?,'{}','orcareplay','time','time')").run(legacy, 'b'.repeat(64)), /CHECK/);
});
