import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { claimEmbeddingJobs } from '../../src/embedding/jobs.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createModelManifest } from '../../src/embedding/model-manifest.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { activateLocalEmbeddingProfile } from '../../src/embedding/store.js';
import { runEmbeddingSetup } from '../../src/embedding/setup-service.js';
import { recordEntry } from '../../src/memory/entries.js';

const timestamp = '2026-08-31T00:00:00.000Z';

test('repeated setup remains ready without duplicate profile rows', async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-embedding-resume-'));
  const database = openConnection(':memory:');
  const provider = {
    profile: { providerKind: 'local-transformers' } as never,
    embed: async (inputs: readonly string[]) => inputs.map(() => { const vector = new Float32Array(384); vector[0] = 1; return vector; }),
  };
  const installer = async () => ({
    installation: 'reused' as const,
    directory: path.join(dataDirectory, 'models'),
    relativePath: 'models/embeddings/local-small/revision',
    totalBytes: LOCAL_SMALL_PRESET.files.reduce((sum, file) => sum + file.size, 0),
    manifestHash: createModelManifest(LOCAL_SMALL_PRESET).artifactManifestHash,
  });
  try {
    migrateDatabase(database);
    const first = await runEmbeddingSetup(database, { presetId: 'local-small', confirmed: true, dryRun: false, offline: false, replace: false }, { env: { KIOKUKO_DATA_DIR: dataDirectory }, provider, installer });
    const second = await runEmbeddingSetup(database, { presetId: 'local-small', confirmed: true, dryRun: false, offline: false, replace: false }, { env: { KIOKUKO_DATA_DIR: dataDirectory }, provider, installer });
    assert.equal(first.profile.profileId, second.profile.profileId);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM embedding_profiles').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT setup_state FROM embedding_settings').get<{ setup_state: string }>()?.setup_state, 'ready');
  } finally {
    database.close();
  }
});

test('setup does not report ready while an unexpired job lease remains outstanding', async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-embedding-setup-leased-'));
  const database = openConnection(':memory:');
  const provider = {
    profile: { providerKind: 'local-transformers' } as never,
    embed: async (inputs: readonly string[]) => inputs.map(() => new Float32Array(384)),
  };
  const installer = async () => ({
    installation: 'reused' as const,
    directory: path.join(dataDirectory, 'models'),
    relativePath: 'models/embeddings/local-small/revision',
    totalBytes: LOCAL_SMALL_PRESET.files.reduce((sum, file) => sum + file.size, 0),
    manifestHash: createModelManifest(LOCAL_SMALL_PRESET).artifactManifestHash,
  });
  try {
    migrateDatabase(database);
    const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
    activateLocalEmbeddingProfile(database, profile, { replace: false, now: timestamp });
    recordEntry(database, {
      workspace: 'project:setup-leased',
      kind: 'lesson',
      title: 'Leased setup job',
      body: 'Setup must account for a job another worker still owns.',
      createdBy: 'setup-test',
    }, { idFactory: () => 'entry-setup-leased', now: timestamp });
    const claimed = claimEmbeddingJobs(database, { maxJobs: 1, now: timestamp, leaseIdFactory: () => 'setup-lease' });
    assert.equal(claimed.length, 1);

    const result = await runEmbeddingSetup(database, { presetId: 'local-small', confirmed: true, dryRun: false, offline: false, replace: false }, {
      env: { KIOKUKO_DATA_DIR: dataDirectory },
      now: () => timestamp,
      provider,
      installer,
    });
    assert.equal(result.semanticEnabled, false);
    assert.deepEqual(result.embeddings, { eligible: 1, completed: 0, failed: 0, blocked: 0, remaining: 1 });
    assert.equal(database.prepare('SELECT setup_state FROM embedding_settings').get<{ setup_state: string }>()?.setup_state, 'degraded');
  } finally {
    database.close();
  }
});
