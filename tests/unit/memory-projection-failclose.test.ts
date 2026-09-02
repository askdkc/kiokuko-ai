import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { hybridSearchProjectionStatus, rebuildHybridSearch } from '../../src/memory/rebuild-search.js';
import { buildStructuredScope, effectiveRetrievalScope, extractEntrySearchSignals } from '../../src/memory/structured-memory.js';
import { canonicalEntryRevisionContentHash, canonicalJson } from '../../src/serialization/validate.js';

const migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations');

function isIntegrityError(error: unknown): boolean {
  return error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR';
}

function projectionSnapshot(database: ReturnType<typeof openConnection>): {
  fts: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  signals: Array<Record<string, unknown>>;
} {
  return {
    fts: database.prepare('SELECT rowid, title, body, summary, tags_text FROM entries_fts ORDER BY rowid').all(),
    documents: database.prepare('SELECT entry_rowid, entry_id, title, body, summary, tags_text FROM entry_search_documents ORDER BY entry_rowid').all(),
    signals: database.prepare('SELECT entry_id, signal_type, normalized_value FROM entry_search_signals ORDER BY entry_id, signal_type, normalized_value').all(),
  };
}

test('rejects a database with no current hybrid-search projection schema', () => {
  const database = openConnection(':memory:');
  try {
    assert.throws(() => rebuildHybridSearch(database), isIntegrityError);
    assert.throws(() => hybridSearchProjectionStatus(database), isIntegrityError);
  } finally {
    database.close();
  }
});

test('rejects a partial hybrid-search projection and rolls back entry writes', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    database.exec('DROP TABLE entry_search_documents');

    assert.throws(
      () => recordEntry(database, { workspace: 'project:partial-projection', kind: 'lesson', title: 'Missing projection', body: 'Must not be stored.' }),
      (error: unknown) => {
        const missing = error instanceof KiokukoError ? error.details.missing : undefined;
        return isIntegrityError(error) && Array.isArray(missing) && missing.includes('entry_search_documents');
      },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.throws(() => rebuildHybridSearch(database), isIntegrityError);
    assert.throws(() => hybridSearchProjectionStatus(database), isIntegrityError);
  } finally {
    database.close();
  }
});

test('rejects an external-content FTS projection without its maintenance triggers', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    database.exec('DROP TRIGGER entry_search_documents_ai');

    assert.throws(
      () => recordEntry(database, {
        workspace: 'project:missing-search-trigger',
        kind: 'lesson',
        title: 'Missing search trigger',
        body: 'The entry must not be stored without a complete FTS projection contract.',
      }),
      (error: unknown) => {
        const missing = error instanceof KiokukoError ? error.details.missing : undefined;
        return isIntegrityError(error) && Array.isArray(missing) && missing.includes('entry_search_documents_ai');
      },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('uses the canonical code-unit tag order for incremental and rebuilt search projections', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const entry = recordEntry(database, {
      workspace: 'project:portable-projection-order',
      kind: 'lesson',
      title: 'Portable projection',
      body: 'Projection ordering must not depend on SQLite or ICU collation.',
      tags: ['\uE000', '😀', 'a'],
    });
    const rowid = database.prepare('SELECT rowid FROM entries WHERE id = ?').get<{ rowid: number }>(entry.id)?.rowid;
    assert.ok(rowid);
    assert.equal(database.prepare('SELECT tags_text FROM entry_search_documents WHERE entry_rowid = ?').get<{ tags_text: string }>(rowid)?.tags_text, 'a 😀 \uE000');

    rebuildHybridSearch(database);

    assert.equal(database.prepare('SELECT tags_text FROM entry_search_documents WHERE entry_rowid = ?').get<{ tags_text: string }>(rowid)?.tags_text, 'a 😀 \uE000');
    assert.equal(hybridSearchProjectionStatus(database).staleTrigram, 0);
  } finally {
    database.close();
  }
});

test('uses canonical code-unit ordering for persisted structured frameworks and signals', () => {
  const scope = buildStructuredScope({
    visibility: 'project',
    applicability: { frameworks: [{ name: '\uE000' }, { name: '😀' }, { name: 'a' }] },
  });
  assert.deepEqual((scope.applicability as { frameworks: Array<{ name: string }> }).frameworks.map(({ name }) => name), ['a', '😀', '\uE000']);
  assert.deepEqual(
    extractEntrySearchSignals({
      entryId: 'portable-signal-order',
      title: '',
      body: '',
      summary: null,
      tags: ['\uE000', '😀', 'a'],
      scope,
    }).filter(({ type }) => type === 'framework' || type === 'tag').map(({ type, value }) => `${type}:${value}`),
    ['framework:a', 'framework:😀', 'framework:\uE000', 'tag:a', 'tag:😀', 'tag:\uE000'],
  );
});

