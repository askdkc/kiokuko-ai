import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js';
import { readEntry, type EntryRecord } from '../memory/entries.js';
import { decodeStoredStructuredScope, readEntryRevision } from '../memory/revisions.js';
import { ensureGlobalWorkspace, GLOBAL_WORKSPACE, resolveProjectWorkspace, type ResolvedProjectWorkspace } from '../memory/workspaces.js';
import { federatedEntries, type FederatedOrigin } from '../memory/federated-retrieval.js';
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js';
import { effectiveRetrievalScope, hasExplicitApplicability } from '../memory/structured-memory.js';
import type { TaskProfile } from '../akinator/types.js';
import { readContextDelivery, recordContextDeliveryInTransaction, type ContextDeliveryInput, type ContextDeliveryView } from './delivery.js';
import { CONTEXT_SELECTION_REASON_ORDER } from './ranking.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { contextFeedbackSignals } from './feedback.js';
import {
  captureProjectManifestSnapshot,
  resolveProjectFingerprint,
  type ProjectFingerprint,
} from '../repository/project-fingerprint.js';
import { entryOriginMatchesWorkspace } from './origin.js';
import type { RunStatus } from '../ledger/types.js';
import { isExternalSkillReference } from '../skills/store.js';
import { contextRetrievalStateHash, ordinaryContextSelectionStateHash } from './selection-state.js';
import { readContextRunRetrievalState } from './run-state.js';
import type { PreparedSemanticQuery } from '../embedding/types.js';
import type { HybridSearchRuntime } from '../memory/hybrid-retrieval.js';

export const SCOPED_CONTEXT_POLICY_VERSION = 'context-ranking-v6' as const;
export const SCOPED_CONTEXT_DEFAULT_CHARACTER_BUDGET = 8_000;
export const SCOPED_CONTEXT_MAX_CHARACTER_BUDGET = 100_000;

export interface ScopedContextQuery {
  cwd?: string;
  project?: ResolvedProjectWorkspace;
  fingerprint?: ProjectFingerprint;
  task: string;
  taskProfile: TaskProfile;
  recommendedTags?: string[];
  changedPaths?: string[];
  errorSignatures?: string[];
  limit?: number;
  characterBudget?: number;
  runId?: string;
}

export interface ScopedContextItem {
  entryId: string;
  revision: number;
  origin: FederatedOrigin;
  title: string;
  summary: string | null;
  bodyPreview: string;
  score: number;
  scoreComponents: {
    status: number;
    trust: number;
    confidence: number;
    retrieval: number;
    taskAffinity: number;
    recommendedTags: number;
    scopeAffinity: number;
    applicability: number;
    pathOverlap: number;
    errorSignature: number;
    exactSignal: number;
    feedback: number;
    recency: number;
    contradiction: number;
  };
  selectionReasons: string[];
  metadata: {
    storedData: true;
    untrusted: true;
    instructions: false;
  };
}

export interface ScopedContextResult {
  project: ResolvedProjectWorkspace | null;
  taskProfileHash: string;
  queryHash: string;
  policyVersion: typeof SCOPED_CONTEXT_POLICY_VERSION;
  items: ScopedContextItem[];
  deliveryId: string | null;
  truncated: boolean;
  untrusted: true;
}

export interface ScopedContextGateDecision<T> {
  persist: boolean;
  value: T;
  assertBeforePersist?: () => void;
}

export interface ScopedContextGatedResult<T> {
  context: ScopedContextResult | null;
  value: T;
  /** Internal corpus generation used by callers that guard later side effects. */
  selectionStateHash: string;
}

function normalizedScopedGateDecision<T>(value: unknown): ScopedContextGateDecision<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Scoped context gate returned an invalid decision');
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== 'string'
      || key !== 'persist' && key !== 'value' && key !== 'assertBeforePersist')
    || !keys.includes('persist')
    || !keys.includes('value')) {
    throw new TypeError('Scoped context gate returned an invalid decision');
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
    throw new TypeError('Scoped context gate returned an invalid decision');
  }
  return {
    persist: persistDescriptor.value as boolean,
    value: resultDescriptor.value as T,
    ...(assertionDescriptor === undefined
      ? {}
      : { assertBeforePersist: assertionDescriptor.value as () => void }),
  };
}

