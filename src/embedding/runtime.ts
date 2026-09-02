import { createHash } from 'node:crypto';
import { KiokukoError } from '../errors.js';
import { readEntry } from '../memory/entries.js';
import { buildEmbeddingDocumentForProfile, renderEmbeddingDocumentInputForProfile } from './document.js';
import {
  claimEmbeddingJobs,
  EMBEDDING_JOB_MAX_ATTEMPTS,
  failEmbeddingJob,
  finalizeEmbeddingJob,
  listEmbeddingJobs,
  type ClaimedEmbeddingJob,
  type EmbeddingJobErrorCode,
} from './jobs.js';
import { requireEnabledEmbeddingConfig } from './config.js';
import { embeddingProfileId } from './profile.js';
import {
  QueryEmbeddingSingleFlight,
  queryEmbeddingCacheKey,
  queryEmbeddingHashForProfile,
  renderEmbeddingQueryInputForProfile,
  readQueryEmbedding,
  writeQueryEmbedding,
  type StoredQueryEmbedding,
} from './query-cache.js';
import { JavaScriptVectorSearchBackend } from './javascript-backend.js';
import { EmbeddingProviderError } from './provider.js';
import { normalizeVector } from './vector.js';
import { readActiveEmbeddingProfile, readEntryEmbedding } from './store.js';
import { defaultEmbeddingConfig, readPersistedEmbeddingSettings } from './settings.js';
import { getEmbeddingPresetDirectory } from '../config/paths.js';
import { LocalTransformersEmbeddingProvider } from './local-transformers-provider.js';
import type {
  EmbeddingConfig,
  EmbeddingDrainResult,
  EmbeddingMode,
  EmbeddingProfile,
  EmbeddingProvider,
  EmbeddingRuntime,
  EnabledEmbeddingConfig,
  PreparedSemanticQuery,
  VectorSearchBackend,
} from './types.js';
import type { SqliteDatabase } from '../db/adapter.js';
import type { HybridSearchRuntime } from '../memory/hybrid-retrieval.js';

const MAX_DRAIN_JOBS = 64;
const MAX_DRAIN_DEADLINE_MS = 120_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export interface EmbeddingRuntimeOptions {
  readonly provider?: EmbeddingProvider;
  readonly backend?: VectorSearchBackend;
  readonly now?: () => string;
  readonly enqueueWrite?: <T>(operation: () => T | PromiseLike<T>) => Promise<T>;
  readonly profile?: EmbeddingProfile;
}

interface EnabledRuntimeState {
  readonly config: EnabledEmbeddingConfig;
  readonly profile: EmbeddingProfile;
  readonly generation: number;
  readonly provider: EmbeddingProvider;
  readonly backend: VectorSearchBackend;
  readonly now: () => string;
}

interface PendingEmbeddingJob {
  readonly job: ClaimedEmbeddingJob;
  readonly documentHash: string;
  readonly text: string;
}

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function unavailable(message = 'Embedding runtime is unavailable'): never {
  throw new KiokukoError('SERVICE_UNAVAILABLE', message);
}

function disabledRuntime(mode: EmbeddingMode): EmbeddingRuntime {
  return Object.freeze({
    mode,
    profileId: null,
    backendId: null,
    backend: null,
    prepareQuery: async () => null,
    drain: async () => ({ claimed: 0, completed: 0, failed: 0, blocked: 0, remaining: 0 }),
    close: async () => undefined,
  });
}

function profileMatches(provider: EmbeddingProvider, profile: EmbeddingProfile): boolean {
  try {
    return embeddingProfileId(provider.profile) === profile.profileId;
  } catch {
    return false;
  }
}

function validateDrainOptions(options: { maxJobs: number; deadlineMs: number }): void {
  if (!Number.isSafeInteger(options.maxJobs) || options.maxJobs < 1 || options.maxJobs > MAX_DRAIN_JOBS) invalid('maxJobs is invalid');
  if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > MAX_DRAIN_DEADLINE_MS) invalid('deadlineMs is invalid');
}

function retryable(code: EmbeddingJobErrorCode): boolean {
  return code === 'timeout' || code === 'rate_limited' || code === 'provider_unavailable';
}

