import { readSkillDiscoveryConfig } from './config.js';
import { OFFICIAL_SKILL_REPOSITORIES } from './official-catalog.js';
import { SkillsShCompatibilityProvider } from './providers/skills-sh-compat.js';
import { SkillsShV1Provider } from './providers/skills-sh-v1.js';
import { SkillProviderError } from './providers/schema.js';
import { validateSkillSearchScope } from './query-builder.js';
import type { SkillRegistryProvider, SkillSearchResult } from './types.js';
import { KiokukoError } from '../errors.js';

const TRUSTED_OFFICIAL_STATUSES = new Set(['curated', 'catalog-verified', 'owner-verified']);

export interface FindSkillsInput {
  query: string;
  owner?: string;
  officialOnly?: boolean;
  limit?: number;
  signal?: AbortSignal;
}

export interface FindSkillsDependencies {
  provider?: SkillRegistryProvider;
  fetchImpl?: typeof fetch;
  fallbackOnAuthentication?: boolean;
}

export function createSkillRegistryProvider(fetchImpl?: typeof fetch): SkillRegistryProvider {
  const config = readSkillDiscoveryConfig();
  const compatibility = new SkillsShCompatibilityProvider({
    apiUrl: config.apiUrl,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    officialRepositories: OFFICIAL_SKILL_REPOSITORIES,
  });
  return config.v1Token
    ? new SkillsShV1Provider({
      apiUrl: config.apiUrl,
      token: config.v1Token,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      officialRepositories: OFFICIAL_SKILL_REPOSITORIES,
      authenticationFallback: compatibility,
    })
    : compatibility;
}

/** Shared implementation for Akinator discovery and `kiokuko-ai skills find`. */
export async function findSkills(
  input: FindSkillsInput,
  dependencies: FindSkillsDependencies = {},
): Promise<SkillSearchResult> {
  const { query, owner } = validateSkillSearchScope(input.query, input.owner);
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill search limit is invalid');
  }
  const provider = dependencies.provider ?? createSkillRegistryProvider(dependencies.fetchImpl);
  const searchInput = {
    query,
    limit,
    ...(owner === undefined ? {} : { owner }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  let result: SkillSearchResult;
  try {
    result = await provider.search(searchInput);
  } catch (error) {
    if (!(error instanceof SkillProviderError)
      || error.code !== 'registry_authentication_failed'
      || dependencies.fallbackOnAuthentication === false
      || provider.authenticationFallback === undefined) throw error;
    result = await provider.authenticationFallback.search(searchInput);
  }
  if (input.officialOnly !== true) return result;
  return {
    ...result,
    candidates: result.candidates.filter((candidate) => TRUSTED_OFFICIAL_STATUSES.has(candidate.officialStatus)),
  };
}
