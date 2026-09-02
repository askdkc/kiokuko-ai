import { parseSkillsShV1AuditResponse, parseSkillsShV1CuratedResponse, parseSkillsShV1SearchResponse, readSkillProviderJson, SkillProviderError, verifiedOfficialRepositories } from './schema.js';
import type { SkillCandidate, SkillRegistryProvider, SkillSearchInput, SkillSearchResult, SkillAuditResult } from '../types.js';
import { validateSkillSearchScope } from '../query-builder.js';
import { SkillSourceError } from '../source/errors.js';
import { validateSkillCandidate } from '../source/snapshot-validator.js';
import { isBearerToken, isTrustedSkillsShApiUrl, parseRetryAfterSeconds } from '../config.js';
import { isExternalFetchFailure } from '../external-transport.js';

export interface SkillsShV1Options {
  apiUrl?: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  officialRepositories?: string[];
  authenticationFallback?: SkillRegistryProvider;
}

function retryAfter(response: Response): number | null {
  return parseRetryAfterSeconds(response.headers.get('retry-after'));
}

function providerUrl(value: string): URL {
  if (!isTrustedSkillsShApiUrl(value)) throw new Error('skills.sh URL is invalid');
  return new URL(value);
}

function responseFailure(response: Response): SkillProviderError {
  if (response.status === 401) return new SkillProviderError('registry_authentication_failed');
  if (response.status === 429) return new SkillProviderError('registry_rate_limited', retryAfter(response));
  return new SkillProviderError('registry_unavailable');
}

export class SkillsShV1Provider implements SkillRegistryProvider {
  readonly id = 'skills-sh-v1';
  readonly authenticationFallback?: SkillRegistryProvider;
  private readonly apiUrl: URL;
  #token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly officialRepositories: ReadonlySet<string>;
  constructor(options: SkillsShV1Options) {
    const url = providerUrl(options.apiUrl ?? 'https://skills.sh');
    if (!isBearerToken(options.token)) throw new Error('skills.sh token is invalid');
    this.apiUrl = url; this.#token = options.token; this.fetchImpl = options.fetchImpl ?? fetch; this.timeoutMs = options.timeoutMs ?? 5_000; this.officialRepositories = verifiedOfficialRepositories(options.officialRepositories ?? []);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error('skills.sh timeout is invalid');
    if (options.authenticationFallback !== undefined) this.authenticationFallback = options.authenticationFallback;
  }
  async search(input: SkillSearchInput): Promise<SkillSearchResult> {
    const { query, owner } = validateSkillSearchScope(input.query, input.owner);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new SkillProviderError('registry_invalid_response');
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    else input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = new URL('/api/v1/skills/search', this.apiUrl);
    url.searchParams.set('q', query); url.searchParams.set('limit', String(input.limit)); if (owner) url.searchParams.set('owner', owner);
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual', headers: { accept: 'application/json', authorization: `Bearer ${this.#token}`, 'user-agent': 'kiokuko-skill-discovery' }, signal: controller.signal });
      if (response.status !== 200) throw responseFailure(response);
      const body = await readSkillProviderJson(response);
      return { provider: this.id, experimental: false, candidates: parseSkillsShV1SearchResponse(body, this.id, { query, limit: input.limit }, this.officialRepositories) };
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
  async curated(signal?: AbortSignal): Promise<import('../types.js').SkillCandidate[] | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs); const url = new URL('/api/v1/skills/curated', this.apiUrl);
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual', headers: { accept: 'application/json', authorization: `Bearer ${this.#token}`, 'user-agent': 'kiokuko-skill-discovery' }, signal: controller.signal });
      if (response.status !== 200) throw responseFailure(response);
      return parseSkillsShV1CuratedResponse(await readSkillProviderJson(response), this.id, this.officialRepositories);
    } catch (error) {
      if (error instanceof SkillProviderError) throw error;
      if (signal?.aborted) throw signal.reason;
      if (isExternalFetchFailure(error)) throw new SkillProviderError('registry_unavailable');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  async audit(candidate: SkillCandidate, signal?: AbortSignal): Promise<SkillAuditResult | null> {
    let validatedCandidate: SkillCandidate;
    try { validatedCandidate = validateSkillCandidate(candidate); }
    catch (error) {
      if (error instanceof SkillSourceError) throw new SkillProviderError('registry_invalid_response');
      throw error;
    }
    const source = validatedCandidate.source;
    const path = `/api/v1/skills/audit/${[source, validatedCandidate.slug].join('/').split('/').map(encodeURIComponent).join('/')}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs); const url = new URL(path, this.apiUrl);
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual', headers: { accept: 'application/json', authorization: `Bearer ${this.#token}`, 'user-agent': 'kiokuko-skill-discovery' }, signal: controller.signal });
      if (response.status !== 200) throw responseFailure(response);
      const body = await readSkillProviderJson(response);
      return parseSkillsShV1AuditResponse(body, { source, slug: validatedCandidate.slug });
    } catch (error) {
      if (error instanceof SkillProviderError) throw error;
      if (signal?.aborted) throw signal.reason;
      if (isExternalFetchFailure(error)) throw new SkillProviderError('registry_unavailable');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
}
