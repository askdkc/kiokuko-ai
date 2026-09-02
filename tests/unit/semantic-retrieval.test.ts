import assert from 'node:assert/strict';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { buildEmbeddingDocumentForProfile } from '../../src/embedding/document.js';
import { JavaScriptVectorSearchBackend } from '../../src/embedding/javascript-backend.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { activateLocalEmbeddingProfile, upsertEntryEmbedding } from '../../src/embedding/store.js';
import { hybridSearch, type HybridSearchRuntime } from '../../src/memory/hybrid-retrieval.js';
import { recordEntry, type EntryRecord } from '../../src/memory/entries.js';
import { rankedEntryHits } from '../../src/memory/retrieval.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';

const timestamp = '2026-08-30T00:00:00.000Z';

function profile() {
  return createLocalEmbeddingProfile({ ...LOCAL_SMALL_PRESET, distanceCeiling: 1.1 });
}

function embeddingVector(values: readonly number[]): number[] {
  const result = new Array<number>(384).fill(0);
  values.forEach((value, index) => { result[index] = value; });
  return result;
}

function runtime(active: ReturnType<typeof profile>, vector: readonly number[] = [1, 0, 0]): HybridSearchRuntime {
  const backend = new JavaScriptVectorSearchBackend();
  return {
    semantic: {
      query: {
        profileId: active.profileId,
        dimensions: 384,
        vector: new Float32Array(embeddingVector(vector)),
        vectorHash: 'q'.repeat(64),
        backendId: backend.id,
        distanceCeiling: active.identity.distanceCeiling,
      },
      backend,
    },
  };
}

function documentHash(active: ReturnType<typeof profile>, entry: EntryRecord): string {
  return buildEmbeddingDocumentForProfile({
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: entry.tags,
    scope: entry.scope,
  }, active.identity).documentHash;
}

test('JavaScript semantic search filters stale rows and applies deterministic top-K ordering', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const first = recordEntry(database, {
      workspace: 'project:semantic',
      kind: 'lesson',
      title: 'First semantic result',
      body: 'A semantic result.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-a', now: timestamp });
    const second = recordEntry(database, {
      workspace: 'project:semantic',
      kind: 'lesson',
      title: 'Second semantic result',
      body: 'Another semantic result.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-b', now: timestamp });
    upsertEntryEmbedding(database, {
      entryId: first.id,
      profileId: active.profileId,
      revision: first.revision,
      contentHash: first.contentHash,
      documentHash: documentHash(active, first),
      vector: embeddingVector([0, 1, 0]),
      createdAt: timestamp,
    });
    upsertEntryEmbedding(database, {
      entryId: second.id,
      profileId: active.profileId,
      revision: second.revision,
      contentHash: second.contentHash,
      documentHash: documentHash(active, second),
      vector: embeddingVector([0, -1, 0]),
      createdAt: timestamp,
    });

    const backend = new JavaScriptVectorSearchBackend();
    assert.deepEqual(backend.search(database, {
      profileId: active.profileId,
      dimensions: 384,
      queryVector: new Float32Array(embeddingVector([1, 0, 0])),
      distanceCeiling: 1.1,
      workspace: 'project:semantic',
      limit: 2,
    }), [
      { entryId: 'entry-a', distance: 1 },
      { entryId: 'entry-b', distance: 1 },
    ]);

    database.prepare('UPDATE entry_embeddings SET content_hash = ? WHERE entry_id = ?').run('c'.repeat(64), first.id);
    assert.deepEqual(backend.search(database, {
      profileId: active.profileId,
      dimensions: 384,
      queryVector: new Float32Array(embeddingVector([1, 0, 0])),
      distanceCeiling: 1.1,
      workspace: 'project:semantic',
      limit: 2,
    }), [{ entryId: 'entry-b', distance: 1 }]);
  } finally {
    database.close();
  }
});

test('semantic retrieval is optional and preserves exact-signal precedence', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const exact = recordEntry(database, {
      workspace: 'project:hybrid',
      kind: 'lesson',
      title: 'Structured path guidance',
      body: 'The path-specific rule is authoritative.',
      scope: buildStructuredScope({ visibility: 'project', signals: { paths: ['src/exact.ts'] } }),
    }, { idFactory: () => 'entry-exact', now: timestamp });
    const semantic = recordEntry(database, {
      workspace: 'project:hybrid',
      kind: 'lesson',
      title: 'Paraphrased guidance',
      body: 'Use the durable release procedure.',
    }, { idFactory: () => 'entry-semantic', now: timestamp });
    upsertEntryEmbedding(database, {
      entryId: exact.id,
      profileId: active.profileId,
      revision: exact.revision,
      contentHash: exact.contentHash,
      documentHash: documentHash(active, exact),
      vector: embeddingVector([0, 1, 0]),
      createdAt: timestamp,
    });
    upsertEntryEmbedding(database, {
      entryId: semantic.id,
      profileId: active.profileId,
      revision: semantic.revision,
      contentHash: semantic.contentHash,
      documentHash: documentHash(active, semantic),
      vector: embeddingVector([1, 0, 0]),
      createdAt: timestamp,
    });

    const input = { workspace: 'project:hybrid', query: 'src/exact.ts', limit: 2 } as const;
    assert.deepEqual(rankedEntryHits(database, input).hits.map((hit) => hit.entryId), [exact.id]);
    const candidates = hybridSearch(database, input, runtime(active));
    assert.deepEqual(candidates.map((candidate) => candidate.entryId), [exact.id, semantic.id]);
    assert.ok(candidates[0]?.reasons.includes('exact_signal_match'));
    assert.ok(candidates[1]?.reasons.includes('semantic_match'));
  } finally {
    database.close();
  }
});

