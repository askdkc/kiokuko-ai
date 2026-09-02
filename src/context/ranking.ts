import { KiokukoError } from '../errors.js';
import { ENTRY_KINDS, ENTRY_STATUSES, TRUST_LEVELS, type EntryKind, type EntryStatus, type TrustLevel } from '../serialization/validate.js';
import { TASK_TYPES, type TaskProfile, type TaskType } from '../akinator/types.js';

export const CONTEXT_RANKING_VERSION = 'context-ranking-v1' as const;

/** Integer score weights. Components are additive and deliberately bounded. */
export const CONTEXT_RANKING_WEIGHTS = Object.freeze({
  statusVerified: 100,
  statusCandidate: 40,
  trustSystemVerified: 30,
  trustSourceVerified: 25,
  trustUserAsserted: 15,
  confidence: 20,
  taskAffinity: 12,
  recommendedTag: 10,
  pathOverlap: 12,
  errorSignature: 15,
  feedbackHelpful: 3,
  feedbackIrrelevant: -3,
  feedbackStale: -4,
  feedbackConflicting: -4,
  recency: 5,
  contradiction: 0,
} as const);

export const CONTEXT_RANKING_COMPONENTS = [
  'status',
  'trust',
  'confidence',
  'taskAffinity',
  'recommendedTags',
  'pathOverlap',
  'errorSignature',
  'feedback',
  'recency',
  'contradiction',
] as const;

/** Additive v2 delivery components; v1 rows continue to use the list above. */
export const CONTEXT_RANKING_COMPONENTS_V2 = [
  'status',
  'trust',
  'confidence',
  'retrieval',
  'taskAffinity',
  'recommendedTags',
  'scopeAffinity',
  'applicability',
  'pathOverlap',
  'errorSignature',
  'exactSignal',
  'feedback',
  'recency',
  'contradiction',
] as const;

export const CONTEXT_SELECTION_REASON_ORDER = [
  'project_origin',
  'ecosystem_origin',
  'global_origin',
  'scope_affinity',
  'applicability_match',
  'applicability_unknown',
  'applicability_mismatch',
  'unscoped_global_prior',
  'exact_signal_match',
  'word_match',
  'semantic_match',
  'lexical_match',
  'cjk_window_match',
  'substring_match',
  'literal_fallback_match',
  'tag_match',
  'verified',
  'candidate',
  'system_verified_trust',
  'source_verified_trust',
  'user_asserted_trust',
  'confidence',
  'task_kind_affinity',
  'task_tag_affinity',
  'recommended_tag_match',
  'target_match',
  'changed_path_match',
  'error_signature_match',
  'helpful_feedback',
  'irrelevant_feedback',
  'stale_feedback',
  'conflicting_feedback',
  'recent',
  'contradiction_warning',
  'revision_changed',
] as const;

export type ContextRankingComponent = (typeof CONTEXT_RANKING_COMPONENTS)[number];
export type ContextRankingV2Component = (typeof CONTEXT_RANKING_COMPONENTS_V2)[number];
export type FeedbackVerdict = 'helpful' | 'irrelevant' | 'stale' | 'conflicting';

export interface ContextCandidateSnapshot {
  id: string;
  revision: number;
  kind: EntryKind;
  status: EntryStatus;
  trustLevel: TrustLevel;
  confidence: number;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  scope: Record<string, unknown>;
  updatedAt: string;
  selectionReasons?: string[];
  contradiction?: boolean;
  origin?: 'project' | 'ecosystem' | 'global';
}

export interface PriorDeliveredEntry {
  entryId: string;
  revision: number;
}

export interface ContextFeedback {
  entryId: string;
  verdict: FeedbackVerdict;
}

export interface RankedScoreComponents {
  status: number;
  trust: number;
  confidence: number;
  taskAffinity: number;
  recommendedTags: number;
  pathOverlap: number;
  errorSignature: number;
  feedback: number;
  recency: number;
  contradiction: number;
}

