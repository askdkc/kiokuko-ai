import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { LedgerStore } from '../../src/ledger/store.js';

const execFileAsync = promisify(execFile);
const migrations = path.resolve(import.meta.dirname, '../../migrations');

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-ledger-concurrency-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database, migrations);
  new LedgerStore(database).createRun({
    runId: 'run-1', workspace: '/tmp/workspace', protocolVersion: '1',
    client: { kind: 'opencode' }, captureProfile: 'standard',
    coverage: { run: 'best_effort', tool: 'best_effort', command: 'best_effort', file: 'best_effort', approval: 'unavailable' },
    task: { title: 'Concurrent', query: 'append', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
    metadata: {}, startedAt: '2026-08-20T00:00:00.000Z',
  });
  database.close();
  return databasePath;
}

test('concurrent producers allocate every local sequence exactly once', async () => {
  const databasePath = await setup();
  const worker = `
    import { openConnection } from './src/db/connection.ts';
    import { LedgerStore } from './src/ledger/store.ts';
    const db = openConnection(process.env.KIOKUKO_DATABASE);
    try {
      const store = new LedgerStore(db);
      for (let i = 0; i < Number(process.env.KIOKUKO_COUNT); i += 1) {
        const index = Number(process.env.KIOKUKO_OFFSET) + i;
        store.appendBatch('run-1', { events: [{ sourceEventId: 'source-' + index, sourceSequence: index, eventType: 'tool.completed', sourceType: 'worker', actor: 'worker', outcome: 'success', occurredAt: '2026-08-20T00:00:00.000Z', payload: { index } }] });
      }
    } finally { db.close(); }
  `;
  await Promise.all(Array.from({ length: 4 }, (_, workerIndex) => execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, KIOKUKO_DATABASE: databasePath, KIOKUKO_COUNT: '10', KIOKUKO_OFFSET: String(workerIndex * 10) },
  })));

  const database = openConnection(databasePath);
  try {
    const rows = database.prepare('SELECT sequence, source_sequence FROM ledger_events WHERE run_id = ? ORDER BY sequence').all<{ sequence: number; source_sequence: number }>('run-1');
    assert.equal(rows.length, 40);
    assert.deepEqual(rows.map((row) => row.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.deepEqual(new Set(rows.map((row) => row.source_sequence)).size, 40);
    assert.equal(database.prepare('SELECT last_sequence FROM ledger_runs WHERE run_id = ?').get<{ last_sequence: number }>('run-1')?.last_sequence, 40);
  } finally {
    database.close();
  }
});
