import { KiokukoError } from '../errors.js';
import {
  ENNO_CLIENT_KINDS,
  HARNESS_ADAPTERS,
  HARNESS_ADVISORS,
  HARNESS_APPROVALS,
  HARNESS_CONTINUATIONS,
  HARNESS_EXECUTION_LIFETIMES,
  HARNESS_FILESYSTEMS,
  HARNESS_NETWORKS,
  HARNESS_SURFACES,
  HARNESS_TOOL_INVENTORIES,
  HARNESS_WORKSPACE_ISOLATIONS,
  type EnnoClientKind,
  type HarnessAdapter,
  type HarnessAdvisorAvailability,
  type HarnessApprovalSurface,
  type HarnessContinuation,
  type HarnessExecutionLifetime,
  type HarnessFilesystem,
  type HarnessNetwork,
  type HarnessProfile,
  type HarnessSurface,
  type HarnessToolInventory,
  type HarnessWorkspaceIsolation,
} from './types.js';

export interface TaskClientHint {
  kind: 'opencode';
  version?: string;
  sessionId?: string;
}

export interface TaskClientHintInput {
  kind?: string | undefined;
  version?: string | undefined;
  sessionId?: string | undefined;
}

export interface McpClientImplementation {
  name: string;
  title?: string | undefined;
  version: string;
}

/**
 * Raw, untrusted evidence supplied by an adapter or a runtime probe.
 *
 * The resolver intentionally accepts unknown input so a malformed capability
 * catalog cannot become a permission.  Known fields may be supplied directly
 * or below `capabilities`, `runtimeProbe`, or `adapterInfo`; all other values
 * are ignored.
 */
export interface HarnessCapabilityEvidence {
  adapter?: unknown;
  continuation?: unknown;
  executionLifetime?: unknown;
  workspaceIsolation?: unknown;
  advisors?: unknown;
  approvals?: unknown;
  toolInventory?: unknown;
  filesystem?: unknown;
  network?: unknown;
  surfaces?: unknown;
  capabilities?: unknown;
  runtimeProbe?: unknown;
  adapterInfo?: unknown;
  [key: string]: unknown;
}

export type HarnessProfileEvidence = HarnessCapabilityEvidence;

export interface HarnessContinuationPolicy {
  mode: 'automatic' | 'manual';
  allowAdvisorFanout: boolean;
  externalMutation: 'host_review' | 'explicit_user' | 'blocked';
  requireExplicitUserConfirmation: boolean;
  reasons: string[];
}

const CLIENT_ALIASES: Readonly<Record<EnnoClientKind, readonly string[]>> = {
  opencode: ['opencode'],
};

function normalizedClientName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200
    || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return value.normalize('NFKC').toLowerCase();
}

function boundedVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100
    || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  return value;
}

export function identifyEnnoClientKind(value: unknown): EnnoClientKind | null {
  const normalized = normalizedClientName(value);
  if (normalized === null) return null;
  return ENNO_CLIENT_KINDS.find((kind) => CLIENT_ALIASES[kind].includes(normalized)) ?? null;
}

export function identifyMcpClientKind(client: McpClientImplementation | undefined): EnnoClientKind | null {
  if (client === undefined) return null;
  const fromName = identifyEnnoClientKind(client.name);
  const fromTitle = identifyEnnoClientKind(client.title);
  if (fromName !== null && fromTitle !== null && fromName !== fromTitle) {
    throw new KiokukoError('CONFLICT', 'MCP client identity is contradictory');
  }
  return fromName ?? fromTitle;
}