function retryDelay(job: ClaimedEmbeddingJob): number {
  if (!retryable(job.errorCode ?? 'provider_unavailable') || job.attempts >= EMBEDDING_JOB_MAX_ATTEMPTS) return 0;
  const jitterSeed = createHash('sha256')
    .update(`${job.entryId}\u0000${job.profileId}\u0000${job.attempts}`, 'utf8')
    .digest()
    .readUInt16BE(0);
  const exponential = RETRY_BASE_MS * (2 ** Math.min(6, Math.max(0, job.attempts - 1)));
  return Math.min(RETRY_MAX_MS, exponential + (jitterSeed % 251));
}

function providerFailureCode(error: unknown): EmbeddingJobErrorCode {
  if (error instanceof EmbeddingProviderError) return error.code;
  if (error instanceof KiokukoError && error.code === 'SECURITY_REJECTION') return 'secret_blocked';
  return 'provider_unavailable';
}

function permanentFailure(code: EmbeddingJobErrorCode): boolean {
  return code === 'invalid_response'
    || code === 'dimension_mismatch'
    || code === 'secret_blocked'
    || code === 'profile_changed';
}

function preparedQuery(
  profile: EmbeddingProfile,
  backend: VectorSearchBackend,
  cached: { vector: Float32Array; vectorHash: string },
): PreparedSemanticQuery {
  return {
    profileId: profile.profileId,
    dimensions: profile.identity.dimensions,
    vector: new Float32Array(cached.vector),
    vectorHash: cached.vectorHash,
    backendId: backend.id,
    distanceCeiling: profile.identity.distanceCeiling,
  };
}

function failureAvailableAt(job: ClaimedEmbeddingJob, errorCode: EmbeddingJobErrorCode, now: string): string {
  const delay = errorCode === 'secret_blocked' || permanentFailure(errorCode) ? 0 : retryDelay(job);
  return new Date(Date.parse(now) + delay).toISOString();
}

