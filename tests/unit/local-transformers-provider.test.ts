import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanonicalEmbeddingDocument, renderEmbeddingProviderInput } from '../../src/embedding/document.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LocalTransformersEmbeddingProvider } from '../../src/embedding/local-transformers-provider.js';

const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET).identity;

function vector(value: number): Float32Array {
  const result = new Float32Array(384);
  result[0] = value;
  result[1] = 1;
  return result;
}

test('loads the local model lazily, validates dimensions, and disposes once', async () => {
  let loads = 0;
  let disposes = 0;
  const provider = new LocalTransformersEmbeddingProvider({
    profile,
    modelDirectory: '/verified/model-root',
    loader: {
      load: async () => {
        loads += 1;
        return { embed: async (inputs) => inputs.map(() => vector(1)), dispose: () => { disposes += 1; } };
      },
    },
  });
  const first = await provider.embed(['passage: one']);
  const second = await provider.embed(['query: two']);
  assert.equal(loads, 1);
  assert.equal(first[0]?.length, 384);
  assert.equal(second[0]?.length, 384);
  await provider.close();
  await provider.close();
  assert.equal(disposes, 1);
});

test('accepts canonical multiline documents without changing the provider input', async () => {
  const document = buildCanonicalEmbeddingDocument({
    kind: 'fact',
    title: 'Ubuntu embedding setup',
    summary: 'Local embeddings use canonical documents',
    body: 'First line\nSecond line',
    tags: ['embedding'],
    scope: {},
  });
  const input = renderEmbeddingProviderInput(document.text);
  let received: readonly string[] = [];
  const provider = new LocalTransformersEmbeddingProvider({
    profile,
    modelDirectory: '/verified/model-root',
    loader: {
      load: async () => ({
        embed: async (inputs) => {
          received = inputs;
          return inputs.map(() => vector(1));
        },
      }),
    },
  });

  assert.match(input, /\n/u);
  await provider.embed([input]);
  assert.deepEqual(received, [input]);
});

test('rejects invalid input and malformed model output', async () => {
  const bad = new LocalTransformersEmbeddingProvider({
    profile,
    modelDirectory: '/verified/model-root',
    loader: { load: async () => ({ embed: async () => [new Float32Array(3)] }) },
  });
  await assert.rejects(bad.embed(['query: invalid output']), { code: 'VALIDATION_ERROR' });

  let loads = 0;
  const invalidInput = new LocalTransformersEmbeddingProvider({
    profile,
    modelDirectory: '/verified/model-root',
    loader: {
      load: async () => {
        loads += 1;
        return { embed: async () => [vector(1)] };
      },
    },
  });
  await assert.rejects(invalidInput.embed(['bad\u0000input']), { code: 'VALIDATION_ERROR' });
  assert.equal(loads, 0);
});
