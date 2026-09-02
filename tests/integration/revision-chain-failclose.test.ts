import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { readEntry, recordEntry } from '../../src/memory/entries.js';
import { insertEntryRevisionInTransaction, readEntryRevision } from '../../src/memory/revisions.js';
import { canonicalEntryRevisionContentHash, canonicalJson } from '../../src/serialization/validate.js';

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-revision-chain-'));
  const result = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  migrateDatabase(result);
  return result;
}

function integrity(error: unknown): boolean {
  return error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR';
}

test('revision insertion requires the exact next revision and leaves no gap row', async () => {
  const db = await database();
  try {
    const entry = recordEntry(db, {
      workspace: 'project:revision-insert-gap',
      kind: 'lesson',
      title: 'Revision one',
      body: 'A complete chain starts at one.',
    });
    assert.throws(
      () => insertEntryRevisionInTransaction(db, {
        entryId: entry.id,
        workspace: entry.workspace,
        revision: 3,
        kind: 'lesson',
        title: 'Revision three',
        body: 'Revision two is missing.',
        createdBy: 'test',
        createdAt: entry.updatedAt,
      }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT' && /exact next revision/u.test(error.message),
    );
    assert.deepEqual(
      db.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision')
        .all<{ revision: number }>(entry.id)
        .map(({ revision }) => revision),
      [1],
    );
  } finally {
    db.close();
  }
});

test('reads fail closed when a stored revision chain is [1,3]', async () => {
  const db = await database();
  try {
    const entry = recordEntry(db, {
      workspace: 'project:revision-read-gap',
      kind: 'lesson',
      title: 'Revision one',
      body: 'A corrupt store skips revision two.',
    });
    const revisionThree = {
      kind: 'lesson' as const,
      title: 'Revision three',
      body: 'This row must never be treated as a complete chain.',
      summary: null,
      scope: {},
      provenance: {},
      tags: [],
    };
    db.prepare(`
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, summary, scope_json,
        provenance_json, content_hash, created_by, created_at
      ) VALUES (?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.workspace,
      revisionThree.kind,
      revisionThree.title,
      revisionThree.body,
      revisionThree.summary,
      canonicalJson(revisionThree.scope),
      canonicalJson(revisionThree.provenance),
      canonicalEntryRevisionContentHash(revisionThree),
      'test',
      entry.updatedAt,
    );
    db.prepare('UPDATE entries SET current_revision = 3 WHERE id = ?').run(entry.id);

    assert.throws(() => readEntry(db, { workspace: entry.workspace, entryId: entry.id }), integrity);
    assert.throws(
      () => readEntryRevision(db, { workspace: entry.workspace, entryId: entry.id, revision: 1 }),
      integrity,
    );
    assert.throws(
      () => readEntryRevision(db, { workspace: entry.workspace, entryId: entry.id, revision: 3 }),
      integrity,
    );
  } finally {
    db.close();
  }
});

test('fractional revision keys cannot make [1,1.5,3] look contiguous', async () => {
  const db = await database();
  try {
    const entry = recordEntry(db, {
      workspace: 'project:fractional-revision-chain',
      kind: 'lesson',
      title: 'Revision one',
      body: 'SQLite INTEGER affinity still permits a REAL key.',
    });
    for (const revision of [1.5, 3]) {
      const material = {
        kind: 'lesson' as const,
        title: `Revision ${revision}`,
        body: `Invalid chain member ${revision}.`,
        summary: null,
        scope: {},
        provenance: {},
        tags: [],
      };
      db.prepare(`
        INSERT INTO entry_revisions (
          entry_id, workspace, revision, kind, title, body, summary, scope_json,
          provenance_json, content_hash, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.workspace,
        revision,
        material.kind,
        material.title,
        material.body,
        material.summary,
        canonicalJson(material.scope),
        canonicalJson(material.provenance),
        canonicalEntryRevisionContentHash(material),
        'test',
        entry.updatedAt,
      );
    }
    assert.equal(
      db.prepare('SELECT typeof(revision) AS storage FROM entry_revisions WHERE entry_id = ? AND revision = 1.5')
        .get<{ storage: string }>(entry.id)?.storage,
      'real',
    );
    db.prepare('UPDATE entries SET current_revision = 3 WHERE id = ?').run(entry.id);

    assert.throws(() => readEntry(db, { workspace: entry.workspace, entryId: entry.id }), integrity);
    assert.throws(
      () => readEntryRevision(db, { workspace: entry.workspace, entryId: entry.id, revision: 1 }),
      integrity,
    );
    assert.throws(
      () => insertEntryRevisionInTransaction(db, {
        entryId: entry.id,
        workspace: entry.workspace,
        revision: 4,
        kind: 'lesson',
        title: 'Revision four',
        body: 'Insertion must reject the corrupt owner chain first.',
        createdBy: 'test',
        createdAt: entry.updatedAt,
      }),
      integrity,
    );
  } finally {
    db.close();
  }
});
