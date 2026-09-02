import path from 'node:path';
import * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';
import {
  STANDARD_FUNCTION_EXPERT_IDS,
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_SOUL_SKILL_NAME,
  STANDARD_UI_EXPERT_IDS,
  STANDARD_UI_SKILL_NAME,
} from '../setup/standard-skills.js';
import { findSecret } from '../memory/secrets.js';
import {
  ADVISORY_FAILURE_CODES,
  ADVISORY_OUTCOMES,
  ADVISORY_PHASES,
  ADVISORY_SLOT_DEFINITIONS,
  ENNO_MAX_ATTEMPTS,
  ENNO_MIN_ATTEMPTS,
  ENNO_PROVENANCE_KEYS,
  type EnnoOdunoContract,
  type EnnoRequestHandoff,
  type AdvisoryContribution,
  type OdunoIdeal,
  type OdunoMeditation,
  type VerifierSpec,
  type WorkPlan,
  type WorkReportResult,
  WORK_UNIT_ROUTES,
} from './types.js';
import {
  ennoZodValidationError,
  type EnnoValidationOperation,
} from './validation-errors.js';

const canonicalText = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value),
  'Value must be bounded canonical text',
);
const identifier = canonicalText(256).refine((value) => value !== '.' && value !== '..' && !/[\\/]/u.test(value));
const boundedPath = canonicalText(4_096).refine((value) => !value.includes('\0'));
const repositoryRelativePath = boundedPath.refine(
  (value) => !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && !value.split(/[\\/]/u).includes('..')
    && !value.split(/[\\/]/u).some((segment) => segment.includes(':')),
  'Path must be repository-relative without parent traversal',
);

const verifierSpecShape = {
  id: identifier,
  kind: z.enum(['test', 'typecheck', 'build', 'lint', 'custom']),
  executable: canonicalText(1_024).refine((value) => !/\s/u.test(value), 'Executable must be one program, not a shell command'),
  args: z.array(z.string().max(16_384).refine((value) => !value.includes('\0'))).max(128),
  timeoutMs: z.number().int().min(100).max(300_000),
} as const;

export const verifierSpecSchema = z.object({ ...verifierSpecShape, cwd: boundedPath }).strict();
export const submissionVerifierSpecSchema = z.object({
  ...verifierSpecShape,
  cwd: repositoryRelativePath.describe('"." or a repository-relative directory; absolute paths and parent traversal are rejected'),
}).strict();

const verifierListSchema = (minimum = 0) => z.array(verifierSpecSchema)
  .min(minimum)
  .max(32)
  .superRefine((verifiers, context) => {
    const seen = new Set<string>();
    for (const [index, verifier] of verifiers.entries()) {
      if (seen.has(verifier.id)) {
        context.addIssue({ code: 'custom', message: 'Verifier IDs must be unique', path: [index, 'id'] });
      }
      seen.add(verifier.id);
    }
  });

const submissionVerifierListSchema = (minimum = 0) => z.array(submissionVerifierSpecSchema)
  .min(minimum)
  .max(32)
  .superRefine((verifiers, context) => {
    const seen = new Set<string>();
    for (const [index, verifier] of verifiers.entries()) {
      if (seen.has(verifier.id)) {
        context.addIssue({ code: 'custom', message: 'Verifier IDs must be unique', path: [index, 'id'] });
      }
      seen.add(verifier.id);
    }
  });

const standardExpertIds = [...STANDARD_FUNCTION_EXPERT_IDS, ...STANDARD_UI_EXPERT_IDS] as const;

export const expertRefSchema = z.object({
  id: z.enum(standardExpertIds),
  reason: canonicalText(500),
}).strict();

