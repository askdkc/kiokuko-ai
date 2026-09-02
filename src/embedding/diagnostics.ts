import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { getEmbeddingPresetDirectory } from '../config/paths.js';
import { parseEmbeddingConfig, isEnabledEmbeddingConfig } from './config.js';
import { embeddingProfileId } from './profile.js';
import { LOCAL_SMALL_PRESET } from './presets/local-small.js';
import { readActiveEmbeddingProfile, readEmbeddingRuntimeState, readEntryEmbedding } from './store.js';
import { decodeVector, hashVectorBytes } from './vector.js';
import { verifyInstalledModelDirectorySync } from './model-manifest.js';
import { buildEmbeddingDocumentForProfile } from './document.js';
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js';
import { readEntry } from '../memory/entries.js';
import type { EmbeddingConfig, EmbeddingMode, EmbeddingProfile, VectorSearchBackend } from './types.js';
import { readPersistedEmbeddingSettings } from './settings.js';

const EMBEDDING_TABLES = [
  'embedding_profiles',
  'embedding_runtime',
  'entry_embeddings',
  'embedding_jobs',
  'query_embeddings',
] as const;

const EMBEDDING_INDEXES = [
  'idx_entry_embeddings_profile_revision',
  'idx_embedding_jobs_claim',
  'idx_query_embeddings_lru',
] as const;

export interface EmbeddingStatus {
  readonly mode: EmbeddingMode;
  readonly activeProfileId: string | null;
  readonly providerKind: string | null;
  readonly model: string | null;
  readonly dimensions: number | null;
  readonly distanceMetric: string | null;
  readonly distanceCeiling: number | null;
  readonly backend: string | null;
  readonly backendVersion: string | null;
  readonly eligibleEntries: number;
  readonly readyVectors: number;
  readonly staleVectors: number;
  readonly missingVectors: number;
  readonly pendingJobs: number;
  readonly leasedJobs: number;
  readonly failedJobs: number;
  readonly blockedJobs: number;
  readonly coverageRatio: number;
  readonly queryCacheRows: number;
}

export interface EmbeddingHealth {
  readonly status: EmbeddingStatus;
  readonly check: {
    readonly ok: boolean;
    readonly count: number;
    readonly detail: string;
  };
}

interface VectorRow extends SqliteRow {
  entry_id: unknown;
  profile_id: unknown;
  dimensions: unknown;
  embedding: unknown;
  vector_hash: unknown;
}

function countRows(database: SqliteDatabase, sql: string, ...parameters: Array<string | number>): number {
  return Number(database.prepare(sql).get<{ count: number }>(...parameters)?.count ?? 0);
}

function eligibleCurrentEntries(database: SqliteDatabase): ReturnType<typeof readEntry>[] {
  return database.prepare(`
    SELECT e.id, e.workspace
      FROM entries AS e
     WHERE e.status <> 'superseded'
     ORDER BY e.workspace ASC, e.id ASC
  `).all<{ id: string; workspace: string }>().map((row) => {
    const entry = readEntry(database, { workspace: row.workspace, entryId: row.id });
    return isRetrievableEntry(database, entry) ? entry : undefined;
  }).filter((entry): entry is ReturnType<typeof readEntry> => entry !== undefined);
}

function readyCurrentVectors(
  database: SqliteDatabase,
  profile: EmbeddingProfile,
  entries: readonly ReturnType<typeof readEntry>[],
): number {
  let ready = 0;
  for (const entry of entries) {
    const embedding = readEntryEmbedding(database, { entryId: entry.id, profileId: profile.profileId });
    if (embedding === undefined || embedding.revision !== entry.revision || embedding.contentHash !== entry.contentHash
      || embedding.dimensions !== profile.identity.dimensions) continue;
    const document = buildEmbeddingDocumentForProfile({
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      body: entry.body,
      tags: entry.tags,
      scope: entry.scope,
    }, profile.identity);
    if (embedding.documentHash === document.documentHash) ready += 1;
  }
  return ready;
}