const MAX_LIMIT = 100;

interface ScopedRunContext {
  runId: string;
  workspace: string;
  status: RunStatus;
  throughSequence: number;
  createdAt: string;
  intakeSessionId: string;
  profileHash: string;
  stateHash: string;
}

type ScopedDeliveryRequest = Omit<ContextDeliveryInput, 'deliveryId'>;

interface FittedScopedItems {
  items: ScopedContextItem[];
  charCount: number;
  truncated: boolean;
}

interface PreparedScopedContext {
  result: ScopedContextResult;
  replayDelivery: ContextDeliveryView | null;
  selectionStateHash: string;
  retrievalStateHash: string;
  selectionWorkspaces: string[];
  pendingDelivery: ScopedDeliveryRequest | null;
  run: ScopedRunContext | null;
  projectState: {
    project: ResolvedProjectWorkspace;
    fingerprint: ProjectFingerprint;
    reparseFingerprint: boolean;
  } | null;
}

function semanticQueryIdentity(runtime: HybridSearchRuntime): Record<string, unknown> | null {
  const semantic = runtime.semantic;
  if (semantic === undefined) return null;
  const query = semantic.query;
  if (typeof query.profileId !== 'string' || query.profileId.length === 0
    || !Number.isSafeInteger(query.dimensions) || query.dimensions < 2 || query.dimensions > 8192
    || !(query.vector instanceof Float32Array) || query.vector.length !== query.dimensions
    || typeof query.vectorHash !== 'string' || query.vectorHash.length === 0
    || !Number.isFinite(query.distanceCeiling) || query.distanceCeiling < 0 || query.distanceCeiling >= 2
    || typeof query.backendId !== 'string' || query.backendId.length === 0
    || query.backendId !== semantic.backend.id) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Prepared semantic query is invalid');
  }
  return {
    profileId: query.profileId,
    dimensions: query.dimensions,
    vectorHash: query.vectorHash,
    backendId: query.backendId,
    distanceCeiling: query.distanceCeiling,
  } satisfies Pick<PreparedSemanticQuery, 'profileId' | 'dimensions' | 'vectorHash' | 'backendId' | 'distanceCeiling'>;
}

function snapshotSemanticRuntime(runtime: HybridSearchRuntime): HybridSearchRuntime {
  if (runtime.semantic === undefined) return {};
  return {
    semantic: {
      backend: runtime.semantic.backend,
      query: {
        ...runtime.semantic.query,
        vector: new Float32Array(runtime.semantic.query.vector),
      },
    },
  };
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function takeCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join('');
}

function textFor(query: ScopedContextQuery): string {
  return [
    query.task,
    query.taskProfile.taskType ?? '',
    query.taskProfile.target ?? '',
    query.taskProfile.expected ?? '',
    query.taskProfile.constraints ?? '',
    ...(query.recommendedTags ?? []),
    ...(query.changedPaths ?? []),
    ...(query.errorSignatures ?? []),
  ].join('\n');
}

function scopeObject(entry: EntryRecord): Record<string, unknown> {
  return entry.scope;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(normalize) : [];
}

