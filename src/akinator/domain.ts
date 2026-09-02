import { KiokukoError } from '../errors.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { TASK_TYPES } from './types.js';
import type { AkinatorQuestion, TaskProfile, TaskType } from './types.js';

/** Version of the deterministic question/answer policy represented by this module. */
export const AKINATOR_POLICY_VERSION = 'v2' as const;

export type DomainStatus = 'needs_answer' | 'ready' | 'exhausted';

export interface AkinatorDomainEvaluation {
  status: DomainStatus;
  question: AkinatorQuestion | null;
  missingFields: Array<keyof TaskProfile>;
  recommendedTags: string[];
  profileHash: string;
}

export interface AkinatorDomainState {
  task: string;
  profile: TaskProfile;
  questionCount: number;
}

export interface AkinatorDomainSnapshot extends AkinatorDomainState, AkinatorDomainEvaluation {}

const PROFILE_FIELDS = ['taskType', 'target', 'expected', 'constraints'] as const;
const STATE_FIELDS = [
  'task', 'profile', 'questionCount', 'status', 'question', 'missingFields', 'recommendedTags', 'profileHash',
] as const;
const ANSWER_FIELDS = ['questionId', 'value'] as const;
const REQUIRED_FIELDS: Array<keyof TaskProfile> = ['taskType', 'target', 'expected'];

type RequiredQuestionId = 'taskType' | 'target' | 'expected';

type QuestionPolicy = {
  readonly id: RequiredQuestionId;
  readonly prompt: string;
  readonly options: readonly string[] | null;
  readonly required: true;
  readonly isMissing: (profile: TaskProfile) => boolean;
};

/**
 * Akinator derives intake state from the profile and question count.
 * Required questions are ordered by this policy; ready and exhausted are
 * terminal intake states and therefore do not produce another question.
 */
const REQUIRED_QUESTION_POLICY = [
  {
    id: 'taskType',
    prompt: 'この作業の主目的はどれですか？',
    options: TASK_TYPES,
    required: true,
    isMissing: (profile) => profile.taskType === null,
  },
  {
    id: 'target',
    prompt: '対象のリポジトリ、ファイル、機能、またはサービスは何ですか？',
    options: null,
    required: true,
    isMissing: (profile) => profile.target === null,
  },
  {
    id: 'expected',
    prompt: '完了と判断する成功条件は何ですか？',
    options: null,
    required: true,
    isMissing: (profile) => profile.expected === null,
  },
] as const satisfies readonly QuestionPolicy[];

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((field) => !allowed.includes(field))) validation(`Unknown ${label} field`);
}

function isProfileField(value: string): value is keyof TaskProfile {
  return PROFILE_FIELDS.some((field) => field === value);
}

function normalizeTaskTypeValue(value: string): TaskType | null {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, TaskType> = {
    implement: 'build', implementation: 'build', feature: 'build', 実装: 'build', 開発: 'build',
    bug: 'debug', debugging: 'debug', fix: 'debug', 修正: 'debug', デバッグ: 'debug',
    research: 'research', 調査: 'research', 研究: 'research',
    review: 'review', audit: 'review', レビュー: 'review', 監査: 'review',
    devops: 'devops', deploy: 'devops', deployment: 'devops', 運用: 'devops', デプロイ: 'devops',
    writing: 'writing', docs: 'writing', documentation: 'writing', 文書: 'writing', 執筆: 'writing',
    analysis: 'analysis', analyse: 'analysis', 分析: 'analysis',
  };
  const direct = TASK_TYPES.find((taskType) => taskType === normalized);
  return direct ?? aliases[normalized] ?? null;
}

export function normalizeTaskType(value: unknown): TaskType {
  if (typeof value !== 'string') validation('taskType must be a non-empty string');
  const normalized = normalizeTaskTypeValue(value);
  if (!normalized) validation('taskType must be one of the allowed task types');
  return normalized;
}

