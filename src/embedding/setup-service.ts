import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readEntry } from '../memory/entries.js';
import { buildCanonicalEmbeddingDocument, renderEmbeddingProviderInput } from './document.js';
import { claimEmbeddingJobs, failEmbeddingJob, finalizeEmbeddingJob, listEmbeddingJobs } from './jobs.js';
import { acquireEmbeddingSetupLock } from './setup-lock.js';
import { installEmbeddingModel, type InstalledModel } from './model-installation.js';
import { LOCAL_SMALL_PRESET } from './presets/local-small.js';
import { createLocalEmbeddingProfile } from './profile.js';
import { activateLocalEmbeddingProfileInTransaction } from './store.js';
import { EmbeddingProviderError } from './provider.js';
import type { EmbeddingJobErrorCode } from './jobs.js';
import type { ModelDownloader, ModelDownloadProgress } from './model-download.js';
import type { SqliteDatabase } from '../db/adapter.js';
import type { EmbeddingProvider } from './types.js';
import type { PathEnvironment } from '../config/paths.js';

export interface EmbeddingSetupInput {
  readonly presetId: string;
  readonly confirmed: boolean;
  readonly dryRun: boolean;
  readonly offline: boolean;
  readonly replace: boolean;
}

export interface EmbeddingSetupResult {
  readonly presetId: string;
  readonly model: { readonly repository: string; readonly revision: string; readonly installation: 'installed' | 'reused'; readonly bytes: number };
  readonly migration: { readonly fromVersion: number; readonly toVersion: number; readonly backupPath: string | null; readonly applied: readonly number[] };
  readonly profile: { readonly profileId: string; readonly generation: number; readonly activated: boolean };
  readonly embeddings: { readonly eligible: number; readonly completed: number; readonly failed: number; readonly blocked: number; readonly remaining: number };
  readonly backend: string;
  readonly semanticEnabled: boolean;
  readonly restartRequired: boolean;
}

export interface EmbeddingSetupOptions extends PathEnvironment {
  readonly downloader?: ModelDownloader;
  readonly installer?: (preset: typeof LOCAL_SMALL_PRESET, options: EmbeddingSetupOptions) => Promise<InstalledModel>;
  readonly provider?: EmbeddingProvider;
  readonly backendId?: string;
  readonly now?: () => string;
  readonly onProgress?: (progress: ModelDownloadProgress) => void;
}