function applicabilityScore(entry: EntryRecord, queryText: string, origin: FederatedOrigin): { score: number; reasons: string[]; conflict: boolean } {
  if (origin === 'project') return { score: 0, reasons: [], conflict: false };
  const scope = scopeObject(entry);
  const applicability = typeof scope.applicability === 'object' && scope.applicability !== null && !Array.isArray(scope.applicability)
    ? scope.applicability as Record<string, unknown>
    : undefined;
  if (applicability === undefined) return origin === 'global' ? { score: -4, reasons: ['unscoped_global_prior'], conflict: false } : { score: -8, reasons: ['applicability_unknown'], conflict: false };
  const haystack = normalize(queryText);
  const values = [
    ...stringList(applicability.languages),
    ...stringList(applicability.databases),
    ...stringList(applicability.runtimes),
    ...stringList(applicability.tools),
    ...stringList(applicability.platforms),
    ...(Array.isArray(applicability.frameworks) ? applicability.frameworks.flatMap((item) => typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string' ? [normalize((item as { name: string }).name)] : []) : []),
  ];
  if (values.length === 0) return origin === 'global' ? { score: -2, reasons: ['unscoped_global_prior'], conflict: false } : { score: -8, reasons: ['applicability_unknown'], conflict: false };
  const matches = values.filter((value) => haystack.includes(value)).length;
  const likelyUnrelated = /\b(?:swiftui|ios|android|kotlin|rust|django|rails|laravel|postgres(?:ql)?|mysql|react|vue)\b/giu;
  const queryEcosystems = [...haystack.matchAll(likelyUnrelated)].map((match) => match[0].toLowerCase());
  const explicitConflict = queryEcosystems.length > 0 && values.some((value) => !queryEcosystems.includes(value) && /^(?:laravel|postgresql?|swiftui|django|rails|rust|kotlin|mysql|react|vue)$/u.test(value));
  if (explicitConflict && matches === 0) return { score: -100, reasons: ['applicability_mismatch'], conflict: true };
  return {
    score: Math.min(18, matches * 9),
    reasons: matches > 0 ? ['applicability_match'] : ['applicability_unknown'],
    conflict: false,
  };
}

function entryScore(entry: EntryRecord, origin: FederatedOrigin, retrieval: number, exact: boolean, queryText: string): ScopedContextItem {
  const scope = origin;
  const status = entry.status === 'verified' ? 100 : entry.status === 'candidate' ? 40 : 0;
  const trust = entry.trustLevel === 'system_verified' ? 30 : entry.trustLevel === 'source_verified' ? 25 : entry.trustLevel === 'user_asserted' ? 15 : 0;
  const confidence = Math.round(entry.confidence * 20);
  const scopeAffinity = scope === 'project' ? 9 : scope === 'ecosystem' ? 6 : 4;
  const applicability = applicabilityScore(entry, queryText, origin);
  const exactSignal = exact ? 24 : 0;
  const score = status + trust + confidence + retrieval + scopeAffinity + applicability.score + exactSignal;
  const reasons = [scope === 'project' ? 'project_origin' : scope === 'ecosystem' ? 'ecosystem_origin' : 'global_origin', ...(entry.status === 'verified' ? ['verified'] : ['candidate']), ...applicability.reasons, ...(exact ? ['exact_signal_match'] : [])];
  return {
    entryId: entry.id,
    revision: entry.revision,
    origin: scope,
    title: entry.title,
    summary: entry.summary,
    bodyPreview: entry.body,
    score,
    scoreComponents: {
      status,
      trust,
      confidence,
      retrieval: Math.round(retrieval),
      taskAffinity: 0,
      recommendedTags: 0,
      scopeAffinity,
      applicability: applicability.score,
      pathOverlap: 0,
      errorSignature: 0,
      exactSignal,
      feedback: 0,
      recency: 0,
      contradiction: 0,
    },
    selectionReasons: [...new Set(reasons)],
    metadata: { storedData: true, untrusted: true, instructions: false },
  };
}

function feedbackScore(database: SqliteDatabase, entryId: string): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const signal of contextFeedbackSignals(database, entryId)) {
    if (signal.verdict === 'helpful') { score += 3 * signal.boundedInfluence; reasons.push('helpful_feedback'); }
    if (signal.verdict === 'irrelevant') { score -= 2 * signal.boundedInfluence; reasons.push('irrelevant_feedback'); }
    if (signal.verdict === 'stale') { score -= 3 * signal.boundedInfluence; reasons.push('stale_feedback'); }
    if (signal.verdict === 'conflicting') { score -= 3 * signal.boundedInfluence; reasons.push('conflicting_feedback'); }
  }
  return { score: Math.max(-6, Math.min(6, score)), reasons };
}

