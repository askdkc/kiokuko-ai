import { rollbackFailedTransaction, withImmediateTransaction } from '../db/transaction.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { canonicalContentHash, canonicalEntryRevisionContentHash, canonicalJson, compareCanonicalStrings, type JsonObject } from '../serialization/validate.js';
import { KiokukoError } from '../errors.js';
import { buildStructuredScope, validateApplicability, validateSignals } from '../memory/structured-memory.js';
import { readEntry, recordEntryInTransaction, updateManagedExternalEntryInTransaction, type EntryRecord } from '../memory/entries.js';
import type { PreparedSkillImport, SkillAuditStatus, SkillCandidate, SkillMaterializationAuthorization, SkillProviderFailureCode, SkillRequirement, SkillSearchResult, SkillSnapshot, SkillSourceFetchRequest } from './types.js';
import { cacheKey, parseSkillCandidates, SkillProviderError } from './providers/schema.js';
import { requirementForOfficialSkill, reviewedCatalogSkill } from './official-catalog.js';
import { SkillSourceError } from './source/errors.js';
import { canonicalSkillSlugFromPrimaryPath, parseGitHubSource, revalidateSkillSnapshot, validateSkillCandidate } from './source/snapshot-validator.js';
import { documentsFromSkillSnapshot } from './import-preparation.js';
import { findSecret } from '../memory/secrets.js';
import { validSkillFrontmatterName } from './source/frontmatter.js';
import { claimSkillMaterializationAuthorization } from './materialization-authority.js';

export interface ExternalSkillRecord {
  skillId: string; provider: string; sourceType: string; sourceLocator: string; slug: string; name: string;
  installUrl: string | null; officialStatus: string; duplicate: boolean; installs: number; state: string;
  sourceWorkspace: string; sourceCommit: string | null; snapshotHash: string | null; metadata: JsonObject;
  auditStatus: SkillAuditStatus;
  generation: number;
  firstSeenAt: string; lastSeenAt: string; lastCheckedAt: string; disabledAt: string | null;
}

export type ExternalSkillState = 'discovered' | 'imported' | 'blocked' | 'stale' | 'disabled';

export interface ExternalSkillListAnchor {
  sourceLocator: string;
  slug: string;
  provider: string;
  skillId: string;
}

export interface ExternalSkillListPage {
  skills: ExternalSkillRecord[];
  version: number;
  truncated: boolean;
}

export interface SkillImportResult { skillId: string; imported: number; updated: boolean; snapshotHash: string; sourceWorkspace: string; entries: EntryRecord[]; }

export type ExternalSkillRefreshResult =
  | { kind: 'refreshed'; result: SkillImportResult }
  | { kind: 'staled'; skill: ExternalSkillRecord };

export interface ExternalSkillRefreshExpectation {
  generation: number;
  sourceCommit: string | null;
  snapshotHash: string | null;
  state: string;
  lastCheckedAt: string;
}

export interface ExternalSkillEntrySummary {
  entryId: string;
  revision: number;
  sourcePath: string;
  chunkIndex: number;
  primary: boolean;
  active: boolean;
}

export interface ExternalSkillDetail {
  skill: ExternalSkillRecord;
  entries: ExternalSkillEntrySummary[];
}

export function externalSkillSourceFetchRequest(detail: ExternalSkillDetail): SkillSourceFetchRequest {
  const materialized = detail.skill.sourceCommit !== null || detail.skill.snapshotHash !== null;
  if (!materialized) {
    if (detail.entries.length !== 0) integrity('Unmaterialized external skill has stored mappings');
    return { purpose: 'discovery' };
  }
  if (detail.skill.sourceCommit === null || detail.skill.snapshotHash === null) integrity('External skill snapshot identity is incomplete');
  const primary = detail.entries.filter((entry) => entry.primary);
  if (primary.length !== 1) integrity('External skill primary mapping is invalid');
  return { purpose: 'refresh', expectedPrimaryPath: primary[0]!.sourcePath };
}

interface CurrentSkillMapping {
  sourcePath: string;
  chunkIndex: number;
}

interface MaterializedSkillMetadata {
  documents: number;
  frontmatter: SkillSnapshot['frontmatter'];
  technology: string;
  requirementAliases: string[];
  applicability: SkillRequirement['applicability'];
  signals: SkillRequirement['signals'];
  currentMappings: CurrentSkillMapping[];
  auditStatus: SkillAuditStatus;
  officialStatus: SkillCandidate['officialStatus'];
}

interface StoredExternalSkillMapping {
  [key: string]: string | number;
  source_path: string;
  chunk_index: number;
  entry_id: string;
  entry_revision: number;
  content_hash: string;
  primary_document: number;
  active: number;
  imported_at: string;
}

export type SkillSearchCacheOutcome = 'success' | 'empty' | 'rate_limited' | 'unavailable';
export interface PersistentSkillSearchResult extends SkillSearchResult {
  cacheOutcome: SkillSearchCacheOutcome;
  failureCode?: 'registry_authentication_failed';
}
export type SkillSourceFailureCacheOutcome = 'source_rate_limited' | 'source_unavailable';
export interface PersistentSkillSourceFailure {
  code: SkillSourceFailureCacheOutcome;
  fetchedAt: string;
  expiresAt: string;
}
export type SkillAuditFailureCacheOutcome = Extract<SkillProviderFailureCode, 'registry_rate_limited' | 'registry_unavailable'>;
export interface PersistentSkillAuditFailure {
  code: SkillAuditFailureCacheOutcome;
  fetchedAt: string;
  expiresAt: string;
}

export interface ExternalSkillCachePruneResult {
  discovery: number;
  sourceFailures: number;
  auditFailures: number;
  total: number;
}

function invalidSkillDiscoveryCache(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Skill discovery cache is invalid');
}

function canonicalStoredJson(value: unknown, onInvalid: () => never): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    if (error instanceof RangeError
      || (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR')) onInvalid();
    throw error;
  }
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

interface StoredSkillSearchCacheRow {
  [key: string]: unknown;
  cache_key: unknown;
  provider: unknown;
  query_text: unknown;
  owner: unknown;
  mode: unknown;
  response_json: unknown;
  outcome: unknown;
  fetched_at: unknown;
  expires_at: unknown;
}

function validateStoredSkillSearchCacheRow(value: StoredSkillSearchCacheRow): void {
  if (typeof value.cache_key !== 'string' || !/^[0-9a-f]{64}$/u.test(value.cache_key)
    || typeof value.provider !== 'string' || typeof value.query_text !== 'string'
    || value.owner !== null && typeof value.owner !== 'string'
    || value.mode !== 'official' && value.mode !== 'community'
    || typeof value.response_json !== 'string' || typeof value.outcome !== 'string'
    || !['success', 'empty', 'rate_limited', 'unavailable'].includes(value.outcome)
    || !canonicalIsoTimestamp(value.fetched_at) || !canonicalIsoTimestamp(value.expires_at)
    || value.fetched_at > value.expires_at) invalidSkillDiscoveryCache();
  let expectedKey: string;
  try {
    expectedKey = cacheKey({ provider: value.provider, query: value.query_text, owner: value.owner, mode: value.mode });
  } catch (error) {
    if (error instanceof SkillProviderError || error instanceof KiokukoError) invalidSkillDiscoveryCache();
    throw error;
  }
  if (value.cache_key !== expectedKey) invalidSkillDiscoveryCache();
  let parsed: unknown;
  try { parsed = JSON.parse(value.response_json) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) invalidSkillDiscoveryCache();
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) invalidSkillDiscoveryCache();
  const object = parsed as Record<string, unknown>;
  const allowedFields = new Set(['provider', 'experimental', 'candidates', 'failureCode']);
  if (Object.keys(object).some((field) => !allowedFields.has(field))
    || canonicalStoredJson(object, invalidSkillDiscoveryCache) !== value.response_json
    || object.provider !== value.provider || typeof object.experimental !== 'boolean'
    || object.failureCode !== undefined && object.failureCode !== 'registry_authentication_failed') invalidSkillDiscoveryCache();
  let candidates: SkillCandidate[];
  try {
    candidates = parseSkillCandidates(object.candidates, value.provider, value.query_text === '__curated__' ? 'curated' : 'search');
  } catch (error) {
    if (error instanceof SkillProviderError && error.code === 'registry_invalid_response') invalidSkillDiscoveryCache();
    throw error;
  }
  if ((value.outcome === 'success') !== (candidates.length > 0)
    || object.failureCode === 'registry_authentication_failed' && (value.outcome !== 'unavailable' || candidates.length !== 0)) {
    invalidSkillDiscoveryCache();
  }
}

interface StoredSkillSourceFailureCacheRow {
  [key: string]: unknown;
  cache_key: unknown;
  source_type: unknown;
  source_locator: unknown;
  slug: unknown;
  outcome: unknown;
  fetched_at: unknown;
  expires_at: unknown;
}

function storedSourceFailureCacheIdentity(value: Pick<StoredSkillSourceFailureCacheRow, 'source_type' | 'source_locator' | 'slug'>): { key: string; sourceType: string; sourceLocator: string; slug: string } {
  if (value.source_type !== 'github' || typeof value.source_locator !== 'string' || typeof value.slug !== 'string'
    || !/^[A-Za-z0-9_.\-/]{1,240}$/u.test(value.slug)
    || value.slug.split('/').some((part) => part === '' || part === '.' || part === '..')
    || findSecret(`${value.source_locator}/${value.slug}`) !== undefined) invalidSkillDiscoveryCache();
  let sourceLocator: string;
  try { sourceLocator = parseGitHubSource(value.source_locator).source; }
  catch (error) {
    if (error instanceof SkillSourceError) invalidSkillDiscoveryCache();
    throw error;
  }
  if (sourceLocator !== value.source_locator) invalidSkillDiscoveryCache();
  const sourceType = value.source_type;
  const slug = value.slug;
  return { key: canonicalContentHash({ sourceType, sourceLocator, slug }), sourceType, sourceLocator, slug };
}

function validateStoredSkillSourceFailureCacheRow(value: StoredSkillSourceFailureCacheRow): void {
  const identity = storedSourceFailureCacheIdentity(value);
  if (value.cache_key !== identity.key || typeof value.outcome !== 'string'
    || !['source_rate_limited', 'source_unavailable'].includes(value.outcome)
    || !canonicalIsoTimestamp(value.fetched_at) || !canonicalIsoTimestamp(value.expires_at)
    || value.fetched_at > value.expires_at) invalidSkillDiscoveryCache();
}

interface StoredSkillAuditFailureCacheRow extends StoredSkillSourceFailureCacheRow {
  provider: unknown;
}

function validateStoredSkillAuditFailureCacheRow(value: StoredSkillAuditFailureCacheRow): void {
  const source = storedSourceFailureCacheIdentity(value);
  if (typeof value.provider !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/u.test(value.provider)
    || findSecret(value.provider) !== undefined
    || value.cache_key !== canonicalContentHash({ provider: value.provider, sourceType: source.sourceType, sourceLocator: source.sourceLocator, slug: source.slug })
    || typeof value.outcome !== 'string' || !['registry_rate_limited', 'registry_unavailable'].includes(value.outcome)
    || !canonicalIsoTimestamp(value.fetched_at) || !canonicalIsoTimestamp(value.expires_at)
    || value.fetched_at > value.expires_at) invalidSkillDiscoveryCache();
}

function storedSearchCacheRow(
  database: SqliteDatabase,
  input: { provider: string; query: string; owner?: string | null; mode: 'official' | 'community' },
  key: string,
): StoredSkillSearchCacheRow | undefined {
  const rows = database.prepare(`
    SELECT cache_key, provider, query_text, owner, mode, response_json, outcome, fetched_at, expires_at
      FROM skill_discovery_cache
     WHERE cache_key = ?
        OR (provider = ? AND query_text = ? AND owner IS ? AND mode = ?)
  `).all<StoredSkillSearchCacheRow>(key, input.provider, input.query, input.owner ?? null, input.mode);
  if (rows.length > 1) invalidSkillDiscoveryCache();
  const value = rows[0];
  if (value !== undefined) validateStoredSkillSearchCacheRow(value);
  return value;
}

function storedSourceFailureCacheRow(
  database: SqliteDatabase,
  identity: { key: string; sourceType: string; sourceLocator: string; slug: string },
): StoredSkillSourceFailureCacheRow | undefined {
  const rows = database.prepare(`
    SELECT cache_key, source_type, source_locator, slug, outcome, fetched_at, expires_at
      FROM skill_source_failure_cache
     WHERE cache_key = ?
        OR (source_type = ? AND source_locator = ? AND slug = ?)
  `).all<StoredSkillSourceFailureCacheRow>(
    identity.key,
    identity.sourceType,
    identity.sourceLocator,
    identity.slug,
  );
  if (rows.length > 1) invalidSkillDiscoveryCache();
  const value = rows[0];
  if (value !== undefined) validateStoredSkillSourceFailureCacheRow(value);
  return value;
}

