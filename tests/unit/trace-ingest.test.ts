import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import {
  ORCA_TRACE_CONTEXT_MAX_BYTES,
  ingestTraceRun,
  readStoredTraceContext,
  readTraceCursor,
  requireTraceRunId,
  upsertTraceCursor,
} from '../../src/trace/ingest.js';

const RUN_ID = 'run_abcdef123456';
const RUNS_DIRECTORY = '/tmp/orca-replay';

function eventLine(seq: number, type: string, attrs: Record<string, unknown> = {}): string {
  return JSON.stringify({
    seq,
    ts: '2026-09-06T08:00:00.000Z',
    mono_us: seq * 1000,
    turn: 0,
    type,
    actor: 'host',
    attrs,
  });
}

function completedRunLines(): string[] {
  return [
    eventLine(1, 'run.start'),
    eventLine(2, 'note', { rule: 'demo', detail: 'hello world' }),
    eventLine(3, 'tool.call', { name: 'bash' }),
    eventLine(4, 'error', { kind: 'compile', suite: 'unit' }),
    eventLine(5, 'fs.change', { path: 'src/x.ts', status: 'modified' }),
    eventLine(6, 'shell.result', { exit_code: 1 }),
    eventLine(7, 'run.end', { exit_code: 0 }),
  ];
}

async function makeRun(
  base: string,
  options: { schemaVersion?: string; lines?: string[] } = {},
): Promise<string> {
  const runDir = path.join(base, RUN_ID);
  await mkdir(path.join(runDir, 'blobs'), { recursive: true });
  const eventsText = `${(options.lines ?? completedRunLines()).join('\n')}\n`;
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
    schema_version: options.schemaVersion ?? '0.1.0',
    run_id: RUN_ID,
    counts: { events: (options.lines ?? completedRunLines()).length },
    integrity: { events_sha256: createHash('sha256').update(eventsText).digest('hex') },
  }));
  await writeFile(path.join(runDir, 'events.jsonl'), eventsText);
  return runDir;
}

async function database(): Promise<ReturnType<typeof openConnection>> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-ingest-'));
  const db = openConnection(path.join(directory, 'db.sqlite3'));
  migrateDatabase(db);
  return db;
}

test('validates runs directory, trace run id, and cursor origin at the boundary', async () => {
  const db = await database();
  try {
    await assert.rejects(
      () => ingestTraceRun(db, { runsDirectory: 'relative', traceRunId: RUN_ID, fromSeq: 0 }),
      (error: unknown) => (error as KiokukoError).code === 'INTEGRITY_ERROR',
    );
    await assert.rejects(
      () => ingestTraceRun(db, { runsDirectory: RUNS_DIRECTORY, traceRunId: 'bad-id', fromSeq: 0 }),
      (error: unknown) => (error as KiokukoError).code === 'INTEGRITY_ERROR',
    );
    await assert.rejects(
      () => ingestTraceRun(db, { runsDirectory: RUNS_DIRECTORY, traceRunId: RUN_ID, fromSeq: -1 }),
      (error: unknown) => (error as KiokukoError).code === 'INTEGRITY_ERROR',
    );
    assert.throws(
      () => requireTraceRunId('run_../escape'),
      (error: unknown) => (error as KiokukoError).code === 'INTEGRITY_ERROR',
    );
  } finally {
    db.close();
  }
});

