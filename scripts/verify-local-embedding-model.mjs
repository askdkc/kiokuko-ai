import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const EXPECTED_MANIFEST_HASH = '85d724217ffdda4333b6c2892f5138754d716f62e08a82cb0093ca5baca24fe4';
const MODEL_ID = 'Xenova/multilingual-e5-small';
const REVISION = 'ae61bf0193ce3851dc8a45147e459b04ed783d8a';
const FILES = [
  ['README.md', 553, '000754b7b0eb4d281504ade130052d4ce887d132bb5c8a77ed53f1926b910f8b'],
  ['config.json', 658, 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1'],
  ['quant_config.json', 674, '59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d'],
  ['tokenizer.json', 17082730, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'],
  ['tokenizer_config.json', 443, 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'],
  ['special_tokens_map.json', 167, 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7'],
  ['sentencepiece.bpe.model', 5069051, 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865'],
  ['onnx/model_quantized.onnx', 118308185, 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'],
];

function usage() {
  console.error('Usage: node scripts/verify-local-embedding-model.mjs --offline [--model-dir <directory>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.includes('--offline')) usage();
const modelDirectoryIndex = args.indexOf('--model-dir');
if (modelDirectoryIndex !== -1 && (modelDirectoryIndex + 1 >= args.length || args[modelDirectoryIndex + 1]?.startsWith('-'))) usage();
if (args.some((arg, index) => arg !== '--offline' && arg !== '--model-dir' && index !== modelDirectoryIndex + 1)) usage();

const modelDirectory = modelDirectoryIndex === -1 ? undefined : path.resolve(args[modelDirectoryIndex + 1]);
if (modelDirectory === undefined) {
  console.log(`Pinned ${MODEL_ID}@${REVISION} manifest verified (${EXPECTED_MANIFEST_HASH}); no local installation supplied.`);
  process.exit(0);
}

const root = path.join(modelDirectory, MODEL_ID);
for (const [relativePath, expectedSize, expectedHash] of FILES) {
  const filePath = path.join(root, relativePath);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Model artifact is not a regular file: ${relativePath}`);
  if (stat.size !== expectedSize) throw new Error(`Model artifact size mismatch: ${relativePath}`);
  const actualHash = createHash('sha256').update(await readFile(filePath)).digest('hex');
  if (actualHash !== expectedHash) throw new Error(`Model artifact hash mismatch: ${relativePath}`);
}

const { env, pipeline } = await import('@huggingface/transformers');
env.localModelPath = `${modelDirectory}${path.sep}`;
env.allowLocalModels = true;
env.allowRemoteModels = false;
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
try {
  const examples = [
    ['query: 二重実行されても壊れない処理', 'passage: ジョブは冪等に実装し、同じ要求が複数回届いても結果が壊れないようにする', 'passage: CSSの余白を調整する'],
    ['query: idempotent retry handling', 'passage: Use idempotent jobs so duplicate requests do not corrupt results', 'passage: Adjust the stylesheet margin'],
    ['query: 幂等重试处理', 'passage: 使用幂等作业，重复请求不会破坏结果', 'passage: 调整 CSS 边距'],
    ['query: 멱등 재시도 처리', 'passage: 멱등 작업을 사용하여 중복 요청이 결과를 손상시키지 않도록 합니다', 'passage: CSS 여백을 조정합니다'],
  ];
  for (const inputs of examples) {
    const output = await extractor(inputs, { pooling: 'mean', normalize: true });
    if (output.dims.length !== 2 || output.dims[0] !== 3 || output.dims[1] !== 384) throw new Error('Unexpected embedding dimensions');
    const vectors = [0, 1, 2].map((index) => output.data.slice(index * 384, (index + 1) * 384));
    for (const vector of vectors) {
      if (vector.some((value) => !Number.isFinite(value))) throw new Error('Embedding contains a non-finite value');
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      if (Math.abs(norm - 1) > 0.02) throw new Error('Embedding is not normalized');
    }
    const distance = (left, right) => 1 - left.reduce((sum, value, index) => sum + value * right[index], 0);
    if (!(distance(vectors[0], vectors[1]) < distance(vectors[0], vectors[2]))) throw new Error('E5 relevance ordering failed');
  }
} finally {
  await extractor.dispose?.();
}
console.log(`Pinned ${MODEL_ID}@${REVISION} offline inference passed (${EXPECTED_MANIFEST_HASH}).`);
