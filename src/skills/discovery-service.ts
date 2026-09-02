import type { ProjectFingerprint } from '../repository/project-fingerprint.js';
import { satisfiesFrameworkVersion } from '../repository/framework-version.js';
import type { TaskProfile } from '../akinator/types.js';
import { detectSkillGap } from './gap-detection.js';
import { buildSkillQueries } from './query-builder.js';
import { rankSkillCandidates } from './candidate-ranking.js';
import { documentsFromSkillSnapshot } from './import-preparation.js';
import { readSkillDiscoveryConfig } from './config.js';
import { SkillProviderError } from './providers/schema.js';
import { SkillDiscoveryCache } from './cache.js';
import { GitHubSkillSourceFetcher, SkillSourceError } from './source/github-fetcher.js';
import { validateSkillSnapshot } from './source/snapshot-validator.js';
import { clearPersistentSkillAuditFailure, clearPersistentSkillSourceFailure, externalSkillRefreshExpectation, externalSkillRequirement, externalSkillSourceFetchRequest, externalSkillWorkspace, markExternalSkillRefreshFailureInTransaction, persistExistingSkillImportInTransaction, persistNewSkillImportInTransaction, readExternalSkill, readPersistentSkillAuditFailure, readPersistentSkillSourceFailure, refreshExternalSkillSnapshotInTransaction, listExternalSkills, readPersistentSkillSearchCache, recordDiscoveredSkillInTransaction, writePersistentSkillAuditFailure, writePersistentSkillSearchCache, writePersistentSkillSourceFailure, type ExternalSkillRecord, type ExternalSkillRefreshExpectation, type SkillImportResult, type SkillSearchCacheOutcome } from './store.js';
import type { DiscoverSkillsInput, PreparedSkillImport, SkillCandidate, SkillDiscoveryMode, SkillDiscoverySummary, SkillMaterializationAuthorization, SkillRequirement, SkillRegistryProvider, SkillSearchResult, SkillSnapshot, SkillSourceFetcher, SkillSourceFetchRequest } from './types.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { createSkillRegistryProvider, findSkills } from './find.js';
import { KiokukoError } from '../errors.js';
import { reviewedCatalogSkill, technologyDefinition } from './official-catalog.js';
import { isSqliteOperationalError } from '../db/sqlite-retry.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { authorizeSkillMaterialization, hasSkillMaterializationAuthorization } from './materialization-authority.js';
import { DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS, externalSkillFailureTtlMs } from './materialization-service.js';
import type { SkillSourceFailureCode } from './source/errors.js';
import { compareCanonicalStrings } from '../serialization/validate.js';

export interface SkillDiscoveryDependencies {
  provider?: SkillRegistryProvider;
  sourceFetcher?: SkillSourceFetcher;
  cache?: SkillDiscoveryCache;
  fetchImpl?: typeof fetch;
  now?: () => string;
  /** Revalidate caller-owned state inside the import write transaction. */
  assertBeforePersist?: () => void;
}

function candidateId(candidate: SkillCandidate): string { return `${candidate.sourceType}:${candidate.source}:${candidate.slug}`; }
function compatibilityProvider(provider: string): boolean { return provider.startsWith('skills-sh-compat-'); }
function containsAlias(value: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(value);
}
type RecoverableProviderFailureCode = SkillProviderError['code'];

function providerFailureCode(error: unknown): RecoverableProviderFailureCode | undefined {
  if (!(error instanceof SkillProviderError)) return undefined;
  const code: unknown = error.code;
  switch (code) {
    case 'registry_authentication_failed':
    case 'registry_unavailable':
    case 'registry_rate_limited':
    case 'registry_invalid_response':
      return code;
    default:
      throw error;
  }
}

function sourceOrValidationFailureCode(error: unknown): Exclude<SkillSourceFailureCode, 'source_missing'> | undefined {
  if (!(error instanceof SkillSourceError)) return undefined;
  const code: unknown = error.code;
  switch (code) {
    case 'source_missing':
      return 'candidate_not_found_at_source';
    case 'source_rate_limited':
    case 'source_unavailable':
    case 'candidate_not_found_at_source':
    case 'source_tree_truncated':
    case 'skill_disabled_for_model_invocation':
    case 'skill_secret_detected':
    case 'skill_too_large':
    case 'skill_validation_failed':
    case 'skill_blocked':
      return code;
    default:
      throw error;
  }
}

function persistenceFailureCode(error: unknown): string | undefined {
  if (error instanceof KiokukoError) {
    if (error.code === 'CONFLICT') return 'persistence_conflict';
    if (error.code === 'BACKPRESSURE') return 'persistence_failed';
    return undefined;
  }
  return isSqliteOperationalError(error) ? 'persistence_failed' : undefined;
}

class CallerPersistenceAssertionError extends Error {
  constructor(readonly assertionError: unknown) {
    super('Caller persistence assertion failed');
    this.name = 'CallerPersistenceAssertionError';
  }
}

function cachedProviderFailure(value: { cacheOutcome: string; failureCode?: string }): 'registry_authentication_failed' | 'registry_unavailable' | 'registry_rate_limited' | undefined {
  if (value.failureCode === 'registry_authentication_failed') return value.failureCode;
  if (value.cacheOutcome === 'unavailable') return 'registry_unavailable';
  if (value.cacheOutcome === 'rate_limited') return 'registry_rate_limited';
  return undefined;
}

function requirementMatchScore(candidate: SkillCandidate, requirement: SkillRequirement, requirements: SkillRequirement[]): number {
  const values = [candidate.name, candidate.slug.split('/').at(-1) ?? candidate.slug].map((value) => value.toLowerCase());
  const identities = [...new Set([requirement.id, requirement.technology].map((value) => value.toLowerCase()))];
  if (values.some((value) => identities.includes(value))) return 100;
  if (values.some((value) => identities.some((identity) => containsAlias(value, identity)))) return 80;
  const uniqueAliases = requirement.aliases.map((alias) => alias.toLowerCase()).filter((alias) => !requirements.some((other) => other !== requirement
    && [other.id, other.technology, ...other.aliases].some((value) => value.toLowerCase() === alias)));
  if (values.some((value) => uniqueAliases.some((alias) => containsAlias(value, alias)))) return 60;
  return 0;
}

