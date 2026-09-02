import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { withImmediateTransaction } from '../db/transaction.js';
import type { TaskProfile } from '../akinator/types.js';
import {
  listContextDeliveries,
  readContextDelivery,
  recordContextDeliveryInTransaction,
  type ContextDeliveryInput,
  type ContextDeliveryView,
} from './delivery.js';
import { contextFeedbackSignals } from './feedback.js';
import { buildRecommendations, RECOMMENDATION_POLICY_VERSION, type Recommendation } from './recommendations.js';
import { CONTEXT_RANKING_VERSION, CONTEXT_SELECTION_REASON_ORDER, rankContextCandidates, type RankedCandidate } from './ranking.js';
import { rankedEntryHits } from '../memory/retrieval.js';
import { readEntry, type EntryRecord } from '../memory/entries.js';
import { decodeStoredStructuredScope, readEntryRevision } from '../memory/revisions.js';
import { federatedEntries, type FederatedOrigin } from '../memory/federated-retrieval.js';
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js';
import { GLOBAL_WORKSPACE } from '../memory/workspaces.js';
import { effectiveRetrievalScope, hasExplicitApplicability } from '../memory/structured-memory.js';
import type { LedgerProjection } from '../ledger/projection.js';
import type { RunRecord } from '../ledger/types.js';
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js';
import { entryOriginMatchesWorkspace } from './origin.js';
import { isExternalSkillReference } from '../skills/store.js';
import { contextRetrievalStateHash } from './selection-state.js';
import { readContextRunRetrievalState, type ContextRunRetrievalState } from './run-state.js';
import { prepareEmbeddingSearchRuntime } from '../embedding/runtime.js';
import type { EmbeddingRuntime } from '../embedding/types.js';
import {
  captureProjectManifestSnapshot,
  resolveProjectFingerprint,
  type ProjectFingerprint,
} from '../repository/project-fingerprint.js';
import type { ResolvedProjectWorkspace } from '../memory/workspaces.js';

export const CONTEXT_BROKER_POLICY_VERSION = `${CONTEXT_RANKING_VERSION}+${RECOMMENDATION_POLICY_VERSION}` as const;
export const CONTEXT_BROKER_DEFAULT_LIMIT = 20;
export const CONTEXT_BROKER_MAX_LIMIT = 100;
export const CONTEXT_BROKER_DEFAULT_CHARACTER_BUDGET = 8_000;
export const CONTEXT_BROKER_MAX_CHARACTER_BUDGET = 100_000;

export interface ContextBrokerQueryInput {
  workspace?: string;
  runId?: string;
  task?: string;
  taskProfile?: TaskProfile;
  recommendedTags?: string[];
  changedPaths?: string[];
  errorSignatures?: string[];
  limit?: number;
  characterBudget?: number;
}

export interface ContextBrokerContextItem {
  entryId: string;
  entryRevision: number;
  rank: number;
  scoreComponents: RankedCandidate['scoreComponents'];
  selectionReasons: string[];
  content: RankedCandidate['content'];
  untrusted: true;
  origin?: FederatedOrigin;
}

export interface ContextBrokerContext {
  deliveryId: string | null;
  runId: string | null;
  throughSequence: number;
  taskProfileHash: string;
  queryHash: string;
  policyVersion: typeof CONTEXT_BROKER_POLICY_VERSION;
  items: ContextBrokerContextItem[];
  untrusted: true;
}

export interface ContextBrokerResult {
  status: 'needs_answer' | 'ready' | 'exhausted' | 'unbound';
  taskProfile: TaskProfile;
  profileHash: string;
  acceptedThrough: number;
  intakeSessionId: string | null;
  recommendedTags: string[];
  projection: LedgerProjection | null;
  context: ContextBrokerContext | null;
  recommendations: Recommendation[];
}

export interface ContextBrokerPersistence {
  enqueueWrite?: <T>(operation: () => T) => Promise<T> | T;
}

export interface ContextBrokerGateDecision<T> {
  persist: boolean;
  value: T;
  assertBeforePersist?: () => void;
}

export interface ContextBrokerGatedResult<T> {
  broker: ContextBrokerResult;
  value: T;
}

function normalizedGateDecision<T>(value: unknown): ContextBrokerGateDecision<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Context broker gate returned an invalid decision');
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== 'string'
      || key !== 'persist' && key !== 'value' && key !== 'assertBeforePersist')
    || !keys.includes('persist')
    || !keys.includes('value')) {
    throw new TypeError('Context broker gate returned an invalid decision');
  }
  const persistDescriptor = Object.getOwnPropertyDescriptor(value, 'persist');
  const resultDescriptor = Object.getOwnPropertyDescriptor(value, 'value');
  const assertionDescriptor = Object.getOwnPropertyDescriptor(value, 'assertBeforePersist');
  if (persistDescriptor === undefined
    || !Object.hasOwn(persistDescriptor, 'value')
    || typeof persistDescriptor.value !== 'boolean'
    || resultDescriptor === undefined
    || !Object.hasOwn(resultDescriptor, 'value')
    || assertionDescriptor !== undefined
      && (!Object.hasOwn(assertionDescriptor, 'value') || typeof assertionDescriptor.value !== 'function')) {
    throw new TypeError('Context broker gate returned an invalid decision');
  }
  return {
    persist: persistDescriptor.value as boolean,
    value: resultDescriptor.value as T,
    ...(assertionDescriptor === undefined
      ? {}
      : { assertBeforePersist: assertionDescriptor.value as () => void }),
  };
}

type RunContext = ContextRunRetrievalState;

export interface ContextBrokerRunState {
  run: RunRecord;
  taskProfile: TaskProfile;
  profileHash: string;
  recommendedTags: string[];
  intakeSessionId: string;
  status: 'needs_answer' | 'ready' | 'exhausted';
}

