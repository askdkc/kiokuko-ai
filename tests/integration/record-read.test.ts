import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { readEntry, recordEntry, recordEntryInTransaction } from '../../src/memory/entries.js';
import { canonicalContentHash, canonicalJson } from '../../src/serialization/validate.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  migrateDatabase(database);
  return database;
}

test('records and reads Unicode and multiline content exactly in one workspace', async () => {
  const database = await temporaryDatabase('record-read');
  try {
    const recorded = recordEntry(database, {
      workspace: 'project:日本語',
      kind: 'decision',
      title: '保存方針 🚀',
      body: '一行目\n二行目\r\n第三行目\n絵文字: 🧠',
      provenance: { type: 'agent_observation', reference: 'test fixture' },
    });

    const read = readEntry(database, {
      workspace: 'project:日本語',
      entryId: recorded.id,
    });

    assert.equal(read.id, recorded.id);
    assert.equal(read.title, '保存方針 🚀');
    assert.equal(read.body, '一行目\n二行目\r\n第三行目\n絵文字: 🧠');
    assert.equal(read.status, 'candidate');
    assert.equal(read.workspace, 'project:日本語');
  } finally {
    database.close();
  }
});

test('reading an existing entry through another workspace returns NOT_FOUND', async () => {
  const database = await temporaryDatabase('workspace-isolation');
  try {
    const recorded = recordEntry(database, {
      workspace: 'project:alpha',
      kind: 'fact',
      title: 'Private fact',
      body: 'Workspace alpha only',
    });

    assert.throws(
      () => readEntry(database, { workspace: 'project:beta', entryId: recorded.id }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'NOT_FOUND',
    );
  } finally {
    database.close();
  }
});

test('duplicate content is idempotent and records exactly one audit event', async () => {
  const database = await temporaryDatabase('duplicate');
  try {
    const input = {
      workspace: 'project:duplicate',
      kind: 'lesson' as const,
      title: 'Stable content',
      body: 'The same body is recorded twice.',
      tags: ['one', 'two'],
    };
    const first = recordEntry(database, input, { idFactory: () => 'entry-first', now: '2026-01-01T00:00:00.000Z' });
    const second = recordEntry(database, input, { idFactory: () => 'entry-second', now: '2026-01-02T00:00:00.000Z' });

    assert.equal(second.id, first.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('caller-owned record primitive participates in the outer transaction', async () => {
  const database = await temporaryDatabase('record-in-transaction');
  try {
    database.exec('BEGIN IMMEDIATE');
    const recorded = recordEntryInTransaction(database, {
      workspace: 'project:transaction',
      kind: 'lesson',
      title: 'Outer transaction entry',
      body: 'This write belongs to the caller transaction.',
      createdBy: 'test-actor',
      actor: 'test-actor',
    }, { now: '2026-01-01T00:00:00.000Z', idFactory: () => 'entry-transaction' });

    assert.equal(recorded.id, 'entry-transaction');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 1);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
  } finally {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The assertion path may already have rolled the outer transaction back.
    }
    database.close();
  }
});

test('canonical JSON and content hashes are stable across object key order', () => {
  const left = { body: '本文', scope: { z: 2, a: 1 }, title: 'タイトル' };
  const right = { title: 'タイトル', scope: { a: 1, z: 2 }, body: '本文' };
  assert.equal(canonicalJson(left), '{"body":"本文","scope":{"a":1,"z":2},"title":"タイトル"}');
  assert.equal(canonicalContentHash(left), canonicalContentHash(right));
});

test('record validation rejects unknown fields and invalid enum values', async () => {
  const database = await temporaryDatabase('validation');
  try {
    const base = { workspace: 'project:validation', kind: 'fact', title: 'Title', body: 'Body' };
    for (const input of [
      { ...base, extra: true },
      { ...base, kind: 'unknown' },
      { ...base, status: 'unknown' },
      { ...base, confidence: 1.1 },
      { ...base, provenance: { type: 'test', reference: 'fixture', extra: true } },
      { ...base, tags: ['ok', 42] },
    ]) {
      assert.throws(() => recordEntry(database, input as never), /field|kind|status|confidence|provenance|tags/i);
    }
  } finally {
    database.close();
  }
});
