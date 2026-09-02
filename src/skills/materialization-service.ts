import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { authorizeSkillMaterialization } from './materialization-authority.js';
import { reviewedCatalogSkill } from './official-catalog.js';
import { SkillProviderError } from './providers/schema.js';
import { SkillSourceError } from './source/errors.js';
import { validateSkillCandidate } from './source/snapshot-validator.js';
import {
  clearPersistentSkillAuditFailure,
  clearPersistentSkillSourceFailure,
  readPersistentSkillAuditFailure,
  readPersistentSkillSourceFailure,
  writePersistentSkillAuditFailure,
  writePersistentSkillSourceFailure,
} from './store.js';
import type {
  SkillCandidate,
  SkillMaterializationAuthorization,
  SkillRegistryProvider,
  SkillSnapshot,
  SkillSourceFetcher,
  SkillSourceFetchRequest,
} from './types.js';

export const DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS = 10 * 60_000;
export const MAX_EXTERNAL_SKILL_RETRY_AFTER_MS = 24 * 60 * 60_000;

export function externalSkillFailureTtlMs(retryAfterSeconds: number | null): number {
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS;
  }
  return Math.min(MAX_EXTERNAL_SKILL_RETRY_AFTER_MS, Math.max(1, Math.floor(retryAfterSeconds * 1000)));
}

export interface MaterializableSkillSnapshot {
  snapshot: SkillSnapshot;
  authorization?: SkillMaterializationAuthorization;
}

function publicAuditFailure(error: SkillProviderError): KiokukoError {
  const failureCode: unknown = error.code;
  const code = (() => {
    switch (failureCode) {
      case 'registry_authentication_failed': return 'AUTHENTICATION_ERROR';
      case 'registry_invalid_response': return 'INTEGRITY_ERROR';
      case 'registry_unavailable':
      case 'registry_rate_limited': return 'SERVICE_UNAVAILABLE';
      default: throw error;
    }
  })();
  return new KiokukoError(code, 'External skill provider audit failed closed', {
    failureCode,
    ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  });
}

/**
 * Apply exact provider-audit and GitHub-source backoff before retrieving a
 * snapshot. Cache rows are operational denial state; they never authorize a
 * materialization and a stored passed audit label is deliberately ignored.
 */
export async function fetchMaterializableSkillSnapshot(
  database: SqliteDatabase,
  candidate: SkillCandidate,
  dependencies: {
    provider: SkillRegistryProvider;
    sourceFetcher: SkillSourceFetcher;
    sourceRequest: SkillSourceFetchRequest;
    now?: string;
    cacheWrite?: <T>(operation: () => T) => Promise<T>;
  },
): Promise<MaterializableSkillSnapshot> {
  const now = dependencies.now ?? new Date().toISOString();
  const cacheWrite = dependencies.cacheWrite ?? (async <T>(operation: () => T): Promise<T> => operation());
  const materializationCandidate = validateSkillCandidate(candidate);
  const providerId = dependencies.provider.id;
  const reviewedCatalog = reviewedCatalogSkill(materializationCandidate) !== undefined;
  if (!reviewedCatalog && providerId !== materializationCandidate.provider) {
    throw new KiokukoError('SECURITY_REJECTION', 'External skill audit provider does not match the candidate provider');
  }
  const cachedSourceFailure = readPersistentSkillSourceFailure(database, materializationCandidate, now);
  if (cachedSourceFailure !== null) throw new SkillSourceError(cachedSourceFailure.code);
  let authorization: Awaited<ReturnType<typeof authorizeSkillMaterialization>>;
  if (!reviewedCatalog) {
    const cachedAuditFailure = readPersistentSkillAuditFailure(database, providerId, materializationCandidate, now);
    if (cachedAuditFailure !== null) {
      throw new KiokukoError('SERVICE_UNAVAILABLE', 'External skill provider audit is in backoff', {
        failureCode: cachedAuditFailure.code,
        expiresAt: cachedAuditFailure.expiresAt,
      });
    }
  }
  try {
    authorization = await authorizeSkillMaterialization(dependencies.provider, materializationCandidate);
  } catch (error) {
    if (!(error instanceof SkillProviderError)) throw error;
    if (error.code === 'registry_rate_limited' || error.code === 'registry_unavailable') {
      const failureCode = error.code;
      await cacheWrite(() => writePersistentSkillAuditFailure(
        database,
        providerId,
        materializationCandidate,
        failureCode,
        externalSkillFailureTtlMs(error.retryAfterSeconds),
        now,
      ));
    }
    throw publicAuditFailure(error);
  }
  if (authorization.status === 'unavailable') {
    await cacheWrite(() => writePersistentSkillAuditFailure(
      database,
      providerId,
      materializationCandidate,
      'registry_unavailable',
      DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS,
      now,
    ));
    throw new KiokukoError('SERVICE_UNAVAILABLE', 'External skill provider audit is unavailable', {
      failureCode: 'registry_unavailable',
    });
  }
  if (!reviewedCatalog) await cacheWrite(() => clearPersistentSkillAuditFailure(database, providerId, materializationCandidate));
  if (authorization.status === 'failed') {
    throw new KiokukoError('SECURITY_REJECTION', 'External skill provider audit rejected the candidate', {
      failureCode: 'community_audit_failed',
    });
  }
  let snapshot: SkillSnapshot;
  try {
    snapshot = await dependencies.sourceFetcher.fetch(authorization.candidate, dependencies.sourceRequest);
  } catch (error) {
    if (error instanceof SkillSourceError && (error.code === 'source_rate_limited' || error.code === 'source_unavailable')) {
      const failureCode = error.code;
      await cacheWrite(() => writePersistentSkillSourceFailure(
        database,
        materializationCandidate,
        failureCode,
        externalSkillFailureTtlMs(error.retryAfterSeconds),
        now,
      ));
    }
    throw error;
  }
  await cacheWrite(() => clearPersistentSkillSourceFailure(database, materializationCandidate));
  return {
    snapshot,
    ...(authorization.status === 'passed' ? { authorization: authorization.authorization } : {}),
  };
}
