import { canonicalContentHash } from '../../serialization/validate.js';

export interface LocalEmbeddingPresetFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface LocalEmbeddingPreset {
  readonly id: 'local-small';
  readonly schemaVersion: 1;
  readonly displayName: string;
  readonly sourceModel: 'intfloat/multilingual-e5-small';
  readonly artifactRepository: 'Xenova/multilingual-e5-small';
  readonly revision: string;
  readonly transformersJsVersion: string;
  readonly dimensions: 384;
  readonly maximumTokens: 512;
  readonly dtype: 'q8';
  readonly pooling: 'mean';
  readonly normalize: true;
  readonly distanceMetric: 'cosine';
  readonly distanceCeiling: number;
  readonly inputContract: 'e5-query-passage-v1';
  readonly queryPrefix: 'query: ';
  readonly documentPrefix: 'passage: ';
  readonly files: readonly LocalEmbeddingPresetFile[];
}

export function presetManifestHash(preset: LocalEmbeddingPreset): string {
  return canonicalContentHash(preset);
}
