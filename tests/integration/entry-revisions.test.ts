import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry, readEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import {
  findEntryRevision,
  insertEntryRevisionInTransaction,
  readEntryRevision,
  type EntryRevisionInput,
} from '../../src/memory/revisions.js';
import { KiokukoError } from '../../src/errors.js';

const migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations');

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-entry-revisions-'));
  const db = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(db, migrationsDirectory);
  return db;
}

function code(error: unknown): string | undefined {
  return error instanceof KiokukoError ? error.code : undefined;
}

function revisionInput(entry: ReturnType<typeof recordEntry>, revision: number, title: string, body: string): EntryRevisionInput {
  return {
    entryId: entry.id,
    workspace: entry.workspace,
    revision,
    kind: entry.kind,
    title,
    body,
    summary: null,
    scope: {},
    provenance: {},
    tags: [],
    createdBy: 'test',
    createdAt: '2026-08-25T00:00:00.000Z',
  };
}

function failRevisionInsert(database: SqliteDatabase, failure: unknown): SqliteDatabase {
  return {
    filePath: database.filePath,
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      if (/INSERT\s+INTO\s+entry_revisions/u.test(sql)) {
        return {
          run: () => { throw failure; },
          get: () => undefined,
          all: () => [],
        };
      }
      return database.prepare(sql);
    },
    close: () => database.close(),
  };
}

test('entry content and tags are immutable per revision', async () => {
  const db = await database();
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(entries)').all<{ name: string }>().map((column) => column.name), [
      'id', 'workspace', 'status', 'trust_level', 'confidence', 'current_revision', 'superseded_by',
      'created_by', 'created_at', 'updated_at', 'verified_at',
    ]);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get(), undefined);
    const first = recordEntry(db, {
      workspace: 'project:revisions',
      kind: 'reference',
      title: 'PostgreSQL',
      body: 'PGroonga',
      summary: 'revision one',
      scope: { applicability: { databases: ['PostgreSQL'] } },
      provenance: { type: 'test', reference: 'revision-1' },
      tags: ['postgresql', 'old'],
      createdBy: 'test',
    });
    assert.equal(first.revision, 1);
    assert.equal(db.prepare('SELECT current_revision FROM entries WHERE id = ?').get<{ current_revision: number }>(first.id)?.current_revision, 1);
    assert.deepEqual(readEntryRevision(db, { entryId: first.id, workspace: first.workspace, revision: 1 }), {
      entryId: first.id,
      workspace: first.workspace,
      revision: 1,
      kind: 'reference',
      title: 'PostgreSQL',
      body: 'PGroonga',
      summary: 'revision one',
      scope: { applicability: { databases: ['PostgreSQL'] } },
      provenance: { reference: 'revision-1', type: 'test' },
      tags: ['old', 'postgresql'],
      contentHash: first.contentHash,
      createdBy: 'test',
      createdAt: first.createdAt,
    });

    const second = updateCandidateEntry(db, {
      workspace: first.workspace,
      entryId: first.id,
      expectedRevision: 1,
      kind: 'lesson',
      title: 'SQLite',
      body: 'FTS5 trigram',
      summary: 'revision two',
      scope: { applicability: { databases: ['SQLite'] } },
      provenance: { type: 'test', reference: 'revision-2' },
      tags: ['new', 'sqlite'],
    });
    assert.equal(second.revision, 2);
    assert.deepEqual(readEntryRevision(db, { entryId: first.id, workspace: first.workspace, revision: 1 }).tags, ['old', 'postgresql']);
    assert.deepEqual(readEntryRevision(db, { entryId: first.id, workspace: first.workspace, revision: 2 }), {
      entryId: first.id,
      workspace: first.workspace,
      revision: 2,
      kind: 'lesson',
      title: 'SQLite',
      body: 'FTS5 trigram',
      summary: 'revision two',
      scope: { applicability: { databases: ['SQLite'] } },
      provenance: { reference: 'revision-2', type: 'test' },
      tags: ['new', 'sqlite'],
      contentHash: second.contentHash,
      createdBy: 'kiokuko-web',
      createdAt: second.updatedAt,
    });
    assert.equal(readEntry(db, { workspace: first.workspace, entryId: first.id }).revision, 2);
    assert.equal(findEntryRevision(db, { entryId: first.id, workspace: first.workspace, revision: 99 }), undefined);

    assert.throws(() => db.prepare('UPDATE entry_revisions SET title = ? WHERE entry_id = ? AND revision = 1').run('mutated', first.id));
    assert.deepEqual(db.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision').all<{ revision: number }>(first.id).map((row) => row.revision), [1, 2]);
  } finally {
    db.close();
  }
});

