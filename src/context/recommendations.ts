import { KiokukoError } from '../errors.js';

export const RECOMMENDATION_POLICY_VERSION = 'recommendations.v1' as const;

export const RECOMMENDATION_CODES = [
  'INTAKE_INCOMPLETE',
  'VERIFY_AFTER_MUTATION',
  'SIDE_EFFECT_OUTCOME_UNKNOWN',
  'UNRESOLVED_FAILURE',
  'COVERAGE_INCOMPLETE',
  'CONTEXT_STALE',
  'CONTRADICTORY_MEMORY',
  'PROMOTION_CANDIDATE',
] as const;

export type RecommendationCode = (typeof RECOMMENDATION_CODES)[number];

export const RECOMMENDATION_PRIORITY: Readonly<Record<RecommendationCode, number>> = Object.freeze({
  INTAKE_INCOMPLETE: 1,
  VERIFY_AFTER_MUTATION: 2,
  SIDE_EFFECT_OUTCOME_UNKNOWN: 3,
  UNRESOLVED_FAILURE: 4,
  COVERAGE_INCOMPLETE: 5,
  CONTEXT_STALE: 6,
  CONTRADICTORY_MEMORY: 7,
  PROMOTION_CANDIDATE: 8,
});

export const MAX_RECOMMENDATIONS = RECOMMENDATION_CODES.length;
export const MAX_EVIDENCE_EVENT_IDS = 16;
export const MAX_REFERENCE_IDS = 16;
export const MAX_INPUT_ITEMS = 4096;

export const RECOMMENDATION_MESSAGES: Readonly<Record<RecommendationCode, string>> = Object.freeze({
  INTAKE_INCOMPLETE: 'Intake is incomplete; required task details remain unanswered',
  VERIFY_AFTER_MUTATION: 'Passing evidence predates the latest mutation',
  SIDE_EFFECT_OUTCOME_UNKNOWN: 'A side effect has no known outcome',
  UNRESOLVED_FAILURE: 'Unresolved failures remain',
  COVERAGE_INCOMPLETE: 'Observed coverage is incomplete',
  CONTEXT_STALE: 'Previously delivered context may be stale',
  CONTRADICTORY_MEMORY: 'Verified memory entries contain a contradiction',
  PROMOTION_CANDIDATE: 'A durable proposal is eligible for candidate promotion only',
});

const COVERAGE_CATEGORIES = ['approval', 'command', 'file', 'run', 'tool'] as const;
const COVERAGE_LEVELS = ['complete', 'best_effort', 'declared', 'unavailable'] as const;
const MISSING_PROFILE_FIELDS = ['taskType', 'target', 'expected'] as const;
const EVIDENCE_STATES = ['none', 'failed', 'fresh', 'stale'] as const;
const TASK_TYPES = ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'] as const;

type CoverageCategory = (typeof COVERAGE_CATEGORIES)[number];
type CoverageLevel = (typeof COVERAGE_LEVELS)[number];
type MissingProfileField = (typeof MISSING_PROFILE_FIELDS)[number];
type EvidenceState = (typeof EVIDENCE_STATES)[number];

type PlainObject = Record<string, unknown>;

export interface RecommendationMetadata {
  truncated: boolean;
  referenceIds: string[];
  incompleteCoverageCategories?: CoverageCategory[];
}

export interface Recommendation {
  code: RecommendationCode;
  message: string;
  evidenceEventIds: string[];
  priority: number;
  untrusted: true;
  actionable: false;
  metadata: RecommendationMetadata;
}