export const workUnitSchema = z.object({
  id: identifier,
  objective: canonicalText(16_384),
  scope: z.array(boundedPath).min(1).max(256),
  dependencies: z.array(identifier).max(128),
  skillNames: z.array(canonicalText(300)).max(64),
  expertRefs: z.array(expertRefSchema).max(3).default([]),
  acceptanceCriteria: z.array(canonicalText(8_192)).min(1).max(128),
  focusedVerifiers: verifierListSchema(),
  routes: z.array(z.enum(WORK_UNIT_ROUTES)).min(1).max(WORK_UNIT_ROUTES.length),
}).strict().superRefine((unit, context) => {
  const ids = unit.expertRefs.map((reference) => reference.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'WorkUnit expertRefs must be unique', path: ['expertRefs'] });
  }
});

const submissionWorkUnitSchema = z.object({
  id: identifier,
  objective: canonicalText(16_384),
  scope: z.array(repositoryRelativePath).min(1).max(256),
  dependencies: z.array(identifier).max(128),
  skillNames: z.array(canonicalText(300)).max(64),
  expertRefs: z.array(expertRefSchema).max(3).default([]),
  acceptanceCriteria: z.array(canonicalText(8_192)).min(1).max(128),
  focusedVerifiers: submissionVerifierListSchema(),
  routes: z.array(z.enum(WORK_UNIT_ROUTES)).min(1).max(WORK_UNIT_ROUTES.length),
}).strict().superRefine((unit, context) => {
  const expertIds = unit.expertRefs.map((reference) => reference.id);
  if (new Set(expertIds).size !== expertIds.length) {
    context.addIssue({ code: 'custom', message: 'WorkUnit expertRefs must be unique', path: ['expertRefs'] });
  }
  if (new Set(unit.routes).size !== unit.routes.length) {
    context.addIssue({ code: 'custom', message: 'WorkUnit routes must be unique', path: ['routes'] });
  }
});

