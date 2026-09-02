import { findSecret } from '../../memory/secrets.js';
import { canonicalContentHash } from '../../serialization/validate.js';
import { OFFICIAL_SKILL_REPOSITORIES, reviewedCatalogSkill } from '../official-catalog.js';
import { SkillSourceError } from '../source/errors.js';
import { parseGitHubSource } from '../source/snapshot-validator.js';
import type { SkillAuditResult, SkillCandidate, SkillProviderFailureCode } from '../types.js';
import { MAX_SEARCH_RESULTS } from '../query-builder.js';
import { parseStrictJson } from '../../setup/strict-json.js';
import { KiokukoError } from '../../errors.js';

export class SkillProviderError extends Error {
  readonly code: SkillProviderFailureCode;
  readonly retryAfterSeconds: number | null;
  constructor(code: SkillProviderFailureCode, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = 'SkillProviderError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const OFFICIAL_REPOSITORIES = new Set(OFFICIAL_SKILL_REPOSITORIES.map((value) => parseGitHubSource(value).source));
const OFFICIAL_STATUSES = new Set<SkillCandidate['officialStatus']>(['curated', 'catalog-verified', 'owner-verified', 'registry-only', 'unknown']);
const AUDIT_STATUSES = new Set(['not-required', 'passed', 'failed', 'unavailable']);
const AUDIT_RISK_LEVELS = new Set(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const AUTO_IMPORT_RISK_LEVELS = new Set(['NONE', 'LOW']);
const MAX_CURATED_RESULTS = 10_000;
const INVALID_IDENTITY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u;
const INVALID_UNICODE = /[\p{Cs}\uFFFD]/u;

function invalid(): never { throw new SkillProviderError('registry_invalid_response'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : invalid(); }

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some((key) => !keys.has(key))) invalid();
}

function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > max || INVALID_IDENTITY_CHARACTERS.test(value)) invalid();
  return value;
}

function providerIdentity(value: unknown): string {
  const provider = text(value, 50);
  if (provider === '.' || provider === '..' || !/^[A-Za-z0-9_.-]+$/u.test(provider)) invalid();
  return provider;
}

function safeName(value: unknown): string {
  const name = text(value);
  if (findSecret(name) !== undefined) invalid();
  return name;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid();
  return value;
}

function slug(value: unknown): string {
  const result = text(value, 240);
  if (!/^[A-Za-z0-9_.\-/]+$/u.test(result) || result.split('/').some((part) => part === '' || part === '.' || part === '..')) invalid();
  return result;
}

function githubSource(value: unknown): string {
  try { return parseGitHubSource(text(value, 201)).source; }
  catch (error) {
    if (error instanceof SkillSourceError) return invalid();
    throw error;
  }
}

function canonicalInstallUrl(source: string): string { return `https://github.com/${source}`; }
function officialStatus(source: string, slug: string, officialRepositories: ReadonlySet<string>): SkillCandidate['officialStatus'] {
  return officialRepositories.has(source) && reviewedCatalogSkill({ source, slug }) !== undefined ? 'catalog-verified' : 'registry-only';
}

function candidate(input: {
  provider: string;
  source: string;
  slug: string;
  name: string;
  installs: number;
  duplicate: boolean;
  officialRepositories: ReadonlySet<string>;
}): SkillCandidate {
  const provider = providerIdentity(input.provider);
  if (findSecret(`${input.source}/${input.slug}`) !== undefined) invalid();
  return {
    id: `${provider}:${input.source}:${input.slug}`,
    provider,
    name: input.name,
    slug: input.slug,
    source: input.source,
    sourceType: 'github',
    installUrl: canonicalInstallUrl(input.source),
    installs: input.installs,
    duplicate: input.duplicate,
    officialStatus: officialStatus(input.source, input.slug, input.officialRepositories),
  };
}