function assertScopedSelectionState(
  database: SqliteDatabase,
  workspaces: readonly string[],
  expectedHash: string,
): void {
  if (contextRetrievalStateHash(database, workspaces, { includeEcosystem: workspaces.length > 0 }) !== expectedHash) {
    throw new KiokukoError('CONFLICT', 'Scoped context catalog changed after ranking');
  }
}

function fitScopedItems(ordered: ScopedContextItem[], limit: number, characterBudget: number): FittedScopedItems {
  const items: ScopedContextItem[] = [];
  let remaining = characterBudget;
  let truncated = false;
  for (const item of ordered) {
    if (items.length >= limit) {
      truncated = true;
      break;
    }
    const metadataCost = characterCount(item.title) + characterCount(item.summary ?? '');
    if (metadataCost > remaining) {
      if (items.length === 0) {
        throw new KiokukoError('VALIDATION_ERROR', 'Scoped context character budget cannot fit candidate metadata');
      }
      truncated = true;
      break;
    }
    const bodyPreview = takeCharacters(item.bodyPreview, remaining - metadataCost);
    if (characterCount(bodyPreview) < characterCount(item.bodyPreview)) truncated = true;
    const cost = metadataCost + characterCount(bodyPreview);
    items.push({
      ...item,
      bodyPreview,
      scoreComponents: { ...item.scoreComponents },
      selectionReasons: [...item.selectionReasons],
    });
    remaining -= cost;
  }
  return { items, charCount: characterBudget - remaining, truncated };
}

function scopedRunContext(
  database: SqliteDatabase,
  runId: string | undefined,
): ScopedRunContext | null {
  if (runId === undefined) return null;
  let state;
  try {
    state = readContextRunRetrievalState(database, runId);
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
      throw new KiokukoError('VALIDATION_ERROR', 'Scoped context run is invalid');
    }
    throw error;
  }
  return {
    runId,
    workspace: state.run.workspace,
    status: state.run.status as RunStatus,
    throughSequence: state.run.lastSequence,
    createdAt: state.run.createdAt,
    intakeSessionId: state.intakeSessionId,
    profileHash: state.profileHash,
    stateHash: state.stateHash,
  };
}

function scopedDeliveryId(delivery: ScopedDeliveryRequest | ContextDeliveryView): string {
  return `context-${canonicalContentHash({
    kind: 'scoped-context-delivery-v1',
    workspace: delivery.workspace,
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
  })}`;
}

function assertScopedDeliveryIdentity(delivery: ContextDeliveryView): void {
  if (delivery.deliveryId !== scopedDeliveryId(delivery)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context character accounting is invalid');
  }
}

function assertScopedReplayDeliveryUnchanged(database: SqliteDatabase, expected: ContextDeliveryView): void {
  let current: ContextDeliveryView;
  try {
    current = readContextDelivery(database, {
      workspace: expected.workspace,
      deliveryId: expected.deliveryId,
    });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context delivery disappeared during replay');
    }
    throw error;
  }
  assertScopedDeliveryIdentity(current);
  if (scopedDeliveryId(current) !== scopedDeliveryId(expected)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context delivery changed during replay');
  }
}

