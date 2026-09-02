import type { EntryRecord } from './entries.js';
import { GLOBAL_WORKSPACE } from './workspaces.js';

export const CURATOR_DRAFT_VERSION = 'deterministic-v1' as const;
export const CURATOR_MEMORY_ACTOR = 'kiokuko-curator' as const;

function hasCuratorReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const suffix = `#${CURATOR_DRAFT_VERSION}`;
  if (!value.endsWith(suffix)) return false;
  const identity = value.slice(0, -suffix.length);
  const separator = identity.lastIndexOf('@');
  if (separator <= 0) return false;
  const revision = Number(identity.slice(separator + 1));
  return Number.isSafeInteger(revision) && revision > 0;
}

type CuratorTrustInput = Pick<EntryRecord,
  'workspace' | 'status' | 'scope' | 'provenance' | 'trustLevel' | 'revision'
  | 'verifiedAt' | 'createdBy' | 'createdAt' | 'updatedAt' | 'tags'
>;

function hasCuratorProjectionIdentity(entry: CuratorTrustInput): boolean {
  const scope = entry.scope as Record<string, unknown>;
  const provenance = entry.provenance as Record<string, unknown>;
  return entry.workspace === GLOBAL_WORKSPACE
    && entry.revision === 1
    && entry.createdBy === CURATOR_MEMORY_ACTOR
    && entry.updatedAt === entry.createdAt
    && scope.schemaVersion === 1
    && scope.visibility === 'global'
    && scope.retrievalScope === 'global'
    && provenance.type === 'curator_globalize'
    && hasCuratorReference(provenance.reference)
    && typeof provenance.sourceWorkspace === 'string'
    && provenance.sourceWorkspace.length > 0
    && provenance.sourceWorkspace !== GLOBAL_WORKSPACE
    && provenance.clientKind === CURATOR_MEMORY_ACTOR
    && provenance.timestamp === entry.createdAt
    && entry.tags.includes('skill:curated')
    && entry.tags.includes(`curator:${CURATOR_DRAFT_VERSION}`);
}

/** Identify a current Curator projection whose provenance and lifecycle are system-verified. */
export function isTrustedCuratorGlobalMemory(entry: CuratorTrustInput): boolean {
  return hasCuratorProjectionIdentity(entry)
    && entry.status === 'verified'
    && entry.trustLevel === 'system_verified'
    && entry.verifiedAt === entry.createdAt;
}

export function isCuratorManagedGlobalMemory(entry: CuratorTrustInput): boolean {
  return isTrustedCuratorGlobalMemory(entry);
}
