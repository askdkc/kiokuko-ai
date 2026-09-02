import type { SkillDiscoveryMode } from './types.js';
import { KiokukoError } from '../errors.js';

export const SKILL_DISCOVERY_ENV = 'KIOKUKO_SKILL_DISCOVERY';
export const MAX_BEARER_TOKEN_CHARS = 4_096;
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const TRUSTED_SKILLS_SH_ORIGIN = 'https://skills.sh';

/** RFC 6750 b64token characters, bounded to keep header construction predictable. */
export function isBearerToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_BEARER_TOKEN_CHARS
    && BEARER_TOKEN.test(value);
}

/** Authenticated registry traffic is never sent to a configurable or local origin. */
export function isTrustedSkillsShApiUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); }
  catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  return url.origin === TRUSTED_SKILLS_SH_ORIGIN
    && url.protocol === 'https:'
    && !url.port
    && !url.username
    && !url.password
    && !url.hash
    && !url.search
    && url.pathname === '/';
}

/** Parse only positive delta-seconds or canonical IMF-fixdate HTTP dates. */
export function parseRetryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) return null;
  const seconds = Math.ceil((timestamp - now) / 1_000);
  return seconds > 0 ? seconds : null;
}

export function isSkillDiscoveryMode(value: unknown): value is SkillDiscoveryMode {
  return value === 'off' || value === 'official' || value === 'community';
}

export function normalizeSkillDiscoveryMode(value: unknown): SkillDiscoveryMode {
  if (value === undefined) return 'official';
  if (isSkillDiscoveryMode(value)) return value;
  throw new KiokukoError('VALIDATION_ERROR', `${SKILL_DISCOVERY_ENV} must be off, official, or community`);
}

export interface SkillDiscoveryConfig {
  mode: SkillDiscoveryMode;
  apiUrl: string;
  v1Token: string | null;
  githubToken: string | null;
}

function normalizeApiUrl(value: string | undefined): string {
  if (value !== undefined && value.trim().length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_SKILLS_API_URL must not be empty when set');
  }
  const apiUrl = value ?? 'https://skills.sh';
  if (apiUrl !== apiUrl.trim()) throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_SKILLS_API_URL is invalid');
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_SKILLS_API_URL is invalid');
  }
  const allowedProtocol = parsed.protocol === 'https:'
    || parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (!allowedProtocol
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || parsed.pathname !== '/') {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_SKILLS_API_URL is invalid');
  }
  return apiUrl;
}

function normalizeOptionalToken(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  if (!isBearerToken(value)) throw new KiokukoError('VALIDATION_ERROR', `${name} is invalid`);
  return value;
}

export function readSkillDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): SkillDiscoveryConfig {
  const apiUrl = normalizeApiUrl(env.KIOKUKO_SKILLS_API_URL);
  const v1Token = normalizeOptionalToken(env.KIOKUKO_SKILLS_V1_TOKEN, 'KIOKUKO_SKILLS_V1_TOKEN');
  if (v1Token !== null && !isTrustedSkillsShApiUrl(apiUrl)) {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_SKILLS_API_URL is invalid for authenticated discovery');
  }
  return {
    mode: normalizeSkillDiscoveryMode(env[SKILL_DISCOVERY_ENV]),
    apiUrl,
    v1Token,
    githubToken: normalizeOptionalToken(env.KIOKUKO_GITHUB_TOKEN, 'KIOKUKO_GITHUB_TOKEN'),
  };
}