export interface RankedCandidateContent {
  title: string;
  summary: string | null;
  bodyPreview: string;
  characterCount: number;
  truncated: boolean;
}

export interface RankedCandidate {
  entryId: string;
  revision: number;
  kind: EntryKind;
  status: EntryStatus;
  trustLevel: TrustLevel;
  confidence: number;
  tags: string[];
  scope: Record<string, unknown>;
  updatedAt: string;
  totalScore: number;
  scoreComponents: RankedScoreComponents;
  selectionReasons: string[];
  content: RankedCandidateContent;
  origin?: 'project' | 'ecosystem' | 'global';
}

const MAX_CANDIDATES = 500;
const MAX_ARRAY_ITEMS = 500;
const MAX_ID_LENGTH = 200;
const MAX_TAG_LENGTH = 200;
const MAX_PATH_LENGTH = 1_000;
const MAX_ERROR_SIGNATURE_LENGTH = 500;
const MAX_TITLE_LENGTH = 2_000;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_BODY_LENGTH = 100_000;
const MAX_SCOPE_DEPTH = 6;
const MAX_SCOPE_ITEMS = 500;
export const CONTEXT_RANKING_DEFAULT_CHARACTER_BUDGET = 8_000;
// Chosen to match the existing bounded retrieval ceiling; delivery previews remain capped.
export const CONTEXT_RANKING_MAX_CHARACTER_BUDGET = 100_000;
const DEFAULT_CHARACTER_BUDGET = CONTEXT_RANKING_DEFAULT_CHARACTER_BUDGET;
const MAX_CHARACTER_BUDGET = CONTEXT_RANKING_MAX_CHARACTER_BUDGET;

const TASK_AFFINITY: Readonly<Record<TaskType, { kinds: readonly EntryKind[]; tags: readonly string[] }>> = {
  build: { kinds: ['decision', 'lesson', 'reference'], tags: ['build', 'builder', 'implementation', 'skill:tdd', 'skill:codebase-design', 'skill:test-driven-development'] },
  debug: { kinds: ['lesson', 'decision', 'reference'], tags: ['debug', 'debugging', 'reviewer', 'skill:diagnosing-bugs', 'skill:systematic-debugging'] },
  research: { kinds: ['reference', 'fact'], tags: ['research', 'researcher', 'skill:research', 'skill:grounded-citations'] },
  review: { kinds: ['lesson', 'decision', 'reference'], tags: ['review', 'reviewer', 'code-review', 'skill:code-review', 'skill:requesting-code-review'] },
  devops: { kinds: ['lesson', 'decision', 'reference'], tags: ['devops', 'skill:wizard', 'skill:server-resource-monitoring'] },
  writing: { kinds: ['preference', 'reference', 'decision'], tags: ['writing', 'writer', 'skill:writing-for-agents', 'skill:writing-plans'] },
  analysis: { kinds: ['fact', 'reference', 'decision'], tags: ['analysis', 'analyst'] },
};

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Invalid context ranking input');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function knownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) invalid();
}

function requiredFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some((field) => !hasOwn(value, field))) invalid();
}

function boundedString(value: unknown, max: number, nonEmpty = true): string {
  if (typeof value !== 'string' || value.length > max || (nonEmpty && value.trim().length === 0)) invalid();
  return value;
}

function positiveInteger(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) invalid();
  return value;
}

function finiteConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}

function canonicalTimestamp(value: unknown): string {
  const timestamp = boundedString(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) invalid();
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) invalid();
  return timestamp;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid();
  return value as T[number];
}

