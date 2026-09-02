import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalEmbeddingProfile, localEmbeddingProfileId } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET, LOCAL_SMALL_PRESET_MANIFEST_HASH } from '../../src/embedding/presets/local-small.js';
import { presetManifestHash } from '../../src/embedding/presets/manifest.js';

test('pins the local-small model contract and every required artifact', () => {
  assert.equal(LOCAL_SMALL_PRESET.id, 'local-small');
  assert.match(LOCAL_SMALL_PRESET.revision, /^[0-9a-f]{40}$/u);
  assert.equal(LOCAL_SMALL_PRESET.artifactRepository, 'Xenova/multilingual-e5-small');
  assert.equal(LOCAL_SMALL_PRESET.dimensions, 384);
  assert.equal(LOCAL_SMALL_PRESET.maximumTokens, 512);
  assert.equal(LOCAL_SMALL_PRESET.queryPrefix, 'query: ');
  assert.equal(LOCAL_SMALL_PRESET.documentPrefix, 'passage: ');
  assert.equal(LOCAL_SMALL_PRESET.files.length, 8);
  assert.deepEqual(LOCAL_SMALL_PRESET.files.map((file) => file.path), [
    'README.md',
    'config.json',
    'quant_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'sentencepiece.bpe.model',
    'onnx/model_quantized.onnx',
  ]);
  for (const file of LOCAL_SMALL_PRESET.files) {
    assert.ok(file.size > 0);
    assert.match(file.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(presetManifestHash(LOCAL_SMALL_PRESET), LOCAL_SMALL_PRESET_MANIFEST_HASH);
});

test('local profile identity includes the complete inference contract', () => {
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  assert.equal(profile.profileId, localEmbeddingProfileId(profile.identity));
  assert.deepEqual(profile.identity, {
    schemaVersion: 1,
    providerKind: 'local-transformers',
    presetId: 'local-small',
    sourceModel: 'intfloat/multilingual-e5-small',
    artifactRepository: 'Xenova/multilingual-e5-small',
    modelRevision: LOCAL_SMALL_PRESET.revision,
    artifactManifestHash: LOCAL_SMALL_PRESET_MANIFEST_HASH,
    inferenceEngine: 'transformers-js',
    inferenceEngineVersion: '4.2.0',
    dtype: 'q8',
    pooling: 'mean',
    normalize: true,
    maximumTokens: 512,
    dimensions: 384,
    distanceMetric: 'cosine',
    distanceCeiling: 0.8,
    inputContract: 'e5-query-passage-v1',
    documentTemplateVersion: 1,
    queryTemplateVersion: 1,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
  });
});

test('profile ID changes for each material model-space change', () => {
  const base = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  const variations = [
    createLocalEmbeddingProfile({ ...LOCAL_SMALL_PRESET, revision: 'b'.repeat(40) }),
    createLocalEmbeddingProfile({ ...LOCAL_SMALL_PRESET, distanceCeiling: 0.9 }),
    createLocalEmbeddingProfile(LOCAL_SMALL_PRESET, '4.2.1'),
    createLocalEmbeddingProfile({ ...LOCAL_SMALL_PRESET, files: [...LOCAL_SMALL_PRESET.files, { path: 'extra', size: 1, sha256: '0'.repeat(64) }] }),
  ];
  for (const variation of variations) assert.notEqual(variation.profileId, base.profileId);
});