function storedAuditFailureCacheRow(
  database: SqliteDatabase,
  identity: { key: string; provider: string; sourceType: string; sourceLocator: string; slug: string },
): StoredSkillAuditFailureCacheRow | undefined {
  const rows = database.prepare(`
    SELECT cache_key, provider, source_type, source_locator, slug, outcome, fetched_at, expires_at
      FROM skill_audit_failure_cache
     WHERE cache_key = ?
        OR (provider = ? AND source_type = ? AND source_locator = ? AND slug = ?)
  `).all<StoredSkillAuditFailureCacheRow>(
    identity.key,
    identity.provider,
    identity.sourceType,
    identity.sourceLocator,
    identity.slug,
  );
  if (rows.length > 1) invalidSkillDiscoveryCache();
  const value = rows[0];
  if (value !== undefined) validateStoredSkillAuditFailureCacheRow(value);
  return value;
}

export function readPersistentSkillSearchCache(database: SqliteDatabase, input: { provider: string; query: string; owner?: string | null; mode: 'official' | 'community'; now?: string }): PersistentSkillSearchResult | null {
  const now = input.now ?? new Date().toISOString();
  if (!canonicalIsoTimestamp(now)) throw new KiokukoError('VALIDATION_ERROR', 'Skill discovery cache time is invalid');
  const key = cacheKey(input);
  const value = storedSearchCacheRow(database, input, key);
  if (!value) return null;
  if (value.provider !== input.provider || value.query_text !== input.query || value.owner !== (input.owner ?? null) || value.mode !== input.mode
    || typeof value.response_json !== 'string' || typeof value.outcome !== 'string'
    || !canonicalIsoTimestamp(value.fetched_at) || !canonicalIsoTimestamp(value.expires_at)
    || value.fetched_at > value.expires_at) invalidSkillDiscoveryCache();
  let parsed: unknown;
  try { parsed = JSON.parse(value.response_json) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) invalidSkillDiscoveryCache();
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) invalidSkillDiscoveryCache();
  const object = parsed as Record<string, unknown>;
  const allowedFields = new Set(['provider', 'experimental', 'candidates', 'failureCode']);
  if (Object.keys(object).some((field) => !allowedFields.has(field))
    || canonicalStoredJson(object, invalidSkillDiscoveryCache) !== value.response_json) invalidSkillDiscoveryCache();
  if (object.provider !== input.provider || typeof object.experimental !== 'boolean') invalidSkillDiscoveryCache();
  if (!['success', 'empty', 'rate_limited', 'unavailable'].includes(value.outcome)) invalidSkillDiscoveryCache();
  if (object.failureCode !== undefined && object.failureCode !== 'registry_authentication_failed') invalidSkillDiscoveryCache();
  let candidates: SkillCandidate[];
  try {
    candidates = parseSkillCandidates(object.candidates, input.provider, input.query === '__curated__' ? 'curated' : 'search');
  } catch (error) {
    if (error instanceof SkillProviderError && error.code === 'registry_invalid_response') invalidSkillDiscoveryCache();
    throw error;
  }
  if ((value.outcome === 'success') !== (candidates.length > 0)) invalidSkillDiscoveryCache();
  if (object.failureCode === 'registry_authentication_failed' && (value.outcome !== 'unavailable' || candidates.length !== 0)) invalidSkillDiscoveryCache();
  if (value.expires_at <= now) return null;
  return {
    provider: input.provider,
    experimental: object.experimental,
    candidates,
    cacheOutcome: value.outcome as SkillSearchCacheOutcome,
    ...(object.failureCode === 'registry_authentication_failed' ? { failureCode: object.failureCode } : {}),
  };
}

export function writePersistentSkillSearchCache(database: SqliteDatabase, input: { provider: string; query: string; owner?: string | null; mode: 'official' | 'community'; result: SkillSearchResult; outcome: SkillSearchCacheOutcome; failureCode?: 'registry_authentication_failed'; ttlMs: number; now?: string }): void {
  if (input.result.provider !== input.provider || typeof input.result.experimental !== 'boolean'
    || Object.prototype.hasOwnProperty.call(input.result, 'cached')
    || !['success', 'empty', 'rate_limited', 'unavailable'].includes(input.outcome)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill search cache result is invalid');
  }
  let candidates: SkillCandidate[];
  try {
    candidates = parseSkillCandidates(input.result.candidates, input.provider, input.query === '__curated__' ? 'curated' : 'search');
  } catch (error) {
    if (error instanceof SkillProviderError && error.code === 'registry_invalid_response') {
      throw new KiokukoError('VALIDATION_ERROR', 'Skill search cache result is invalid');
    }
    throw error;
  }
  if (input.failureCode !== undefined && input.failureCode !== 'registry_authentication_failed'
    || (input.outcome === 'success') !== (candidates.length > 0)
    || input.failureCode === 'registry_authentication_failed' && (input.outcome !== 'unavailable' || candidates.length !== 0)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill search cache failure is invalid');
  }
  const now = input.now ?? new Date().toISOString();
  if (!canonicalIsoTimestamp(now) || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) throw new KiokukoError('VALIDATION_ERROR', 'Skill discovery cache time is invalid');
  const expiresAt = Date.parse(now) + input.ttlMs;
  if (!Number.isFinite(expiresAt) || Math.abs(expiresAt) > 8.64e15) throw new KiokukoError('VALIDATION_ERROR', 'Skill discovery cache time is invalid');
  const key = cacheKey(input); const expires = new Date(expiresAt).toISOString();
  storedSearchCacheRow(database, input, key);
  const response = { provider: input.result.provider, experimental: input.result.experimental, candidates, ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }) };
  database.prepare('INSERT INTO skill_discovery_cache (cache_key, provider, query_text, owner, mode, outcome, response_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET outcome = excluded.outcome, response_json = excluded.response_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at').run(key, input.provider, input.query, input.owner ?? null, input.mode, input.outcome, canonicalJson(response), now, expires);
}

function sourceFailureCacheIdentity(candidate: SkillCandidate): { key: string; sourceType: string; sourceLocator: string; slug: string } {
  validateCandidateForStorage(candidate);
  const sourceType = candidate.sourceType.normalize('NFKC').toLowerCase();
  const sourceLocator = candidate.source.normalize('NFKC').toLowerCase();
  // Repository names are canonicalized, but repository paths are
  // case-sensitive. `Foo/SKILL.md` and `foo/SKILL.md` are distinct sources.
  const slug = candidate.slug;
  return { key: canonicalContentHash({ sourceType, sourceLocator, slug }), sourceType, sourceLocator, slug };
}

export function readPersistentSkillSourceFailure(database: SqliteDatabase, candidate: SkillCandidate, now = new Date().toISOString()): PersistentSkillSourceFailure | null {
  if (!canonicalIsoTimestamp(now)) throw new KiokukoError('VALIDATION_ERROR', 'Skill source cache time is invalid');
  const identity = sourceFailureCacheIdentity(candidate);
  const value = storedSourceFailureCacheRow(database, identity);
  if (value === undefined) return null;
  if (value.source_type !== identity.sourceType || value.source_locator !== identity.sourceLocator || value.slug !== identity.slug
    || typeof value.outcome !== 'string' || !['source_rate_limited', 'source_unavailable'].includes(value.outcome)
    || !canonicalIsoTimestamp(value.fetched_at) || !canonicalIsoTimestamp(value.expires_at)
    || value.fetched_at > value.expires_at) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Skill source failure cache is invalid');
  }
  if (value.expires_at <= now) return null;
  return { code: value.outcome as SkillSourceFailureCacheOutcome, fetchedAt: value.fetched_at, expiresAt: value.expires_at };
}

export function writePersistentSkillSourceFailure(database: SqliteDatabase, candidate: SkillCandidate, code: SkillSourceFailureCacheOutcome, ttlMs: number, now = new Date().toISOString()): void {
  const identity = sourceFailureCacheIdentity(candidate);
  if (!['source_rate_limited', 'source_unavailable'].includes(code)
    || !canonicalIsoTimestamp(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill source failure cache is invalid');
  }
  const expiresAt = Date.parse(now) + ttlMs;
  if (!Number.isFinite(expiresAt) || Math.abs(expiresAt) > 8.64e15) throw new KiokukoError('VALIDATION_ERROR', 'Skill source cache time is invalid');
  storedSourceFailureCacheRow(database, identity);
  database.prepare(`
    INSERT INTO skill_source_failure_cache
      (cache_key, source_type, source_locator, slug, outcome, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      source_type = excluded.source_type,
      source_locator = excluded.source_locator,
      slug = excluded.slug,
      outcome = excluded.outcome,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `).run(identity.key, identity.sourceType, identity.sourceLocator, identity.slug, code, now, new Date(expiresAt).toISOString());
}

export function clearPersistentSkillSourceFailure(database: SqliteDatabase, candidate: SkillCandidate): void {
  const identity = sourceFailureCacheIdentity(candidate);
  storedSourceFailureCacheRow(database, identity);
  database.prepare('DELETE FROM skill_source_failure_cache WHERE cache_key = ?').run(identity.key);
}

function auditFailureCacheIdentity(provider: string, candidate: SkillCandidate): { key: string; provider: string; sourceType: string; sourceLocator: string; slug: string } {
  const source = sourceFailureCacheIdentity(candidate);
  if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(provider) || findSecret(provider) !== undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill audit failure cache is invalid');
  }
  return {
    key: canonicalContentHash({ provider, sourceType: source.sourceType, sourceLocator: source.sourceLocator, slug: source.slug }),
    provider,
    sourceType: source.sourceType,
    sourceLocator: source.sourceLocator,
    slug: source.slug,
  };
}

export function readPersistentSkillAuditFailure(database: SqliteDatabase, provider: string, candidate: SkillCandidate, now = new Date().toISOString()): PersistentSkillAuditFailure | null {
  if (!canonicalIsoTimestamp(now)) throw new KiokukoError('VALIDATION_ERROR', 'Skill audit cache time is invalid');
  const identity = auditFailureCacheIdentity(provider, candidate);
  const value = storedAuditFailureCacheRow(database, identity);
  if (value === undefined) return null;
  if (value.provider !== identity.provider || value.source_type !== identity.sourceType
    || value.source_locator !== identity.sourceLocator || value.slug !== identity.slug
    || typeof value.outcome !== 'string' || !['registry_rate_limited', 'registry_unavailable'].includes(value.outcome)
    || !canonicalIsoTimestamp(value.fetched_at) || !canonicalIsoTimestamp(value.expires_at)
    || value.fetched_at > value.expires_at) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Skill audit failure cache is invalid');
  }
  if (value.expires_at <= now) return null;
  return { code: value.outcome as SkillAuditFailureCacheOutcome, fetchedAt: value.fetched_at, expiresAt: value.expires_at };
}

