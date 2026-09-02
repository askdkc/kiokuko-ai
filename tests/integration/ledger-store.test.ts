import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { GENESIS_HASH } from '../../src/ledger/hash.js';
import { MAX_EVENT_PAYLOAD_BYTES } from '../../src/ledger/types.js';

const now = '2026-08-20T00:00:00.000Z';
const migrations = path.resolve(import.meta.dirname, '../../migrations');

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-ledger-store-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1', workspace: '/tmp/workspace', protocolVersion: '1',
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

test('creates a run with immutable coverage and appends a contiguous hash chain', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { home: '/home/tester' });
    const created = store.createRun(runInput());
    assert.deepEqual(created.coverage, runInput().coverage);
    assert.deepEqual(store.readRun('run-1')?.coverage, runInput().coverage);

    const ack = store.appendBatch('run-1', { events: [event('source-1', 100), event('source-2', 7, { value: 'second' })] });
    assert.equal(ack.acceptedThrough, 2);
    assert.deepEqual(ack.localSequences, [1, 2]);
    assert.deepEqual(ack.sourceSequences, [100, 7]);

    const rows = database.prepare('SELECT sequence, source_sequence, previous_hash, event_hash, payload_json FROM ledger_events WHERE run_id = ? ORDER BY sequence').all<{ sequence: number; source_sequence: number; previous_hash: string; event_hash: string; payload_json: string }>('run-1');
    assert.deepEqual(rows.map((row) => row.sequence), [1, 2]);
    assert.deepEqual(rows.map((row) => row.source_sequence), [100, 7]);
    assert.equal(rows[0]?.previous_hash, GENESIS_HASH);
    assert.equal(rows[1]?.previous_hash, rows[0]?.event_hash);
    assert.equal(JSON.parse(rows[1]?.payload_json ?? '{}').value, 'second');
    assert.equal(store.verifyChain('run-1'), true);
  } finally {
    database.close();
  }
});

test('exact source batch replay returns the same acknowledgement and different body conflicts', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    const first = store.appendBatch('run-1', { events: [event('source-1', 1, { value: 'one' })] });
    const replay = store.appendBatch('run-1', { events: [event('source-1', 1, { value: 'one' })] });
    assert.deepEqual(replay, first);
    assert.throws(() => store.appendBatch('run-1', { events: [event('source-1', 1, { value: 'different' })] }), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'CONFLICT');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('canonical-equivalent replay ignores object insertion order in redaction metadata', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    const firstPayload: Record<string, unknown> = {};
    firstPayload.password = 'sensitive-value';
    firstPayload.authorization = 'sensitive-value';
    firstPayload.normal = 'kept';
    const replayPayload: Record<string, unknown> = {};
    replayPayload.normal = 'kept';
    replayPayload.authorization = 'sensitive-value';
    replayPayload.password = 'sensitive-value';

    const first = store.appendBatch('run-1', { events: [event('canonical-source', 1, firstPayload)] });
    assert.deepEqual(
      store.appendBatch('run-1', { events: [event('canonical-source', 1, replayPayload)] }),
      first,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('exact eventId-only replay returns the same acknowledgement and different body conflicts', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    const batch = {
      events: [{
        eventId: 'event-explicit-1',
        eventType: 'tool.completed',
        actor: 'agent',
        payload: { value: 'one' },
      }],
    };
    const first = store.appendBatch('run-1', batch);
    assert.deepEqual(store.appendBatch('run-1', batch), first);
    assert.throws(() => store.appendBatch('run-1', {
      events: [{
        eventId: 'event-explicit-1',
        eventType: 'tool.completed',
        actor: 'agent',
        payload: { value: 'different' },
      }],
    }), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'CONFLICT');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('duplicate explicit event IDs conflict before any batch row is stored', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    assert.throws(() => store.appendBatch('run-1', {
      events: [
        { eventId: 'duplicate-explicit-id', eventType: 'tool.completed', actor: 'agent', payload: { index: 1 } },
        { eventId: 'duplicate-explicit-id', eventType: 'tool.completed', actor: 'agent', payload: { index: 2 } },
      ],
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('an explicit event ID already owned by another run is a typed conflict', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    store.createRun(runInput({ runId: 'run-2' }));
    store.appendBatch('run-1', {
      events: [{ eventId: 'global-event-id', eventType: 'tool.completed', actor: 'agent', payload: { run: 1 } }],
    });
    assert.throws(() => store.appendBatch('run-2', {
      events: [{ eventId: 'global-event-id', eventType: 'tool.completed', actor: 'agent', payload: { run: 2 } }],
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>('run-2')?.count, 0);
  } finally {
    database.close();
  }
});

test('verifies a persisted hash chain when optional event fields are omitted', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput());
    store.appendBatch('run-1', {
      events: [{
        eventId: 'event-minimal-1',
        eventType: 'run.started',
        actor: 'agent',
        payload: {},
      }],
    });
    assert.equal(store.verifyChain('run-1'), true);
  } finally {
    database.close();
  }
});

test('verifies a persisted hash chain when nullable optional fields are explicitly null', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput());
    store.appendBatch('run-1', {
      events: [{
        eventId: 'event-nullable-1',
        eventType: 'tool.completed',
        actor: 'agent',
        outcome: null,
        payload: {},
      }],
    });
    assert.equal(store.verifyChain('run-1'), true);
  } finally {
    database.close();
  }
});

test('terminal runs reject new events but permit only exact replay', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    const batch = { events: [event('source-1', 1)] };
    const ack = store.appendBatch('run-1', batch);
    store.updateRunStatus('run-1', 'completed', now);
    assert.deepEqual(store.appendBatch('run-1', batch), ack);
    assert.throws(() => store.appendBatch('run-1', { events: [event('source-2', 2)] }), /terminal|closed|conflict/i);
  } finally {
    database.close();
  }
});