test('marks unsupported schema runs with an unsupported cursor', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-ingest-'));
  const db = await database();
  try {
    await makeRun(base, { schemaVersion: '1.0.0' });
    const outcome = await ingestTraceRun(db, { runsDirectory: base, traceRunId: RUN_ID, fromSeq: 0 });
    assert.equal(outcome.ingested, false);
    assert.equal(outcome.reason, 'unsupported_schema');
    assert.equal(outcome.cursorSeq, -1);
    const cursor = readTraceCursor(db, base, RUN_ID);
    assert.equal(cursor?.state, 'unsupported');
    assert.equal(cursor?.lastSeq, -1);
  } finally {
    db.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('uses persisted byte progress even when a caller supplies an obsolete seq', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-ingest-'));
  const db = await database();
  try {
    await makeRun(base, {});
    const outcome = await ingestTraceRun(db, { runsDirectory: base, traceRunId: RUN_ID, fromSeq: 10 });
    assert.equal(outcome.ingested, true);
    assert.equal(outcome.reason, null);
    assert.equal(outcome.throughSeq, 7);
    assert.equal(outcome.cursorSeq, 7);
  } finally {
    db.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('ingests a ready run exactly once and advances the cursor', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-ingest-'));
  const db = await database();
  try {
    await makeRun(base, {});
    const fetchImpl = async (): Promise<never> => { throw new Error('offline'); };
    const first = await ingestTraceRun(db, { runsDirectory: base, traceRunId: RUN_ID, fromSeq: 0, fetchImpl });
    assert.equal(first.ingested, true);
    assert.equal(first.reason, null);
    assert.equal(first.throughSeq, 7);
    assert.equal(first.cursorSeq, 7);
    assert.equal(first.integrity, 'verified');
    assert.match(first.contextDigest ?? '', /^[0-9a-f]{64}$/u);
    assert.equal(first.memoryCandidates, 3);
    assert.equal(first.skillCandidates, 0);

    const stored = readStoredTraceContext(db, base, RUN_ID);
    assert.ok(stored !== undefined);
    assert.equal(stored.context.source, 'orcareplay');
    assert.equal((stored.context.summary as { events: number }).events, 7);
    assert.equal((stored.context.summary as { runEnded: boolean }).runEnded, true);

    const cursor = readTraceCursor(db, base, RUN_ID);
    assert.equal(cursor?.state, 'active');
    assert.equal(cursor?.lastSeq, 7);

    const second = await ingestTraceRun(db, { runsDirectory: base, traceRunId: RUN_ID, fromSeq: 0, fetchImpl });
    assert.equal(second.ingested, false);
    assert.equal(second.reason, 'already_ingested');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orcareplay_trace_context").get<{ count: number }>()?.count, 1);
  } finally {
    db.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects secret-shaped trace context and persists nothing', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-ingest-'));
  const db = await database();
  try {
    const lines = [
      eventLine(1, 'run.start'),
      eventLine(2, 'note', { rule: 'demo', detail: 'api_key = super-secret-value-12345' }),
      eventLine(3, 'run.end', { exit_code: 0 }),
    ];
    await makeRun(base, { lines });
    await assert.rejects(
      () => ingestTraceRun(db, { runsDirectory: base, traceRunId: RUN_ID, fromSeq: 0 }),
      (error: unknown) => (error as KiokukoError).code === 'SECURITY_REJECTION',
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orcareplay_trace_context").get<{ count: number }>()?.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orcareplay_trace_cursors").get<{ count: number }>()?.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orchestration_jobs WHERE kind = 'memory_promotion'").get<{ count: number }>()?.count, 0);
  } finally {
    db.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('bounds the stored context to the configured maximum', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-ingest-'));
  const db = await database();
  try {
    const lines = [eventLine(1, 'run.start')];
    for (let index = 0; index < 40; index += 1) {
      lines.push(eventLine(2 + index, 'note', { rule: `rule-${index}`, detail: 'x'.repeat(200) }));
    }
    lines.push(eventLine(42, 'run.end', { exit_code: 0 }));
    await makeRun(base, { lines });
    const outcome = await ingestTraceRun(db, { runsDirectory: base, traceRunId: RUN_ID, fromSeq: 0 });
    assert.equal(outcome.ingested, true);
    const stored = readStoredTraceContext(db, base, RUN_ID);
    assert.ok(stored !== undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(stored.context), 'utf8') <= ORCA_TRACE_CONTEXT_MAX_BYTES);
    const notes = (stored.context.summary as { notes: unknown[] }).notes;
    assert.ok(notes.length < 40);
  } finally {
    db.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('gates skill search and memory promotion on runEnded', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-ingest-'));
  const db = await database();
  try {
    let fetchCalls = 0;
    const fetchImpl = async (): Promise<never> => { fetchCalls += 1; throw new Error('offline'); };
    await makeRun(base, { lines: [eventLine(1, 'run.start'), eventLine(2, 'note', { rule: 'demo' })] });
    const outcome = await ingestTraceRun(db, { runsDirectory: base, traceRunId: RUN_ID, fromSeq: 0, fetchImpl });
    assert.equal(outcome.ingested, true);
    assert.equal(outcome.skillCandidates, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orchestration_jobs WHERE kind = 'memory_promotion'").get<{ count: number }>()?.count, 0);
  } finally {
    db.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('enqueues memory promotion only when the run ended with candidates', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-ingest-'));
  const db = await database();
  try {
    await makeRun(base, {});
    const outcome = await ingestTraceRun(db, { runsDirectory: base, traceRunId: RUN_ID, fromSeq: 0 });
    assert.equal(outcome.ingested, true);
    assert.equal(outcome.memoryCandidates, 3);
    const jobs = db.prepare("SELECT payload_json AS payload FROM orchestration_jobs WHERE kind = 'memory_promotion'").all<{ payload: string }>();
    assert.equal(jobs.length, 1);
    const payload = JSON.parse(jobs[0]!.payload) as { source: string; candidates: unknown[] };
    assert.equal(payload.source, 'orcareplay');
    assert.equal(payload.candidates.length, 3);
  } finally {
    db.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('cursor upsert and read round-trip validate their inputs', async () => {
  const db = await database();
  try {
    upsertTraceCursor(db, { runsDirectory: RUNS_DIRECTORY, traceRunId: RUN_ID, lastSeq: 3, state: 'active', now: '2026-09-06T08:00:00.000Z' });
    const cursor = readTraceCursor(db, RUNS_DIRECTORY, RUN_ID);
    assert.equal(cursor?.lastSeq, 3);
    assert.equal(cursor?.state, 'active');
    assert.throws(
      () => upsertTraceCursor(db, { runsDirectory: RUNS_DIRECTORY, traceRunId: RUN_ID, lastSeq: -2, state: 'active', now: '2026-09-06T08:00:00.000Z' }),
      (error: unknown) => (error as KiokukoError).code === 'VALIDATION_ERROR',
    );
    assert.equal(readTraceCursor(db, RUNS_DIRECTORY, 'run_ffffff123456'), undefined);
  } finally {
    db.close();
  }
});

test('rejects an invalid stored context with an integrity error', async () => {
  const db = await database();
  try {
    db.prepare(`
      INSERT INTO orcareplay_trace_context (directory, trace_run_id, digest, context_json, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'orcareplay', ?, ?)
    `).run(RUNS_DIRECTORY, RUN_ID, 'a'.repeat(64), '[1,2,3]', '2026-09-06T08:00:00.000Z', '2026-09-06T08:00:00.000Z');
    assert.throws(
      () => readStoredTraceContext(db, RUNS_DIRECTORY, RUN_ID),
      (error: unknown) => (error as KiokukoError).code === 'INTEGRITY_ERROR',
    );
  } finally {
    db.close();
  }
});