function cloneScope(value: unknown, depth = 0, itemCount = { value: 0 }): Record<string, unknown> {
  if (!isRecord(value) || depth > MAX_SCOPE_DEPTH) invalid();
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key.length > MAX_TAG_LENGTH) invalid();
    itemCount.value += 1;
    if (itemCount.value > MAX_SCOPE_ITEMS) invalid();
    const child = value[key];
    if (child === null || typeof child === 'boolean') {
      result[key] = child;
    } else if (typeof child === 'string') {
      result[key] = boundedString(child, MAX_BODY_LENGTH, false);
    } else if (typeof child === 'number') {
      if (!Number.isFinite(child)) invalid();
      result[key] = child;
    } else if (Array.isArray(child)) {
      if (child.length > MAX_ARRAY_ITEMS) invalid();
      result[key] = child.map((item) => cloneScopeValue(item, depth + 1, itemCount));
    } else if (isRecord(child)) {
      result[key] = cloneScope(child, depth + 1, itemCount);
    } else {
      invalid();
    }
  }
  return result;
}

function cloneScopeValue(value: unknown, depth: number, itemCount: { value: number }): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundedString(value, MAX_BODY_LENGTH, false);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) invalid();
    return value.map((item) => cloneScopeValue(item, depth + 1, itemCount));
  }
  if (isRecord(value)) return cloneScope(value, depth, itemCount);
  invalid();
}

function stringArray(value: unknown, maxLength: number, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  return value.map((item) => boundedString(item, maxLength));
}

function normalizeLiteral(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function literalTokens(value: string): string[] {
  const normalized = normalizeLiteral(value);
  return normalized.match(/[\p{L}\p{N}](?:[\p{L}\p{N}._:/\\-]*[\p{L}\p{N}])?/gu) ?? [];
}

function pathEvidenceTokens(value: string): Set<string> {
  const result = new Set<string>();
  for (const token of literalTokens(value)) {
    result.add(token);
    for (const segment of token.split(/[\\/]+/u)) {
      if (segment.length > 0) result.add(segment);
    }
  }
  return result;
}

function collectScopeStrings(value: Record<string, unknown>, result: string[] = []): string[] {
  for (const child of Object.values(value)) {
    if (typeof child === 'string') result.push(child);
    else if (Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string') result.push(item);
        else if (isRecord(item)) collectScopeStrings(item, result);
      }
    } else if (isRecord(child)) collectScopeStrings(child, result);
  }
  return result;
}

function candidatePathFields(candidate: ContextCandidateSnapshot): string[] {
  return [candidate.title, ...candidate.tags, ...collectScopeStrings(candidate.scope)];
}

function candidateErrorFields(candidate: ContextCandidateSnapshot): string[] {
  return [candidate.title, ...(candidate.summary === null ? [] : [candidate.summary]), ...candidate.tags, ...collectScopeStrings(candidate.scope)];
}

function literalMatch(field: string, signature: string): boolean {
  const normalizedField = normalizeLiteral(field);
  const normalizedSignature = normalizeLiteral(signature);
  const start = normalizedField.indexOf(normalizedSignature);
  if (start < 0) return false;
  if (!/^[\u0000-\u007f]+$/u.test(normalizedSignature)) return true;
  const before = normalizedField[start - 1];
  const after = normalizedField[start + normalizedSignature.length];
  const word = /[A-Za-z0-9_]/u;
  return !(before !== undefined && word.test(before)) && !(after !== undefined && word.test(after));
}

interface RankingContext {
  taskProfile: TaskProfile;
  recommendedTags: Set<string>;
  changedPaths: string[];
  errorSignatures: string[];
  priorDelivered: Map<string, number>;
  feedback: Map<string, FeedbackVerdict[]>;
  oldestUpdatedAt: number;
}

function parseTaskProfile(value: unknown): TaskProfile {
  if (!isRecord(value)) invalid();
  knownFields(value, ['taskType', 'target', 'expected', 'constraints']);
  requiredFields(value, ['taskType', 'target', 'expected', 'constraints']);
  const taskType = value.taskType === null ? null : enumValue(value.taskType, TASK_TYPES);
  const target = value.target === null ? null : boundedString(value.target, MAX_PATH_LENGTH);
  const expected = value.expected === null ? null : boundedString(value.expected, MAX_SUMMARY_LENGTH);
  const constraints = value.constraints === null ? null : boundedString(value.constraints, MAX_SUMMARY_LENGTH);
  return { taskType, target, expected, constraints };
}