interface PreparedQuery {
  workspace: string;
  selectionWorkspaces: string[];
  includeEcosystem: boolean;
  run: RunRecord | null;
  taskProfile: TaskProfile;
  profileHash: string;
  recommendedTags: string[];
  changedPaths: string[];
  errorSignatures: string[];
  task: string;
  limit: number;
  characterBudget: number;
  throughSequence: number;
  intakeSessionId: string | null;
  projection: LedgerProjection | null;
  runStatus: ContextBrokerResult['status'];
  projectState: { project: ResolvedProjectWorkspace; fingerprint: ProjectFingerprint } | null;
  retrievalStateHash: string | null;
  runStateHash: string | null;
  deliveryHistoryStateHash: string | null;
  deliveryHistoryExcludeQueryHash: string | null;
  queryHash: string;
  deliveryId: string | null;
}

interface PreparedBrokerResult {
  result: ContextBrokerResult;
  replayDelivery: ContextDeliveryView | null;
  pendingDelivery: {
    query: PreparedQuery;
    ranked: RankedCandidate[];
    input: ContextDeliveryInput;
  } | null;
}

function contextDeliverySnapshotHash(delivery: ContextDeliveryView): string {
  return canonicalContentHash({
    workspace: delivery.workspace,
    deliveryId: delivery.deliveryId,
    runId: delivery.runId,
    throughSequence: delivery.throughSequence,
    intakeSessionId: delivery.intakeSessionId,
    taskProfileHash: delivery.taskProfileHash,
    queryHash: delivery.queryHash,
    policyVersion: delivery.policyVersion,
    charBudget: delivery.charBudget,
    charCount: delivery.charCount,
    truncated: delivery.truncated,
    createdAt: delivery.createdAt,
    scoreSchemaVersion: delivery.scoreSchemaVersion ?? 1,
    items: delivery.items.map((item) => ({
      entryId: item.entryId,
      entryRevision: item.entryRevision,
      rank: item.rank,
      scoreComponents: item.scoreComponents,
      selectionReasons: item.selectionReasons,
      ...(item.origin === undefined ? {} : { origin: item.origin }),
    })),
  });
}

function assertReplayDeliveryUnchanged(database: SqliteDatabase, expected: ContextDeliveryView): void {
  let current: ContextDeliveryView;
  try {
    current = readContextDelivery(database, {
      workspace: expected.workspace,
      deliveryId: expected.deliveryId,
    });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery disappeared during replay');
    }
    throw error;
  }
  if (contextDeliverySnapshotHash(current) !== contextDeliverySnapshotHash(expected)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery changed during replay');
  }
}

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Context query input is invalid');
}

function notFound(): never {
  throw new KiokukoError('NOT_FOUND', 'Context run was not found');
}

function isTaskProfile(value: unknown): value is TaskProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return Object.keys(profile).length === 4
    && ['taskType', 'target', 'expected', 'constraints'].every((field) => Object.hasOwn(profile, field))
    && (profile.taskType === null || ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'].includes(String(profile.taskType)))
    && ['target', 'expected', 'constraints'].every((field) => profile[field] === null || typeof profile[field] === 'string');
}

function boundedStringArray(value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 2_000)) invalid();
  return [...new Set(value as string[])].sort();
}

function normalizeInput(input: unknown): ContextBrokerQueryInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  const allowed = new Set(['apiVersion', 'workspace', 'runId', 'task', 'taskProfile', 'recommendedTags', 'changedPaths', 'errorSignatures', 'limit', 'characterBudget']);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  if (value.apiVersion !== undefined && value.apiVersion !== '1') invalid();
  if (value.workspace !== undefined && (typeof value.workspace !== 'string' || value.workspace.length === 0 || value.workspace.length > 256)) invalid();
  if (value.runId === undefined && value.workspace === undefined) invalid();
  if (value.runId !== undefined && (typeof value.runId !== 'string' || value.runId.length === 0 || value.runId.length > 256)) invalid();
  if (value.task !== undefined && (typeof value.task !== 'string' || value.task.length > 16_384)) invalid();
  if (value.taskProfile !== undefined && !isTaskProfile(value.taskProfile)) invalid();
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > CONTEXT_BROKER_MAX_LIMIT)) invalid();
  if (value.characterBudget !== undefined && (typeof value.characterBudget !== 'number' || !Number.isSafeInteger(value.characterBudget) || value.characterBudget < 1 || value.characterBudget > CONTEXT_BROKER_MAX_CHARACTER_BUDGET)) invalid();
  return {
    ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.task === undefined ? {} : { task: value.task }),
    ...(value.taskProfile === undefined ? {} : { taskProfile: value.taskProfile }),
    recommendedTags: boundedStringArray(value.recommendedTags, 500),
    changedPaths: boundedStringArray(value.changedPaths, 500),
    errorSignatures: boundedStringArray(value.errorSignatures, 500),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(value.characterBudget === undefined ? {} : { characterBudget: value.characterBudget as number }),
  };
}

function normalizePersistence(value: unknown): ContextBrokerPersistence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Context broker persistence adapter is invalid');
  }
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  const keys = Reflect.ownKeys(object);
  const descriptor = Object.getOwnPropertyDescriptor(object, 'enqueueWrite');
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => key !== 'enqueueWrite')
    || descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('Context broker persistence adapter is invalid');
  }
  const enqueueWrite = descriptor?.value;
  if (enqueueWrite !== undefined && typeof enqueueWrite !== 'function') {
    throw new TypeError('Context broker persistence adapter is invalid');
  }
  return enqueueWrite === undefined
    ? {}
    : { enqueueWrite: enqueueWrite as NonNullable<ContextBrokerPersistence['enqueueWrite']> };
}