export const workPlanSchema = z.object({
  objective: canonicalText(16_384),
  units: z.array(workUnitSchema).min(1).max(128),
}).strict().superRefine((plan, context) => {
  const ids = new Set(plan.units.map((unit) => unit.id));
  if (ids.size !== plan.units.length) {
    context.addIssue({ code: 'custom', message: 'WorkUnit IDs must be unique' });
  }
  for (const unit of plan.units) {
    if (unit.dependencies.includes(unit.id) || unit.dependencies.some((dependency) => !ids.has(dependency))) {
      context.addIssue({ code: 'custom', message: `WorkUnit ${unit.id} has an invalid dependency` });
    }
  }
  const dependencies = new Map(plan.units.map((unit) => [unit.id, unit.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (hasCycle(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (plan.units.some((unit) => hasCycle(unit.id))) {
    context.addIssue({ code: 'custom', message: 'WorkUnit dependencies must be acyclic' });
  }
});

export const submissionWorkPlanSchema = z.object({
  objective: canonicalText(16_384),
  units: z.array(submissionWorkUnitSchema).min(1).max(128),
}).strict().superRefine((plan, context) => {
  const ids = new Set(plan.units.map((unit) => unit.id));
  if (ids.size !== plan.units.length) {
    context.addIssue({ code: 'custom', message: 'WorkUnit IDs must be unique', path: ['units'] });
  }
  const dependencies = new Map(plan.units.map((unit) => [unit.id, unit.dependencies]));
  for (const [index, unit] of plan.units.entries()) {
    if (unit.dependencies.includes(unit.id) || unit.dependencies.some((dependency) => !ids.has(dependency))) {
      context.addIssue({ code: 'custom', message: 'WorkUnit has an invalid dependency', path: ['units', index, 'dependencies'] });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (hasCycle(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (plan.units.some((unit) => hasCycle(unit.id))) {
    context.addIssue({ code: 'custom', message: 'WorkUnit dependencies must be acyclic', path: ['units'] });
  }
});

const draftWorkPlanSchema = z.object({
  objective: canonicalText(16_384),
  units: z.array(workUnitSchema).length(0),
}).strict();

const contractProvenanceSchema = z.object(Object.fromEntries(
  ENNO_PROVENANCE_KEYS.map((key) => [key, z.enum(['explicit_user', 'repository_evidence', 'inferred'])]),
) as Record<(typeof ENNO_PROVENANCE_KEYS)[number], z.ZodEnum<{
  explicit_user: 'explicit_user';
  repository_evidence: 'repository_evidence';
  inferred: 'inferred';
}>>).strict();

export const acceptanceCriterionSchema = z.object({
  id: identifier,
  description: canonicalText(8_192),
}).strict();

export const skillRequirementSchema = z.object({
  name: canonicalText(300),
  purposes: z.array(z.enum(['planning', 'implementation', 'ui', 'testing', 'review', 'operations'])).min(1).max(6),
  required: z.boolean(),
}).strict();

const skillDiscoverySummarySchema = z.object({
  attempted: z.boolean(),
  mode: z.enum(['off', 'official', 'community']),
  requirements: z.array(canonicalText(300)).max(64),
  queries: z.array(canonicalText(500)).max(3),
  cacheHits: z.number().int().min(0),
  candidates: z.number().int().min(0),
  selected: z.array(z.object({
    skillId: canonicalText(1_000),
    name: canonicalText(500),
    source: canonicalText(201),
    officialStatus: z.enum(['curated', 'catalog-verified', 'owner-verified', 'registry-only', 'unknown']),
    imported: z.boolean(),
    updated: z.boolean(),
  }).strict()).max(2),
  failures: z.array(z.object({
    stage: z.enum(['search', 'source', 'validation', 'persistence']),
    code: canonicalText(200),
  }).strict()).max(128),
}).strict();

const skillSetEntrySchema = z.object({
  name: canonicalText(300),
  purposes: z.array(z.enum(['planning', 'implementation', 'ui', 'testing', 'review', 'operations'])).min(1).max(6),
  required: z.boolean(),
  availability: z.enum(['local', 'imported_fresh', 'external_reference', 'unavailable']),
  referenceId: canonicalText(1_000).nullable(),
}).strict();

const orchestrationIdSchema = canonicalText(256)
  .describe('Exact ennoOduno.orchestrationId returned by task_prepare or task_answer; this is not a host client session ID');
const resumeTokenSchema = canonicalText(256).describe('Opaque continuation token returned by the current client adapter route');

const requireExplicitIdentityOrResumeToken = (
  value: { workspace?: unknown; orchestrationId?: unknown; resumeToken?: unknown },
  context: z.RefinementCtx,
): void => {
  const explicit = value.workspace !== undefined && value.orchestrationId !== undefined;
  const partialExplicit = value.workspace !== undefined || value.orchestrationId !== undefined;
  const resumed = value.resumeToken !== undefined;
  if ((!explicit && !resumed) || (partialExplicit && !explicit) || (explicit && resumed)) {
    context.addIssue({
      code: 'custom',
      message: 'Provide either workspace plus orchestrationId or resumeToken',
      path: ['resumeToken'],
    });
  }
};

const advisorySlotIds = ADVISORY_SLOT_DEFINITIONS.map((slot) => slot.slotId) as [string, ...string[]];
const advisorySlotIdSchema = z.string().pipe(z.enum(advisorySlotIds));
const advisoryContextSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('ideal'),
    objective: canonicalText(16_384),
    constraints: z.array(canonicalText(8_192)).max(32),
    expectedOutcome: canonicalText(4_096),
    successSignals: z.array(canonicalText(8_192)).max(32),
    skillTrust: z.array(z.object({
      name: canonicalText(500),
      source: z.enum(['local', 'imported_fresh', 'external_reference', 'unavailable']),
      required: z.boolean(),
      trustStatus: z.enum(['available', 'reference_only', 'unavailable']),
    }).strict()).max(64),
  }).strict(),
  z.object({
    phase: z.literal('planning'),
    idealObjective: canonicalText(16_384),
    acceptanceCriteria: z.array(canonicalText(8_192)).max(128),
    planningConstraints: z.array(canonicalText(8_192)).max(32),
    skillAvailability: z.array(z.object({
      name: canonicalText(500),
      source: z.enum(['local', 'imported_fresh', 'external_reference', 'unavailable']),
      required: z.boolean(),
      trustStatus: z.enum(['available', 'reference_only', 'unavailable']),
    }).strict()).max(64),
  }).strict(),
  z.object({
    phase: z.literal('final_review'),
    workPlanSummary: canonicalText(16_384),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).max(128),
    workUnitOutcomes: z.array(z.object({
      id: identifier,
      objective: canonicalText(16_384),
      acceptanceCriteria: z.array(canonicalText(8_192)).max(128),
      routes: z.array(z.enum(WORK_UNIT_ROUTES)).max(WORK_UNIT_ROUTES.length),
      status: z.enum(['completed', 'failed', 'blocked']),
      summary: canonicalText(16_384),
      mutated: z.boolean(),
      changedPaths: z.array(repositoryRelativePath).max(256),
    }).strict()).max(128),
    changedPaths: z.array(repositoryRelativePath).max(256),
    verifierEvidence: z.array(z.object({
      id: identifier,
      kind: z.enum(['test', 'typecheck', 'build', 'lint', 'custom']),
      executable: canonicalText(1_024),
      args: z.array(z.string().max(16_384)).max(128),
      directory: repositoryRelativePath,
      timeoutMs: z.number().int().min(100).max(300_000),
      status: z.enum(['passed', 'failed', 'timeout', 'spawn_failed']),
      exitCode: z.number().int().nullable(),
      signal: z.string().max(200).nullable(),
      stdoutDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      stderrDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      stdoutPreview: z.string().max(2_048),
      stderrPreview: z.string().max(2_048),
      repositoryStatePolicyVersion: z.number().int().min(1).nullable(),
      repositoryStateDigest: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
    }).strict()).max(32),
    freshnessMarker: canonicalText(256),
    evidenceSetDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    repositoryStateDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    evidenceFreshnessPolicyVersion: z.number().int().min(1),
  }).strict(),
]);

const advisoryEvidenceSchema = z.object({
  path: repositoryRelativePath,
  statement: canonicalText(8_192),
}).strict();

const advisoryContributionSchema = z.union([
  z.object({
    slotId: advisorySlotIdSchema,
    outcome: z.literal('completed'),
    summary: canonicalText(8_192),
    recommendations: z.array(canonicalText(8_192)).max(32).default([]),
    risks: z.array(canonicalText(8_192)).max(32).default([]),
    evidence: z.array(advisoryEvidenceSchema).max(32).default([]),
  }).strict(),
  z.object({
    slotId: advisorySlotIdSchema,
    outcome: z.enum(ADVISORY_OUTCOMES.filter((outcome) => outcome !== 'completed') as ['failed', 'timeout', 'unavailable']),
    reasonCode: z.enum(ADVISORY_FAILURE_CODES),
  }).strict(),
]);

function parseStoredAdvisoryContribution(input: unknown): AdvisoryContribution {
  const parsed = advisoryContributionSchema.safeParse(input);
  if (!parsed.success) throw new KiokukoError('INTEGRITY_ERROR', 'Stored advisory contribution is invalid');
  return parsed.data as AdvisoryContribution;
}

export { parseStoredAdvisoryContribution };

export const advisoryContributionSchemaPublic = advisoryContributionSchema;

export const adviceSubmissionSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  mutationRevision: z.number().int().min(0),
  idempotencyKey: identifier,
  phase: z.enum(ADVISORY_PHASES),
  allowlistedContext: advisoryContextSchema,
  contributions: z.array(advisoryContributionSchema).length(3),
}).strict().superRefine(requireExplicitIdentityOrResumeToken);

const advisoryRoundDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const adviceReadSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  advisoryRoundDigest: advisoryRoundDigestSchema,
}).strict().superRefine(requireExplicitIdentityOrResumeToken);

