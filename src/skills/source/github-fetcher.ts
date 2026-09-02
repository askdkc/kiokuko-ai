import type { SkillCandidate, SkillSnapshot, SkillSourceFetcher, SkillSourceFetchRequest } from '../types.js';
import { SkillSourceError, skillSourceFailure } from './errors.js';
import type { SkillSourceFailureCode } from './errors.js';
import { parseGitHubSource, validateSkillCandidate, validateSkillSnapshot, validateSourceCommit, MAX_FILE_BYTES, MAX_FILES_PER_SKILL, MAX_PRIMARY_SKILL_BYTES, MAX_TREE_ITEMS, MAX_TOTAL_SKILL_BYTES } from './snapshot-validator.js';
import { isBearerToken, parseRetryAfterSeconds } from '../config.js';
import { reviewedCatalogSkill } from '../official-catalog.js';
import { KiokukoError } from '../../errors.js';
import { parseStrictJson } from '../../setup/strict-json.js';
import { isExternalFetchFailure } from '../external-transport.js';

export { SkillSourceError } from './errors.js';
export type { SkillSourceFailureCode } from './errors.js';

export interface GitHubSkillSourceFetcherOptions {
  fetchImpl?: typeof fetch;
  token?: string | null;
  timeoutMs?: number;
}

interface TreeItem { path: string; type: 'blob' | 'tree' | 'commit'; mode: string; }

const MAX_API_RESPONSE_BYTES = 100_000;
const MAX_TREE_RESPONSE_BYTES = 3_000_000;
const INVALID_IDENTITY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u;
const INVALID_UNICODE = /[\p{Cs}\uFFFD]/u;

function safeTreePath(value: string): boolean {
  return value.length > 0
    && value.length <= 2_000
    && !value.startsWith('/')
    && !value.includes('\\')
    && !INVALID_IDENTITY_CHARACTERS.test(value)
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function hasUnsafeMode(item: TreeItem): boolean { return item.mode === '120000' || item.mode === '100755'; }

function isAllowedReferencePath(root: string, value: string): boolean {
  const prefix = root === '' ? '' : `${root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/`;
  return new RegExp(`^${prefix}references/.+\\.(?:md|txt)$`, 'u').test(value)
    || new RegExp(`^${prefix}docs/.+\\.md$`, 'u').test(value);
}

function sourceParts(input: SkillCandidate): { candidate: SkillCandidate; owner: string; repo: string } {
  const candidate = validateSkillCandidate(input);
  const { owner, repo } = parseGitHubSource(candidate.source);
  return { candidate, owner, repo };
}

function sourceFetchRequest(value: SkillSourceFetchRequest): SkillSourceFetchRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) skillSourceFailure('skill_validation_failed');
  const request = value as Record<string, unknown>;
  if (request.purpose === 'discovery' && Object.keys(request).length === 1) return { purpose: 'discovery' };
  if (request.purpose === 'refresh' && Object.keys(request).length === 2
    && typeof request.expectedPrimaryPath === 'string'
    && safeTreePath(request.expectedPrimaryPath)
    && (request.expectedPrimaryPath === 'SKILL.md' || request.expectedPrimaryPath.endsWith('/SKILL.md'))) {
    return { purpose: 'refresh', expectedPrimaryPath: request.expectedPrimaryPath };
  }
  skillSourceFailure('skill_validation_failed');
}

function githubUrl(path: string): URL {
  const url = new URL(path);
  const allowedQuery = url.hostname === 'api.github.com' && url.search === '?recursive=1';
  if (url.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com'].includes(url.hostname) || url.port || url.username || url.password || url.hash || url.search && !allowedQuery) skillSourceFailure('skill_validation_failed');
  return url;
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.get('x-ratelimit-remaining') === '0'
    || parseRetryAfterSeconds(response.headers.get('retry-after')) !== null;
}

function hasAcceptedGitHubJsonContentType(response: Response): boolean {
  const value = response.headers.get('content-type');
  if (value === null) return false;
  const parts = value.split(';');
  const mediaType = parts[0]?.trim().toLowerCase();
  if (parts.length > 2 || mediaType !== 'application/json' && mediaType !== 'application/vnd.github+json') return false;
  return parts.length === 1 || /^charset\s*=\s*utf-8$/iu.test(parts[1]?.trim() ?? '');
}

function validDefaultBranch(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 200
    && value === value.trim()
    && /^[A-Za-z0-9._/-]+$/u.test(value)
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && !value.endsWith('.lock')
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && !value.split('/').some((part) => part === '.' || part === '..');
}

function treeItem(value: unknown): TreeItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) skillSourceFailure('skill_validation_failed');
  const item = value as Record<string, unknown>;
  if (typeof item.path !== 'string' || !safeTreePath(item.path)
    || (item.type !== 'blob' && item.type !== 'tree' && item.type !== 'commit')
    || typeof item.mode !== 'string') skillSourceFailure('skill_validation_failed');
  const validMode = item.type === 'blob'
    ? ['100644', '100755', '120000'].includes(item.mode)
    : item.type === 'tree' ? item.mode === '040000' : item.mode === '160000';
  if (!validMode) skillSourceFailure('skill_validation_failed');
  return { path: item.path, type: item.type, mode: item.mode };
}