export function writePersistentSkillAuditFailure(database: SqliteDatabase, provider: string, candidate: SkillCandidate, code: SkillAuditFailureCacheOutcome, ttlMs: number, now = new Date().toISOString()): void {
  const identity = auditFailureCacheIdentity(provider, candidate);
  if (!['registry_rate_limited', 'registry_unavailable'].includes(code)
    || !canonicalIsoTimestamp(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill audit failure cache is invalid');
  }
  const expiresAt = Date.parse(now) + ttlMs;
  if (!Number.isFinite(expiresAt) || Math.abs(expiresAt) > 8.64e15) throw new KiokukoError('VALIDATION_ERROR', 'Skill audit cache time is invalid');
  storedAuditFailureCacheRow(database, identity);
  database.prepare(`
    INSERT INTO skill_audit_failure_cache
      (cache_key, provider, source_type, source_locator, slug, outcome, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      provider = excluded.provider,
      source_type = excluded.source_type,
      source_locator = excluded.source_locator,
      slug = excluded.slug,
      outcome = excluded.outcome,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `).run(identity.key, identity.provider, identity.sourceType, identity.sourceLocator, identity.slug, code, now, new Date(expiresAt).toISOString());
}

export function clearPersistentSkillAuditFailure(database: SqliteDatabase, provider: string, candidate: SkillCandidate): void {
  const identity = auditFailureCacheIdentity(provider, candidate);
  storedAuditFailureCacheRow(database, identity);
  database.prepare('DELETE FROM skill_audit_failure_cache WHERE cache_key = ?').run(identity.key);
}

export function pruneExternalSkillCaches(database: SqliteDatabase, now = new Date().toISOString()): ExternalSkillCachePruneResult {
  if (!canonicalIsoTimestamp(now)) throw new KiokukoError('VALIDATION_ERROR', 'Skill cache prune time is invalid');
  return withImmediateTransaction(database, () => {
    const discoveryRows = database.prepare(`
      SELECT cache_key, provider, query_text, owner, mode, response_json, outcome, fetched_at, expires_at
        FROM skill_discovery_cache
       ORDER BY cache_key
    `).all<StoredSkillSearchCacheRow>();
    const sourceRows = database.prepare(`
      SELECT cache_key, source_type, source_locator, slug, outcome, fetched_at, expires_at
        FROM skill_source_failure_cache
       ORDER BY cache_key
    `).all<StoredSkillSourceFailureCacheRow>();
    const auditRows = database.prepare(`
      SELECT cache_key, provider, source_type, source_locator, slug, outcome, fetched_at, expires_at
        FROM skill_audit_failure_cache
       ORDER BY cache_key
    `).all<StoredSkillAuditFailureCacheRow>();
    discoveryRows.forEach(validateStoredSkillSearchCacheRow);
    sourceRows.forEach(validateStoredSkillSourceFailureCacheRow);
    auditRows.forEach(validateStoredSkillAuditFailureCacheRow);
    database.prepare('DELETE FROM skill_discovery_cache WHERE expires_at <= ?').run(now);
    const discovery = Number(database.prepare('SELECT changes() AS count').get<{ count: number }>()?.count ?? 0);
    database.prepare('DELETE FROM skill_source_failure_cache WHERE expires_at <= ?').run(now);
    const sourceFailures = Number(database.prepare('SELECT changes() AS count').get<{ count: number }>()?.count ?? 0);
    database.prepare('DELETE FROM skill_audit_failure_cache WHERE expires_at <= ?').run(now);
    const auditFailures = Number(database.prepare('SELECT changes() AS count').get<{ count: number }>()?.count ?? 0);
    if (!Number.isSafeInteger(discovery) || discovery < 0 || !Number.isSafeInteger(sourceFailures) || sourceFailures < 0
      || !Number.isSafeInteger(auditFailures) || auditFailures < 0) {
      invalidSkillDiscoveryCache();
    }
    return { discovery, sourceFailures, auditFailures, total: discovery + sourceFailures + auditFailures };
  });
}

function safePart(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/gu, '-'); }
export function externalSkillWorkspace(candidate: SkillCandidate): string {
  const prefix = `external-skills:${candidate.sourceType}:`;
  const source = safePart(candidate.source);
  const available = 240 - prefix.length;
  const suffix = canonicalContentHash({ sourceType: candidate.sourceType, source: candidate.source.toLowerCase() }).slice(0, 16);
  const maxSource = available - suffix.length - 1;
  return `${prefix}${source.slice(0, maxSource)}-${suffix}`;
}
function sourceReference(candidate: SkillCandidate, commit: string, path: string): string { return `https://github.com/${candidate.source}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`; }
function candidateId(candidate: SkillCandidate): string { return `${candidate.sourceType}:${candidate.source.toLowerCase()}:${candidate.slug}`; }
function sameSkillSource(record: ExternalSkillRecord, candidate: SkillCandidate): boolean {
  return record.sourceType.toLowerCase() === candidate.sourceType.toLowerCase()
    && record.sourceLocator.toLowerCase() === candidate.source.toLowerCase();
}

export interface ExternalSkillLocator { source: string; slug: string; }

export function parseExternalSkillLocator(identifier: string): ExternalSkillLocator {
  if (identifier !== identifier.trim() || identifier.includes('?') || identifier.includes('#') || identifier.includes('\\')) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill identifier must be an owner/repository/skill path');
  }
  if (identifier.includes('://')) throw new KiokukoError('VALIDATION_ERROR', 'Skill identifier must be an owner/repository/skill path');
  const parts = identifier.split('/');
  if (parts.length < 3 || parts.some((part) => part.length === 0)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill identifier must be owner/repository/skill');
  }
  let source: string;
  try { source = parseGitHubSource(`${parts[0]!}/${parts[1]!}`).source; }
  catch (error) {
    if (error instanceof SkillSourceError) throw new KiokukoError('VALIDATION_ERROR', 'Skill identifier contains an unsafe path');
    throw error;
  }
  const slug = parts.slice(2).join('/');
  if (!/^[A-Za-z0-9_.\-/]{1,240}$/u.test(slug)
    || slug.split('/').some((part) => part === '.' || part === '..')) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill identifier contains an unsafe path');
  }
  return { source, slug };
}

export function resolveExternalSkillIdentifier(database: SqliteDatabase, identifier: string): ExternalSkillRecord {
  const exact = row(database, identifier);
  if (exact !== undefined) return exact;
  if (identifier.includes('://')) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill identifier must be an owner/repository/skill path');
  }
  if (identifier.includes(':')) {
    throw new KiokukoError('NOT_FOUND', 'External skill not found');
  }
  const locator = parseExternalSkillLocator(identifier);
  const matches = database.prepare(`SELECT skill_id FROM external_skills WHERE source_locator = ? AND slug = ? ORDER BY skill_id`)
    .all<{ skill_id: string }>(locator.source, locator.slug);
  if (matches.length === 0) throw new KiokukoError('NOT_FOUND', 'External skill not found');
  if (matches.length > 1) throw new KiokukoError('CONFLICT', 'External skill identifier is ambiguous; use the internal skill ID');
  const resolved = row(database, matches[0]!.skill_id);
  if (resolved === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'External skill row disappeared during identifier resolution');
  return resolved;
}

function validateCandidateForStorage(candidate: SkillCandidate): void {
  let validated: SkillCandidate;
  try { validated = validateSkillCandidate(candidate); }
  catch (error) {
    if (error instanceof SkillSourceError) throw new KiokukoError('VALIDATION_ERROR', 'External skill candidate is invalid');
    throw error;
  }
  // The source validator canonicalizes repository casing for fetches. Durable
  // rows must already contain that canonical value rather than accepting an
  // alternate spelling that later resolves to the same repository.
  if (validated.source !== candidate.source) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill candidate is invalid');
  }
}

function integrity(message: string): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function assertExternalSkillGenerationClock(database: SqliteDatabase): number {
  const clock = database.prepare('SELECT value FROM external_skill_generation_clock WHERE singleton = 1')
    .get<{ value: unknown }>();
  const tokens = database.prepare('SELECT COUNT(*) AS count, MAX(generation) AS maximum FROM external_skill_generation_tokens')
    .get<{ count: unknown; maximum: unknown }>();
  const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'external_skill_generation_tokens'")
    .get<{ seq: unknown }>();
  const live = database.prepare('SELECT COUNT(*) AS count, MAX(generation) AS maximum FROM external_skills')
    .get<{ count: unknown; maximum: unknown }>();
  const missingTokens = database.prepare(`
    SELECT COUNT(*) AS count
      FROM external_skills AS skill
      LEFT JOIN external_skill_generation_tokens AS token ON token.generation = skill.generation
     WHERE token.generation IS NULL
  `).get<{ count: unknown }>()?.count;
  const unreferencedTokens = database.prepare(`
    SELECT COUNT(*) AS count
      FROM external_skill_generation_tokens AS token
      LEFT JOIN external_skills AS skill ON skill.generation = token.generation
     WHERE skill.generation IS NULL
  `).get<{ count: unknown }>()?.count;
  const tokenMaximum = tokens?.maximum === null ? 0 : tokens?.maximum;
  const sequenceValue = sequence === undefined ? 0 : sequence.seq;
  const liveMaximum = live?.maximum === null ? 0 : live?.maximum;
  if (clock === undefined || typeof clock.value !== 'number' || !Number.isSafeInteger(clock.value)
    || clock.value < 0 || clock.value >= Number.MAX_SAFE_INTEGER
    || tokens === undefined || typeof tokens.count !== 'number' || !Number.isSafeInteger(tokens.count) || tokens.count < 0
    || typeof tokenMaximum !== 'number' || !Number.isSafeInteger(tokenMaximum) || tokenMaximum < 0
    || typeof sequenceValue !== 'number' || !Number.isSafeInteger(sequenceValue) || sequenceValue < 0
    || live === undefined || typeof live.count !== 'number' || !Number.isSafeInteger(live.count) || live.count < 0
    || typeof liveMaximum !== 'number' || !Number.isSafeInteger(liveMaximum) || liveMaximum < 0
    || typeof missingTokens !== 'number' || missingTokens !== 0
    || typeof unreferencedTokens !== 'number' || unreferencedTokens !== 0
    || tokens.count !== live.count || tokenMaximum > clock.value || liveMaximum > clock.value
    || sequenceValue !== clock.value) {
    integrity('External skill generation allocator is invalid or exhausted');
  }
  return clock.value;
}

/** Read the durable mutation token used to bind external-skill list snapshots. */
export function externalSkillListVersion(database: SqliteDatabase): number {
  return assertExternalSkillGenerationClock(database);
}

function requiredMetadataText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 500
    || /[\p{Cc}\p{Cf}]/u.test(value) || findSecret(value) !== undefined) {
    integrity('External skill metadata is invalid');
  }
  const normalized = value.normalize('NFKC').trim();
  if (normalized !== value) integrity('External skill metadata is invalid');
  return normalized;
}

function requirementAliasesMetadata(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100
    || value.some((item) => typeof item !== 'string' || item.trim().length < 1 || item.length > 500 || /[\p{Cc}\p{Cf}]/u.test(item) || findSecret(item) !== undefined)) {
    integrity('External skill metadata is invalid');
  }
  const normalized = [...new Set(value.map((item) => String(item).normalize('NFKC').trim()))]
    .sort(compareCanonicalStrings);
  if (normalized.length < 1 || normalized.length !== value.length
    || normalized.some((item, index) => item !== value[index])) integrity('External skill metadata is invalid');
  return normalized;
}

function currentMappingsMetadata(value: unknown): CurrentSkillMapping[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) integrity('External skill metadata is invalid');
  const seen = new Set<string>();
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) integrity('External skill metadata is invalid');
    const mapping = item as Record<string, unknown>;
    if (Object.keys(mapping).some((key) => key !== 'sourcePath' && key !== 'chunkIndex')
      || typeof mapping.sourcePath !== 'string' || mapping.sourcePath.length < 1 || mapping.sourcePath.length > 2_000
      || mapping.sourcePath.startsWith('/') || mapping.sourcePath.includes('\\') || mapping.sourcePath.includes('\0')
      || mapping.sourcePath.split('/').some((part) => part === '' || part === '.' || part === '..')
      || typeof mapping.chunkIndex !== 'number' || !Number.isSafeInteger(mapping.chunkIndex) || mapping.chunkIndex < 0) {
      integrity('External skill metadata is invalid');
    }
    const key = `${mapping.sourcePath}\u0000${mapping.chunkIndex}`;
    if (seen.has(key)) integrity('External skill metadata is invalid');
    seen.add(key);
    return { sourcePath: mapping.sourcePath, chunkIndex: mapping.chunkIndex };
  });
}

function materializedSkillMetadata(metadata: JsonObject): MaterializedSkillMetadata {
  const fields = new Set(['applicability', 'auditStatus', 'currentMappings', 'documents', 'frontmatter', 'officialStatus', 'requirementAliases', 'signals', 'technology']);
  const keys = Object.keys(metadata);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) integrity('External skill metadata is invalid');
  const auditStatus = metadata.auditStatus;
  if (typeof auditStatus !== 'string' || !['not-required', 'passed', 'failed', 'unavailable'].includes(auditStatus)) integrity('External skill metadata is invalid');
  const officialStatus = metadata.officialStatus;
  if (typeof officialStatus !== 'string' || !['curated', 'catalog-verified', 'owner-verified', 'registry-only', 'unknown'].includes(officialStatus)) integrity('External skill metadata is invalid');
  let applicability: SkillRequirement['applicability'];
  let signals: SkillRequirement['signals'];
  try {
    applicability = validateApplicability(metadata.applicability) as SkillRequirement['applicability'];
    signals = validateSignals(metadata.signals) as SkillRequirement['signals'];
  } catch (error) {
    if (error instanceof KiokukoError && (error.code === 'VALIDATION_ERROR' || error.code === 'SECURITY_REJECTION')) integrity('External skill metadata is invalid');
    throw error;
  }
  const currentMappings = currentMappingsMetadata(metadata.currentMappings);
  const rawFrontmatter = metadata.frontmatter;
  if (typeof rawFrontmatter !== 'object' || rawFrontmatter === null || Array.isArray(rawFrontmatter)) integrity('External skill frontmatter is invalid');
  const frontmatterObject = rawFrontmatter as Record<string, unknown>;
  if (Object.keys(frontmatterObject).length !== 3
    || Object.keys(frontmatterObject).some((key) => !['name', 'description', 'disableModelInvocation'].includes(key))
    || !validSkillFrontmatterName(frontmatterObject.name) || findSecret(frontmatterObject.name) !== undefined
    || frontmatterObject.description !== null && (typeof frontmatterObject.description !== 'string' || frontmatterObject.description.length > 2_000
      || /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u.test(frontmatterObject.description) || findSecret(frontmatterObject.description) !== undefined)
    || frontmatterObject.disableModelInvocation !== false) integrity('External skill frontmatter is invalid');
  const frontmatter = {
    name: frontmatterObject.name,
    description: frontmatterObject.description as string | null,
    disableModelInvocation: false,
  };
  const documents = metadata.documents;
  if (typeof documents !== 'number' || !Number.isSafeInteger(documents) || documents < 1 || documents > 64 || documents !== currentMappings.length) {
    integrity('External skill metadata is invalid');
  }
  if (!Object.values(applicability).some((value) => Array.isArray(value) && value.length > 0)) integrity('External skill applicability is missing');
  if (canonicalContentHash(applicability) !== canonicalContentHash(metadata.applicability)
    || canonicalContentHash(signals) !== canonicalContentHash(metadata.signals)) integrity('External skill metadata is invalid');
  return {
    documents,
    frontmatter,
    technology: requiredMetadataText(metadata.technology),
    requirementAliases: requirementAliasesMetadata(metadata.requirementAliases),
    applicability,
    signals,
    currentMappings,
    auditStatus: auditStatus as SkillAuditStatus,
    officialStatus: officialStatus as SkillCandidate['officialStatus'],
  };
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1) integrity('External skill row is invalid');
  return value;
}

