import type { ProjectFingerprint } from '../repository/project-fingerprint.js';

export type SkillDiscoveryMode = 'off' | 'official' | 'community';

export interface SkillRequirement {
  id: string;
  technology: string;
  aliases: string[];
  /** Aliases allowed for token-boundary fuzzy name matching; exact aliases remain supported. */
  fuzzyAliases?: string[];
  queries: string[];
  owners: string[];
  repositories: string[];
  applicability: {
    languages?: string[];
    frameworks?: Array<{ name: string; version?: string }>;
    databases?: string[];
    runtimes?: string[];
    tools?: string[];
  };
  signals: { packages?: string[] };
  reason: string;
}

export interface SkillSearchInput {
  query: string;
  owner?: string;
  limit: number;
  signal?: AbortSignal;
}

export interface SkillCandidate {
  id: string;
  provider: string;
  name: string;
  slug: string;
  source: string;
  sourceType: 'github';
  installUrl: string | null;
  installs: number;
  duplicate: boolean;
  officialStatus: 'curated' | 'catalog-verified' | 'owner-verified' | 'registry-only' | 'unknown';
  auditStatus?: SkillAuditStatus;
}

export type SkillAuditStatus = 'not-required' | 'passed' | 'failed' | 'unavailable';

export interface SkillSnapshotFile {
  path: string;
  content: string;
  contentHash: string;
  primary: boolean;
}

export interface SkillSnapshot {
  candidate: SkillCandidate;
  sourceCommit: string;
  snapshotHash: string;
  files: SkillSnapshotFile[];
  frontmatter: {
    name: string;
    description: string | null;
    disableModelInvocation: boolean;
  };
}

export interface PreparedSkillDocument {
  sourcePath: string;
  chunkIndex: number;
  title: string;
  body: string;
  summary: string | null;
  contentHash: string;
  primary: boolean;
}

export interface PreparedSkillImport {
  skill: SkillCandidate;
  sourceWorkspace: string;
  sourceCommit: string;
  snapshotHash: string;
  frontmatter: SkillSnapshot['frontmatter'];
  documents: PreparedSkillDocument[];
  requirement?: SkillRequirement;
}

export interface SkillSearchResult {
  provider: string;
  experimental: boolean;
  candidates: SkillCandidate[];
}

export interface SkillAuditResult {
  status: 'passed' | 'failed';
}

declare const skillMaterializationAuthorizationBrand: unique symbol;

/**
 * Opaque, process-local authority issued only after a provider audit passes.
 * The type brand is documentation for TypeScript callers; persistence also
 * verifies the object against a private runtime registry before writing.
 */
export interface SkillMaterializationAuthorization {
  readonly [skillMaterializationAuthorizationBrand]: true;
}

export type SkillMaterializationAuthorizationResult =
  | { status: 'not-required'; candidate: SkillCandidate }
  | { status: 'passed'; candidate: SkillCandidate; authorization: SkillMaterializationAuthorization }
  | { status: 'failed' | 'unavailable'; candidate: SkillCandidate };

export type SkillProviderFailureCode = 'registry_authentication_failed' | 'registry_unavailable' | 'registry_rate_limited' | 'registry_invalid_response';

export interface SkillRegistryProvider {
  readonly id: string;
  readonly authenticationFallback?: SkillRegistryProvider;
  search(input: SkillSearchInput): Promise<SkillSearchResult>;
  curated?(signal?: AbortSignal): Promise<SkillCandidate[] | null>;
  audit?(candidate: SkillCandidate, signal?: AbortSignal): Promise<SkillAuditResult | null>;
}

export interface SkillSourceFetcher {
  fetch(candidate: SkillCandidate, request: SkillSourceFetchRequest, signal?: AbortSignal): Promise<SkillSnapshot>;
}

export type SkillSourceFetchRequest =
  | { purpose: 'discovery' }
  | { purpose: 'refresh'; expectedPrimaryPath: string };

export interface DiscoverSkillsInput {
  project: { workspace: string; repositoryRoot: string; repositoryId: string };
  fingerprint: ProjectFingerprint;
  task: string;
  profile: { taskType: string | null; target: string | null; expected: string | null; constraints: string | null };
  recommendedTags: string[];
  capabilities?: unknown;
  mode: SkillDiscoveryMode;
  maxSelectedSkills?: 1 | 2;
  maxQueries?: 1 | 2 | 3;
  fetchImpl?: typeof fetch;
  now?: string;
  signal?: AbortSignal;
}

export interface SkillDiscoverySummary {
  attempted: boolean;
  mode: SkillDiscoveryMode;
  requirements: string[];
  queries: string[];
  cacheHits: number;
  candidates: number;
  selected: Array<{
    skillId: string;
    name: string;
    source: string;
    officialStatus: SkillCandidate['officialStatus'];
    imported: boolean;
    updated: boolean;
  }>;
  failures: Array<{ stage: 'search' | 'source' | 'validation' | 'persistence'; code: string }>;
}
