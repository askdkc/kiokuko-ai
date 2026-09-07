import {applyTraceEvents,buildTraceContext} from '../../src/trace/aggregate.js';
import {registerTraceStore} from '../../src/trace/store-location.js';
import {upsertTraceCursor} from '../../src/trace/ingest.js';
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

function storedContext(root:string):JsonObject {
 return buildTraceContext('run_abcdef123456','0.1.0',4,'verified',applyTraceEvents(undefined,[]),
 {readerPolicyVersion:2,generation:1,finalization:'finalized',sourceDigest:'a'.repeat(64),captureCwd:root,traceCreatedAt:'2026-09-07T00:00:00Z',derived:false}).context;
}

function insertStoredContext(database: SqliteDatabase, root: string, context: JsonObject, digest = canonicalContentHash(context)): void {
  const directory = orcaRunsDirectory(root);
  registerTraceStore(database,{repositoryRoot:root,captureCwd:root,runsDirectory:directory});
  database.prepare("UPDATE orcareplay_trace_stores SET state='present'").run();
  upsertTraceCursor(database,{runsDirectory:directory,traceRunId:'run_abcdef123456',lastSeq:4,state:'active',now:'2026-09-07T00:00:00Z'});
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
  database.prepare("UPDATE orcareplay_trace_context SET reader_policy_version=2,finalization='finalized'").run();
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
    const context = storedContext(root);
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

test('isolates malformed trace context while continuing task preparation', async () => {
  const { root, database } = await fixture();
  try {
    insertStoredContext(database,root,storedContext(root));
    database.prepare("UPDATE orcareplay_trace_context SET context_json='[1,2,3]'").run();
    const prepared=await prepare(root,database,'trace-advisory-malformed');
    assert.equal(prepared.traceContext,undefined);
    assert.ok(prepared.warnings.some(x=>x.code==='TRACE_CONTEXT_REJECTED'));
  } finally {
    database.close();
  }
});
