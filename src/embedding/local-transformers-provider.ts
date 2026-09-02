import { KiokukoError } from '../errors.js';
import { normalizeVector } from './vector.js';
import { createLocalTransformersModelLoader, type LocalModelLoader, type LocalModelRuntime } from './local-model-loader.js';
import type { EmbeddingProvider, LocalEmbeddingProfileIdentity } from './types.js';

const MAX_INPUTS = 64;
const MAX_INPUT_BYTES = 32 * 1024;

function validateInputs(inputs: readonly string[]): readonly string[] {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_INPUTS) {
    throw new KiokukoError('VALIDATION_ERROR', 'Local embedding input batch is invalid');
  }
  return inputs.map((input) => {
    if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Local embedding input is invalid');
    }
    return input;
  });
}

export interface LocalTransformersEmbeddingProviderOptions {
  readonly profile: LocalEmbeddingProfileIdentity;
  readonly modelDirectory: string;
  readonly loader?: LocalModelLoader;
}

export class LocalTransformersEmbeddingProvider implements EmbeddingProvider {
  readonly profile: LocalEmbeddingProfileIdentity;
  readonly #modelDirectory: string;
  readonly #loader: LocalModelLoader;
  #runtime: Promise<LocalModelRuntime> | undefined;
  #closed = false;

  constructor(options: LocalTransformersEmbeddingProviderOptions) {
    if (options.profile.providerKind !== 'local-transformers') throw new KiokukoError('VALIDATION_ERROR', 'Local provider profile is invalid');
    this.profile = Object.freeze({ ...options.profile });
    this.#modelDirectory = options.modelDirectory;
    this.#loader = options.loader ?? createLocalTransformersModelLoader();
  }

  async #load(): Promise<LocalModelRuntime> {
    if (this.#closed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Local embedding provider is closed');
    this.#runtime ??= this.#loader.load(this.profile, this.#modelDirectory);
    return this.#runtime;
  }

  async embed(inputs: readonly string[], options: { signal?: AbortSignal } = {}): Promise<readonly Float32Array[]> {
    const validInputs = validateInputs(inputs);
    if (options.signal?.aborted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Local embedding was interrupted');
    const runtime = await this.#load();
    const vectors = await runtime.embed(validInputs, options.signal);
    if (vectors.length !== validInputs.length) throw new KiokukoError('VALIDATION_ERROR', 'Local model returned the wrong number of embeddings');
    return vectors.map((vector) => normalizeVector(vector, this.profile.dimensions));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const runtime = this.#runtime === undefined ? undefined : await this.#runtime;
    await runtime?.dispose?.();
  }
}