export class GitHubSkillSourceFetcher implements SkillSourceFetcher {
  private readonly fetchImpl: typeof fetch;
  #token: string | null;
  private readonly timeoutMs: number;
  constructor(options: GitHubSkillSourceFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.#token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error('GitHub timeout is invalid');
    if (this.#token !== null && !isBearerToken(this.#token)) throw new Error('GitHub token is invalid');
  }
  private async request(url: URL, signal?: AbortSignal): Promise<Response> {
    try {
      const safeUrl = githubUrl(url.toString());
      const response = await this.fetchImpl(safeUrl, { redirect: 'manual', headers: { accept: 'application/vnd.github+json', 'user-agent': 'kiokuko-skill-discovery', ...(this.#token && safeUrl.hostname === 'api.github.com' ? { authorization: `Bearer ${this.#token}` } : {}) }, ...(signal === undefined ? {} : { signal }) });
      if (response.status >= 300 && response.status < 400) {
        throw new SkillSourceError('source_unavailable');
      }
      if (response.status === 404 || response.status === 410) throw new SkillSourceError('source_missing');
      if (isRateLimited(response)) throw new SkillSourceError('source_rate_limited', parseRetryAfterSeconds(response.headers.get('retry-after')));
      if (response.status !== 200) throw new SkillSourceError('source_unavailable');
      return response;
    } catch (error) {
      if (error instanceof SkillSourceError) throw error;
      if (signal?.aborted && signal.reason !== undefined) throw signal.reason;
      if (isExternalFetchFailure(error)) throw new SkillSourceError('source_unavailable');
      throw error;
    }
  }
  private async text(url: URL, signal: AbortSignal, limit: number): Promise<string> {
    const response = await this.request(url, signal);
    return this.responseText(response, limit, 'skill_too_large', signal);
  }
  private async responseText(response: Response, limit: number, overflowCode: SkillSourceFailureCode, signal?: AbortSignal): Promise<string> {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && !/^\d+$/u.test(contentLength)) skillSourceFailure('skill_validation_failed');
    const declared = contentLength === null ? null : Number(contentLength);
    if (declared !== null && (!Number.isSafeInteger(declared) || declared > limit)) skillSourceFailure(overflowCode);
    try {
      const reader = response.body?.getReader();
      if (!reader) {
        return '';
      }
      const chunks: Buffer[] = []; let size = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; const chunk = Buffer.from(next.value); size += chunk.byteLength; if (size > limit) { await reader.cancel(); skillSourceFailure(overflowCode); } chunks.push(chunk); }
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
      catch { skillSourceFailure('skill_validation_failed'); }
      if (INVALID_UNICODE.test(content)) skillSourceFailure('skill_validation_failed');
      return content;
    } catch (error) {
      if (signal?.aborted && signal.reason !== undefined) throw signal.reason;
      if (isExternalFetchFailure(error)) throw new SkillSourceError('source_unavailable');
      throw error;
    }
  }
  private async json(url: URL, signal: AbortSignal, limit = MAX_API_RESPONSE_BYTES, overflowCode: SkillSourceFailureCode = 'skill_validation_failed'): Promise<unknown> {
    const response = await this.request(url, signal);
    if (!hasAcceptedGitHubJsonContentType(response)) skillSourceFailure('skill_validation_failed');
    const body = await this.responseText(response, limit, overflowCode, signal);
    try {
      return parseStrictJson(
        body,
        { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
        'GitHub source response is not valid JSON with unique keys',
      );
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') skillSourceFailure('skill_validation_failed');
      throw error;
    }
  }
  async fetch(input: SkillCandidate, request: SkillSourceFetchRequest, signal?: AbortSignal): Promise<SkillSnapshot> {
    const { candidate, owner, repo } = sourceParts(input);
    const fetchRequest = sourceFetchRequest(request);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const repositoryJson = await this.json(new URL(apiBase), controller.signal);
      if (typeof repositoryJson !== 'object' || repositoryJson === null || Array.isArray(repositoryJson)) skillSourceFailure('skill_validation_failed');
      const defaultBranch = (repositoryJson as Record<string, unknown>).default_branch;
      if (!validDefaultBranch(defaultBranch)) skillSourceFailure('skill_validation_failed');
      const commitJson = await this.json(new URL(`${apiBase}/commits/${encodeURIComponent(defaultBranch)}`), controller.signal);
      if (typeof commitJson !== 'object' || commitJson === null || Array.isArray(commitJson)) skillSourceFailure('skill_validation_failed');
      const sha = validateSourceCommit((commitJson as Record<string, unknown>).sha);
      const treeJson = await this.json(new URL(`${apiBase}/git/trees/${encodeURIComponent(sha)}?recursive=1`), controller.signal, MAX_TREE_RESPONSE_BYTES, 'source_tree_truncated');
      if (typeof treeJson !== 'object' || treeJson === null || Array.isArray(treeJson) || (treeJson as { truncated?: unknown }).truncated !== false || !Array.isArray((treeJson as { tree?: unknown }).tree)) skillSourceFailure('source_tree_truncated');
      const rawTree = (treeJson as { tree: unknown[] }).tree;
      if (rawTree.length > MAX_TREE_ITEMS) skillSourceFailure('source_tree_truncated');
      const tree = rawTree.map(treeItem);
      const reviewedSkill = reviewedCatalogSkill(candidate);
      let primary: TreeItem | undefined;
      if (fetchRequest.purpose === 'refresh') {
        const expectedMatches = tree.filter((item) => item.type === 'blob' && item.path === fetchRequest.expectedPrimaryPath);
        if (expectedMatches.length > 1) skillSourceFailure('skill_validation_failed');
        primary = expectedMatches[0];
        if (primary === undefined) {
          const skillSuffix = `${candidate.slug}/SKILL.md`;
          const movedIdentityMatches = tree.filter((item) => item.type === 'blob'
            && (reviewedSkill === undefined
              ? item.path === skillSuffix || item.path.endsWith(`/${skillSuffix}`)
              : reviewedSkill.primaryPaths.includes(item.path)));
          if (movedIdentityMatches.length > 1) skillSourceFailure('skill_validation_failed');
          primary = movedIdentityMatches[0];
        }
      } else {
        const skillSuffix = `${candidate.slug}/SKILL.md`;
        const exactMatches = tree.filter((item) => item.type === 'blob'
          && (reviewedSkill === undefined
            ? item.path === skillSuffix || item.path.endsWith(`/${skillSuffix}`)
            : reviewedSkill.primaryPaths.includes(item.path)));
        if (exactMatches.length > 1) skillSourceFailure('skill_validation_failed');
        primary = exactMatches[0];
        if (primary === undefined && reviewedSkill === undefined) {
          const fuzzyMatches = tree.filter((item) => item.type === 'blob' && (item.path === 'SKILL.md' || item.path.endsWith('/SKILL.md')));
          if (fuzzyMatches.length > 1) skillSourceFailure('skill_validation_failed');
          primary = fuzzyMatches[0];
        }
      }
      if (!primary) skillSourceFailure('candidate_not_found_at_source');
      if (hasUnsafeMode(primary)) skillSourceFailure('skill_validation_failed');
      const root = primary.path === 'SKILL.md' ? '' : primary.path.slice(0, -'/SKILL.md'.length);
      const related = tree.filter((item) => safeTreePath(item.path) && (item.path === primary.path || isAllowedReferencePath(root, item.path)));
      if (related.some(hasUnsafeMode)) skillSourceFailure('skill_validation_failed');
      const paths = related.filter((item) => item.type === 'blob');
      if (paths.length > MAX_FILES_PER_SKILL) skillSourceFailure('skill_too_large');
      const files = []; let total = 0;
      for (const item of paths) {
        const isPrimary = item.path === primary.path;
        const fileLimit = isPrimary ? MAX_PRIMARY_SKILL_BYTES : MAX_FILE_BYTES;
        const remainingTotalBytes = MAX_TOTAL_SKILL_BYTES - total;
        const content = await this.text(
          new URL(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/${item.path.split('/').map(encodeURIComponent).join('/')}`),
          controller.signal,
          Math.min(fileLimit, remainingTotalBytes),
        );
        total += Buffer.byteLength(content, 'utf8');
        if (total > MAX_TOTAL_SKILL_BYTES) skillSourceFailure('skill_too_large');
        files.push({ path: item.path, content, primary: isPrimary });
      }
      return validateSkillSnapshot({ candidate, sourceCommit: sha, files });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