function currentRetrievableDeliveryEntry(
  database: SqliteDatabase,
  runWorkspace: string,
  item: { entryId: string; entryRevision: number; origin?: FederatedOrigin },
): EntryRecord | null {
  const candidate = database.prepare('SELECT workspace FROM entries WHERE id = ?')
    .get<{ workspace: unknown }>(item.entryId);
  if (candidate === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context entry is missing');
  }
  if (typeof candidate.workspace !== 'string' || candidate.workspace.length === 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context entry is invalid');
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
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context entry revision is missing');
    }
    throw error;
  }
  const deliveredScope = decodeStoredStructuredScope(deliveredRevision.scope, origin !== 'project').canonicalScope;
  if (!entryOriginMatchesWorkspace({ origin, runWorkspace, entryWorkspace: deliveredRevision.workspace })) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context entry origin is invalid');
  }
  if (origin === 'global'
    && (deliveredScope.visibility !== 'global' || effectiveRetrievalScope(deliveredScope) !== 'global')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context entry scope is invalid');
  }
  if (origin === 'ecosystem'
    && (!Object.hasOwn(deliveredScope, 'retrievalScope')
      || effectiveRetrievalScope(deliveredScope) !== 'ecosystem'
      || !hasExplicitApplicability(deliveredScope))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context entry scope is invalid');
  }
  if (isExternalSkillReference(deliveredRevision)) {
    const mappings = database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE entry_id = ?')
      .get<{ count: unknown }>(item.entryId)?.count;
    if (typeof mappings !== 'number' || !Number.isSafeInteger(mappings) || mappings < 1) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context external entry mapping is missing');
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

function storedDeliveryIsRetrievable(
  database: SqliteDatabase,
  delivery: ContextDeliveryView,
  throughSequence: number,
  taskProfileHash: string,
  limit: number,
  characterBudget: number,
): boolean {
  if (delivery.policyVersion !== SCOPED_CONTEXT_POLICY_VERSION) return false;
  assertScopedDeliveryIdentity(delivery);
  if (delivery.throughSequence !== throughSequence) return false;
  if (!delivery.items.every((item) => currentRetrievableDeliveryEntry(database, delivery.workspace, item) !== null)) return false;
  return !(delivery.taskProfileHash !== taskProfileHash
    || delivery.policyVersion !== SCOPED_CONTEXT_POLICY_VERSION
    || delivery.scoreSchemaVersion !== 2
    || delivery.charBudget !== characterBudget
    || delivery.items.length > limit);
}

function replayableDelivery(
  database: SqliteDatabase,
  run: ScopedRunContext | null,
  queryHash: string,
  taskProfileHash: string,
  limit: number,
  characterBudget: number,
): ContextDeliveryView | null {
  if (run === null) return null;
  const rows = database.prepare(`
    SELECT delivery_id AS deliveryId
      FROM context_deliveries
     WHERE run_id = ? AND query_hash = ?
     ORDER BY delivery_id ASC
  `).all<{ deliveryId: string }>(run.runId, queryHash);
  for (const row of rows) {
    const delivery = readContextDelivery(database, { workspace: run.workspace, deliveryId: row.deliveryId });
    if (storedDeliveryIsRetrievable(database, delivery, run.throughSequence, taskProfileHash, limit, characterBudget)) return delivery;
  }
  return null;
}

function storedScopedItems(database: SqliteDatabase, delivery: ContextDeliveryView): ScopedContextItem[] {
  if (delivery.policyVersion !== SCOPED_CONTEXT_POLICY_VERSION) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context delivery cannot be replayed');
  }
  assertScopedDeliveryIdentity(delivery);
  const fullItems = delivery.items.map((item): ScopedContextItem => {
    const current = currentRetrievableDeliveryEntry(database, delivery.workspace, item);
    if (current === null) throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context entry is no longer retrievable');
    const revision = readEntryRevision(database, {
      entryId: item.entryId,
      workspace: current.workspace,
      revision: item.entryRevision,
    });
    const scoreComponents = item.scoreComponents as ScopedContextItem['scoreComponents'];
    return {
      entryId: item.entryId,
      revision: item.entryRevision,
      origin: item.origin ?? 'project',
      title: revision.title,
      summary: revision.summary,
      bodyPreview: revision.body,
      score: Object.values(scoreComponents).reduce((total, component) => total + component, 0),
      scoreComponents: { ...scoreComponents },
      selectionReasons: [...item.selectionReasons],
      metadata: { storedData: true, untrusted: true, instructions: false },
    };
  });
  const fitted = fitScopedItems(fullItems, fullItems.length || 1, delivery.charBudget);
  if (fitted.charCount !== delivery.charCount
    || fitted.items.length !== delivery.items.length
    || (fitted.truncated && !delivery.truncated)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context character accounting is invalid');
  }
  return fitted.items;
}

