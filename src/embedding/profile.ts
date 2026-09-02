import { createHash } from 'node:crypto';
import { canonicalJson } from '../serialization/validate.js';
import type {
  EmbeddingProfile,
  EmbeddingProfileIdentity,
  LocalEmbeddingProfile,
  LocalEmbeddingProfileIdentity,
} from './types.js';
import type { LocalEmbeddingPreset } from './presets/manifest.js';
import { presetManifestHash } from './presets/manifest.js';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function embeddingProfileId(identity: EmbeddingProfileIdentity): string {
  return sha256(canonicalJson(identity));
}

export function localEmbeddingProfileId(identity: LocalEmbeddingProfileIdentity): string {
  return embeddingProfileId(identity);
}

export function createLocalEmbeddingProfileIdentity(
  preset: LocalEmbeddingPreset,
  inferenceEngineVersion = preset.transformersJsVersion,
): LocalEmbeddingProfileIdentity {
  return {
    schemaVersion: 1,
    providerKind: 'local-transformers',
    presetId: preset.id,
    sourceModel: preset.sourceModel,
    artifactRepository: preset.artifactRepository,
    modelRevision: preset.revision,
    artifactManifestHash: presetManifestHash(preset),
    inferenceEngine: 'transformers-js',
    inferenceEngineVersion,
    dtype: preset.dtype,
    pooling: preset.pooling,
    normalize: preset.normalize,
    maximumTokens: preset.maximumTokens,
    dimensions: preset.dimensions,
    distanceMetric: preset.distanceMetric,
    distanceCeiling: preset.distanceCeiling,
    inputContract: preset.inputContract,
    documentTemplateVersion: 1,
    queryTemplateVersion: 1,
    queryPrefix: preset.queryPrefix,
    documentPrefix: preset.documentPrefix,
  };
}

export function createLocalEmbeddingProfile(
  preset: LocalEmbeddingPreset,
  inferenceEngineVersion = preset.transformersJsVersion,
): LocalEmbeddingProfile {
  const identity = createLocalEmbeddingProfileIdentity(preset, inferenceEngineVersion);
  return Object.freeze({
    profileId: localEmbeddingProfileId(identity),
    identity: Object.freeze(identity),
  });
}

export function freezeEmbeddingProfile(profile: LocalEmbeddingProfile): EmbeddingProfile {
  return Object.freeze({ profileId: profile.profileId, identity: Object.freeze({ ...profile.identity }) });
}
