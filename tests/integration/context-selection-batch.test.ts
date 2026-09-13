import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { readEntries, readEntry, recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { ordinaryContextSelectionStateHash } from '../../src/context/selection-state.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';

function fixture(t: test.TestContext) {
  const database = openConnection(':memory:');
  migrateDatabase(database);
  t.after(() => database.close());
  return database;
}

const workspace = 'project:selection-batch';

test('batch entry reads preserve current tags, order, duplicates, workspace isolation and canonical validation', t => {
  const database = fixture(t);
  const first = recordEntry(database, { workspace, kind: 'fact', title: 'First', body: 'Initial body', tags: ['old'] });
  updateCandidateEntry(database, { workspace, entryId: first.id, expectedRevision: 1, kind: 'fact', title: 'First', body: 'Current body', tags: ['zeta', 'alpha'] });
  const second = recordEntry(database, { workspace, kind: 'lesson', title: 'Second', body: 'Second body' });
  const inputs = [second, first, second].map(entry => ({ workspace, entryId: entry.id }));
  assert.deepEqual(readEntries(database, inputs), inputs.map(input => readEntry(database, input)));
  assert.deepEqual(readEntries(database, [inputs[1]!])[0]!.tags, ['alpha', 'zeta']);
  assert.throws(() => readEntries(database, [{ workspace: 'project:other', entryId: first.id }]), { code: 'NOT_FOUND' });
  assert.throws(() => readEntries(database, Array.from({ length: 257 }, () => inputs[0]!)), { code: 'VALIDATION_ERROR' });
  database.exec('DROP TRIGGER entry_revisions_immutable_update');
  database.prepare('UPDATE entry_revisions SET body = ? WHERE entry_id = ? AND revision = 2').run('Tampered body', first.id);
  assert.throws(() => readEntries(database, [inputs[1]!]), { code: 'INTEGRITY_ERROR' });
});

test('batch entry reads reject a missing current revision and revision gaps', t => {
  const database = fixture(t);
  const entry = recordEntry(database, { workspace, kind: 'fact', title: 'Broken revision', body: 'Body' });
  database.prepare('UPDATE entries SET current_revision = 2 WHERE id = ?').run(entry.id);
  assert.throws(() => readEntries(database, [{ workspace, entryId: entry.id }]), { code: 'INTEGRITY_ERROR' });
  database.prepare('UPDATE entries SET current_revision = 1 WHERE id = ?').run(entry.id);
  database.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER entry_revisions_immutable_update');
  database.prepare('UPDATE entry_revisions SET revision = 3 WHERE entry_id = ?').run(entry.id);
  database.prepare('UPDATE entries SET current_revision = 3 WHERE id = ?').run(entry.id);
  assert.throws(() => readEntries(database, [{ workspace, entryId: entry.id }]), { code: 'INTEGRITY_ERROR' });
});

test('ordinary snapshot preserves its canonical identity with bounded batch queries and detects later mutation', t => {
  const database = fixture(t);
  const records = Array.from({ length: 600 }, (_, index) => recordEntry(database, {
    workspace, kind: 'fact', title: `Fact ${index}`, body: `Body ${index}`, tags: ['fixture'],
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const expected = canonicalContentHash({ workspaces: [workspace], includeEcosystem: false, entries: records.map(entry => ({
    id: entry.id, workspace: entry.workspace, revision: entry.revision, kind: entry.kind, status: entry.status,
    trustLevel: entry.trustLevel, confidence: entry.confidence, title: entry.title, summary: entry.summary,
    body: entry.body, tags: entry.tags, scope: entry.scope, provenance: entry.provenance, contentHash: entry.contentHash,
    supersededBy: entry.supersededBy, createdBy: entry.createdBy, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    verifiedAt: entry.verifiedAt, searchSignals: database.prepare('SELECT signal_type AS type, normalized_value AS value FROM entry_search_signals WHERE entry_id = ? ORDER BY signal_type, normalized_value').all(entry.id), feedback: [],
  })) });
  let queries = 0;
  const observed: SqliteDatabase = {
    filePath: database.filePath, exec: sql => database.exec(sql), close() {},
    prepare(sql) { queries++; return database.prepare(sql); },
  };
  const before = ordinaryContextSelectionStateHash(observed, [workspace]);
  assert.equal(before, expected);
  assert.ok(queries <= 16, `600 entries must use batch queries, observed ${queries}`);
  const entry = records[0]!;
  database.prepare('UPDATE entries SET confidence = ? WHERE id = ?').run(0.25, entry.id);
  assert.notEqual(ordinaryContextSelectionStateHash(database, [workspace]), before);
  database.exec('DROP TRIGGER entry_revisions_immutable_update');
  database.prepare('UPDATE entry_revisions SET body = ? WHERE entry_id = ?').run('Corrupt body', entry.id);
  assert.throws(() => ordinaryContextSelectionStateHash(database, [workspace]), { code: 'INTEGRITY_ERROR' });
});
