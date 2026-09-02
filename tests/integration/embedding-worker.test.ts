import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import {
  activateLocalEmbeddingProfile,
  readEntryEmbedding,
  upsertEntryEmbedding,
} from '../../src/embedding/store.js';
import {
  claimEmbeddingJobs,
  EMBEDDING_JOB_LEASE_MS,
  EMBEDDING_JOB_MAX_ATTEMPTS,
  finalizeEmbeddingJob,
  listEmbeddingJobs,
} from '../../src/embedding/jobs.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createEmbeddingRuntime } from '../../src/embedding/runtime.js';
import { EmbeddingProviderError } from '../../src/embedding/provider.js';
import { recordEntry } from '../../src/memory/entries.js';
import { updateCandidateEntry } from '../../src/memory/entries.js';
import type { EmbeddingProvider } from '../../src/embedding/types.js';
import { DEFAULT_EMBEDDING_WORKER_DEADLINE_MS } from '../../src/embedding/worker.js';
import { KiokukoError } from '../../src/errors.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  return database;
}

function profile(runtimeVersion: string) {
  return createLocalEmbeddingProfile(LOCAL_SMALL_PRESET, runtimeVersion);
}

function localConfig() {
  return {
    mode: 'optional' as const,
    provider: 'local-transformers' as const,
    presetId: 'local-small' as const,
    vectorBackend: 'javascript' as const,
    timeoutMs: 30_000,
    batchSize: 16,
  };
}

function vector(first = 1): Float32Array {
  const value = new Float32Array(384);
  value[0] = first;
  return value;
}

const timestamp = '2026-08-30T00:00:00.000Z';

test('the default job lease outlives the default worker deadline', () => {
  assert.ok(EMBEDDING_JOB_LEASE_MS > DEFAULT_EMBEDDING_WORKER_DEADLINE_MS);
});

test('active profile activation and entry mutation enqueue current jobs atomically', async () => {
  const database = await temporaryDatabase('embedding-jobs');
  try {
    const active = profile('model-a');
    assert.deepEqual(activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp }), {
      profileId: active.profileId,
      generation: 1,
      activated: true,
      enqueued: 0,
    });
    const entry = recordEntry(database, {
      workspace: 'project:jobs',
      kind: 'lesson',
      title: 'Queue this entry',
      body: 'A current entry needs one embedding job.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-jobs', now: timestamp });
    assert.deepEqual(listEmbeddingJobs(database), [{
      entryId: entry.id,
      profileId: active.profileId,
      revision: 1,
      contentHash: entry.contentHash,
      state: 'pending',
      attempts: 0,
      availableAt: timestamp,
      leaseId: null,
      leaseExpiresAt: null,
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspace: 'project:jobs',
    }]);

    const claimed = claimEmbeddingJobs(database, {
      maxJobs: 1,
      now: timestamp,
      leaseIdFactory: () => 'lease-one',
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.leaseId, 'lease-one');
    assert.equal(claimed[0]?.attempts, 1);
    assert.equal(claimed[0]?.state, 'leased');
  } finally {
    database.close();
  }
});

test('expired leases are reclaimed and revision changes reset the current job without deleting old vectors', async () => {
  const database = await temporaryDatabase('embedding-revision');
  try {
    const active = profile('model-a');
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entry = recordEntry(database, {
      workspace: 'project:revision',
      kind: 'lesson',
      title: 'Original title',
      body: 'Original body',
      createdBy: 'test',
    }, { idFactory: () => 'entry-revision', now: timestamp });
    upsertEntryEmbedding(database, {
      entryId: entry.id,
      profileId: active.profileId,
      revision: 1,
      contentHash: entry.contentHash,
      documentHash: 'c'.repeat(64),
      vector: [1, ...new Array<number>(383).fill(0)],
      createdAt: timestamp,
    });
    const firstClaim = claimEmbeddingJobs(database, {
      maxJobs: 1,
      now: timestamp,
      leaseMs: 1_000,
      leaseIdFactory: () => 'lease-expired',
    });
    assert.equal(firstClaim[0]?.state, 'leased');
    const reclaimed = claimEmbeddingJobs(database, {
      maxJobs: 1,
      now: '2026-08-30T00:00:01.001Z',
      leaseIdFactory: () => 'lease-reclaimed',
    });
    assert.equal(reclaimed[0]?.leaseId, 'lease-reclaimed');
    assert.equal(reclaimed[0]?.attempts, 2);

    const updated = updateCandidateEntry(database, {
      workspace: 'project:revision',
      entryId: entry.id,
      expectedRevision: 1,
      kind: 'lesson',
      title: 'Updated title',
      body: 'Updated body',
      createdBy: 'test',
      now: '2026-08-30T00:00:02.000Z',
    });
    const jobs = listEmbeddingJobs(database);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.revision, 2);
    assert.equal(jobs[0]?.contentHash, updated.contentHash);
    assert.equal(jobs[0]?.state, 'pending');
    assert.equal(jobs[0]?.attempts, 0);
    assert.equal(jobs[0]?.leaseId, null);
    assert.equal(readEntryEmbedding(database, { entryId: entry.id, profileId: active.profileId })?.revision, 1);
  } finally {
    database.close();
  }
});

