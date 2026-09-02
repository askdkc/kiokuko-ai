import { canonicalContentHash } from '../serialization/validate.js';
import { validateTimestamp } from '../ledger/validate.js';
import { withImmediateTransaction } from '../db/transaction.js';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEmbeddingProfile, readEmbeddingRuntimeState } from './store.js';
import { decodeVector, encodeVector, hashVectorBytes } from './vector.js';
import type { LocalEmbeddingProfileIdentity } from './types.js';

export const QUERY_TEMPLATE_VERSION = 1 as const;
export const EMBEDDING_QUERY_INPUT_CONTRACT = 'e5-query-passage-v1' as const;
export const MAX_QUERY_TEXT_BYTES = 32 * 1024;
export const QUERY_EMBEDDING_CACHE_LIMIT = 512;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const INVALID_UNICODE = /[\p{Cs}\uFFFD]/u;
const QUERY_PREFIX = 'query: ' as const;

export interface StoredQueryEmbedding {
  readonly profileId: string;
  readonly queryHash: string;
  readonly dimensions: number;
  readonly vector: Float32Array;
  readonly vectorHash: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export interface QueryEmbeddingInput {
  readonly profileId: string;
  readonly queryHash: string;
  readonly vector: Float32Array | readonly number[];
}

export interface QueryEmbeddingWriteOptions {
  readonly now?: string;
  readonly expectedGeneration?: number;
}

export interface QueryEmbeddingReadOptions {
  readonly now?: string;
  readonly expectedGeneration?: number;
}

export interface QueryEmbeddingCacheIdentity {
  readonly profileId: string;
  readonly generation: number;
  readonly queryHash: string;
}

interface QueryRow extends SqliteRow {
  profile_id: unknown;
  query_hash: unknown;
  dimensions: unknown;
  embedding: unknown;
  vector_hash: unknown;
  created_at: unknown;
  last_used_at: unknown;
}

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function integrity(message: string): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) invalid(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function canonicalQueryText(value: unknown): string {
  if (typeof value !== 'string') invalid('Query text must be a string');
  const normalized = value.normalize('NFKC').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (normalized.length === 0 || INVALID_CONTROL.test(normalized) || INVALID_UNICODE.test(normalized)) invalid('Query text is invalid');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_QUERY_TEXT_BYTES) invalid('Query text exceeds the byte limit');
  return normalized;
}

function canonicalQueryTextWithLimit(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string') invalid('Query text must be a string');
  const normalized = value.normalize('NFKC').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (normalized.length === 0 || INVALID_CONTROL.test(normalized) || INVALID_UNICODE.test(normalized)) invalid('Query text is invalid');
  if (Buffer.byteLength(normalized, 'utf8') > maximumBytes) invalid('Query text exceeds the byte limit');
  return normalized;
}

export function normalizeEmbeddingQuery(value: string): string {
  return canonicalQueryText(value);
}

export function renderEmbeddingQueryInput(value: string, prefix = 'query: '): string {
  if (prefix !== QUERY_PREFIX) invalid('Embedding provider query prefix is invalid');
  const normalized = canonicalQueryTextWithLimit(value, MAX_QUERY_TEXT_BYTES - Buffer.byteLength(prefix, 'utf8'));
  return `${prefix}${normalized}`;
}

/** Hash the complete local provider input contract without storing raw query text. */
export function queryEmbeddingHash(value: string): string {
  const rendered = renderEmbeddingQueryInput(value);
  return canonicalContentHash({
    contract: EMBEDDING_QUERY_INPUT_CONTRACT,
    prefix: QUERY_PREFIX,
    templateVersion: QUERY_TEMPLATE_VERSION,
    text: rendered.slice(QUERY_PREFIX.length),
  });
}

export type EmbeddingProfileIdentityLike = LocalEmbeddingProfileIdentity;

/** Select the provider query input for the active profile contract. */
export function renderEmbeddingQueryInputForProfile(
  value: string,
  profile: EmbeddingProfileIdentityLike,
): string {
  if (profile.providerKind !== 'local-transformers') invalid('Embedding profile provider is invalid');
  return renderEmbeddingQueryInput(value, profile.queryPrefix);
}

/** Select the query hash for the active profile contract without storing raw text. */
export function queryEmbeddingHashForProfile(
  value: string,
  profile: EmbeddingProfileIdentityLike,
): string {
  if (profile.providerKind !== 'local-transformers') invalid('Embedding profile provider is invalid');
  return queryEmbeddingHash(value);
}

function positiveGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('generation must be a positive integer');
  return value as number;
}

/** Derive a stable, profile- and generation-bound cache identity. */
export function queryEmbeddingCacheKey(input: QueryEmbeddingCacheIdentity): string {
  const profileId = hash(input.profileId, 'profileId');
  const queryHash = hash(input.queryHash, 'queryHash');
  const generation = positiveGeneration(input.generation);
  return canonicalContentHash({ version: 1, profileId, generation, queryHash });
}

/** Share one provider operation among concurrent misses for one cache identity. */
export class QueryEmbeddingSingleFlight<T> {
  private readonly flights = new Map<string, Promise<T>>();

  async getOrLoad(
    key: string,
    loader: () => Promise<T>,
  ): Promise<{ result: T; hit: boolean }> {
    if (typeof key !== 'string' || key.length === 0) invalid('Query embedding cache key is invalid');
    const existing = this.flights.get(key);
    if (existing !== undefined) return { result: await existing, hit: true };
    const flight = loader();
    this.flights.set(key, flight);
    try {
      return { result: await flight, hit: false };
    } finally {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    }
  }
}

export const embeddingQueryHash = queryEmbeddingHash;

function storedTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') integrity(`${label} is invalid`);
  try {
    return validateTimestamp(value, label);
  } catch {
    integrity(`${label} is invalid`);
  }
}