function createEnabledRuntime(
  database: SqliteDatabase,
  config: EnabledEmbeddingConfig,
  options: EmbeddingRuntimeOptions,
): EmbeddingRuntime {
  const active = readActiveEmbeddingProfile(database);
  const profile = options.profile ?? active?.profile;
  if (profile === undefined || profile.identity.providerKind !== 'local-transformers') {
    if (config.mode === 'required') unavailable('Local embedding profile is not active');
    return disabledRuntime(config.mode);
  }
  if (active === null || active.profile.profileId !== profile.profileId) {
    if (config.mode === 'required') unavailable('Embedding profile is not active');
    return disabledRuntime(config.mode);
  }
  const provider = options.provider ?? new LocalTransformersEmbeddingProvider({
    profile: profile.identity,
    modelDirectory: getEmbeddingPresetDirectory(profile.identity.presetId, profile.identity.modelRevision),
  });
  if (!profileMatches(provider, profile)) throw new KiokukoError('CONFLICT', 'Embedding provider profile does not match the active profile');
  const backend = options.backend ?? (() => {
    if (config.vectorBackend === 'sqlite-vec') {
      if (config.mode === 'optional') return null;
      unavailable('sqlite-vec backend is not available');
    }
    return new JavaScriptVectorSearchBackend();
  })();
  if (backend === null) return disabledRuntime(config.mode);
  const state: EnabledRuntimeState = {
    config,
    profile,
    generation: active.generation,
    provider,
    backend,
    now: options.now ?? (() => new Date().toISOString()),
  };
  const inFlight = new Set<AbortController>();
  const activeOperations = new Set<Promise<unknown>>();
  const queryFlights = new QueryEmbeddingSingleFlight<StoredQueryEmbedding | null>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const enqueueWrite = options.enqueueWrite ?? ((operation) => Promise.resolve(operation()));

  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation);
    void operation.then(
      () => { activeOperations.delete(operation); },
      () => { activeOperations.delete(operation); },
    );
    return operation;
  };

  const ensureActive = (): void => {
    const current = readActiveEmbeddingProfile(database);
    if (current === null || current.profile.profileId !== state.profile.profileId || current.generation !== state.generation) {
      unavailable('Embedding profile changed while the runtime was active');
    }
  };

  const failOrFallback = (error: unknown): null => {
    if (error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR') throw error;
    if (state.config.mode === 'optional') return null;
    unavailable();
  };

  const prepareQuery = (databaseForQuery: SqliteDatabase, text: string): Promise<PreparedSemanticQuery | null> => trackOperation((async () => {
    if (closed) unavailable('Embedding runtime is closed');
    ensureActive();
    const providerInput = renderEmbeddingQueryInputForProfile(text, state.profile.identity);
    const queryHash = queryEmbeddingHashForProfile(text, state.profile.identity);
    const now = state.now();
    const cached = readQueryEmbedding(databaseForQuery, {
      profileId: state.profile.profileId,
      queryHash,
      now,
      expectedGeneration: state.generation,
    });
    if (cached !== undefined) {
      ensureActive();
      return preparedQuery(state.profile, state.backend, cached);
    }

    const flight = await queryFlights.getOrLoad(
      queryEmbeddingCacheKey({ profileId: state.profile.profileId, generation: state.generation, queryHash }),
      async () => {
        const controller = new AbortController();
        inFlight.add(controller);
        let vectors: readonly Float32Array[];
        try {
          vectors = await state.provider.embed([providerInput], { signal: controller.signal });
        } catch (error) {
          return failOrFallback(error);
        } finally {
          inFlight.delete(controller);
        }
        if (vectors.length !== 1) return failOrFallback(new EmbeddingProviderError('invalid_response', false));
        let vector: Float32Array;
        try {
          vector = normalizeVector(vectors[0]!, state.profile.identity.dimensions);
        } catch {
          return failOrFallback(new EmbeddingProviderError('dimension_mismatch', false));
        }
        ensureActive();
        return enqueueWrite(() => writeQueryEmbedding(
          databaseForQuery,
          { profileId: state.profile.profileId, queryHash, vector },
          { now: state.now(), expectedGeneration: state.generation },
        ));
      },
    );
    if (flight.result === null) return null;
    ensureActive();
    return preparedQuery(state.profile, state.backend, flight.result);
  })());

  const settleFailure = (job: ClaimedEmbeddingJob, errorCode: EmbeddingJobErrorCode): Promise<boolean> => {
    const now = state.now();
    return enqueueWrite(() => failEmbeddingJob(database, {
      entryId: job.entryId,
      profileId: job.profileId,
      generation: job.generation,
      leaseId: job.leaseId,
      errorCode,
      availableAt: failureAvailableAt(job, errorCode, now),
      now,
      permanent: permanentFailure(errorCode),
    }));
  };

  const processPending = async (pending: PendingEmbeddingJob[], deadline: number, controller: AbortController): Promise<{ completed: number; failed: number; blocked: number }> => {
    let completed = 0;
    let failed = 0;
    let blocked = 0;
    for (let offset = 0; offset < pending.length; offset += state.config.batchSize) {
      if (Date.now() >= deadline || closed) break;
      const batch = pending.slice(offset, offset + state.config.batchSize);
      let vectors: readonly Float32Array[];
      try {
        vectors = await state.provider.embed(batch.map((item) => item.text), { signal: controller.signal });
      } catch (error) {
        const code = providerFailureCode(error);
        for (const item of batch) {
          if (!(await settleFailure(item.job, code))) continue;
          if (code === 'secret_blocked') blocked += 1;
          else failed += 1;
        }
        continue;
      }
      if (vectors.length !== batch.length) {
        for (const item of batch) if (await settleFailure(item.job, 'invalid_response')) failed += 1;
        continue;
      }
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index]!;
        let vector: Float32Array;
        try {
          vector = normalizeVector(vectors[index]!, state.profile.identity.dimensions);
        } catch {
          if (await settleFailure(item.job, 'dimension_mismatch')) failed += 1;
          continue;
        }
        try {
          await enqueueWrite(() => finalizeEmbeddingJob(database, {
            entryId: item.job.entryId,
            profileId: item.job.profileId,
            generation: item.job.generation,
            leaseId: item.job.leaseId,
            revision: item.job.revision,
            contentHash: item.job.contentHash,
            documentHash: item.documentHash,
            vector,
            now: state.now(),
          }));
          completed += 1;
        } catch (error) {
          if (error instanceof KiokukoError && error.code === 'CONFLICT') continue;
          throw error;
        }
      }
    }
    return { completed, failed, blocked };
  };

  const drain = (options: { workspace?: string; maxJobs: number; deadlineMs: number }): Promise<EmbeddingDrainResult> => trackOperation((async () => {
    validateDrainOptions(options);
    if (closed) unavailable('Embedding runtime is closed');
    ensureActive();
    const now = state.now();
    const claimed = claimEmbeddingJobs(database, {
      maxJobs: options.maxJobs,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      now,
    });
    const deadline = Date.now() + options.deadlineMs;
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), options.deadlineMs);
    inFlight.add(controller);
    const pending: PendingEmbeddingJob[] = [];
    let completed = 0;
    let failed = 0;
    let blocked = 0;
    try {
      for (const job of claimed) {
        if (Date.now() >= deadline || closed) break;
        try {
          const entry = readEntry(database, { workspace: job.workspace, entryId: job.entryId });
          if (entry.revision !== job.revision || entry.contentHash !== job.contentHash) {
            if (await settleFailure(job, 'entry_changed')) failed += 1;
            continue;
          }
          const document = buildEmbeddingDocumentForProfile({
            kind: entry.kind,
            title: entry.title,
            summary: entry.summary,
            body: entry.body,
            tags: entry.tags,
            scope: entry.scope,
          }, state.profile.identity);
          const providerInput = renderEmbeddingDocumentInputForProfile(document, state.profile.identity);
          const previous = readEntryEmbedding(database, { entryId: entry.id, profileId: state.profile.profileId });
          if (previous !== undefined && previous.documentHash === document.documentHash && previous.dimensions === state.profile.identity.dimensions) {
            try {
              await enqueueWrite(() => finalizeEmbeddingJob(database, {
                entryId: job.entryId,
                profileId: job.profileId,
                generation: job.generation,
                leaseId: job.leaseId,
                revision: job.revision,
                contentHash: job.contentHash,
                documentHash: document.documentHash,
                vector: previous.vector,
                now: state.now(),
              }));
              completed += 1;
            } catch (error) {
              if (!(error instanceof KiokukoError && error.code === 'CONFLICT')) throw error;
            }
            continue;
          }
          pending.push({ job, documentHash: document.documentHash, text: providerInput });
        } catch (error) {
          const code = error instanceof KiokukoError && error.code === 'SECURITY_REJECTION'
            ? 'secret_blocked'
            : error instanceof KiokukoError && (error.code === 'NOT_FOUND' || error.code === 'CONFLICT')
              ? 'entry_changed'
              : null;
          if (code === null) throw error;
          if (!(await settleFailure(job, code))) continue;
          if (code === 'secret_blocked') blocked += 1;
          else failed += 1;
        }
      }
      const processed = await processPending(pending, deadline, controller);
      completed += processed.completed;
      failed += processed.failed;
      blocked += processed.blocked;
    } finally {
      clearTimeout(deadlineTimer);
      inFlight.delete(controller);
    }
    const remaining = listEmbeddingJobs(database, {
      profileId: state.profile.profileId,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    }).length;
    return { claimed: claimed.length, completed, failed, blocked, remaining };
  })());

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    for (const controller of inFlight) controller.abort();
    const operations = [...activeOperations];
    closePromise = (async () => {
      await Promise.allSettled(operations);
      const closeProvider = (state.provider as EmbeddingProvider & { close?: () => Promise<void> | void }).close;
      if (closeProvider !== undefined) await closeProvider.call(state.provider);
      const closeBackend = (state.backend as VectorSearchBackend & { close?: () => Promise<void> | void }).close;
      if (closeBackend !== undefined) await closeBackend.call(state.backend);
      inFlight.clear();
    })();
    return closePromise;
  };

  return Object.freeze({
    mode: config.mode,
    profileId: profile.profileId,
    backendId: backend.id,
    backend,
    prepareQuery,
    drain,
    close,
  });
}

export function createEmbeddingRuntime(
  database: SqliteDatabase,
  config?: EmbeddingConfig,
  options: EmbeddingRuntimeOptions = {},
): EmbeddingRuntime {
  const persisted = config ?? (() => {
    try { return readPersistedEmbeddingSettings(database); } catch { return defaultEmbeddingConfig(); }
  })();
  if (persisted.mode === 'off') return disabledRuntime('off');
  return createEnabledRuntime(database, requireEnabledEmbeddingConfig(persisted), options);
}

/** Convert an owned runtime into the retrieval-only shape consumed by search lanes. */
export async function prepareEmbeddingSearchRuntime(
  runtime: EmbeddingRuntime | undefined,
  database: SqliteDatabase,
  text: string,
): Promise<HybridSearchRuntime> {
  if (runtime === undefined || runtime.backend === null) return {};
  const query = await runtime.prepareQuery(database, text);
  if (query === null) return {};
  return { semantic: { query, backend: runtime.backend } };
}
