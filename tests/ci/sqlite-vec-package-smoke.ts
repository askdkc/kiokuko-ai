import assert from 'node:assert/strict';
import { detectSqliteVecCapability } from '../../src/db/capabilities.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { openEmbeddingDatabase } from '../../src/embedding/backend.js';
import {
  createSqliteVecLoader,
  SQLITE_VEC_EXTENSION_VERSION,
} from '../../src/embedding/sqlite-vec-loader.js';
import { SqliteVecVectorSearchBackend } from '../../src/embedding/sqlite-vec-backend.js';
import { JavaScriptVectorSearchBackend } from '../../src/embedding/javascript-backend.js';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { buildEmbeddingDocumentForProfile } from '../../src/embedding/document.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { activateLocalEmbeddingProfile, upsertEntryEmbedding } from '../../src/embedding/store.js';
import { recordEntry } from '../../src/memory/entries.js';

const timestamp = '2026-08-30T00:00:00.000Z';

function profile() {
  return createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
}

function config() {
  return requireEnabledEmbeddingConfig(parseEmbeddingConfig({
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_VECTOR_BACKEND: 'sqlite-vec',
  }));
}

function vector(first: number, second: number): number[] {
  const result = new Array<number>(384).fill(0);
  result[0] = first;
  result[1] = second;
  return result;
}

async function main(): Promise<void> {
  const loader = await createSqliteVecLoader();
  if (loader === null) {
    if (process.env.KIOKUKO_REQUIRE_SQLITE_VEC_SMOKE === '1') {
      throw new Error('sqlite-vec package or native extension is required for this smoke job');
    }
    process.stdout.write('sqlite-vec package or native extension is unavailable; smoke skipped.\n');
    return;
  }

  const opened = await openEmbeddingDatabase(':memory:', {
    config: config(),
    createLoader: async () => loader,
  });
  const database = opened.database;
  try {
    assert.equal(opened.backend?.id, 'sqlite-vec');
    assert.deepEqual(detectSqliteVecCapability(database), {
      id: 'sqlite-vec',
      available: true,
      version: SQLITE_VEC_EXTENSION_VERSION,
    });
    assert.throws(
      () => database.prepare('SELECT load_extension(?)').get('sqlite-vec'),
      'extension loading must be disabled after the known extension is loaded',
    );

    migrateDatabase(database);
    const active = profile();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entries = [
      recordEntry(database, { workspace: 'project:sqlite-vec-smoke', kind: 'lesson', title: 'Nearest', body: 'Nearest vector.' }, { idFactory: () => 'entry-nearest', now: timestamp }),
      recordEntry(database, { workspace: 'project:sqlite-vec-smoke', kind: 'lesson', title: 'Middle', body: 'Middle vector.' }, { idFactory: () => 'entry-middle', now: timestamp }),
      recordEntry(database, { workspace: 'project:sqlite-vec-smoke', kind: 'lesson', title: 'Farthest', body: 'Farthest vector.' }, { idFactory: () => 'entry-farthest', now: timestamp }),
    ];
    const vectors: readonly (readonly number[])[] = [
      vector(1, 0),
      vector(Math.SQRT1_2, Math.SQRT1_2),
      vector(0, 1),
    ];
    for (const [index, entry] of entries.entries()) {
      const documentHash = buildEmbeddingDocumentForProfile({
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        body: entry.body,
        tags: entry.tags,
        scope: entry.scope,
      }, active.identity).documentHash;
      upsertEntryEmbedding(database, {
        entryId: entry.id,
        profileId: active.profileId,
        revision: entry.revision,
        contentHash: entry.contentHash,
        documentHash,
        vector: vectors[index]!,
        createdAt: timestamp,
      });
    }

    const input = {
      profileId: active.profileId,
      dimensions: 384,
      queryVector: new Float32Array(vector(1, 0)),
      distanceCeiling: 1.1,
      workspace: 'project:sqlite-vec-smoke',
      limit: 3,
    } as const;
    const nativeHits = new SqliteVecVectorSearchBackend().search(database, input);
    const javascriptHits = new JavaScriptVectorSearchBackend().search(database, input);
    assert.deepEqual(nativeHits.map((hit) => hit.entryId), javascriptHits.map((hit) => hit.entryId));
    assert.equal(nativeHits.length, 3);
    for (const [index, nativeHit] of nativeHits.entries()) {
      assert.ok(Number.isFinite(nativeHit.distance));
      assert.ok(Math.abs(nativeHit.distance - javascriptHits[index]!.distance) < 1e-5);
    }
  } finally {
    database.close();
  }
}

await main();