const advisoryDispositionSchema = z.object({
  slotId: advisorySlotIdSchema,
  disposition: z.enum(['adopted', 'not_adopted', 'unavailable']),
  rationale: canonicalText(500).refine(
    (value) => findSecret(value) === undefined,
    'Advisory rationale must not contain secret material',
  ),
}).strict();

const requireDispositionWithDigest = (
  value: { advisoryRoundDigest?: unknown; advisoryDisposition?: unknown },
  context: z.RefinementCtx,
): void => {
  if (value.advisoryRoundDigest !== undefined) {
    if (value.advisoryDisposition === undefined
      || !Array.isArray(value.advisoryDisposition)
      || value.advisoryDisposition.length === 0) {
      context.addIssue({ code: 'custom', message: 'advisoryDisposition is required when an advisory digest is supplied' });
      return;
    }
  }
};

export const ennoContractSchema = z.object({
  revision: z.number().int().min(1),
  scope: z.array(boundedPath).max(256),
  exclusions: z.array(boundedPath).max(256),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(128),
  workPlan: z.union([workPlanSchema, draftWorkPlanSchema]),
  skillSet: z.object({
    entries: z.array(skillSetEntrySchema).max(64),
    intakeDiscovery: skillDiscoverySummarySchema,
    zenkiDiscovery: skillDiscoverySummarySchema,
  }).strict(),
  finalVerifiers: verifierListSchema(),
  maxAttempts: z.number().int().min(ENNO_MIN_ATTEMPTS).max(ENNO_MAX_ATTEMPTS),
  provenance: contractProvenanceSchema,
}).strict();

