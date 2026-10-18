import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NodeSqliteAdapter } from '../../src/db/adapter.js';
import { readTaskContextRevisions } from '../../src/context/revisions.js';
import { markLegacyModelContext } from '../../src/memory/relation-delivery.js';

test('old stored context is explicitly legacy at the read boundary without rewriting its immutable JSON', () => {
  const database = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'));
  database.exec('CREATE TABLE task_context_revisions(run_id TEXT,context_revision INTEGER,selection_state_hash TEXT,context_json TEXT,created_at TEXT)');
  const body = { kind: 'prepare', context: { items: [{ entryId: 'old-entry', workspace: 'p', revision: 1 }], truncated: false } };
  const json = JSON.stringify(body);
  database.prepare('INSERT INTO task_context_revisions VALUES(?,1,?,?,?)').run('run', 'hash', json, '2026-10-18T00:00:00Z');
  try {
    const value = readTaskContextRevisions(database, { runId: 'run' })[0]!;
    const memory = value.context.context as { relationDelivery: { status: string }; items: unknown[] };
    assert.equal(memory.relationDelivery.status, 'omitted_legacy'); assert.deepEqual(memory.items, body.context.items);
    assert.equal(database.prepare('SELECT context_json FROM task_context_revisions').get<{context_json:string}>()!.context_json, json);
    const original = { context: body.context };
    const presented = markLegacyModelContext(original);
    assert.ok(!Object.hasOwn(original.context, 'relationDelivery'));
    assert.equal((presented.context as unknown as {relationDelivery:{status:string}}).relationDelivery.status, 'omitted_legacy');
  } finally { database.close(); }
});