test('a failed batch leaves no partial rows or sequence advancement', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    assert.throws(() => store.appendBatch('run-1', { events: [event('source-new', 2), event('source-new', 3)] }), /source|duplicate|conflict|unique/i);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 0);
    assert.equal(store.readRun('run-1')?.lastSequence, 0);

    const secret = 'password = hidden-secret-value-12345';
    store.createRun(runInput({ runId: 'run-secret', task: { title: 'Task', query: secret, profileHints: { taskType: 'build', target: null, expected: null, constraints: null } }}));
    const stored = database.prepare('SELECT metadata_json, task_hash FROM ledger_runs WHERE run_id = ?').get<{ metadata_json: string; task_hash: string | null }>('run-secret');
    assert.equal(JSON.stringify(stored).includes(secret), false);
  } finally {
    database.close();
  }
});

test('rejects secret material in the run workspace before any row or hash is stored', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    const rawWorkspace = 'password=super-secret-value-12345';
    assert.throws(() => store.createRun(runInput({ runId: 'run-secret-workspace', workspace: rawWorkspace })), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SECURITY_REJECTION');
      assert.equal((error as Error).message.includes(rawWorkspace), false);
      assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(rawWorkspace), false);
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs WHERE run_id = ?').get<{ count: number }>('run-secret-workspace')?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('caller-owned transaction rolls back only a failed batch savepoint', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    database.exec(`
      CREATE TABLE caller_marker (value TEXT NOT NULL);
      CREATE TRIGGER force_second_ledger_insert_failure
      BEFORE INSERT ON ledger_events
      WHEN NEW.source_event_id = 'force-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced ledger insert failure');
      END;
    `);
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('INSERT INTO caller_marker (value) VALUES (?)').run('outer survives');
      assert.throws(() => store.appendBatchInTransaction('run-1', {
        events: [
          { sourceEventId: 'first-in-batch', eventType: 'tool.completed', actor: 'agent', payload: { index: 1 } },
          { sourceEventId: 'force-failure', eventType: 'tool.completed', actor: 'agent', payload: { index: 2 } },
        ],
      }), /forced ledger insert failure/i);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT value FROM caller_marker').get<{ value: string }>()?.value, 'outer survives');
      assert.equal(store.readRun('run-1')?.lastSequence, 0);
    } finally {
      database.exec('ROLLBACK');
    }
  } finally {
    database.close();
  }
});

test('reports both the batch failure and a savepoint rollback failure', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    store.createRun(runInput());
    database.exec(`
      CREATE TRIGGER force_ledger_cleanup_test_failure
      BEFORE INSERT ON ledger_events
      WHEN NEW.source_event_id = 'force-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced ledger operation failure');
      END;
    `);
    database.exec('BEGIN IMMEDIATE');
    const originalExec = database.exec.bind(database);
    const rollbackFailure = new Error('forced savepoint rollback failure');
    database.exec = (sql: string): void => {
      if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) throw rollbackFailure;
      originalExec(sql);
    };
    try {
      assert.throws(() => store.appendBatchInTransaction('run-1', {
        events: [
          { sourceEventId: 'first-in-batch', eventType: 'tool.completed', actor: 'agent', payload: { index: 1 } },
          { sourceEventId: 'force-failure', eventType: 'tool.completed', actor: 'agent', payload: { index: 2 } },
        ],
      }), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[0]), /forced ledger operation failure/i);
        assert.equal(error.errors[1], rollbackFailure);
        return true;
      });
    } finally {
      database.exec = originalExec;
      database.exec('ROLLBACK');
    }
  } finally {
    database.close();
  }
});

test('rejects oversized sanitized run metadata before writing the run', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database);
    assert.throws(() => store.createRun(runInput({
      runId: 'run-oversized-metadata',
      metadata: { data: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) },
    })), /64|sanitized|size|bytes/i);
    assert.equal(store.readRun('run-oversized-metadata'), undefined);
  } finally {
    database.close();
  }
});
