import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import {
  ORCA_TRACE_MAX_WARNINGS,
  readOrcaTraceManifest,
  readOrcaTraceRun,
} from '../../src/trace/orca-trace.js';

const RUN_ID = 'run_abcdef123456';

function eventLine(seq: number, overrides: Record<string, unknown> = {}): string {
  const event = {
    seq,
    ts: '2026-09-06T08:00:00.000Z',
    mono_us: seq * 1000,
    turn: 0,
    type: 'note',
    actor: 'host',
    payload: { text: `event ${seq}` },
    ...overrides,
  };
  return JSON.stringify(event);
}

async function makeRun(
  base: string,
  options: {
    runId?: string;
    schemaVersion?: string;
    lines?: string[];
    counts?: number;
    eventsSha256?: string;
  } = {},
): Promise<string> {
  const runId = options.runId ?? RUN_ID;
  const runDir = path.join(base, runId);
  await mkdir(path.join(runDir, 'blobs'), { recursive: true });
  const lines = options.lines ?? [eventLine(1), eventLine(2)];
  const eventsText = `${lines.join('\n')}\n`;
  const eventsSha256 = options.eventsSha256 ?? createHash('sha256').update(eventsText).digest('hex');
  const manifest = {
    schema_version: options.schemaVersion ?? '0.1.0',
    run_id: runId,
    counts: { events: options.counts ?? lines.length },
    integrity: { events_sha256: eventsSha256 },
  };
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(runDir, 'events.jsonl'), eventsText);
  return runDir;
}

