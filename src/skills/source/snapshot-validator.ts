import { createHash } from 'node:crypto';
import { canonicalContentHash } from '../../serialization/validate.js';
import type { SkillCandidate, SkillSnapshot } from '../types.js';
import { skillSourceFailure } from './errors.js';
import { parseSkillFrontmatter } from './frontmatter.js';
import { findSecret } from '../../memory/secrets.js';
import { reviewedCatalogSkill } from '../official-catalog.js';

export const MAX_TREE_ITEMS = 1_000;
export const MAX_FILES_PER_SKILL = 20;
export const MAX_FILE_BYTES = 100_000;
export const MAX_TOTAL_SKILL_BYTES = 300_000;
export const MAX_PRIMARY_SKILL_BYTES = 150_000;

const OFFICIAL_STATUSES = new Set(['curated', 'catalog-verified', 'owner-verified', 'registry-only', 'unknown']);
const AUDIT_STATUSES = new Set(['not-required', 'passed', 'failed', 'unavailable']);
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const INVALID_IDENTITY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u;
const INVALID_UNICODE = /[\p{Cs}\uFFFD]/u;
const CANDIDATE_FIELDS = new Set([
  'id', 'provider', 'name', 'slug', 'source', 'sourceType', 'installUrl',
  'installs', 'duplicate', 'officialStatus', 'auditStatus',
]);
const REQUIRED_CANDIDATE_FIELDS = [...CANDIDATE_FIELDS].filter((field) => field !== 'auditStatus');

function validPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 2_000
    && /^[A-Za-z0-9_.\-/]+$/u.test(value)
    && !value.startsWith('/')
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

export function parseGitHubSource(value: unknown): { owner: string; repo: string; source: string } {
  if (typeof value !== 'string' || value !== value.trim()) skillSourceFailure('skill_validation_failed');
  const parts = value.split('/');
  if (parts.length !== 2
    || parts.some((part) => part === '.' || part === '..' || !/^[A-Za-z0-9_.-]{1,100}$/u.test(part))) skillSourceFailure('skill_validation_failed');
  const owner = parts[0]!.toLowerCase();
  const repo = parts[1]!.toLowerCase();
  return { owner, repo, source: `${owner}/${repo}` };
}

export function validateSourceCommit(value: unknown): string {
  if (typeof value !== 'string' || !FULL_COMMIT_PATTERN.test(value)) skillSourceFailure('skill_validation_failed');
  return value;
}

/** Validate and canonicalize a provider candidate before any source request. */
export function validateSkillCandidate(value: SkillCandidate): SkillCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || REQUIRED_CANDIDATE_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field))
    || Object.keys(value).some((field) => !CANDIDATE_FIELDS.has(field))) skillSourceFailure('skill_validation_failed');
  const source = parseGitHubSource(value.source).source;
  const installUrl = `https://github.com/${source}`;
  if (value.sourceType !== 'github'
    || typeof value.provider !== 'string' || !/^[A-Za-z0-9_.-]{1,50}$/u.test(value.provider) || value.provider === '.' || value.provider === '..'
    || typeof value.id !== 'string' || value.id !== value.id.trim() || value.id.length < 1 || value.id.length > 500 || INVALID_IDENTITY_CHARACTERS.test(value.id)
    || typeof value.name !== 'string' || value.name !== value.name.trim() || value.name.length < 1 || value.name.length > 500 || INVALID_IDENTITY_CHARACTERS.test(value.name) || findSecret(value.name) !== undefined
    || !/^[A-Za-z0-9_.\-/]{1,240}$/u.test(value.slug) || value.slug.split('/').some((part) => part === '' || part === '.' || part === '..')
    || findSecret(`${source}/${value.slug}`) !== undefined
    || (value.installUrl !== null && value.installUrl !== installUrl)
    || !Number.isSafeInteger(value.installs) || value.installs < 0
    || typeof value.duplicate !== 'boolean'
    || !OFFICIAL_STATUSES.has(value.officialStatus)
    || (value.auditStatus !== undefined && !AUDIT_STATUSES.has(value.auditStatus))) skillSourceFailure('skill_validation_failed');
  return {
    id: value.id,
    provider: value.provider,
    name: value.name,
    slug: value.slug,
    source,
    sourceType: 'github',
    installUrl,
    installs: value.installs,
    duplicate: value.duplicate,
    officialStatus: value.officialStatus,
    ...(value.auditStatus === undefined ? {} : { auditStatus: value.auditStatus }),
  };
}

/** Return the skill slug represented by a verified primary SKILL.md path. */
export function canonicalSkillSlugFromPrimaryPath(primaryPath: string): string {
  if (!validPath(primaryPath) || !primaryPath.endsWith('/SKILL.md')) skillSourceFailure('skill_validation_failed');
  const root = primaryPath.slice(0, -'/SKILL.md'.length);
  // These are reviewed repository layouts, not aliases. Keep this list exact:
  // an arbitrary parent directory must remain part of the canonical identity.
  const reviewedPrefix = ['skills/', 'tools/skills/'].find((prefix) => root.startsWith(prefix));
  const slug = reviewedPrefix === undefined ? root : root.slice(reviewedPrefix.length);
  if (!/^[A-Za-z0-9_.\-/]{1,240}$/u.test(slug) || slug.split('/').some((part) => part === '' || part === '.' || part === '..')) skillSourceFailure('skill_validation_failed');
  return slug;
}

