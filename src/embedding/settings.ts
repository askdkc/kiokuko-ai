import { KiokukoError } from '../errors.js';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import type { EmbeddingConfig, VectorBackendPreference } from './types.js';

const DISABLED_CONFIG: EmbeddingConfig = Object.freeze({
  mode: 'off',
  provider: 'local-transformers',
  vectorBackend: 'auto',
  timeoutMs: 30_000,
  batchSize: 16,
});

interface SettingsRow extends SqliteRow {
  singleton: unknown;
  mode: unknown;
  provider_kind: unknown;
  vector_backend: unknown;
  batch_size: unknown;
  timeout_ms: unknown;
  setup_state: unknown;
}

function invalid(message: string): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function tableExists(database: SqliteDatabase): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'embedding_settings'
  `).get());
}

function vectorBackend(value: unknown): VectorBackendPreference {
  if (value !== 'auto' && value !== 'javascript' && value !== 'sqlite-vec') invalid('Persisted embedding vector backend is invalid');
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`Persisted embedding ${field} is invalid`);
  }
  return value;
}

/** Read durable embedding settings without consulting embedding environment variables. */
export function readPersistedEmbeddingSettings(database: SqliteDatabase): EmbeddingConfig {
  if (!tableExists(database)) return DISABLED_CONFIG;
  const row = database.prepare(`
    SELECT singleton, mode, provider_kind, vector_backend, batch_size, timeout_ms, setup_state
      FROM embedding_settings
  `).get<SettingsRow>();
  if (row === undefined || row.singleton !== 1) invalid('Persisted embedding settings must contain exactly one singleton row');
  const backend = vectorBackend(row.vector_backend);
  const batchSize = integer(row.batch_size, 1, 64, 'batch size');
  const timeoutMs = integer(row.timeout_ms, 100, 120_000, 'timeout');
  if (row.mode !== 'off' && row.mode !== 'optional' && row.mode !== 'required') invalid('Persisted embedding mode is invalid');
  if (row.setup_state !== 'disabled' && row.setup_state !== 'requires_setup' && row.setup_state !== 'installing'
    && row.setup_state !== 'ready' && row.setup_state !== 'degraded') invalid('Persisted embedding setup state is invalid');

  if (row.mode === 'off' || row.provider_kind !== 'local-transformers' || row.setup_state !== 'ready') {
    return Object.freeze({ ...DISABLED_CONFIG, vectorBackend: backend, batchSize, timeoutMs });
  }
  return Object.freeze({
    mode: row.mode as 'optional' | 'required',
    provider: 'local-transformers',
    presetId: 'local-small',
    vectorBackend: backend,
    batchSize,
    timeoutMs,
  });
}

export function defaultEmbeddingConfig(): EmbeddingConfig {
  return DISABLED_CONFIG;
}