function requirementFor(candidate: SkillCandidate, requirements: SkillRequirement[]): SkillRequirement | undefined {
  return requirements.map((requirement) => ({ requirement, score: requirementMatchScore(candidate, requirement, requirements) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || compareCanonicalStrings(left.requirement.id, right.requirement.id))[0]?.requirement;
}
function normalizeOfficial(candidate: SkillCandidate, requirement: SkillRequirement): SkillCandidate {
  const official = reviewedCatalogSkill(candidate) !== undefined
    ? 'catalog-verified'
    : requirement.owners.some((owner) => candidate.source.toLowerCase().startsWith(`${owner.toLowerCase()}/`))
      ? 'owner-verified'
      : candidate.officialStatus;
  return { ...candidate, officialStatus: official };
}

function requirementsForQuery(query: string, requirements: SkillRequirement[]): SkillRequirement[] {
  const normalized = query.normalize('NFKC').toLowerCase();
  return requirements.filter((requirement) => {
    const technology = requirement.technology.normalize('NFKC').toLowerCase();
    return requirement.queries.some((value) => value.normalize('NFKC').toLowerCase() === normalized)
      || normalized === `${technology} testing`
      || normalized === `${technology} debug`
      || normalized === `${technology} review`;
  });
}
function locallySafeCommunityCandidate(candidate: SkillCandidate): boolean {
  return candidate.sourceType === 'github'
    && !candidate.duplicate
    && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(candidate.source)
    && /^[A-Za-z0-9_.\-/]{1,240}$/u.test(candidate.slug)
    && !candidate.slug.split('/').some((part) => part === '' || part === '.' || part === '..');
}

const CURATED_CACHE_QUERY = '__curated__';
const DEFAULT_AUTOMATIC_MATERIALIZATION_LIMIT = 1;
const MAX_AUTOMATIC_MATERIALIZATION_LIMIT = 2;
const MAX_SOURCE_ATTEMPTS = 6;
const MAX_COMMUNITY_AUDITS = 6;
const IMPORT_FRESHNESS_MS = 7 * 24 * 60 * 60_000;
function automaticMaterializationLimit(value: DiscoverSkillsInput['maxSelectedSkills']): 1 | 2 {
  const resolved = value ?? DEFAULT_AUTOMATIC_MATERIALIZATION_LIMIT;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_AUTOMATIC_MATERIALIZATION_LIMIT) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill materialization limit must be 1 or 2');
  }
  return resolved as 1 | 2;
}

function providerNegativeCache(error: SkillProviderError): { outcome: Extract<SkillSearchCacheOutcome, 'rate_limited' | 'unavailable'>; ttlMs: number; failureCode?: 'registry_authentication_failed' } | undefined {
  const code: unknown = error.code;
  switch (code) {
    case 'registry_rate_limited':
      return { outcome: 'rate_limited', ttlMs: externalSkillFailureTtlMs(error.retryAfterSeconds) };
    case 'registry_authentication_failed':
      return { outcome: 'unavailable', ttlMs: DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS, failureCode: code };
    case 'registry_unavailable':
      return { outcome: 'unavailable', ttlMs: DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS };
    case 'registry_invalid_response':
      return undefined;
    default:
      throw error;
  }
}

function frameworkVersionMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  const compatibility = satisfiesFrameworkVersion(actual, expected);
  return compatibility === 'exact' || compatibility === 'compatible';
}

function applicabilityMatchesFingerprint(requirement: SkillRequirement, fingerprint: ProjectFingerprint): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
  const dimensionMatches = (expected: string[] | undefined, actual: string[]): boolean =>
    expected === undefined || expected.length === 0 || expected.some((value) => actual.some((candidate) => normalize(candidate) === normalize(value)));
  if (!dimensionMatches(requirement.applicability.languages, fingerprint.languages)
    || !dimensionMatches(requirement.applicability.databases, fingerprint.databases)
    || !dimensionMatches(requirement.applicability.runtimes, fingerprint.runtimes)
    || !dimensionMatches(requirement.applicability.tools, fingerprint.tools)) return false;
  const frameworks = requirement.applicability.frameworks;
  return frameworks === undefined || frameworks.length === 0 || frameworks.some((expected) => fingerprint.frameworks.some((actual) =>
    normalize(actual.name) === normalize(expected.name) && frameworkVersionMatches(actual.version, expected.version)));
}

function officialStatus(value: string): SkillCandidate['officialStatus'] {
  return value === 'curated' || value === 'catalog-verified' || value === 'owner-verified' || value === 'registry-only' ? value : 'unknown';
}

function reusableImportedSkill(record: ExternalSkillRecord, mode: Exclude<SkillDiscoveryMode, 'off'>): boolean {
  if (reviewedCatalogSkill({ source: record.sourceLocator, slug: record.slug }) !== undefined) return true;
  // The materialized record itself crossed the runtime authority boundary.
  // Its persisted audit label is descriptive and must not become a reusable
  // authorization input for later discovery runs.
  return mode === 'community';
}

function isReviewedCatalogCandidate(candidate: SkillCandidate, requirement: SkillRequirement): boolean {
  const definition = technologyDefinition(requirement.id);
  return definition !== undefined
    && requirement.repositories.some((source) => source.normalize('NFKC').toLowerCase() === candidate.source.normalize('NFKC').toLowerCase())
    && (definition.reviewedSkills ?? []).some((skill) => skill.slug === candidate.slug);
}

function isReviewedCatalogIdentity(record: ExternalSkillRecord, requirement: SkillRequirement): boolean {
  return isReviewedCatalogCandidate(candidateFromRecord(record), requirement);
}

function freshImportedSkill(database: SqliteDatabase, requirement: SkillRequirement, rows: ExternalSkillRecord[], now: string, mode: Exclude<SkillDiscoveryMode, 'off'>, fingerprint: ProjectFingerprint): ExternalSkillRecord | undefined {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return undefined;
  return rows.find((record) => {
    if (record.state !== 'imported' || record.sourceCommit === null || record.snapshotHash === null) return false;
    if (!reusableImportedSkill(record, mode)) return false;
    const checkedAt = Date.parse(record.lastCheckedAt);
    const age = nowMs - checkedAt;
    if (!Number.isFinite(checkedAt) || age < 0 || age >= IMPORT_FRESHNESS_MS) return false;
    const importedRequirement = externalSkillRequirement(database, record.skillId);
    if (importedRequirement === undefined) return false;
    return applicabilityMatchesFingerprint(importedRequirement, fingerprint)
      && (requirementOverlaps(importedRequirement, requirement) || isReviewedCatalogIdentity(record, requirement));
  });
}

