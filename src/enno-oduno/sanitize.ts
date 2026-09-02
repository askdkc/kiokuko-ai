import type * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';
import { findSecret } from '../memory/secrets.js';
import { sanitizeJson } from '../security/sanitize.js';
import {
  ennoAnswerSchema,
  finishSchema,
  idealSubmissionSchema,
  meditationSubmissionSchema,
  parseEnnoAnswer,
  parseFinishRequest,
  parseIdealSubmission,
  parseMeditationSubmission,
  parsePlanSubmission,
  parseWorkReport,
  planSubmissionSchema,
  workReportSchema,
} from './schemas.js';

type PlanSubmission = z.infer<typeof planSubmissionSchema>;
type WorkReport = z.infer<typeof workReportSchema>;
type EnnoAnswer = z.infer<typeof ennoAnswerSchema>;
type FinishRequest = z.infer<typeof finishSchema>;
type IdealSubmission = z.infer<typeof idealSubmissionSchema>;
type MeditationSubmission = z.infer<typeof meditationSubmissionSchema>;

function sanitizedObject(value: unknown, repositoryRoot: string): Record<string, unknown> {
  const omitUndefined = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(omitUndefined);
    if (typeof candidate !== 'object' || candidate === null) return candidate;
    return Object.fromEntries(Object.entries(candidate)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, omitUndefined(child)]));
  };
  return sanitizeJson(omitUndefined(value), { workspace: repositoryRoot }).value as Record<string, unknown>;
}

export function verifierCommandContainsSecret(verifier: Pick<PlanSubmission['finalVerifiers'][number], 'executable' | 'args'>): boolean {
  if (findSecret(verifier.executable) !== undefined) return true;
  return verifier.args.some((argument, index) => (
    findSecret(argument) !== undefined
    || index + 1 < verifier.args.length
      && findSecret(`${argument} ${verifier.args[index + 1]}`) !== undefined
  ));
}

function assertSafeVerifierCommands(plan: PlanSubmission): void {
  const verifiers = [
    ...plan.finalVerifiers,
    ...plan.workPlan.units.flatMap((unit) => unit.focusedVerifiers),
  ];
  for (const verifier of verifiers) {
    if (verifierCommandContainsSecret(verifier)) {
      throw new KiokukoError('SECURITY_REJECTION', 'Verifier command resembles secret material and was rejected');
    }
  }
}

export function sanitizePlanSubmission(input: PlanSubmission, repositoryRoot: string): PlanSubmission {
  assertSafeVerifierCommands(input);
  const workPlanWithoutVerifierCommands = {
    ...input.workPlan,
    units: input.workPlan.units.map((unit) => ({ ...unit, focusedVerifiers: [] })),
  };
  const sanitized = sanitizedObject({
    scope: input.scope,
    exclusions: input.exclusions,
    acceptanceCriteria: input.acceptanceCriteria,
    workPlan: workPlanWithoutVerifierCommands,
    skillRequirements: input.skillRequirements,
    advisoryDisposition: input.advisoryDisposition,
  }, repositoryRoot);
  const sanitizedWorkPlan = sanitized.workPlan as PlanSubmission['workPlan'];
  return parsePlanSubmission({
    ...input,
    ...sanitized,
    workPlan: {
      ...sanitizedWorkPlan,
      units: sanitizedWorkPlan.units.map((unit, index) => ({
        ...unit,
        focusedVerifiers: input.workPlan.units[index]?.focusedVerifiers.map((verifier) => ({
          ...verifier,
          args: [...verifier.args],
        })) ?? [],
      })),
    },
    finalVerifiers: input.finalVerifiers.map((verifier) => ({ ...verifier, args: [...verifier.args] })),
  });
}

export function sanitizeWorkReport(input: WorkReport, repositoryRoot: string): WorkReport {
  const sanitized = sanitizedObject({ result: input.result }, repositoryRoot);
  return parseWorkReport({ ...input, ...sanitized });
}

export function sanitizeEnnoAnswer(input: EnnoAnswer, repositoryRoot: string): EnnoAnswer {
  if (input.requestedChanges === undefined) return input;
  const sanitized = sanitizedObject({ requestedChanges: input.requestedChanges }, repositoryRoot);
  return parseEnnoAnswer({ ...input, ...sanitized });
}

export function sanitizeFinishRequest(input: FinishRequest, repositoryRoot: string): FinishRequest {
  const sanitized = sanitizedObject({ review: input.review, advisoryDisposition: input.advisoryDisposition }, repositoryRoot);
  return parseFinishRequest({ ...input, ...sanitized });
}

export function sanitizeIdealSubmission(input: IdealSubmission, repositoryRoot: string): IdealSubmission {
  const sanitized = sanitizedObject({ ideal: input.ideal, advisoryDisposition: input.advisoryDisposition }, repositoryRoot);
  return parseIdealSubmission({ ...input, ...sanitized });
}

export function sanitizeMeditationSubmission(input: MeditationSubmission, repositoryRoot: string): MeditationSubmission {
  const sanitized = sanitizedObject({ meditation: input.meditation }, repositoryRoot);
  return parseMeditationSubmission({ ...input, ...sanitized });
}
