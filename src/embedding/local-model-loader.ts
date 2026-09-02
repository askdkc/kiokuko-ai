import { KiokukoError } from '../errors.js';
import { verifyInstalledModelDirectory } from './model-manifest.js';
import { LOCAL_SMALL_PRESET } from './presets/local-small.js';
import type { LocalEmbeddingProfileIdentity } from './types.js';

export interface LocalModelRuntime {
  embed(inputs: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]>;
  dispose?(): Promise<void> | void;
}

export interface LocalModelLoader {
  load(profile: LocalEmbeddingProfileIdentity, modelDirectory: string): Promise<LocalModelRuntime>;
}

interface FeatureExtractionTensor {
  readonly dims: readonly number[];
  readonly data: ArrayLike<number>;
}

interface FeatureExtractionPipeline {
  (inputs: readonly string[], options: { pooling: 'mean'; normalize: true }): Promise<FeatureExtractionTensor>;
  dispose?(): Promise<void> | void;
}

function unavailable(message: string, cause?: unknown): never {
  const error = new KiokukoError('SERVICE_UNAVAILABLE', message);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  throw error;
}

function outputRows(output: FeatureExtractionTensor, expectedCount: number): readonly Float32Array[] {
  if (!Array.isArray(output.dims) || output.dims.length !== 2 || output.dims[0] !== expectedCount || output.dims[1] !== 384) {
    throw new KiokukoError('VALIDATION_ERROR', 'Local model returned unexpected embedding dimensions');
  }
  const vectors: Float32Array[] = [];
  for (let row = 0; row < expectedCount; row += 1) {
    const vector = new Float32Array(384);
    for (let column = 0; column < 384; column += 1) vector[column] = output.data[row * 384 + column] ?? Number.NaN;
    vectors.push(vector);
  }
  return vectors;
}

export function createLocalTransformersModelLoader(
  options: {
    readonly pipeline?: (task: string, model: string, options: Record<string, unknown>) => Promise<FeatureExtractionPipeline>;
    readonly verifyInstallation?: boolean;
  } = {},
): LocalModelLoader {
  return {
    load: async (profile, modelDirectory) => {
      if (profile.providerKind !== 'local-transformers'
        || profile.presetId !== LOCAL_SMALL_PRESET.id
        || profile.sourceModel !== LOCAL_SMALL_PRESET.sourceModel
        || profile.artifactRepository !== LOCAL_SMALL_PRESET.artifactRepository
        || profile.modelRevision !== LOCAL_SMALL_PRESET.revision
        || !/^[0-9a-f]{64}$/u.test(profile.artifactManifestHash)
        || profile.inferenceEngine !== 'transformers-js'
        || profile.inferenceEngineVersion !== LOCAL_SMALL_PRESET.transformersJsVersion
        || profile.dtype !== 'q8'
        || profile.pooling !== 'mean'
        || profile.normalize !== true
        || profile.maximumTokens !== LOCAL_SMALL_PRESET.maximumTokens
        || profile.dimensions !== LOCAL_SMALL_PRESET.dimensions
        || profile.documentPrefix !== LOCAL_SMALL_PRESET.documentPrefix
        || profile.queryPrefix !== LOCAL_SMALL_PRESET.queryPrefix) {
        throw new KiokukoError('VALIDATION_ERROR', 'Local model profile contract is invalid');
      }
      if (options.verifyInstallation !== false) {
        const manifest = await verifyInstalledModelDirectory(modelDirectory, LOCAL_SMALL_PRESET);
        if (manifest.artifactManifestHash !== profile.artifactManifestHash) {
          throw new KiokukoError('INTEGRITY_ERROR', 'Local model installation does not match the active profile');
        }
      }
      let pipeline = options.pipeline;
      if (pipeline === undefined) {
        try {
          const transformers = await import('@huggingface/transformers');
          transformers.env.localModelPath = `${modelDirectory.endsWith('/') ? modelDirectory : `${modelDirectory}/`}`;
          transformers.env.allowLocalModels = true;
          transformers.env.allowRemoteModels = false;
          pipeline = transformers.pipeline as unknown as NonNullable<typeof pipeline>;
        } catch (error) {
          unavailable('The optional local Transformers.js dependency is unavailable', error);
        }
      }
      if (pipeline === undefined) unavailable('The local Transformers.js pipeline is unavailable');
      const pipelineFactory = pipeline;
      let extractor: FeatureExtractionPipeline;
      try {
        extractor = await pipelineFactory('feature-extraction', modelDirectory, { dtype: profile.dtype });
      } catch (error) {
        unavailable('The verified local embedding model could not be loaded offline', error);
      }
      return {
        embed: async (inputs, signal) => {
          if (signal?.aborted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Local embedding was interrupted');
          const output = await extractor(inputs, { pooling: 'mean', normalize: true });
          if (signal?.aborted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Local embedding was interrupted');
          return outputRows(output, inputs.length);
        },
        dispose: async () => { await extractor.dispose?.(); },
      };
    },
  };
}