function parseCandidate(value: unknown): ContextCandidateSnapshot {
  if (!isRecord(value)) invalid();
  knownFields(value, [
    'id', 'revision', 'kind', 'status', 'trustLevel', 'confidence', 'title', 'summary', 'body', 'tags', 'scope', 'updatedAt', 'selectionReasons', 'contradiction', 'origin',
  ]);
  requiredFields(value, [
    'id', 'revision', 'kind', 'status', 'trustLevel', 'confidence', 'title', 'summary', 'body', 'tags', 'scope', 'updatedAt',
  ]);
  const summary = value.summary === null ? null : boundedString(value.summary, MAX_SUMMARY_LENGTH, false);
  const contradiction = value.contradiction === undefined ? false : value.contradiction;
  if (typeof contradiction !== 'boolean') invalid();
  const selectionReasons = value.selectionReasons === undefined
    ? []
    : stringArray(value.selectionReasons, MAX_TAG_LENGTH, CONTEXT_SELECTION_REASON_ORDER.length);
  if (selectionReasons.some((reason) => !CONTEXT_SELECTION_REASON_ORDER.includes(reason as (typeof CONTEXT_SELECTION_REASON_ORDER)[number]))) invalid();
  return {
    id: boundedString(value.id, MAX_ID_LENGTH),
    revision: positiveInteger(value.revision, Number.MAX_SAFE_INTEGER),
    kind: enumValue(value.kind, ENTRY_KINDS),
    status: enumValue(value.status, ENTRY_STATUSES),
    trustLevel: enumValue(value.trustLevel, TRUST_LEVELS),
    confidence: finiteConfidence(value.confidence),
    title: boundedString(value.title, MAX_TITLE_LENGTH),
    summary,
    body: boundedString(value.body, MAX_BODY_LENGTH, false),
    tags: stringArray(value.tags, MAX_TAG_LENGTH, MAX_ARRAY_ITEMS),
    scope: cloneScope(value.scope),
    updatedAt: canonicalTimestamp(value.updatedAt),
    ...(selectionReasons.length === 0 ? {} : { selectionReasons: canonicalSelectionReasons(selectionReasons) }),
    ...(contradiction ? { contradiction: true } : {}),
    ...(value.origin === undefined ? {} : { origin: enumValue(value.origin, ['project', 'ecosystem', 'global'] as const) }),
  };
}