function currentRunContext(database: SqliteDatabase, runId: string): RunContext {
  try {
    return readContextRunRetrievalState(database, runId);
  } catch (error) {
    if (error instanceof KiokukoError
      && error.code === 'NOT_FOUND'
      && error.message === 'Context run was not found') {
      notFound();
    }
    throw error;
  }
}

/** Read the same authoritative run/intake/profile snapshot used to rank broker context. */
export function readContextBrokerRunState(database: SqliteDatabase, runId: string): ContextBrokerRunState {
  const current = currentRunContext(database, runId);
  return {
    run: current.run,
    taskProfile: { ...current.profile },
    profileHash: current.profileHash,
    recommendedTags: [...current.recommendedTags],
    intakeSessionId: current.intakeSessionId,
    status: current.intakeStatus === 'active' ? 'needs_answer' : current.intakeStatus,
  };
}

function preparedQuery(database: SqliteDatabase, input: ContextBrokerQueryInput): PreparedQuery {
  const runContext = input.runId === undefined ? null : currentRunContext(database, input.runId);
  const requestedWorkspace = input.workspace ?? 'run-bound';
  const profile = runContext?.profile ?? input.taskProfile;
  if (profile === undefined || !isTaskProfile(profile)) invalid();
  const task = runContext?.run.title ?? input.task ?? [profile.target, profile.expected, profile.constraints].filter((value): value is string => value !== null).join(' ');
  const throughSequence = runContext?.run.lastSequence ?? 0;
  const taskProfileHash = runContext?.profileHash ?? canonicalContentHash(profile);
  const recommendedTags = runContext?.recommendedTags ?? input.recommendedTags ?? [];
  const workspace = runContext?.run.workspace ?? requestedWorkspace;
  const project = projectForWorkspace(database, workspace);
  const projectState = project === undefined
    ? null
    : {
        project,
        fingerprint: resolveProjectFingerprint(
          database,
          project,
          captureProjectManifestSnapshot(project),
        ),
      };
  const includeEcosystem = projectState !== null;
  const selectionWorkspaces = !includeEcosystem
    ? [workspace]
    : [workspace, GLOBAL_WORKSPACE];
  const retrievalStateHash = runContext === null || runContext.intakeStatus !== 'active'
    ? contextRetrievalStateHash(database, selectionWorkspaces, { includeEcosystem })
    : null;
  const queryShape = {
    runId: input.runId ?? null,
    workspace: input.runId === undefined ? requestedWorkspace : null,
    task,
    taskProfile: profile,
    recommendedTags: [...recommendedTags].sort(),
    changedPaths: input.changedPaths ?? [],
    errorSignatures: input.errorSignatures ?? [],
    throughSequence,
    characterBudget: input.characterBudget ?? CONTEXT_BROKER_DEFAULT_CHARACTER_BUDGET,
    limit: input.limit ?? CONTEXT_BROKER_DEFAULT_LIMIT,
    projectState,
    retrievalStateHash,
    runStateHash: runContext?.stateHash ?? null,
  };
  const queryHash = canonicalContentHash(queryShape);
  return {
    workspace,
    selectionWorkspaces,
    includeEcosystem,
    run: runContext?.run ?? null,
    taskProfile: profile,
    profileHash: taskProfileHash,
    recommendedTags,
    changedPaths: input.changedPaths ?? [],
    errorSignatures: input.errorSignatures ?? [],
    task,
    limit: input.limit ?? CONTEXT_BROKER_DEFAULT_LIMIT,
    characterBudget: input.characterBudget ?? CONTEXT_BROKER_DEFAULT_CHARACTER_BUDGET,
    throughSequence,
    intakeSessionId: runContext?.intakeSessionId ?? null,
    projection: runContext?.projection ?? null,
    runStatus: runContext === null ? 'unbound' : runContext.intakeStatus === 'active' ? 'needs_answer' : runContext.intakeStatus,
    projectState,
    retrievalStateHash,
    runStateHash: runContext?.stateHash ?? null,
    deliveryHistoryStateHash: null,
    deliveryHistoryExcludeQueryHash: null,
    queryHash,
    deliveryId: null,
  };
}

function entrySnapshot(entry: EntryRecord, origin?: FederatedOrigin, selectionReasons: string[] = []): Parameters<typeof rankContextCandidates>[0] extends infer _ ? {
  id: string; revision: number; kind: EntryRecord['kind']; status: EntryRecord['status']; trustLevel: EntryRecord['trustLevel']; confidence: number;
  title: string; summary: string | null; body: string; tags: string[]; scope: JsonObject; updatedAt: string;
  selectionReasons: string[];
  origin?: FederatedOrigin;
} : never {
  return {
    id: entry.id,
    revision: entry.revision,
    kind: entry.kind,
    status: entry.status,
    trustLevel: entry.trustLevel,
    confidence: entry.confidence,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: [...entry.tags],
    scope: entry.scope,
    updatedAt: entry.updatedAt,
    selectionReasons: [...selectionReasons],
    ...(origin === undefined ? {} : { origin }),
  };
}

type JsonObject = Record<string, unknown>;

function retrievalQuery(query: PreparedQuery): string {
  const values = [query.task, query.taskProfile.target, query.taskProfile.expected, ...query.recommendedTags].filter((value): value is string => value !== null && value.length > 0);
  return values.join(' ').slice(0, 16_384) || 'kiokuko';
}

interface RetrievedEntry {
  entry: EntryRecord;
  origin: FederatedOrigin;
  selectionReasons: string[];
}

const APPLICABILITY_DETAIL_REASONS = new Set([
  'language_match',
  'database_match',
  'runtime_match',
  'tool_match',
  'platform_match',
  'framework_exact_match',
  'framework_match',
]);

