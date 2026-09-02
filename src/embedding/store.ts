import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { validateTimestamp } from '../ledger/validate.js';
import { requireWorkspace } from '../serialization/validate.js';
import { embeddingProfileId } from './profile.js';
import { decodeVector, encodeVector, hashVectorBytes } from './vector.js';
import type {
  EmbeddingProfile,
  LocalEmbeddingProfile,
  LocalEmbeddingProfileIdentity,
} from './types.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const EMBEDDING_TABLES = [
  'embedding_profiles',
  'embedding_runtime',
  'entry_embeddings',
  'embedding_jobs',
  'query_embeddings',
] as const;

export interface EmbeddingRuntimeState {
  readonly activeProfileId: string | null;
  readonly generation: number;
  readonly activatedAt: string | null;
}

export interface ActiveEmbeddingProfile {
  readonly profile: EmbeddingProfile;
  readonly generation: number;
  readonly activatedAt: string;
}

export interface ActivateEmbeddingProfileOptions {
  readonly replace: boolean;
  readonly now?: string;
}

export interface EmbeddingProfileActivation {
  readonly profileId: string;
  readonly generation: number;
  readonly activated: boolean;
  readonly enqueued: number;
}

export interface CurrentEntryEmbeddingJobInput {
  readonly entryId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly now: string;
}

export interface EntryEmbeddingInput {
  readonly entryId: string;
  readonly profileId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly documentHash: string;
  readonly vector: Float32Array | readonly number[];
  readonly createdAt: string;
}

export interface StoredEntryEmbedding {
  readonly entryId: string;
  readonly profileId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly documentHash: string;
  readonly dimensions: number;
  readonly vector: Float32Array;
  readonly vectorHash: string;
  readonly createdAt: string;
}

interface ProfileRow extends SqliteRow {
  profile_id: unknown;
  schema_version: unknown;
  provider_kind: unknown;
  dimensions: unknown;
  distance_metric: unknown;
  distance_ceiling: unknown;
  document_template_version: unknown;
  query_template_version: unknown;
  preset_id: unknown;
  source_model: unknown;
  artifact_repository: unknown;
  model_revision: unknown;
  artifact_manifest_hash: unknown;
  inference_engine: unknown;
  inference_engine_version: unknown;
  dtype: unknown;
  pooling: unknown;
  normalize: unknown;
  maximum_tokens: unknown;
  input_contract: unknown;
  query_prefix: unknown;
  document_prefix: unknown;
  created_at: unknown;
}

interface RuntimeRow extends SqliteRow {
  singleton: unknown;
  active_profile_id: unknown;
  generation: unknown;
  activated_at: unknown;
}

interface CurrentEntryRow extends SqliteRow {
  current_revision: unknown;
  content_hash: unknown;
}

interface EntryEmbeddingRow extends SqliteRow {
  entry_id: unknown;
  profile_id: unknown;
  revision: unknown;
  content_hash: unknown;
  document_hash: unknown;
  dimensions: unknown;
  embedding: unknown;
  vector_hash: unknown;
  created_at: unknown;
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

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(`${label} must be a positive integer`);
  }
  return value;
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) invalid(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function storedHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) integrity(`${label} is invalid`);
  return value;
}

function storedTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') integrity(`${label} is invalid`);
  try {
    return validateTimestamp(value, label);
  } catch {
    integrity(`${label} is invalid`);
  }
}

function entryIdValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function requireProfileIdentity(identity: LocalEmbeddingProfileIdentity): void {
  if (identity.schemaVersion !== 1
    || identity.providerKind !== 'local-transformers'
    || identity.presetId !== 'local-small'
    || identity.sourceModel !== 'intfloat/multilingual-e5-small'
    || identity.artifactRepository !== 'Xenova/multilingual-e5-small'
    || !/^[0-9a-f]{40}$/u.test(identity.modelRevision)
    || !HASH_PATTERN.test(identity.artifactManifestHash)
    || identity.inferenceEngine !== 'transformers-js'
    || identity.inferenceEngineVersion.length === 0
    || identity.dtype !== 'q8'
    || identity.pooling !== 'mean'
    || identity.normalize !== true
    || identity.maximumTokens !== 512
    || identity.dimensions !== 384
    || identity.distanceMetric !== 'cosine'
    || identity.documentTemplateVersion !== 1
    || identity.queryTemplateVersion !== 1
    || identity.inputContract !== 'e5-query-passage-v1'
    || identity.queryPrefix !== 'query: '
    || identity.documentPrefix !== 'passage: '
    || !Number.isFinite(identity.distanceCeiling)
    || identity.distanceCeiling <= 0 || identity.distanceCeiling >= 2) {
    invalid('Embedding local profile identity is invalid');
  }
}