test('reads a valid run with verified integrity and manifest view', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const lines = [eventLine(1), eventLine(2, { turn: 1, type: 'tool.call', actor: 'agent' })];
    const runDir = await makeRun(base, { lines, counts: 2 });
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.status, 'ready');
    assert.equal(read.integrity, 'verified');
    assert.equal(read.manifest?.schemaVersion, '0.1.0');
    assert.equal(read.manifest?.runId, RUN_ID);
    assert.equal(read.manifest?.countsEvents, 2);
    assert.match(read.manifest?.eventsSha256 ?? '', /^[0-9a-f]{64}$/u);
    assert.equal(read.events.length, 2);
    assert.equal(read.maxSeq, 2);
    assert.equal(read.warnings.length, 0);
    assert.equal(read.events[0]?.seq, 1);
    assert.equal(read.events[1]?.type, 'tool.call');
    assert.equal(read.events[1]?.actor, 'agent');
    assert.equal((read.events[1]?.payload as { text: string }).text, 'event 2');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('reports missing_manifest and invalid_manifest', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    await mkdir(path.join(base, RUN_ID, 'blobs'), { recursive: true });
    await writeFile(path.join(base, RUN_ID, 'events.jsonl'), '');
    const missing = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(missing.status, 'missing_manifest');
    assert.equal(missing.integrity, 'unavailable');
    assert.equal(missing.events.length, 0);

    await writeFile(path.join(base, RUN_ID, 'manifest.json'), '{not json');
    const invalid = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(invalid.status, 'invalid_manifest');

    await writeFile(path.join(base, RUN_ID, 'manifest.json'), JSON.stringify({
      schema_version: '0.1.0',
      run_id: 'run_ffffffffffff',
      counts: { events: 1 },
      integrity: { events_sha256: '0'.repeat(64) },
    }));
    const mismatch = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(mismatch.status, 'invalid_manifest');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('reports unsupported_schema for an unknown schema version', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    await makeRun(base, { schemaVersion: '1.0.0' });
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.status, 'unsupported_schema');
    assert.equal(read.integrity, 'unavailable');
    assert.equal(read.events.length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects invalid runs directory and run id at the boundary', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    await assert.rejects(
      () => readOrcaTraceManifest('relative/path', RUN_ID),
      (error: unknown) => (error as KiokukoError).code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      () => readOrcaTraceManifest(base, 'not-a-run-id'),
      (error: unknown) => (error as KiokukoError).code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      () => readOrcaTraceManifest(`${'a'.repeat(4097)}`, RUN_ID),
      (error: unknown) => (error as KiokukoError).code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      () => readOrcaTraceRun('relative/path', RUN_ID),
      (error: unknown) => (error as KiokukoError).code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      () => readOrcaTraceRun(base, 'run_../escape'),
      (error: unknown) => (error as KiokukoError).code === 'VALIDATION_ERROR',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('skips malformed lines and keeps valid events with warnings', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const lines = [
      eventLine(1),
      '',
      '{not json',
      '[1,2,3]',
      eventLine(2, { type: 'mystery.thing' }),
    ];
    const eventsText = `${lines.join('\n')}\n`;
    await makeRun(base, {
      lines,
      eventsSha256: createHash('sha256').update(eventsText).digest('hex'),
    });
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.events.length, 2);
    assert.equal(read.maxSeq, 2);
    const codes = read.warnings.map((warning) => warning.code);
    assert.equal(codes.filter((code) => code === 'invalid_event').length, 3);
    assert.equal(codes.filter((code) => code === 'unknown_event_type').length, 1);
    assert.equal(read.events[1]?.unknownType, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('warns on duplicate and out-of-order seq without regressing maxSeq', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const lines = [
      eventLine(1),
      eventLine(1),
      eventLine(2),
      eventLine(0),
      eventLine(3),
    ];
    const eventsText = `${lines.join('\n')}\n`;
    await makeRun(base, {
      lines,
      eventsSha256: createHash('sha256').update(eventsText).digest('hex'),
    });
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.events.map((event) => event.seq).join(','), '1,2,3');
    assert.equal(read.maxSeq, 3);
    assert.equal(read.warnings.filter((warning) => warning.code === 'invalid_event').length, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('warns on seq gaps but still ingests', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const lines = [eventLine(1), eventLine(4)];
    const eventsText = `${lines.join('\n')}\n`;
    await makeRun(base, {
      lines,
      eventsSha256: createHash('sha256').update(eventsText).digest('hex'),
    });
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.events.length, 2);
    assert.equal(read.maxSeq, 4);
    assert.deepEqual(read.warnings, [{ code: 'seq_gap' }]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects invalid envelope fields', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const lines = [
      JSON.stringify({ seq: 1, ts: 'not-a-date', mono_us: 1, turn: 0, type: 'note', actor: 'host' }),
      JSON.stringify({ seq: 2, ts: '2026-09-06T08:00:00.000Z', mono_us: -1, turn: 0, type: 'note', actor: 'host' }),
      JSON.stringify({ seq: 3, ts: '2026-09-06T08:00:00.000Z', mono_us: 3, turn: -1, type: 'note', actor: 'host' }),
      JSON.stringify({ seq: 4, ts: '2026-09-06T08:00:00.000Z', mono_us: 4, turn: 0, type: '', actor: 'host' }),
      JSON.stringify({ seq: 5, ts: '2026-09-06T08:00:00.000Z', mono_us: 5, turn: 0, type: 'note', actor: '' }),
      eventLine(6),
    ];
    const eventsText = `${lines.join('\n')}\n`;
    await makeRun(base, {
      lines,
      eventsSha256: createHash('sha256').update(eventsText).digest('hex'),
    });
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.events.length, 1);
    assert.equal(read.maxSeq, 6);
    assert.equal(read.warnings.filter((warning) => warning.code === 'invalid_event').length, 5);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects invalid causes, attrs, and redacted', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const lines = [
      JSON.stringify({ seq: 1, ts: '2026-09-06T08:00:00.000Z', mono_us: 1, turn: 0, type: 'note', actor: 'host', causes: [2] }),
      JSON.stringify({ seq: 2, ts: '2026-09-06T08:00:00.000Z', mono_us: 2, turn: 0, type: 'note', actor: 'host', causes: [-1] }),
      JSON.stringify({ seq: 3, ts: '2026-09-06T08:00:00.000Z', mono_us: 3, turn: 0, type: 'note', actor: 'host', attrs: [1, 2] }),
      JSON.stringify({ seq: 4, ts: '2026-09-06T08:00:00.000Z', mono_us: 4, turn: 0, type: 'note', actor: 'host', redacted: ['ok', 5] }),
      eventLine(5, { causes: [1], attrs: { key: 'value' }, redacted: ['secret-key'] }),
    ];
    const eventsText = `${lines.join('\n')}\n`;
    await makeRun(base, {
      lines,
      eventsSha256: createHash('sha256').update(eventsText).digest('hex'),
    });
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.events.length, 1);
    assert.equal(read.events[0]?.causes?.join(','), '1');
    assert.deepEqual(read.events[0]?.attrs, { key: 'value' });
    assert.deepEqual(read.events[0]?.redacted, ['secret-key']);
    assert.equal(read.warnings.filter((warning) => warning.code === 'invalid_event').length, 4);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('returns descriptors without opening small or large blobs', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const runDir = path.join(base, RUN_ID);
    await mkdir(path.join(runDir, 'blobs'), { recursive: true });
    const inlineText = JSON.stringify({ hello: 'world' });
    const inlineHex = createHash('sha256').update(inlineText).digest('hex');
    await mkdir(path.join(runDir, 'blobs', inlineHex.slice(0, 2)), { recursive: true });
    await writeFile(path.join(runDir, 'blobs', inlineHex.slice(0, 2), inlineHex), inlineText);

    const largeText = `{"padding":"${'x'.repeat(5000)}"}`;
    const largeHex = createHash('sha256').update(largeText).digest('hex');
    await mkdir(path.join(runDir, 'blobs', largeHex.slice(0, 2)), { recursive: true });
    await writeFile(path.join(runDir, 'blobs', largeHex.slice(0, 2), largeHex), largeText);

    const lines = [
      JSON.stringify({ seq: 1, ts: '2026-09-06T08:00:00.000Z', mono_us: 1, turn: 0, type: 'note', actor: 'host', payload: { $blob: `sha256:${inlineHex}`, bytes:Buffer.byteLength(inlineText) } }),
      JSON.stringify({ seq: 2, ts: '2026-09-06T08:00:00.000Z', mono_us: 2, turn: 0, type: 'note', actor: 'host', payload: { $blob: `sha256:${largeHex}`, bytes: largeText.length, media_type: 'application/json' } }),
    ];
    const eventsText = `${lines.join('\n')}\n`;
    await writeFile(path.join(runDir, 'events.jsonl'), eventsText);
    await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: '0.1.0',
      run_id: RUN_ID,
      counts: { events: 2 },
      integrity: { events_sha256: createHash('sha256').update(eventsText).digest('hex') },
    }));

    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.warnings.length, 0);
    assert.deepEqual(read.events[0]?.payload, { blobDigest:inlineHex,bytes:Buffer.byteLength(inlineText) });
    const descriptor = read.events[1]?.payload as { blobDigest: string; bytes: number; mediaType: string };
    assert.equal(descriptor.blobDigest, largeHex);
    assert.equal(descriptor.bytes, largeText.length);
    assert.equal(descriptor.mediaType, 'application/json');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('reports blob_unresolved for missing, mismatched, malformed, and invalid blobs', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const runDir = path.join(base, RUN_ID);
    await mkdir(path.join(runDir, 'blobs'), { recursive: true });
    const missingHex = 'ab'.repeat(32);
    const mismatchHex = 'cd'.repeat(32);
    await mkdir(path.join(runDir, 'blobs', 'cd'), { recursive: true });
    await writeFile(path.join(runDir, 'blobs', 'cd', mismatchHex), 'wrong content');

    const lines = [
      JSON.stringify({ seq: 1, ts: '2026-09-06T08:00:00.000Z', mono_us: 1, turn: 0, type: 'note', actor: 'host', payload: { $blob: `sha256:${missingHex}` } }),
      JSON.stringify({ seq: 2, ts: '2026-09-06T08:00:00.000Z', mono_us: 2, turn: 0, type: 'note', actor: 'host', payload: { $blob: `sha256:${mismatchHex}` } }),
      JSON.stringify({ seq: 3, ts: '2026-09-06T08:00:00.000Z', mono_us: 3, turn: 0, type: 'note', actor: 'host', payload: { $blob: 'sha256:xyz' } }),
      JSON.stringify({ seq: 4, ts: '2026-09-06T08:00:00.000Z', mono_us: 4, turn: 0, type: 'note', actor: 'host', payload: { $blob: `sha256:${missingHex}`, bytes: 0 } }),
      eventLine(5),
    ];
    const eventsText = `${lines.join('\n')}\n`;
    await writeFile(path.join(runDir, 'events.jsonl'), eventsText);
    await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: '0.1.0',
      run_id: RUN_ID,
      counts: { events: 5 },
      integrity: { events_sha256: createHash('sha256').update(eventsText).digest('hex') },
    }));

    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.events.length, 5);
    assert.equal(read.maxSeq, 5);
    const blobWarnings = read.warnings.filter((warning) => warning.code === 'blob_unresolved');
    assert.equal(blobWarnings.length, 4);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('reports truncated_final_line for an incomplete final line', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const eventsText = `${eventLine(1)}\n{"seq":2,"ts":"2026-09-06T08:00:00.000Z","mono_us":2,"turn":0,"type":"note","actor":"host","payload":`;
    await makeRun(base, {
      lines: [eventLine(1)],
      eventsSha256: createHash('sha256').update(eventsText).digest('hex'),
    });
    await writeFile(path.join(base, RUN_ID, 'events.jsonl'), eventsText);
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.events.length, 1);
    assert.equal(read.maxSeq, 1);
    assert.deepEqual(read.warnings, [{ code: 'truncated_final_line' }]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('defers a valid final line without final manifest evidence', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const eventsText = `${eventLine(1)}\n${eventLine(2)}`;
    await makeRun(base, {
      lines: [eventLine(1)],
      eventsSha256: createHash('sha256').update(eventsText).digest('hex'),
    });
    await writeFile(path.join(base, RUN_ID, 'events.jsonl'), eventsText);
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.events.length, 1);
    assert.equal(read.maxSeq, 1);
    assert.equal(read.warnings.length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects an oversized unterminated line instead of rereading a bounded file prefix', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const runDir = path.join(base, RUN_ID);
    await mkdir(path.join(runDir, 'blobs'), { recursive: true });
    const handle = await open(path.join(runDir, 'events.jsonl'), 'w');
    await handle.write(`${eventLine(1)}\n`);
    await handle.truncate(80 * 1024 * 1024);
    await handle.close();
    await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: '0.1.0',
      run_id: RUN_ID,
      counts: { events: 1 },
      integrity: { events_sha256: '0'.repeat(64) },
    }));
    await assert.rejects(()=>readOrcaTraceRun(base,RUN_ID), (error:unknown)=>(error as {code:string}).code==='event_line_too_large');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('caps warnings at the configured maximum', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    const lines = Array.from({ length: ORCA_TRACE_MAX_WARNINGS + 8 }, (_, index) => `{not json ${index}`);
    lines.push(eventLine(1));
    const eventsText = `${lines.join('\n')}\n`;
    await makeRun(base, {
      lines,
      eventsSha256: createHash('sha256').update(eventsText).digest('hex'),
    });
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.warnings.length, ORCA_TRACE_MAX_WARNINGS);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('never writes into the trace directory during a read', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    await makeRun(base, {});
    const before = (await readdir(path.join(base, RUN_ID))).sort();
    const read = await readOrcaTraceRun(base, RUN_ID);
    assert.equal(read.status, 'ready');
    const after = (await readdir(path.join(base, RUN_ID))).sort();
    assert.deepEqual(after, before);
    const blobDir = path.join(base, RUN_ID, 'blobs');
    assert.equal((await readdir(blobDir)).length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('exposes counts and integrity from the manifest view', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-orca-'));
  try {
    await makeRun(base, { counts: 3 });
    const read = await readOrcaTraceManifest(base, RUN_ID);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.manifest.countsEvents, 3);
      assert.match(read.manifest.eventsSha256 ?? '', /^[0-9a-f]{64}$/u);
      assert.equal(read.manifest.schemaVersion, '0.1.0');
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
