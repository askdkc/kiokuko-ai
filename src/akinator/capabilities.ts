import type { TaskProfile } from './types.js';
import {
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_MEMORY_SKILL_NAME,
  STANDARD_SOUL_SKILL_NAME,
  STANDARD_UI_SKILL_NAME,
} from '../setup/standard-skills.js';
import { compareCanonicalStrings } from '../serialization/validate.js';

export const CAPABILITY_KINDS = ['skill', 'mcp_tool'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const MAX_CAPABILITY_DESCRIPTION_CHARS = 2_000;
export const MAX_RAW_CAPABILITY_DESCRIPTION_CHARS = 64_000;
export const MAX_CAPABILITY_NAME_CHARS = 300;
export const MAX_CAPABILITY_ITEMS = 200;
export const MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS = 512_000;

export interface CapabilityDescriptor {
  kind: CapabilityKind;
  name: string;
  description?: string;
}

export type CapabilityCatalogAvailability = 'known-empty' | 'known-nonempty' | 'unknown';

export interface CapabilityCatalogDiagnostics {
  received: number;
  accepted: number;
  truncated: number;
  dropped: number;
}

export interface NormalizedCapabilityCatalog {
  availability: CapabilityCatalogAvailability;
  skills: CapabilityDescriptor[];
  tools: CapabilityDescriptor[];
  diagnostics: CapabilityCatalogDiagnostics;
  budgetExceeded: boolean;
}

export interface CapabilityWarning {
  code: 'CAPABILITY_CATALOG_COMPACTED' | 'CAPABILITY_CATALOG_ITEMS_DROPPED' | 'CAPABILITY_CATALOG_BUDGET_EXCEEDED' | 'CAPABILITY_CATALOG_UNAVAILABLE';
  message: string;
}

export interface CapabilityRecommendation {
  kind: CapabilityKind;
  name: string;
  availability: 'available' | 'missing' | 'unknown';
  reason: string;
  source: 'akinator_policy' | 'catalog_similarity';
  required?: boolean;
}

export interface CapabilityResolution {
  availability: CapabilityCatalogAvailability;
  catalogProvided: boolean;
  availableSkillCount: number | null;
  diagnostics: CapabilityCatalogDiagnostics;
  warnings: CapabilityWarning[];
  recommendations: CapabilityRecommendation[];
}

export const MEMORY_REASONING_SKILL_NAME = STANDARD_MEMORY_SKILL_NAME;

/** Missing memory-reasoning withholds actionable memory but never blocks the task itself. */
export function hasBlockingRequiredCapability(resolution: Pick<CapabilityResolution, 'recommendations'>): boolean {
  return resolution.recommendations.some((item) => item.required === true
    && item.availability !== 'available'
    && item.name !== MEMORY_REASONING_SKILL_NAME);
}

export function shouldWithholdMemoryContext(resolution: Pick<CapabilityResolution, 'recommendations'>): boolean {
  return resolution.recommendations.some((item) => item.required === true
    && item.name === MEMORY_REASONING_SKILL_NAME
    && item.availability !== 'available');
}

export type MemoryUseSignal = 'none' | 'actionable';
export type MemoryReasoningCapabilityAvailability = 'available' | 'missing' | 'unknown';
export type MemoryWithheldReason = 'memory_reasoning_missing' | 'memory_reasoning_unknown';

export interface MemoryPolicy {
  memoryReasoningRequired: boolean;
  contextWithheld: boolean;
  withheldReason: MemoryWithheldReason | null;
  deliveryEmpty?: true;
  storedEntryCount?: number;
}

export interface MemoryDeliveryObservation {
  contextItemCount: number | null;
  storedEntryCount: number;
}

const ACTIONABLE_MEMORY_SELECTION_REASONS = new Set([
  'exact_signal_match',
  'word_match',
  'lexical_match',
  'cjk_window_match',
  'applicability_match',
  'tag_match',
  'changed_path_match',
  'error_signature_match',
  'helpful_feedback',
]);

export function hasActionableMemorySelection(
  items: ReadonlyArray<{ selectionReasons: ReadonlyArray<string> }>,
): boolean {
  return items.some((item) => item.selectionReasons.some((reason) => ACTIONABLE_MEMORY_SELECTION_REASONS.has(reason)));
}

export function deriveMemoryUseSignal(input: {
  deliveryId: string | null;
  items: ReadonlyArray<{ selectionReasons: ReadonlyArray<string> }>;
} | null): MemoryUseSignal {
  if (input === null || input.deliveryId === null || input.items.length === 0) return 'none';
  return hasActionableMemorySelection(input.items) ? 'actionable' : 'none';
}

export function memoryReasoningRequired(
  profile: Pick<TaskProfile, 'taskType'>,
  memoryUse: MemoryUseSignal,
): boolean {
  return memoryUse === 'actionable' && (profile.taskType === 'build' || profile.taskType === 'debug');
}

export function deriveMemoryPolicy(
  profile: Pick<TaskProfile, 'taskType'>,
  memoryUse: MemoryUseSignal,
  capabilities: unknown,
  delivery?: MemoryDeliveryObservation,
): MemoryPolicy {
  const emptyDelivery = delivery !== undefined
    && (delivery.contextItemCount === null || delivery.contextItemCount === 0)
    && delivery.storedEntryCount > 0
    ? { deliveryEmpty: true as const, storedEntryCount: delivery.storedEntryCount }
    : {};
  const required = memoryReasoningRequired(profile, memoryUse);
  if (!required) {
    return { memoryReasoningRequired: false, contextWithheld: false, withheldReason: null, ...emptyDelivery };
  }
  const availability = memoryReasoningCapabilityAvailability(capabilities);
  if (availability === 'available') {
    return { memoryReasoningRequired: true, contextWithheld: false, withheldReason: null, ...emptyDelivery };
  }
  return {
    memoryReasoningRequired: true,
    contextWithheld: true,
    withheldReason: availability === 'missing'
      ? 'memory_reasoning_missing'
      : 'memory_reasoning_unknown',
    ...emptyDelivery,
  };
}

export function boundedCodePointLength(value: string, limit: number): number {
  if (limit < 0) return 0;
  let length = 0;
  for (const _point of value) {
    length += 1;
    if (length > limit) return length;
  }
  return length;
}

export function truncateCodePoints(value: string, max: number): string {
  if (max <= 0) return '';
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max - 1).join('')}…`;
}

export function compactCapabilityDescription(value: string): { description: string; truncated: boolean } {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => /\s/u.test(character) ? ' ' : '')
    .replace(/\s+/gu, ' ')
    .trim();
  const description = truncateCodePoints(normalized, MAX_CAPABILITY_DESCRIPTION_CHARS);
  return { description, truncated: description !== normalized };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === 'string' && CAPABILITY_KINDS.includes(value as CapabilityKind);
}

function normalizedCatalogWarningList(
  availability: CapabilityCatalogAvailability,
  diagnostics: CapabilityCatalogDiagnostics,
  catalogWasSupplied: boolean,
  budgetExceeded: boolean,
): CapabilityWarning[] {
  const warnings: CapabilityWarning[] = [];
  if (diagnostics.truncated > 0) {
    warnings.push({
      code: 'CAPABILITY_CATALOG_COMPACTED',
      message: 'Some capability descriptions were shortened or omitted.',
    });
  }
  if (diagnostics.dropped > 0) {
    warnings.push({
      code: 'CAPABILITY_CATALOG_ITEMS_DROPPED',
      message: 'Some capability catalog items were ignored.',
    });
  }
  if (budgetExceeded) {
    warnings.push({
      code: 'CAPABILITY_CATALOG_BUDGET_EXCEEDED',
      message: 'Some capability catalog data was omitted because the catalog exceeded its processing budget.',
    });
  }
  if (catalogWasSupplied && availability === 'unknown') {
    warnings.push({
      code: 'CAPABILITY_CATALOG_UNAVAILABLE',
      message: 'The capability catalog could not be safely classified.',
    });
  }
  return warnings;
}

function validateCapabilityHeader(value: unknown): Pick<CapabilityDescriptor, 'kind' | 'name'> | null {
  if (!isPlainRecord(value) || !isCapabilityKind(value.kind) || typeof value.name !== 'string') return null;
  const allowedKeys = new Set(['kind', 'name', 'description']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (boundedCodePointLength(value.name, MAX_CAPABILITY_NAME_CHARS) > MAX_CAPABILITY_NAME_CHARS
    || value.name.trim().length === 0
    || value.name.trim() !== value.name
    || /[\p{Cc}\p{Cf}]/u.test(value.name)) return null;
  return { kind: value.kind, name: value.name };
}

export function normalizeCapabilityCatalog(input: unknown): NormalizedCapabilityCatalog {
  const emptyDiagnostics = { received: 0, accepted: 0, truncated: 0, dropped: 0 };
  if (input === undefined) {
    return { availability: 'unknown', skills: [], tools: [], diagnostics: emptyDiagnostics, budgetExceeded: false };
  }
  if (!Array.isArray(input)) {
    return { availability: 'unknown', skills: [], tools: [], diagnostics: emptyDiagnostics, budgetExceeded: false };
  }

  const diagnostics: CapabilityCatalogDiagnostics = {
    received: input.length,
    accepted: 0,
    truncated: 0,
    dropped: Math.max(0, input.length - MAX_CAPABILITY_ITEMS),
  };
  const skills: CapabilityDescriptor[] = [];
  const tools: CapabilityDescriptor[] = [];
  const processCount = Math.min(input.length, MAX_CAPABILITY_ITEMS);
  let remaining = MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS;
  let budgetExceeded = false;
  const accept = (descriptor: CapabilityDescriptor, truncated: boolean): void => {
    diagnostics.accepted += 1;
    if (truncated) diagnostics.truncated += 1;
    (descriptor.kind === 'skill' ? skills : tools).push(descriptor);
  };
  for (let index = 0; index < processCount; index += 1) {
    const item = input[index];
    const header = validateCapabilityHeader(item);
    if (header === null) {
      diagnostics.dropped += 1;
      continue;
    }
    const nameCost = boundedCodePointLength(header.name, remaining);
    if (nameCost > remaining) {
      diagnostics.dropped += processCount - index;
      budgetExceeded = true;
      break;
    }
    remaining -= nameCost;
    const descriptor: CapabilityDescriptor = { ...header };
    if (!isPlainRecord(item) || item.description === undefined) {
      accept(descriptor, false);
      continue;
    }
    if (typeof item.description !== 'string') {
      diagnostics.dropped += 1;
      continue;
    }
    const scanLimit = Math.min(remaining, MAX_RAW_CAPABILITY_DESCRIPTION_CHARS);
    const descriptionCost = boundedCodePointLength(item.description, scanLimit);
    if (descriptionCost > scanLimit) {
      accept(descriptor, true);
      if (remaining <= MAX_RAW_CAPABILITY_DESCRIPTION_CHARS) {
        diagnostics.dropped += processCount - index - 1;
        budgetExceeded = true;
        break;
      }
      remaining -= descriptionCost;
      continue;
    }
    remaining -= descriptionCost;
    const compacted = compactCapabilityDescription(item.description);
    if (compacted.description.length > 0) descriptor.description = compacted.description;
    accept(descriptor, compacted.truncated || (item.description.length > 0 && compacted.description.length === 0));
  }
  const availability: CapabilityCatalogAvailability = input.length === 0
    ? 'known-empty'
    : diagnostics.dropped > 0 || budgetExceeded
      ? 'unknown'
      : 'known-nonempty';
  return { availability, skills, tools, diagnostics, budgetExceeded };
}

const TASK_TOOL_TERMS: Record<NonNullable<TaskProfile['taskType']>, string[]> = {
  build: ['build', 'code', 'github', 'gitlab', 'repository', 'test'],
  debug: ['browser', 'debug', 'error', 'github', 'log', 'test'],
  research: ['citation', 'docs', 'documentation', 'research', 'search', 'web'],
  review: ['code', 'diff', 'github', 'gitlab', 'pull', 'review'],
  devops: ['cloud', 'deploy', 'docker', 'kubernetes', 'log', 'monitor'],
  writing: ['docs', 'document', 'markdown', 'publish', 'writing'],
  analysis: ['analysis', 'database', 'dataset', 'query', 'spreadsheet', 'sql'],
};

const SKILL_REASONS: Record<string, string> = {
  tdd: 'The build task benefits from a test-first implementation workflow.',
  'diagnosing-bugs': 'The debugging task benefits from a reproducible diagnosis workflow.',
  research: 'The research task requires source-grounded findings.',
  'code-review': 'The review task benefits from a structured code-review workflow.',
  [MEMORY_REASONING_SKILL_NAME]: 'Relevant stored memory was delivered for a build or debug task; verify its premises, invariants, counterexamples, and tests before changing code.',
  [STANDARD_SOUL_SKILL_NAME]: 'Every non-trivial Kiokuko-governed task starts with the canonical SOUL router before applying any role-specific, code, or interactive UI Skill.',
  [STANDARD_FUNCTION_SKILL_NAME]: 'The task explicitly involves writing, changing, debugging, or reviewing code and benefits from problem-shaped concepts, cohesive function contracts, explicit representation boundaries, and focused tests.',
  [STANDARD_UI_SKILL_NAME]: 'The task explicitly involves UI implementation, design, or review and benefits from Kiokuko\'s interaction-state and accessibility contract.',
};

const EXPLICIT_UI_INTENT = /(?:\b(?:ui|ux|frontend|front-end|swiftui|accessibility)\b|\buser[ -]?interface\b|\b(?:app|web)[ -]?(?:screen|interface|view|page)\b|\bscreen(?:s)?\b|ユーザーインターフェース|インターフェース|フロントエンド|アクセシビリティ|画面|操作(?:性|設計|フロー)|ボタン|フォーム|モーダル|ダイアログ|ナビゲーション)/iu;
const EXCLUDED_UI_SCOPE = /(?:\bbackend[- ]only\b|\bserver[- ]side only\b|\bimage generation only\b|バックエンド(?:だけ|のみ)|画像生成(?:だけ|のみ))/iu;
const EXPLICIT_CODING_INTENT = /(?:\b(?:code|coding|codebase|programming|function|method|class|module|refactor|debug|bugfix|bug[ -]?fix|unit[ -]?test|integration[ -]?test|pull[ -]?request|source[ -]?file)\b|\b(?:implement|modify|patch|fix|test|review|rewrite|compile|typecheck|type-check)\b.{0,32}\b(?:code|function|method|class|module|api|test|repository|file)\b|\b(?:typescript|javascript|php|python|ruby|rust|golang|java|kotlin|swift|c\+\+|csharp|c#|sql|terraform)\b|コード|コーディング|プログラミング|実装|関数|メソッド|クラス|モジュール|ソース(?:コード|ファイル)|リファクタ|デバッグ|バグ(?:修正|フィックス)|単体テスト|結合テスト|型チェック|プルリクエスト)/iu;
const EXCLUDED_CODING_SCOPE = /(?:\b(?:no code changes?|without changing code|documentation only|writing only|image generation only)\b|コード変更(?:なし|不要)|コードを変更しない|文書(?:だけ|のみ)|文章(?:だけ|のみ)|画像生成(?:だけ|のみ))/iu;

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

function nameAliases(value: string): Set<string> {
  const normalized = normalizedName(value);
  const segments = normalized.split(/(?:::|:|\/)/u).filter(Boolean);
  return new Set([normalized, segments.at(-1) ?? normalized]);
}

function tokens(value: string): Set<string> {
  const found = value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return new Set(found.flatMap((token) => {
    const normalized = token.replaceAll('_', '-');
    return [normalized, ...normalized.split('-')];
  }).filter((token) => token.length > 2));
}

function desiredSkills(input: { task: string; profile: TaskProfile; recommendedTags: string[]; memoryUse: MemoryUseSignal }): string[] {
  const skillNames = [STANDARD_SOUL_SKILL_NAME, ...input.recommendedTags
    .filter((tag) => tag.startsWith('skill:'))
    .map((tag) => normalizedName(tag.slice('skill:'.length)))
    .filter(Boolean)];
  const taskScope = [input.task, input.profile.target ?? '', input.profile.expected ?? '', input.profile.constraints ?? ''].join(' ');
  if (!EXCLUDED_UI_SCOPE.test(taskScope) && EXPLICIT_UI_INTENT.test(taskScope)) skillNames.push(STANDARD_UI_SKILL_NAME);
  if (!EXCLUDED_CODING_SCOPE.test(taskScope) && EXPLICIT_CODING_INTENT.test(taskScope)) {
    skillNames.push(STANDARD_FUNCTION_SKILL_NAME);
  }
  if (memoryReasoningRequired(input.profile, input.memoryUse)) {
    skillNames.push(MEMORY_REASONING_SKILL_NAME);
  }
  return [...new Set(skillNames)];
}

function matchingSkill(catalog: CapabilityDescriptor[], desired: string): CapabilityDescriptor | undefined {
  return catalog.find((candidate) => candidate.kind === 'skill' && nameAliases(candidate.name).has(desired));
}

function matchingExactLocalSkill(catalog: CapabilityDescriptor[], desired: string): CapabilityDescriptor | undefined {
  return catalog.find((candidate) => candidate.kind === 'skill'
    && candidate.name === desired);
}

export function memoryReasoningCapabilityAvailability(capabilities: unknown): MemoryReasoningCapabilityAvailability {
  const normalized = normalizeCapabilityCatalog(capabilities);
  if (normalized.availability === 'unknown') return 'unknown';
  if (matchingExactLocalSkill(normalized.skills, MEMORY_REASONING_SKILL_NAME)) return 'available';
  return 'missing';
}

function relevantCatalogCapabilities(
  task: string,
  profile: TaskProfile,
  catalog: CapabilityDescriptor[],
  desiredSkillNames: Set<string>,
): CapabilityRecommendation[] {
  const taskTokens = tokens([task, profile.target ?? '', profile.expected ?? '', profile.constraints ?? ''].join(' '));
  const roleTerms = new Set(profile.taskType ? TASK_TOOL_TERMS[profile.taskType] : []);
  return catalog
    .filter((candidate) => {
      const aliases = nameAliases(candidate.name);
      if (aliases.has(STANDARD_SOUL_SKILL_NAME)
        || aliases.has(STANDARD_UI_SKILL_NAME)
        || aliases.has(STANDARD_FUNCTION_SKILL_NAME)
        || aliases.has(MEMORY_REASONING_SKILL_NAME)) return false;
      if (candidate.kind === 'mcp_tool') return true;
      return ![...aliases].some((alias) => desiredSkillNames.has(alias));
    })
    .map((candidate) => {
      const candidateTokens = tokens(`${candidate.name} ${candidate.description ?? ''}`);
      const matchedTaskTerms = [...taskTokens].filter((token) => candidateTokens.has(token));
      const matchedRoleTerms = [...roleTerms].filter((token) => candidateTokens.has(token));
      return {
        candidate,
        matchedTaskTerms,
        matchedRoleTerms,
        score: matchedTaskTerms.length * 3 + matchedRoleTerms.length,
      };
    })
    .filter(({ score, matchedTaskTerms, matchedRoleTerms }) => score >= 3 || (matchedTaskTerms.length > 0 && matchedRoleTerms.length > 0))
    .sort((left, right) => right.score - left.score || compareCanonicalStrings(left.candidate.name, right.candidate.name))
    .slice(0, 5)
    .map(({ candidate, matchedTaskTerms, matchedRoleTerms }) => {
      const terms = [...new Set([...matchedTaskTerms, ...matchedRoleTerms])].slice(0, 5);
      return {
        kind: candidate.kind,
        name: candidate.name,
        availability: 'available',
        reason: `Available ${candidate.kind === 'skill' ? 'skill' : 'MCP tool'} metadata matches the task${terms.length > 0 ? ` (${terms.join(', ')})` : ''}.`,
        source: 'catalog_similarity',
      };
    });
}

export function resolveCapabilities(input: {
  task: string;
  profile: TaskProfile;
  recommendedTags: string[];
  capabilities?: unknown;
  memoryUse: MemoryUseSignal;
}): CapabilityResolution {
  const normalized = normalizeCapabilityCatalog(input.capabilities);
  const catalogProvided = normalized.availability !== 'unknown';
  const catalog = [...normalized.skills, ...normalized.tools];
  const desired = desiredSkills(input);
  const desiredSkillNames = new Set(desired);
  const skills: CapabilityRecommendation[] = desired.map((desiredName) => {
    // Mandatory local workflows are clean-break contracts. A namespaced,
    // fetched, or similarly named Skill must not satisfy either capability.
    const exactLocalIdentity = desiredName === MEMORY_REASONING_SKILL_NAME
      || desiredName === STANDARD_SOUL_SKILL_NAME;
    const matched = exactLocalIdentity
      ? matchingExactLocalSkill(normalized.skills, desiredName)
      : matchingSkill(catalog, desiredName);
    const availability = desiredName === MEMORY_REASONING_SKILL_NAME && normalized.availability === 'unknown'
      ? 'unknown'
      : matched ? 'available' : normalized.availability === 'unknown' ? 'unknown' : 'missing';
    return {
      kind: 'skill',
      name: matched?.name ?? desiredName,
      availability,
      reason: SKILL_REASONS[desiredName] ?? 'The Akinator task policy recommends this workflow.',
      source: 'akinator_policy',
      ...(desiredName === MEMORY_REASONING_SKILL_NAME
        || desiredName === STANDARD_SOUL_SKILL_NAME
        ? { required: true }
        : {}),
    };
  });
  return {
    availability: normalized.availability,
    catalogProvided,
    availableSkillCount: normalized.availability === 'unknown' ? null : normalized.skills.length,
    diagnostics: normalized.diagnostics,
    warnings: normalizedCatalogWarningList(normalized.availability, normalized.diagnostics, input.capabilities !== undefined, normalized.budgetExceeded),
    recommendations: [...skills, ...relevantCatalogCapabilities(input.task, input.profile, catalog, desiredSkillNames)],
  };
}