function sourceSkillIdentity(value: { sourceType: string; source: string; slug: string }): string {
  return `${value.sourceType.normalize('NFKC').toLowerCase()}\u0000${value.source.normalize('NFKC').toLowerCase()}\u0000${value.slug}`;
}

function suppressAutomaticImport(record: ExternalSkillRecord | undefined): boolean {
  return record !== undefined
    && (record.disabledAt !== null || record.state === 'disabled' || record.state === 'blocked');
}

function sameSkillSource(record: ExternalSkillRecord, candidate: SkillCandidate): boolean {
  return record.sourceType.normalize('NFKC').toLowerCase() === candidate.sourceType.normalize('NFKC').toLowerCase()
    && record.sourceLocator.normalize('NFKC').toLowerCase() === candidate.source.normalize('NFKC').toLowerCase();
}

function requirementOverlaps(left: SkillRequirement, right: SkillRequirement): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
  const leftCanonical = new Set([left.id, left.technology].map(normalize));
  const rightCanonical = new Set([right.id, right.technology].map(normalize));
  if ([...leftCanonical].some((value) => rightCanonical.has(value))) return true;
  const leftNames = new Set([left.id, left.technology, ...left.aliases].map(normalize));
  const rightNames = new Set([right.id, right.technology, ...right.aliases].map(normalize));
  return [...rightCanonical].some((value) => leftNames.has(value))
    && [...leftCanonical].some((value) => rightNames.has(value));
}

function existingIdentityOwners(database: SqliteDatabase, rows: ExternalSkillRecord[], candidate: SkillCandidate, canonical: SkillCandidate, requirement: SkillRequirement, fingerprint: ProjectFingerprint): ExternalSkillRecord[] {
  const requestedIdentity = sourceSkillIdentity(candidate);
  const canonicalIdentity = sourceSkillIdentity(canonical);
  return rows.filter((record) => {
    if (!sameSkillSource(record, canonical)) return false;
    const identity = sourceSkillIdentity({ sourceType: record.sourceType, source: record.sourceLocator, slug: record.slug });
    if (identity === requestedIdentity || identity === canonicalIdentity) return true;
    if (record.sourceCommit === null && record.snapshotHash === null && record.state === 'stale' && record.disabledAt === null) return true;
    const stored = externalSkillRequirement(database, record.skillId);
    return stored !== undefined && requirementOverlaps(stored, requirement)
      && (record.disabledAt !== null || record.state === 'disabled' || record.state === 'stale' || record.state === 'blocked'
        || applicabilityMatchesFingerprint(stored, fingerprint));
  });
}

function candidateFromRecord(record: ExternalSkillRecord): SkillCandidate {
  if (record.sourceType !== 'github') throw new KiokukoError('INTEGRITY_ERROR', 'External Skill source type is invalid');
  return {
    id: record.skillId,
    provider: record.provider,
    name: record.name,
    slug: record.slug,
    source: record.sourceLocator,
    sourceType: record.sourceType,
    installUrl: record.installUrl,
    installs: record.installs,
    duplicate: record.duplicate,
    officialStatus: officialStatus(record.officialStatus),
    auditStatus: record.auditStatus,
  };
}