function decodeExternalSkillRow(value: Record<string, unknown>): ExternalSkillRecord {
  if (typeof value.metadata_json !== 'string') integrity('External skill metadata is invalid');
  let metadata: JsonObject;
  try {
    metadata = JSON.parse(value.metadata_json) as JsonObject;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) integrity('External skill metadata is invalid');
    throw error;
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) integrity('External skill metadata is invalid');
  if (canonicalStoredJson(metadata, () => integrity('External skill metadata is invalid')) !== value.metadata_json) {
    integrity('External skill metadata is not canonical');
  }
  const sourceCommit = value.source_commit === null ? null : storedText(value.source_commit);
  const snapshotHash = value.snapshot_hash === null ? null : storedText(value.snapshot_hash);
  if ((sourceCommit === null) !== (snapshotHash === null)) integrity('External skill snapshot identity is invalid');
  if (sourceCommit !== null && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit) || !/^[0-9a-f]{64}$/u.test(snapshotHash!))) {
    integrity('External skill snapshot identity is invalid');
  }
  if (sourceCommit === null && Object.keys(metadata).length !== 0) integrity('External skill metadata is invalid');
  const materialized = sourceCommit === null ? undefined : materializedSkillMetadata(metadata);
  const storedSkillId = storedText(value.skill_id);
  const generation = value.generation;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    integrity('External skill generation is invalid');
  }
  const provider = storedText(value.provider);
  const sourceType = storedText(value.source_type);
  const sourceLocator = storedText(value.source_locator);
  const slug = storedText(value.slug);
  const name = storedText(value.name);
  const installUrl = value.install_url === null ? null : storedText(value.install_url);
  const officialStatus = storedText(value.official_status);
  if (typeof value.duplicate !== 'number' || ![0, 1].includes(value.duplicate)
    || typeof value.installs !== 'number' || !Number.isSafeInteger(value.installs)) integrity('External skill row is invalid');
  const state = storedText(value.state);
  const sourceWorkspace = storedText(value.source_workspace);
  const disabledAt = value.disabled_at === null ? null : storedText(value.disabled_at);
  const firstSeenAt = storedText(value.first_seen_at);
  const lastSeenAt = storedText(value.last_seen_at);
  const lastCheckedAt = storedText(value.last_checked_at);
  if (!canonicalIsoTimestamp(firstSeenAt) || !canonicalIsoTimestamp(lastSeenAt) || !canonicalIsoTimestamp(lastCheckedAt)
    || disabledAt !== null && !canonicalIsoTimestamp(disabledAt)
    || firstSeenAt > lastSeenAt || firstSeenAt > lastCheckedAt
    || disabledAt !== null && disabledAt < firstSeenAt) {
    integrity('External skill lifecycle timestamps are invalid');
  }
  const candidate: SkillCandidate = {
    id: `${provider}:${sourceLocator}:${slug}`,
    provider,
    name,
    slug,
    source: sourceLocator,
    sourceType: sourceType as SkillCandidate['sourceType'],
    installUrl,
    installs: value.installs,
    duplicate: value.duplicate === 1,
    officialStatus: officialStatus as SkillCandidate['officialStatus'],
    ...(materialized === undefined ? {} : { auditStatus: materialized.auditStatus }),
  };
  try {
    validateCandidateForStorage(candidate);
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') integrity('External skill row is invalid');
    throw error;
  }
  if (materialized !== undefined && materialized.auditStatus !== (reviewedCatalogSkill(candidate) === undefined ? 'passed' : 'not-required')) {
    integrity('External skill materialization trust is invalid');
  }
  if (storedSkillId !== candidateId(candidate) || sourceWorkspace !== externalSkillWorkspace(candidate)
    || !['discovered', 'imported', 'disabled', 'stale', 'blocked'].includes(state)
    || (sourceCommit === null && (state === 'imported' || state === 'disabled' || disabledAt !== null))
    || (sourceCommit !== null && !['imported', 'disabled', 'stale', 'blocked'].includes(state))
    || (state === 'imported' && disabledAt !== null)
    || (state === 'disabled' && disabledAt === null)
    || (materialized !== undefined && (materialized.officialStatus !== officialStatus || materialized.frontmatter.name !== name))) {
    integrity('External skill row is invalid');
  }
  const auditStatus = materialized?.auditStatus
    ?? (reviewedCatalogSkill(candidate) === undefined ? 'unavailable' : 'not-required');
  return { skillId: storedSkillId, provider, sourceType, sourceLocator, slug, name, installUrl, officialStatus, duplicate: value.duplicate === 1, installs: value.installs, state, sourceWorkspace, sourceCommit, snapshotHash, metadata, auditStatus, generation, firstSeenAt, lastSeenAt, lastCheckedAt, disabledAt };
}

function row(database: SqliteDatabase, skillId: string): ExternalSkillRecord | undefined {
  assertExternalSkillGenerationClock(database);
  const value = database.prepare('SELECT * FROM external_skills WHERE skill_id = ?').get<Record<string, unknown>>(skillId);
  if (!value) return undefined;
  return decodeExternalSkillRow(value);
}

/** Capture the exact row generation required by refresh and discovery CAS operations. */
export function externalSkillRefreshExpectation(record: ExternalSkillRecord): ExternalSkillRefreshExpectation {
  return {
    generation: record.generation,
    sourceCommit: record.sourceCommit,
    snapshotHash: record.snapshotHash,
    state: record.state,
    lastCheckedAt: record.lastCheckedAt,
  };
}

function mergedStrings(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  const values = [...new Set([...(left ?? []), ...(right ?? [])])].sort(compareCanonicalStrings);
  return values.length === 0 ? undefined : values;
}

function mergeSkillRequirements(left: SkillRequirement, right: SkillRequirement): SkillRequirement {
  const frameworks = [...new Map([...(left.applicability.frameworks ?? []), ...(right.applicability.frameworks ?? [])]
    .map((item) => [`${item.name}\u0000${item.version ?? ''}`, item])).values()]
    .sort((a, b) => compareCanonicalStrings(`${a.name}\u0000${a.version ?? ''}`, `${b.name}\u0000${b.version ?? ''}`));
  const applicability = validateApplicability({
    ...(mergedStrings(left.applicability.languages, right.applicability.languages) === undefined ? {} : { languages: mergedStrings(left.applicability.languages, right.applicability.languages) }),
    ...(frameworks.length === 0 ? {} : { frameworks }),
    ...(mergedStrings(left.applicability.databases, right.applicability.databases) === undefined ? {} : { databases: mergedStrings(left.applicability.databases, right.applicability.databases) }),
    ...(mergedStrings(left.applicability.runtimes, right.applicability.runtimes) === undefined ? {} : { runtimes: mergedStrings(left.applicability.runtimes, right.applicability.runtimes) }),
    ...(mergedStrings(left.applicability.tools, right.applicability.tools) === undefined ? {} : { tools: mergedStrings(left.applicability.tools, right.applicability.tools) }),
  }) as SkillRequirement['applicability'];
  const packages = mergedStrings(left.signals.packages, right.signals.packages);
  const [technology] = [left.technology, right.technology].sort(compareCanonicalStrings);
  return {
    id: technology!, technology: technology!,
    aliases: mergedStrings([left.id, left.technology, ...left.aliases], [right.id, right.technology, ...right.aliases]) ?? [technology!],
    queries: mergedStrings(left.queries, right.queries) ?? [technology!],
    owners: mergedStrings(left.owners, right.owners) ?? [],
    repositories: mergedStrings(left.repositories, right.repositories) ?? [],
    applicability,
    signals: packages === undefined ? {} : { packages },
    reason: 'Merged applicability for one managed external skill.',
  };
}

function requirementScopeIdentity(requirement: SkillRequirement | undefined, identities: string[]): string | null {
  return requirement === undefined ? null : canonicalContentHash({ technology: requirement.technology, identities, applicability: requirement.applicability, signals: requirement.signals });
}

function managedRequirementScopeHash(requirement: SkillRequirement | undefined): string {
  if (requirement === undefined) throw new KiokukoError('VALIDATION_ERROR', 'External skill applicability is required');
  const identities = [...new Set([requirement.id, requirement.technology, ...requirement.aliases])]
    .sort(compareCanonicalStrings);
  return requirementScopeIdentity(requirement, identities)!;
}

function requirementFromMaterializedSkill(skill: ExternalSkillRecord, metadata: MaterializedSkillMetadata): SkillRequirement {
  return {
    id: metadata.technology,
    technology: metadata.technology,
    aliases: metadata.requirementAliases,
    queries: [metadata.technology],
    owners: [skill.sourceLocator.split('/')[0] ?? skill.sourceLocator],
    repositories: [skill.sourceLocator],
    applicability: metadata.applicability,
    signals: metadata.signals,
    reason: 'Applicability persisted with the imported external skill snapshot.',
  };
}

/** Read the complete applicability persisted at the materialization boundary. */
export function externalSkillRequirement(database: SqliteDatabase, skillId: string): SkillRequirement | undefined {
  const skill = row(database, skillId);
  if (!skill || skill.sourceCommit === null) return undefined;
  assertCurrentManagedSnapshot(database, skill);
  const requirement = requirementFromMaterializedSkill(skill, materializedSkillMetadata(skill.metadata));
  return requirement;
}

function normalizedSkillRequirement(requirement: SkillRequirement): SkillRequirement {
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 500 || value !== value.normalize('NFKC').trim()
      || /[\p{Cc}\p{Cf}]/u.test(value) || findSecret(value) !== undefined) {
      throw new KiokukoError('VALIDATION_ERROR', 'External skill requirement is invalid');
    }
    return value;
  };
  if (!Array.isArray(requirement.aliases) || requirement.aliases.length < 1 || requirement.aliases.length > 100) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill requirement is invalid');
  }
  const normalized = {
    ...requirement,
    id: text(requirement.id),
    technology: text(requirement.technology),
    aliases: [...new Set(requirement.aliases.map(text))].sort(compareCanonicalStrings),
    applicability: validateApplicability(requirement.applicability) as SkillRequirement['applicability'],
    signals: validateSignals(requirement.signals) as SkillRequirement['signals'],
  };
  if (!Object.values(normalized.applicability).some((value) => Array.isArray(value) && value.length > 0)) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill applicability is required');
  }
  return normalized;
}

function allocateExternalSkillGeneration(database: SqliteDatabase): number {
  const previous = assertExternalSkillGenerationClock(database);
  const allocated = database.prepare('INSERT INTO external_skill_generation_tokens DEFAULT VALUES RETURNING generation')
    .get<{ generation: unknown }>();
  if (allocated === undefined || typeof allocated.generation !== 'number'
    || !Number.isSafeInteger(allocated.generation) || allocated.generation !== previous + 1) {
    integrity('External skill generation allocator is invalid or exhausted');
  }
  database.prepare('UPDATE external_skill_generation_clock SET value = ? WHERE singleton = 1 AND value = ?')
    .run(allocated.generation, previous);
  const changed = database.prepare('SELECT changes() AS count').get<{ count: unknown }>()?.count;
  if (changed !== 1) integrity('External skill generation allocator is invalid or exhausted');
  return allocated.generation;
}

function pruneExternalSkillGenerationTokens(database: SqliteDatabase): void {
  database.prepare('DELETE FROM external_skill_generation_tokens WHERE generation NOT IN (SELECT generation FROM external_skills)').run();
}

