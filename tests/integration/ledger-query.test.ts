import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { listLedgerEvents, listLedgerRuns, readLedgerRun } from '../../src/ledger/query.js';

const now = '2026-08-20T00:00:00.000Z';
const migrations = path.resolve(import.meta.dirname, '../../migrations');

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-ledger-query-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1', workspace: 'workspace-a', protocolVersion: '1',
    client: { kind: 'generic', version: '1.0.0', sessionId: 'source-session' },
    captureProfile: 'standard',
    coverage: { run: 'complete', tool: 'best_effort', command: 'declared', file: 'unavailable', approval: 'unavailable' },
    task: { title: 'Task', query: 'Run tests', profileHints: { taskType: 'build', target: null, expected: 'pass', constraints: null } },
    metadata: { safe: true }, startedAt: now, ...overrides,
  };
}

function event(sourceEventId: string, sourceSequence: number, payload: Record<string, unknown> = {}) {
  return { sourceEventId, sourceSequence, eventType: 'tool.completed', sourceType: 'generic', actor: 'agent', outcome: 'success', occurredAt: now, payload };
}

function errorIdentity(operation: () => unknown): { code: string; message: string } {
  try {
    operation();
  } catch (error) {
    if (error instanceof KiokukoError) return { code: error.code, message: error.message };
    throw error;
  }
  assert.fail('expected operation to throw');
}

test('lists only runs belonging to the requested workspace', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput());
    store.createRun(runInput({ runId: 'run-2', workspace: 'workspace-b' }));

    const result = listLedgerRuns(database, { workspace: 'workspace-a' });

    assert.deepEqual(result.items.map((run) => run.runId), ['run-1']);
    assert.equal(result.items[0]?.workspace, 'workspace-a');
    assert.equal(result.items[0]?.client.kind, 'generic');
    assert.equal(result.items[0]?.createdAt, now);
    assert.equal(result.nextCursor, null);
  } finally {
    database.close();
  }
});

test('orders runs by newest creation time and then ascending run ID', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput({ runId: 'run-z' }));
    store.createRun(runInput({ runId: 'run-a' }));

    const result = listLedgerRuns(database, { workspace: 'workspace-a' });

    assert.deepEqual(result.items.map((run) => run.runId), ['run-a', 'run-z']);
  } finally {
    database.close();
  }
});

test('fetches one extra run to return a continuation cursor at the hard page limit', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput({ runId: 'run-c' }));
    store.createRun(runInput({ runId: 'run-b' }));
    store.createRun(runInput({ runId: 'run-a' }));

    const result = listLedgerRuns(database, { workspace: 'workspace-a', limit: 2 });

    assert.deepEqual(result.items.map((run) => run.runId), ['run-a', 'run-b']);
    assert.equal(typeof result.nextCursor, 'string');
    assert.notEqual(result.nextCursor, '');
    const cursor = JSON.parse(Buffer.from(result.nextCursor ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(cursor).sort(), ['createdAt', 'runId', 'version']);
    assert.equal(cursor.version, 1);
  } finally {
    database.close();
  }
});

test('concatenating cursor pages has no gaps or duplicates when creation timestamps tie', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    for (const runId of ['run-d', 'run-c', 'run-b', 'run-a']) store.createRun(runInput({ runId }));

    const firstPage = listLedgerRuns(database, { workspace: 'workspace-a', limit: 2 });
    const secondPage = listLedgerRuns(database, { workspace: 'workspace-a', cursor: firstPage.nextCursor ?? undefined, limit: 2 });

    assert.deepEqual([...firstPage.items, ...secondPage.items].map((run) => run.runId), ['run-a', 'run-b', 'run-c', 'run-d']);
    assert.equal(secondPage.nextCursor, null);
  } finally {
    database.close();
  }
});

test('reads a workspace-scoped run as an untrusted public view without mutating rows', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput({ metadata: { stored: 'metadata' } }));
    const beforeRuns = database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count;
    const beforeEvents = database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count;

    const result = readLedgerRun(database, { workspace: 'workspace-a', runId: 'run-1' });

    assert.equal(result.runId, 'run-1');
    assert.deepEqual(result.coverage, runInput().coverage);
    assert.equal(result.title, 'Task');
    assert.deepEqual(result.metadata, { stored: 'metadata' });
    assert.equal(result.untrusted, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, beforeRuns);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, beforeEvents);
  } finally {
    database.close();
  }
});

test('hides missing and cross-workspace runs behind the same typed not-found error', async () => {
  const database = await setup();
  try {
    new LedgerStore(database, { now: () => now }).createRun(runInput());

    const missing = errorIdentity(() => readLedgerRun(database, { workspace: 'workspace-a', runId: 'missing' }));
    const crossWorkspace = errorIdentity(() => readLedgerRun(database, { workspace: 'workspace-b', runId: 'run-1' }));

    assert.deepEqual(crossWorkspace, missing);
    assert.equal(missing.code, 'NOT_FOUND');
    assert.equal(missing.message, 'Ledger run not found');
  } finally {
    database.close();
  }
});

