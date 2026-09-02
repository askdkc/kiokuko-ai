import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { contextRetrievalStateHash, ordinaryContextSelectionStateHash, semanticProjectionSnapshot } from '../../src/context/selection-state.js';
import { buildEmbeddingDocumentForProfile } from '../../src/embedding/document.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { activateLocalEmbeddingProfile, upsertEntryEmbedding } from '../../src/embedding/store.js';
import { JavaScriptVectorSearchBackend } from '../../src/embedding/javascript-backend.js';
import type { HybridSearchRuntime } from '../../src/memory/hybrid-retrieval.js';
import { ensureGlobalWorkspace, resolveProjectWorkspace, type ResolvedProjectWorkspace } from '../../src/memory/workspaces.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { recordEntry, type EntryRecord } from '../../src/memory/entries.js';
import { recallScopedMemory } from '../../src/memory/scoped-memory.js';
import { retrieveFederatedMemory } from '../../src/memory/federated-retrieval.js';
import { rankedEntryHits } from '../../src/memory/retrieval.js';

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

function addVector(database: ReturnType<typeof openConnection>, active: ReturnType<typeof profile>, entry: EntryRecord, vector: readonly number[]): void {
  upsertEntryEmbedding(database, {
    entryId: entry.id,
    profileId: active.profileId,
    revision: entry.revision,
    contentHash: entry.contentHash,
    documentHash: buildEmbeddingDocumentForProfile({
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      body: entry.body,
      tags: entry.tags,
      scope: entry.scope,
    }, active.identity).documentHash,
    vector: embeddingVector(vector),
    createdAt: timestamp,
  });
}

const project: ResolvedProjectWorkspace = {
  repositoryRoot: '/tmp/semantic-retrieval-project',
  repositoryId: 'repo-semantic-retrieval',
  workspace: 'project:semantic-retrieval',
  source: 'location',
};

test('one prepared semantic query is propagated through Project, Global, and scoped retrieval', async () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    ensureGlobalWorkspace(database, timestamp);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const projectEntry = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      title: 'Durable release strategy',
      body: 'Use a bounded rollout with a reversible deployment plan.',
    }, { idFactory: () => 'entry-project-semantic', now: timestamp });
    const globalEntry = recordEntry(database, {
      workspace: 'global',
      kind: 'reference',
      title: 'Global release strategy',
      body: 'A reversible rollout is safer than an unbounded deployment.',
      scope: buildStructuredScope({ visibility: 'global', retrievalScope: 'global', portableReason: 'Shared release reference' }),
    }, { idFactory: () => 'entry-global-semantic', now: timestamp });
    addVector(database, active, projectEntry, [1, 0, 0]);
    addVector(database, active, globalEntry, [1, 0, 0]);
    const prepared = runtime(active);

    const projectResult = await retrieveFederatedMemory(database, {
      project,
      scope: 'project',
      query: 'unrelated paraphrase for rollout',
      limit: 1,
    }, prepared);
    assert.equal(projectResult.project?.memory.items[0]?.id, projectEntry.id);

    const scopedResult = await recallScopedMemory(database, {
      project,
      scope: 'project',
      query: 'another rollout paraphrase',
      limit: 1,
    }, prepared);
    assert.equal(scopedResult.project?.memory.items[0]?.id, projectEntry.id);

    const globalResult = await retrieveFederatedMemory(database, {
      scope: 'global',
      query: 'global rollout paraphrase',
      limit: 1,
    }, prepared);
    assert.equal(globalResult.global?.items[0]?.id, globalEntry.id);
  } finally {
    database.close();
  }
});

