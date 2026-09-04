import * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';

export const ENNO_INPUT_INVALID_DETAIL_KEY = 'publicEnnoValidationError' as const;
export const ENNO_VALIDATION_PRESENTATION_VERSION = 1 as const;
export const ENNO_MAX_PUBLIC_ISSUES = 16;

export const ENNO_VALIDATION_OPERATIONS = [
  'ideal_submit',
  'plan_submit',
  'advice_submit',
  'advice_read',
  'work_report',
  'work_claim',
  'verify_prepare',
  'finish',
  'meditation_submit',
] as const;
export type EnnoValidationOperation = (typeof ENNO_VALIDATION_OPERATIONS)[number];

export const ENNO_VALIDATION_REASONS = [
  'missing_required_field',
  'unknown_field',
  'invalid_type',
  'invalid_enum',
  'non_canonical_text',
  'too_many_items',
  'too_few_items',
  'duplicate_id',
  'unknown_dependency',
  'dependency_cycle',
  'undeclared_skill',
  'unknown_expert',
  'duplicate_expert',
  'missing_code_expert',
  'missing_ui_expert',
  'invalid_work_unit_route',
  'invalid_verifier_directory',
  'duplicate_verifier_id',
  'advisory_digest_requires_disposition',
  'advisory_consumption_required',
  'advisory_slot_missing',
  'advisory_slot_duplicate',
  'advisory_digest_stale',
] as const;
export type PublicEnnoValidationReason = (typeof ENNO_VALIDATION_REASONS)[number];

export interface PublicEnnoValidationExpected {
  minItems?: number;
  maxItems?: number;
  allowedValues?: string[];
  requiredExpertKinds?: Array<'code' | 'ui'>;
  requiredSlotIds?: string[];
  directoryPolicy?: 'repository_relative';
}

export interface PublicEnnoValidationIssue {
  path: Array<string | number>;
  reasonCode: PublicEnnoValidationReason;
  expected?: PublicEnnoValidationExpected;
}

export interface PublicEnnoValidationError {
  code: 'ENNO_INPUT_INVALID';
  operation: EnnoValidationOperation;
  presentationVersion: typeof ENNO_VALIDATION_PRESENTATION_VERSION;
  issues: PublicEnnoValidationIssue[];
  retry: 'correct_input' | 'refresh_state' | 'stop';
  mutationApplied: false;
}

const publicExpectedSchema = z.object({
  minItems: z.number().int().min(0).max(1_000_000).optional(),
  maxItems: z.number().int().min(0).max(1_000_000).optional(),
  allowedValues: z.array(z.string().min(1).max(100)).max(32).optional(),
  requiredExpertKinds: z.array(z.enum(['code', 'ui'])).max(2).optional(),
  requiredSlotIds: z.array(z.string().min(1).max(100)).max(3).optional(),
  directoryPolicy: z.literal('repository_relative').optional(),
}).strict();

export const publicEnnoValidationErrorSchema = z.object({
  code: z.literal('ENNO_INPUT_INVALID'),
  operation: z.enum(ENNO_VALIDATION_OPERATIONS),
  presentationVersion: z.literal(ENNO_VALIDATION_PRESENTATION_VERSION),
  issues: z.array(z.object({
    path: z.array(z.union([z.string().min(1).max(256), z.number().int().min(0).max(1_000)])).max(12),
    reasonCode: z.enum(ENNO_VALIDATION_REASONS),
    expected: publicExpectedSchema.optional(),
  }).strict()).min(1).max(ENNO_MAX_PUBLIC_ISSUES),
  retry: z.enum(['correct_input', 'refresh_state', 'stop']),
  mutationApplied: z.literal(false),
}).strict();

function boundedPath(path: PropertyKey[]): Array<string | number> {
  return path.slice(0, 12).map((segment) => {
    if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) return Math.min(segment, 1_000);
    if (typeof segment !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,255}$/u.test(segment)) return 'field';
    return segment;
  });
}