function canonicalRetrievedReasons(reasons: readonly string[]): string[] {
  const normalized = reasons.map((reason) => {
    if (APPLICABILITY_DETAIL_REASONS.has(reason)) return 'applicability_match';
    if (CONTEXT_SELECTION_REASON_ORDER.includes(reason as (typeof CONTEXT_SELECTION_REASON_ORDER)[number])) return reason;
    throw new KiokukoError('INTEGRITY_ERROR', 'Retrieval returned an unknown selection reason');
  });
  const rank = (reason: string): number => CONTEXT_SELECTION_REASON_ORDER.indexOf(reason as (typeof CONTEXT_SELECTION_REASON_ORDER)[number]);
  return [...new Set(normalized)].sort((left, right) => rank(left) - rank(right) || compareCanonicalStrings(left, right));
}

function addRetrievedEntry(entries: Map<string, RetrievedEntry>, value: RetrievedEntry): void {
  const existing = entries.get(value.entry.id);
  entries.set(value.entry.id, {
    ...value,
    selectionReasons: canonicalRetrievedReasons([...(existing?.selectionReasons ?? []), ...value.selectionReasons]),
  });
}

function projectForWorkspace(database: SqliteDatabase, workspace: string): ResolvedProjectWorkspace | undefined {
  const row = database.prepare(`
    SELECT r.repository_id AS repositoryId, r.workspace, l.canonical_root AS repositoryRoot
      FROM repositories AS r JOIN repository_locations AS l ON l.repository_id = r.repository_id
     WHERE r.workspace = ? ORDER BY l.last_seen_at DESC, l.canonical_root ASC LIMIT 1
  `).get<{ repositoryId: unknown; workspace: unknown; repositoryRoot: unknown }>(workspace);
  if (row === undefined) return undefined;
  const { repositoryId, repositoryRoot, workspace: storedWorkspace } = row;
  if (typeof repositoryId !== 'string' || repositoryId.length === 0
    || typeof storedWorkspace !== 'string' || storedWorkspace !== workspace
    || typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context project binding is invalid');
  }
  return { repositoryRoot, repositoryId, workspace: storedWorkspace, source: 'location' };
}

async function retrieveEntries(
  database: SqliteDatabase,
  query: PreparedQuery,
  runtime: import('../memory/hybrid-retrieval.js').HybridSearchRuntime,
): Promise<RetrievedEntry[]> {
  const terms = [query.task, query.taskProfile.target, query.taskProfile.expected, ...query.recommendedTags]
    .filter((value): value is string => value !== null && value.length > 0)
    .map((value) => value.slice(0, 2_000));
  const queries = [retrievalQuery(query), ...terms];
  const entries = new Map<string, RetrievedEntry>();
  for (const value of queries) {
    if (query.projectState !== null) {
        for (const hit of await federatedEntries(database, {
        project: query.projectState.project,
        fingerprint: query.projectState.fingerprint,
        query: value,
        limit: 500,
        }, runtime)) {
        addRetrievedEntry(entries, { entry: hit.entry, origin: hit.origin, selectionReasons: hit.selectionReasons });
      }
    } else {
      for (const hit of rankedEntryHits(database, { workspace: query.workspace, query: value, limit: 500, includeSuperseded: false }, runtime).hits) {
        addRetrievedEntry(entries, {
          entry: readEntry(database, { workspace: query.workspace, entryId: hit.entryId }),
          origin: 'project',
          selectionReasons: ['project_origin', ...hit.reasons],
        });
      }
    }
  }
  return [...entries.values()];
}

function assertPreparedProjectState(database: SqliteDatabase, query: PreparedQuery): void {
  const currentProject = projectForWorkspace(database, query.workspace);
  if (query.projectState === null) {
    if (currentProject !== undefined) {
      throw new KiokukoError('CONFLICT', 'Context project state changed after ranking');
    }
    return;
  }
  if (currentProject === undefined
    || canonicalContentHash(currentProject) !== canonicalContentHash(query.projectState.project)) {
    throw new KiokukoError('CONFLICT', 'Context project state changed after ranking');
  }
  const manifestSnapshot = captureProjectManifestSnapshot(currentProject);
  if (manifestSnapshot.manifestDigest !== query.projectState.fingerprint.manifestDigest) {
    throw new KiokukoError('CONFLICT', 'Context project state changed after ranking');
  }
  const currentFingerprint = resolveProjectFingerprint(
    database,
    currentProject,
    manifestSnapshot,
    { readOnly: true },
  );
  if (canonicalContentHash(currentFingerprint) !== canonicalContentHash(query.projectState.fingerprint)) {
    throw new KiokukoError('CONFLICT', 'Context project state changed after ranking');
  }
}

async function rank(
  database: SqliteDatabase,
  query: PreparedQuery,
  prior: ReturnType<typeof priorData>,
  runtime: import('../memory/hybrid-retrieval.js').HybridSearchRuntime,
): Promise<RankedCandidate[]> {
  const entries = await retrieveEntries(database, query, runtime);
  const feedback = entries.flatMap(({ entry }) => contextFeedbackSignals(database, entry.id).flatMap((signal) =>
    Array.from({ length: signal.boundedInfluence }, () => ({ entryId: entry.id, verdict: signal.verdict }))));
  return rankContextCandidates({
    taskProfile: query.taskProfile,
    recommendedTags: query.recommendedTags,
    changedPaths: query.changedPaths,
    errorSignatures: query.errorSignatures,
    priorDelivered: prior.delivered,
    feedback,
    candidates: entries.map(({ entry, origin, selectionReasons }) => entrySnapshot(entry, origin, selectionReasons)),
    limit: query.limit,
    characterBudget: query.characterBudget,
  });
}

interface PriorData {
  delivered: Array<{ entryId: string; revision: number }>;
  stale: Array<{ entryId: string; deliveredRevision: number; currentRevision: number; stale: true }>;
  stateHash: string | null;
}

interface PriorDataOptions {
  excludeDeliveredQueryHash?: string;
  excludeDeliveryId?: string;
}