test('semantic retrieval discovers a compatible ecosystem workspace without lexical signals', async () => {
  const database = openConnection(':memory:');
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-semantic-source-'));
  const targetRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-semantic-target-'));
  execFileSync('git', ['init', '-q', sourceRoot]);
  execFileSync('git', ['init', '-q', targetRoot]);
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  await writeFile(path.join(targetRoot, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  try {
    migrateDatabase(database);
    const source = await resolveProjectWorkspace(database, sourceRoot);
    const target = await resolveProjectWorkspace(database, targetRoot);
    assert.ok(source);
    assert.ok(target);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entry = recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Durable release guidance',
      body: 'Use a reversible rollout and verify the rollback boundary.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: source.repositoryId,
        applicability: { languages: ['TypeScript'] },
      }),
    }, { idFactory: () => 'entry-semantic-ecosystem-only', now: timestamp });
    // Remove lexical signals to prove that workspace discovery comes from the vector lane.
    database.prepare('DELETE FROM entry_search_signals WHERE entry_id = ?').run(entry.id);
    addVector(database, active, entry, [1, 0, 0]);

    const result = await retrieveFederatedMemory(database, {
      project: target,
      scope: 'ecosystem',
      query: 'unrelated paraphrase for rollout safety',
      limit: 5,
    }, runtime(active));
    const item = result.ecosystem?.items.find((candidate) => candidate.id === entry.id);
    assert.equal(item?.origin, 'ecosystem');
    assert.equal(item?.sourceWorkspace, source.workspace);
    assert.ok(item?.selectionReasons.includes('semantic_match'));
  } finally {
    database.close();
  }
});

test('retrieval state binds semantic projection changes without changing the ordinary capability corpus hash', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entry = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      title: 'Semantic state sentinel',
      body: 'This entry verifies projection state identity.',
    }, { idFactory: () => 'entry-semantic-state', now: timestamp });
    const workspaces = [project.workspace, 'global'];
    const ordinaryBefore = ordinaryContextSelectionStateHash(database, workspaces, { includeEcosystem: true });
    const retrievalBefore = contextRetrievalStateHash(database, workspaces, { includeEcosystem: true });
    addVector(database, active, entry, [1, 0, 0]);
    const ordinaryAfter = ordinaryContextSelectionStateHash(database, workspaces, { includeEcosystem: true });
    const retrievalAfter = contextRetrievalStateHash(database, workspaces, { includeEcosystem: true });
    assert.equal(ordinaryAfter, ordinaryBefore);
    assert.notEqual(retrievalAfter, retrievalBefore);
    assert.deepEqual(semanticProjectionSnapshot(database, entry), {
      activeProfileId: active.profileId,
      embedding: {
        profileId: active.profileId,
        revision: entry.revision,
        contentHash: entry.contentHash,
        documentHash: buildEmbeddingDocumentForProfile({
          kind: entry.kind,
          title: entry.title,
          summary: entry.summary,
          body: entry.body,
          tags: entry.tags,
          scope: entry.scope,
        }, active.identity).documentHash,
        vectorHash: database.prepare('SELECT vector_hash AS vectorHash FROM entry_embeddings WHERE entry_id = ?')
          .get<{ vectorHash: string }>(entry.id)?.vectorHash,
        dimensions: 384,
      },
    });
  } finally {
    database.close();
  }
});

test('feature-off retrieval keeps the lexical baseline unchanged', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const lexical = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      title: 'Lexical deployment note',
      body: 'Deployment requires a checklist.',
    }, { idFactory: () => 'entry-lexical-baseline', now: timestamp });
    const semantic = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      title: 'Paraphrased rollout note',
      body: 'A reversible release procedure.',
    }, { idFactory: () => 'entry-semantic-baseline', now: timestamp });
    addVector(database, active, lexical, [0, 1, 0]);
    addVector(database, active, semantic, [1, 0, 0]);

    const baseline = rankedEntryHits(database, { workspace: project.workspace, query: 'deployment', limit: 10 });
    const explicitFeatureOff = rankedEntryHits(database, { workspace: project.workspace, query: 'deployment', limit: 10 }, {});
    assert.deepEqual(explicitFeatureOff, baseline);
    assert.deepEqual(baseline.hits.map((hit) => hit.entryId), [lexical.id]);
  } finally {
    database.close();
  }
});