function uniqueCandidates(candidates: SkillCandidate[]): SkillCandidate[] {
  const identities = new Set<string>();
  for (const item of candidates) {
    const identity = `${item.source}\u0000${item.slug}`;
    if (identities.has(identity)) invalid();
    identities.add(identity);
  }
  return candidates;
}

export function verifiedOfficialRepositories(values: string[] = OFFICIAL_SKILL_REPOSITORIES): ReadonlySet<string> {
  const repositories = new Set<string>();
  for (const value of values) {
    let source: string;
    try { source = parseGitHubSource(value).source; }
    catch (error) {
      if (error instanceof SkillSourceError) throw new Error('Official skill repository is invalid');
      throw error;
    }
    if (!OFFICIAL_REPOSITORIES.has(source)) throw new Error('Official skill repository is not in the local catalog');
    repositories.add(source);
  }
  return repositories;
}

export async function readSkillProviderJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (contentType === null || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)) throw new SkillProviderError('registry_invalid_response');
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && !/^\d+$/u.test(contentLength)) throw new SkillProviderError('registry_invalid_response');
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > MAX_PROVIDER_RESPONSE_BYTES)) throw new SkillProviderError('registry_invalid_response');
  const reader = response.body?.getReader();
  let body: string;
  if (!reader) {
    body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_PROVIDER_RESPONSE_BYTES) throw new SkillProviderError('registry_invalid_response');
  } else {
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      size += chunk.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SkillProviderError('registry_invalid_response');
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (INVALID_UNICODE.test(body)) throw new SkillProviderError('registry_invalid_response');
  try {
    return parseStrictJson(
      body,
      { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
      'External Skill provider JSON is invalid',
    );
  }
  catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') {
      throw new SkillProviderError('registry_invalid_response');
    }
    throw error;
  }
}

function compatibilityRow(value: unknown, provider: string, officialRepositories: ReadonlySet<string>): SkillCandidate {
  const item = record(value);
  exactKeys(item, ['id', 'name', 'installs', 'source'], ['skillId', 'isDuplicate']);
  const source = githubSource(item.source);
  const id = text(item.id, 500);
  const prefix = `${source}/`;
  if (!id.startsWith(prefix)) invalid();
  const skillSlug = slug(id.slice(prefix.length));
  if (item.skillId !== undefined && slug(item.skillId) !== skillSlug) invalid();
  if (item.isDuplicate !== undefined && typeof item.isDuplicate !== 'boolean') invalid();
  return candidate({ provider, source, slug: skillSlug, name: safeName(item.name), installs: nonNegativeInteger(item.installs), duplicate: item.isDuplicate === true, officialRepositories });
}

export function parseSkillsShCompatibilityResponse(
  value: unknown,
  provider: string,
  expected: { query: string; limit: number },
  officialRepositories: ReadonlySet<string>,
): SkillCandidate[] {
  const providerId = providerIdentity(provider);
  const root = record(value);
  exactKeys(root, ['skills'], ['query', 'searchType', 'count', 'duration_ms']);
  if (root.query !== undefined && text(root.query, 80) !== expected.query) invalid();
  if (root.searchType !== undefined && root.searchType !== 'fuzzy' && root.searchType !== 'semantic') invalid();
  if (!Array.isArray(root.skills) || root.skills.length > expected.limit || root.skills.length > MAX_SEARCH_RESULTS) invalid();
  if (root.count !== undefined && nonNegativeInteger(root.count) !== root.skills.length) invalid();
  if (root.duration_ms !== undefined) nonNegativeNumber(root.duration_ms);
  return uniqueCandidates(root.skills.map((item) => compatibilityRow(item, providerId, officialRepositories)));
}