export function resolveTaskPrepareClient(
  explicit: TaskClientHintInput | undefined,
  runtime: McpClientImplementation | undefined,
): TaskClientHint {
  const runtimeKind = identifyMcpClientKind(runtime);
  const explicitKind = identifyEnnoClientKind(explicit?.kind);
  if (explicit?.kind !== undefined && explicitKind === null) {
    throw new KiokukoError('UNSUPPORTED_CLIENT', 'Only OpenCode is supported');
  }
  if (runtime !== undefined && runtimeKind === null) {
    throw new KiokukoError('UNSUPPORTED_CLIENT', 'Only OpenCode is supported');
  }
  if (runtimeKind !== null && explicitKind !== null && explicitKind !== runtimeKind) {
    throw new KiokukoError('CONFLICT', 'Explicit client identity conflicts with the MCP client');
  }
  if (runtimeKind !== null) {
    const runtimeVersion = boundedVersion(runtime?.version);
    return {
      kind: runtimeKind,
      ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
      ...(explicit?.sessionId === undefined ? {} : { sessionId: explicit.sessionId }),
    };
  }
  if (explicitKind === 'opencode') {
    const selected = explicit as TaskClientHintInput;
    return {
      kind: 'opencode',
      ...(selected.version === undefined ? {} : { version: selected.version }),
      ...(selected.sessionId === undefined ? {} : { sessionId: selected.sessionId }),
    };
  }
  throw new KiokukoError('UNSUPPORTED_CLIENT', 'OpenCode client identity is required');
}

type EvidenceRecord = Record<string, unknown>;

const PROFILE_ADAPTER_ALIASES: Readonly<Record<Exclude<HarnessAdapter, 'unknown'>, readonly string[]>> = {
  opencode: ['opencode', 'open-code'],
};

function evidenceRecord(value: unknown): EvidenceRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as EvidenceRecord;
}

function evidenceSources(input: unknown): EvidenceRecord[] {
  const root = evidenceRecord(input);
  if (root === null) return [];
  const sources: EvidenceRecord[] = [root];
  for (const key of ['capabilities', 'runtimeProbe', 'adapterInfo']) {
    const nested = evidenceRecord(root[key]);
    if (nested !== null) sources.push(nested);
  }
  return sources;
}

function firstEvidence(sources: readonly EvidenceRecord[], key: string): unknown {
  for (const source of sources) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      return source[key];
    }
  }
  return undefined;
}

function normalizedEvidenceString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100
    || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return value.normalize('NFKC').toLowerCase();
}