test('rejects malformed stored scope JSON without clearing existing projections', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const entry = recordEntry(database, {
      workspace: 'project:corrupt-scope',
      kind: 'lesson',
      title: 'Projection remains intact',
      body: 'The malformed scope must fail closed.',
      scope: { signals: { symbols: ['ProjectionSentinel'] } },
      tags: ['projection-sentinel'],
    });
    const before = database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals').get<{ count: number }>()?.count;
    assert.ok(Number(before) > 0);

    database.exec('DROP TRIGGER entry_revisions_immutable_update');
    database.prepare('UPDATE entry_revisions SET scope_json = ? WHERE entry_id = ? AND revision = ?').run('{', entry.id, entry.revision);

    assert.throws(() => rebuildHybridSearch(database), isIntegrityError);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals').get<{ count: number }>()?.count, before);
    assert.throws(() => hybridSearchProjectionStatus(database), isIntegrityError);
  } finally {
    database.close();
  }
});

test('rejects malformed typed signal metadata before mutating any projection', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const entry = recordEntry(database, {
      workspace: 'project:corrupt-signal-metadata',
      kind: 'lesson',
      title: 'Typed projection remains intact',
      body: 'A non-string signal must be treated as stored-data corruption.',
      scope: { schemaVersion: 1, visibility: 'project', signals: { symbols: ['TypedProjectionSentinel'] } },
      tags: ['typed-projection-sentinel'],
    });
    const before = projectionSnapshot(database);

    database.exec('DROP TRIGGER entry_revisions_immutable_update');
    database.prepare('UPDATE entry_revisions SET scope_json = ? WHERE entry_id = ? AND revision = ?')
      .run('{"schemaVersion":1,"signals":{"symbols":[123]},"visibility":"project"}', entry.id, entry.revision);

    assert.throws(() => rebuildHybridSearch(database), isIntegrityError);
    assert.deepEqual(projectionSnapshot(database), before);
  } finally {
    database.close();
  }
});

test('rejects canonical duplicate typed signals with a matching forged hash before projection mutation', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const entry = recordEntry(database, {
      workspace: 'project:duplicate-signal-corruption',
      kind: 'lesson',
      title: 'Duplicate typed signal',
      body: 'A matching content hash must not legitimize noncanonical metadata.',
      scope: { schemaVersion: 1, visibility: 'project', signals: { symbols: ['Duplicated'] } },
      tags: ['duplicate-signal'],
    });
    const before = projectionSnapshot(database);
    const corruptScope = {
      schemaVersion: 1,
      visibility: 'project',
      signals: { symbols: ['Duplicated', 'Duplicated'] },
    };
    const forgedHash = canonicalEntryRevisionContentHash({
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      summary: entry.summary,
      scope: corruptScope,
      provenance: entry.provenance,
      tags: entry.tags,
    });
    database.exec('DROP TRIGGER entry_revisions_immutable_update');
    database.prepare('UPDATE entry_revisions SET scope_json = ?, content_hash = ? WHERE entry_id = ? AND revision = ?')
      .run(canonicalJson(corruptScope), forgedHash, entry.id, entry.revision);

    assert.throws(() => rebuildHybridSearch(database), isIntegrityError);
    assert.deepEqual(projectionSnapshot(database), before);
  } finally {
    database.close();
  }
});

test('rejects current-revision content whose stored hash no longer matches before projection mutation', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const entry = recordEntry(database, {
      workspace: 'project:projection-hash-corruption',
      kind: 'lesson',
      title: 'Hash-protected projection',
      body: 'Original body.',
      tags: ['hash-protected'],
    });
    const before = projectionSnapshot(database);
    database.exec('DROP TRIGGER entry_revisions_immutable_update');
    database.prepare('UPDATE entry_revisions SET body = ? WHERE entry_id = ? AND revision = ?')
      .run('Forged body that must never reach FTS.', entry.id, entry.revision);

    assert.throws(() => rebuildHybridSearch(database), isIntegrityError);
    assert.throws(() => hybridSearchProjectionStatus(database), isIntegrityError);
    assert.deepEqual(projectionSnapshot(database), before);
  } finally {
    database.close();
  }
});