function v1Url(value: unknown, source: string, skillSlug: string): void {
  const urlValue = text(value, 1_000);
  let url: URL;
  try { url = new URL(urlValue); }
  catch (error) {
    if (error instanceof TypeError) return invalid();
    throw error;
  }
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (error) {
    if (error instanceof URIError) return invalid();
    throw error;
  }
  if (url.protocol !== 'https:' || !['skills.sh', 'www.skills.sh'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash
    || pathname !== `/${source}/${skillSlug}`) invalid();
}

function v1Row(value: unknown, provider: string, officialRepositories: ReadonlySet<string>): SkillCandidate {
  const item = record(value);
  exactKeys(item, ['id', 'slug', 'name', 'source', 'installs', 'sourceType', 'installUrl', 'url'], ['isDuplicate']);
  if (item.sourceType !== 'github') invalid();
  const source = githubSource(item.source);
  const skillSlug = slug(item.slug);
  if (text(item.id, 500) !== `${source}/${skillSlug}`
    || item.installUrl !== canonicalInstallUrl(source)
    || (item.isDuplicate !== undefined && typeof item.isDuplicate !== 'boolean')) invalid();
  v1Url(item.url, source, skillSlug);
  return candidate({ provider, source, slug: skillSlug, name: safeName(item.name), installs: nonNegativeInteger(item.installs), duplicate: item.isDuplicate === true, officialRepositories });
}

export function parseSkillsShV1SearchResponse(
  value: unknown,
  provider: string,
  expected: { query: string; limit: number },
  officialRepositories: ReadonlySet<string>,
): SkillCandidate[] {
  const providerId = providerIdentity(provider);
  const root = record(value);
  exactKeys(root, ['data', 'query', 'searchType', 'count', 'durationMs']);
  if (text(root.query, 80) !== expected.query || (root.searchType !== 'fuzzy' && root.searchType !== 'semantic')) invalid();
  if (!Array.isArray(root.data) || root.data.length > expected.limit || root.data.length > MAX_SEARCH_RESULTS) invalid();
  if (nonNegativeInteger(root.count) !== root.data.length) invalid();
  nonNegativeNumber(root.durationMs);
  return uniqueCandidates(root.data.map((item) => v1Row(item, providerId, officialRepositories)));
}

export function parseSkillsShV1CuratedResponse(value: unknown, provider: string, officialRepositories: ReadonlySet<string>): SkillCandidate[] {
  const providerId = providerIdentity(provider);
  const root = record(value);
  exactKeys(root, ['data', 'totalOwners', 'totalSkills', 'generatedAt']);
  if (!Array.isArray(root.data) || root.data.length > 1_000 || nonNegativeInteger(root.totalOwners) !== root.data.length) invalid();
  const generatedAt = text(root.generatedAt, 100);
  if (!Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) invalid();
  const candidates: SkillCandidate[] = [];
  for (const value of root.data) {
    const group = record(value);
    exactKeys(group, ['owner', 'totalInstalls', 'featuredRepo', 'featuredSkill', 'skills']);
    const owner = text(group.owner, 100).toLowerCase();
    if (owner === '.' || owner === '..' || !/^[a-z0-9_.-]+$/u.test(owner)) invalid();
    nonNegativeInteger(group.totalInstalls);
    const featuredRepo = text(group.featuredRepo, 100).toLowerCase();
    const featuredSkill = slug(group.featuredSkill);
    if (featuredRepo === '.' || featuredRepo === '..' || !/^[a-z0-9_.-]+$/u.test(featuredRepo) || !Array.isArray(group.skills) || group.skills.length < 1) invalid();
    const skills = group.skills.map((item) => v1Row(item, providerId, officialRepositories));
    if (skills.some((item) => !item.source.startsWith(`${owner}/`))
      || !skills.some((item) => item.source === `${owner}/${featuredRepo}` && item.slug === featuredSkill)) invalid();
    candidates.push(...skills.map((item) => ({ ...item, officialStatus: 'curated' as const })));
  }
  if (nonNegativeInteger(root.totalSkills) !== candidates.length || candidates.length > MAX_CURATED_RESULTS) invalid();
  return uniqueCandidates(candidates);
}

function isoTimestamp(value: unknown): void {
  const timestamp = text(value, 100);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) invalid();
}