function deliveryItems(items: ScopedContextItem[]): ContextDeliveryInput['items'] {
  const allowedReasons = new Set<string>(CONTEXT_SELECTION_REASON_ORDER);
  return items.map((item, index) => ({
    entryId: item.entryId,
    entryRevision: item.revision,
    rank: index + 1,
    scoreComponents: { ...item.scoreComponents },
    selectionReasons: [...new Set([
      ...item.selectionReasons.filter((reason) => allowedReasons.has(reason)),
      item.scoreComponents.status >= 100 ? 'verified' : 'candidate',
    ])].sort((left, right) => CONTEXT_SELECTION_REASON_ORDER.findIndex((reason) => reason === left)
      - CONTEXT_SELECTION_REASON_ORDER.findIndex((reason) => reason === right)),
    ...(item.origin === 'project' ? {} : { origin: item.origin }),
  }));
}

function deliveryRequest(
  run: ScopedRunContext,
  taskProfileHash: string,
  queryHash: string,
  characterBudget: number,
  fitted: FittedScopedItems,
): ScopedDeliveryRequest {
  return {
    workspace: run.workspace,
    runId: run.runId,
    throughSequence: run.throughSequence,
    intakeSessionId: run.intakeSessionId,
    taskProfileHash,
    queryHash,
    policyVersion: SCOPED_CONTEXT_POLICY_VERSION,
    charBudget: characterBudget,
    charCount: fitted.charCount,
    truncated: fitted.truncated,
    createdAt: run.createdAt,
    scoreSchemaVersion: 2,
    items: deliveryItems(fitted.items),
  };
}