function inferTaskType(task: string): TaskType | null {
  const normalized = task.toLowerCase();
  if (/debug|bug|fix|修正|不具合|エラー|障害/u.test(normalized)) return 'debug';
  if (/review|audit|レビュー|監査|検証/u.test(normalized)) return 'review';
  if (/research|調査|研究|比較|検索/u.test(normalized)) return 'research';
  if (/deploy|deployment|devops|運用|デプロイ|サーバー|インフラ/u.test(normalized)) return 'devops';
  if (/write|writing|documentation|docs|文書|執筆|ドキュメント/u.test(normalized)) return 'writing';
  if (/analysis|analyse|分析|集計/u.test(normalized)) return 'analysis';
  if (/build|implement|feature|code|実装|作成|追加|開発|機能/u.test(normalized)) return 'build';
  return null;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') validation(`${field} must be a string or null`);
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function validateProfile(value: unknown): TaskProfile {
  if (!isPlainObject(value)) validation('profile must be a JSON object');
  assertKnownFields(value, PROFILE_FIELDS, 'profile');

  let taskType: TaskType | null = null;
  if (value.taskType !== undefined && value.taskType !== null) {
    if (typeof value.taskType !== 'string') validation('taskType must be a string or null');
    taskType = normalizeTaskTypeValue(value.taskType);
    if (!taskType) validation('taskType must be one of the allowed task types');
  }

  return {
    taskType,
    target: optionalText(value.target, 'target'),
    expected: optionalText(value.expected, 'expected'),
    constraints: optionalText(value.constraints, 'constraints'),
  };
}

export function deriveProfile(task: string, profileHints: unknown = {}): TaskProfile {
  if (typeof task !== 'string' || task.trim().length === 0) validation('task must be a non-empty string');
  if (!isPlainObject(profileHints)) validation('profile hints must be a JSON object');
  assertKnownFields(profileHints, PROFILE_FIELDS, 'profile');

  let taskType = inferTaskType(task.trim());
  if (profileHints.taskType !== undefined && profileHints.taskType !== null) {
    if (typeof profileHints.taskType !== 'string') validation('taskType must be a string or null');
    const normalized = normalizeTaskTypeValue(profileHints.taskType);
    if (!normalized) validation('taskType must be one of the allowed task types');
    taskType = normalized;
  }

  return {
    taskType,
    target: optionalText(profileHints.target, 'target'),
    expected: optionalText(profileHints.expected, 'expected'),
    constraints: optionalText(profileHints.constraints, 'constraints'),
  };
}

function missingFields(profile: TaskProfile): Array<keyof TaskProfile> {
  return REQUIRED_FIELDS.filter((field) => profile[field] === null || profile[field] === '');
}

function nextQuestion(profile: TaskProfile, questionCount: number): AkinatorQuestion | null {
  if (questionCount >= 3) return null;
  for (const policy of REQUIRED_QUESTION_POLICY) {
    if (!policy.isMissing(profile)) continue;
    return {
      id: policy.id,
      prompt: policy.prompt,
      options: policy.options === null ? null : [...policy.options],
      required: policy.required,
    };
  }
  return null;
}

function recommendedTags(profile: TaskProfile): string[] {
  const tags = new Set<string>();
  const role = profile.taskType === 'build' ? 'builder'
    : profile.taskType === 'debug' || profile.taskType === 'review' ? 'reviewer'
      : profile.taskType === 'research' ? 'researcher'
        : profile.taskType === 'devops' ? 'devops'
          : profile.taskType === 'writing' ? 'writer'
            : profile.taskType === 'analysis' ? 'analyst' : 'common';
  tags.add(`bot:${role}`);
  if (profile.taskType === 'build') tags.add('skill:tdd');
  if (profile.taskType === 'debug') tags.add('skill:diagnosing-bugs');
  if (profile.taskType === 'research') tags.add('skill:research');
  if (profile.taskType === 'review') tags.add('skill:code-review');
  return [...tags];
}

function validateQuestionCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) {
    validation('questionCount must be an integer between 0 and 3');
  }
  return value;
}

function evaluateValidatedProfile(profile: TaskProfile, questionCount: number): AkinatorDomainEvaluation {
  const missing = missingFields(profile);
  const question = missing.length > 0 ? nextQuestion(profile, questionCount) : null;
  const status: DomainStatus = missing.length === 0
    ? 'ready'
    : questionCount >= 3
      ? 'exhausted'
      : 'needs_answer';
  return {
    status,
    question,
    missingFields: [...missing],
    recommendedTags: recommendedTags(profile),
    profileHash: canonicalContentHash(profile),
  };
}

export function evaluateProfile(profile: unknown, questionCount: unknown): AkinatorDomainEvaluation {
  const normalizedProfile = validateProfile(profile);
  return evaluateValidatedProfile(normalizedProfile, validateQuestionCount(questionCount));
}

/** SHA-256 of the recursively key-sorted, compact JSON representation of the normalized profile only. */
export function profileHash(profile: unknown): string {
  return canonicalContentHash(validateProfile(profile));
}

function validateState(value: unknown): AkinatorDomainState {
  if (!isPlainObject(value)) validation('state must be a JSON object');
  assertKnownFields(value, STATE_FIELDS, 'state');
  if (typeof value.task !== 'string' || value.task.trim().length === 0) validation('state task must be a non-empty string');
  const profile = validateProfile(value.profile);
  const questionCount = validateQuestionCount(value.questionCount);
  return { task: value.task.trim(), profile, questionCount };
}

function validateAnswer(value: unknown): { questionId: keyof TaskProfile; value: string } {
  if (!isPlainObject(value)) validation('answer must be a JSON object');
  assertKnownFields(value, ANSWER_FIELDS, 'answer');
  if (typeof value.questionId !== 'string' || !isProfileField(value.questionId)) validation('answer questionId is invalid');
  if (typeof value.value !== 'string') validation('answer value must be a string');
  return { questionId: value.questionId, value: value.value };
}

export function applyAnswer(state: unknown, answer: unknown): AkinatorDomainSnapshot {
  const current = validateState(state);
  const submitted = validateAnswer(answer);
  const question = nextQuestion(current.profile, current.questionCount);
  if (!question || question.id !== submitted.questionId) {
    throw new KiokukoError('CONFLICT', 'Answer does not match the current question', {
      expectedField: question?.id ?? null,
    });
  }

  const trimmed = submitted.value.trim();
  if (trimmed.length === 0) validation('answer value must be a non-empty string');

  let profile: TaskProfile;
  if (question.id === 'taskType') {
    profile = { ...current.profile, taskType: normalizeTaskType(trimmed) };
  } else if (question.id === 'target') {
    profile = { ...current.profile, target: trimmed };
  } else if (question.id === 'expected') {
    profile = { ...current.profile, expected: trimmed };
  } else {
    profile = { ...current.profile, constraints: trimmed };
  }

  const questionCount = current.questionCount + 1;
  const evaluation = evaluateValidatedProfile(profile, questionCount);
  return {
    task: current.task,
    profile,
    questionCount,
    ...evaluation,
  };
}