function enumEvidence<T extends string>(
  sources: readonly EvidenceRecord[],
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = normalizedEvidenceString(firstEvidence(sources, key));
  if (value === null) return undefined;
  return (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function booleanEvidence(sources: readonly EvidenceRecord[], ...keys: string[]): boolean | undefined {
  const values = keys.map((key) => firstEvidence(sources, key)).filter((value): value is boolean => typeof value === 'boolean');
  if (values.length === 0) return undefined;
  const unique = new Set(values);
  return unique.size === 1 ? values[0] : undefined;
}

function adapterEvidence(sources: readonly EvidenceRecord[]): HarnessAdapter {
  const value = normalizedEvidenceString(firstEvidence(sources, 'adapter'))
    ?? normalizedEvidenceString(firstEvidence(sources, 'adapterName'))
    ?? normalizedEvidenceString(firstEvidence(sources, 'name'));
  if (value === null) return 'unknown';
  for (const adapter of HARNESS_ADAPTERS) {
    if (adapter !== 'unknown' && PROFILE_ADAPTER_ALIASES[adapter].includes(value)) return adapter;
  }
  return 'unknown';
}

function continuationEvidence(sources: readonly EvidenceRecord[]): HarnessContinuation {
  const explicit = enumEvidence(sources, 'continuation', HARNESS_CONTINUATIONS);
  if (explicit !== undefined) return explicit;
  const candidates: HarnessContinuation[] = [];
  if (booleanEvidence(sources, 'sessionIdle', 'session_idle', 'sessionIdleAvailable') === true) candidates.push('session_idle');
  return candidates.length === 1 ? candidates[0]! : 'manual';
}

function executionLifetimeEvidence(sources: readonly EvidenceRecord[]): HarnessExecutionLifetime {
  const explicit = enumEvidence(sources, 'executionLifetime', HARNESS_EXECUTION_LIFETIMES);
  if (explicit !== undefined) return explicit;
  const candidates: HarnessExecutionLifetime[] = [];
  if (booleanEvidence(sources, 'processBound', 'process_bound') === true) candidates.push('process_bound');
  if (booleanEvidence(sources, 'taskPersistent', 'task_persistent') === true) candidates.push('task_persistent');
  if (booleanEvidence(sources, 'scheduled') === true) candidates.push('scheduled');
  return candidates.length === 1 ? candidates[0]! : 'unknown';
}

function workspaceIsolationEvidence(sources: readonly EvidenceRecord[]): HarnessWorkspaceIsolation {
  const explicit = enumEvidence(sources, 'workspaceIsolation', HARNESS_WORKSPACE_ISOLATIONS)
    ?? enumEvidence(sources, 'isolation', HARNESS_WORKSPACE_ISOLATIONS);
  if (explicit !== undefined) return explicit;
  const isolated = booleanEvidence(sources, 'isolated', 'workspaceIsolated');
  const verified = booleanEvidence(sources, 'isolationVerified', 'workspaceIsolationVerified');
  if (isolated === true && verified === true) return 'isolated';
  if (booleanEvidence(sources, 'shared', 'workspaceShared') === true) return 'shared';
  return 'unknown';
}

function advisorEvidence(sources: readonly EvidenceRecord[]): HarnessAdvisorAvailability {
  const explicit = enumEvidence(sources, 'advisors', HARNESS_ADVISORS)
    ?? enumEvidence(sources, 'advisorAvailability', HARNESS_ADVISORS);
  if (explicit !== undefined) return explicit;
  if (booleanEvidence(sources, 'advisorUnavailable', 'advisorsUnavailable') === true) return 'unavailable';
  if (booleanEvidence(sources, 'sharedWorkspaceAdvisor', 'advisorSharedWorkspace') === true) return 'shared_workspace';
  const isolated = booleanEvidence(sources, 'advisorIsolated', 'advisorIsolatedReadonly', 'advisorReadOnly');
  const verified = booleanEvidence(sources, 'advisorVerified', 'advisorIsolationVerified');
  if (isolated === true && verified === true) return 'verified_isolated_readonly';
  return 'unknown';
}

function approvalEvidence(sources: readonly EvidenceRecord[]): HarnessApprovalSurface {
  const explicit = enumEvidence(sources, 'approvals', HARNESS_APPROVALS)
    ?? enumEvidence(sources, 'approvalSurface', HARNESS_APPROVALS);
  if (explicit !== undefined) return explicit;
  if (booleanEvidence(sources, 'hostReview', 'host_review') === true) return 'host_review';
  if (booleanEvidence(sources, 'explicitUser', 'userConfirmation', 'explicit_user') === true) return 'explicit_user';
  return 'unavailable';
}

function toolInventoryEvidence(sources: readonly EvidenceRecord[]): HarnessToolInventory {
  const explicit = enumEvidence(sources, 'toolInventory', HARNESS_TOOL_INVENTORIES);
  if (explicit !== undefined) return explicit;
  const complete = booleanEvidence(sources, 'toolInventoryComplete', 'toolsComplete');
  if (complete === true) return 'complete';
  if (complete === false || Array.isArray(firstEvidence(sources, 'tools'))) return 'partial';
  return 'unknown';
}

function filesystemEvidence(sources: readonly EvidenceRecord[]): HarnessFilesystem {
  const explicit = enumEvidence(sources, 'filesystem', HARNESS_FILESYSTEMS);
  if (explicit !== undefined) return explicit;
  const candidates: HarnessFilesystem[] = [];
  for (const [key, value] of [
    ['localReadWrite', 'local_read_write'],
    ['localReadOnly', 'local_read_only'],
    ['remotePersistent', 'remote_persistent'],
    ['ephemeral', 'ephemeral'],
    ['none', 'none'],
  ] as const) {
    if (booleanEvidence(sources, key) === true) candidates.push(value);
  }
  return candidates.length === 1 ? candidates[0]! : 'unknown';
}

function networkEvidence(sources: readonly EvidenceRecord[]): HarnessNetwork {
  const explicit = enumEvidence(sources, 'network', HARNESS_NETWORKS);
  if (explicit !== undefined) return explicit;
  const candidates: HarnessNetwork[] = [];
  for (const [key, value] of [
    ['networkOpen', 'open'],
    ['allowlistedNetwork', 'allowlisted'],
    ['networkNone', 'none'],
  ] as const) {
    if (booleanEvidence(sources, key) === true) candidates.push(value);
  }
  return candidates.length === 1 ? candidates[0]! : 'unknown';
}

function surfaceEvidence(sources: readonly EvidenceRecord[]): HarnessSurface[] {
  const value = firstEvidence(sources, 'surfaces');
  const fromArray = Array.isArray(value)
    ? value.map(normalizedEvidenceString).filter((entry): entry is string => entry !== null)
    : [];
  const booleans: Array<[string, HarnessSurface]> = [
    ['progressSurface', 'progress'],
    ['approvalSurfaceAvailable', 'approval'],
    ['artifactSurface', 'artifact'],
    ['browserSurface', 'browser'],
    ['taskSurface', 'task'],
  ];
  for (const [key, surface] of booleans) {
    if (booleanEvidence(sources, key) === true) fromArray.push(surface);
  }
  return HARNESS_SURFACES.filter((surface) => fromArray.includes(surface));
}

/**
 * Convert raw capability evidence into the stable, fail-closed public profile.
 * No prompt text or adapter name is used to infer capabilities.
 */
export function resolveHarnessProfile(input: unknown): HarnessProfile {
  const sources = evidenceSources(input);
  const profile: HarnessProfile = {
    profileVersion: 1,
    adapter: adapterEvidence(sources),
    continuation: continuationEvidence(sources),
    executionLifetime: executionLifetimeEvidence(sources),
    workspaceIsolation: workspaceIsolationEvidence(sources),
    advisors: advisorEvidence(sources),
    approvals: approvalEvidence(sources),
    toolInventory: toolInventoryEvidence(sources),
    filesystem: filesystemEvidence(sources),
    network: networkEvidence(sources),
    surfaces: surfaceEvidence(sources),
  };
  return Object.freeze({ ...profile, surfaces: Object.freeze(profile.surfaces) as unknown as HarnessSurface[] });
}

export const deriveHarnessProfile = resolveHarnessProfile;

/**
 * Decide orchestration permissions using only the already-derived profile.
 * Unknown or absent evidence never enables an automatic or mutating path.
 */
export function decideContinuationPolicy(profile: HarnessProfile): HarnessContinuationPolicy {
  const reasons: string[] = [];
  const automatic = profile.continuation !== 'manual';
  if (!automatic) reasons.push('automatic_continuation_unverified');

  const allowAdvisorFanout = profile.advisors === 'verified_isolated_readonly';
  if (!allowAdvisorFanout) reasons.push('advisor_isolation_unverified');

  let externalMutation: HarnessContinuationPolicy['externalMutation'] = 'blocked';
  if (profile.filesystem === 'local_read_write' || profile.filesystem === 'remote_persistent') {
    if (profile.approvals === 'host_review' && profile.network !== 'unknown' && profile.network !== 'none') {
      externalMutation = 'host_review';
    } else if (profile.approvals === 'explicit_user') {
      externalMutation = 'explicit_user';
    }
  }
  if (externalMutation === 'blocked') reasons.push('external_mutation_not_verified');

  return {
    mode: automatic ? 'automatic' : 'manual',
    allowAdvisorFanout,
    externalMutation,
    requireExplicitUserConfirmation: externalMutation === 'explicit_user',
    reasons,
  };
}