function parseInput(value: unknown): {
  taskProfile: TaskProfile;
  recommendedTags: string[];
  changedPaths: string[];
  errorSignatures: string[];
  priorDelivered: PriorDeliveredEntry[];
  feedback: ContextFeedback[];
  candidates: ContextCandidateSnapshot[];
  limit: number;
  characterBudget: number;
} {
  if (!isRecord(value)) invalid();
  knownFields(value, ['taskProfile', 'recommendedTags', 'changedPaths', 'errorSignatures', 'priorDelivered', 'feedback', 'candidates', 'limit', 'characterBudget']);
  requiredFields(value, ['taskProfile', 'recommendedTags', 'changedPaths', 'errorSignatures', 'priorDelivered', 'feedback', 'candidates', 'limit']);
  const candidatesValue = value.candidates;
  if (!Array.isArray(candidatesValue) || candidatesValue.length > MAX_CANDIDATES) invalid();
  const candidates = candidatesValue.map(parseCandidate);
  const ids = new Set<string>();
  for (const candidateValue of candidates) {
    if (ids.has(candidateValue.id)) invalid();
    ids.add(candidateValue.id);
  }
  if (!Array.isArray(value.priorDelivered) || value.priorDelivered.length > MAX_ARRAY_ITEMS) invalid();
  const priorDelivered = value.priorDelivered.map((item): PriorDeliveredEntry => {
    if (!isRecord(item)) invalid();
    knownFields(item, ['entryId', 'revision']);
    requiredFields(item, ['entryId', 'revision']);
    return { entryId: boundedString(item.entryId, MAX_ID_LENGTH), revision: positiveInteger(item.revision, Number.MAX_SAFE_INTEGER) };
  });
  if (!Array.isArray(value.feedback) || value.feedback.length > MAX_ARRAY_ITEMS) invalid();
  const feedback = value.feedback.map((item): ContextFeedback => {
    if (!isRecord(item)) invalid();
    knownFields(item, ['entryId', 'verdict']);
    requiredFields(item, ['entryId', 'verdict']);
    return { entryId: boundedString(item.entryId, MAX_ID_LENGTH), verdict: enumValue(item.verdict, ['helpful', 'irrelevant', 'stale', 'conflicting'] as const) };
  });
  const characterBudget = value.characterBudget === undefined ? DEFAULT_CHARACTER_BUDGET : positiveInteger(value.characterBudget, MAX_CHARACTER_BUDGET);
  return {
    taskProfile: parseTaskProfile(value.taskProfile),
    recommendedTags: stringArray(value.recommendedTags, MAX_TAG_LENGTH, MAX_ARRAY_ITEMS),
    changedPaths: stringArray(value.changedPaths, MAX_PATH_LENGTH, MAX_ARRAY_ITEMS),
    errorSignatures: stringArray(value.errorSignatures, MAX_ERROR_SIGNATURE_LENGTH, MAX_ARRAY_ITEMS),
    priorDelivered,
    feedback,
    candidates,
    limit: positiveInteger(value.limit, 100),
    characterBudget,
  };
}

function statusScore(status: EntryStatus): number {
  return status === 'verified' ? CONTEXT_RANKING_WEIGHTS.statusVerified : CONTEXT_RANKING_WEIGHTS.statusCandidate;
}

function trustScore(trustLevel: TrustLevel): number {
  if (trustLevel === 'system_verified') return CONTEXT_RANKING_WEIGHTS.trustSystemVerified;
  if (trustLevel === 'source_verified') return CONTEXT_RANKING_WEIGHTS.trustSourceVerified;
  if (trustLevel === 'user_asserted') return CONTEXT_RANKING_WEIGHTS.trustUserAsserted;
  return 0;
}

