import type { EmbeddingProvider } from './types.js';

export type EmbeddingProviderFailureCode =
  | 'timeout'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'dimension_mismatch'
  | 'secret_blocked';

/** A provider failure contains only a stable classification, never remote data. */
export class EmbeddingProviderError extends Error {
  override readonly name = 'EmbeddingProviderError';

  constructor(
    readonly code: EmbeddingProviderFailureCode,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
  }
}

export function isEmbeddingProviderError(value: unknown): value is EmbeddingProviderError {
  return value instanceof EmbeddingProviderError;
}

export type { EmbeddingProvider };