export const ennoRequestHandoffSchema = z.object({
  sourceRole: z.literal('enno-oduno'),
  taskType: z.enum(['build', 'debug', 'review', 'devops']),
  objective: canonicalText(16_384),
  target: canonicalText(4_096).nullable(),
  expected: canonicalText(8_192).nullable(),
  constraints: z.array(canonicalText(8_192)).max(16),
  verification: z.array(canonicalText(8_192)).max(16),
  stopConditions: z.array(canonicalText(8_192)).max(16),
}).strict();

export const odunoIdealSchema = z.object({
  objective: canonicalText(16_384),
  principles: z.array(canonicalText(8_192)).min(1).max(32),
  skillContributions: z.array(z.object({
    skillName: canonicalText(500),
    contribution: canonicalText(8_192),
  }).strict()).max(2),
  successSignals: z.array(canonicalText(8_192)).min(1).max(32),
}).strict().superRefine((ideal, context) => {
  const names = ideal.skillContributions.map((item) => item.skillName);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', message: 'Oduno ideal Skill contributions must be unique', path: ['skillContributions'] });
  }
});

export const odunoMeditationSchema = z.object({
  summary: canonicalText(16_384),
  inspectedPaths: z.array(repositoryRelativePath).min(1).max(256),
  deletionCandidates: z.array(z.object({
    kind: z.enum(['test', 'function']),
    path: repositoryRelativePath,
    name: canonicalText(1_000),
    reason: canonicalText(8_192),
    evidence: z.array(canonicalText(8_192)).min(1).max(16),
  }).strict()).max(128),
}).strict().superRefine((meditation, context) => {
  if (new Set(meditation.inspectedPaths).size !== meditation.inspectedPaths.length) {
    context.addIssue({ code: 'custom', message: 'Oduno meditation inspected paths must be unique', path: ['inspectedPaths'] });
  }
  const inspected = new Set(meditation.inspectedPaths);
  const candidateKeys = new Set<string>();
  for (const [index, candidate] of meditation.deletionCandidates.entries()) {
    if (!inspected.has(candidate.path)) {
      context.addIssue({ code: 'custom', message: 'Deletion candidate path must be inspected', path: ['deletionCandidates', index, 'path'] });
    }
    const key = `${candidate.kind}\0${candidate.path}\0${candidate.name}`;
    if (candidateKeys.has(key)) {
      context.addIssue({ code: 'custom', message: 'Oduno meditation deletion candidates must be unique', path: ['deletionCandidates', index] });
    }
    candidateKeys.add(key);
  }
});

export const idealSubmissionSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  advisoryRoundDigest: advisoryRoundDigestSchema.optional(),
  advisoryDisposition: z.array(advisoryDispositionSchema).max(3).optional(),
  ideal: odunoIdealSchema,
}).strict().superRefine((value, context) => {
  requireExplicitIdentityOrResumeToken(value, context);
  requireDispositionWithDigest(value, context);
});