test('shared stored-memory decoder rejects hash tampering and noncanonical JSON through both read paths', async () => {
  const db = await database();
  try {
    const tamperedBody = recordEntry(db, {
      workspace: 'project:stored-memory-integrity',
      kind: 'reference',
      title: 'Content hash integrity',
      body: 'original body',
    });
    const noncanonicalScope = recordEntry(db, {
      workspace: tamperedBody.workspace,
      kind: 'reference',
      title: 'Canonical JSON integrity',
      body: 'canonical body',
      scope: { applicability: { databases: ['SQLite'] } },
    });
    db.exec('DROP TRIGGER entry_revisions_immutable_update');
    db.prepare("UPDATE entry_revisions SET body = body || ' tampered' WHERE entry_id = ? AND revision = ?")
      .run(tamperedBody.id, tamperedBody.revision);
    db.prepare('UPDATE entry_revisions SET scope_json = ? WHERE entry_id = ? AND revision = ?')
      .run('{ "applicability": {"databases":["SQLite"]}}', noncanonicalScope.id, noncanonicalScope.revision);

    for (const entry of [tamperedBody, noncanonicalScope]) {
      assert.throws(
        () => readEntryRevision(db, { entryId: entry.id, workspace: entry.workspace, revision: entry.revision }),
        (error) => code(error) === 'INTEGRITY_ERROR',
      );
      assert.throws(
        () => readEntry(db, { workspace: entry.workspace, entryId: entry.id }),
        (error) => code(error) === 'INTEGRITY_ERROR',
      );
    }
  } finally {
    db.close();
  }
});

