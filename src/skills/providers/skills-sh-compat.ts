import { parseSkillsShCompatibilityResponse, readSkillProviderJson, SkillProviderError, verifiedOfficialRepositories } from './schema.js';
import type { SkillRegistryProvider, SkillSearchInput, SkillSearchResult } from '../types.js';
import { validateSkillSearchScope } from '../query-builder.js';
import { parseRetryAfterSeconds } from '../config.js';
import { createHash } from 'node:crypto';
import { isExternalFetchFailure } from '../external-transport.js';

export interface SkillsShCompatibilityOptions {
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  officialRepositories?: string[];
}

function baseUrl(value: string): URL {
  const url = new URL(value);
  const allowedProtocol = url.protocol === 'https:'
    || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!allowedProtocol
    || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('skills.sh URL is invalid');
  return url;
}

function retryAfter(response: Response): number | null {
  return parseRetryAfterSeconds(response.headers.get('retry-after'));
}

export class SkillsShCompatibilityProvider implements SkillRegistryProvider {
  readonly id: string;
  private readonly apiUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly officialRepositories: ReadonlySet<string>;
  constructor(options: SkillsShCompatibilityOptions = {}) {
    this.apiUrl = baseUrl(options.apiUrl ?? 'https://skills.sh');
    this.id = `skills-sh-compat-${createHash('sha256').update(this.apiUrl.origin, 'utf8').digest('hex').slice(0, 16)}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error('skills.sh timeout is invalid');
    this.officialRepositories = verifiedOfficialRepositories(options.officialRepositories ?? []);
  }
  async search(input: SkillSearchInput): Promise<SkillSearchResult> {
    const { query, owner } = validateSkillSearchScope(input.query, input.owner);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new SkillProviderError('registry_invalid_response');
    const url = new URL('/api/search', this.apiUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(input.limit));
    if (owner) url.searchParams.set('owner', owner);
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    else input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 'kiokuko-skill-discovery' }, signal: controller.signal });
      if (response.status === 429) throw new SkillProviderError('registry_rate_limited', retryAfter(response));
      if (response.status !== 200) throw new SkillProviderError('registry_unavailable');
      const body = await readSkillProviderJson(response);
      return { provider: this.id, experimental: true, candidates: parseSkillsShCompatibilityResponse(body, this.id, { query, limit: input.limit }, this.officialRepositories) };
    } catch (error) {
      if (error instanceof SkillProviderError) throw error;
      if (input.signal?.aborted) throw input.signal.reason;
      if (isExternalFetchFailure(error)) throw new SkillProviderError('registry_unavailable');
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }
}