export const planSubmissionSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  advisoryRoundDigest: advisoryRoundDigestSchema.optional(),
  advisoryDisposition: z.array(advisoryDispositionSchema).max(3).optional(),
  scope: z.array(repositoryRelativePath).min(1).max(256),
  exclusions: z.array(repositoryRelativePath).max(256),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(128),
  workPlan: submissionWorkPlanSchema,
  skillRequirements: z.array(skillRequirementSchema).max(64),
  finalVerifiers: submissionVerifierListSchema(1),
  maxAttempts: z.number().int().min(ENNO_MIN_ATTEMPTS).max(ENNO_MAX_ATTEMPTS).default(8),
  provenance: contractProvenanceSchema,
  recoveryAction: z.enum(['continue_same_plan', 'revise_plan']).optional().describe(
    'Required only when explicitly resuming a same-run plan-start recovery after the user chose one displayed option.',
  ),
  capabilities: z.array(z.unknown()).optional().describe(
    'Complete current client capability descriptors. The field remains transport-optional only so omission can return a safe user-facing recovery choice before any plan effect.',
  ),
}).strict().superRefine((submission, context) => {
  requireExplicitIdentityOrResumeToken(submission, context);
  requireDispositionWithDigest(submission, context);
  const requirements = new Set(submission.skillRequirements.map((requirement) => requirement.name.normalize('NFKC').toLowerCase()));
  const standardSkills = new Set([
    STANDARD_SOUL_SKILL_NAME,
    STANDARD_FUNCTION_SKILL_NAME,
    STANDARD_UI_SKILL_NAME,
  ]);
  for (const [index, unit] of submission.workPlan.units.entries()) {
    for (const skillName of unit.skillNames) {
      const normalized = skillName.normalize('NFKC').toLowerCase();
      if (!requirements.has(normalized) && !standardSkills.has(normalized)) {
        context.addIssue({
          code: 'custom',
          message: `WorkUnit ${unit.id} uses an undeclared Skill`,
          path: ['workPlan', 'units', index, 'skillNames'],
        });
      }
    }
  }
});

export const ennoAnswerSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  action: z.enum(['approve', 'revise', 'cancel']),
  requestedChanges: canonicalText(16_384).optional(),
}).strict().superRefine((value, context) => {
  requireExplicitIdentityOrResumeToken(value, context);
  if (value.action === 'revise' && value.requestedChanges === undefined) {
    context.addIssue({ code: 'custom', message: 'requestedChanges is required when revising' });
  }
  if (value.action !== 'revise' && value.requestedChanges !== undefined) {
    context.addIssue({ code: 'custom', message: 'requestedChanges is only valid when revising' });
  }
});

export const workReportSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  leaseToken: canonicalText(256).optional(),
  routeEpoch: z.number().int().min(0).optional(),
  workUnitId: identifier,
  result: z.object({
    outcome: z.enum(['completed', 'failed', 'blocked']),
    summary: canonicalText(16_384),
    mutated: z.boolean(),
    changedPaths: z.array(repositoryRelativePath).max(256),
  }).strict(),
}).strict().superRefine(requireExplicitIdentityOrResumeToken);

export const finishSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  advisoryRoundDigest: advisoryRoundDigestSchema.optional(),
  advisoryDisposition: z.array(advisoryDispositionSchema).max(3).optional(),
  review: z.object({
    decision: z.enum(['accept', 'replan']),
    summary: canonicalText(16_384),
  }).strict(),
}).strict().superRefine((value, context) => {
  requireExplicitIdentityOrResumeToken(value, context);
  requireDispositionWithDigest(value, context);
});

export const verificationPrepareSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
}).strict().superRefine(requireExplicitIdentityOrResumeToken);

export const meditationSubmissionSchema = z.object({
  runId: identifier,
  workspace: canonicalText(256).optional(),
  orchestrationId: orchestrationIdSchema.optional(),
  resumeToken: resumeTokenSchema.optional(),
  expectedRevision: z.number().int().min(1),
  idempotencyKey: identifier,
  meditation: odunoMeditationSchema,
}).strict().superRefine(requireExplicitIdentityOrResumeToken);