function priorData(database: SqliteDatabase, query: PreparedQuery, options: PriorDataOptions = {}): PriorData {
  if (query.run === null) return { delivered: [], stale: [], stateHash: null };
  const deliveries = [] as ContextDeliveryView[];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < 10; page += 1) {
    const result = listContextDeliveries(database, { workspace: query.workspace, runId: query.run.runId, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    deliveries.push(...result.items);
    if (result.nextCursor === null) {
      complete = true;
      break;
    }
    cursor = result.nextCursor;
  }
  if (!complete) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Context delivery history exceeds the broker policy bound');
  }
  for (const delivery of deliveries) {
    for (const item of delivery.items) {
      currentRetrievableDeliveryEntry(database, query.workspace, item);
    }
  }
  const stateDeliveries = deliveries.filter((delivery) => delivery.deliveryId !== options.excludeDeliveryId);
  const delivered = stateDeliveries
    .filter((delivery) => delivery.queryHash !== options.excludeDeliveredQueryHash)
    .flatMap((delivery) => delivery.items.flatMap((item) => contextFeedbackSignals(database, item.entryId)
      .some((signal) => signal.verdict === 'helpful')
      ? []
      : [{ entryId: item.entryId, revision: item.entryRevision }]));
  const stale = stateDeliveries.flatMap((delivery) => delivery.items.flatMap((item) => {
    const current = database.prepare('SELECT current_revision FROM entries WHERE id = ?').get<{ current_revision: number }>(item.entryId);
    return current && Number(current.current_revision) > item.entryRevision ? [{ entryId: item.entryId, deliveredRevision: item.entryRevision, currentRevision: Number(current.current_revision), stale: true as const }] : [];
  }));
  return {
    delivered,
    stale,
    stateHash: canonicalContentHash({
      runId: query.run.runId,
      excludeDeliveredQueryHash: options.excludeDeliveredQueryHash ?? null,
      deliveries: stateDeliveries.map(contextDeliverySnapshotHash),
      delivered,
      stale,
    }),
  };
}

function historyAttestedDeliveryId(
  query: PreparedQuery,
  historyStateHash: string,
  excludeDeliveredQueryHash: string | null,
): string {
  return `context-${canonicalContentHash({
    kind: 'context-delivery-history-attestation-v1',
    queryHash: query.queryHash,
    historyStateHash,
    excludeDeliveredQueryHash,
  })}`;
}

function deliveryHistoryExclusionForReplay(
  database: SqliteDatabase,
  query: PreparedQuery,
  deliveryId: string,
): string | null {
  if (query.run === null) return null;
  const priorSameQuery = database.prepare(`
    SELECT 1 AS present
      FROM context_deliveries
     WHERE run_id = ? AND query_hash = ? AND delivery_id <> ?
     LIMIT 1
  `).get<{ present: unknown }>(query.run.runId, query.queryHash, deliveryId);
  if (priorSameQuery === undefined) return null;
  if (priorSameQuery.present !== 1) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery history is invalid');
  }
  return query.queryHash;
}

function deliveryHistoryIsAttested(
  database: SqliteDatabase,
  query: PreparedQuery,
  delivery: ContextDeliveryView,
): boolean {
  const excludeDeliveredQueryHash = deliveryHistoryExclusionForReplay(
    database,
    query,
    delivery.deliveryId,
  );
  const history = priorData(database, query, {
    ...(excludeDeliveredQueryHash === null ? {} : { excludeDeliveredQueryHash }),
    excludeDeliveryId: delivery.deliveryId,
  });
  if (history.stateHash === null) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery history is invalid');
  }
  return delivery.deliveryId === historyAttestedDeliveryId(
    query,
    history.stateHash,
    excludeDeliveredQueryHash,
  );
}

function outputContext(query: PreparedQuery, items: RankedCandidate[], delivery: ContextDeliveryView | null): ContextBrokerContext {
  const sourceItems = items.map((item, index) => ({
    entryId: item.entryId,
    entryRevision: item.revision,
    rank: index + 1,
    scoreComponents: { ...item.scoreComponents },
    selectionReasons: [...item.selectionReasons],
    content: { ...item.content },
    untrusted: true as const,
    ...(item.origin === undefined ? {} : { origin: item.origin }),
  }));
  return {
    deliveryId: delivery?.deliveryId ?? query.deliveryId,
    runId: query.run?.runId ?? null,
    throughSequence: query.throughSequence,
    taskProfileHash: query.profileHash,
    queryHash: query.queryHash,
    policyVersion: CONTEXT_BROKER_POLICY_VERSION,
    items: sourceItems,
    untrusted: true,
  };
}

function deliveryInput(query: PreparedQuery, ranked: RankedCandidate[]): ContextDeliveryInput {
  const items = ranked.map((item, index) => ({
    entryId: item.entryId,
    entryRevision: item.revision,
    rank: index + 1,
    scoreComponents: { ...item.scoreComponents },
    selectionReasons: [...item.selectionReasons],
    ...(item.origin === undefined ? {} : { origin: item.origin }),
  }));
  const charCount = ranked.reduce((sum, item) => sum + item.content.characterCount, 0);
  const truncated = ranked.some((item) => item.content.truncated);
  return {
    workspace: query.workspace,
    deliveryId: query.deliveryId as string,
    runId: query.run?.runId as string,
    throughSequence: query.throughSequence,
    intakeSessionId: query.intakeSessionId,
    taskProfileHash: query.profileHash,
    queryHash: query.queryHash,
    policyVersion: CONTEXT_BROKER_POLICY_VERSION,
    charBudget: query.characterBudget,
    charCount,
    truncated,
    createdAt: query.run?.updatedAt ?? new Date().toISOString(),
    items,
  };
}