export class SkillDiscoveryService {
  private readonly cache: SkillDiscoveryCache;
  private readonly provider: SkillRegistryProvider;
  private readonly sourceFetcher: SkillSourceFetcher;
  private readonly sourceFlights = new Map<string, Promise<Awaited<ReturnType<SkillSourceFetcher['fetch']>>>>();
  private readonly now: () => string;
  private readonly assertBeforePersist: (() => void) | undefined;
  constructor(dependencies: SkillDiscoveryDependencies = {}) {
    const config = readSkillDiscoveryConfig();
    this.provider = dependencies.provider ?? createSkillRegistryProvider(dependencies.fetchImpl);
    this.sourceFetcher = dependencies.sourceFetcher ?? new GitHubSkillSourceFetcher({ token: config.githubToken, ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) });
    this.cache = dependencies.cache ?? new SkillDiscoveryCache();
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.assertBeforePersist = dependencies.assertBeforePersist;
  }

  private async fetchSnapshot(candidate: SkillCandidate, request: SkillSourceFetchRequest, signal?: AbortSignal) {
    const key = JSON.stringify([candidateId(candidate), request.purpose, request.purpose === 'refresh' ? request.expectedPrimaryPath : null]);
    const active = signal === undefined ? this.sourceFlights.get(key) : undefined;
    if (active) return active;
    const flight = this.sourceFetcher.fetch(candidate, request, signal);
    if (signal !== undefined) return flight;
    this.sourceFlights.set(key, flight);
    try { return await flight; }
    finally { if (this.sourceFlights.get(key) === flight) this.sourceFlights.delete(key); }
  }

  private async searchWithCache(database: SqliteDatabase, input: {
    provider: SkillRegistryProvider;
    query: string;
    owner: string | null;
    mode: 'official' | 'community';
    now: string;
    allowAuthenticationFallback: boolean;
    signal?: AbortSignal;
  }): Promise<{ result: SkillSearchResult; cacheHits: number; authenticationFallbackUsed: boolean; failureCode?: 'registry_authentication_failed' | 'registry_unavailable' | 'registry_rate_limited' }> {
    const persistent = readPersistentSkillSearchCache(database, { ...input, provider: input.provider.id });
    if (persistent !== null) {
      if (persistent.failureCode === 'registry_authentication_failed') {
        if (!input.allowAuthenticationFallback || input.provider.authenticationFallback === undefined) return { result: persistent, cacheHits: 1, authenticationFallbackUsed: false, failureCode: persistent.failureCode };
        const fallback = await this.searchWithCache(database, { ...input, provider: input.provider.authenticationFallback, allowAuthenticationFallback: false });
        return { ...fallback, cacheHits: fallback.cacheHits + 1, authenticationFallbackUsed: true };
      }
      const failureCode = cachedProviderFailure(persistent);
      if (failureCode !== undefined) return { result: persistent, cacheHits: 1, authenticationFallbackUsed: false, failureCode };
      return { result: persistent, cacheHits: 1, authenticationFallbackUsed: false };
    }
    try {
      const loaded = await this.cache.getOrLoad({
        provider: input.provider.id,
        query: input.query,
        mode: input.mode,
        owner: input.owner,
          loader: () => findSkills({ query: input.query, limit: 20, ...(input.owner === null ? {} : { owner: input.owner }), ...(input.signal === undefined ? {} : { signal: input.signal }) }, {
          provider: input.provider,
          fallbackOnAuthentication: false,
        }),
      });
      writePersistentSkillSearchCache(database, {
        provider: input.provider.id,
        query: input.query,
        owner: input.owner,
        mode: input.mode,
        result: loaded.result,
        outcome: loaded.result.candidates.length === 0 ? 'empty' : 'success',
        ttlMs: loaded.result.candidates.length === 0 ? 6 * 60 * 60_000 : 24 * 60 * 60_000,
        now: input.now,
      });
      return { result: loaded.result, cacheHits: loaded.hit ? 1 : 0, authenticationFallbackUsed: false };
    } catch (error) {
      if (error instanceof SkillProviderError) {
        const negativeCache = providerNegativeCache(error);
        if (negativeCache !== undefined) {
        writePersistentSkillSearchCache(database, {
          provider: input.provider.id,
          query: input.query,
          owner: input.owner,
          mode: input.mode,
          result: { provider: input.provider.id, experimental: compatibilityProvider(input.provider.id), candidates: [] },
          outcome: negativeCache.outcome,
          ...(negativeCache.failureCode === undefined ? {} : { failureCode: negativeCache.failureCode }),
          ttlMs: negativeCache.ttlMs,
          now: input.now,
        });
        if (error.code === 'registry_authentication_failed' && input.allowAuthenticationFallback && input.provider.authenticationFallback !== undefined) {
          const fallback = await this.searchWithCache(database, { ...input, provider: input.provider.authenticationFallback, allowAuthenticationFallback: false });
          return { ...fallback, authenticationFallbackUsed: true };
        }
        }
      }
      throw error;
    }
  }

  async discover(database: SqliteDatabase, input: DiscoverSkillsInput, modeOverride?: DiscoverSkillsInput['mode']): Promise<SkillDiscoverySummary> {
    const selectedSkillLimit = automaticMaterializationLimit(input.maxSelectedSkills);
    const requestedMode = modeOverride ?? input.mode;
    const now = this.now();
    if (requestedMode === 'off') return { attempted: false, mode: requestedMode, requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] };
    const gap = detectSkillGap({ fingerprint: input.fingerprint, task: input.task, profile: input.profile as TaskProfile, recommendedTags: input.recommendedTags, capabilities: input.capabilities, mode: requestedMode });
    const mode = requestedMode === 'community' && gap.catalogAvailability === 'unknown' ? 'official' : requestedMode;
    const base: SkillDiscoverySummary = { attempted: false, mode, requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] };
    base.requirements = gap.missing.map((requirement) => requirement.id);
    if (!gap.shouldDiscover || gap.missing.length === 0) return base;
    const existingSkills = listExternalSkills(database);
    const unresolved: SkillRequirement[] = [];
    const reused = new Set<string>();
    for (const requirement of gap.missing) {
      const existing = freshImportedSkill(database, requirement, existingSkills, now, mode, input.fingerprint);
      if (!existing) { unresolved.push(requirement); continue; }
      if (!reused.has(existing.skillId) && base.selected.length < selectedSkillLimit) {
        reused.add(existing.skillId);
        base.selected.push({ skillId: existing.skillId, name: existing.name, source: existing.sourceLocator, officialStatus: officialStatus(existing.officialStatus), imported: true, updated: false });
      }
    }
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new KiokukoError('INTEGRITY_ERROR', 'Skill discovery clock is invalid');
    const requirementsToSearch = base.selected.length >= selectedSkillLimit ? [] : unresolved;
    if (requirementsToSearch.length === 0) return base;
    base.attempted = true;
    const queries = buildSkillQueries({ requirements: requirementsToSearch, profile: input.profile as TaskProfile, mode })
      .slice(0, input.maxQueries ?? 3);
    base.queries = queries;
    for (const query of queries) {
      if (requirementsForQuery(query, requirementsToSearch).length === 0) throw new KiokukoError('INTEGRITY_ERROR', 'Generated Skill query has no requirement provenance');
    }

    type AssociatedCandidate = { candidate: SkillCandidate; requirement: SkillRequirement };
    const seenCandidates = new Set<string>();
    const officialCandidates = new Map<string, AssociatedCandidate>();
    const communityCandidates = new Map<string, AssociatedCandidate>();
    const associateCandidate = (target: Map<string, AssociatedCandidate>, candidate: SkillCandidate, requirements: SkillRequirement[], forcedRequirement?: SkillRequirement): void => {
      seenCandidates.add(candidateId(candidate));
      const requirement = forcedRequirement ?? requirementFor(candidate, requirements);
      if (requirement === undefined) return;
      const normalized = normalizeOfficial(candidate, requirement);
      const identity = sourceSkillIdentity(normalized);
      const current = target.get(identity);
      const score = requirementMatchScore(normalized, requirement, gap.missing);
      const currentScore = current === undefined ? -1 : requirementMatchScore(current.candidate, current.requirement, gap.missing);
      if (current === undefined || score > currentScore || (score === currentScore && compareCanonicalStrings(requirement.id, current.requirement.id) < 0)) {
        target.set(identity, { candidate: normalized, requirement });
      }
    };
    let primaryAuthenticationFailed = false;
    let providerRequestsLatched = false;
    const search = async (query: string, owner: string | null, requirements: SkillRequirement[], target: Map<string, AssociatedCandidate>): Promise<void> => {
      if (providerRequestsLatched) return;
      try {
        const loaded = await this.searchWithCache(database, { provider: this.provider, query, owner, mode, now, allowAuthenticationFallback: true, ...(input.signal === undefined ? {} : { signal: input.signal }) });
        base.cacheHits += loaded.cacheHits;
        primaryAuthenticationFailed ||= loaded.authenticationFallbackUsed;
        if (loaded.failureCode !== undefined) {
          base.failures.push({ stage: 'search', code: loaded.failureCode });
          providerRequestsLatched = true;
          return;
        }
        for (const candidate of loaded.result.candidates) associateCandidate(target, candidate, requirements);
      } catch (error) {
        const code = providerFailureCode(error);
        if (code === undefined) throw error;
        base.failures.push({ stage: 'search', code });
        providerRequestsLatched = true;
      }
    };

    // Phase 1: scoped searches against verified owners only.
    for (const query of queries) {
      const queryRequirements = requirementsForQuery(query, requirementsToSearch);
      const owners = [...new Set(queryRequirements.flatMap((requirement) => requirement.owners))];
      for (const owner of owners) {
        await search(query, owner, queryRequirements.filter((requirement) => requirement.owners.includes(owner)), officialCandidates);
      }
    }

    if (this.provider.curated && !primaryAuthenticationFailed && !providerRequestsLatched) {
      const cachedCurated = readPersistentSkillSearchCache(database, { provider: this.provider.id, query: CURATED_CACHE_QUERY, owner: null, mode, now });
      if (cachedCurated) {
        base.cacheHits += 1;
        const failureCode = cachedProviderFailure(cachedCurated);
          if (failureCode !== undefined) {
            base.failures.push({ stage: 'search', code: failureCode });
            providerRequestsLatched = true;
          }
        else for (const candidate of cachedCurated.candidates) associateCandidate(officialCandidates, candidate, requirementsToSearch);
      } else {
        try {
          const curated = await this.provider.curated(input.signal);
          const result: SkillSearchResult = { provider: this.provider.id, experimental: compatibilityProvider(this.provider.id), candidates: curated ?? [] };
          writePersistentSkillSearchCache(database, { provider: this.provider.id, query: CURATED_CACHE_QUERY, owner: null, mode, result, outcome: result.candidates.length === 0 ? 'empty' : 'success', ttlMs: 6 * 60 * 60_000, now });
          for (const candidate of result.candidates) associateCandidate(officialCandidates, candidate, requirementsToSearch);
        } catch (error) {
          const code = providerFailureCode(error);
          if (code === undefined) throw error;
          if (error instanceof SkillProviderError) {
            const negativeCache = providerNegativeCache(error);
            if (negativeCache !== undefined) {
              writePersistentSkillSearchCache(database, {
                provider: this.provider.id,
                query: CURATED_CACHE_QUERY,
                owner: null,
                mode,
                result: { provider: this.provider.id, experimental: compatibilityProvider(this.provider.id), candidates: [] },
                outcome: negativeCache.outcome,
                ...(negativeCache.failureCode === undefined ? {} : { failureCode: negativeCache.failureCode }),
                ttlMs: negativeCache.ttlMs,
                now,
              });
            }
          }
          base.failures.push({ stage: 'search', code });
          providerRequestsLatched = true;
        }
      }
    }

    const communityAudit = new Map<string,
      | { allowed: false }
      | { allowed: true; authorization: SkillMaterializationAuthorization }
    >();
    let auditAttempts = 0;
    let auditLimitReported = false;
    let communityAuditLatched = false;
    let communityAuditUnavailableReported = false;
    const communityAllowed = async (candidate: SkillCandidate): Promise<{ candidate: SkillCandidate; authorization?: SkillMaterializationAuthorization } | null> => {
      if (!locallySafeCommunityCandidate(candidate)) return null;
      if (reviewedCatalogSkill(candidate) !== undefined) return { candidate: { ...candidate, officialStatus: 'catalog-verified', auditStatus: 'not-required' } };
      const key = candidateId(candidate);
      const known = communityAudit.get(key);
      if (known !== undefined) return known.allowed
        ? { candidate: { ...candidate, auditStatus: 'passed' }, authorization: known.authorization }
        : null;
      if (providerRequestsLatched || primaryAuthenticationFailed || communityAuditLatched || this.provider.audit === undefined) {
        providerRequestsLatched = true;
        communityAudit.set(key, { allowed: false });
        communityAuditLatched = true;
        if (!communityAuditUnavailableReported) {
          base.failures.push({ stage: 'validation', code: 'community_audit_unavailable' });
          communityAuditUnavailableReported = true;
        }
        return null;
      }
      const cachedAuditFailure = readPersistentSkillAuditFailure(database, this.provider.id, candidate, now);
      if (cachedAuditFailure !== null) {
        providerRequestsLatched = true;
        communityAudit.set(key, { allowed: false });
        communityAuditLatched = true;
        if (!communityAuditUnavailableReported) {
          base.failures.push({ stage: 'validation', code: 'community_audit_unavailable' });
          communityAuditUnavailableReported = true;
        }
        return null;
      }
      if (auditAttempts >= MAX_COMMUNITY_AUDITS) {
        communityAudit.set(key, { allowed: false });
        if (!auditLimitReported) { base.failures.push({ stage: 'validation', code: 'community_audit_limit_reached' }); auditLimitReported = true; }
        return null;
      }
      auditAttempts += 1;
      let audit;
      try {
        audit = await authorizeSkillMaterialization(this.provider, candidate, input.signal);
      } catch (error) {
        const code = providerFailureCode(error);
        if (code === undefined) throw error;
        if (error instanceof SkillProviderError && (error.code === 'registry_rate_limited' || error.code === 'registry_unavailable')) {
          writePersistentSkillAuditFailure(database, this.provider.id, candidate, error.code, externalSkillFailureTtlMs(error.retryAfterSeconds), now);
        }
        providerRequestsLatched = true;
        communityAudit.set(key, { allowed: false });
        communityAuditLatched = true;
        if (code === 'registry_invalid_response') {
          base.failures.push({ stage: 'search', code });
        } else if (!communityAuditUnavailableReported) {
          base.failures.push({ stage: 'validation', code: 'community_audit_unavailable' });
          communityAuditUnavailableReported = true;
        }
        return null;
      }
      if (audit.status === 'unavailable') {
        writePersistentSkillAuditFailure(database, this.provider.id, candidate, 'registry_unavailable', DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS, now);
        providerRequestsLatched = true;
        communityAudit.set(key, { allowed: false });
        communityAuditLatched = true;
        if (!communityAuditUnavailableReported) {
          base.failures.push({ stage: 'validation', code: 'community_audit_unavailable' });
          communityAuditUnavailableReported = true;
        }
        return null;
      }
      clearPersistentSkillAuditFailure(database, this.provider.id, candidate);
      const allowed = audit.status === 'passed' ? { candidate: audit.candidate, authorization: audit.authorization } : null;
      communityAudit.set(key, allowed === null ? { allowed: false } : { allowed: true, authorization: allowed.authorization });
      if (allowed === null) base.failures.push({ stage: 'validation', code: 'community_audit_failed' });
      return allowed;
    };
    const existingByIdentity = new Map(existingSkills.map((record) => [sourceSkillIdentity({ sourceType: record.sourceType, source: record.sourceLocator, slug: record.slug }), record]));
    const successfulSkills = new Set(base.selected.flatMap((candidate) => {
      const record = existingSkills.find((skill) => skill.skillId === candidate.skillId);
      return record === undefined ? [] : [sourceSkillIdentity({ sourceType: record.sourceType, source: record.sourceLocator, slug: record.slug })];
    }));
    const successfulRequirements = new Set<string>();
    const attemptedSkills = new Set<string>();
    let sourceRequestsLatched = false;

    type PreparedSelection = {
      requestedCandidate: SkillCandidate;
      canonicalCandidate: SkillCandidate;
      authorization?: SkillMaterializationAuthorization;
      requirement: SkillRequirement;
      selectedExisting?: ExternalSkillRecord;
      observedCanonical?: ExternalSkillRecord;
      snapshot: SkillSnapshot;
      documents: PreparedSkillImport['documents'];
    };
    type PendingFailureTransition =
      | { kind: 'new-stale'; candidate: SkillCandidate }
      | { kind: 'existing'; record: ExternalSkillRecord; state: 'stale' | 'blocked' };
    const preparedSelections: PreparedSelection[] = [];
    const pendingFailureTransitions = new Map<string, PendingFailureTransition>();

    const recordRecoverableFailure = (candidate: SkillCandidate, error: unknown, selectedExisting?: ExternalSkillRecord): boolean => {
      const code = sourceOrValidationFailureCode(error);
      if (code === undefined) return false;
      const identity = sourceSkillIdentity(candidate);
      const exactExisting = existingByIdentity.get(identity);
      if (code === 'candidate_not_found_at_source') {
        const selectedExact = selectedExisting !== undefined
          && sourceSkillIdentity({ sourceType: selectedExisting.sourceType, source: selectedExisting.sourceLocator, slug: selectedExisting.slug }) === identity
          ? selectedExisting
          : undefined;
        const existing = selectedExact ?? exactExisting;
        if (existing === undefined) pendingFailureTransitions.set(`new:${identity}`, { kind: 'new-stale', candidate });
        else pendingFailureTransitions.set(`existing:${existing.skillId}`, { kind: 'existing', record: existing, state: 'stale' });
      } else if ((code === 'skill_disabled_for_model_invocation' || code === 'skill_secret_detected' || code === 'skill_blocked') && exactExisting !== undefined) {
        // A registry alias is only a hint. Never create or block that guessed
        // identity when no verified canonical mapping exists.
        pendingFailureTransitions.set(`existing:${exactExisting.skillId}`, { kind: 'existing', record: exactExisting, state: 'blocked' });
      }
      base.failures.push({ stage: /^(?:skill_|candidate_|source_tree)/u.test(code) ? 'validation' : 'source', code });
      return true;
    };

    const processCandidates = async (candidates: Map<string, AssociatedCandidate>): Promise<void> => {
      if (attemptedSkills.size >= MAX_SOURCE_ATTEMPTS || base.selected.length + preparedSelections.length >= selectedSkillLimit) return;
      const selected = new Map<string, { candidate: SkillCandidate; requirement: SkillRequirement; existing?: ExternalSkillRecord }>();
      for (const requirement of requirementsToSearch) {
        if (successfulRequirements.has(requirement.id)) continue;
        const ranked = rankSkillCandidates({
          candidates: [...candidates.values()].filter((item) => item.requirement.id === requirement.id).map((item) => item.candidate),
          requirement,
          task: input.task,
          profile: input.profile as TaskProfile,
          mode,
        });
        for (const rankedCandidate of ranked) {
          const candidate = rankedCandidate.candidate;
          const identity = sourceSkillIdentity(candidate);
          if (candidate.duplicate || selected.has(identity) || attemptedSkills.has(identity)) continue;
          const owners = existingIdentityOwners(database, listExternalSkills(database), candidate, candidate, requirement, input.fingerprint);
          const exactOwners = owners.filter((record) => sourceSkillIdentity({ sourceType: record.sourceType, source: record.sourceLocator, slug: record.slug }) === identity);
          if (exactOwners.length > 1 || (exactOwners.length === 0 && owners.length > 1)) throw new KiokukoError('CONFLICT', 'External Skill canonical identity is ambiguous');
          const existing = exactOwners[0] ?? owners[0];
          if (suppressAutomaticImport(existing)) continue;
          const audited = await communityAllowed(candidate);
          if (audited === null) continue;
          selected.set(identity, { candidate: audited.candidate, requirement, ...(existing === undefined ? {} : { existing }) });
          attemptedSkills.add(identity);
          if (attemptedSkills.size >= MAX_SOURCE_ATTEMPTS) break;
        }
        if (attemptedSkills.size >= MAX_SOURCE_ATTEMPTS) break;
      }

      for (const { candidate, requirement, existing: selectedExisting } of selected.values()) {
        if (sourceRequestsLatched) break;
        const identity = sourceSkillIdentity(candidate);
        if (successfulRequirements.has(requirement.id) || successfulSkills.has(identity)) continue;
        const cachedSourceFailure = readPersistentSkillSourceFailure(database, candidate, now);
        if (cachedSourceFailure !== null) {
          base.failures.push({ stage: 'source', code: cachedSourceFailure.code });
          continue;
        }
        let snapshot;
        let documents;
        let authorizedCanonicalCandidate: SkillCandidate;
        let authorization: SkillMaterializationAuthorization | undefined;
        try {
          let fetchRequest: SkillSourceFetchRequest = { purpose: 'discovery' };
          if (selectedExisting !== undefined) {
            const detail = readExternalSkill(database, selectedExisting.skillId);
            if (detail === undefined) throw new KiokukoError('CONFLICT', 'External Skill changed during discovery');
            fetchRequest = externalSkillSourceFetchRequest(detail);
          }
          const fetched = await this.fetchSnapshot(candidate, fetchRequest, input.signal);
          snapshot = validateSkillSnapshot({
            candidate,
            sourceCommit: fetched.sourceCommit,
            files: fetched.files.map((file) => ({ path: file.path, content: file.content, primary: file.primary })),
          });
          const reviewedCatalog = isReviewedCatalogCandidate(candidate, requirement) ? reviewedCatalogSkill(candidate) : undefined;
          const primaryPath = snapshot.files.find((file) => file.primary)?.path;
          if (reviewedCatalog !== undefined && (primaryPath === undefined || !reviewedCatalog.primaryPaths.includes(primaryPath))) {
            throw new SkillSourceError('skill_validation_failed');
          }
          if (requirementMatchScore(snapshot.candidate, requirement, gap.missing) === 0) throw new SkillSourceError('skill_validation_failed');
          snapshot = { ...snapshot, candidate: normalizeOfficial(snapshot.candidate, requirement) };
          const authorized = await communityAllowed(snapshot.candidate);
          if (authorized === null) continue;
          authorizedCanonicalCandidate = authorized.candidate;
          authorization = authorized.authorization;
          documents = documentsFromSkillSnapshot(snapshot);
          clearPersistentSkillSourceFailure(database, candidate);
        } catch (error) {
          if (error instanceof SkillSourceError && (error.code === 'source_rate_limited' || error.code === 'source_unavailable')) {
            writePersistentSkillSourceFailure(database, candidate, error.code, externalSkillFailureTtlMs(error.retryAfterSeconds), now);
            if (error.code === 'source_rate_limited') sourceRequestsLatched = true;
          }
          if (!recordRecoverableFailure(candidate, error, selectedExisting)) throw error;
          continue;
        }

        const canonicalCandidate = authorizedCanonicalCandidate;
        const canonicalIdentity = sourceSkillIdentity(canonicalCandidate);
        if (successfulSkills.has(canonicalIdentity)) continue;
        preparedSelections.push({
          requestedCandidate: candidate,
          canonicalCandidate,
          ...(authorization === undefined ? {} : { authorization }),
          requirement,
          ...(selectedExisting === undefined ? {} : { selectedExisting }),
          ...(existingByIdentity.get(canonicalIdentity) === undefined ? {} : { observedCanonical: existingByIdentity.get(canonicalIdentity)! }),
          snapshot: { ...snapshot, candidate: canonicalCandidate },
          documents,
        });
        successfulSkills.add(canonicalIdentity);
        successfulRequirements.add(requirement.id);
        if (base.selected.length + preparedSelections.length >= selectedSkillLimit) break;
      }
    };

    // Owner-scoped and curated candidates are source-validated before any
    // unscoped community query leaves the process.
    await processCandidates(officialCandidates);

    // Phase 3: general registry search is community-only and runs only for
    // requirements that direct/owner-verified discovery did not satisfy.
    if (mode === 'community' && base.selected.length + preparedSelections.length < selectedSkillLimit && attemptedSkills.size < MAX_SOURCE_ATTEMPTS) {
      const remaining = requirementsToSearch.filter((requirement) => !successfulRequirements.has(requirement.id));
      for (const query of queries) {
        const queryRequirements = requirementsForQuery(query, remaining);
        if (queryRequirements.length > 0) await search(query, null, queryRequirements, communityCandidates);
      }
      await processCandidates(communityCandidates);
    }

    type ResolvedSelection =
      | { kind: 'new'; plan: PreparedSelection; input: PreparedSkillImport }
      | { kind: 'existing'; plan: PreparedSelection; input: PreparedSkillImport; existing: ExternalSkillRecord; canonicalTarget?: { skillId: string; expected: ExternalSkillRefreshExpectation } }
      | { kind: 'refresh'; plan: PreparedSelection; input: PreparedSkillImport; existing: ExternalSkillRecord }
      | { kind: 'reused'; plan: PreparedSelection; record: ExternalSkillRecord }
      | { kind: 'skipped'; plan: PreparedSelection };
    type PersistenceOutcome =
      | { kind: 'selected'; plan: PreparedSelection; result: SkillImportResult }
      | { kind: 'reused'; plan: PreparedSelection; record: ExternalSkillRecord }
      | { kind: 'staled'; plan: PreparedSelection }
      | { kind: 'skipped'; plan: PreparedSelection };

    if (preparedSelections.length > 0 || pendingFailureTransitions.size > 0) {
      let outcomes: PersistenceOutcome[];
      try {
        outcomes = withImmediateTransaction(database, () => {
          // Every current-state and CAS check runs under the same write lock,
          // before the first candidate import mutates durable state.
          try {
            this.assertBeforePersist?.();
          } catch (error) {
            // Caller-owned state assertions are not persistence failures. Keep
            // them out of the recoverable CAS/SQLite summary boundary below.
            throw new CallerPersistenceAssertionError(error);
          }
          const currentSkills = listExternalSkills(database);
          const failureTransitions: PendingFailureTransition[] = [];
          for (const transition of pendingFailureTransitions.values()) {
            if (transition.kind === 'new-stale') {
              const identity = sourceSkillIdentity(transition.candidate);
              if (!currentSkills.some((record) => sourceSkillIdentity({ sourceType: record.sourceType, source: record.sourceLocator, slug: record.slug }) === identity)) {
                failureTransitions.push(transition);
              }
              continue;
            }
            const current = currentSkills.find((record) => record.skillId === transition.record.skillId);
            const expected = externalSkillRefreshExpectation(transition.record);
            if (current === undefined
              || current.generation !== expected.generation
              || current.sourceCommit !== expected.sourceCommit
              || current.snapshotHash !== expected.snapshotHash
              || current.state !== expected.state
              || current.lastCheckedAt !== expected.lastCheckedAt) {
              throw new KiokukoError('CONFLICT', 'External Skill changed during discovery');
            }
            failureTransitions.push(transition);
          }

          const resolvedSelections: ResolvedSelection[] = preparedSelections.map((plan) => {
            const { requestedCandidate, canonicalCandidate, requirement, selectedExisting, observedCanonical, snapshot, documents } = plan;
            const canonicalIdentity = sourceSkillIdentity(canonicalCandidate);
            const selectedMaterialized = selectedExisting !== undefined && (selectedExisting.sourceCommit !== null || selectedExisting.snapshotHash !== null);
            const canonicalTarget = selectedExisting !== undefined && !selectedMaterialized && observedCanonical !== undefined && selectedExisting.skillId !== observedCanonical.skillId
              ? { skillId: observedCanonical.skillId, expected: externalSkillRefreshExpectation(observedCanonical) }
              : undefined;
            const observedExisting = selectedExisting ?? observedCanonical;
            const currentOwners = existingIdentityOwners(database, currentSkills, requestedCandidate, canonicalCandidate, requirement, input.fingerprint);
            const concurrentlyImported = observedExisting === undefined && currentOwners.length === 1
              ? currentOwners.find((record) => {
                if (sourceSkillIdentity({ sourceType: record.sourceType, source: record.sourceLocator, slug: record.slug }) !== canonicalIdentity
                  || record.state !== 'imported' || record.sourceCommit !== snapshot.sourceCommit || record.snapshotHash !== snapshot.snapshotHash
                  || !hasSkillMaterializationAuthorization(canonicalCandidate, plan.authorization)) return false;
                const storedRequirement = externalSkillRequirement(database, record.skillId);
                return storedRequirement !== undefined && requirementOverlaps(storedRequirement, requirement)
                  && applicabilityMatchesFingerprint(storedRequirement, input.fingerprint);
              })
              : undefined;
            if (concurrentlyImported !== undefined) return { kind: 'reused', plan, record: concurrentlyImported };

            const allowedOwnerIds = new Set([selectedExisting?.skillId, observedCanonical?.skillId].filter((value): value is string => value !== undefined));
            if (currentOwners.some((record) => !allowedOwnerIds.has(record.skillId))
              || observedExisting === undefined && currentOwners.length > 0
              || selectedExisting === undefined && currentOwners.length > 1
              || selectedExisting !== undefined && !selectedMaterialized && currentOwners.length > (canonicalTarget === undefined ? 1 : 2)) {
              throw new KiokukoError('CONFLICT', 'External Skill changed during discovery');
            }
            const currentObserved = observedExisting === undefined ? undefined : currentSkills.find((record) => record.skillId === observedExisting.skillId);
            if (observedExisting !== undefined && currentObserved === undefined) throw new KiokukoError('CONFLICT', 'External Skill changed during discovery');
            if (suppressAutomaticImport(currentObserved)) return { kind: 'skipped', plan };
            const prepared: PreparedSkillImport = {
              skill: canonicalCandidate,
              sourceWorkspace: externalSkillWorkspace(canonicalCandidate),
              sourceCommit: snapshot.sourceCommit,
              snapshotHash: snapshot.snapshotHash,
              frontmatter: snapshot.frontmatter,
              documents,
              requirement,
            };
            if (observedExisting === undefined) return { kind: 'new', plan, input: prepared };
            if (observedExisting.sourceCommit === null && observedExisting.snapshotHash === null) {
              return { kind: 'existing', plan, input: prepared, existing: observedExisting, ...(canonicalTarget === undefined ? {} : { canonicalTarget }) };
            }
            return { kind: 'refresh', plan, input: prepared, existing: observedExisting };
          });

          for (const transition of failureTransitions) {
            if (transition.kind === 'existing') {
              markExternalSkillRefreshFailureInTransaction(database, transition.record.skillId, transition.state, externalSkillRefreshExpectation(transition.record), now);
            } else {
              const discovered = recordDiscoveredSkillInTransaction(database, transition.candidate, now);
              markExternalSkillRefreshFailureInTransaction(database, discovered.skillId, 'stale', externalSkillRefreshExpectation(discovered), now);
            }
          }

          return resolvedSelections.map((selection): PersistenceOutcome => {
            if (selection.kind === 'reused' || selection.kind === 'skipped') return selection;
            if (selection.kind === 'new') {
              return { kind: 'selected', plan: selection.plan, result: persistNewSkillImportInTransaction(database, selection.input, now, selection.plan.authorization) };
            }
            if (selection.kind === 'existing') {
              return {
                kind: 'selected',
                plan: selection.plan,
                result: persistExistingSkillImportInTransaction(database, selection.existing.skillId, selection.input, externalSkillRefreshExpectation(selection.existing), now, selection.canonicalTarget, selection.plan.authorization),
              };
            }
            const result = refreshExternalSkillSnapshotInTransaction(
              database,
              selection.existing.skillId,
              selection.plan.snapshot,
              selection.input.documents,
              selection.plan.requirement,
              externalSkillRefreshExpectation(selection.existing),
              now,
              selection.plan.authorization,
            );
            return result.kind === 'staled'
              ? { kind: 'staled', plan: selection.plan }
              : { kind: 'selected', plan: selection.plan, result: result.result };
          });
        });
      } catch (error) {
        if (error instanceof CallerPersistenceAssertionError) throw error.assertionError;
        const code = persistenceFailureCode(error);
        if (code === undefined) throw error;
        base.failures.push({ stage: 'persistence', code });
        outcomes = [];
      }

      for (const outcome of outcomes) {
        if (outcome.kind === 'staled') {
          base.failures.push({ stage: 'persistence', code: 'persistence_conflict' });
          continue;
        }
        if (outcome.kind === 'skipped' || base.selected.length >= selectedSkillLimit) continue;
        if (outcome.kind === 'reused') {
          if (!base.selected.some((item) => item.skillId === outcome.record.skillId)) {
            base.selected.push({ skillId: outcome.record.skillId, name: outcome.record.name, source: outcome.record.sourceLocator, officialStatus: officialStatus(outcome.record.officialStatus), imported: true, updated: false });
          }
          continue;
        }
        if (!base.selected.some((item) => item.skillId === outcome.result.skillId)) {
          base.selected.push({
            skillId: outcome.result.skillId,
            name: outcome.plan.canonicalCandidate.name,
            source: outcome.plan.canonicalCandidate.source,
            officialStatus: outcome.plan.canonicalCandidate.officialStatus,
            imported: outcome.result.imported > 0,
            updated: outcome.result.updated,
          });
        }
      }
    }

    base.candidates = seenCandidates.size;
    return base;
  }
}

