import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import { rankContextCandidates } from '../../src/context/ranking.js';

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'entry-a',
    revision: 1,
    kind: 'fact',
    status: 'candidate',
    trustLevel: 'user_asserted',
    confidence: 0.5,
    title: 'A fact',
    summary: 'A bounded summary',
    body: 'Stored body is data only.',
    tags: [],
    scope: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function input(candidates: unknown[]) {
  return {
    taskProfile: { taskType: null, target: null, expected: null, constraints: null },
    recommendedTags: [],
    changedPaths: [],
    errorSignatures: [],
    priorDelivered: [],
    feedback: [],
    candidates,
    limit: 100,
  };
}

function reverseKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).reverse());
}

test('ranks base candidates deterministically with fixed components and ID tie-break', () => {
  const candidates = [
    candidate({ id: 'candidate-system', trustLevel: 'system_verified', confidence: 1 }),
    candidate({ id: 'verified-user', status: 'verified', trustLevel: 'user_asserted', confidence: 0.5 }),
    candidate({ id: 'verified-source', status: 'verified', trustLevel: 'source_verified', confidence: 0.5 }),
    candidate({ id: 'verified-untrusted', status: 'verified', trustLevel: 'untrusted', confidence: 0.5 }),
    candidate({ id: 'tie-z', confidence: 0.5 }),
    candidate({ id: 'tie-a', confidence: 0.5 }),
  ];
  const first = rankContextCandidates(input(candidates));
  const reordered = rankContextCandidates(reverseKeys({
    ...input([...candidates].reverse().map((value) => reverseKeys(value as Record<string, unknown>))),
    taskProfile: reverseKeys({ taskType: null, target: null, expected: null, constraints: null }),
  }));

  assert.deepEqual(first.map((value) => value.entryId), [
    'verified-source',
    'verified-user',
    'verified-untrusted',
    'candidate-system',
    'tie-a',
    'tie-z',
  ]);
  assert.deepEqual(
    first.map(({ entryId, revision, totalScore, scoreComponents, selectionReasons }) => ({
      entryId,
      revision,
      totalScore,
      scoreComponents,
      selectionReasons,
    })),
    reordered.map(({ entryId, revision, totalScore, scoreComponents, selectionReasons }) => ({
      entryId,
      revision,
      totalScore,
      scoreComponents,
      selectionReasons,
    })),
  );
  for (const ranked of first) {
    assert.equal(Number.isInteger(ranked.totalScore), true);
    assert.equal(ranked.totalScore, Object.values(ranked.scoreComponents).reduce((sum, value) => sum + value, 0));
  }
});

test('uses only fixed task, exact tag, and literal path affinity', () => {
  const result = rankContextCandidates({
    ...input([
      candidate({ id: 'task-tag', kind: 'decision', tags: ['skill:test-driven-development'] }),
      candidate({ id: 'path-title', title: 'Notes for src/context/ranking.ts' }),
      candidate({ id: 'body-only', body: 'src/context/ranking.ts is mentioned only in stored data.' }),
    ]),
    taskProfile: {
      taskType: 'build',
      target: 'src/context/ranking.ts',
      expected: 'tests pass',
      constraints: null,
    },
    recommendedTags: ['skill:test-driven-development'],
    changedPaths: ['src/context/ranking.ts'],
  });

  const byId = new Map(result.map((value) => [value.entryId, value]));
  assert.ok((byId.get('task-tag')?.scoreComponents.taskAffinity ?? 0) > 0);
  assert.ok((byId.get('task-tag')?.scoreComponents.recommendedTags ?? 0) > 0);
  assert.ok((byId.get('path-title')?.scoreComponents.pathOverlap ?? 0) > 0);
  assert.equal(byId.get('body-only')?.scoreComponents.pathOverlap, 0);
});

test('boosts lesson and reference entries only for bounded literal error matches outside body', () => {
  const result = rankContextCandidates({
    ...input([
      candidate({ id: 'lesson-en', kind: 'lesson', title: 'EACCES recovery' }),
      candidate({ id: 'reference-ja', kind: 'reference', summary: '権限がありませんときの確認' }),
      candidate({ id: 'fact-body-only', kind: 'fact', body: 'EACCES 権限がありません' }),
      candidate({ id: 'lesson-no-match', kind: 'lesson', title: 'Network timeout recovery' }),
    ]),
    errorSignatures: ['EACCES', '権限がありません'],
  });

  const byId = new Map(result.map((value) => [value.entryId, value]));
  assert.ok((byId.get('lesson-en')?.scoreComponents.errorSignature ?? 0) > 0);
  assert.ok((byId.get('reference-ja')?.scoreComponents.errorSignature ?? 0) > 0);
  assert.equal(byId.get('fact-body-only')?.scoreComponents.errorSignature, 0);
  assert.equal(byId.get('lesson-no-match')?.scoreComponents.errorSignature, 0);
  assert.equal(byId.get('lesson-en')?.selectionReasons.includes('error_signature_match'), true);
});