function currentRetrievableDeliveryEntry(
  database: SqliteDatabase,
  runWorkspace: string,
  item: ContextDeliveryView['items'][number],
): EntryRecord | null {
  const candidate = database.prepare('SELECT workspace FROM entries WHERE id = ?')
    .get<{ workspace: unknown }>(item.entryId);
  if (candidate === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context entry is missing');
  }
  if (typeof candidate.workspace !== 'string' || candidate.workspace.length === 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context entry is invalid');
  }
  const origin = item.origin ?? 'project';
  let deliveredRevision;
  try {
    deliveredRevision = readEntryRevision(database, {
      workspace: candidate.workspace,
      entryId: item.entryId,
      revision: item.entryRevision,
    });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context entry revision is missing');
    }
    throw error;
  }
  const deliveredScope = decodeStoredStructuredScope(deliveredRevision.scope, origin !== 'project').canonicalScope;
  if (!entryOriginMatchesWorkspace({ origin, runWorkspace, entryWorkspace: deliveredRevision.workspace })) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context entry origin is invalid');
  }
  if (origin === 'global'
    && (deliveredScope.visibility !== 'global' || effectiveRetrievalScope(deliveredScope) !== 'global')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context entry scope is invalid');
  }
  if (origin === 'ecosystem'
    && (!Object.hasOwn(deliveredScope, 'retrievalScope')
      || effectiveRetrievalScope(deliveredScope) !== 'ecosystem'
      || !hasExplicitApplicability(deliveredScope))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context entry scope is invalid');
  }
  if (isExternalSkillReference(deliveredRevision)) {
    const mappings = database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE entry_id = ?')
      .get<{ count: unknown }>(item.entryId)?.count;
    if (typeof mappings !== 'number' || !Number.isSafeInteger(mappings) || mappings < 1) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context external entry mapping is missing');
    }
  }
  const entry = readEntry(
    database,
    { workspace: candidate.workspace, entryId: item.entryId },
    { requireStructuredScope: origin !== 'project' },
  );
  const retrievable = isRetrievableEntry(database, entry);
  if (entry.revision !== item.entryRevision) return null;
  if (!retrievable) return null;
  if (entry.status === 'superseded') return null;
  return entry;
}

function storedContext(database: SqliteDatabase, query: PreparedQuery, delivery: ContextDeliveryView): ContextBrokerContext {
  let remaining = query.characterBudget;
  let totalCharacterCount = 0;
  let anyTruncated = false;
  const items = delivery.items.map((item) => {
    const current = currentRetrievableDeliveryEntry(database, query.workspace, item);
    if (current === null) throw new KiokukoError('INTEGRITY_ERROR', 'Stored context entry is no longer retrievable');
    const entry = readEntryRevision(database, {
      entryId: item.entryId,
      workspace: current.workspace,
      revision: item.entryRevision,
    });
    const take = (value: string, budget: number): string => Array.from(value).slice(0, Math.max(0, budget)).join('');
    const count = (value: string): number => Array.from(value).length;
    const title = take(entry.title, remaining);
    remaining -= count(title);
    const summary = entry.summary === null ? null : take(entry.summary, remaining);
    remaining -= count(summary ?? '');
    const bodyPreview = take(entry.body, remaining);
    remaining -= count(bodyPreview);
    const characterCount = count(title) + count(summary ?? '') + count(bodyPreview);
    const truncated = count(title) < count(entry.title)
      || (entry.summary !== null && count(summary ?? '') < count(entry.summary))
      || count(bodyPreview) < count(entry.body);
    totalCharacterCount += characterCount;
    anyTruncated ||= truncated;
    return {
      entryId: item.entryId,
      entryRevision: item.entryRevision,
      rank: item.rank,
      scoreComponents: item.scoreComponents,
      selectionReasons: [...item.selectionReasons],
      content: {
        title,
        summary,
        bodyPreview,
        characterCount,
        truncated,
      },
      untrusted: true as const,
      ...(item.origin === undefined ? {} : { origin: item.origin }),
    };
  });
  if (totalCharacterCount !== delivery.charCount || anyTruncated !== delivery.truncated) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context character accounting is invalid');
  }
  return {
    deliveryId: delivery.deliveryId,
    runId: delivery.runId,
    throughSequence: delivery.throughSequence,
    taskProfileHash: delivery.taskProfileHash,
    queryHash: delivery.queryHash,
    policyVersion: delivery.policyVersion as typeof CONTEXT_BROKER_POLICY_VERSION,
    items,
    untrusted: true,
  };
}

function storedDeliveryIsRetrievable(database: SqliteDatabase, query: PreparedQuery, delivery: ContextDeliveryView): boolean {
  if (delivery.throughSequence !== query.throughSequence) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery sequence is invalid');
  }
  if (!delivery.items.every((item) => currentRetrievableDeliveryEntry(database, query.workspace, item) !== null)) return false;
  return !(delivery.taskProfileHash !== query.profileHash
    || delivery.queryHash !== query.queryHash
    || delivery.policyVersion !== CONTEXT_BROKER_POLICY_VERSION
    || (delivery.scoreSchemaVersion ?? 1) !== 1
    || delivery.charBudget !== query.characterBudget
    || delivery.items.length > query.limit);
}

function assertPreparedSelectedEntries(database: SqliteDatabase, query: PreparedQuery, result: ContextBrokerResult): void {
  if (result.context !== null
    && result.context.items.some((item) => currentRetrievableDeliveryEntry(database, query.workspace, item) === null)) {
    throw new KiokukoError('CONFLICT', 'Context delivery selection changed before return');
  }
}