function requireProfile(profile: EmbeddingProfile): void {
  if (typeof profile.profileId !== 'string' || !HASH_PATTERN.test(profile.profileId)) invalid('Embedding profile ID is invalid');
  requireProfileIdentity(profile.identity);
  if (embeddingProfileId(profile.identity) !== profile.profileId) {
    invalid('Embedding profile ID does not match its identity');
  }
}

function profileIdentityFromRow(row: ProfileRow): EmbeddingProfile {
  if (typeof row.profile_id !== 'string' || !HASH_PATTERN.test(row.profile_id)
    || row.schema_version !== 1 || row.provider_kind !== 'local-transformers'
    || row.preset_id !== 'local-small' || row.source_model !== 'intfloat/multilingual-e5-small'
    || row.artifact_repository !== 'Xenova/multilingual-e5-small'
    || typeof row.model_revision !== 'string' || !/^[0-9a-f]{40}$/u.test(row.model_revision)
    || typeof row.artifact_manifest_hash !== 'string' || !HASH_PATTERN.test(row.artifact_manifest_hash)
    || row.inference_engine !== 'transformers-js'
    || typeof row.inference_engine_version !== 'string' || row.inference_engine_version.length === 0
    || row.dtype !== 'q8' || row.pooling !== 'mean' || row.normalize !== 1
    || row.maximum_tokens !== 512 || row.dimensions !== 384 || row.distance_metric !== 'cosine'
    || row.document_template_version !== 1 || row.query_template_version !== 1
    || row.input_contract !== 'e5-query-passage-v1' || row.query_prefix !== 'query: '
    || row.document_prefix !== 'passage: '
    || typeof row.distance_ceiling !== 'number' || !Number.isFinite(row.distance_ceiling)
    || row.distance_ceiling <= 0 || row.distance_ceiling >= 2) integrity('Stored local embedding profile is invalid');
  const identity: LocalEmbeddingProfileIdentity = {
      schemaVersion: 1,
      providerKind: 'local-transformers',
      presetId: 'local-small',
      sourceModel: 'intfloat/multilingual-e5-small',
      artifactRepository: 'Xenova/multilingual-e5-small',
      modelRevision: row.model_revision,
      artifactManifestHash: row.artifact_manifest_hash,
      inferenceEngine: 'transformers-js',
      inferenceEngineVersion: row.inference_engine_version,
      dtype: 'q8',
      pooling: 'mean',
      normalize: true,
      maximumTokens: 512,
      dimensions: 384,
      distanceMetric: 'cosine',
      distanceCeiling: row.distance_ceiling,
      inputContract: 'e5-query-passage-v1',
      documentTemplateVersion: 1,
      queryTemplateVersion: 1,
      queryPrefix: 'query: ',
      documentPrefix: 'passage: ',
    };
  if (embeddingProfileId(identity) !== row.profile_id) integrity('Stored local embedding profile ID does not match its identity');
  storedTimestamp(row.created_at, 'embedding profile created_at');
  return Object.freeze({ profileId: row.profile_id, identity: Object.freeze(identity) });
}

function profileIdentitiesEqual(left: LocalEmbeddingProfileIdentity, right: LocalEmbeddingProfileIdentity): boolean {
  return left.schemaVersion === right.schemaVersion && embeddingProfileId(left) === embeddingProfileId(right);
}