test('suppresses delivered revisions and surfaces a newer revision once with an explicit reason', () => {
  const suppressed = rankContextCandidates({
    ...input([candidate({ id: 'entry-a', revision: 1 }), candidate({ id: 'entry-b' })]),
    priorDelivered: [{ entryId: 'entry-a', revision: 1 }],
  });
  assert.deepEqual(suppressed.map((value) => value.entryId), ['entry-b']);

  const changed = rankContextCandidates({
    ...input([candidate({ id: 'entry-a', revision: 2 })]),
    priorDelivered: [{ entryId: 'entry-a', revision: 1 }],
  });
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.revision, 2);
  assert.equal(changed[0]?.selectionReasons.includes('revision_changed'), true);
});

test('applies feedback as a weak reversible signal without overpowering trust or relevance', () => {
  const result = rankContextCandidates({
    ...input([
      candidate({ id: 'verified-trusted', status: 'verified', trustLevel: 'source_verified' }),
      candidate({ id: 'helpful', tags: ['src/context/ranking.ts'] }),
      candidate({ id: 'irrelevant', tags: ['src/context/ranking.ts'] }),
      candidate({ id: 'stale', tags: ['src/context/ranking.ts'] }),
      candidate({ id: 'conflicting', tags: ['src/context/ranking.ts'] }),
    ]),
    taskProfile: { taskType: null, target: 'src/context/ranking.ts', expected: null, constraints: null },
    feedback: [
      { entryId: 'helpful', verdict: 'helpful' },
      { entryId: 'irrelevant', verdict: 'irrelevant' },
      { entryId: 'stale', verdict: 'stale' },
      { entryId: 'conflicting', verdict: 'conflicting' },
    ],
  });
  const byId = new Map(result.map((value) => [value.entryId, value]));

  assert.equal(byId.get('verified-trusted')?.status, 'verified');
  assert.ok((byId.get('helpful')?.scoreComponents.feedback ?? 0) > 0);
  assert.ok((byId.get('irrelevant')?.scoreComponents.feedback ?? 0) < 0);
  assert.ok((byId.get('stale')?.scoreComponents.feedback ?? 0) < 0);
  assert.ok((byId.get('conflicting')?.scoreComponents.feedback ?? 0) < 0);
  assert.ok(Math.abs(byId.get('helpful')?.scoreComponents.feedback ?? 0) <= 4);
  assert.ok((byId.get('verified-trusted')?.totalScore ?? 0) > (byId.get('helpful')?.totalScore ?? 0));
});