function assertPreparedBrokerState(
  database: SqliteDatabase,
  query: PreparedQuery,
  result: ContextBrokerResult,
  expectedHistoryStateHash: string | null = query.deliveryHistoryStateHash,
): void {
  assertPreparedProjectState(database, query);
  if (query.run === null) {
    if (query.retrievalStateHash !== null
      && contextRetrievalStateHash(database, query.selectionWorkspaces, { includeEcosystem: query.includeEcosystem }) !== query.retrievalStateHash) {
      throw new KiokukoError('CONFLICT', 'Context selection state changed after ranking');
    }
    return;
  }
  const current = currentRunContext(database, query.run.runId);
  const currentStatus = current.intakeStatus === 'active' ? 'needs_answer' : current.intakeStatus;
  if (query.runStateHash === null
    || current.stateHash !== query.runStateHash
    || current.run.workspace !== query.workspace
    || current.run.status !== query.run.status
    || current.run.lastSequence !== query.throughSequence
    || current.intakeSessionId !== query.intakeSessionId
    || currentStatus !== query.runStatus
    || current.profileHash !== query.profileHash
    || canonicalContentHash([...current.recommendedTags].sort()) !== canonicalContentHash([...query.recommendedTags].sort())) {
    throw new KiokukoError('CONFLICT', 'Context delivery conflicts with current run state');
  }
  if (result.context !== null && query.run.status !== 'active') {
    throw new KiokukoError('CONFLICT', 'Context delivery conflicts with current run state');
  }
  assertPreparedSelectedEntries(database, query, result);
  if (query.retrievalStateHash !== null
    && contextRetrievalStateHash(database, query.selectionWorkspaces, { includeEcosystem: query.includeEcosystem }) !== query.retrievalStateHash) {
    throw new KiokukoError('CONFLICT', 'Context selection state changed after ranking');
  }
  if (expectedHistoryStateHash !== null) {
    const currentHistory = priorData(
      database,
      query,
      query.deliveryHistoryExcludeQueryHash === null
        ? {}
        : { excludeDeliveredQueryHash: query.deliveryHistoryExcludeQueryHash },
    );
    if (currentHistory.stateHash !== expectedHistoryStateHash) {
      throw new KiokukoError('CONFLICT', 'Context delivery history changed after ranking');
    }
  }
}

function replayableDelivery(database: SqliteDatabase, query: PreparedQuery): { delivery: ContextDeliveryView | null; found: boolean } {
  if (query.run === null) return { delivery: null, found: false };
  const rows = database.prepare(`
    SELECT delivery_id AS deliveryId
      FROM context_deliveries
     WHERE run_id = ? AND query_hash = ?
     ORDER BY delivery_id ASC
  `).all<{ deliveryId: string }>(query.run.runId, query.queryHash);
  for (const row of rows) {
    const delivery = readContextDelivery(database, { workspace: query.workspace, deliveryId: row.deliveryId });
    if (storedDeliveryIsRetrievable(database, query, delivery)
      && deliveryHistoryIsAttested(database, query, delivery)) {
      return { delivery, found: true };
    }
  }
  return { delivery: null, found: rows.length > 0 };
}