function upsertCandidate(database: SqliteDatabase, candidate: SkillCandidate, now: string): string {
  validateCandidateForStorage(candidate);
  const skillId = candidateId(candidate); const workspace = externalSkillWorkspace(candidate);
  // Validate an existing row before the upsert can overwrite and accidentally
  // conceal corrupted identity or materialization metadata.
  row(database, skillId);
  const generation = allocateExternalSkillGeneration(database);
  database.prepare(`
    INSERT INTO external_skills (
      skill_id, generation, provider, source_type, source_locator, slug, name,
      install_url, official_status, duplicate, installs, state,
      source_workspace, first_seen_at, last_seen_at, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?)
    ON CONFLICT(skill_id) DO UPDATE SET
      generation = excluded.generation,
      provider = CASE WHEN external_skills.source_commit IS NULL THEN excluded.provider ELSE external_skills.provider END,
      source_type = CASE WHEN external_skills.source_commit IS NULL THEN excluded.source_type ELSE external_skills.source_type END,
      source_locator = CASE WHEN external_skills.source_commit IS NULL THEN excluded.source_locator ELSE external_skills.source_locator END,
      slug = CASE WHEN external_skills.source_commit IS NULL THEN excluded.slug ELSE external_skills.slug END,
      name = CASE WHEN external_skills.source_commit IS NULL THEN excluded.name ELSE external_skills.name END,
      install_url = CASE WHEN external_skills.source_commit IS NULL THEN excluded.install_url ELSE external_skills.install_url END,
      official_status = CASE WHEN external_skills.source_commit IS NULL THEN excluded.official_status ELSE external_skills.official_status END,
      duplicate = CASE WHEN external_skills.source_commit IS NULL THEN excluded.duplicate ELSE external_skills.duplicate END,
      installs = CASE WHEN external_skills.source_commit IS NULL THEN excluded.installs ELSE external_skills.installs END,
      source_workspace = CASE WHEN external_skills.source_commit IS NULL THEN excluded.source_workspace ELSE external_skills.source_workspace END,
      last_seen_at = excluded.last_seen_at,
      last_checked_at = CASE WHEN external_skills.source_commit IS NULL THEN excluded.last_checked_at ELSE external_skills.last_checked_at END
  `).run(skillId, generation, candidate.provider, candidate.sourceType, candidate.source, candidate.slug, candidate.name, candidate.installUrl, candidate.officialStatus, candidate.duplicate ? 1 : 0, candidate.installs, workspace, now, now, now);
  pruneExternalSkillGenerationTokens(database);
  return skillId;
}

function authorizedPreparedSkillImport(
  input: PreparedSkillImport,
  authorization: SkillMaterializationAuthorization | undefined,
): PreparedSkillImport {
  return { ...input, skill: claimSkillMaterializationAuthorization(input.skill, authorization) };
}

function inputForDocument(input: PreparedSkillImport, document: PreparedSkillImport['documents'][number], now: string) {
  const scope = buildStructuredScope({ visibility: 'project', retrievalScope: 'ecosystem', memoryClass: 'reference', applicability: input.requirement?.applicability ?? {}, signals: input.requirement?.signals ?? {} });
  const provenance = {
    type: 'external_skill',
    reference: sourceReference(input.skill, input.sourceCommit, document.sourcePath),
    externalSkillId: candidateId(input.skill),
    requirementScopeHash: managedRequirementScopeHash(input.requirement),
    sourceRepositoryId: `github:${input.skill.source}`,
    sourceWorkspace: input.sourceWorkspace,
    sourceCommit: input.sourceCommit,
    sourcePath: document.sourcePath,
    sourceChunkIndex: document.chunkIndex,
    timestamp: now,
  } as JsonObject;
  const tags = [...new Set(['external:skill', `provider:${input.skill.provider}`, `source:${input.skill.source}`, `skill:${input.skill.slug.split('/').at(-1) ?? input.skill.slug}`, `official:${input.skill.officialStatus}`, `technology:${input.requirement?.technology ?? input.skill.name}`])]
    .sort(compareCanonicalStrings);
  return { workspace: input.sourceWorkspace, kind: 'reference' as const, status: 'candidate' as const, title: document.title, body: document.body, summary: document.summary, scope, provenance, trustLevel: 'untrusted' as const, confidence: 0.7, tags, createdBy: 'kiokuko-skill-discovery', actor: 'kiokuko-skill-discovery' };
}

function validatePreparedFrontmatter(input: PreparedSkillImport): void {
  const value = input.frontmatter as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KiokukoError('VALIDATION_ERROR', 'External skill frontmatter is invalid');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 3 || Object.keys(object).some((key) => !['name', 'description', 'disableModelInvocation'].includes(key))
    || object.name !== input.skill.name
    || !validSkillFrontmatterName(object.name) || findSecret(object.name as string) !== undefined
    || object.description !== null && (typeof object.description !== 'string' || object.description.length > 2_000 || /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u.test(object.description) || findSecret(object.description) !== undefined)
    || object.disableModelInvocation !== false
    || input.documents.some((document) => document.summary !== object.description)) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill frontmatter is invalid');
  }
  const primaryPath = input.documents.find((document) => document.primary)?.sourcePath;
  if (primaryPath === 'SKILL.md' && (input.skill.slug.includes('/') || input.skill.slug !== object.name || input.skill.name !== object.name)) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill root identity is invalid');
  }
}

type ManagedRecordInput = ReturnType<typeof inputForDocument>;

function managedRecordContentHash(input: ManagedRecordInput): string {
  return canonicalEntryRevisionContentHash({
    kind: input.kind,
    title: input.title,
    body: input.body,
    summary: input.summary ?? null,
    scope: input.scope,
    provenance: input.provenance,
    tags: input.tags,
  });
}

function candidateFromMaterializedSkill(skill: ExternalSkillRecord, metadata: MaterializedSkillMetadata): SkillCandidate {
  return {
    id: `${skill.provider}:${skill.sourceLocator}:${skill.slug}`,
    provider: skill.provider,
    name: skill.name,
    slug: skill.slug,
    source: skill.sourceLocator,
    sourceType: 'github',
    installUrl: skill.installUrl,
    installs: skill.installs,
    duplicate: skill.duplicate,
    officialStatus: metadata.officialStatus,
    auditStatus: metadata.auditStatus,
  };
}

function canonicalStoredSkillSlug(candidate: Pick<SkillCandidate, 'source' | 'slug'>, primaryPath: string): string {
  const reviewed = reviewedCatalogSkill(candidate);
  if (reviewed !== undefined) {
    if (!reviewed.primaryPaths.includes(primaryPath)) throw new SkillSourceError('skill_validation_failed');
    return reviewed.slug;
  }
  return primaryPath === 'SKILL.md' ? candidate.slug : canonicalSkillSlugFromPrimaryPath(primaryPath);
}

function assertManagedEntryIdentity(
  database: SqliteDatabase,
  entry: EntryRecord,
  mapping: Pick<StoredExternalSkillMapping, 'entry_revision' | 'imported_at'>,
  expected: ManagedRecordInput,
  requireCreatedAt = false,
): void {
  const revision = database.prepare(`
    SELECT created_by, created_at
      FROM entry_revisions
     WHERE entry_id = ? AND workspace = ? AND revision = ?
  `).get<{ created_by: string; created_at: string }>(entry.id, expected.workspace, mapping.entry_revision);
  const expectedHash = managedRecordContentHash(expected);
  if (entry.workspace !== expected.workspace
    || entry.kind !== 'reference' || entry.status !== 'candidate'
    || entry.trustLevel !== 'untrusted' || entry.confidence !== 0.7
    || entry.title !== expected.title || entry.body !== expected.body || entry.summary !== (expected.summary ?? null)
    || canonicalContentHash(entry.scope) !== canonicalContentHash(expected.scope)
    || canonicalContentHash(entry.provenance) !== canonicalContentHash(expected.provenance)
    || canonicalContentHash(entry.tags) !== canonicalContentHash(expected.tags)
    || entry.contentHash !== expectedHash || entry.revision !== mapping.entry_revision
    || entry.supersededBy !== null || entry.createdBy !== 'kiokuko-skill-discovery' || entry.verifiedAt !== null
    || entry.updatedAt !== mapping.imported_at || (requireCreatedAt && entry.createdAt !== mapping.imported_at)
    || revision?.created_by !== 'kiokuko-skill-discovery' || revision.created_at !== mapping.imported_at) {
    integrity('Managed external skill entry is invalid');
  }
}

function assertManagedEntryLifecycle(entry: EntryRecord, mapping: Pick<StoredExternalSkillMapping, 'entry_revision' | 'content_hash'>): void {
  if (entry.kind !== 'reference' || entry.status !== 'candidate' || entry.trustLevel !== 'untrusted'
    || entry.confidence !== 0.7 || entry.createdBy !== 'kiokuko-skill-discovery'
    || entry.verifiedAt !== null || entry.supersededBy !== null
    || entry.revision !== mapping.entry_revision || entry.contentHash !== mapping.content_hash) {
    integrity('Managed external skill entry is invalid');
  }
}

function assertManagedEntryParentIdentity(
  database: SqliteDatabase,
  skill: ExternalSkillRecord,
  candidate: SkillCandidate,
  entry: EntryRecord,
  mapping: StoredExternalSkillMapping,
): void {
  const provenance = entry.provenance as Record<string, unknown>;
  const fields = new Set([
    'type', 'reference', 'externalSkillId', 'requirementScopeHash', 'sourceRepositoryId',
    'sourceWorkspace', 'sourceCommit', 'sourcePath',
    'sourceChunkIndex', 'timestamp',
  ]);
  const sourceCommit = provenance.sourceCommit;
  const revision = database.prepare(`
    SELECT created_by, created_at
      FROM entry_revisions
     WHERE entry_id = ? AND workspace = ? AND revision = ?
  `).get<{ created_by: string; created_at: string }>(entry.id, skill.sourceWorkspace, mapping.entry_revision);
  if (Object.keys(provenance).length !== fields.size || Object.keys(provenance).some((field) => !fields.has(field))
    || provenance.type !== 'external_skill'
    || provenance.externalSkillId !== skill.skillId
    || provenance.requirementScopeHash === undefined || typeof provenance.requirementScopeHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(provenance.requirementScopeHash)
    || provenance.sourceRepositoryId !== `github:${skill.sourceLocator}`
    || provenance.sourceWorkspace !== skill.sourceWorkspace
    || typeof sourceCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)
    || provenance.sourcePath !== mapping.source_path
    || provenance.sourceChunkIndex !== mapping.chunk_index
    || provenance.reference !== sourceReference(candidate, sourceCommit, mapping.source_path)
    || provenance.timestamp !== mapping.imported_at
    || entry.updatedAt !== mapping.imported_at
    || revision?.created_by !== 'kiokuko-skill-discovery' || revision.created_at !== mapping.imported_at) {
    integrity('Managed external skill entry parent identity is invalid');
  }
}

function readMappedEntry(database: SqliteDatabase, workspace: string, entryId: string): EntryRecord {
  try {
    return readEntry(database, { workspace, entryId });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') integrity('Managed external skill entry is missing');
    throw error;
  }
}

function storedExternalSkillMappings(database: SqliteDatabase, skillId: string): StoredExternalSkillMapping[] {
  const mappings = database.prepare(`
    SELECT source_path, chunk_index, entry_id, entry_revision, content_hash,
           primary_document, active, imported_at
      FROM external_skill_entries
     WHERE skill_id = ?
     ORDER BY source_path, chunk_index
  `).all<Record<string, unknown>>(skillId);
  const entryIds = new Set<string>();
  return mappings.map((value) => {
    if (typeof value.source_path !== 'string' || value.source_path.length < 1 || value.source_path.length > 2_000
      || !/^[A-Za-z0-9_.\-/]+$/u.test(value.source_path) || value.source_path.startsWith('/')
      || value.source_path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || typeof value.chunk_index !== 'number' || !Number.isSafeInteger(value.chunk_index) || value.chunk_index < 0
      || typeof value.entry_id !== 'string' || value.entry_id.length < 1 || value.entry_id.length > 500 || /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u.test(value.entry_id)
      || typeof value.entry_revision !== 'number' || !Number.isSafeInteger(value.entry_revision) || value.entry_revision < 1
      || typeof value.content_hash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.content_hash)
      || typeof value.primary_document !== 'number' || ![0, 1].includes(value.primary_document)
      || typeof value.active !== 'number' || ![0, 1].includes(value.active)
      || typeof value.imported_at !== 'string' || !canonicalIsoTimestamp(value.imported_at)
      || entryIds.has(value.entry_id)) {
      integrity('External skill mapping is invalid');
    }
    entryIds.add(value.entry_id);
    return value as unknown as StoredExternalSkillMapping;
  });
}