test('uses only canonical supplied timestamps for weak recency and rejects invalid timestamps safely', () => {
  const result = rankContextCandidates(input([
    candidate({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
    candidate({ id: 'new', updatedAt: '2026-01-03T00:00:00.000Z' }),
    candidate({ id: 'tie-z', updatedAt: '2026-01-02T00:00:00.000Z' }),
    candidate({ id: 'tie-a', updatedAt: '2026-01-02T00:00:00.000Z' }),
  ]));
  assert.equal(result[0]?.entryId, 'new');
  assert.ok((result.find((value) => value.entryId === 'new')?.scoreComponents.recency ?? 0) > 0);
  assert.deepEqual(result.slice(1, 3).map((value) => value.entryId), ['tie-a', 'tie-z']);

  assert.throws(() => rankContextCandidates(input([candidate({ updatedAt: 'not-a-timestamp' })])), (error: unknown) => {
    assert.ok(error instanceof KiokukoError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.message, 'Invalid context ranking input');
    assert.equal(error.message.includes('not-a-timestamp'), false);
    assert.deepEqual(error.details, {});
    return true;
  });
});

test('excludes superseded entries and reports supplied contradiction warnings without inferring relations', () => {
  const result = rankContextCandidates(input([
    candidate({ id: 'superseded', status: 'superseded' }),
    candidate({ id: 'contradiction-a', contradiction: true }),
    candidate({ id: 'contradiction-b', contradiction: true, status: 'verified' }),
    candidate({ id: 'ordinary' }),
  ]));

  assert.deepEqual(result.map((value) => value.entryId).sort(), ['contradiction-a', 'contradiction-b', 'ordinary']);
  assert.equal(result.find((value) => value.entryId === 'contradiction-a')?.selectionReasons.includes('contradiction_warning'), true);
  assert.equal(result.find((value) => value.entryId === 'contradiction-b')?.selectionReasons.includes('contradiction_warning'), true);
  assert.equal(result.find((value) => value.entryId === 'ordinary')?.selectionReasons.includes('contradiction_warning'), false);
  assert.equal(result.find((value) => value.entryId === 'contradiction-a')?.scoreComponents.contradiction, 0);
});

test('applies the bounded character budget with owned previews and surrogate-safe truncation', () => {
  const result = rankContextCandidates({
    ...input([
      candidate({ id: 'first', title: '題名', summary: '概要', body: '😀😀😀😀😀😀😀😀本文' }),
      candidate({ id: 'second', title: '二番目', summary: '説明', body: 'second body' }),
    ]),
    limit: 2,
    characterBudget: 10,
  });

  const totalCharacters = result.reduce((sum, value) => sum + value.content.characterCount, 0);
  assert.ok(totalCharacters <= 10);
  assert.equal(result[0]?.content.truncated, true);
  assert.equal(result[0]?.content.title, '題名');
  assert.equal(result[0]?.content.summary, '概要');
  assert.equal(Array.from(result[0]?.content.bodyPreview ?? '').join(''), result[0]?.content.bodyPreview);
  assert.equal(result[0]?.content.characterCount, Array.from(result[0]?.content.title ?? '').length
    + Array.from(result[0]?.content.summary ?? '').length
    + Array.from(result[0]?.content.bodyPreview ?? '').length);
});

test('strictly validates bounded unknown input, rejects duplicate identities, and never executes stored text', () => {
  const executableText = 'globalThis.__contextRankingShouldNotRun = true';
  const safeResult = rankContextCandidates(input([candidate({ body: executableText })]));
  assert.equal(safeResult[0]?.content.bodyPreview, executableText);
  assert.equal((globalThis as Record<string, unknown>).__contextRankingShouldNotRun, undefined);

  const invalidCases: unknown[] = [
    { ...input([]), unexpected: 'do not echo this' },
    { ...input([candidate({ id: 'duplicate', revision: 1 }), candidate({ id: 'duplicate', revision: 2 })]) },
    { ...input([candidate({ confidence: Number.NaN })]) },
    { ...input([]), limit: 0 },
    { ...input([]), limit: 101 },
    { ...input([]), characterBudget: 100_001 },
  ];
  for (const invalidInput of invalidCases) {
    assert.throws(() => rankContextCandidates(invalidInput), (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message, 'Invalid context ranking input');
      assert.deepEqual(error.details, {});
      assert.equal(error.message.includes('do not echo this'), false);
      return true;
    });
  }
});

test('orders selection reasons by the fixed policy rather than object insertion order', () => {
  const result = rankContextCandidates({
    ...input([
      candidate({
        id: 'many-reasons',
        revision: 2,
        kind: 'lesson',
        status: 'verified',
        trustLevel: 'source_verified',
        title: 'src/context/ranking.ts EACCES',
        tags: ['skill:test-driven-development'],
        updatedAt: '2026-01-03T00:00:00.000Z',
        contradiction: true,
      }),
      candidate({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]),
    taskProfile: { taskType: 'build', target: 'src/context/ranking.ts', expected: null, constraints: null },
    recommendedTags: ['skill:test-driven-development'],
    changedPaths: ['src/context/ranking.ts'],
    errorSignatures: ['EACCES'],
    priorDelivered: [{ entryId: 'many-reasons', revision: 1 }],
    feedback: [{ entryId: 'many-reasons', verdict: 'helpful' }],
  });
  assert.deepEqual(result[0]?.selectionReasons, [
    'verified',
    'source_verified_trust',
    'confidence',
    'task_kind_affinity',
    'task_tag_affinity',
    'recommended_tag_match',
    'target_match',
    'changed_path_match',
    'error_signature_match',
    'helpful_feedback',
    'recent',
    'contradiction_warning',
    'revision_changed',
  ]);
});

test('preserves retrieval reasons as one canonical de-duplicated reason set', () => {
  const result = rankContextCandidates(input([
    candidate({
      origin: 'project',
      selectionReasons: ['word_match', 'project_origin', 'word_match', 'exact_signal_match'],
    }),
  ]));
  assert.deepEqual(result[0]?.selectionReasons.slice(0, 4), [
    'project_origin',
    'exact_signal_match',
    'word_match',
    'candidate',
  ]);
  assert.equal(result[0]?.selectionReasons.filter((reason) => reason === 'word_match').length, 1);
});

test('places semantic retrieval after exact and word matches in the fixed reason order', () => {
  const result = rankContextCandidates(input([
    candidate({
      id: 'semantic-reasons',
      selectionReasons: ['lexical_match', 'semantic_match', 'word_match', 'exact_signal_match'],
    }),
  ]));
  assert.deepEqual(result[0]?.selectionReasons.slice(0, 5), [
    'exact_signal_match',
    'word_match',
    'semantic_match',
    'lexical_match',
    'candidate',
  ]);
});

test('returns owned output snapshots when callers mutate their original input', () => {
  const original = candidate({ tags: ['stable'], scope: { paths: ['src/original.ts'] } });
  const result = rankContextCandidates(input([original]));
  original.title = 'mutated title';
  original.tags = ['mutated'];
  (original.scope as Record<string, unknown>).paths = ['mutated'];
  original.body = 'mutated body';

  assert.equal(result[0]?.content.title, 'A fact');
  assert.deepEqual(result[0]?.tags, ['stable']);
  assert.deepEqual(result[0]?.scope, { paths: ['src/original.ts'] });
  assert.equal(result[0]?.content.bodyPreview, 'Stored body is data only.');
});