export async function discoverSkills(database: SqliteDatabase, input: DiscoverSkillsInput, dependencies: SkillDiscoveryDependencies = {}): Promise<SkillDiscoverySummary> {
  const effectiveDependencies = dependencies.fetchImpl === undefined && input.fetchImpl !== undefined
    ? { ...dependencies, fetchImpl: input.fetchImpl }
    : dependencies;
  return discoveryServiceFor(effectiveDependencies).discover(database, input);
}

let sharedDiscoveryService: SkillDiscoveryService | undefined;
const fetchDiscoveryServices = new WeakMap<Function, SkillDiscoveryService>();

function discoveryServiceFor(dependencies: SkillDiscoveryDependencies): SkillDiscoveryService {
  const keys = Object.keys(dependencies);
  if (keys.length === 0) {
    sharedDiscoveryService ??= new SkillDiscoveryService();
    return sharedDiscoveryService;
  }
  if (keys.length === 1 && dependencies.fetchImpl !== undefined) {
    const key = dependencies.fetchImpl as unknown as Function;
    const existing = fetchDiscoveryServices.get(key);
    if (existing) return existing;
    const service = new SkillDiscoveryService(dependencies);
    fetchDiscoveryServices.set(key, service);
    return service;
  }
  return new SkillDiscoveryService(dependencies);
}
