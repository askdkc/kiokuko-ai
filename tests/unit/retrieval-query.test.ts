import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRetrievalQuery } from '../../src/memory/retrieval-query.js';

test('splits long CJK runs into bounded overlapping windows without changing lexical terms', () => {
  const task = '開発環境に既存データがなく、過去のマイグレーションファイルを直接編集することを明示的に承認しているため、テーブルにカラムを追加する。';
  const parsed = parseRetrievalQuery(task);

  assert.ok(parsed.substringTerms.includes('マイグ'));
  assert.ok(parsed.substringTerms.includes('ション'));
  assert.ok(parsed.substringTerms.every((term) => Array.from(term).length <= 512));
  assert.ok(parsed.substringTerms.length <= 64);
  assert.ok(parsed.lexicalTerms.includes('開発環境に既存データがなく'));
});

test('allocates CJK windows across runs instead of letting the first run consume the budget', () => {
  const parsed = parseRetrievalQuery(`${'甲'.repeat(200)} ASCII ${'マイグレーション'.repeat(4)}`);

  assert.ok(parsed.substringTerms.some((term) => term === '甲甲甲'));
  assert.ok(parsed.substringTerms.some((term) => term === 'マイグ'));
  assert.ok(parsed.substringTerms.some((term) => term === 'ション'));
});

test('allocates two, three, and four character windows for one Japanese run', () => {
  const parsed = parseRetrievalQuery('マイグレーション');

  assert.ok(parsed.substringTerms.includes('マイ'));
  assert.ok(parsed.substringTerms.includes('マイグ'));
  assert.ok(parsed.substringTerms.includes('マイグレ'));
});

test('keeps windows across Han and Hiragana boundaries', () => {
  const parsed = parseRetrievalQuery('取り扱って');

  assert.ok(parsed.substringTerms.includes('取り扱'));
});