function assertCurrentManagedSnapshot(database: SqliteDatabase, skill: ExternalSkillRecord, expectedDocuments?: PreparedSkillImport['documents']): void {
  if (skill.sourceCommit === null || skill.snapshotHash === null) integrity('External skill snapshot identity is invalid');
  const metadata = materializedSkillMetadata(skill.metadata);
  const candidate = candidateFromMaterializedSkill(skill, metadata);
  if (skill.sourceType !== 'github' || skill.sourceWorkspace !== externalSkillWorkspace(candidate)) integrity('External skill snapshot identity is invalid');
  if (!['imported', 'disabled', 'stale', 'blocked'].includes(skill.state)
    || (skill.state === 'imported' && skill.disabledAt !== null)
    || (skill.state === 'disabled' && skill.disabledAt === null)) {
    integrity('External skill lifecycle is invalid');
  }
  const mappings = storedExternalSkillMappings(database, skill.skillId);
  const mappingByKey = new Map(mappings.map((mapping) => [`${mapping.source_path}\u0000${mapping.chunk_index}`, mapping]));
  const currentKeys = new Set(metadata.currentMappings.map((mapping) => `${mapping.sourcePath}\u0000${mapping.chunkIndex}`));
  const current = metadata.currentMappings.map((mapping) => mappingByKey.get(`${mapping.sourcePath}\u0000${mapping.chunkIndex}`));
  if (current.some((mapping) => mapping === undefined)
    || current.filter((mapping) => mapping?.primary_document === 1).length !== 1
    || current.some((mapping) => mapping?.primary_document !== 0 && mapping?.primary_document !== 1)
    || mappings.some((mapping) => !currentKeys.has(`${mapping.source_path}\u0000${mapping.chunk_index}`) && mapping.active !== 0)) {
    integrity('External skill current mapping is invalid');
  }
  const entriesByMapping = new Map<string, EntryRecord>();
  for (const mapping of mappings) {
    const entry = readMappedEntry(database, skill.sourceWorkspace, mapping.entry_id);
    assertManagedEntryLifecycle(entry, mapping);
    assertManagedEntryParentIdentity(database, skill, candidate, entry, mapping);
    entriesByMapping.set(`${mapping.source_path}\u0000${mapping.chunk_index}`, entry);
  }
  const expectedActive = skill.state === 'imported' ? 1 : 0;
  if (current.some((mapping) => mapping?.active !== expectedActive)) integrity('External skill current mapping is invalid');
  const primaryMapping = current.find((mapping) => mapping?.primary_document === 1)!;
  try {
    if (canonicalStoredSkillSlug(candidate, primaryMapping.source_path) !== skill.slug) integrity('External skill current mapping is invalid');
  } catch (error) {
    if (error instanceof SkillSourceError || error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') integrity('External skill current mapping is invalid');
    throw error;
  }

  if (expectedDocuments !== undefined) {
    const expectedByKey = new Map(expectedDocuments.map((document) => [`${document.sourcePath}\u0000${document.chunkIndex}`, document]));
    if (expectedByKey.size !== currentKeys.size || [...currentKeys].some((key) => !expectedByKey.has(key))) integrity('External skill current mapping is invalid');
    for (const mapping of current) {
      const document = expectedByKey.get(`${mapping!.source_path}\u0000${mapping!.chunk_index}`)!;
      if (mapping!.primary_document !== (document.primary ? 1 : 0)) integrity('External skill current mapping is invalid');
    }
  }

  const requirement = requirementFromMaterializedSkill(skill, metadata);
  const seenEntries = new Set<string>();
  for (const mapping of current as StoredExternalSkillMapping[]) {
    if (typeof mapping.source_path !== 'string' || typeof mapping.entry_id !== 'string' || typeof mapping.imported_at !== 'string'
      || !Number.isSafeInteger(mapping.chunk_index) || mapping.chunk_index < 0
      || !Number.isSafeInteger(mapping.entry_revision) || mapping.entry_revision < 1
      || !/^[0-9a-f]{64}$/u.test(mapping.content_hash)
      || seenEntries.has(mapping.entry_id)) {
      integrity('External skill current mapping is invalid');
    }
    seenEntries.add(mapping.entry_id);
    const entry = entriesByMapping.get(`${mapping.source_path}\u0000${mapping.chunk_index}`)!;
    const documentHash = canonicalContentHash({ title: entry.title, body: entry.body, sourcePath: mapping.source_path });
    const expectedDocument = expectedDocuments?.find((document) => document.sourcePath === mapping.source_path && document.chunkIndex === mapping.chunk_index);
    if (mapping.content_hash !== entry.contentHash
      || entry.summary !== metadata.frontmatter.description
      || expectedDocument !== undefined && (expectedDocument.contentHash !== documentHash
        || expectedDocument.title !== entry.title || expectedDocument.body !== entry.body
        || expectedDocument.summary !== entry.summary)) {
      integrity('External skill current mapping is invalid');
    }
    const expected = inputForDocument({
      skill: candidate,
      sourceWorkspace: skill.sourceWorkspace,
      sourceCommit: skill.sourceCommit,
      snapshotHash: skill.snapshotHash,
      frontmatter: metadata.frontmatter,
      documents: [],
      requirement,
    }, {
      sourcePath: mapping.source_path,
      chunkIndex: mapping.chunk_index,
      title: entry.title,
      body: entry.body,
      summary: entry.summary,
      contentHash: documentHash,
      primary: mapping.primary_document === 1,
    }, mapping.imported_at);
    assertManagedEntryIdentity(database, entry, mapping, expected);
  }
}

function validatePreparedDocuments(documents: PreparedSkillImport['documents']): void {
  if (documents.length < 1 || documents.length > 64 || documents.filter((document) => document.primary).length !== 1) throw new KiokukoError('VALIDATION_ERROR', 'External skill documents are invalid');
  const primaryPath = documents.find((document) => document.primary)!.sourcePath;
  if (primaryPath !== 'SKILL.md' && !primaryPath.endsWith('/SKILL.md')) throw new KiokukoError('VALIDATION_ERROR', 'External skill documents are invalid');
  const root = primaryPath === 'SKILL.md' ? '' : primaryPath.slice(0, -'/SKILL.md'.length);
  const mappings = new Set<string>();
  for (const document of documents) {
    const allowedPath = document.sourcePath === primaryPath
      || document.sourcePath.startsWith(root === '' ? 'references/' : `${root}/references/`) && /\.(?:md|txt)$/u.test(document.sourcePath)
      || document.sourcePath.startsWith(root === '' ? 'docs/' : `${root}/docs/`) && /\.md$/u.test(document.sourcePath);
    if (!Number.isSafeInteger(document.chunkIndex) || document.chunkIndex < 0
      || document.sourcePath.length < 1 || document.sourcePath.length > 2_000 || !/^[A-Za-z0-9_.\-/]+$/u.test(document.sourcePath) || document.sourcePath.startsWith('/') || document.sourcePath.split('/').some((part) => part === '' || part === '.' || part === '..')
      || !allowedPath
      || !/^[0-9a-f]{64}$/u.test(document.contentHash)
      || document.contentHash !== canonicalContentHash({ title: document.title, body: document.body, sourcePath: document.sourcePath })) throw new KiokukoError('VALIDATION_ERROR', 'External skill documents are invalid');
    const key = `${document.sourcePath}\u0000${document.chunkIndex}`;
    if (mappings.has(key)) throw new KiokukoError('VALIDATION_ERROR', 'External skill document mapping is duplicated');
    mappings.add(key);
  }
}

function validatePreparedSkillIdentity(input: PreparedSkillImport): void {
  if (input.sourceWorkspace !== externalSkillWorkspace(input.skill)) throw new KiokukoError('VALIDATION_ERROR', 'External skill import identity is invalid');
  const primary = input.documents.find((document) => document.primary);
  if (primary === undefined) throw new KiokukoError('VALIDATION_ERROR', 'External skill import identity is invalid');
  let slug: string;
  try { slug = canonicalStoredSkillSlug(input.skill, primary.sourcePath); }
  catch (error) {
    if (error instanceof SkillSourceError) throw new KiokukoError('VALIDATION_ERROR', 'External skill import identity is invalid');
    throw error;
  }
  if (input.skill.slug !== slug || input.skill.id !== `${input.skill.provider}:${input.skill.source}:${slug}`) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill import identity is invalid');
  }
}

function persistSkillImportInTransaction(database: SqliteDatabase, input: PreparedSkillImport, now = new Date().toISOString()): SkillImportResult {
  validatePreparedSkillIdentity(input);
  validatePreparedFrontmatter(input);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.sourceCommit)
    || !/^[0-9a-f]{64}$/u.test(input.snapshotHash)) throw new KiokukoError('VALIDATION_ERROR', 'External skill import identity is invalid');
  validatePreparedDocuments(input.documents);
  const previous = row(database, candidateId(input.skill));
  const skillId = upsertCandidate(database, input.skill, now); const current = row(database, skillId);
  if (!current) throw new KiokukoError('INTEGRITY_ERROR', 'External skill row disappeared during import');
  // disabled_at is the durable user intent. A failed refresh records stale/blocked
  // in state, but must not allow the next successful refresh to re-enable the skill.
  const preserveDisabled = current.disabledAt !== null;
  const storedMappingCount = Number(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ?').get<{ count: number }>(skillId)?.count ?? 0);
  if (current.sourceCommit === null && storedMappingCount !== 0) integrity('Unmaterialized external skill has stored mappings');
  const storedRequirement = current.sourceCommit === null
    ? undefined
    : requirementFromMaterializedSkill(current, materializedSkillMetadata(current.metadata));
  const requirementInput = input.requirement ?? storedRequirement ?? requirementForOfficialSkill(input.skill);
  if (requirementInput === undefined) throw new KiokukoError('VALIDATION_ERROR', 'External skill applicability is required');
  const requestedRequirement = normalizedSkillRequirement(requirementInput);
  const effectiveRequirement = storedRequirement === undefined ? requestedRequirement
    : mergeSkillRequirements(storedRequirement, requestedRequirement);
  const storedRequirementIdentities = storedRequirement === undefined ? [] : requirementAliasesMetadata(current.metadata.requirementAliases);
  const effectiveRequirementIdentities = [...new Set([
    ...storedRequirementIdentities,
    effectiveRequirement.id,
    effectiveRequirement.technology,
    ...effectiveRequirement.aliases,
  ])].sort(compareCanonicalStrings);
  const effectiveInput: PreparedSkillImport = { ...input, requirement: effectiveRequirement };
  const exactReplay = current.snapshotHash === input.snapshotHash && current.state === 'imported'
    && requirementScopeIdentity(storedRequirement, storedRequirementIdentities) === requirementScopeIdentity(effectiveRequirement, effectiveRequirementIdentities);
  if (previous !== undefined && previous.sourceCommit !== null) {
    assertCurrentManagedSnapshot(database, previous, exactReplay ? input.documents : undefined);
  }
  if (exactReplay) {
    const entries = database.prepare('SELECT entry_id FROM external_skill_entries WHERE skill_id = ? AND active = 1 ORDER BY source_path, chunk_index').all<{ entry_id: string }>(skillId).map(({ entry_id }) => readMappedEntry(database, input.sourceWorkspace, entry_id));
    return { skillId, imported: 0, updated: false, snapshotHash: input.snapshotHash, sourceWorkspace: input.sourceWorkspace, entries };
  }
  const currentMappingKeys = current.sourceCommit === null
    ? new Set<string>()
    : new Set(materializedSkillMetadata(current.metadata).currentMappings.map((mapping) => `${mapping.sourcePath}\u0000${mapping.chunkIndex}`));
  const previousMappings = new Map(database.prepare(`
    SELECT source_path, chunk_index, entry_id, entry_revision, content_hash,
           primary_document, active, imported_at
      FROM external_skill_entries
     WHERE skill_id = ?
  `).all<StoredExternalSkillMapping>(skillId).map((mapping) => [`${mapping.source_path}\u0000${mapping.chunk_index}`, mapping]));
  database.prepare('UPDATE external_skill_entries SET active = 0 WHERE skill_id = ?').run(skillId);
  const entries: EntryRecord[] = [];
  for (const document of input.documents) {
    const key = `${document.sourcePath}\u0000${document.chunkIndex}`;
    const recordInput = inputForDocument(effectiveInput, document, now);
    const previous = previousMappings.get(key);
    let entry: EntryRecord;
    let mappingImportedAt = now;
    if (previous !== undefined) {
      const existingEntry = readMappedEntry(database, input.sourceWorkspace, previous.entry_id);
      assertManagedEntryLifecycle(existingEntry, previous);
      const reusableInput = inputForDocument(effectiveInput, document, previous.imported_at);
      if (currentMappingKeys.has(key) && previous.content_hash === managedRecordContentHash(reusableInput)) {
        assertManagedEntryIdentity(database, existingEntry, previous, reusableInput);
        entry = existingEntry;
        mappingImportedAt = previous.imported_at;
      } else {
        entry = updateManagedExternalEntryInTransaction(database, {
          workspace: input.sourceWorkspace,
          entryId: previous.entry_id,
          expectedRevision: previous.entry_revision,
          kind: recordInput.kind,
          title: recordInput.title,
          body: recordInput.body,
          summary: recordInput.summary,
          scope: recordInput.scope,
          provenance: recordInput.provenance,
          tags: recordInput.tags,
          createdBy: 'kiokuko-skill-discovery',
          actor: 'kiokuko-skill-discovery',
          now,
        });
        assertManagedEntryIdentity(database, entry, { entry_revision: entry.revision, imported_at: now }, recordInput);
      }
    } else {
      entry = recordEntryInTransaction(database, recordInput, { now });
      assertManagedEntryIdentity(database, entry, { entry_revision: entry.revision, imported_at: now }, recordInput, true);
    }
    const active = preserveDisabled ? 0 : 1;
    database.prepare(`INSERT INTO external_skill_entries (skill_id, source_path, chunk_index, entry_id, entry_revision, content_hash, primary_document, active, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(skill_id, source_path, chunk_index) DO UPDATE SET entry_id = excluded.entry_id, entry_revision = excluded.entry_revision, content_hash = excluded.content_hash, primary_document = excluded.primary_document, active = excluded.active, imported_at = excluded.imported_at`).run(skillId, document.sourcePath, document.chunkIndex, entry.id, entry.revision, entry.contentHash, document.primary ? 1 : 0, active, mappingImportedAt);
    entries.push(entry);
  }
  const metadata = {
    documents: input.documents.length,
    frontmatter: input.frontmatter,
    currentMappings: input.documents.map((document) => ({ sourcePath: document.sourcePath, chunkIndex: document.chunkIndex })),
    technology: effectiveRequirement.technology,
    requirementAliases: effectiveRequirementIdentities,
    auditStatus: input.skill.auditStatus ?? current.auditStatus,
    officialStatus: input.skill.officialStatus,
    applicability: effectiveRequirement.applicability,
    signals: effectiveRequirement.signals,
  };
  const generation = allocateExternalSkillGeneration(database);
  database.prepare(`
    UPDATE external_skills
       SET generation = ?,
           provider = ?,
           source_type = ?,
           source_locator = ?,
           slug = ?,
           name = ?,
           install_url = ?,
           official_status = ?,
           duplicate = ?,
           installs = ?,
           state = ?,
           source_commit = ?,
           snapshot_hash = ?,
           source_workspace = ?,
           last_checked_at = ?,
           metadata_json = ?
     WHERE skill_id = ?
  `).run(
    generation,
    input.skill.provider,
    input.skill.sourceType,
    input.skill.source,
    input.skill.slug,
    input.skill.name,
    input.skill.installUrl,
    input.skill.officialStatus,
    input.skill.duplicate ? 1 : 0,
    input.skill.installs,
    preserveDisabled ? 'disabled' : 'imported',
    input.sourceCommit,
    input.snapshotHash,
    input.sourceWorkspace,
    now,
    canonicalJson(metadata),
    skillId,
  );
  pruneExternalSkillGenerationTokens(database);
  const stored = row(database, skillId);
  if (stored === undefined) integrity('External skill row disappeared during import');
  assertCurrentManagedSnapshot(database, stored, input.documents);
  return { skillId, imported: entries.length, updated: current?.snapshotHash !== null && current?.snapshotHash !== input.snapshotHash, snapshotHash: input.snapshotHash, sourceWorkspace: input.sourceWorkspace, entries };
}