test('rejects a noncontiguous revision chain before projection mutation', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const first = recordEntry(database, {
      workspace: 'project:projection-revision-gap',
      kind: 'lesson',
      title: 'Revision one',
      body: 'First body.',
      tags: ['revision-gap'],
    });
    const second = updateCandidateEntry(database, {
      workspace: first.workspace,
      entryId: first.id,
      expectedRevision: first.revision,
      kind: first.kind,
      title: 'Revision two',
      body: 'Second body.',
      tags: first.tags,
    });
    updateCandidateEntry(database, {
      workspace: second.workspace,
      entryId: second.id,
      expectedRevision: second.revision,
      kind: second.kind,
      title: 'Revision three',
      body: 'Third body.',
      tags: second.tags,
    });
    const before = projectionSnapshot(database);
    database.prepare('DELETE FROM entry_revisions WHERE entry_id = ? AND revision = 2').run(first.id);

    assert.throws(() => rebuildHybridSearch(database), isIntegrityError);
    assert.deepEqual(projectionSnapshot(database), before);
  } finally {
    database.close();
  }
});

test('does not reinterpret unversioned scope key collisions as structured projection metadata', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const entry = recordEntry(database, {
      workspace: 'project:unversioned-scope-collision',
      kind: 'lesson',
      title: 'Unstructured scope keys',
      body: 'These arbitrary keys are not typed structured memory.',
      scope: {
        visibility: 7,
        applicability: 'not structured metadata',
        signals: { symbols: ['UnversionedSignalSentinel'] },
      },
    });
    const signalCount = () => database.prepare(`
      SELECT COUNT(*) AS count
        FROM entry_search_signals
       WHERE entry_id = ? AND signal_type = 'symbol' AND normalized_value = ?
    `).get<{ count: number }>(entry.id, 'unversionedsignalsentinel')?.count;

    assert.equal(signalCount(), 0);
    assert.doesNotThrow(() => rebuildHybridSearch(database));
    assert.equal(signalCount(), 0);
  } finally {
    database.close();
  }
});

test('rolls back every projection when a late signal write fails', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const entry = recordEntry(database, {
      workspace: 'project:late-projection-failure',
      kind: 'lesson',
      title: 'Canonical projection title',
      body: 'The old projection must survive a late transactional failure.',
      scope: { schemaVersion: 1, visibility: 'project', signals: { symbols: ['LateProjectionWriteFailure'] } },
      tags: ['late-projection'],
    });
    const row = database.prepare('SELECT rowid FROM entries WHERE id = ?').get<{ rowid: number }>(entry.id);
    assert.ok(row);
    database.prepare('UPDATE entry_search_documents SET title = ? WHERE entry_rowid = ?').run('Pre-existing FTS sentinel', row.rowid);
    database.prepare(`
      INSERT INTO entry_search_signals (entry_id, signal_type, normalized_value)
      VALUES (?, 'symbol', 'pre-existing-signal-sentinel')
    `).run(entry.id);
    const before = projectionSnapshot(database);
    database.exec(`
      CREATE TRIGGER fail_late_search_projection_write
      BEFORE INSERT ON entry_search_signals
      WHEN NEW.normalized_value = 'lateprojectionwritefailure'
      BEGIN
        SELECT RAISE(ABORT, 'injected late search projection write failure');
      END
    `);

    assert.throws(
      () => rebuildHybridSearch(database),
      /injected late search projection write failure/u,
    );
    assert.deepEqual(projectionSnapshot(database), before);
  } finally {
    database.close();
  }
});

test('rejects an invalid explicit stored retrieval scope instead of defaulting it', () => {
  assert.throws(
    () => effectiveRetrievalScope({ visibility: 'project', retrievalScope: 'unknown-scope' }),
    isIntegrityError,
  );
  assert.equal(effectiveRetrievalScope({ visibility: 'project' }), 'project-only');
  assert.equal(effectiveRetrievalScope({ visibility: 'global' }), 'global');
});

test('rejects explicit project ecosystem scope without applicability', () => {
  assert.throws(
    () => buildStructuredScope({ visibility: 'project', retrievalScope: 'ecosystem' }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.doesNotThrow(() => buildStructuredScope({
    visibility: 'project',
    retrievalScope: 'ecosystem',
    applicability: { languages: ['TypeScript'] },
  }));
});
