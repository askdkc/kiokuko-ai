import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalEmbeddingProfile, createLocalEmbeddingProfileIdentity, embeddingProfileId } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';

test('local-small profile identity and ID are deterministic', () => {
  const first = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  const second = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  assert.deepEqual(first, second);
  assert.equal(first.profileId, embeddingProfileId(first.identity));
  assert.equal(first.identity.providerKind, 'local-transformers');
  assert.equal(first.identity.presetId, 'local-small');
  assert.equal(first.identity.dimensions, 384);
  assert.match(first.profileId, /^[0-9a-f]{64}$/u);
});

test('profile identity changes when the pinned runtime contract changes', () => {
  const first = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  const differentEngine = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET, 'different-transformers-js');
  const differentManifest = createLocalEmbeddingProfileIdentity({
    ...LOCAL_SMALL_PRESET,
    distanceCeiling: 0.9,
  });
  assert.notEqual(first.profileId, differentEngine.profileId);
  assert.notEqual(first.profileId, embeddingProfileId(differentManifest));
  assert.equal(first.identity.distanceMetric, 'cosine');
  assert.equal(first.identity.documentTemplateVersion, 1);
  assert.equal(first.identity.queryTemplateVersion, 1);
});