async function prepareScopedContext(
  database: SqliteDatabase,
  raw: ScopedContextQuery,
  requestedRuntime: HybridSearchRuntime,
): Promise<PreparedScopedContext> {
  const runtime = snapshotSemanticRuntime(requestedRuntime);
  const semanticIdentity = semanticQueryIdentity(runtime);
  const taskProfileHash = canonicalContentHash(raw.taskProfile);
  const run = scopedRunContext(database, raw.runId);
  if (run !== null && run.profileHash !== taskProfileHash) {
    throw new KiokukoError('CONFLICT', 'Scoped context task profile does not match its run');
  }
  const resolvedProject = raw.project ?? await resolveProjectWorkspace(database, raw.cwd);
  const project = resolvedProject === undefined ? undefined : { ...resolvedProject };
  if (run !== null && (project === undefined || run.workspace !== project.workspace)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Scoped context run is invalid');
  }
  if (raw.fingerprint !== undefined && project === undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'Scoped context fingerprint requires a project');
  }
  const manifestSnapshot = project === undefined ? undefined : captureProjectManifestSnapshot(project);
  if (raw.fingerprint !== undefined
    && manifestSnapshot !== undefined
    && raw.fingerprint.manifestDigest !== manifestSnapshot.manifestDigest) {
    throw new KiokukoError('CONFLICT', 'Project manifest changed while task context was being prepared');
  }
  // task_prepare may deliberately supply an empty, digest-bound fingerprint
  // after a malformed manifest. Re-parsing here would turn an advisory
  // enrichment failure back into a coding gate. The fresh manifest digest
  // comparison above remains the synchronous race/identity fence.
  const fingerprint = raw.fingerprint ?? (project === undefined || manifestSnapshot === undefined
    ? undefined
    : resolveProjectFingerprint(database, project, manifestSnapshot));
  const projectState = project === undefined || fingerprint === undefined ? null : {
    project,
    fingerprint,
    reparseFingerprint: raw.fingerprint === undefined,
  };
  ensureGlobalWorkspace(database);
  const limit = raw.limit ?? 20;
  const characterBudget = raw.characterBudget ?? SCOPED_CONTEXT_DEFAULT_CHARACTER_BUDGET;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isSafeInteger(characterBudget) || characterBudget < 1 || characterBudget > SCOPED_CONTEXT_MAX_CHARACTER_BUDGET) {
    throw new KiokukoError('VALIDATION_ERROR', 'Scoped context bounds are invalid');
  }
  const queryText = textFor(raw);
  const selectionWorkspaces = project === undefined ? [] : [project.workspace, GLOBAL_WORKSPACE];
  const selectionStateHash = ordinaryContextSelectionStateHash(database, selectionWorkspaces, {
    includeEcosystem: project !== undefined,
  });
  const retrievalStateHash = contextRetrievalStateHash(database, selectionWorkspaces, {
    includeEcosystem: project !== undefined,
  });
  const queryHash = canonicalContentHash({
    task: raw.task,
    taskProfile: raw.taskProfile,
    recommendedTags: raw.recommendedTags ?? [],
    changedPaths: raw.changedPaths ?? [],
    errorSignatures: raw.errorSignatures ?? [],
    project: project === undefined ? null : {
      workspace: project.workspace,
      repositoryId: project.repositoryId,
      repositoryRoot: project.repositoryRoot,
      fingerprint,
    },
    limit,
    characterBudget,
    policyVersion: SCOPED_CONTEXT_POLICY_VERSION,
    retrievalStateHash,
    runStateHash: run?.stateHash ?? null,
    semanticQuery: semanticIdentity,
  });
  const replay = replayableDelivery(
    database,
    run,
    queryHash,
    taskProfileHash,
    limit,
    characterBudget,
  );
  if (replay !== null) {
    return {
      result: {
        project: project ?? null,
        taskProfileHash,
        queryHash,
        policyVersion: SCOPED_CONTEXT_POLICY_VERSION,
        items: storedScopedItems(database, replay),
        deliveryId: replay.deliveryId,
        truncated: replay.truncated,
        untrusted: true,
      },
      replayDelivery: replay,
      selectionStateHash,
      retrievalStateHash,
      selectionWorkspaces,
      pendingDelivery: null,
      run,
      projectState,
    };
  }
  const candidates = new Map<string, ScopedContextItem>();
  const federated = project === undefined ? [] : await federatedEntries(database, {
    project,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    query: queryText,
    limit: 200,
  }, runtime);
  for (const hit of federated) {
    const entry = hit.entry;
    const item = entryScore(entry, hit.origin, hit.score, hit.selectionReasons.includes('exact_signal_match'), queryText);
    item.selectionReasons.push(...hit.selectionReasons);
    item.selectionReasons = [...new Set(item.selectionReasons)];
    const feedback = feedbackScore(database, entry.id);
    item.score += feedback.score;
    item.scoreComponents.feedback = feedback.score;
    item.selectionReasons.push(...feedback.reasons);
    if (item.score <= -50) continue;
    const previous = candidates.get(item.entryId);
    if (previous === undefined || item.score > previous.score) candidates.set(item.entryId, item);
  }
  const ordered = [...candidates.values()].sort((left, right) => right.score - left.score || compareCanonicalStrings(left.entryId, right.entryId));
  const fitted = fitScopedItems(ordered, limit, characterBudget);
  return {
    result: {
      project: project ?? null,
      taskProfileHash,
      queryHash,
      policyVersion: SCOPED_CONTEXT_POLICY_VERSION,
      items: fitted.items,
      deliveryId: null,
      truncated: fitted.truncated,
      untrusted: true,
    },
    replayDelivery: null,
    selectionStateHash,
    retrievalStateHash,
    selectionWorkspaces,
    pendingDelivery: run === null ? null : deliveryRequest(run, taskProfileHash, queryHash, characterBudget, fitted),
    run,
    projectState,
  };
}

function assertPreparedScopedRun(database: SqliteDatabase, run: ScopedRunContext): void {
  const current = readContextRunRetrievalState(database, run.runId);
  if (run.status !== 'active'
    || current.run.workspace !== run.workspace
    || current.run.status !== run.status
    || current.run.lastSequence !== run.throughSequence
    || current.intakeSessionId !== run.intakeSessionId
    || current.profileHash !== run.profileHash
    || current.stateHash !== run.stateHash) {
    throw new KiokukoError('CONFLICT', 'Scoped context run changed before persistence');
  }
}

