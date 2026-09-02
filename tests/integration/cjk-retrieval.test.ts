import assert from 'node:assert/strict';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { rankedEntryHits, searchEntries } from '../../src/memory/retrieval.js';

test('the trigram lane retrieves a Japanese-only entry from a Japanese word query', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const entry = recordEntry(database, {
      workspace: 'project:cjk-retrieval',
      kind: 'decision',
      status: 'verified',
      title: '履歴保全方針',
      body: '過去のマイグレーションファイルは直接編集せず、新しいファイルで前方移行する。',
      tags: ['履歴保全'],
    });

    const directFtsRows = database.prepare(`
      SELECT rowid FROM entries_trigram WHERE entries_trigram MATCH ?
    `).all('"マイグレーション"');
    assert.equal(directFtsRows.length, 1);

    const hits = rankedEntryHits(database, {
      workspace: 'project:cjk-retrieval',
      query: 'マイグレーション',
      limit: 5,
    });
    const hit = hits.hits.find((candidate) => candidate.entryId === entry.id);
    assert.ok(hit);
    assert.ok(hit.reasons.includes('substring_match'));
    assert.ok(hit.reasons.includes('cjk_window_match'));
  } finally {
    database.close();
  }
});

test('word retrieval preserves diacritics and outranks more than 120 substring decoys', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const exact = recordEntry(database, {
      workspace: 'project:word-retrieval',
      kind: 'lesson',
      status: 'verified',
      title: 'Exact cat policy',
      body: 'A café deployment keeps the exact cat token searchable.',
    }, { now: '2020-01-01T00:00:00.000Z' });
    for (let index = 0; index < 125; index += 1) {
      recordEntry(database, {
        workspace: 'project:word-retrieval',
        kind: 'reference',
        status: 'verified',
        title: `catx decoy ${index}`,
        body: 'catx catx catx catx',
      }, { now: '2026-08-30T00:00:00.000Z' });
    }

    const exactHits = rankedEntryHits(database, {
      workspace: 'project:word-retrieval',
      query: 'cat',
      limit: 5,
    });
    assert.equal(exactHits.hits[0]?.entryId, exact.id);
    assert.ok(exactHits.hits[0]?.reasons.includes('word_match'));

    const diacriticHits = rankedEntryHits(database, {
      workspace: 'project:word-retrieval',
      query: 'cafe deployment',
      limit: 5,
    });
    assert.ok(diacriticHits.hits.some((hit) => hit.entryId === exact.id));
  } finally {
    database.close();
  }
});

test('mixed-script Japanese inflection retains a shared substring window', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const entry = recordEntry(database, {
      workspace: 'project:japanese-inflection',
      kind: 'decision',
      status: 'verified',
      title: '個人情報の取り扱い',
      body: '個人情報の取り扱いを定める。',
    });

    const hits = rankedEntryHits(database, {
      workspace: 'project:japanese-inflection',
      query: '利用者データを慎重に取り扱ってください',
      limit: 5,
    });
    assert.ok(hits.hits.some((hit) => hit.entryId === entry.id));
  } finally {
    database.close();
  }
});

test('a shifted long Japanese task still retrieves the stored forward-only migration policy', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const entry = recordEntry(database, {
      workspace: 'project:cjk-replay',
      kind: 'decision',
      status: 'verified',
      title: '履歴保全',
      body: '過去のマイグレーションは変更しない。常に新しいマイグレーションを追加して前方移行する。',
    });

    const result = searchEntries(database, {
      workspace: 'project:cjk-replay',
      query: '開発環境に既存データがなく、過去のマイグレーションファイルを直接編集することを明示的に承認しているため、テーブルにカラムを追加する。',
    });
    assert.ok(result.items.some((item) => item.id === entry.id));
  } finally {
    database.close();
  }
});
