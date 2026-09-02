import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { readEntry, recordEntry } from '../../src/memory/entries.js';
import { recallEntries, searchEntries } from '../../src/memory/retrieval.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  migrateDatabase(database);
  return database;
}

test('searches Japanese and English content, tags, filters, and excludes superseded entries', async () => {
  const database = await temporaryDatabase('fts');
  try {
    const japanese = recordEntry(database, {
      workspace: 'project:search',
      kind: 'decision',
      status: 'verified',
      title: '日本語のメモリ方針',
      body: 'メモリ検索は日本語でも利用できます',
      tags: ['日本語', 'memory'],
    }, { now: '2026-01-01T00:00:00.000Z', idFactory: () => 'entry-japanese' });
    const english = recordEntry(database, {
      workspace: 'project:search',
      kind: 'fact',
      title: 'English memory policy',
      body: 'Memory search is available in English',
      tags: ['memory', 'english'],
    }, { now: '2026-01-01T00:00:00.000Z', idFactory: () => 'entry-english' });
    const old = recordEntry(database, {
      workspace: 'project:search',
      kind: 'lesson',
      title: 'Superseded memory policy',
      body: 'This memory should not be returned',
      tags: ['memory'],
    }, { now: '2026-01-01T00:00:00.000Z', idFactory: () => 'entry-old' });
    const replacement = recordEntry(database, {
      workspace: 'project:search',
      kind: 'lesson',
      title: 'Replacement memory policy',
      body: 'The current memory policy is retained',
      tags: ['memory'],
    }, { now: '2026-01-02T00:00:00.000Z', idFactory: () => 'entry-replacement' });
    database.prepare("UPDATE entries SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(replacement.id, '2026-01-03T00:00:00.000Z', old.id);

    const japaneseResults = searchEntries(database, { workspace: 'project:search', query: '日本語' });
    assert.ok(japaneseResults.items.some((item) => item.id === japanese.id));
    assert.deepEqual(searchEntries(database, { workspace: 'project:search', query: '日本語' }).items.map((item) => item.id), japaneseResults.items.map((item) => item.id));

    const tagged = searchEntries(database, { workspace: 'project:search', query: 'memory', tag: 'english' });
    assert.deepEqual(tagged.items.map((item) => item.id), [english.id]);
    const verified = searchEntries(database, { workspace: 'project:search', query: 'memory', status: 'verified' });
    assert.deepEqual(verified.items.map((item) => item.id), [japanese.id]);
    const all = searchEntries(database, { workspace: 'project:search', query: 'memory' });
    assert.ok(all.items.some((item) => item.id === replacement.id));
    assert.equal(all.items.some((item) => item.id === old.id), false);
  } finally {
    database.close();
  }
});

test('literal punctuation and empty search are safe no-result operations', async () => {
  const database = await temporaryDatabase('literal-search');
  try {
    recordEntry(database, {
      workspace: 'project:literal',
      kind: 'fact',
      title: 'Punctuation',
      body: 'Literal [brackets] and quotes are data',
    });
    assert.deepEqual(searchEntries(database, { workspace: 'project:literal', query: '" OR 1=1 --' }).items, []);
    assert.deepEqual(searchEntries(database, { workspace: 'project:literal', query: '   ' }).items, []);
  } finally {
    database.close();
  }
});

test('recall respects limit and character budget and marks stored data as untrusted', async () => {
  const database = await temporaryDatabase('recall-budget');
  try {
    const recorded = recordEntry(database, {
      workspace: 'project:budget',
      kind: 'lesson',
      title: 'Budget entry',
      body: `budget ${'長い本文 '.repeat(300)}`,
      summary: 'A concise budget summary',
    });
    const result = recallEntries(database, { workspace: 'project:budget', query: 'budget', limit: 1, maxChars: 80 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, recorded.id);
    assert.ok(result.characterCount <= 80);
    assert.equal(result.truncated, true);
    assert.equal(result.items[0]?.metadata.storedData, true);
    assert.equal(result.items[0]?.metadata.untrusted, true);
    assert.equal(result.items[0]?.metadata.instructions, false);
    assert.equal(readEntry(database, { workspace: 'project:budget', entryId: recorded.id }).body.length > 80, true);
  } finally {
    database.close();
  }
});
