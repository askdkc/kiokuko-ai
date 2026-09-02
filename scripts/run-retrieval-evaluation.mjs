import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repositoryRoot, 'tests', 'fixtures', 'retrieval-evaluation');

function jsonLines(text, label) {
  return text.split(/\r?\n/u).filter((line) => line.length > 0).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label} line ${index + 1} is not valid JSON`);
    }
  });
}

function vectorForKey(key, dimensions) {
  const values = new Float32Array(dimensions);
  let offset = 0;
  let block = 0;
  while (offset < dimensions) {
    const bytes = createHash('sha256').update(`${key}\u0000${block}`, 'utf8').digest();
    for (const byte of bytes) {
      if (offset >= dimensions) break;
      values[offset] = (byte - 127.5) / 127.5;
      offset += 1;
    }
    block += 1;
  }
  return values;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

const memories = jsonLines(await readFile(path.join(fixtureRoot, 'memories.jsonl'), 'utf8'), 'memories.jsonl');
const queryGroups = jsonLines(await readFile(path.join(fixtureRoot, 'queries.jsonl'), 'utf8'), 'queries.jsonl');
const expected = JSON.parse(await readFile(path.join(fixtureRoot, 'expected.json'), 'utf8'));
const entryIdBySemanticKey = new Map(memories.map((memory) => [memory.semanticKey, memory.id]));
const queries = queryGroups.flatMap((group) => group.variants.map(([text, category], index) => ({
  id: `${group.id}-${index + 1}`,
  workspace: group.workspace,
  expected: group.expected,
  semanticKey: group.semanticKey,
  text,
  category,
})));

assert.ok(queries.length >= expected.minimumQueryCount, `evaluation requires at least ${expected.minimumQueryCount} queries`);

const {
  openConnection,
} = await import('../dist/db/connection.js');
const { migrateDatabase } = await import('../dist/db/migrate.js');
const { parseEmbeddingConfig, requireEnabledEmbeddingConfig } = await import('../dist/embedding/config.js');
const { createLocalEmbeddingProfile } = await import('../dist/embedding/profile.js');
const { activateLocalEmbeddingProfile, upsertEntryEmbedding } = await import('../dist/embedding/store.js');
const { LOCAL_SMALL_PRESET } = await import('../dist/embedding/presets/local-small.js');
const { buildEmbeddingDocumentForProfile } = await import('../dist/embedding/document.js');
const { JavaScriptVectorSearchBackend } = await import('../dist/embedding/javascript-backend.js');
const { hashVector } = await import('../dist/embedding/vector.js');
const { recordEntry, updateCandidateEntry } = await import('../dist/memory/entries.js');
const { supersedeEntry } = await import('../dist/memory/lifecycle.js');
const { buildStructuredScope } = await import('../dist/memory/structured-memory.js');
const { hybridSearch } = await import('../dist/memory/hybrid-retrieval.js');

const dimensions = 384;
const timestamp = '2026-08-31T00:00:00.000Z';
const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig({
  KIOKUKO_EMBEDDINGS: 'optional',
  KIOKUKO_VECTOR_BACKEND: 'javascript',
}));
const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
const backend = new JavaScriptVectorSearchBackend();
const database = openConnection(':memory:');

try {
  migrateDatabase(database);
  activateLocalEmbeddingProfile(database, profile, { replace: false, now: timestamp });
  const inserted = new Map();
  for (const memory of memories) {
    const scope = buildStructuredScope({
      visibility: memory.workspace === 'global' ? 'global' : 'project',
      retrievalScope: memory.workspace === 'global'
        ? 'global'
        : memory.workspace.startsWith('ecosystem:') ? 'ecosystem' : 'project-only',
      memoryClass: 'troubleshooting',
      ...(memory.workspace === 'global' ? { portableReason: 'Cross-project evaluation fixture.' } : {}),
      ...(memory.workspace.startsWith('ecosystem:')
        ? { applicability: { tools: [memory.workspace.slice('ecosystem:'.length)] } }
        : {}),
      signals: memory.signals,
    });
    const entry = recordEntry(database, {
      workspace: memory.workspace,
      kind: memory.kind,
      title: memory.title,
      body: memory.body,
      tags: memory.tags,
      scope,
      createdBy: 'retrieval-evaluation',
    }, { idFactory: () => memory.id, now: timestamp });
    inserted.set(memory.id, entry);
    const vector = vectorForKey(memory.semanticKey, dimensions);
    const documentHash = buildEmbeddingDocumentForProfile({
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      body: entry.body,
      tags: entry.tags,
      scope: entry.scope,
    }, profile.identity).documentHash;
    upsertEntryEmbedding(database, {
      entryId: entry.id,
      profileId: profile.profileId,
      revision: entry.revision,
      contentHash: entry.contentHash,
      documentHash,
      vector,
      createdAt: timestamp,
    });
  }

  for (const memory of memories) {
    if (memory.state === 'stale') {
      const entry = inserted.get(memory.id);
      updateCandidateEntry(database, {
        workspace: memory.workspace,
        entryId: memory.id,
        expectedRevision: entry.revision,
        kind: memory.kind,
        title: `${memory.title} updated`,
        body: 'The current revision intentionally has no completed vector.',
        tags: memory.tags,
        scope: buildStructuredScope({
          visibility: 'project',
          retrievalScope: 'project-only',
          memoryClass: 'troubleshooting',
          signals: memory.signals,
        }),
        createdBy: 'retrieval-evaluation',
        now: '2026-08-31T00:00:01.000Z',
      });
    } else if (memory.state === 'superseded') {
      supersedeEntry(database, {
        workspace: memory.workspace,
        oldEntryId: memory.id,
        replacementEntryId: memory.supersededBy,
        expectedRevision: 1,
        now: '2026-08-31T00:00:01.000Z',
      });
    }
  }

  let recallAt1Hits = 0;
  let recallAt5Hits = 0;
  let reciprocalRank = 0;
  let exactHits = 0;
  let exactCount = 0;
  let semanticOnlyHits = 0;
  let semanticOnlyBaselineHits = 0;
  let semanticOnlyCount = 0;
  let scopeLeakageCount = 0;
  let falseNegativeDeliveryCount = 0;
  let positiveCount = 0;
  const misses = [];

  for (const query of queries) {
    const baseline = hybridSearch(database, {
      workspace: query.workspace,
      query: query.text,
      limit: 5,
    });
    const queryVector = vectorForKey(query.semanticKey, dimensions);
    const semantic = hybridSearch(database, {
      workspace: query.workspace,
      query: query.text,
      limit: 5,
    }, {
      semantic: {
        backend,
        query: {
          profileId: profile.profileId,
          dimensions,
          vector: queryVector,
          vectorHash: hashVector(queryVector),
          backendId: backend.id,
          distanceCeiling: profile.identity.distanceCeiling,
        },
      },
    });
    if (process.env.KIOKUKO_EVALUATION_DEBUG === '1' && query.id.startsWith('q-node-runtime')) {
      process.stderr.write(`${JSON.stringify({ id: query.id, baseline: baseline.map((hit) => hit.entryId), semantic: semantic.map((hit) => [hit.entryId, hit.laneRanks]) })}\n`);
    }

    for (const hit of semantic) {
      const workspace = database.prepare('SELECT workspace FROM entries WHERE id = ?').get(hit.entryId)?.workspace;
      if (workspace !== query.workspace) scopeLeakageCount += 1;
    }

    if (query.expected === null) {
      const forbiddenEntryId = entryIdBySemanticKey.get(query.semanticKey);
      if (semantic.some((hit) => hit.entryId === forbiddenEntryId && hit.laneRanks.semantic !== undefined)) {
        falseNegativeDeliveryCount += 1;
      }
      continue;
    }
    positiveCount += 1;
    const rank = semantic.findIndex((hit) => hit.entryId === query.expected) + 1;
    const baselineRank = baseline.findIndex((hit) => hit.entryId === query.expected) + 1;
    if (rank === 1) recallAt1Hits += 1;
    if (rank > 0 && rank <= 5) recallAt5Hits += 1;
    if (rank === 0 || rank > 5) misses.push({ id: query.id, category: query.category, rank });
    if (rank > 0) reciprocalRank += 1 / rank;
    if (query.category === 'exact_identifier') {
      exactCount += 1;
      if (rank === 1) exactHits += 1;
    }
    if (query.category === 'semantic_only') {
      semanticOnlyCount += 1;
      if (rank > 0 && rank <= 5) semanticOnlyHits += 1;
      if (baselineRank > 0 && baselineRank <= 5) semanticOnlyBaselineHits += 1;
    }
  }

  const metrics = {
    queryCount: queries.length,
    positiveQueryCount: positiveCount,
    recallAt1: ratio(recallAt1Hits, positiveCount),
    recallAt5: ratio(recallAt5Hits, positiveCount),
    mrr: ratio(reciprocalRank, positiveCount),
    exactIdentifierRecallAt1: ratio(exactHits, exactCount),
    semanticOnlyRecallAt5: ratio(semanticOnlyHits, semanticOnlyCount),
    semanticOnlyBaselineRecallAt5: ratio(semanticOnlyBaselineHits, semanticOnlyCount),
    semanticOnlyImprovement: ratio(semanticOnlyHits - semanticOnlyBaselineHits, semanticOnlyCount),
    scopeLeakageCount,
    falseNegativeDeliveryCount,
  };

  assert.ok(metrics.recallAt1 >= expected.minimumRecallAt1, `Recall@1 gate failed: ${metrics.recallAt1}`);
  assert.ok(metrics.recallAt5 >= expected.minimumRecallAt5, `Recall@5 gate failed: ${metrics.recallAt5}; misses=${JSON.stringify(misses)}`);
  assert.ok(metrics.exactIdentifierRecallAt1 >= expected.minimumExactIdentifierRecallAt1, `exact identifier Recall@1 gate failed: ${metrics.exactIdentifierRecallAt1}`);
  assert.ok(metrics.semanticOnlyRecallAt5 >= expected.minimumSemanticOnlyRecallAt5, `semantic-only Recall@5 gate failed: ${metrics.semanticOnlyRecallAt5}`);
  assert.ok(metrics.semanticOnlyImprovement >= expected.minimumSemanticOnlyImprovement, `semantic-only improvement gate failed: ${metrics.semanticOnlyImprovement}`);
  assert.ok(metrics.scopeLeakageCount <= expected.maximumScopeLeakageCount, `scope leakage gate failed: ${metrics.scopeLeakageCount}`);
  assert.ok(metrics.falseNegativeDeliveryCount <= expected.maximumFalseNegativeDeliveryCount, `stale or superseded delivery gate failed: ${metrics.falseNegativeDeliveryCount}`);

  process.stdout.write(`${JSON.stringify({
    evaluationVersion: 1,
    backend: backend.id,
    dimensions,
    distanceCeiling: profile.identity.distanceCeiling,
    semanticWeight: 2.5,
    metrics,
    misses,
    gates: expected,
  }, null, 2)}\n`);
} finally {
  database.close();
}