const customReasons: ReadonlyArray<readonly [RegExp, PublicEnnoValidationReason]> = [
  [/canonical text/iu, 'non_canonical_text'],
  [/Verifier IDs must be unique/iu, 'duplicate_verifier_id'],
  [/WorkUnit IDs must be unique/iu, 'duplicate_id'],
  [/invalid dependency/iu, 'unknown_dependency'],
  [/dependencies must be acyclic/iu, 'dependency_cycle'],
  [/undeclared Skill/iu, 'undeclared_skill'],
  [/expertRefs must be unique/iu, 'duplicate_expert'],
  [/repository-relative/iu, 'invalid_verifier_directory'],
  [/advisoryDisposition is required/iu, 'advisory_digest_requires_disposition'],
];

function numericLimit(issue: z.core.$ZodIssue): number | undefined {
  const candidate = (issue as unknown as { maximum?: unknown; minimum?: unknown }).maximum
    ?? (issue as unknown as { minimum?: unknown }).minimum;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? Math.max(0, Math.trunc(candidate)) : undefined;
}

function issueProjection(issue: z.core.$ZodIssue): PublicEnnoValidationIssue {
  const path = boundedPath([...issue.path]);
  if (issue.code === 'unrecognized_keys') return { path, reasonCode: 'unknown_field' };
  if (issue.code === 'invalid_type') {
    return { path, reasonCode: /received undefined$/u.test(issue.message) ? 'missing_required_field' : 'invalid_type' };
  }
  if (issue.code === 'invalid_value') {
    const values = (issue as unknown as { values?: unknown }).values;
    const last = path.at(-1);
    const reasonCode = last === 'id' && path.includes('expertRefs')
      ? 'unknown_expert'
      : last === 'slotId' && path.includes('advisoryDisposition')
        ? 'advisory_slot_missing'
        : path.includes('routes') ? 'invalid_work_unit_route' : 'invalid_enum';
    return {
      path,
      reasonCode,
      ...(Array.isArray(values) && values.every((value) => typeof value === 'string')
        ? { expected: { allowedValues: values.slice(0, 32) as string[] } }
        : {}),
    };
  }
  if (issue.code === 'too_big') {
    const maximum = numericLimit(issue);
    return { path, reasonCode: 'too_many_items', ...(maximum === undefined ? {} : { expected: { maxItems: maximum } }) };
  }
  if (issue.code === 'too_small') {
    const minimum = numericLimit(issue);
    return { path, reasonCode: 'too_few_items', ...(minimum === undefined ? {} : { expected: { minItems: minimum } }) };
  }
  for (const [pattern, reasonCode] of customReasons) {
    if (pattern.test(issue.message)) {
      return reasonCode === 'invalid_verifier_directory'
        ? { path, reasonCode, expected: { directoryPolicy: 'repository_relative' } }
        : { path, reasonCode };
    }
  }
  return { path, reasonCode: 'invalid_type' };
}

export function publicIssuesFromZod(error: z.ZodError): PublicEnnoValidationIssue[] {
  return error.issues.slice(0, ENNO_MAX_PUBLIC_ISSUES).map(issueProjection);
}

export function ennoValidationError(
  operation: EnnoValidationOperation,
  issues: readonly PublicEnnoValidationIssue[],
  retry: PublicEnnoValidationError['retry'] = 'correct_input',
): KiokukoError {
  const candidate: PublicEnnoValidationError = {
    code: 'ENNO_INPUT_INVALID',
    operation,
    presentationVersion: ENNO_VALIDATION_PRESENTATION_VERSION,
    issues: issues.slice(0, ENNO_MAX_PUBLIC_ISSUES).map((issue) => ({
      path: [...issue.path],
      reasonCode: issue.reasonCode,
      ...(issue.expected === undefined ? {} : { expected: { ...issue.expected } }),
    })),
    retry,
    mutationApplied: false,
  };
  const parsed = publicEnnoValidationErrorSchema.safeParse(candidate);
  if (!parsed.success) return new KiokukoError('INTEGRITY_ERROR', 'Public Enno validation projection is invalid');
  return new KiokukoError('VALIDATION_ERROR', 'Enno input is invalid', {
    [ENNO_INPUT_INVALID_DETAIL_KEY]: parsed.data,
  });
}

export function ennoZodValidationError(
  operation: EnnoValidationOperation,
  error: z.ZodError,
): KiokukoError {
  return ennoValidationError(operation, publicIssuesFromZod(error));
}