export function parseSkillsShV1AuditResponse(value: unknown, expected: { source: string; slug: string }): SkillAuditResult {
  const root = record(value);
  exactKeys(root, ['id', 'source', 'slug', 'audits']);
  const source = githubSource(root.source);
  const skillSlug = slug(root.slug);
  if (source !== expected.source.toLowerCase() || skillSlug !== expected.slug
    || text(root.id, 500) !== `${source}/${skillSlug}`
    || !Array.isArray(root.audits) || root.audits.length < 1 || root.audits.length > 100) invalid();
  const providers = new Set<string>();
  let passed = true;
  for (const value of root.audits) {
    const audit = record(value);
    exactKeys(audit, ['provider', 'slug', 'status', 'summary', 'auditedAt'], ['riskLevel', 'categories']);
    const providerName = text(audit.provider, 200);
    const providerSlug = slug(audit.slug).toLowerCase();
    if (providers.has(providerSlug) || findSecret(providerName) !== undefined) invalid();
    providers.add(providerSlug);
    if (audit.status !== 'pass' && audit.status !== 'warn' && audit.status !== 'fail') invalid();
    text(audit.summary, 1_000);
    isoTimestamp(audit.auditedAt);
    if (audit.riskLevel !== undefined && (typeof audit.riskLevel !== 'string' || !AUDIT_RISK_LEVELS.has(audit.riskLevel))) invalid();
    // A missing risk level remains status-driven for providers that do not emit it.
    // An explicit MEDIUM-or-higher risk can never be auto-imported, even with status=pass.
    passed &&= audit.status === 'pass'
      && (audit.riskLevel === undefined || AUTO_IMPORT_RISK_LEVELS.has(audit.riskLevel));
    if (audit.categories !== undefined && (!Array.isArray(audit.categories) || audit.categories.length > 100
      || audit.categories.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 100 || INVALID_IDENTITY_CHARACTERS.test(item)))) invalid();
  }
  return { status: passed ? 'passed' : 'failed' };
}

/** Strictly parse Kiokuko's own cached candidate shape. */
export function parseSkillCandidates(value: unknown, provider: string, provenance: 'search' | 'curated'): SkillCandidate[] {
  const providerId = providerIdentity(provider);
  const resultLimit = provenance === 'curated' ? MAX_CURATED_RESULTS : MAX_SEARCH_RESULTS;
  if (!Array.isArray(value) || value.length > resultLimit) invalid();
  const candidates = value.map((candidateValue) => {
    const item = record(candidateValue);
    exactKeys(item, ['id', 'provider', 'name', 'slug', 'source', 'sourceType', 'installUrl', 'installs', 'duplicate', 'officialStatus'], ['auditStatus']);
    if (item.provider !== providerId || item.sourceType !== 'github' || typeof item.duplicate !== 'boolean' || !OFFICIAL_STATUSES.has(item.officialStatus as SkillCandidate['officialStatus'])
      || (item.auditStatus !== undefined && !AUDIT_STATUSES.has(String(item.auditStatus)))) invalid();
    const source = githubSource(item.source);
    const skillSlug = slug(item.slug);
    if (item.installUrl !== canonicalInstallUrl(source)) invalid();
    const parsed = candidate({ provider: providerId, source, slug: skillSlug, name: safeName(item.name), installs: nonNegativeInteger(item.installs), duplicate: item.duplicate, officialRepositories: OFFICIAL_REPOSITORIES });
    const result = provenance === 'curated' ? { ...parsed, officialStatus: 'curated' as const } : parsed;
    if (text(item.id, 500) !== result.id || item.officialStatus !== result.officialStatus) invalid();
    return item.auditStatus === undefined ? result : { ...result, auditStatus: item.auditStatus as Exclude<SkillCandidate['auditStatus'], undefined> };
  });
  return uniqueCandidates(candidates);
}

export function cacheKey(input: { provider: string; query: string; owner?: string | null; mode: string }): string {
  return canonicalContentHash({ provider: providerIdentity(input.provider), query: input.query, owner: input.owner ?? null, mode: input.mode });
}