test('operator-soup protection preserves exact command signals and the semantic lane', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const command = recordEntry(database, {
      workspace: 'project:command-signal',
      kind: 'lesson',
      title: 'Runtime command',
      body: 'Inspect the current runtime version.',
      scope: buildStructuredScope({ visibility: 'project', signals: { commands: ['node --version'] } }),
    }, { idFactory: () => 'entry-command', now: timestamp });
    const semantic = recordEntry(database, {
      workspace: 'project:command-signal',
      kind: 'lesson',
      title: 'Semantic fallback',
      body: 'A punctuation-heavy query can still have a prepared semantic vector.',
    }, { idFactory: () => 'entry-command-semantic', now: timestamp });
    upsertEntryEmbedding(database, {
      entryId: command.id,
      profileId: active.profileId,
      revision: command.revision,
      contentHash: command.contentHash,
       documentHash: documentHash(active, command),
      vector: embeddingVector([-1, 0, 0]),
      createdAt: timestamp,
    });
    upsertEntryEmbedding(database, {
      entryId: semantic.id,
      profileId: active.profileId,
      revision: semantic.revision,
      contentHash: semantic.contentHash,
       documentHash: documentHash(active, semantic),
      vector: embeddingVector([1, 0, 0]),
      createdAt: timestamp,
    });

    const exact = hybridSearch(database, { workspace: 'project:command-signal', query: 'node --version', limit: 2 });
    assert.deepEqual(exact.map((candidate) => candidate.entryId), [command.id]);
    assert.ok(exact[0]?.reasons.includes('exact_signal_match'));

    const fallback = hybridSearch(
      database,
      { workspace: 'project:command-signal', query: 'unknown --flag', limit: 2 },
      runtime(active),
    );
    assert.deepEqual(fallback.map((candidate) => candidate.entryId), [semantic.id]);
    assert.ok(fallback[0]?.reasons.includes('semantic_match'));
  } finally {
    database.close();
  }
});

test('semantic retrieval fuses with lexical results and supports CJK paraphrases', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const lexical = recordEntry(database, {
      workspace: 'project:fusion',
      kind: 'lesson',
      title: 'Deployment checklist',
      body: 'Verify the deployment checklist before release.',
    }, { idFactory: () => 'entry-lexical', now: timestamp });
    const semantic = recordEntry(database, {
      workspace: 'project:fusion',
      kind: 'lesson',
      title: 'Release rollout guidance',
      body: 'Validate the rollout before publishing.',
    }, { idFactory: () => 'entry-rollout', now: timestamp });
    const cjk = recordEntry(database, {
      workspace: 'project:fusion',
      kind: 'lesson',
      title: '保管手順',
      body: 'データを安全に保管する手順です。',
    }, { idFactory: () => 'entry-cjk', now: timestamp });
    for (const [entry, vector, hash] of [
      [lexical, [0, 1, 0], '1'],
      [semantic, [1, 0, 0], '2'],
      [cjk, [0, 0, 1], '3'],
    ] as const) {
      upsertEntryEmbedding(database, {
        entryId: entry.id,
        profileId: active.profileId,
        revision: entry.revision,
        contentHash: entry.contentHash,
      documentHash: documentHash(active, entry),
      vector: embeddingVector(vector),
        createdAt: timestamp,
      });
    }

    const fused = rankedEntryHits(database, { workspace: 'project:fusion', query: 'deployment', limit: 2 }, runtime(active));
    assert.deepEqual(fused.hits.map((hit) => hit.entryId), [lexical.id, semantic.id]);
    assert.ok(fused.hits[0]?.reasons.includes('word_match'));
    assert.ok(fused.hits[1]?.reasons.includes('semantic_match'));

    const cjkResult = rankedEntryHits(database, { workspace: 'project:fusion', query: '安全な保存', limit: 1 }, runtime(active, [0, 0, 1]));
    assert.equal(cjkResult.hits[0]?.entryId, cjk.id);
    assert.ok(cjkResult.hits[0]?.reasons.includes('semantic_match'));
  } finally {
    database.close();
  }
});

test('corrupt semantic vectors fail closed after lexical filtering', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entry = recordEntry(database, {
      workspace: 'project:corrupt',
      kind: 'lesson',
      title: 'Corrupt vector',
      body: 'The vector must fail closed.',
    }, { idFactory: () => 'entry-corrupt', now: timestamp });
    upsertEntryEmbedding(database, {
      entryId: entry.id,
      profileId: active.profileId,
      revision: entry.revision,
      contentHash: entry.contentHash,
       documentHash: documentHash(active, entry),
      vector: embeddingVector([1, 0, 0]),
      createdAt: timestamp,
    });
    database.prepare('UPDATE entry_embeddings SET document_hash = ? WHERE entry_id = ?').run('e'.repeat(64), entry.id);
    assert.throws(
      () => rankedEntryHits(database, { workspace: 'project:corrupt', query: 'unrelated paraphrase', limit: 1 }, runtime(active)),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    database.prepare('UPDATE entry_embeddings SET document_hash = ? WHERE entry_id = ?').run(documentHash(active, entry), entry.id);
    database.prepare('UPDATE entry_embeddings SET vector_hash = ? WHERE entry_id = ?').run('f'.repeat(64), entry.id);
    assert.throws(
      () => rankedEntryHits(database, { workspace: 'project:corrupt', query: 'unrelated paraphrase', limit: 1 }, runtime(active)),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
  } finally {
    database.close();
  }
});