test('lists parsed sanitized event views only after a workspace-scoped run check', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput());
    store.appendBatch('run-1', { events: [event('source-1', 9, { normal: 'kept' })] });
    const beforeRuns = database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count;
    const beforeEvents = database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count;

    const result = listLedgerEvents(database, { workspace: 'workspace-a', runId: 'run-1' });
    const first = result.items[0];

    assert.equal(result.items.length, 1);
    assert.equal(first?.runId, 'run-1');
    assert.equal(first?.sequence, 1);
    assert.equal(first?.sourceEventId, 'source-1');
    assert.equal(first?.sourceSequence, 9);
    assert.equal(first?.eventType, 'tool.completed');
    assert.equal(first?.sourceType, 'generic');
    assert.equal(first?.actor, 'agent');
    assert.equal(first?.outcome, 'success');
    assert.equal(first?.occurredAt, now);
    assert.deepEqual(first?.payload, { normal: 'kept' });
    assert.deepEqual(first?.redaction, []);
    assert.equal(first?.previousHash.length, 64);
    assert.equal(first?.eventHash.length, 64);
    assert.equal(first?.untrusted, true);
    assert.equal(first ? Object.keys(first).some((key) => key.includes('_')) : false, false);
    assert.equal(result.nextCursor, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, beforeRuns);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, beforeEvents);
  } finally {
    database.close();
  }
});

test('paginates events by sequence and applies the canonical event-type filter', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput());
    store.appendBatch('run-1', {
      events: [
        event('source-1', 1),
        { ...event('source-2', 2), eventType: 'command.completed' },
        event('source-3', 3),
      ],
    });

    const firstPage = listLedgerEvents(database, { workspace: 'workspace-a', runId: 'run-1', limit: 2 });
    const secondPage = listLedgerEvents(database, { workspace: 'workspace-a', runId: 'run-1', after: firstPage.nextCursor ?? 0, limit: 2 });
    const filtered = listLedgerEvents(database, { workspace: 'workspace-a', runId: 'run-1', type: 'command.completed' });

    assert.deepEqual(firstPage.items.map((item) => item.sequence), [1, 2]);
    assert.equal(firstPage.nextCursor, 2);
    assert.deepEqual(secondPage.items.map((item) => item.sequence), [3]);
    assert.equal(secondPage.nextCursor, null);
    assert.deepEqual(filtered.items.map((item) => item.sequence), [2]);
    assert.equal(filtered.nextCursor, null);
  } finally {
    database.close();
  }
});

test('hides missing and cross-workspace event runs before disclosing event rows', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput());
    store.appendBatch('run-1', { events: [event('source-1', 1)] });

    const missing = errorIdentity(() => listLedgerEvents(database, { workspace: 'workspace-a', runId: 'missing' }));
    const crossWorkspace = errorIdentity(() => listLedgerEvents(database, { workspace: 'workspace-b', runId: 'run-1' }));

    assert.deepEqual(crossWorkspace, missing);
    assert.equal(missing.code, 'NOT_FOUND');
    assert.equal(missing.message, 'Ledger run not found');
  } finally {
    database.close();
  }
});

test('rejects unknown fields, invalid statuses, and every out-of-range page value without echoing input', async () => {
  const database = await setup();
  try {
    const unknownField = 'secret-extra-field';
    const unknown = errorIdentity(() => listLedgerRuns(database, { workspace: 'workspace-a', [unknownField]: 'value' }));
    assert.equal(unknown.code, 'VALIDATION_ERROR');
    assert.equal(unknown.message, 'Unknown run list input field');
    assert.equal(unknown.message.includes(unknownField), false);

    const invalidStatus = errorIdentity(() => listLedgerRuns(database, { workspace: 'workspace-a', status: "failed' OR 1=1 --" }));
    assert.equal(invalidStatus.code, 'VALIDATION_ERROR');
    assert.equal(invalidStatus.message, 'status has an invalid enum value');
    assert.equal(invalidStatus.message.includes('failed'), false);

    for (const limit of [0, -1, 1.5, 101]) {
      const invalidLimit = errorIdentity(() => listLedgerRuns(database, { workspace: 'workspace-a', limit }));
      assert.equal(invalidLimit.code, 'VALIDATION_ERROR');
      assert.equal(invalidLimit.message, 'limit must be an integer between 1 and 100');
    }

    const invalidAfter = errorIdentity(() => listLedgerEvents(database, { workspace: 'workspace-a', runId: 'run-1', after: -1 }));
    assert.equal(invalidAfter.code, 'VALIDATION_ERROR');
    assert.equal(invalidAfter.message, 'after must be a non-negative safe integer');

    const unknownEventField = errorIdentity(() => listLedgerEvents(database, { workspace: 'workspace-a', runId: 'run-1', extra: 'untrusted' }));
    assert.equal(unknownEventField.code, 'VALIDATION_ERROR');
    assert.equal(unknownEventField.message, 'Unknown event list input field');
    assert.equal(unknownEventField.message.includes('untrusted'), false);

    const invalidType = errorIdentity(() => listLedgerEvents(database, { workspace: 'workspace-a', runId: 'run-1', type: "tool.completed' OR 1=1 --" }));
    assert.equal(invalidType.code, 'VALIDATION_ERROR');
    assert.equal(invalidType.message, 'type has an invalid event type');

    for (const limit of [0, -1, 1.5, 101]) {
      const invalidEventLimit = errorIdentity(() => listLedgerEvents(database, { workspace: 'workspace-a', runId: 'run-1', limit }));
      assert.equal(invalidEventLimit.code, 'VALIDATION_ERROR');
      assert.equal(invalidEventLimit.message, 'limit must be an integer between 1 and 100');
    }
  } finally {
    database.close();
  }
});