export interface RecommendationProjectionInput {
  intakeIncomplete: boolean;
  missingProfileFields: MissingProfileField[];
  evidenceState: EvidenceState;
  unresolvedFailureEventIds: string[];
  unknownOutcomeEventIds: string[];
  coverage: 'complete' | 'partial';
  declaredCoverage?: Partial<Record<CoverageCategory, CoverageLevel>>;
  incompleteCoverageCategories?: CoverageCategory[];
  latestMutationEventIds?: string[];
  latestPassingVerificationEventIds?: string[];
  throughSequence?: number;
  latestMutationSequence?: number | null;
  latestPassingVerificationSequence?: number | null;
  profileHash?: string;
  taskProfile?: {
    taskType: (typeof TASK_TYPES)[number] | null;
    target: string | null;
    expected: string | null;
    constraints: string | null;
  };
}

export interface RecommendationStaleDeliveredEntryInput {
  entryId: string;
  deliveredRevision: number;
  currentRevision: number;
  stale?: boolean;
  evidenceEventIds?: string[];
}

export interface RecommendationContradictionPairInput {
  leftEntryId: string;
  rightEntryId: string;
  verified: boolean;
  evidenceEventIds?: string[];
}

export interface RecommendationPromotionCandidateInput {
  eventId: string;
  eligible: boolean;
  evidenceEventIds?: string[];
}

export interface RecommendationBrokerInput {
  staleDeliveredEntries?: RecommendationStaleDeliveredEntryInput[];
  contradictoryMemoryPairs?: RecommendationContradictionPairInput[];
  promotionCandidates?: RecommendationPromotionCandidateInput[];
}

interface BoundedIds<T extends string = string> {
  values: T[];
  truncated: boolean;
}

interface NormalizedProjection {
  intakeIncomplete: boolean;
  missingProfileFields: MissingProfileField[];
  evidenceState: EvidenceState;
  unresolvedFailureEventIds: string[];
  unknownOutcomeEventIds: string[];
  coverage: 'complete' | 'partial';
  declaredCoverage?: Partial<Record<CoverageCategory, CoverageLevel>>;
  incompleteCoverageCategories: CoverageCategory[];
  latestMutationEventIds: string[];
  latestPassingVerificationEventIds: string[];
}

interface NormalizedStaleDeliveredEntry {
  entryId: string;
  stale: boolean;
  evidenceEventIds: string[];
}

interface NormalizedContradictionPair {
  leftEntryId: string;
  rightEntryId: string;
  verified: boolean;
  evidenceEventIds: string[];
}

interface NormalizedPromotionCandidate {
  eventId: string;
  eligible: boolean;
  evidenceEventIds: string[];
}

interface NormalizedBroker {
  staleDeliveredEntries: NormalizedStaleDeliveredEntry[];
  contradictoryMemoryPairs: NormalizedContradictionPair[];
  promotionCandidates: NormalizedPromotionCandidate[];
}

interface NormalizedInput {
  projection: NormalizedProjection;
  broker: NormalizedBroker;
}

const TOP_LEVEL_FIELDS = ['projection', 'broker'] as const;
const PROJECTION_FIELDS = [
  'intakeIncomplete', 'missingProfileFields', 'evidenceState', 'unresolvedFailureEventIds',
  'unknownOutcomeEventIds', 'coverage', 'declaredCoverage', 'incompleteCoverageCategories',
  'latestMutationEventIds', 'latestPassingVerificationEventIds', 'throughSequence',
  'latestMutationSequence', 'latestPassingVerificationSequence', 'profileHash', 'taskProfile',
] as const;
const BROKER_FIELDS = ['staleDeliveredEntries', 'contradictoryMemoryPairs', 'promotionCandidates'] as const;
const STALE_ENTRY_FIELDS = ['entryId', 'deliveredRevision', 'currentRevision', 'stale', 'evidenceEventIds'] as const;
const CONTRADICTION_FIELDS = ['leftEntryId', 'rightEntryId', 'verified', 'evidenceEventIds'] as const;
const PROMOTION_FIELDS = ['eventId', 'eligible', 'evidenceEventIds'] as const;
const COVERAGE_FIELDS = COVERAGE_CATEGORIES;
const TASK_PROFILE_FIELDS = ['taskType', 'target', 'expected', 'constraints'] as const;