function scoreCandidate(candidate: ContextCandidateSnapshot, context: RankingContext): RankedCandidate {
  const origin = candidate.origin;
  const candidateTags = new Set(candidate.tags.map(normalizeLiteral));
  const taskAffinity = context.taskProfile.taskType === null ? null : TASK_AFFINITY[context.taskProfile.taskType];
  const taskTagMatch = taskAffinity?.tags.some((tag) => candidateTags.has(normalizeLiteral(tag))) ?? false;
  const taskKindMatch = taskAffinity?.kinds.includes(candidate.kind) ?? false;
  const recommendedTagMatches = [...context.recommendedTags].filter((tag) => candidateTags.has(tag)).length;
  const candidatePathTokens = new Set<string>();
  for (const field of candidatePathFields(candidate)) {
    for (const token of pathEvidenceTokens(field)) candidatePathTokens.add(token);
  }
  const targetMatch = context.taskProfile.target !== null
    && [...pathEvidenceTokens(context.taskProfile.target)].some((token) => candidatePathTokens.has(token));
  const changedPathMatch = context.changedPaths.some((path) => [...pathEvidenceTokens(path)].some((token) => candidatePathTokens.has(token)));
  const errorMatches = candidate.kind === 'lesson' || candidate.kind === 'reference'
    ? context.errorSignatures.filter((signature) => candidateErrorFields(candidate).some((field) => literalMatch(field, signature))).length
    : 0;
  const feedbackVerdicts = context.feedback.get(candidate.id) ?? [];
  const feedbackScore = feedbackVerdicts.reduce((sum, verdict) => {
    if (verdict === 'helpful') return sum + CONTEXT_RANKING_WEIGHTS.feedbackHelpful;
    if (verdict === 'irrelevant') return sum + CONTEXT_RANKING_WEIGHTS.feedbackIrrelevant;
    if (verdict === 'stale') return sum + CONTEXT_RANKING_WEIGHTS.feedbackStale;
    return sum + CONTEXT_RANKING_WEIGHTS.feedbackConflicting;
  }, 0);
  const recencyScore = Math.min(5, Math.floor(Math.max(0, Date.parse(candidate.updatedAt) - context.oldestUpdatedAt) / 86_400_000));
  const scoreComponents: RankedScoreComponents = {
    status: statusScore(candidate.status),
    trust: trustScore(candidate.trustLevel),
    confidence: Math.round(candidate.confidence * CONTEXT_RANKING_WEIGHTS.confidence),
    taskAffinity: taskKindMatch || taskTagMatch ? CONTEXT_RANKING_WEIGHTS.taskAffinity : 0,
    recommendedTags: Math.min(20, recommendedTagMatches * CONTEXT_RANKING_WEIGHTS.recommendedTag),
    pathOverlap: targetMatch || changedPathMatch ? CONTEXT_RANKING_WEIGHTS.pathOverlap : 0,
    errorSignature: Math.min(30, errorMatches * CONTEXT_RANKING_WEIGHTS.errorSignature),
    feedback: Math.max(-4, Math.min(4, feedbackScore)),
    recency: recencyScore,
    contradiction: 0,
  };
  const selectionReasons: string[] = [...(candidate.selectionReasons ?? [])];
  if (origin !== undefined) selectionReasons.push(origin === 'project' ? 'project_origin' : origin === 'ecosystem' ? 'ecosystem_origin' : 'global_origin');
  if (candidate.status === 'verified') selectionReasons.push('verified');
  else selectionReasons.push('candidate');
  if (candidate.trustLevel !== 'untrusted') selectionReasons.push(`${candidate.trustLevel}_trust`);
  if (scoreComponents.confidence > 0) selectionReasons.push('confidence');
  if (taskKindMatch) selectionReasons.push('task_kind_affinity');
  if (taskTagMatch) selectionReasons.push('task_tag_affinity');
  if (scoreComponents.recommendedTags > 0) selectionReasons.push('recommended_tag_match');
  if (targetMatch) selectionReasons.push('target_match');
  if (changedPathMatch) selectionReasons.push('changed_path_match');
  if (scoreComponents.errorSignature > 0) selectionReasons.push('error_signature_match');
  if (feedbackVerdicts.includes('helpful')) selectionReasons.push('helpful_feedback');
  for (const verdict of ['irrelevant', 'stale', 'conflicting'] as const) {
    if (feedbackVerdicts.includes(verdict)) selectionReasons.push(`${verdict}_feedback`);
  }
  if (recencyScore > 0) selectionReasons.push('recent');
  if (candidate.contradiction === true) selectionReasons.push('contradiction_warning');
  const deliveredRevision = context.priorDelivered.get(candidate.id);
  if (deliveredRevision !== undefined && candidate.revision > deliveredRevision) selectionReasons.push('revision_changed');
  const canonicalReasons = canonicalSelectionReasons(selectionReasons);
  return {
    entryId: candidate.id,
    revision: candidate.revision,
    kind: candidate.kind,
    status: candidate.status,
    trustLevel: candidate.trustLevel,
    confidence: candidate.confidence,
    tags: [...candidate.tags].sort(compareStrings),
    scope: cloneScope(candidate.scope),
    updatedAt: candidate.updatedAt,
    totalScore: Object.values(scoreComponents).reduce((sum, component) => sum + component, 0) + (origin === undefined ? 0 : origin === 'project' ? 100 : origin === 'ecosystem' ? 45 : 35),
    scoreComponents,
    selectionReasons: canonicalReasons,
    content: {
      title: candidate.title,
      summary: candidate.summary,
      bodyPreview: candidate.body,
      characterCount: candidate.title.length + (candidate.summary?.length ?? 0) + candidate.body.length,
      truncated: false,
    },
    ...(candidate.origin === undefined ? {} : { origin }),
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reasonRank(reason: string): number {
  const index = CONTEXT_SELECTION_REASON_ORDER.indexOf(reason as (typeof CONTEXT_SELECTION_REASON_ORDER)[number]);
  return index === -1 ? CONTEXT_SELECTION_REASON_ORDER.length : index;
}

function canonicalSelectionReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)].sort((left, right) => reasonRank(left) - reasonRank(right) || compareStrings(left, right));
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function takeCharacters(value: string, budget: number): string {
  return Array.from(value).slice(0, Math.max(0, budget)).join('');
}