test('rejects malformed, wrong-version, and unknown-field run cursors with fixed errors', async () => {
  const database = await setup();
  try {
    const cursorWithUnknownField = Buffer.from(JSON.stringify({ version: 1, createdAt: now, runId: 'run-1', extra: 'untrusted-cursor' }), 'utf8').toString('base64url');
    const wrongVersion = Buffer.from(JSON.stringify({ version: 99, createdAt: now, runId: 'run-1' }), 'utf8').toString('base64url');
    const invalidTuple = Buffer.from(JSON.stringify({ version: 1, createdAt: 'not-a-timestamp', runId: 'run-1' }), 'utf8').toString('base64url');

    const malformed = errorIdentity(() => listLedgerRuns(database, { workspace: 'workspace-a', cursor: 'not a cursor' }));
    const unknownField = errorIdentity(() => listLedgerRuns(database, { workspace: 'workspace-a', cursor: cursorWithUnknownField }));
    const unsupportedVersion = errorIdentity(() => listLedgerRuns(database, { workspace: 'workspace-a', cursor: wrongVersion }));
    const invalidTupleError = errorIdentity(() => listLedgerRuns(database, { workspace: 'workspace-a', cursor: invalidTuple }));

    assert.deepEqual(malformed, { code: 'VALIDATION_ERROR', message: 'Invalid run cursor' });
    assert.deepEqual(unknownField, { code: 'VALIDATION_ERROR', message: 'Invalid run cursor' });
    assert.deepEqual(unsupportedVersion, { code: 'VALIDATION_ERROR', message: 'Unsupported run cursor version' });
    assert.deepEqual(invalidTupleError, { code: 'VALIDATION_ERROR', message: 'Invalid run cursor' });
    assert.equal(unknownField.message.includes('untrusted-cursor'), false);
  } finally {
    database.close();
  }
});

test('binds client and status filters as values, including punctuation and SQL-like text', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput());
    store.createRun(runInput({ runId: 'run-2', client: { kind: 'other-client' } }));
    store.updateRunStatus('run-2', 'completed', now);
    const beforeRuns = database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count;
    const beforeEvents = database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count;

    const filtered = listLedgerRuns(database, { workspace: 'workspace-a', client: 'generic', status: 'intake' });
    const completed = listLedgerRuns(database, { workspace: 'workspace-a', status: 'completed' });
    const injectionLike = listLedgerRuns(database, { workspace: 'workspace-a', client: "generic' OR 1=1 --" });

    assert.deepEqual(filtered.items.map((run) => run.runId), ['run-1']);
    assert.deepEqual(completed.items.map((run) => run.runId), ['run-2']);
    assert.deepEqual(injectionLike.items, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, beforeRuns);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, beforeEvents);
  } finally {
    database.close();
  }
});

test('turns corrupt persisted JSON into a fixed integrity error without leaking stored content', async () => {
  const runDatabase = await setup();
  try {
    new LedgerStore(runDatabase, { now: () => now }).createRun(runInput());
    const corruptRunContent = '{invalid-run-json-secret}';
    runDatabase.prepare('UPDATE ledger_runs SET metadata_json = ? WHERE run_id = ?').run(corruptRunContent, 'run-1');

    const error = errorIdentity(() => readLedgerRun(runDatabase, { workspace: 'workspace-a', runId: 'run-1' }));

    assert.deepEqual(error, { code: 'INTEGRITY_ERROR', message: 'Stored ledger JSON is invalid' });
    assert.equal(error.message.includes(corruptRunContent), false);
  } finally {
    runDatabase.close();
  }

  const eventDatabase = await setup();
  try {
    const store = new LedgerStore(eventDatabase, { now: () => now });
    store.createRun(runInput());
    store.appendBatch('run-1', { events: [event('source-1', 1)] });
    const corruptEventContent = '{invalid-event-json-secret}';
    eventDatabase.prepare('UPDATE ledger_events SET payload_json = ? WHERE event_id = (SELECT event_id FROM ledger_events LIMIT 1)').run(corruptEventContent);

    const error = errorIdentity(() => listLedgerEvents(eventDatabase, { workspace: 'workspace-a', runId: 'run-1' }));

    assert.deepEqual(error, { code: 'INTEGRITY_ERROR', message: 'Stored ledger JSON is invalid' });
    assert.equal(error.message.includes(corruptEventContent), false);
  } finally {
    eventDatabase.close();
  }
});
