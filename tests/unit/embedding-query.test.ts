import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import {
  MAX_QUERY_TEXT_BYTES,
  QueryEmbeddingSingleFlight,
  queryEmbeddingCacheKey,
  queryEmbeddingHash,
  queryEmbeddingHashForProfile,
  renderEmbeddingQueryInput,
  renderEmbeddingQueryInputForProfile,
} from '../../src/embedding/query-cache.js';

test('renders the E5 query prefix after canonical normalization', () => {
  assert.equal(renderEmbeddingQueryInput('  二重実行\r\n  '), 'query: 二重実行');
  assert.match(queryEmbeddingHash('same'), /^[0-9a-f]{64}$/u);
  assert.notEqual(queryEmbeddingHash('same'), queryEmbeddingHash('different'));
});

test('rejects an unsupported provider prefix and oversized/control query', () => {
  assert.throws(() => renderEmbeddingQueryInput('query', 'passage: '), { code: 'VALIDATION_ERROR' });
  assert.throws(() => renderEmbeddingQueryInput('bad\u0000query'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => renderEmbeddingQueryInput('x'.repeat(MAX_QUERY_TEXT_BYTES)), { code: 'VALIDATION_ERROR' });
});

test('selects the local profile query contract and binds cache identity to generation', () => {
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);

  assert.equal(renderEmbeddingQueryInputForProfile('  同じ query  ', profile.identity), 'query: 同じ query');
  assert.equal(queryEmbeddingHashForProfile('same', profile.identity), queryEmbeddingHash('same'));
  assert.notEqual(
    queryEmbeddingCacheKey({ profileId: 'a'.repeat(64), generation: 1, queryHash: queryEmbeddingHash('same') }),
    queryEmbeddingCacheKey({ profileId: 'a'.repeat(64), generation: 2, queryHash: queryEmbeddingHash('same') }),
  );
});

test('shares one concurrent provider operation for the same cache identity', async () => {
  const flights = new QueryEmbeddingSingleFlight<number>();
  const key = queryEmbeddingCacheKey({ profileId: 'a'.repeat(64), generation: 1, queryHash: queryEmbeddingHash('same') });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const loader = async (): Promise<number> => {
    calls += 1;
    await gate;
    return 384;
  };

  const first = flights.getOrLoad(key, loader);
  const second = flights.getOrLoad(key, loader);
  release();
  const results = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.deepEqual(results, [{ result: 384, hit: false }, { result: 384, hit: true }]);
});