function assertPreparedScopedState(database: SqliteDatabase, prepared: PreparedScopedContext): void {
  if (prepared.projectState !== null) {
    const manifestSnapshot = captureProjectManifestSnapshot(prepared.projectState.project);
    if (manifestSnapshot.manifestDigest !== prepared.projectState.fingerprint.manifestDigest) {
      throw new KiokukoError('CONFLICT', 'Scoped context project state changed after ranking');
    }
    if (prepared.projectState.reparseFingerprint) {
      const currentFingerprint = resolveProjectFingerprint(
        database,
        prepared.projectState.project,
        manifestSnapshot,
        { readOnly: true },
      );
      if (canonicalContentHash(currentFingerprint) !== canonicalContentHash(prepared.projectState.fingerprint)) {
        throw new KiokukoError('CONFLICT', 'Scoped context project state changed after ranking');
      }
    }
  }
  if (prepared.run !== null) assertPreparedScopedRun(database, prepared.run);
  const workspace = prepared.run?.workspace ?? prepared.result.project?.workspace;
  if (workspace !== undefined && prepared.result.items.some((item) => currentRetrievableDeliveryEntry(database, workspace, {
    entryId: item.entryId,
    entryRevision: item.revision,
    origin: item.origin,
  }) === null)) {
    throw new KiokukoError('CONFLICT', 'Scoped context selection changed before return');
  }
  assertScopedSelectionState(database, prepared.selectionWorkspaces, prepared.retrievalStateHash);
  if (prepared.replayDelivery !== null) {
    assertScopedReplayDeliveryUnchanged(database, prepared.replayDelivery);
  }
}

function persistPreparedScopedContext(
  database: SqliteDatabase,
  prepared: PreparedScopedContext,
  assertBeforePersist?: () => void,
): ScopedContextResult {
  if (prepared.pendingDelivery === null) {
    return withImmediateTransaction(database, () => {
      assertPreparedScopedState(database, prepared);
      if (assertBeforePersist !== undefined) {
        assertBeforePersist();
        assertPreparedScopedState(database, prepared);
      }
      return prepared.result;
    });
  }
  const request = prepared.pendingDelivery;
  return withImmediateTransaction(database, () => {
    if (prepared.run === null) throw new KiokukoError('INTEGRITY_ERROR', 'Stored scoped context run is invalid');
    assertPreparedScopedState(database, prepared);
    if (assertBeforePersist !== undefined) {
      assertBeforePersist();
      assertPreparedScopedState(database, prepared);
    }
    const delivery = recordContextDeliveryInTransaction(
      database,
      { ...request, deliveryId: scopedDeliveryId(request) },
    );
    return {
      ...prepared.result,
      items: storedScopedItems(database, delivery),
      deliveryId: delivery.deliveryId,
      truncated: delivery.truncated,
    };
  });
}

export async function queryScopedContext(
  database: SqliteDatabase,
  raw: ScopedContextQuery,
  runtime: HybridSearchRuntime = {},
): Promise<ScopedContextResult> {
  return persistPreparedScopedContext(database, await prepareScopedContext(database, raw, runtime));
}

export async function queryScopedContextGated<T>(
  database: SqliteDatabase,
  raw: ScopedContextQuery,
  decide: (candidate: ScopedContextResult) => ScopedContextGateDecision<T>,
  runtime: HybridSearchRuntime = {},
): Promise<ScopedContextGatedResult<T>> {
  const prepared = await prepareScopedContext(database, raw, runtime);
  const decision = normalizedScopedGateDecision<T>(decide(prepared.result));
  if (!decision.persist) {
    withImmediateTransaction(database, () => {
      assertPreparedScopedState(database, prepared);
      if (decision.assertBeforePersist !== undefined) {
        decision.assertBeforePersist();
        assertPreparedScopedState(database, prepared);
      }
    });
  }
  return {
    context: decision.persist ? persistPreparedScopedContext(database, prepared, decision.assertBeforePersist) : null,
    value: decision.value,
    selectionStateHash: prepared.selectionStateHash,
  };
}
