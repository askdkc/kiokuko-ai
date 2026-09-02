import type { LocalEmbeddingPreset } from './manifest.js';

/**
 * The only public local model preset. Every artifact coordinate is immutable;
 * model installation code must consume this value rather than user input.
 */
export const LOCAL_SMALL_PRESET: LocalEmbeddingPreset = Object.freeze({
  id: 'local-small',
  schemaVersion: 1,
  displayName: 'multilingual-e5-small',
  sourceModel: 'intfloat/multilingual-e5-small',
  artifactRepository: 'Xenova/multilingual-e5-small',
  revision: 'ae61bf0193ce3851dc8a45147e459b04ed783d8a',
  transformersJsVersion: '4.2.0',
  dimensions: 384,
  maximumTokens: 512,
  dtype: 'q8',
  pooling: 'mean',
  normalize: true,
  distanceMetric: 'cosine',
  distanceCeiling: 0.8,
  inputContract: 'e5-query-passage-v1',
  queryPrefix: 'query: ',
  documentPrefix: 'passage: ',
  files: Object.freeze([
    {
      path: 'README.md',
      size: 553,
      sha256: '000754b7b0eb4d281504ade130052d4ce887d132bb5c8a77ed53f1926b910f8b',
    },
    {
      path: 'config.json',
      size: 658,
      sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
    },
    {
      path: 'quant_config.json',
      size: 674,
      sha256: '59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d',
    },
    {
      path: 'tokenizer.json',
      size: 17_082_730,
      sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    },
    {
      path: 'tokenizer_config.json',
      size: 443,
      sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
    },
    {
      path: 'special_tokens_map.json',
      size: 167,
      sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7',
    },
    {
      path: 'sentencepiece.bpe.model',
      size: 5_069_051,
      sha256: 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865',
    },
    {
      path: 'onnx/model_quantized.onnx',
      size: 118_308_185,
      sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    },
  ]),
});

export const LOCAL_SMALL_PRESET_MANIFEST_HASH =
  '85d724217ffdda4333b6c2892f5138754d716f62e08a82cb0093ca5baca24fe4';