function storedQueryEmbedding(row: QueryRow): StoredQueryEmbedding {
  const profileId = hash(row.profile_id, 'Stored query embedding profile ID');
  const queryHash = hash(row.query_hash, 'Stored query embedding query hash');
  if (typeof row.dimensions !== 'number' || !Number.isSafeInteger(row.dimensions) || row.dimensions < 2 || row.dimensions > 8192) {
    integrity('Stored query embedding dimensions are invalid');
  }
  const vectorHash = hash(row.vector_hash, 'Stored query embedding vector hash');
  let vector: Float32Array;
  try {
    vector = decodeVector(row.embedding, row.dimensions, vectorHash);
  } catch {
    integrity('Stored query embedding vector is invalid');
  }
  const createdAt = storedTimestamp(row.created_at, 'query embedding created_at');
  const lastUsedAt = storedTimestamp(row.last_used_at, 'query embedding last_used_at');
  return { profileId, queryHash, dimensions: row.dimensions, vector, vectorHash, createdAt, lastUsedAt };
}

function validateWriteInput(input: QueryEmbeddingInput): { profileId: string; queryHash: string } {
  return {
    profileId: hash(input.profileId, 'profileId'),
    queryHash: hash(input.queryHash, 'queryHash'),
  };
}

function assertExpectedGeneration(database: SqliteDatabase, profileId: string, expectedGeneration: number | undefined): void {
  if (expectedGeneration === undefined) return;
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) invalid('expectedGeneration must be a positive integer');
  const runtime = readEmbeddingRuntimeState(database);
  if (runtime.activeProfileId !== profileId || runtime.generation !== expectedGeneration) {
    conflict('Embedding profile changed while writing the query cache');
  }
}

function pruneProfileCache(database: SqliteDatabase, profileId: string): void {
  database.prepare(`
    DELETE FROM query_embeddings
     WHERE profile_id = ?
       AND query_hash NOT IN (
         SELECT query_hash
           FROM query_embeddings
          WHERE profile_id = ?
          ORDER BY last_used_at DESC, query_hash ASC
          LIMIT ?
       )
  `).run(profileId, profileId, QUERY_EMBEDDING_CACHE_LIMIT);
}

export function readQueryEmbeddingInTransaction(
  database: SqliteDatabase,
  input: { profileId: string; queryHash: string } & QueryEmbeddingReadOptions,
): StoredQueryEmbedding | undefined {
  const profileId = hash(input.profileId, 'profileId');
  const queryHash = hash(input.queryHash, 'queryHash');
  const now = validateTimestamp(input.now ?? new Date().toISOString(), 'now');
  readEmbeddingRuntimeState(database);
  assertExpectedGeneration(database, profileId, input.expectedGeneration);
  const row = database.prepare(`
    SELECT profile_id, query_hash, dimensions, embedding, vector_hash, created_at, last_used_at
      FROM query_embeddings
     WHERE profile_id = ? AND query_hash = ?
  `).get<QueryRow>(profileId, queryHash);
  if (row === undefined) return undefined;
  const stored = storedQueryEmbedding(row);
  const profile = readEmbeddingProfile(database, profileId);
  if (profile === undefined || profile.identity.dimensions !== stored.dimensions) integrity('Stored query embedding profile is invalid');
  database.prepare(`
    UPDATE query_embeddings
       SET last_used_at = ?
     WHERE profile_id = ? AND query_hash = ?
  `).run(now, profileId, queryHash);
  return { ...stored, lastUsedAt: now, vector: new Float32Array(stored.vector) };
}

export function readQueryEmbedding(
  database: SqliteDatabase,
  input: { profileId: string; queryHash: string } & QueryEmbeddingReadOptions,
): StoredQueryEmbedding | undefined {
  return withImmediateTransaction(database, () => readQueryEmbeddingInTransaction(database, input));
}

export function writeQueryEmbeddingInTransaction(
  database: SqliteDatabase,
  input: QueryEmbeddingInput,
  options: QueryEmbeddingWriteOptions = {},
): StoredQueryEmbedding {
  const { profileId, queryHash } = validateWriteInput(input);
  const now = validateTimestamp(options.now ?? new Date().toISOString(), 'now');
  assertExpectedGeneration(database, profileId, options.expectedGeneration);
  const profile = readEmbeddingProfile(database, profileId);
  if (profile === undefined) throw new KiokukoError('NOT_FOUND', 'Embedding profile not found');
  const bytes = encodeVector(input.vector, profile.identity.dimensions);
  const vectorHash = hashVectorBytes(bytes);
  database.prepare(`
    INSERT INTO query_embeddings (
      profile_id, query_hash, dimensions, embedding, vector_hash, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, query_hash) DO UPDATE SET
      dimensions = excluded.dimensions,
      embedding = excluded.embedding,
      vector_hash = excluded.vector_hash,
      last_used_at = excluded.last_used_at
  `).run(profileId, queryHash, profile.identity.dimensions, bytes, vectorHash, now, now);
  pruneProfileCache(database, profileId);
  const row = database.prepare(`
    SELECT profile_id, query_hash, dimensions, embedding, vector_hash, created_at, last_used_at
      FROM query_embeddings
     WHERE profile_id = ? AND query_hash = ?
  `).get<QueryRow>(profileId, queryHash);
  if (row === undefined) integrity('Query embedding write could not be read back');
  return storedQueryEmbedding(row);
}

export function writeQueryEmbedding(
  database: SqliteDatabase,
  input: QueryEmbeddingInput,
  options: QueryEmbeddingWriteOptions = {},
): StoredQueryEmbedding {
  return withImmediateTransaction(database, () => writeQueryEmbeddingInTransaction(database, input, options));
}