function validation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Invalid recommendation input');
}

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: PlainObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function knownFields(value: PlainObject, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) validation();
}

function requiredFields(value: PlainObject, required: readonly string[]): void {
  if (required.some((key) => !hasOwn(value, key))) validation();
}

function safeIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) validation();
  if (/\s|:\/\/|[;&|<>`$]/u.test(value)) validation();
  if (/(?:bearer|basic)\s|(?:ghp_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{16})/iu.test(value)) validation();
  return value;
}

function idList(value: unknown, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > MAX_INPUT_ITEMS) validation();
  return [...new Set(value.map((item) => safeIdentifier(item)))].sort();
}

function bounded<T extends string>(values: readonly T[], maximum: number): BoundedIds<T> {
  const unique = [...new Set(values)].sort() as T[];
  return { values: unique.slice(0, maximum), truncated: unique.length > maximum };
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) validation();
  return value as T;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') validation();
  return value;
}

function sequence(value: unknown, optional: boolean): number | null {
  if (value === undefined && optional) return null;
  if (value === null && optional) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) validation();
  return value;
}

function parseTaskProfile(value: unknown): RecommendationProjectionInput['taskProfile'] {
  if (!isPlainObject(value)) validation();
  knownFields(value, TASK_PROFILE_FIELDS);
  requiredFields(value, TASK_PROFILE_FIELDS);
  const taskType = value.taskType === null ? null : enumValue(value.taskType, TASK_TYPES);
  for (const field of ['target', 'expected', 'constraints'] as const) {
    if (value[field] !== null && typeof value[field] !== 'string') validation();
  }
  return {
    taskType,
    target: value.target as string | null,
    expected: value.expected as string | null,
    constraints: value.constraints as string | null,
  };
}

function parseDeclaredCoverage(value: unknown): Partial<Record<CoverageCategory, CoverageLevel>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) validation();
  knownFields(value, COVERAGE_FIELDS);
  const result: Partial<Record<CoverageCategory, CoverageLevel>> = {};
  for (const category of COVERAGE_CATEGORIES) {
    if (hasOwn(value, category)) result[category] = enumValue(value[category], COVERAGE_LEVELS);
  }
  return result;
}

function parseProjection(value: unknown): NormalizedProjection {
  if (!isPlainObject(value)) validation();
  knownFields(value, PROJECTION_FIELDS);
  requiredFields(value, [
    'intakeIncomplete', 'missingProfileFields', 'evidenceState', 'unresolvedFailureEventIds',
    'unknownOutcomeEventIds', 'coverage',
  ]);
  const intakeIncomplete = booleanValue(value.intakeIncomplete);
  const missingProfileFields = idList(value.missingProfileFields, true) as MissingProfileField[];
  if (missingProfileFields.some((field) => !MISSING_PROFILE_FIELDS.includes(field))) validation();
  const evidenceState = enumValue(value.evidenceState, EVIDENCE_STATES);
  const coverage = enumValue(value.coverage, ['complete', 'partial'] as const);
  const declaredCoverage = parseDeclaredCoverage(value.declaredCoverage);
  const incompleteCoverageCategories = idList(value.incompleteCoverageCategories, false) as CoverageCategory[];
  if (incompleteCoverageCategories.some((category) => !COVERAGE_CATEGORIES.includes(category))) validation();
  if (intakeIncomplete && missingProfileFields.length === 0) validation();
  if (hasOwn(value, 'throughSequence')) sequence(value.throughSequence, false);
  if (hasOwn(value, 'latestMutationSequence')) sequence(value.latestMutationSequence, true);
  if (hasOwn(value, 'latestPassingVerificationSequence')) sequence(value.latestPassingVerificationSequence, true);
  if (hasOwn(value, 'profileHash')) safeIdentifier(value.profileHash);
  if (hasOwn(value, 'taskProfile')) parseTaskProfile(value.taskProfile);
  return {
    intakeIncomplete,
    missingProfileFields,
    evidenceState,
    unresolvedFailureEventIds: idList(value.unresolvedFailureEventIds, true),
    unknownOutcomeEventIds: idList(value.unknownOutcomeEventIds, true),
    coverage,
    ...(declaredCoverage === undefined ? {} : { declaredCoverage }),
    incompleteCoverageCategories,
    latestMutationEventIds: idList(value.latestMutationEventIds, false),
    latestPassingVerificationEventIds: idList(value.latestPassingVerificationEventIds, false),
  };
}

function parseStaleEntries(value: unknown): NormalizedStaleDeliveredEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INPUT_ITEMS) validation();
  return value.map((item) => {
    if (!isPlainObject(item)) validation();
    knownFields(item, STALE_ENTRY_FIELDS);
    requiredFields(item, ['entryId', 'deliveredRevision', 'currentRevision']);
    if (sequence(item.deliveredRevision, false) === null || sequence(item.currentRevision, false) === null) validation();
    return {
      entryId: safeIdentifier(item.entryId),
      stale: hasOwn(item, 'stale') ? booleanValue(item.stale) : true,
      evidenceEventIds: idList(item.evidenceEventIds, false),
    };
  });
}

function parseContradictions(value: unknown): NormalizedContradictionPair[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INPUT_ITEMS) validation();
  return value.map((item) => {
    if (!isPlainObject(item)) validation();
    knownFields(item, CONTRADICTION_FIELDS);
    requiredFields(item, ['leftEntryId', 'rightEntryId', 'verified']);
    return {
      leftEntryId: safeIdentifier(item.leftEntryId),
      rightEntryId: safeIdentifier(item.rightEntryId),
      verified: booleanValue(item.verified),
      evidenceEventIds: idList(item.evidenceEventIds, false),
    };
  });
}

function parsePromotionCandidates(value: unknown): NormalizedPromotionCandidate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INPUT_ITEMS) validation();
  return value.map((item) => {
    if (!isPlainObject(item)) validation();
    knownFields(item, PROMOTION_FIELDS);
    requiredFields(item, ['eventId', 'eligible']);
    return {
      eventId: safeIdentifier(item.eventId),
      eligible: booleanValue(item.eligible),
      evidenceEventIds: idList(item.evidenceEventIds, false),
    };
  });
}

function parseBroker(value: unknown): NormalizedBroker {
  if (value === undefined) return { staleDeliveredEntries: [], contradictoryMemoryPairs: [], promotionCandidates: [] };
  if (!isPlainObject(value)) validation();
  knownFields(value, BROKER_FIELDS);
  return {
    staleDeliveredEntries: parseStaleEntries(value.staleDeliveredEntries),
    contradictoryMemoryPairs: parseContradictions(value.contradictoryMemoryPairs),
    promotionCandidates: parsePromotionCandidates(value.promotionCandidates),
  };
}

function parseInput(value: unknown): NormalizedInput {
  if (!isPlainObject(value)) validation();
  knownFields(value, TOP_LEVEL_FIELDS);
  requiredFields(value, ['projection']);
  return {
    projection: parseProjection(value.projection),
    broker: parseBroker(value.broker),
  };
}

function makeRecommendation(
  code: RecommendationCode,
  evidenceEventIds: readonly string[],
  referenceIds: readonly string[] = [],
  extraMetadata: { incompleteCoverageCategories?: readonly CoverageCategory[] } = {},
): Recommendation {
  const evidence = bounded(evidenceEventIds, MAX_EVIDENCE_EVENT_IDS);
  const references = bounded(referenceIds, MAX_REFERENCE_IDS);
  const categories = extraMetadata.incompleteCoverageCategories === undefined
    ? undefined
    : bounded(extraMetadata.incompleteCoverageCategories, MAX_REFERENCE_IDS);
  return {
    code,
    message: RECOMMENDATION_MESSAGES[code],
    evidenceEventIds: evidence.values,
    priority: RECOMMENDATION_PRIORITY[code],
    untrusted: true,
    actionable: false,
    metadata: {
      truncated: evidence.truncated || references.truncated || (categories?.truncated ?? false),
      ...(categories === undefined || categories.values.length === 0 ? {} : { incompleteCoverageCategories: categories.values }),
      referenceIds: references.values,
    },
  };
}

function sortRecommendations(recommendations: Recommendation[]): Recommendation[] {
  const ordered = [...recommendations].sort((left, right) => left.priority - right.priority);
  if (ordered.length <= MAX_RECOMMENDATIONS) return ordered;
  const truncated = ordered.slice(0, MAX_RECOMMENDATIONS);
  return truncated.map((recommendation) => ({
    ...recommendation,
    metadata: {
      truncated: true,
      referenceIds: [...recommendation.metadata.referenceIds],
      ...(recommendation.metadata.incompleteCoverageCategories === undefined
        ? {}
        : { incompleteCoverageCategories: [...recommendation.metadata.incompleteCoverageCategories] }),
    },
  }));
}

export function buildRecommendations(input: unknown): Recommendation[] {
  const normalized = parseInput(input);
  const { projection, broker } = normalized;
  const recommendations: Recommendation[] = [];

  if (projection.intakeIncomplete) {
    recommendations.push(makeRecommendation('INTAKE_INCOMPLETE', []));
  }
  if (projection.evidenceState === 'stale') {
    recommendations.push(makeRecommendation('VERIFY_AFTER_MUTATION', [
      ...projection.latestMutationEventIds,
      ...projection.latestPassingVerificationEventIds,
    ]));
  }
  if (projection.unknownOutcomeEventIds.length > 0) {
    recommendations.push(makeRecommendation('SIDE_EFFECT_OUTCOME_UNKNOWN', projection.unknownOutcomeEventIds));
  }
  if (projection.unresolvedFailureEventIds.length > 0) {
    recommendations.push(makeRecommendation('UNRESOLVED_FAILURE', projection.unresolvedFailureEventIds));
  }
  if (projection.coverage === 'partial') {
    const declaredCoverage = projection.declaredCoverage;
    const declaredCategories = declaredCoverage === undefined
      ? []
      : COVERAGE_CATEGORIES.filter((category) => (
        Object.prototype.hasOwnProperty.call(declaredCoverage, category)
        && declaredCoverage[category] !== 'complete'
      ));
    recommendations.push(makeRecommendation(
      'COVERAGE_INCOMPLETE',
      [],
      [],
      { incompleteCoverageCategories: [...declaredCategories, ...projection.incompleteCoverageCategories] },
    ));
  }

  const staleEntries = broker.staleDeliveredEntries.filter((entry) => entry.stale);
  if (staleEntries.length > 0) {
    recommendations.push(makeRecommendation(
      'CONTEXT_STALE',
      staleEntries.flatMap((entry) => entry.evidenceEventIds),
      staleEntries.map((entry) => entry.entryId),
    ));
  }

  const verifiedPairs = broker.contradictoryMemoryPairs.filter((pair) => pair.verified);
  if (verifiedPairs.length > 0) {
    recommendations.push(makeRecommendation(
      'CONTRADICTORY_MEMORY',
      verifiedPairs.flatMap((pair) => pair.evidenceEventIds),
      verifiedPairs.flatMap((pair) => [pair.leftEntryId, pair.rightEntryId]),
    ));
  }

  const eligibleCandidates = broker.promotionCandidates.filter((candidate) => candidate.eligible);
  if (eligibleCandidates.length > 0) {
    recommendations.push(makeRecommendation(
      'PROMOTION_CANDIDATE',
      eligibleCandidates.flatMap((candidate) => [candidate.eventId, ...candidate.evidenceEventIds]),
    ));
  }

  return sortRecommendations(recommendations);
}