function now(options: EmbeddingSetupOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function setupFailureCode(error: unknown): EmbeddingJobErrorCode {
  if (error instanceof EmbeddingProviderError) return error.code;
  if (error instanceof KiokukoError && error.code === 'SECURITY_REJECTION') return 'secret_blocked';
  if (error instanceof KiokukoError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) return 'entry_changed';
  if (error instanceof KiokukoError && error.code === 'SERVICE_UNAVAILABLE') return 'provider_unavailable';
  if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') return 'dimension_mismatch';
  return 'provider_unavailable';
}

async function installationExists(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function installationId(presetId: string, revision: string, manifestHash: string): string {
  return createHash('sha256').update(`${presetId}\u0000${revision}\u0000${manifestHash}`, 'utf8').digest('hex');
}

function activateSettings(database: SqliteDatabase, input: { installationId: string; setupState: 'installing' | 'ready' | 'degraded'; now: string }): void {
  database.prepare(`
    UPDATE embedding_settings
       SET mode = 'optional', provider_kind = 'local-transformers', preset_id = ?,
           model_installation_id = ?, vector_backend = 'auto', batch_size = 16,
           timeout_ms = 30000, setup_state = ?, updated_at = ?
     WHERE singleton = 1
  `).run(LOCAL_SMALL_PRESET.id, input.installationId, input.setupState, input.now);
}

async function drainSetupJobs(
  database: SqliteDatabase,
  provider: EmbeddingProvider,
  profileId: string,
  generation: number,
  options: EmbeddingSetupOptions,
): Promise<{ completed: number; failed: number; blocked: number; remaining: number }> {
  let completed = 0;
  let failed = 0;
  let blocked = 0;
  for (let round = 0; round < 3; round += 1) {
    const jobs = claimEmbeddingJobs(database, { maxJobs: 64, now: now(options) });
    if (jobs.length === 0) break;
    for (const job of jobs) {
      try {
        const entry = readEntry(database, { workspace: job.workspace, entryId: job.entryId });
        const canonical = buildCanonicalEmbeddingDocument({
          kind: entry.kind,
          title: entry.title,
          summary: entry.summary,
          body: entry.body,
          tags: entry.tags,
          scope: entry.scope,
        });
        const providerInput = renderEmbeddingProviderInput(canonical.text);
        const vectors = await provider.embed([providerInput]);
        if (vectors.length !== 1) throw new KiokukoError('VALIDATION_ERROR', 'Local provider returned an invalid batch');
        const documentHash = canonical.documentHash;
        finalizeEmbeddingJob(database, {
          entryId: job.entryId,
          profileId,
          generation,
          leaseId: job.leaseId,
          revision: job.revision,
          contentHash: job.contentHash,
          documentHash,
          vector: vectors[0]!,
          now: now(options),
        });
        completed += 1;
      } catch (error) {
        const code = setupFailureCode(error);
        if (code === 'secret_blocked') blocked += 1;
        else failed += 1;
        const transitioned = failEmbeddingJob(database, {
          entryId: job.entryId,
          profileId,
          generation,
          leaseId: job.leaseId,
          errorCode: code,
          availableAt: now(options),
          now: now(options),
          permanent: code === 'secret_blocked' || code === 'dimension_mismatch',
        });
        if (!transitioned) {
          if (code === 'secret_blocked') blocked -= 1;
          else failed -= 1;
        }
      }
    }
  }
  const remaining = listEmbeddingJobs(database, { profileId }).length;
  return { completed, failed, blocked, remaining };
}

export async function runEmbeddingSetup(
  database: SqliteDatabase,
  input: EmbeddingSetupInput,
  options: EmbeddingSetupOptions = {},
): Promise<EmbeddingSetupResult> {
  if (input.presetId !== LOCAL_SMALL_PRESET.id) throw new KiokukoError('VALIDATION_ERROR', 'Only the local-small embedding preset is supported');
  if (typeof input.confirmed !== 'boolean' || typeof input.dryRun !== 'boolean' || typeof input.offline !== 'boolean' || typeof input.replace !== 'boolean') {
    throw new KiokukoError('VALIDATION_ERROR', 'Embedding setup options are invalid');
  }
  const eligible = Number(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count ?? 0);
  const fromVersion = Number(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get<{ version: number }>()?.version ?? 0);
  if (input.dryRun) {
    return {
      presetId: LOCAL_SMALL_PRESET.id,
      model: { repository: LOCAL_SMALL_PRESET.artifactRepository, revision: LOCAL_SMALL_PRESET.revision, installation: 'reused', bytes: LOCAL_SMALL_PRESET.files.reduce((sum, file) => sum + file.size, 0) },
      migration: { fromVersion, toVersion: fromVersion, backupPath: null, applied: [] },
      profile: { profileId: createLocalEmbeddingProfile(LOCAL_SMALL_PRESET).profileId, generation: 0, activated: false },
      embeddings: { eligible, completed: 0, failed: 0, blocked: 0, remaining: eligible },
      backend: options.backendId ?? 'javascript',
      semanticEnabled: false,
      restartRequired: false,
    };
  }
  if (!input.confirmed) throw new KiokukoError('USAGE_ERROR', 'Embedding setup requires explicit confirmation');
  const lock = await acquireEmbeddingSetupLock(options);
  try {
    const finalDirectory = (await import('../config/paths.js')).getEmbeddingPresetDirectory(LOCAL_SMALL_PRESET.id, LOCAL_SMALL_PRESET.revision, options);
    if (input.offline && !(await installationExists(finalDirectory))) throw new KiokukoError('SERVICE_UNAVAILABLE', 'The pinned local embedding model is not installed for offline setup');
    const installed = await (options.installer ?? installEmbeddingModel)(LOCAL_SMALL_PRESET, {
      ...options,
      ...(input.offline ? { downloader: { download: async () => { throw new KiokukoError('SERVICE_UNAVAILABLE', 'Offline setup cannot download the model'); } } } : {}),
    });
    const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
    const setupNow = now(options);
    const setupId = randomUUID();
    const installation = installationId(LOCAL_SMALL_PRESET.id, LOCAL_SMALL_PRESET.revision, installed.manifestHash);
    const activation = withImmediateTransaction(database, () => {
      database.prepare(`
        INSERT INTO embedding_model_installations (
          installation_id, preset_id, repository_id, revision, artifact_manifest_hash,
          relative_path, state, total_bytes, installed_at, verified_at, last_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET state = 'verified', verified_at = excluded.verified_at, last_checked_at = excluded.last_checked_at
      `).run(installation, LOCAL_SMALL_PRESET.id, LOCAL_SMALL_PRESET.artifactRepository, LOCAL_SMALL_PRESET.revision, installed.manifestHash, installed.relativePath, installed.totalBytes, setupNow, setupNow, setupNow);
      database.prepare(`
        INSERT INTO embedding_setup_runs (setup_id, preset_id, phase, initial_entry_count, processed_entry_count, started_at, updated_at)
        VALUES (?, ?, 'activating', ?, 0, ?, ?)
      `).run(setupId, LOCAL_SMALL_PRESET.id, eligible, setupNow, setupNow);
      const result = activateLocalEmbeddingProfileInTransaction(database, profile, { replace: input.replace, now: setupNow });
      activateSettings(database, { installationId: installation, setupState: 'installing', now: setupNow });
      database.prepare('UPDATE embedding_setup_runs SET active_profile_id = ?, model_installation_id = ?, phase = \'embedding\', updated_at = ? WHERE setup_id = ?').run(profile.profileId, installation, setupNow, setupId);
      return result;
    });
    const provider = options.provider ?? new (await import('./local-transformers-provider.js')).LocalTransformersEmbeddingProvider({ profile: profile.identity, modelDirectory: installed.directory });
    let drain;
    try {
      drain = await drainSetupJobs(database, provider, profile.profileId, activation.generation, options);
    } finally {
      await (provider as { close?: () => Promise<void> }).close?.();
    }
    const finalState = drain.remaining === 0 ? 'ready' : 'degraded';
    withImmediateTransaction(database, () => {
      activateSettings(database, { installationId: installation, setupState: finalState, now: now(options) });
      database.prepare('UPDATE embedding_setup_runs SET phase = ?, processed_entry_count = ?, updated_at = ?, completed_at = ? WHERE setup_id = ?').run(finalState === 'ready' ? 'completed' : 'failed', drain.completed, now(options), now(options), setupId);
    });
    return {
      presetId: LOCAL_SMALL_PRESET.id,
      model: { repository: LOCAL_SMALL_PRESET.artifactRepository, revision: LOCAL_SMALL_PRESET.revision, installation: installed.installation, bytes: installed.totalBytes },
      migration: { fromVersion, toVersion: fromVersion, backupPath: null, applied: [] },
      profile: { profileId: profile.profileId, generation: activation.generation, activated: activation.activated },
      embeddings: { eligible, completed: drain.completed, failed: drain.failed, blocked: drain.blocked, remaining: drain.remaining },
      backend: options.backendId ?? 'javascript',
       semanticEnabled: finalState === 'ready',
      restartRequired: true,
    };
  } finally {
    await lock.release();
  }
}