test('an expired lease at the attempt limit becomes terminal instead of being reclaimed forever', async () => {
  const database = await temporaryDatabase('embedding-attempt-limit');
  try {
    const active = profile('model-attempt-limit');
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    recordEntry(database, {
      workspace: 'project:attempt-limit',
      kind: 'lesson',
      title: 'Exhausted job',
      body: 'A job that reaches the attempt limit must stop retrying.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-attempt-limit', now: timestamp });

    for (let attempt = 0; attempt < EMBEDDING_JOB_MAX_ATTEMPTS; attempt += 1) {
      const claimed = claimEmbeddingJobs(database, {
        maxJobs: 1,
        now: new Date(Date.parse(timestamp) + attempt * 1_001).toISOString(),
        leaseMs: 1_000,
        leaseIdFactory: () => `lease-attempt-${attempt + 1}`,
      });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.attempts, attempt + 1);
    }

    const terminal = claimEmbeddingJobs(database, {
      maxJobs: 1,
      now: new Date(Date.parse(timestamp) + EMBEDDING_JOB_MAX_ATTEMPTS * 1_001).toISOString(),
      leaseMs: 1_000,
      leaseIdFactory: () => 'lease-should-not-exist',
    });
    assert.deepEqual(terminal, []);
    const job = listEmbeddingJobs(database)[0];
    assert.equal(job?.state, 'failed');
    assert.equal(job?.attempts, EMBEDDING_JOB_MAX_ATTEMPTS);
    assert.equal(job?.errorCode, 'timeout');
    assert.equal(job?.leaseId, null);
    assert.equal(job?.leaseExpiresAt, null);
  } finally {
    database.close();
  }
});

test('finalize rejects a vector whose document hash does not match the current entry', async () => {
  const database = await temporaryDatabase('embedding-finalize-hash');
  try {
    const active = profile('model-finalize-hash');
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entry = recordEntry(database, {
      workspace: 'project:finalize-hash',
      kind: 'lesson',
      title: 'Canonical source',
      body: 'The finalized vector must identify this exact document.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-finalize-hash', now: timestamp });
    const claimed = claimEmbeddingJobs(database, {
      maxJobs: 1,
      now: timestamp,
      leaseIdFactory: () => 'lease-finalize-hash',
    });
    assert.equal(claimed.length, 1);
    const job = claimed[0]!;

    assert.throws(() => finalizeEmbeddingJob(database, {
      entryId: entry.id,
      profileId: active.profileId,
      generation: job.generation,
      leaseId: job.leaseId,
      revision: entry.revision,
      contentHash: entry.contentHash,
      documentHash: 'f'.repeat(64),
      vector: [1, ...new Array<number>(383).fill(0)],
      now: timestamp,
    }), (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT');
    assert.equal(readEntryEmbedding(database, { entryId: entry.id, profileId: active.profileId }), undefined);
    assert.equal(listEmbeddingJobs(database)[0]?.state, 'leased');
  } finally {
    database.close();
  }
});

test('a failed enqueue rolls back the canonical entry write', async () => {
  const database = await temporaryDatabase('embedding-rollback');
  try {
    const active = profile('model-a');
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    database.exec(`
      CREATE TRIGGER reject_embedding_job
      BEFORE INSERT ON embedding_jobs
      BEGIN
        SELECT RAISE(ABORT, 'test enqueue failure');
      END;
    `);
    assert.throws(() => recordEntry(database, {
      workspace: 'project:rollback',
      kind: 'lesson',
      title: 'Must roll back',
      body: 'The queue write is part of the entry transaction.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-rollback', now: timestamp }));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('runtime drains jobs with a fake provider and reuses the query vector cache', async () => {
  const database = await temporaryDatabase('embedding-runtime');
  try {
    const active = profile('model-runtime');
    const config = localConfig();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    let calls = 0;
    const provider: EmbeddingProvider = {
      profile: active.identity,
      async embed(inputs) {
        calls += 1;
        return inputs.map(() => vector());
      },
    };
    const runtime = createEmbeddingRuntime(database, config, { provider, now: () => timestamp });
    const entry = recordEntry(database, {
      workspace: 'project:runtime',
      kind: 'lesson',
      title: 'Runtime worker entry',
      body: 'A fake provider should index this entry.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-runtime', now: timestamp });

    assert.deepEqual(await runtime.drain({ workspace: 'project:runtime', maxJobs: 4, deadlineMs: 5_000 }), {
      claimed: 1,
      completed: 1,
      failed: 0,
      blocked: 0,
      remaining: 0,
    });
    assert.equal(readEntryEmbedding(database, { entryId: entry.id, profileId: active.profileId })?.revision, 1);
    assert.equal(listEmbeddingJobs(database).length, 0);

    const first = await runtime.prepareQuery(database, ' query ');
    const second = await runtime.prepareQuery(database, 'query');
    assert.ok(first);
    assert.ok(second);
    assert.equal(calls, 2);
    assert.equal(first?.vectorHash, second?.vectorHash);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM query_embeddings').get<{ count: number }>()?.count, 1);
    await runtime.close();
  } finally {
    database.close();
  }
});

test('runtime aborts an in-flight provider batch at the caller drain deadline', async () => {
  const database = await temporaryDatabase('embedding-deadline');
  try {
    const active = profile('model-deadline');
    const config = localConfig();
    activateLocalEmbeddingProfile(database, active, { replace: false, now: timestamp });
    recordEntry(database, {
      workspace: 'project:deadline',
      kind: 'lesson',
      title: 'Bound the provider call',
      body: 'The drain deadline must abort a provider that does not finish.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-deadline', now: timestamp });
    const provider: EmbeddingProvider = {
      profile: active.identity,
      embed(_inputs, options) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new EmbeddingProviderError('timeout', true));
          }, { once: true });
        });
      },
    };
    const runtime = createEmbeddingRuntime(database, config, { provider, now: () => timestamp });
    const startedAt = Date.now();
    const result = await runtime.drain({ workspace: 'project:deadline', maxJobs: 1, deadlineMs: 20 });

    assert.ok(Date.now() - startedAt < 1_000);
    assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1, blocked: 0, remaining: 1 });
    assert.equal(listEmbeddingJobs(database)[0]?.errorCode, 'timeout');
    await runtime.close();
  } finally {
    database.close();
  }
});