export function validateSkillSnapshot(input: { candidate: SkillCandidate; sourceCommit: string; files: Array<{ path: string; content: string; primary: boolean }> }): SkillSnapshot {
  const candidate = validateSkillCandidate(input.candidate);
  const sourceCommit = validateSourceCommit(input.sourceCommit);
  if (input.files.length === 0 || input.files.length > MAX_FILES_PER_SKILL) skillSourceFailure('skill_validation_failed');
  const primaryInputs = input.files.filter((file) => file.primary);
  if (primaryInputs.length !== 1 || !validPath(primaryInputs[0]!.path)
    || primaryInputs[0]!.path !== 'SKILL.md' && !primaryInputs[0]!.path.endsWith('/SKILL.md')) skillSourceFailure('skill_validation_failed');
  const primaryPath = primaryInputs[0]!.path;
  const reviewedSkill = reviewedCatalogSkill(candidate);
  if (reviewedSkill !== undefined && !reviewedSkill.primaryPaths.includes(primaryPath)) skillSourceFailure('skill_validation_failed');
  const canonicalSlug = reviewedSkill?.slug ?? (primaryPath === 'SKILL.md' ? candidate.slug : canonicalSkillSlugFromPrimaryPath(primaryPath));
  const canonicalCandidate: SkillCandidate = {
    ...candidate,
    slug: canonicalSlug,
    id: `${candidate.provider}:${candidate.source}:${canonicalSlug}`,
  };
  const root = primaryPath === 'SKILL.md' ? '' : primaryPath.slice(0, -'/SKILL.md'.length);
  let total = 0; let primaryCount = 0;
  const seenPaths = new Set<string>();
  const orderedFiles = [...input.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const files = orderedFiles.map((file) => {
    const allowedReference = (file.path.startsWith(root === '' ? 'references/' : `${root}/references/`) && /\.(?:md|txt)$/u.test(file.path))
      || (file.path.startsWith(root === '' ? 'docs/' : `${root}/docs/`) && /\.md$/u.test(file.path));
    if (!validPath(file.path) || (file.path !== primaryPath && !allowedReference) || file.primary !== (file.path === primaryPath)) skillSourceFailure('skill_validation_failed');
    if (seenPaths.has(file.path)) skillSourceFailure('skill_validation_failed');
    seenPaths.add(file.path);
    if (typeof file.content !== 'string' || INVALID_UNICODE.test(file.content)) skillSourceFailure('skill_validation_failed');
    const bytes = Buffer.byteLength(file.content, 'utf8');
    const fileLimit = file.primary ? MAX_PRIMARY_SKILL_BYTES : MAX_FILE_BYTES;
    if (bytes > fileLimit) skillSourceFailure('skill_too_large');
    if (file.content.includes('\0')) skillSourceFailure('skill_validation_failed');
    if (findSecret(file.content)) skillSourceFailure('skill_secret_detected');
    total += bytes; if (total > MAX_TOTAL_SKILL_BYTES) skillSourceFailure('skill_too_large');
    if (file.primary) primaryCount += 1;
    const contentHash = createHash('sha256').update(file.content, 'utf8').digest('hex');
    return { path: file.path, content: file.content, contentHash, primary: file.primary };
  });
  if (primaryCount !== 1) skillSourceFailure('skill_validation_failed');
  const primary = files.find((file) => file.primary)!;
  const frontmatter = parseSkillFrontmatter(primary.content);
  if (frontmatter.disableModelInvocation) skillSourceFailure('skill_disabled_for_model_invocation');
  if (primaryPath === 'SKILL.md' && (candidate.slug.includes('/') || candidate.slug !== frontmatter.name || candidate.name !== frontmatter.name)) {
    skillSourceFailure('skill_validation_failed');
  }
  const persistedCandidate = { ...canonicalCandidate, name: frontmatter.name };
  const sourceIdentity = {
    sourceType: persistedCandidate.sourceType,
    source: persistedCandidate.source,
    slug: persistedCandidate.slug,
  };
  const snapshotHash = canonicalContentHash({ source: sourceIdentity, sourceCommit, files: files.map(({ path, contentHash, primary }) => ({ path, contentHash, primary })) });
  return { candidate: persistedCandidate, sourceCommit, snapshotHash, files, frontmatter };
}

/** Recompute every derived field before a snapshot crosses the persistence boundary. */
export function revalidateSkillSnapshot(snapshot: SkillSnapshot): SkillSnapshot {
  const verified = validateSkillSnapshot({
    candidate: snapshot.candidate,
    sourceCommit: snapshot.sourceCommit,
    files: snapshot.files.map(({ path, content, primary }) => ({ path, content, primary })),
  });
  const verifiedFiles = new Map(verified.files.map((file) => [file.path, file]));
  const derivedFilesMatch = snapshot.files.length === verified.files.length && snapshot.files.every((file) => {
    const verifiedFile = verifiedFiles.get(file.path);
    return verifiedFile !== undefined && file.contentHash === verifiedFile.contentHash && file.primary === verifiedFile.primary;
  });
  const frontmatterMatches = snapshot.frontmatter.name === verified.frontmatter.name
    && snapshot.frontmatter.description === verified.frontmatter.description
    && snapshot.frontmatter.disableModelInvocation === verified.frontmatter.disableModelInvocation;
  const identityMatches = snapshot.candidate.sourceType === verified.candidate.sourceType
    && snapshot.candidate.source === verified.candidate.source
    && snapshot.candidate.slug === verified.candidate.slug
    && snapshot.candidate.id === verified.candidate.id
    && snapshot.candidate.installUrl === verified.candidate.installUrl
    && snapshot.candidate.name === verified.candidate.name;
  if (snapshot.snapshotHash !== verified.snapshotHash || !derivedFilesMatch || !frontmatterMatches || !identityMatches) skillSourceFailure('skill_validation_failed');
  return verified;
}