/** Create a materialized skill only when its canonical identity is absent under the write lock. */
export function persistNewSkillImportInTransaction(database: SqliteDatabase, input: PreparedSkillImport, now = new Date().toISOString(), authorization?: SkillMaterializationAuthorization): SkillImportResult {
  validatePreparedSkillIdentity(input);
  const expectedSkillId = candidateId(input.skill);
  const identityOwner = database.prepare(`
    SELECT skill_id
      FROM external_skills
     WHERE source_type = ? AND source_locator = ? AND slug = ?
  `).get<{ skill_id: string }>(input.skill.sourceType, input.skill.source, input.skill.slug);
  if (row(database, expectedSkillId) !== undefined || identityOwner !== undefined) {
    if (identityOwner !== undefined && identityOwner.skill_id !== expectedSkillId) {
      // A valid row's key is derived from this tuple. Surface corruption rather
      // than disguising it as an ordinary create-only conflict.
      row(database, identityOwner.skill_id);
      integrity('External skill identity owner is invalid');
    }
    throw new KiokukoError('CONFLICT', 'External skill already exists; use refresh');
  }
  return persistSkillImportInTransaction(database, authorizedPreparedSkillImport(input, authorization), now);
}

export function persistSkillImport(database: SqliteDatabase, input: PreparedSkillImport, now?: string, authorization?: SkillMaterializationAuthorization): SkillImportResult {
  return withImmediateTransaction(database, () => persistNewSkillImportInTransaction(database, input, now, authorization));
}

/** Persist already-validated prepared documents only through an explicit materialized-row CAS. */
export function persistPreparedSkillRefresh(database: SqliteDatabase, input: PreparedSkillImport, expected: ExternalSkillRefreshExpectation, now = new Date().toISOString(), authorization?: SkillMaterializationAuthorization): SkillImportResult {
  return withImmediateTransaction(database, () => {
    validatePreparedSkillIdentity(input);
    const current = row(database, candidateId(input.skill));
    if (current === undefined || current.sourceCommit === null || current.snapshotHash === null
      || current.generation !== expected.generation || current.sourceCommit !== expected.sourceCommit
      || current.snapshotHash !== expected.snapshotHash || current.state !== expected.state
      || current.lastCheckedAt !== expected.lastCheckedAt) {
      throw new KiokukoError('CONFLICT', 'External skill snapshot changed during refresh');
    }
    return persistSkillImportInTransaction(database, authorizedPreparedSkillImport(input, authorization), now);
  });
}

/** Import through an existing unmaterialized discovery identity with a generation check. */
export function persistExistingSkillImportInTransaction(database: SqliteDatabase, skillId: string, input: PreparedSkillImport, expected: ExternalSkillRefreshExpectation, now = new Date().toISOString(), canonicalTarget?: { skillId: string; expected: ExternalSkillRefreshExpectation }, authorization?: SkillMaterializationAuthorization): SkillImportResult {
  validatePreparedSkillIdentity(input);
  const current = row(database, skillId);
  if (!current) throw new KiokukoError('NOT_FOUND', 'External skill not found');
  if (current.generation !== expected.generation || current.sourceCommit !== expected.sourceCommit || current.snapshotHash !== expected.snapshotHash
    || current.state !== expected.state || current.lastCheckedAt !== expected.lastCheckedAt) {
    throw new KiokukoError('CONFLICT', 'External skill snapshot changed during discovery');
  }
  const mappingCount = database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ?').get<{ count: number }>(skillId)?.count ?? 0;
  if (current.sourceCommit !== null || current.snapshotHash !== null || Number(mappingCount) !== 0) throw new KiokukoError('CONFLICT', 'Verified external skills must use refresh');
  if (current.disabledAt !== null || current.state === 'blocked' || !['discovered', 'stale'].includes(current.state)) throw new KiokukoError('CONFLICT', 'External skill alias has protected state');
  if (!sameSkillSource(current, input.skill)) throw new KiokukoError('CONFLICT', 'External skill source identity changed during discovery');
  const authorizedInput = authorizedPreparedSkillImport(input, authorization);
  const canonicalId = candidateId(input.skill);
  if (canonicalId !== skillId) {
    const canonical = row(database, canonicalId);
    if (canonical !== undefined) {
      if (canonicalTarget === undefined || canonicalTarget.skillId !== canonicalId
        || canonical.generation !== canonicalTarget.expected.generation
        || canonical.sourceCommit !== canonicalTarget.expected.sourceCommit || canonical.snapshotHash !== canonicalTarget.expected.snapshotHash
        || canonical.state !== canonicalTarget.expected.state || canonical.lastCheckedAt !== canonicalTarget.expected.lastCheckedAt) {
        throw new KiokukoError('CONFLICT', 'External skill canonical identity is ambiguous');
      }
      if (canonical.disabledAt !== null || canonical.state === 'disabled' || canonical.state === 'blocked') throw new KiokukoError('CONFLICT', 'External skill canonical identity has protected state');
      const currentPrimary = database.prepare('SELECT source_path FROM external_skill_entries WHERE skill_id = ? AND primary_document = 1 ORDER BY source_path LIMIT 1').get<{ source_path: string }>(canonicalId)?.source_path;
      const incomingPrimary = input.documents.find((document) => document.primary)?.sourcePath;
      if (currentPrimary !== undefined && currentPrimary !== incomingPrimary) throw new KiokukoError('CONFLICT', 'External skill canonical primary path changed');
      allocateExternalSkillGeneration(database);
      database.prepare('DELETE FROM external_skills WHERE skill_id = ?').run(skillId);
      pruneExternalSkillGenerationTokens(database);
    } else {
      if (canonicalTarget !== undefined) throw new KiokukoError('CONFLICT', 'External skill canonical identity changed during discovery');
      const generation = allocateExternalSkillGeneration(database);
      database.prepare('UPDATE external_skills SET generation = ?, skill_id = ?, provider = ?, slug = ?, source_workspace = ? WHERE skill_id = ?')
        .run(generation, canonicalId, input.skill.provider, input.skill.slug, externalSkillWorkspace(input.skill), skillId);
      pruneExternalSkillGenerationTokens(database);
    }
  }
  return persistSkillImportInTransaction(database, authorizedInput, now);
}

export function persistExistingSkillImport(database: SqliteDatabase, skillId: string, input: PreparedSkillImport, expected: ExternalSkillRefreshExpectation, now = new Date().toISOString(), canonicalTarget?: { skillId: string; expected: ExternalSkillRefreshExpectation }, authorization?: SkillMaterializationAuthorization): SkillImportResult {
  return withImmediateTransaction(database, () => persistExistingSkillImportInTransaction(database, skillId, input, expected, now, canonicalTarget, authorization));
}

export function recordDiscoveredSkillInTransaction(database: SqliteDatabase, candidate: SkillCandidate, now = new Date().toISOString()): ExternalSkillRecord { const id = upsertCandidate(database, candidate, now); const result = row(database, id); if (!result) throw new KiokukoError('INTEGRITY_ERROR', 'External skill row disappeared during discovery'); return result; }
export function recordDiscoveredSkill(database: SqliteDatabase, candidate: SkillCandidate, now?: string): ExternalSkillRecord { const at = now ?? new Date().toISOString(); return withImmediateTransaction(database, () => recordDiscoveredSkillInTransaction(database, candidate, at)); }
const EXTERNAL_SKILL_STATES = new Set<ExternalSkillState>(['discovered', 'imported', 'blocked', 'stale', 'disabled']);
const MAX_EXTERNAL_SKILL_LIST_SIZE = 1_000;
const MAX_EXTERNAL_SKILL_PAGE_SIZE = 200;

function externalSkillListState(value: string | undefined): ExternalSkillState | undefined {
  if (value === undefined) return undefined;
  if (!EXTERNAL_SKILL_STATES.has(value as ExternalSkillState)) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill list state is invalid');
  }
  return value as ExternalSkillState;
}

function validateExternalSkillListAnchor(anchor: ExternalSkillListAnchor): void {
  let canonicalSource: string;
  try { canonicalSource = parseGitHubSource(anchor.sourceLocator).source; }
  catch (error) {
    if (error instanceof SkillSourceError) throw new KiokukoError('VALIDATION_ERROR', 'External skill list anchor is invalid');
    throw error;
  }
  if (canonicalSource !== anchor.sourceLocator
    || !/^[A-Za-z0-9_.\-/]{1,240}$/u.test(anchor.slug)
    || anchor.slug.split('/').some((part) => part === '' || part === '.' || part === '..')
    || !/^[A-Za-z0-9_.-]{1,50}$/u.test(anchor.provider)
    || typeof anchor.skillId !== 'string' || anchor.skillId.length < 1 || anchor.skillId.length > 2_000
    || /[\p{Cc}\p{Cf}]/u.test(anchor.skillId)) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill list anchor is invalid');
  }
}

function withExternalSkillReadTransaction<T>(database: SqliteDatabase, operation: () => T): T {
  database.exec('BEGIN DEFERRED');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    rollbackFailedTransaction(database, error);
  }
}

/**
 * Read one strict, keyset-ordered page bound to the durable external-skill mutation token.
 * Continuations must provide both the prior version and the last row's anchor.
 */