test('current revision is the highest revision and historical content replay conflicts explicitly', async () => {
  const db = await database();
  try {
    const first = recordEntry(db, {
      workspace: 'project:current-revision-integrity',
      kind: 'lesson',
      title: 'Revision A',
      body: 'first semantic payload',
      tags: ['revision-a'],
    });
    const second = updateCandidateEntry(db, {
      workspace: first.workspace,
      entryId: first.id,
      expectedRevision: first.revision,
      kind: 'lesson',
      title: 'Revision B',
      body: 'second semantic payload',
      tags: ['revision-b'],
    });

    assert.throws(
      () => recordEntry(db, {
        workspace: first.workspace,
        kind: first.kind,
        title: first.title,
        body: first.body,
        summary: first.summary,
        scope: first.scope,
        provenance: first.provenance,
        tags: first.tags,
      }),
      (error) => code(error) === 'CONFLICT' && /historical/iu.test((error as Error).message),
    );
    const replay = recordEntry(db, {
      workspace: second.workspace,
      kind: second.kind,
      title: second.title,
      body: second.body,
      summary: second.summary,
      scope: second.scope,
      provenance: second.provenance,
      tags: second.tags,
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.revision, 2);

    db.prepare('UPDATE entries SET current_revision = 1 WHERE id = ?').run(first.id);
    assert.throws(
      () => readEntry(db, { workspace: first.workspace, entryId: first.id }),
      (error) => code(error) === 'INTEGRITY_ERROR',
    );
    assert.throws(
      () => readEntryRevision(db, { workspace: first.workspace, entryId: first.id, revision: 2 }),
      (error) => code(error) === 'INTEGRITY_ERROR',
    );
  } finally {
    db.close();
  }
});

test('stored timestamps are canonical and chronologically consistent', async () => {
  const db = await database();
  try {
    const entry = recordEntry(db, {
      workspace: 'project:timestamp-integrity',
      kind: 'fact',
      title: 'Canonical timestamps',
      body: 'timestamps affect deterministic ranking',
    }, { now: '2026-08-25T01:02:03.004Z' });
    db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run('2026-08-25 01:02:03', entry.id);
    assert.throws(() => readEntry(db, { workspace: entry.workspace, entryId: entry.id }), (error) => code(error) === 'INTEGRITY_ERROR');

    db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run('2026-08-25T01:02:03.004Z', entry.id);
    db.exec('DROP TRIGGER entry_revisions_immutable_update');
    db.prepare('UPDATE entry_revisions SET created_at = ? WHERE entry_id = ?').run('2026-08-25T02:02:03.004Z', entry.id);
    assert.throws(() => readEntry(db, { workspace: entry.workspace, entryId: entry.id }), (error) => code(error) === 'INTEGRITY_ERROR');
    assert.throws(() => readEntryRevision(db, { workspace: entry.workspace, entryId: entry.id, revision: 1 }), (error) => code(error) === 'INTEGRITY_ERROR');
  } finally {
    db.close();
  }
});

test('stale, verified, superseded, secret, and duplicate edits do not append revisions', async () => {
  const db = await database();
  try {
    const first = recordEntry(db, { workspace: 'project:guards', kind: 'lesson', title: 'one', body: 'one' });
    const other = recordEntry(db, { workspace: 'project:guards', kind: 'lesson', title: 'edited', body: 'two' });
    const edit = (body: string, expectedRevision = 1) => updateCandidateEntry(db, {
      workspace: first.workspace,
      entryId: first.id,
      expectedRevision,
      kind: 'lesson',
      title: 'edited',
      body,
    });

    assert.throws(() => edit('stale', 2), (error) => code(error) === 'CONFLICT');
    assert.throws(() => edit(other.body), (error) => code(error) === 'CONFLICT');
    assert.throws(() => edit('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'), (error) => code(error) === 'SECURITY_REJECTION');
    assert.deepEqual(db.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision').all<{ revision: number }>(first.id).map((row) => row.revision), [1]);

    const verified = recordEntry(db, { workspace: first.workspace, kind: 'fact', status: 'verified', title: 'verified', body: 'fixed' });
    assert.throws(() => updateCandidateEntry(db, { workspace: first.workspace, entryId: verified.id, expectedRevision: 1, kind: 'lesson', title: 'x', body: 'x' }), (error) => code(error) === 'CONFLICT');
    const superseded = recordEntry(db, { workspace: first.workspace, kind: 'fact', title: 'old', body: 'old' });
    db.prepare("UPDATE entries SET status = 'superseded', superseded_by = ? WHERE id = ?").run(other.id, superseded.id);
    assert.throws(() => updateCandidateEntry(db, { workspace: first.workspace, entryId: superseded.id, expectedRevision: 1, kind: 'lesson', title: 'x', body: 'x' }), (error) => code(error) === 'CONFLICT');
  } finally {
    db.close();
  }
});

test('maps only the declared revision primary-key and content-hash uniqueness targets to conflict', async () => {
  const db = await database();
  try {
    const first = recordEntry(db, {
      workspace: 'project:revision-conflicts',
      kind: 'lesson',
      title: 'first',
      body: 'first body',
    });
    const second = recordEntry(db, {
      workspace: first.workspace,
      kind: 'lesson',
      title: 'second',
      body: 'second body',
    });

    assert.throws(
      () => insertEntryRevisionInTransaction(db, revisionInput(first, 1, 'different', 'primary-key collision')),
      (error) => code(error) === 'CONFLICT',
    );
    assert.throws(
      () => insertEntryRevisionInTransaction(db, {
        ...revisionInput(second, 2, first.title, first.body),
        summary: first.summary,
        scope: first.scope,
        provenance: first.provenance,
        tags: first.tags,
      }),
      (error) => code(error) === 'CONFLICT',
    );
    assert.equal(findEntryRevision(db, { entryId: second.id, workspace: second.workspace, revision: 2 }), undefined);
  } finally {
    db.close();
  }
});

test('propagates constraint-shaped programmer errors without SQLite error identity', async () => {
  const db = await database();
  try {
    const entry = recordEntry(db, {
      workspace: 'project:revision-programmer-error',
      kind: 'lesson',
      title: 'first',
      body: 'first body',
    });
    const exactMessage = 'UNIQUE constraint failed: entry_revisions.entry_id, entry_revisions.revision';
    const failures: unknown[] = [
      new Error(exactMessage),
      { code: 'ERR_SQLITE_ERROR', errcode: 2_067, message: exactMessage },
      Object.assign(new Error(exactMessage), { code: 'ERR_SQLITE_ERROR', errcode: 19 }),
    ];
    for (const failure of failures) {
      assert.throws(
        () => insertEntryRevisionInTransaction(failRevisionInsert(db, failure), revisionInput(entry, 2, 'next', 'next body')),
        (error) => error === failure,
      );
    }
  } finally {
    db.close();
  }
});

test('propagates unrelated and message-spoofing trigger constraints', async () => {
  for (const trigger of [
    {
      name: 'unrelated unique target',
      sql: `
        CREATE TABLE unrelated_revision_unique (value TEXT NOT NULL UNIQUE);
        INSERT INTO unrelated_revision_unique (value) VALUES ('sentinel');
        CREATE TRIGGER reject_revision_with_unrelated_unique
        AFTER INSERT ON entry_revisions
        BEGIN
          INSERT INTO unrelated_revision_unique (value) VALUES ('sentinel');
        END;
      `,
      errcode: 2_067,
      message: 'UNIQUE constraint failed: unrelated_revision_unique.value',
    },
    {
      name: 'declared target text with trigger errcode',
      sql: `
        CREATE TRIGGER reject_revision_with_spoofed_message
        BEFORE INSERT ON entry_revisions
        BEGIN
          SELECT RAISE(ABORT, 'UNIQUE constraint failed: entry_revisions.entry_id, entry_revisions.revision');
        END;
      `,
      errcode: 1_811,
      message: 'UNIQUE constraint failed: entry_revisions.entry_id, entry_revisions.revision',
    },
  ]) {
    const db = await database();
    try {
      const entry = recordEntry(db, {
        workspace: `project:revision-trigger-${trigger.errcode}`,
        kind: 'lesson',
        title: 'first',
        body: 'first body',
      });
      db.exec(trigger.sql);
      assert.throws(
        () => insertEntryRevisionInTransaction(db, revisionInput(entry, 2, 'next', 'next body')),
        (error: unknown) => {
          const failure = error as { code?: unknown; errcode?: unknown; message?: unknown };
          assert.equal(failure.code, 'ERR_SQLITE_ERROR', trigger.name);
          assert.equal(failure.errcode, trigger.errcode, trigger.name);
          assert.equal(failure.message, trigger.message, trigger.name);
          return true;
        },
      );
      assert.equal(findEntryRevision(db, { entryId: entry.id, workspace: entry.workspace, revision: 2 }), undefined);
    } finally {
      db.close();
    }
  }
});