function objectNames(database: SqliteDatabase, kind: 'table' | 'index' | 'trigger'): Set<string> {
  return new Set(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = ? AND name IS NOT NULL
  `).all<{ name: string }>(kind).map((row) => row.name));
}

function configuredBackend(config: EmbeddingConfig, backend: VectorSearchBackend | undefined): { id: string | null; version: string | null } {
  if (config.mode === 'off') return { id: null, version: null };
  if (backend !== undefined) return { id: backend.id, version: backend.id === 'sqlite-vec' ? 'v0.1.9' : null };
  if (config.vectorBackend === 'sqlite-vec') return { id: 'sqlite-vec', version: 'v0.1.9' };
  return { id: 'javascript', version: null };
}

function emptyStatus(config: EmbeddingConfig, backend?: VectorSearchBackend): EmbeddingStatus {
  const selectedBackend = configuredBackend(config, backend);
  return {
    mode: config.mode,
    activeProfileId: null,
    providerKind: config.mode === 'off' ? null : config.provider,
    model: config.mode === 'off' ? null : LOCAL_SMALL_PRESET.sourceModel,
    dimensions: config.mode === 'off' ? null : LOCAL_SMALL_PRESET.dimensions,
    distanceMetric: config.mode === 'off' ? null : 'cosine',
    distanceCeiling: config.mode === 'off' ? null : LOCAL_SMALL_PRESET.distanceCeiling,
    backend: selectedBackend.id,
    backendVersion: selectedBackend.version,
    eligibleEntries: 0,
    readyVectors: 0,
    staleVectors: 0,
    missingVectors: 0,
    pendingJobs: 0,
    leasedJobs: 0,
    failedJobs: 0,
    blockedJobs: 0,
    coverageRatio: 0,
    queryCacheRows: 0,
  };
}

function activeStatus(
  database: SqliteDatabase,
  config: EmbeddingConfig,
  active: EmbeddingProfile | null,
  backend?: VectorSearchBackend,
): EmbeddingStatus {
  const selectedBackend = configuredBackend(config, backend);
  const eligible = eligibleCurrentEntries(database);
  const eligibleEntries = eligible.length;
  if (active === null) {
    return { ...emptyStatus(config, backend), eligibleEntries, missingVectors: eligibleEntries };
  }
  const readyVectors = readyCurrentVectors(database, active, eligible);
  const totalVectors = countRows(database, 'SELECT COUNT(*) AS count FROM entry_embeddings WHERE profile_id = ?', active.profileId);
  const jobs = new Map<string, number>(
    database.prepare(`
      SELECT state, COUNT(*) AS count
        FROM embedding_jobs
       WHERE profile_id = ?
       GROUP BY state
    `).all<{ state: string; count: number }>(active.profileId).map((row) => [row.state, Number(row.count)]),
  );
  const selected = {
    pending: jobs.get('pending') ?? 0,
    leased: jobs.get('leased') ?? 0,
    failed: jobs.get('failed') ?? 0,
    blocked: jobs.get('blocked') ?? 0,
  };
  const queryCacheRows = countRows(database, 'SELECT COUNT(*) AS count FROM query_embeddings WHERE profile_id = ?', active.profileId);
  return {
    mode: config.mode,
    activeProfileId: active.profileId,
    providerKind: active.identity.providerKind,
    model: active.identity.sourceModel,
    dimensions: active.identity.dimensions,
    distanceMetric: active.identity.distanceMetric,
    distanceCeiling: active.identity.distanceCeiling,
    backend: selectedBackend.id,
    backendVersion: selectedBackend.version,
    eligibleEntries,
    readyVectors,
    staleVectors: Math.max(0, totalVectors - readyVectors),
    missingVectors: Math.max(0, eligibleEntries - readyVectors),
    pendingJobs: selected.pending,
    leasedJobs: selected.leased,
    failedJobs: selected.failed,
    blockedJobs: selected.blocked,
    coverageRatio: eligibleEntries === 0 ? 0 : readyVectors / eligibleEntries,
    queryCacheRows,
  };
}

export function readEmbeddingStatus(
  database: SqliteDatabase,
  config: EmbeddingConfig = readPersistedEmbeddingSettings(database),
  backend?: VectorSearchBackend,
): EmbeddingStatus {
  const runtime = readEmbeddingRuntimeState(database);
  const active = readActiveEmbeddingProfile(database);
  if (active !== null && runtime.activeProfileId !== active.profile.profileId) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Embedding runtime active profile is inconsistent');
  }
  return activeStatus(database, config, active?.profile ?? null, backend);
}

function inspectVectors(database: SqliteDatabase): number {
  let findings = 0;
  const rows = database.prepare(`
    SELECT entry_id, profile_id, dimensions, embedding, vector_hash
      FROM entry_embeddings
     ORDER BY profile_id ASC, entry_id ASC
  `).all<VectorRow>();
  for (const row of rows) {
    try {
      if (typeof row.profile_id !== 'string' || typeof row.dimensions !== 'number' || typeof row.vector_hash !== 'string') {
        findings += 1;
        continue;
      }
      const bytes = row.embedding instanceof Uint8Array ? row.embedding : null;
      if (bytes === null || bytes.byteLength !== row.dimensions * 4 || hashVectorBytes(bytes) !== row.vector_hash) {
        findings += 1;
        continue;
      }
      decodeVector(bytes, row.dimensions, row.vector_hash);
    } catch {
      findings += 1;
    }
  }
  return findings;
}

function inspectQueryCache(database: SqliteDatabase): number {
  let findings = 0;
  const rows = database.prepare(`
    SELECT profile_id, dimensions, embedding, vector_hash
      FROM query_embeddings
     ORDER BY profile_id ASC, query_hash ASC
  `).all<VectorRow>();
  for (const row of rows) {
    try {
      if (typeof row.dimensions !== 'number' || typeof row.vector_hash !== 'string' || !(row.embedding instanceof Uint8Array)) {
        findings += 1;
        continue;
      }
      decodeVector(row.embedding, row.dimensions, row.vector_hash);
    } catch {
      findings += 1;
    }
  }
  return findings;
}

function inspectJobReferences(database: SqliteDatabase): number {
  return countRows(database, `
    SELECT COUNT(*) AS count
      FROM embedding_jobs AS j
      LEFT JOIN entries AS e ON e.id = j.entry_id
      LEFT JOIN entry_revisions AS r ON r.entry_id = j.entry_id AND r.revision = j.revision
     WHERE e.id IS NULL OR r.entry_id IS NULL
        OR (j.state = 'leased' AND (j.lease_id IS NULL OR j.lease_expires_at IS NULL))
        OR (j.state <> 'leased' AND (j.lease_id IS NOT NULL OR j.lease_expires_at IS NOT NULL))
  `);
}

function inspectConfiguration(
  database: SqliteDatabase,
  config: EmbeddingConfig,
  active: ReturnType<typeof readActiveEmbeddingProfile>,
  backend: VectorSearchBackend | undefined,
  environment: NodeJS.ProcessEnv | EmbeddingConfig,
): number {
  if (config.mode === 'off') return 0;
  let findings = 0;
  if (active === null || !isEnabledEmbeddingConfig(config)) findings += 1;
  else if (active.profile.identity.providerKind !== 'local-transformers') {
    findings += 1;
  } else {
    try {
      if (embeddingProfileId(active.profile.identity) !== active.profile.profileId) findings += 1;
    } catch {
      findings += 1;
    }
    const settings = database.prepare(`
      SELECT provider_kind, preset_id, setup_state
        FROM embedding_settings
       WHERE singleton = 1
    `).get<{ provider_kind: unknown; preset_id: unknown; setup_state: unknown }>();
    if (settings === undefined
      || settings.provider_kind !== active.profile.identity.providerKind
      || settings.preset_id !== active.profile.identity.presetId
      || settings.setup_state !== 'ready') findings += 1;
    const installation = database.prepare(`
      SELECT i.installation_id, i.preset_id, i.repository_id, i.revision,
             i.artifact_manifest_hash, i.relative_path, i.state, i.total_bytes
        FROM embedding_settings AS s
        LEFT JOIN embedding_model_installations AS i
          ON i.installation_id = s.model_installation_id
       WHERE s.singleton = 1
    `).get<{
      installation_id: unknown;
      preset_id: unknown;
      repository_id: unknown;
      revision: unknown;
      artifact_manifest_hash: unknown;
      relative_path: unknown;
      state: unknown;
      total_bytes: unknown;
    }>();
    const identity = active.profile.identity;
    const expectedRelativePath = `models/embeddings/${LOCAL_SMALL_PRESET.id}/${LOCAL_SMALL_PRESET.revision}`;
    if (settings?.setup_state === 'ready'
      && (installation?.installation_id === undefined
        || installation.preset_id !== identity.presetId
        || installation.repository_id !== identity.artifactRepository
        || installation.revision !== identity.modelRevision
        || installation.artifact_manifest_hash !== identity.artifactManifestHash
        || installation.relative_path !== expectedRelativePath
        || installation.state !== 'verified'
        || typeof installation.total_bytes !== 'number')) {
      findings += 1;
    }
    if (settings?.setup_state === 'ready') {
      try {
        const pathOptions = isEmbeddingConfig(environment) ? {} : { env: environment };
        const manifest = verifyInstalledModelDirectorySync(
          getEmbeddingPresetDirectory(identity.presetId, identity.modelRevision, pathOptions),
          LOCAL_SMALL_PRESET,
        );
        if (manifest.artifactManifestHash !== identity.artifactManifestHash) findings += 1;
      } catch {
        findings += 1;
      }
    }
  }
  if (config.vectorBackend === 'sqlite-vec' && backend?.id !== 'sqlite-vec') findings += 1;
  return findings;
}

function safeConfig(environment: NodeJS.ProcessEnv): { config?: EmbeddingConfig; invalid: boolean } {
  try {
    return { config: parseEmbeddingConfig(environment), invalid: false };
  } catch {
    return { invalid: true };
  }
}

function isEmbeddingConfig(value: NodeJS.ProcessEnv | EmbeddingConfig): value is EmbeddingConfig {
  return typeof value.mode === 'string' && typeof value.provider === 'string'
    && typeof value.vectorBackend === 'string'
    && typeof value.timeoutMs === 'number' && typeof value.batchSize === 'number';
}

export function inspectEmbeddingHealth(
  database: SqliteDatabase,
  environment: NodeJS.ProcessEnv | EmbeddingConfig = readPersistedEmbeddingSettings(database),
  backend?: VectorSearchBackend,
): EmbeddingHealth {
  const parsed = isEmbeddingConfig(environment)
    ? { config: environment, invalid: false }
    : safeConfig(environment);
  const config: EmbeddingConfig = (isEmbeddingConfig(environment) ? environment : parsed.config) ?? {
    mode: 'off',
    provider: 'local-transformers',
    vectorBackend: 'auto',
    timeoutMs: 30_000,
    batchSize: 16,
  };
  let status = emptyStatus(config, backend);
  let findings = parsed.invalid ? 1 : 0;
  const tables = objectNames(database, 'table');
  const indexes = objectNames(database, 'index');
  const triggers = objectNames(database, 'trigger');
  findings += EMBEDDING_TABLES.filter((name) => !tables.has(name)).length;
  findings += EMBEDDING_INDEXES.filter((name) => !indexes.has(name)).length;
  if (!triggers.has('embedding_profiles_immutable_update')) findings += 1;

  try {
    const runtime = readEmbeddingRuntimeState(database);
    const active = readActiveEmbeddingProfile(database);
    status = activeStatus(database, config, active?.profile ?? null, backend);
    findings += inspectConfiguration(database, config, active, backend, environment);
    findings += inspectVectors(database);
    findings += inspectQueryCache(database);
    findings += inspectJobReferences(database);
    const runtimeRows = countRows(database, 'SELECT COUNT(*) AS count FROM embedding_runtime');
    if (runtimeRows !== 1) findings += 1;
    const stale = countRows(database, `
      SELECT COUNT(*) AS count
        FROM entry_embeddings AS ee
        JOIN entries AS e ON e.id = ee.entry_id
        JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
       WHERE ee.revision != e.current_revision OR ee.content_hash != r.content_hash
    `);
    if (stale !== status.staleVectors) findings += 1;
  } catch {
    findings += 1;
  }

  return {
    status,
    check: {
      ok: findings === 0,
      count: findings,
      detail: parsed.invalid ? `findings=${findings}, configuration=invalid` : `findings=${findings}, mode=${config.mode}, backend=${status.backend ?? 'disabled'}`,
    },
  };
}