export class ContextBroker {
  private readonly inFlight = new Map<string, Promise<ContextBrokerResult>>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly embeddingRuntime?: EmbeddingRuntime,
  ) {}

  listDeliveries(input: { runId: string; cursor?: string; limit?: number }): ReturnType<typeof listContextDeliveries> & { untrusted: true } {
    const context = currentRunContext(this.database, input.runId);
    return {
      ...listContextDeliveries(this.database, {
        workspace: context.run.workspace,
        runId: input.runId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
      untrusted: true,
    };
  }

  async query(rawInput: unknown, persistence: ContextBrokerPersistence = {}): Promise<ContextBrokerResult> {
    return this.execute(rawInput, normalizePersistence(persistence));
  }

  async queryGated<T>(
    rawInput: unknown,
    decide: (candidate: ContextBrokerResult) => ContextBrokerGateDecision<T>,
    persistence: ContextBrokerPersistence = {},
  ): Promise<ContextBrokerGatedResult<T>> {
    const normalizedPersistence = normalizePersistence(persistence);
    const input = normalizeInput(rawInput);
    const query = preparedQuery(this.database, input);
    const prepared = await this.prepareResult(query);
    const decision = normalizedGateDecision<T>(decide(prepared.result));
    const broker = decision.persist
      ? await this.persistPrepared(prepared, normalizedPersistence, query, decision.assertBeforePersist)
      : this.validatePrepared(prepared, query, decision.assertBeforePersist);
    return { broker, value: decision.value };
  }

  private async execute(rawInput: unknown, persistence: ContextBrokerPersistence): Promise<ContextBrokerResult> {
    const input = normalizeInput(rawInput);
    const query = preparedQuery(this.database, input);
    const previous = this.inFlight.get(query.queryHash);
    if (previous !== undefined) return previous;
    const operation = this.queryPrepared(query, persistence);
    this.inFlight.set(query.queryHash, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(query.queryHash) === operation) this.inFlight.delete(query.queryHash);
    }
  }

  private async queryPrepared(query: PreparedQuery, persistence: ContextBrokerPersistence): Promise<ContextBrokerResult> {
    const prepared = await this.prepareResult(query);
    return this.persistPrepared(prepared, persistence, query);
  }

  private async prepareResult(query: PreparedQuery): Promise<PreparedBrokerResult> {
    const base = {
      status: query.runStatus,
      taskProfile: { ...query.taskProfile },
      profileHash: query.profileHash,
      acceptedThrough: query.throughSequence,
      intakeSessionId: query.intakeSessionId,
      recommendedTags: [...query.recommendedTags],
      projection: query.projection,
      context: null,
      recommendations: query.projection === null ? [] : buildRecommendations({ projection: query.projection, broker: {} }),
    } satisfies Omit<ContextBrokerResult, 'context'> & { context: null };
    if (query.runStatus === 'needs_answer') return { result: base, replayDelivery: null, pendingDelivery: null };

    const replay = replayableDelivery(this.database, query);
    const excludeDeliveredQueryHash = replay.delivery === null && replay.found ? query.queryHash : undefined;
    const prior = priorData(this.database, query, excludeDeliveredQueryHash === undefined
      ? {}
      : { excludeDeliveredQueryHash });
    query.deliveryHistoryStateHash = prior.stateHash;
    query.deliveryHistoryExcludeQueryHash = excludeDeliveredQueryHash ?? null;
    if (replay.delivery !== null) {
      return {
        result: {
          ...base,
          context: storedContext(this.database, query, replay.delivery),
          recommendations: query.projection === null ? [] : buildRecommendations({ projection: query.projection, broker: { staleDeliveredEntries: prior.stale } }),
        },
        replayDelivery: replay.delivery,
        pendingDelivery: null,
      };
    }

    const retrievalRuntime = await prepareEmbeddingSearchRuntime(
      this.embeddingRuntime,
      this.database,
      retrievalQuery(query),
    );
    const ranked = await rank(this.database, query, prior, retrievalRuntime);
    if (query.run !== null && prior.stateHash === null) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery history is invalid');
    }
    const deliveryQuery = query.run === null
      ? query
      : {
          ...query,
          deliveryId: historyAttestedDeliveryId(
            query,
            prior.stateHash as string,
            query.deliveryHistoryExcludeQueryHash,
          ),
        };

    const recommendations = query.projection === null
      ? []
      : buildRecommendations({ projection: query.projection, broker: { staleDeliveredEntries: prior.stale } });
    const context = outputContext(deliveryQuery, ranked, null);
    if (deliveryQuery.deliveryId === null || deliveryQuery.run === null) {
      return { result: { ...base, context, recommendations }, replayDelivery: null, pendingDelivery: null };
    }
    const deliveryRequest = deliveryInput(deliveryQuery, ranked);
    return {
      result: { ...base, context, recommendations },
      replayDelivery: null,
      pendingDelivery: { query: deliveryQuery, ranked, input: deliveryRequest },
    };
  }

  private async persistPrepared(
    prepared: PreparedBrokerResult,
    persistence: ContextBrokerPersistence,
    query: PreparedQuery,
    assertBeforePersist?: () => void,
  ): Promise<ContextBrokerResult> {
    if (prepared.pendingDelivery === null) {
      return withImmediateTransaction(this.database, () => {
        if (prepared.replayDelivery !== null) {
          assertPreparedSelectedEntries(this.database, query, prepared.result);
          assertReplayDeliveryUnchanged(this.database, prepared.replayDelivery);
        }
        assertPreparedBrokerState(this.database, query, prepared.result);
        if (assertBeforePersist !== undefined) {
          assertBeforePersist();
          if (prepared.replayDelivery !== null) {
            assertPreparedSelectedEntries(this.database, query, prepared.result);
            assertReplayDeliveryUnchanged(this.database, prepared.replayDelivery);
          }
          assertPreparedBrokerState(this.database, query, prepared.result);
        }
        return prepared.result;
      });
    }
    const pendingDelivery = prepared.pendingDelivery;
    let committedDelivery: ContextDeliveryView | null = null;
    let committedHistoryStateHash: string | null = null;
    let invocationCount = 0;
    let acceptingInvocation = true;
    const persist = (): ContextDeliveryView => {
      if (!acceptingInvocation) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Context broker write adapter invoked persistence outside its queue operation');
      }
      invocationCount += 1;
      if (invocationCount !== 1) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Context broker write adapter invoked persistence more than once');
      }
      committedDelivery = withImmediateTransaction(this.database, () => {
        assertPreparedBrokerState(this.database, query, prepared.result);
        if (assertBeforePersist !== undefined) {
          assertBeforePersist();
          assertPreparedBrokerState(this.database, query, prepared.result);
        }
        const delivery = recordContextDeliveryInTransaction(this.database, pendingDelivery.input);
        committedHistoryStateHash = priorData(
          this.database,
          query,
          query.deliveryHistoryExcludeQueryHash === null
            ? {}
            : { excludeDeliveredQueryHash: query.deliveryHistoryExcludeQueryHash },
        ).stateHash;
        return delivery;
      });
      return committedDelivery;
    };
    let returned: ContextDeliveryView;
    try {
      returned = persistence.enqueueWrite === undefined
        ? persist()
        : await persistence.enqueueWrite(persist);
    } finally {
      acceptingInvocation = false;
    }
    const committed = committedDelivery;
    const committedHistory = committedHistoryStateHash;
    if (invocationCount !== 1 || committed === null || committedHistory === null || returned !== committed) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Context broker write adapter returned an invalid result');
    }
    withImmediateTransaction(this.database, () => {
      assertReplayDeliveryUnchanged(this.database, committed);
      if (!deliveryHistoryIsAttested(this.database, query, committed)) {
        throw new KiokukoError('CONFLICT', 'Context delivery history changed after ranking');
      }
      assertPreparedBrokerState(this.database, query, prepared.result, committedHistory);
    });
    return {
      ...prepared.result,
      context: outputContext(pendingDelivery.query, pendingDelivery.ranked, committed),
    };
  }

  private validatePrepared(
    prepared: PreparedBrokerResult,
    query: PreparedQuery,
    assertBeforeReturn?: () => void,
  ): ContextBrokerResult {
    return withImmediateTransaction(this.database, () => {
      if (prepared.replayDelivery !== null) {
        assertPreparedSelectedEntries(this.database, query, prepared.result);
        assertReplayDeliveryUnchanged(this.database, prepared.replayDelivery);
      }
      assertPreparedBrokerState(this.database, query, prepared.result);
      if (assertBeforeReturn !== undefined) {
        assertBeforeReturn();
        if (prepared.replayDelivery !== null) {
          assertPreparedSelectedEntries(this.database, query, prepared.result);
          assertReplayDeliveryUnchanged(this.database, prepared.replayDelivery);
        }
        assertPreparedBrokerState(this.database, query, prepared.result);
      }
      return prepared.result;
    });
  }
}
