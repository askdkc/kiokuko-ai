import { KiokukoError } from '../errors.js';
import type { EmbeddingConfig, EnabledEmbeddingConfig, EmbeddingMode, VectorBackendPreference } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 16;

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function enumValue<T extends string>(value: string | undefined, fallback: T, allowed: readonly T[], field: string): T {
  const selected = value === undefined ? fallback : value as T;
  if (!allowed.includes(selected)) invalid(`${field} has an unsupported value`);
  return selected;
}

function integerValue(value: string | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) invalid(`${field} must be an integer in the supported range`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(`${field} must be an integer in the supported range`);
  }
  return parsed;
}

export function isEnabledEmbeddingConfig(config: EmbeddingConfig): config is EnabledEmbeddingConfig {
  return config.mode !== 'off' && config.presetId === 'local-small';
}

export function requireEnabledEmbeddingConfig(config: EmbeddingConfig): EnabledEmbeddingConfig {
  if (!isEnabledEmbeddingConfig(config)) invalid('Embedding configuration is disabled or incomplete');
  return config;
}

/** Parse the v0.1.0 local embedding contract. */
export function parseEmbeddingConfig(environment: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const mode = enumValue<EmbeddingMode>(environment.KIOKUKO_EMBEDDINGS, 'off', ['off', 'optional', 'required'], 'KIOKUKO_EMBEDDINGS');
  const vectorBackend = enumValue<VectorBackendPreference>(environment.KIOKUKO_VECTOR_BACKEND, 'auto', ['auto', 'javascript', 'sqlite-vec'], 'KIOKUKO_VECTOR_BACKEND');
  const timeoutMs = integerValue(environment.KIOKUKO_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 120_000, 'KIOKUKO_EMBEDDING_TIMEOUT_MS');
  const batchSize = integerValue(environment.KIOKUKO_EMBEDDING_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 64, 'KIOKUKO_EMBEDDING_BATCH_SIZE');

  return Object.freeze({
    mode,
    provider: 'local-transformers',
    ...(mode === 'off' ? {} : { presetId: 'local-small' as const }),
    vectorBackend,
    timeoutMs,
    batchSize,
  });
}