function parseBoundary<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', message);
  return parsed.data;
}

function parseInputBoundary<T>(
  operation: EnnoValidationOperation,
  schema: z.ZodType<T>,
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw ennoZodValidationError(operation, parsed.error);
  return parsed.data;
}

export function parseWorkPlan(input: unknown): WorkPlan {
  return parseBoundary(workPlanSchema, input, 'Enno WorkPlan is invalid');
}

export function parseEnnoContract(input: unknown): EnnoOdunoContract {
  return parseBoundary(ennoContractSchema, input, 'Stored Enno contract is invalid');
}

export function parseEnnoRequestHandoff(input: unknown): EnnoRequestHandoff {
  return parseBoundary(ennoRequestHandoffSchema, input, 'Stored Enno request handoff is invalid');
}

export function parseOdunoIdeal(input: unknown): OdunoIdeal {
  return parseBoundary(odunoIdealSchema, input, 'Stored Oduno ideal is invalid');
}

export function parseOdunoMeditation(input: unknown): OdunoMeditation {
  return parseBoundary(odunoMeditationSchema, input, 'Stored Oduno meditation is invalid');
}

export function parseVerifierSpec(input: unknown): VerifierSpec {
  return parseBoundary(verifierSpecSchema, input, 'Enno verifier is invalid');
}

export function parseWorkReportResult(input: unknown): WorkReportResult {
  return parseBoundary(workReportSchema.shape.result, input, 'Enno work report is invalid');
}

export function parsePlanSubmission(input: unknown): z.infer<typeof planSubmissionSchema> {
  return parseInputBoundary('plan_submit', planSubmissionSchema, input);
}

export function parseAdviceSubmission(input: unknown): z.infer<typeof adviceSubmissionSchema> {
  return parseInputBoundary('advice_submit', adviceSubmissionSchema, input);
}

export function parseAdviceRead(input: unknown): z.infer<typeof adviceReadSchema> {
  return parseInputBoundary('advice_read', adviceReadSchema, input);
}

export function parseIdealSubmission(input: unknown): z.infer<typeof idealSubmissionSchema> {
  return parseInputBoundary('ideal_submit', idealSubmissionSchema, input);
}

export function parseEnnoAnswer(input: unknown): z.infer<typeof ennoAnswerSchema> {
  return parseBoundary(ennoAnswerSchema, input, 'Enno answer is invalid');
}

export function parseWorkReport(input: unknown): z.infer<typeof workReportSchema> {
  return parseInputBoundary('work_report', workReportSchema, input);
}

export function parseFinishRequest(input: unknown): z.infer<typeof finishSchema> {
  return parseInputBoundary('finish', finishSchema, input);
}

export function parseVerificationPrepare(input: unknown): z.infer<typeof verificationPrepareSchema> {
  return parseInputBoundary('verify_prepare', verificationPrepareSchema, input);
}

export function parseMeditationSubmission(input: unknown): z.infer<typeof meditationSubmissionSchema> {
  return parseInputBoundary('meditation_submit', meditationSubmissionSchema, input);
}

export function assertVerifierCwd(repositoryRoot: string, verifier: VerifierSpec): void {
  const candidate = path.isAbsolute(verifier.cwd) ? verifier.cwd : path.resolve(repositoryRoot, verifier.cwd);
  const relative = path.relative(repositoryRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new KiokukoError('SECURITY_REJECTION', 'Verifier cwd must stay inside the canonical repository root');
  }
}

export function assertContractVerifierCwds(repositoryRoot: string, contract: Pick<EnnoOdunoContract, 'workPlan' | 'finalVerifiers'>): void {
  for (const verifier of contract.finalVerifiers) assertVerifierCwd(repositoryRoot, verifier);
  for (const unit of contract.workPlan.units) {
    for (const verifier of unit.focusedVerifiers) assertVerifierCwd(repositoryRoot, verifier);
  }
}