function schemaTables(database: SqliteDatabase): Set<string> {
  return new Set(database.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table' AND name IN (${EMBEDDING_TABLES.map(() => '?').join(', ')})
  `).all<{ name: string }>(...EMBEDDING_TABLES).map((row) => row.name));
}

function requireEmbeddingSchema(database: SqliteDatabase): void {
  const tables = schemaTables(database);
  const missing = EMBEDDING_TABLES.filter((table) => !tables.has(table));
  if (missing.length > 0) integrity(`Embedding projection schema is incomplete: missing ${missing.join(', ')}`);
}

function embeddingSchemaInstalled(database: SqliteDatabase): boolean {
  const tables = schemaTables(database);
  const present = EMBEDDING_TABLES.filter((table) => tables.has(table));
  if (present.length === 0) return false;
  if (present.length !== EMBEDDING_TABLES.length) {
    const missing = EMBEDDING_TABLES.filter((table) => !tables.has(table));
    integrity(`Embedding projection schema is incomplete: missing ${missing.join(', ')}`);
  }
  return true;
}

function readProfileRow(database: SqliteDatabase, profileId: string): EmbeddingProfile | undefined {
  const row = database.prepare(`
    SELECT profile_id, schema_version, provider_kind, dimensions,
           distance_metric, distance_ceiling, document_template_version,
           query_template_version, preset_id, source_model, artifact_repository,
           model_revision, artifact_manifest_hash, inference_engine,
           inference_engine_version, dtype, pooling, normalize, maximum_tokens,
           input_contract, query_prefix, document_prefix, created_at
      FROM embedding_profiles
     WHERE profile_id = ?
  `).get<ProfileRow>(profileId);
  return row === undefined ? undefined : profileIdentityFromRow(row);
}

export function readEmbeddingProfile(database: SqliteDatabase, profileId: string): EmbeddingProfile | undefined {
  hashValue(profileId, 'profileId');
  if (!embeddingSchemaInstalled(database)) return undefined;
  return readProfileRow(database, profileId);
}

export function readEmbeddingRuntimeState(database: SqliteDatabase): EmbeddingRuntimeState {
  requireEmbeddingSchema(database);
  const rows = database.prepare(`
    SELECT singleton, active_profile_id, generation, activated_at
      FROM embedding_runtime
  `).all<RuntimeRow>();
  if (rows.length !== 1) integrity('Embedding runtime must contain exactly one singleton row');
  const row = rows[0]!;
  if (row.singleton !== 1
    || (row.active_profile_id !== null && (typeof row.active_profile_id !== 'string' || !HASH_PATTERN.test(row.active_profile_id)))
    || typeof row.generation !== 'number'
    || !Number.isSafeInteger(row.generation)
    || row.generation < 1
    || (row.activated_at !== null && typeof row.activated_at !== 'string')) {
    integrity('Stored embedding runtime is invalid');
  }
  const activatedAt = row.activated_at === null ? null : storedTimestamp(row.activated_at, 'embedding runtime activated_at');
  if ((row.active_profile_id === null) !== (activatedAt === null)) integrity('Stored embedding runtime activation state is invalid');
  if (row.active_profile_id !== null && readProfileRow(database, row.active_profile_id) === undefined) {
    integrity('Active embedding profile is missing');
  }
  return { activeProfileId: row.active_profile_id, generation: row.generation, activatedAt };
}

export function readActiveEmbeddingProfile(database: SqliteDatabase): ActiveEmbeddingProfile | null {
  const runtime = readEmbeddingRuntimeState(database);
  if (runtime.activeProfileId === null || runtime.activatedAt === null) return null;
  const profile = readProfileRow(database, runtime.activeProfileId);
  if (profile === undefined) integrity('Active embedding profile is missing');
  return Object.freeze({ profile, generation: runtime.generation, activatedAt: runtime.activatedAt });
}

function currentEntry(database: SqliteDatabase, entryId: string): { revision: number; contentHash: string } {
  const row = database.prepare(`
    SELECT e.current_revision, r.content_hash
      FROM entries AS e
      JOIN entry_revisions AS r
        ON r.entry_id = e.id AND r.revision = e.current_revision
     WHERE e.id = ?
  `).get<CurrentEntryRow>(entryId);
  if (row === undefined) throw new KiokukoError('NOT_FOUND', 'Entry not found');
  if (typeof row.current_revision !== 'number' || !Number.isSafeInteger(row.current_revision) || row.current_revision < 1
    || typeof row.content_hash !== 'string' || row.content_hash.length === 0) {
    integrity('Current entry embedding source is invalid');
  }
  return { revision: row.current_revision, contentHash: row.content_hash };
}

function enqueueForProfile(database: SqliteDatabase, profileId: string, input: CurrentEntryEmbeddingJobInput): void {
  const current = currentEntry(database, input.entryId);
  if (current.revision !== input.revision || current.contentHash !== input.contentHash) {
    conflict('Entry changed before its embedding job could be enqueued');
  }
  database.prepare(`
    INSERT INTO embedding_jobs (
      entry_id, profile_id, revision, content_hash, state, attempts,
      available_at, lease_id, lease_expires_at, error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(entry_id, profile_id) DO UPDATE SET
      revision = excluded.revision,
      content_hash = excluded.content_hash,
      state = 'pending',
      attempts = 0,
      available_at = excluded.available_at,
      lease_id = NULL,
      lease_expires_at = NULL,
      error_code = NULL,
      updated_at = excluded.updated_at
  `).run(
    input.entryId,
    profileId,
    input.revision,
    input.contentHash,
    input.now,
    input.now,
    input.now,
  );
}

/** Enqueue the current entry revision for the active profile inside its caller-owned transaction. */
export function enqueueCurrentEntryEmbeddingInTransaction(
  database: SqliteDatabase,
  input: CurrentEntryEmbeddingJobInput,
): void {
  entryIdValue(input.entryId, 'entryId');
  const revision = positiveInteger(input.revision, 'revision');
  const contentHash = hashValue(input.contentHash, 'contentHash');
  const now = validateTimestamp(input.now, 'now');
  if (!embeddingSchemaInstalled(database)) return;
  const runtime = readEmbeddingRuntimeState(database);
  if (runtime.activeProfileId === null) return;
  enqueueForProfile(database, runtime.activeProfileId, { entryId: input.entryId, revision, contentHash, now });
}

/** Enqueue every current entry for an already-installed active profile. */
export function enqueueAllCurrentEntryEmbeddingsInTransaction(
  database: SqliteDatabase,
  requestedNow?: string,
  requestedWorkspace?: string,
): number {
  if (!embeddingSchemaInstalled(database)) return 0;
  const runtime = readEmbeddingRuntimeState(database);
  if (runtime.activeProfileId === null) return 0;
  const now = validateTimestamp(requestedNow ?? new Date().toISOString(), 'now');
  const workspace = requestedWorkspace === undefined ? undefined : requireWorkspace(requestedWorkspace);
  const rows = database.prepare(`
    SELECT e.id, e.current_revision, r.content_hash
      FROM entries AS e
      JOIN entry_revisions AS r
        ON r.entry_id = e.id AND r.revision = e.current_revision
      ${workspace === undefined ? '' : 'WHERE e.workspace = ?'}
     ORDER BY e.id ASC
  `).all<{ id: unknown; current_revision: unknown; content_hash: unknown }>(...(workspace === undefined ? [] : [workspace]));
  for (const row of rows) {
    const entryId = entryIdValue(row.id, 'entryId');
    const revision = positiveInteger(row.current_revision, 'revision');
    const contentHash = hashValue(row.content_hash, 'contentHash');
    enqueueForProfile(database, runtime.activeProfileId, { entryId, revision, contentHash, now });
  }
  return rows.length;
}

export function activateLocalEmbeddingProfileInTransaction(
  database: SqliteDatabase,
  profile: LocalEmbeddingProfile,
  options: ActivateEmbeddingProfileOptions,
): EmbeddingProfileActivation {
  requireProfile(profile);
  if (profile.identity.schemaVersion !== 1) invalid('Local embedding profile identity is invalid');
  if (typeof options.replace !== 'boolean') invalid('replace must be a boolean');
  const now = validateTimestamp(options.now ?? new Date().toISOString(), 'now');
  requireEmbeddingSchema(database);
  const existing = readProfileRow(database, profile.profileId);
  if (existing === undefined) {
    database.prepare(`
      INSERT INTO embedding_profiles (
        profile_id, schema_version, provider_kind,
        dimensions, distance_metric, distance_ceiling, document_template_version,
        query_template_version, preset_id, source_model, artifact_repository,
        model_revision, artifact_manifest_hash, inference_engine,
        inference_engine_version, dtype, pooling, normalize, maximum_tokens,
        input_contract, query_prefix, document_prefix, created_at
      ) VALUES (?, 1, 'local-transformers', 384, 'cosine', ?, 1, 1,
        ?, ?, ?, ?, ?, 'transformers-js', ?, 'q8', 'mean', 1, 512,
        'e5-query-passage-v1', 'query: ', 'passage: ', ?)
    `).run(
      profile.profileId,
      profile.identity.distanceCeiling,
      profile.identity.presetId,
      profile.identity.sourceModel,
      profile.identity.artifactRepository,
      profile.identity.modelRevision,
      profile.identity.artifactManifestHash,
      profile.identity.inferenceEngineVersion,
      now,
    );
  } else if (!profileIdentitiesEqual(existing.identity, profile.identity)) {
    conflict('Embedding profile ID already refers to different profile fields');
  }
  const runtime = readEmbeddingRuntimeState(database);
  if (runtime.activeProfileId === profile.profileId) return { profileId: profile.profileId, generation: runtime.generation, activated: false, enqueued: 0 };
  if (runtime.activeProfileId !== null && !options.replace) conflict('An active embedding profile already exists; use replace to switch it');
  const generation = runtime.activeProfileId === null ? runtime.generation : runtime.generation + 1;
  database.prepare(`
    UPDATE embedding_runtime SET active_profile_id = ?, generation = ?, activated_at = ?
     WHERE singleton = 1 AND generation = ?
  `).run(profile.profileId, generation, now, runtime.generation);
  const updated = readEmbeddingRuntimeState(database);
  if (updated.activeProfileId !== profile.profileId || updated.generation !== generation || updated.activatedAt !== now) conflict('Embedding runtime changed while activating a local profile');
  const enqueued = enqueueAllCurrentEntryEmbeddingsInTransaction(database, now);
  return { profileId: profile.profileId, generation, activated: true, enqueued };
}

export function activateLocalEmbeddingProfile(
  database: SqliteDatabase,
  profile: LocalEmbeddingProfile,
  options: ActivateEmbeddingProfileOptions,
): EmbeddingProfileActivation {
  return withImmediateTransaction(database, () => activateLocalEmbeddingProfileInTransaction(database, profile, options));
}

function storedEmbedding(row: EntryEmbeddingRow): StoredEntryEmbedding {
  const entryId = entryIdValue(row.entry_id, 'entryId');
  const profileId = hashValue(row.profile_id, 'profileId');
  const revision = positiveInteger(row.revision, 'revision');
  const contentHash = storedHash(row.content_hash, 'entry embedding content_hash');
  const documentHash = storedHash(row.document_hash, 'entry embedding document_hash');
  const dimensions = positiveInteger(row.dimensions, 'dimensions');
  if (dimensions < 2 || dimensions > 8192) integrity('Stored entry embedding dimensions are invalid');
  const vectorHash = storedHash(row.vector_hash, 'entry embedding vector_hash');
  const vector = decodeVector(row.embedding, dimensions, vectorHash);
  const createdAt = storedTimestamp(row.created_at, 'entry embedding created_at');
  return { entryId, profileId, revision, contentHash, documentHash, dimensions, vector, vectorHash, createdAt };
}

export function upsertEntryEmbeddingInTransaction(database: SqliteDatabase, input: EntryEmbeddingInput): void {
  requireEmbeddingSchema(database);
  entryIdValue(input.entryId, 'entryId');
  const profileId = hashValue(input.profileId, 'profileId');
  const profile = readProfileRow(database, profileId);
  if (profile === undefined) throw new KiokukoError('NOT_FOUND', 'Embedding profile not found');
  const revision = positiveInteger(input.revision, 'revision');
  const contentHash = hashValue(input.contentHash, 'contentHash');
  const documentHash = hashValue(input.documentHash, 'documentHash');
  const createdAt = validateTimestamp(input.createdAt, 'createdAt');
  const current = currentEntry(database, input.entryId);
  if (current.revision !== revision || current.contentHash !== contentHash) {
    conflict('Entry changed before its embedding could be stored');
  }
  const bytes = encodeVector(input.vector, profile.identity.dimensions);
  const vectorHash = hashVectorBytes(bytes);
  database.prepare(`
    INSERT INTO entry_embeddings (
      entry_id, profile_id, revision, content_hash, document_hash,
      dimensions, embedding, vector_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id, profile_id) DO UPDATE SET
      revision = excluded.revision,
      content_hash = excluded.content_hash,
      document_hash = excluded.document_hash,
      dimensions = excluded.dimensions,
      embedding = excluded.embedding,
      vector_hash = excluded.vector_hash,
      created_at = excluded.created_at
  `).run(
    input.entryId,
    profileId,
    revision,
    contentHash,
    documentHash,
    profile.identity.dimensions,
    bytes,
    vectorHash,
    createdAt,
  );
}

export function upsertEntryEmbedding(
  database: SqliteDatabase,
  input: EntryEmbeddingInput,
): void {
  withImmediateTransaction(database, () => upsertEntryEmbeddingInTransaction(database, input));
}

export function readEntryEmbedding(
  database: SqliteDatabase,
  input: { entryId: string; profileId: string },
): StoredEntryEmbedding | undefined {
  requireEmbeddingSchema(database);
  const entryId = entryIdValue(input.entryId, 'entryId');
  const profileId = hashValue(input.profileId, 'profileId');
  const row = database.prepare(`
    SELECT entry_id, profile_id, revision, content_hash, document_hash,
           dimensions, embedding, vector_hash, created_at
      FROM entry_embeddings
     WHERE entry_id = ? AND profile_id = ?
  `).get<EntryEmbeddingRow>(entryId, profileId);
  return row === undefined ? undefined : storedEmbedding(row);
}
