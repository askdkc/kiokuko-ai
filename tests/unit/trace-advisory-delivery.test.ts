import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { openConnection } from '../../src/db/connection.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { canonicalContentHash, type JsonObject } from '../../src/serialization/validate.js';
import { orcaRunsDirectory } from '../../src/trace/scan.js';

const capabilities = [
  { kind: 'skill' as const, name: 'kiokuko-soul', description: 'Routes work.' },
  { kind: 'skill' as const, name: 'kiokuko-single-purpose-functions', description: 'Code contracts.' },
  { kind: 'skill' as const, name: 'memory-reasoning', description: 'Verifies recalled claims.' },
];

async function fixture(): Promise<{ root: string; database: SqliteDatabase }> {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-trace-advisory-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-trace-advisory-db-'));
  const database = openConnection(path.join(databaseDirectory, 'data.sqlite3'));
  migrateDatabase(database);
  return { root: await realpath(root), database };
}

async function prepare(root: string, database: SqliteDatabase, requestId: string) {
  return prepareOpenCodeTask(database, {
    requestId,
    cwd: root,
    task: 'Repair the trace-aware task preparation path',
    profileHints: {
      taskType: 'debug',
      target: 'src/trace/ingest.ts',
      expected: 'advisory context is bounded',
      constraints: null,
    },
    capabilities,
    client: { kind: 'opencode', sessionId: 'trace-advisory-test' },
    skillDiscoveryMode: 'off',
  });
}

function storedContext(): JsonObject {
  return {
    source: 'orcareplay',
    traceRunId: 'run_abcdef123456',
    schemaVersion: '0.1.0',
    throughSeq: 4,
    integrity: 'verified',
    summary: {
      events: 4,
      turns: 1,
      errorCount: 0,
      shellFailures: 0,
      runEnded: false,
      toolCalls: [],
      errors: [],
      fsChanges: [],
      notes: [],
    },
  };
}

function insertStoredContext(database: SqliteDatabase, root: string, context: JsonObject, digest = canonicalContentHash(context)): void {
  const directory = orcaRunsDirectory(root);
  const traceRunId = context.traceRunId;
  if (typeof traceRunId !== 'string') throw new Error('test trace context is missing its run ID');
  database.prepare(`
    INSERT INTO orcareplay_trace_context (directory, trace_run_id, digest, context_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'orcareplay', ?, ?)
  `).run(
    directory,
    traceRunId,
    digest,
    JSON.stringify(context),
    '2026-09-06T08:00:00.000Z',
    '2026-09-06T08:00:00.000Z',
  );
}

test('task preparation is unchanged when no stored trace context exists', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepare(root, database, 'trace-advisory-no-context');
    assert.equal(Object.hasOwn(prepared, 'traceContext'), false);
  } finally {
    database.close();
  }
});

test('attaches the newest stored trace context as explicit advisory-only data', async () => {
  const { root, database } = await fixture();
  try {
    const context = storedContext();
    insertStoredContext(database, root, context);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orcareplay_trace_context WHERE directory = ?').get<{ count: number }>(orcaRunsDirectory(root))?.count, 1);
    const prepared = await prepare(root, database, 'trace-advisory-with-context');
    assert.deepEqual(prepared.traceContext, {
      source: 'orcareplay',
      referenceOnly: true,
      autoInstall: false,
      autoExecute: false,
      traceRunId: 'run_abcdef123456',
      digest: canonicalContentHash(context),
      context,
    });
    const revision = database.prepare(`
      SELECT context_json AS contextJson
      FROM task_context_revisions
      WHERE run_id = ?
      ORDER BY context_revision DESC
      LIMIT 1
    `).get<{ contextJson: string }>(prepared.run.runId);
    assert.ok(revision !== undefined);
    assert.deepEqual((JSON.parse(revision.contextJson) as { traceContext?: unknown }).traceContext, prepared.traceContext);
  } finally {
    database.close();
  }
});

test('fails closed when the stored trace context is not an object', async () => {
  const { root, database } = await fixture();
  try {
    const directory = orcaRunsDirectory(root);
    database.prepare(`
      INSERT INTO orcareplay_trace_context (directory, trace_run_id, digest, context_json, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'orcareplay', ?, ?)
    `).run(
      directory,
      'run_abcdef123456',
      'a'.repeat(64),
      '[1,2,3]',
      '2026-09-06T08:00:00.000Z',
      '2026-09-06T08:00:00.000Z',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orcareplay_trace_context WHERE directory = ?').get<{ count: number }>(directory)?.count, 1);
    await assert.rejects(
      () => prepare(root, database, 'trace-advisory-malformed'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
  } finally {
    database.close();
  }
});