function fitContent(content: RankedCandidateContent, budget: number): RankedCandidateContent {
  let remaining = budget;
  const title = takeCharacters(content.title, remaining);
  remaining -= characterCount(title);
  const fullSummary = content.summary ?? '';
  const summaryText = takeCharacters(fullSummary, remaining);
  remaining -= characterCount(summaryText);
  const bodyPreview = takeCharacters(content.bodyPreview, remaining);
  const truncated = title.length !== content.title.length
    || summaryText.length !== fullSummary.length
    || bodyPreview.length !== content.bodyPreview.length;
  return {
    title,
    summary: content.summary === null ? null : summaryText,
    bodyPreview,
    characterCount: characterCount(title) + characterCount(summaryText) + characterCount(bodyPreview),
    truncated,
  };
}

function applyCharacterBudget(ranked: RankedCandidate[], budget: number): RankedCandidate[] {
  const selected: RankedCandidate[] = [];
  let remaining = budget;
  for (const candidate of ranked) {
    if (remaining <= 0) break;
    const content = fitContent(candidate.content, remaining);
    selected.push({ ...candidate, content });
    remaining -= content.characterCount;
  }
  return selected;
}

export function rankContextCandidates(input: unknown): RankedCandidate[] {
  const parsed = parseInput(input);
  const priorDelivered = new Map<string, number>();
  for (const delivered of parsed.priorDelivered) {
    priorDelivered.set(delivered.entryId, Math.max(delivered.revision, priorDelivered.get(delivered.entryId) ?? 0));
  }
  const feedback = new Map<string, FeedbackVerdict[]>();
  for (const signal of parsed.feedback) feedback.set(signal.entryId, [...(feedback.get(signal.entryId) ?? []), signal.verdict]);
  const context: RankingContext = {
    taskProfile: parsed.taskProfile,
    recommendedTags: new Set(parsed.recommendedTags.map(normalizeLiteral)),
    changedPaths: parsed.changedPaths,
    errorSignatures: parsed.errorSignatures,
    priorDelivered,
    feedback,
    oldestUpdatedAt: parsed.candidates.length === 0 ? 0 : Math.min(...parsed.candidates.map((candidate) => Date.parse(candidate.updatedAt))),
  };
  const ranked = parsed.candidates
    .filter((candidate) => candidate.status !== 'superseded')
    .filter((candidate) => {
      const deliveredRevision = context.priorDelivered.get(candidate.id);
      return deliveredRevision === undefined || candidate.revision > deliveredRevision;
    })
    .map((candidate) => scoreCandidate(candidate, context))
    .sort((left, right) => right.totalScore - left.totalScore || compareStrings(left.entryId, right.entryId));
  return applyCharacterBudget(ranked.slice(0, parsed.limit), parsed.characterBudget);
}
