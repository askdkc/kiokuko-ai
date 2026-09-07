import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { upsertTraceCursor } from '../../src/trace/ingest.js';
import {
  ORCA_TRACE_SCAN_MAX_RUNS,
  orcaRunsDirectory,
  scanOrcaTraceStore,
} from '../../src/trace/scan.js';

function eventLine(seq: number): string {
  return JSON.stringify({
    seq,
    ts: '2026-09-06T08:00:00.000Z',
    mono_us: seq * 1000,
    turn: 0,
    type: seq === 0 ? 'run.start' : 'note',
    actor: 'host',
    attrs: { rule: 'scan' },
  });
}

async function makeRun(runsDirectory: string, runId: string, sequences: readonly number[], schemaVersion = '0.1.0'): Promise<string> {
  const runDirectory = path.join(runsDirectory, runId);
  await mkdir(runDirectory, { recursive: true });
  const events = `${sequences.map((seq) => eventLine(seq)).join('\n')}\n`;
  await writeFile(path.join(runDirectory, 'events.jsonl'), events);
  await writeFile(path.join(runDirectory, 'manifest.json'), JSON.stringify({
    schema_version: schemaVersion,
    run_id: runId,
    counts: { events: sequences.length },
  }));
  return runDirectory;
}

async function database(): Promise<SqliteDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-scan-db-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  return database;
}

function jobPayloads(database: SqliteDatabase): Array<{ traceRunId: string; fromSeq: number }> {
  const rows = database.prepare(`
    SELECT payload_json AS payload
    FROM orchestration_jobs
    WHERE kind = 'trace_ingestion'
    ORDER BY created_at, job_id
  `).all<{ payload: string }>();
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as { traceRunId: string; fromSeq: number };
    return { traceRunId: payload.traceRunId, fromSeq: payload.fromSeq };
  });
}

test('treats a missing store and an empty run as a no-op', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-scan-project-'));
  const databaseConnection = await database();
  try {
    assert.deepEqual(await scanOrcaTraceStore(databaseConnection, orcaRunsDirectory(projectRoot)), {
      runsDirectory: orcaRunsDirectory(projectRoot),
      scanned: 0,
      enqueued: 0,
      skippedUnsupported: 0, storesVisited:1,discovered:0,scanComplete:true,hasMore:false,warningCodes:[],
    });

    const runsDirectory = orcaRunsDirectory(projectRoot);
    await mkdir(runsDirectory, { recursive: true });
    await makeRun(runsDirectory, 'run_aaaaaa', []);
    const outcome = await scanOrcaTraceStore(databaseConnection, runsDirectory);
    assert.equal(outcome.scanned, 1);
    assert.equal(outcome.enqueued, 1);
  } finally {
    databaseConnection.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('bounds the number of runs probed and enqueued', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-scan-project-'));
  const runsDirectory = path.join(root, '.orca', 'runs');
  const databaseConnection = await database();
  try {
    await mkdir(runsDirectory, { recursive: true });
    for (let index = 0; index < ORCA_TRACE_SCAN_MAX_RUNS + 3; index += 1) {
      await makeRun(runsDirectory, `run_${index.toString(16).padStart(6, '0')}`, [0]);
    }
    const outcome = await scanOrcaTraceStore(databaseConnection, runsDirectory, { maxRuns: 3 });
    assert.equal(outcome.scanned, 3);
    assert.equal(outcome.enqueued, 3);
    assert.equal(jobPayloads(databaseConnection).length, 3);
  } finally {
    databaseConnection.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deduplicates an identical scan before ingestion advances its cursor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-scan-project-'));
  const runsDirectory = path.join(root, '.orca', 'runs');
  const databaseConnection = await database();
  try {
    await mkdir(runsDirectory, { recursive: true });
    await makeRun(runsDirectory, 'run_aaaaaa', [0]);
    const first = await scanOrcaTraceStore(databaseConnection, runsDirectory, { now: '2026-09-06T08:00:00.000Z' });
    const second = await scanOrcaTraceStore(databaseConnection, runsDirectory, { now: '2026-09-06T08:00:01.000Z' });
    assert.equal(first.enqueued, 1);
    assert.equal(second.enqueued, 0);
    assert.equal(jobPayloads(databaseConnection).length, 1);
  } finally {
    databaseConnection.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('marks unsupported schemas and detects non-zero or gapped sequence lag', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-scan-project-'));
  const runsDirectory = path.join(root, '.orca', 'runs');
  const databaseConnection = await database();
  try {
    await mkdir(runsDirectory, { recursive: true });
    await makeRun(runsDirectory, 'run_aaaaaa', [5]);
    await makeRun(runsDirectory, 'run_bbbbbb', [5, 7]);
    await makeRun(runsDirectory, 'run_cccccc', [0], '1.0.0');
    upsertTraceCursor(databaseConnection, {
      runsDirectory,
      traceRunId: 'run_bbbbbb',
      lastSeq: 5,
      state: 'active',
      now: '2026-09-06T08:00:00.000Z',
    });
    const outcome = await scanOrcaTraceStore(databaseConnection, runsDirectory, { now: '2026-09-06T08:00:01.000Z' });
    assert.equal(outcome.scanned, 3);
    assert.equal(outcome.enqueued, 2);
    assert.equal(outcome.skippedUnsupported, 1);
    assert.deepEqual(jobPayloads(databaseConnection).sort((left, right) => left.traceRunId.localeCompare(right.traceRunId)), [
      { traceRunId: 'run_aaaaaa', fromSeq: 0 },
      { traceRunId: 'run_bbbbbb', fromSeq: 6 },
    ]);
  } finally {
    databaseConnection.close();
    await rm(root, { recursive: true, force: true });
  }
});