export function listExternalSkillsPage(database: SqliteDatabase, input: {
  state?: string;
  limit: number;
  after?: ExternalSkillListAnchor;
  expectedVersion?: number;
}): ExternalSkillListPage {
  const state = externalSkillListState(input.state);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_EXTERNAL_SKILL_PAGE_SIZE
    || (input.after === undefined) !== (input.expectedVersion === undefined)
    || input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= Number.MAX_SAFE_INTEGER)) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill list page is invalid');
  }
  if (input.after !== undefined) validateExternalSkillListAnchor(input.after);
  return withExternalSkillReadTransaction(database, () => {
    const version = assertExternalSkillGenerationClock(database);
    if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
      throw new KiokukoError('CONFLICT', 'External skill list changed; restart pagination');
    }
    if (input.after !== undefined) {
      const anchorValue = database.prepare('SELECT * FROM external_skills WHERE skill_id = ?')
        .get<Record<string, unknown>>(input.after.skillId);
      if (anchorValue === undefined) throw new KiokukoError('CONFLICT', 'External skill list anchor is missing; restart pagination');
      const anchor = decodeExternalSkillRow(anchorValue);
      if (anchor.sourceLocator !== input.after.sourceLocator || anchor.slug !== input.after.slug || anchor.provider !== input.after.provider
        || state !== undefined && anchor.state !== state) {
        throw new KiokukoError('CONFLICT', 'External skill list anchor does not match this snapshot and filter');
      }
    }
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (state !== undefined) { clauses.push('state = ?'); parameters.push(state); }
    if (input.after !== undefined) {
      clauses.push('(source_locator, slug, provider, skill_id) > (?, ?, ?, ?)');
      parameters.push(input.after.sourceLocator, input.after.slug, input.after.provider, input.after.skillId);
    }
    const statement = `SELECT * FROM external_skills${clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`} ORDER BY source_locator, slug, provider, skill_id LIMIT ?`;
    parameters.push(input.limit + 1);
    const decoded = database.prepare(statement).all<Record<string, unknown>>(...parameters).map(decodeExternalSkillRow);
    if (assertExternalSkillGenerationClock(database) !== version) {
      throw new KiokukoError('CONFLICT', 'External skill list changed; restart pagination');
    }
    return { skills: decoded.slice(0, input.limit), version, truncated: decoded.length > input.limit };
  });
}

/** Strict management list with a hard 1,000-row safety bound. */
export function listExternalSkills(database: SqliteDatabase, options: { state?: string; limit?: number } = {}): ExternalSkillRecord[] {
  const state = externalSkillListState(options.state);
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_EXTERNAL_SKILL_LIST_SIZE)) {
    throw new KiokukoError('VALIDATION_ERROR', 'External skill list limit is invalid');
  }
  const version = assertExternalSkillGenerationClock(database);
  const requested = options.limit ?? MAX_EXTERNAL_SKILL_LIST_SIZE;
  const parameters: Array<string | number> = [];
  let statement = 'SELECT * FROM external_skills';
  if (state !== undefined) { statement += ' WHERE state = ?'; parameters.push(state); }
  statement += ' ORDER BY source_locator, slug, provider, skill_id LIMIT ?';
  parameters.push(requested + (options.limit === undefined ? 1 : 0));
  const values = database.prepare(statement).all<Record<string, unknown>>(...parameters).map(decodeExternalSkillRow);
  if (assertExternalSkillGenerationClock(database) !== version) {
    throw new KiokukoError('CONFLICT', 'External skill list changed during read');
  }
  if (options.limit === undefined && values.length > MAX_EXTERNAL_SKILL_LIST_SIZE) {
    throw new KiokukoError('BACKPRESSURE', 'External skill list exceeds the 1,000-row management bound');
  }
  return values;
}
export function readExternalSkill(database: SqliteDatabase, skillId: string): ExternalSkillDetail | undefined {
  const version = assertExternalSkillGenerationClock(database);
  const skill = row(database, skillId);
  if (!skill) {
    if (assertExternalSkillGenerationClock(database) !== version) throw new KiokukoError('CONFLICT', 'External skill changed during read');
    return undefined;
  }
  const entries = storedExternalSkillMappings(database, skillId).map((entry) => ({ entryId: entry.entry_id, revision: entry.entry_revision, sourcePath: entry.source_path, chunkIndex: entry.chunk_index, primary: entry.primary_document === 1, active: entry.active === 1 }));
  if (skill.sourceCommit === null) {
    if (entries.length !== 0) integrity('Unmaterialized external skill has stored mappings');
  } else {
    assertCurrentManagedSnapshot(database, skill);
  }
  if (assertExternalSkillGenerationClock(database) !== version) {
    throw new KiokukoError('CONFLICT', 'External skill changed during read');
  }
  return { skill, entries };
}
function activateCurrentMappings(database: SqliteDatabase, skill: ExternalSkillRecord): void {
  assertCurrentManagedSnapshot(database, skill);
  database.prepare('UPDATE external_skill_entries SET active = 0 WHERE skill_id = ?').run(skill.skillId);
  for (const mapping of materializedSkillMetadata(skill.metadata).currentMappings) {
    database.prepare('UPDATE external_skill_entries SET active = 1 WHERE skill_id = ? AND source_path = ? AND chunk_index = ?').run(skill.skillId, mapping.sourcePath, mapping.chunkIndex);
    const changed = database.prepare('SELECT changes() AS count').get<{ count: number }>();
    if (Number(changed?.count ?? 0) !== 1) throw new KiokukoError('INTEGRITY_ERROR', 'External skill current mapping is missing');
  }
}

export function setExternalSkillState(database: SqliteDatabase, skillId: string, state: 'disabled' | 'imported', now = new Date().toISOString()): ExternalSkillRecord {
  return withImmediateTransaction(database, () => {
    const current = row(database, skillId);
    if (!current) throw new KiokukoError('NOT_FOUND', 'External skill not found');
    if (state === 'imported' && (current.state !== 'disabled' || current.sourceCommit === null || current.snapshotHash === null)) throw new KiokukoError('CONFLICT', 'Only a disabled skill with a verified snapshot can be enabled');
    if (state === 'disabled' && current.state !== 'imported') throw new KiokukoError('CONFLICT', 'Only an imported skill can be disabled');
    if (state === 'disabled') database.prepare('UPDATE external_skill_entries SET active = 0 WHERE skill_id = ?').run(skillId);
    else activateCurrentMappings(database, current);
    const generation = allocateExternalSkillGeneration(database);
    database.prepare('UPDATE external_skills SET generation = ?, state = ?, disabled_at = ? WHERE skill_id = ?').run(generation, state, state === 'disabled' ? now : null, skillId);
    pruneExternalSkillGenerationTokens(database);
    const result = row(database, skillId);
    if (!result) throw new KiokukoError('INTEGRITY_ERROR', 'External skill row disappeared during update');
    assertCurrentManagedSnapshot(database, result);
    return result;
  });
}
export function markExternalSkillRefreshFailureInTransaction(database: SqliteDatabase, skillId: string, state: 'stale' | 'blocked', expected: ExternalSkillRefreshExpectation, now = new Date().toISOString()): ExternalSkillRecord {
  const current = row(database, skillId);
  if (!current) throw new KiokukoError('NOT_FOUND', 'External skill not found');
  if (current.generation !== expected.generation || current.sourceCommit !== expected.sourceCommit || current.snapshotHash !== expected.snapshotHash
    || current.state !== expected.state || current.lastCheckedAt !== expected.lastCheckedAt) {
    throw new KiokukoError('CONFLICT', 'External skill snapshot changed during refresh');
  }
  if (current.state === 'blocked' && state === 'stale') throw new KiokukoError('CONFLICT', 'A blocked external skill cannot be downgraded to stale');
  if (current.sourceCommit === null) {
    const mappingCount = database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ?').get<{ count: number }>(skillId)?.count;
    if (mappingCount !== 0) integrity('Unmaterialized external skill has stored mappings');
  } else {
    assertCurrentManagedSnapshot(database, current);
  }
  const generation = allocateExternalSkillGeneration(database);
  database.prepare('UPDATE external_skills SET generation = ?, state = ?, last_checked_at = ? WHERE skill_id = ?').run(generation, state, now, skillId);
  database.prepare('UPDATE external_skill_entries SET active = 0 WHERE skill_id = ?').run(skillId);
  pruneExternalSkillGenerationTokens(database);
  const result = row(database, skillId);
  if (!result) throw new KiokukoError('INTEGRITY_ERROR', 'External skill row disappeared during update');
  if (result.sourceCommit === null) {
    const mappingCount = database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ?').get<{ count: number }>(skillId)?.count;
    if (mappingCount !== 0) integrity('Unmaterialized external skill has stored mappings');
  } else {
    assertCurrentManagedSnapshot(database, result);
  }
  return result;
}

export function markExternalSkillRefreshFailure(database: SqliteDatabase, skillId: string, state: 'stale' | 'blocked', expected: ExternalSkillRefreshExpectation, now = new Date().toISOString()): ExternalSkillRecord {
  return withImmediateTransaction(database, () => markExternalSkillRefreshFailureInTransaction(database, skillId, state, expected, now));
}
export function isExternalSkillReference(entry: { createdBy: string; provenance: JsonObject }): boolean {
  const provenanceType = (entry.provenance as Record<string, unknown>).type;
  return entry.createdBy === 'kiokuko-skill-discovery'
    || entry.createdBy === 'kiokuko-source-sync'
    || provenanceType === 'external_skill'
    || provenanceType === 'source_sync';
}

function verifiedSnapshotDocuments(snapshot: SkillSnapshot, documents: PreparedSkillImport['documents']): { snapshot: SkillSnapshot; documents: PreparedSkillImport['documents'] } {
  const verifiedSnapshot = revalidateSkillSnapshot(snapshot);
  const verifiedDocuments = documentsFromSkillSnapshot(verifiedSnapshot);
  if (canonicalContentHash(documents) !== canonicalContentHash(verifiedDocuments)) throw new KiokukoError('VALIDATION_ERROR', 'External skill documents do not match the verified snapshot');
  return { snapshot: verifiedSnapshot, documents: verifiedDocuments };
}

export function importSkillSnapshot(database: SqliteDatabase, snapshot: SkillSnapshot, documents: PreparedSkillImport['documents'], requirement?: PreparedSkillImport['requirement'], now?: string, authorization?: SkillMaterializationAuthorization): SkillImportResult {
  const verified = verifiedSnapshotDocuments(snapshot, documents);
  return persistSkillImport(database, { skill: verified.snapshot.candidate, sourceWorkspace: externalSkillWorkspace(verified.snapshot.candidate), sourceCommit: verified.snapshot.sourceCommit, snapshotHash: verified.snapshot.snapshotHash, frontmatter: verified.snapshot.frontmatter, documents: verified.documents, ...(requirement ? { requirement } : {}) }, now, authorization);
}

/** Refresh inside an existing write transaction and report every committed lifecycle transition. */
export function refreshExternalSkillSnapshotInTransaction(database: SqliteDatabase, skillId: string, snapshot: SkillSnapshot, documents: PreparedSkillImport['documents'], requirement: PreparedSkillImport['requirement'] | undefined, expected: ExternalSkillRefreshExpectation, now = new Date().toISOString(), authorization?: SkillMaterializationAuthorization): ExternalSkillRefreshResult {
  const verified = verifiedSnapshotDocuments(snapshot, documents);
  snapshot = verified.snapshot;
  documents = verified.documents;
  const detail = readExternalSkill(database, skillId);
  if (!detail) throw new KiokukoError('NOT_FOUND', 'External skill not found');
  if (detail.skill.generation !== expected.generation || detail.skill.sourceCommit !== expected.sourceCommit || detail.skill.snapshotHash !== expected.snapshotHash
    || detail.skill.state !== expected.state || detail.skill.lastCheckedAt !== expected.lastCheckedAt) {
    throw new KiokukoError('CONFLICT', 'External skill snapshot changed during refresh');
  }
  const unmaterialized = detail.skill.sourceCommit === null;
  if (unmaterialized) {
    if (!['discovered', 'stale'].includes(detail.skill.state)) {
      throw new KiokukoError('CONFLICT', 'Only discovered or stale unmaterialized skills can be refreshed');
    }
    if (detail.entries.length !== 0) integrity('Unmaterialized external skill has stored mappings');
  } else {
    assertCurrentManagedSnapshot(database, detail.skill);
  }
  const primary = documents.find((document) => document.primary);
  const expectedPrimary = unmaterialized ? undefined : detail.entries.find((entry) => entry.primary);
  const identityChanged = snapshot.candidate.sourceType !== detail.skill.sourceType
    || snapshot.candidate.source !== detail.skill.sourceLocator
    || snapshot.candidate.slug !== detail.skill.slug
    || (expectedPrimary !== undefined && primary?.sourcePath !== expectedPrimary.sourcePath);
  if (identityChanged) {
    const generation = allocateExternalSkillGeneration(database);
    database.prepare("UPDATE external_skills SET generation = ?, state = 'stale', last_checked_at = ? WHERE skill_id = ?").run(generation, now, skillId);
    database.prepare('UPDATE external_skill_entries SET active = 0 WHERE skill_id = ?').run(skillId);
    pruneExternalSkillGenerationTokens(database);
    const staled = row(database, skillId);
    if (staled === undefined) integrity('External skill row disappeared during refresh');
    return { kind: 'staled', skill: staled };
  }
  const authorizedCandidate = claimSkillMaterializationAuthorization(snapshot.candidate, authorization);
  const result = persistSkillImportInTransaction(database, {
    skill: authorizedCandidate,
    sourceWorkspace: externalSkillWorkspace(snapshot.candidate),
    sourceCommit: snapshot.sourceCommit,
    snapshotHash: snapshot.snapshotHash,
    frontmatter: snapshot.frontmatter,
    documents,
    ...(requirement === undefined ? {} : { requirement }),
  }, now);
  return { kind: 'refreshed', result };
}

/** Refresh an existing managed skill without allowing stale fetches or moved sources to replace its current snapshot. */
export function refreshExternalSkillSnapshot(database: SqliteDatabase, skillId: string, snapshot: SkillSnapshot, documents: PreparedSkillImport['documents'], requirement: PreparedSkillImport['requirement'] | undefined, expected: ExternalSkillRefreshExpectation, now = new Date().toISOString(), authorization?: SkillMaterializationAuthorization): ExternalSkillRefreshResult {
  return withImmediateTransaction(database, () => refreshExternalSkillSnapshotInTransaction(database, skillId, snapshot, documents, requirement, expected, now, authorization));
}
