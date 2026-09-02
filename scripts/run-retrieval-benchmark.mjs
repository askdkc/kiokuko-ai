import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const CORPUS_SIZE = 10_000;
const DIMENSIONS = [384];
const SEARCH_RUNS = 25;
const SEARCH_LIMIT = 20;
const timestamp = '2026-08-31T00:00:00.000Z';

const { openConnection } = await import('../dist/db/connection.js');
const { migrateDatabase } = await import('../dist/db/migrate.js');
const { createLocalEmbeddingProfile } = await import('../dist/embedding/profile.js');
const { activateLocalEmbeddingProfile, upsertEntryEmbeddingInTransaction } = await import('../dist/embedding/store.js');
const { createSqliteVecLoader } = await import('../dist/embedding/sqlite-vec-loader.js');
const { JavaScriptVectorSearchBackend } = await import('../dist/embedding/javascript-backend.js');
const { SqliteVecVectorSearchBackend } = await import('../dist/embedding/sqlite-vec-backend.js');
const { recordEntryInTransaction } = await import('../dist/memory/entries.js');

function vectorFor(index, dimensions) {
  const vector = new Float32Array(dimensions);
  vector[0] = 1;
  vector[1 + index % (dimensions - 1)] = ((index % 97) + 1) / 100;
  vector[1 + (index * 31) % (dimensions - 1)] += ((index % 43) + 1) / 100;
  return vector;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function elapsedMilliseconds(operation) {
  const startedAt = performance.now();
  const result = operation();
  return { result, milliseconds: performance.now() - startedAt };
}

function benchmarkBackend(database, backend, profile, dimensions) {
  const queryVector = vectorFor(0, dimensions);
  const input = {
    profileId: profile.profileId,
    dimensions,
    queryVector,
    distanceCeiling: 1.99,
    workspace: `project:benchmark-${dimensions}`,
    limit: SEARCH_LIMIT,
  };
  backend.search(database, input);
  const samples = [];
  let peakRssBytes = process.memoryUsage().rss;
  let firstResult;
  for (let run = 0; run < SEARCH_RUNS; run += 1) {
    const measured = elapsedMilliseconds(() => backend.search(database, input));
    firstResult ??= measured.result.map((hit) => hit.entryId);
    if (measured.result.length !== SEARCH_LIMIT) {
      throw new Error(`${backend.id} returned ${measured.result.length} hits; expected ${SEARCH_LIMIT}`);
    }
    samples.push(measured.milliseconds);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  return {
    backend: backend.id,
    p50Milliseconds: Number(percentile(samples, 0.5).toFixed(3)),
    p95Milliseconds: Number(percentile(samples, 0.95).toFixed(3)),
    peakRssMiB: Number((peakRssBytes / 1024 / 1024).toFixed(1)),
    resultDigest: createHash('sha256').update(JSON.stringify(firstResult)).digest('hex'),
  };
}

const loader = await createSqliteVecLoader();
const results = [];
for (const dimensions of DIMENSIONS) {
  const database = openConnection(':memory:', loader === null ? {} : { sqliteVecLoader: loader });
  try {
    migrateDatabase(database);
    const profile = createLocalEmbeddingProfile();
    activateLocalEmbeddingProfile(database, profile, { replace: false, now: timestamp });

    const setup = elapsedMilliseconds(() => {
      database.exec('BEGIN IMMEDIATE');
      try {
        for (let index = 0; index < CORPUS_SIZE; index += 1) {
          const entry = recordEntryInTransaction(database, {
            workspace: `project:benchmark-${dimensions}`,
            kind: 'lesson',
            title: `Benchmark entry ${index}`,
            body: 'Synthetic deterministic vector-search performance fixture.',
            createdBy: 'retrieval-benchmark',
          }, { idFactory: () => `benchmark-${dimensions}-${String(index).padStart(5, '0')}`, now: timestamp });
          upsertEntryEmbeddingInTransaction(database, {
            entryId: entry.id,
            profileId: profile.profileId,
            revision: entry.revision,
            contentHash: entry.contentHash,
            documentHash: createHash('sha256').update(`document:${entry.id}`).digest('hex'),
            vector: vectorFor(index, dimensions),
            createdAt: timestamp,
          });
        }
        database.prepare('DELETE FROM embedding_jobs').run();
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });

    const backends = [new JavaScriptVectorSearchBackend()];
    if (loader !== null) backends.push(new SqliteVecVectorSearchBackend());
    const measurements = backends.map((backend) => benchmarkBackend(database, backend, profile, dimensions));
    if (measurements.length === 2 && measurements[0].resultDigest !== measurements[1].resultDigest) {
      throw new Error(`backend ranking mismatch at ${dimensions} dimensions`);
    }
    results.push({
      dimensions,
      corpusSize: CORPUS_SIZE,
      setupMilliseconds: Number(setup.milliseconds.toFixed(3)),
      measurements,
    });
  } finally {
    database.close();
  }
}

process.stdout.write(`${JSON.stringify({
  benchmarkVersion: 1,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  searchRuns: SEARCH_RUNS,
  searchLimit: SEARCH_LIMIT,
  providerLatency: 'not measured; database search only',
  nativeBackendAvailable: loader !== null,
  results,
}, null, 2)}\n`);
