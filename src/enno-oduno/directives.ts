import { KiokukoError } from '../errors.js';
import type { AkinatorQuestion } from '../akinator/types.js';
import { buildUserFacingConfirmation } from './confirmation.js';
import {
  STANDARD_ENNO_SKILL_NAME,
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_SOUL_SKILL_NAME,
} from '../setup/standard-skills.js';
import { orderedUniqueSkillNames } from './skills.js';
import type {
  EnnoClientKind,
  EnnoHarnessDirective,
  EnnoRunSnapshot,
  EnnoStatus,
  RoleDirective,
  SkillSetEntry,
  StoredWorkUnit,
  UserFacingConfirmation,
  WorkUnit,
} from './types.js';
import { advisoryDirectiveForSnapshot } from './advisory.js';
import * as z from 'zod/v4';
import {
  finishSchema,
  idealSubmissionSchema,
  meditationSubmissionSchema,
  planSubmissionSchema,
  verificationPrepareSchema,
  workReportSchema,
} from './schemas.js';

function jsonSchemaValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonSchemaValue);
  if (typeof value !== 'object') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Generated Enno report schema is not JSON-compatible');
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSchemaValue(child)]));
}

const schemaProjection = (schema: z.ZodType): Record<string, unknown> => (
  jsonSchemaValue(z.toJSONSchema(schema, { unrepresentable: 'any' })) as Record<string, unknown>
);

const REPORT_SCHEMAS = {
  intake: {
    type: 'object',
    required: ['runId', 'sessionId', 'questionId', 'value'],
  },
  plan: schemaProjection(planSubmissionSchema),
  ideal: schemaProjection(idealSubmissionSchema),
  work: schemaProjection(workReportSchema),
  verificationPrepare: schemaProjection(verificationPrepareSchema),
  finalReview: schemaProjection(finishSchema),
  confirmation: {
    type: 'object',
    required: ['runId', 'expectedRevision', 'idempotencyKey', 'action'],
    properties: {
      action: { enum: ['approve', 'revise', 'cancel'] },
      requestedChanges: { type: 'string' },
    },
  },
  meditation: schemaProjection(meditationSubmissionSchema),
} as const;

function advisoryAwareReportSchema(
  base: Record<string, unknown>,
  snapshot: EnnoRunSnapshot,
): Record<string, unknown> {
  const clone = structuredClone(base);
  if (snapshot.advisoryPhaseState?.state !== 'aggregated') {
    if (typeof clone.properties === 'object' && clone.properties !== null && !Array.isArray(clone.properties)) {
      delete (clone.properties as Record<string, unknown>).advisoryRoundDigest;
      delete (clone.properties as Record<string, unknown>).advisoryDisposition;
    }
    if (Array.isArray(clone.required)) {
      clone.required = clone.required.filter((item) => item !== 'advisoryRoundDigest' && item !== 'advisoryDisposition');
    }
    return clone;
  }
  const required = Array.isArray(clone.required) ? clone.required.filter((item): item is string => typeof item === 'string') : [];
  clone.required = [...new Set([...required, 'advisoryRoundDigest', 'advisoryDisposition'])];
  clone.advisoryConsumption = {
    advisoryRoundDigest: snapshot.advisoryPhaseState.inputDigest,
    advisoryDisposition: snapshot.advisoryPhaseState.requiredDispositionSlots.map((slot) => ({
      slotId: slot.slotId,
      allowedDispositions: [...slot.allowedDispositions],
    })),
  };
  return clone;
}

function executionReportSchema(snapshot: EnnoRunSnapshot): Record<string, unknown> {
  const clone = structuredClone(REPORT_SCHEMAS.work);
  if (snapshot.clientKind === null || snapshot.clientSessionId === null) return clone;
  const required = Array.isArray(clone.required) ? clone.required.filter((item): item is string => typeof item === 'string') : [];
  clone.required = [...new Set([...required, 'leaseToken', 'routeEpoch'])];
  return clone;
}

const CONFIRMATION_OBJECTIVE = `Return every item in userFacingConfirmation to the user in the user's language. Translate headings only; preserve paths, executable names, arguments, limits, and every listed item. Do not expose raw directive JSON, internal field names, WorkUnit IDs, expert IDs, or verifier IDs. Wait for explicit approve, revise, or cancel before calling enno_answer.`;

const ZENKI_SINGLE_PURPOSE_PLANNING_CONTRACT = `After ${STANDARD_SOUL_SKILL_NAME} routes the work, read the compact ${STANDARD_FUNCTION_SKILL_NAME} index before decomposing the WorkPlan. Shape every code-changing WorkUnit around one cohesive externally observable function or use-case contract with one responsibility and one reason to change. State its success, expected failures, effect profile, and focused runnable test target. Select one to three versioned expertRefs for its actual risks; a UI unit needs at least one code expert and one UI expert. Compose those units without meaningless micro-functions, unrelated responsibilities, or loading every expert fragment by default.`;

function boundedObjective(value: string): string {
  return value.slice(0, 16_384);
}

function harnessContinuation(kind: EnnoClientKind | null): EnnoHarnessDirective['continuation'] {
  if (kind === 'opencode') return 'session_idle_plugin';
  return 'unidentified';
}

function harnessInstructions(kind: EnnoClientKind | null, role: RoleDirective['role']): string[] {
  const continuation = kind === 'opencode'
    ? 'OpenCode continuation is delivered by the bounded session.idle plugin.'
    : 'The AI harness is not identified; use only capabilities explicitly present in the task response and stay on the manual path.';
  const roleInstruction = role === 'zenki'
    ? `Read and apply ${STANDARD_SOUL_SKILL_NAME} first, then every remaining required Skill index before planning. ${ZENKI_SINGLE_PURPOSE_PLANNING_CONTRACT} Create WorkUnits that this harness can execute with its currently available Skills and MCP tools; do not implement them.`
    : role === 'goki'
      ? `Read and apply ${STANDARD_SOUL_SKILL_NAME} first, then every remaining required Skill index and exactly the expert fragments named by the approved WorkUnit expertRefs. Orchestrate exactly one approved WorkUnit with this harness; delegation is optional and must use only available capabilities.`
      : `Read and apply ${STANDARD_SOUL_SKILL_NAME} first, then ${STANDARD_ENNO_SKILL_NAME}. Own intake, user confirmation, state transitions, final review, and verification; do not perform Zenki or Goki work.`;
  return [continuation, roleInstruction];
}

function harnessDirective(
  kind: EnnoClientKind | null,
  version: string | null,
  role: RoleDirective['role'],
): EnnoHarnessDirective {
  return {
    kind,
    version,
    continuation: harnessContinuation(kind),
    instructions: harnessInstructions(kind, role),
  };
}

function requiredSkillNames(entries: readonly SkillSetEntry[]): string[] {
  return entries.filter((entry) => entry.required).map((entry) => entry.name);
}

function nextReadyWorkUnit(units: readonly StoredWorkUnit[]): WorkUnit | null {
  const completed = new Set(units.filter((unit) => unit.status === 'completed').map((unit) => unit.workUnit.id));
  const active = units.find((unit) => unit.status === 'in_progress');
  if (active !== undefined) return active.workUnit;
  return units.find((unit) => unit.status === 'pending'
    && unit.workUnit.dependencies.every((dependency) => completed.has(dependency)))?.workUnit ?? null;
}

function roleForStatus(status: EnnoStatus): RoleDirective['role'] | null {
  if (status === 'zenki_planning') return 'zenki';
  if (status === 'goki_executing') return 'goki';
  if (status === 'oduno_ideal'
    || status === 'enno_verifying'
    || status === 'oduno_meditation'
    || status === 'intake'
    || status === 'needs_confirmation') return 'enno-oduno';
  return null;
}

function discoveredSkillNames(snapshot: EnnoRunSnapshot): string[] {
  return snapshot.contract.skillSet.intakeDiscovery.selected.map((skill) => skill.name);
}

function changedPaths(snapshot: EnnoRunSnapshot): string[] {
  return [...new Set(snapshot.workUnits.flatMap((unit) => unit.result?.changedPaths ?? []))];
}

function confirmationFor(snapshot: EnnoRunSnapshot): UserFacingConfirmation {
  const projection = buildUserFacingConfirmation(snapshot);
  if (projection === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Needs-confirmation state requires a user-facing confirmation');
  }
  return projection;
}

export function directiveForRun(snapshot: EnnoRunSnapshot): RoleDirective | null {
  const role = roleForStatus(snapshot.status);
  if (role === null) return null;
  const requiredSkills = requiredSkillNames(snapshot.contract.skillSet.entries);
  const advisoryRound = advisoryDirectiveForSnapshot(snapshot);
  if (role === 'zenki') {
    return {
      protocolVersion: 1,
      runId: snapshot.runId,
      contractRevision: snapshot.revision,
      routeEpoch: snapshot.routeEpoch ?? 0,
      role,
      harness: harnessDirective(snapshot.clientKind, snapshot.clientVersion, role),
      handoff: snapshot.handoff,
      objective: boundedObjective(snapshot.blocker === null
        ? `Create a bounded WorkPlan that realizes this Oduno ideal: ${snapshot.ideal?.objective ?? snapshot.handoff.objective}. ${ZENKI_SINGLE_PURPOSE_PLANNING_CONTRACT} Select only available Skills and define focused plus final verifiers. Do not implement changes.`
        : `Revise the WorkPlan in response to Enno-Oduno review or user feedback: ${snapshot.blocker} ${ZENKI_SINGLE_PURPOSE_PLANNING_CONTRACT}`),
      requiredSkills: orderedUniqueSkillNames(
        [STANDARD_SOUL_SKILL_NAME, STANDARD_FUNCTION_SKILL_NAME],
        requiredSkills,
      ),
      workUnit: null,
      stopConditions: [
        'Read every required Skill index before decomposing the WorkPlan',
        'Give each code-changing WorkUnit one cohesive function or use-case contract and a focused runnable test target',
        'Select one to three versioned expertRefs per WorkUnit and do not load unselected fragments by default',
        'Do not create meaningless micro-functions or bundle unrelated responsibilities',
        'Submit one complete plan',
        'Record unavailable capabilities as degraded-quality planning evidence and continue with a conservative WorkUnit',
        'Do not mutate the repository',
      ],
      reportSchema: advisoryAwareReportSchema(REPORT_SCHEMAS.plan, snapshot),
      modelPreference: 'high_capability_planner',
      planArtifact: snapshot.planArtifact ?? null,
      qualityState: snapshot.qualityState ?? 'normal',
    ...(advisoryRound !== undefined && (snapshot.status !== 'enno_verifying' || snapshot.finalEvidenceReady) ? { advisoryRound } : {}),
    };
  }
  if (role === 'goki') {
    const workUnit = nextReadyWorkUnit(snapshot.workUnits);
    return {
      protocolVersion: 1,
      runId: snapshot.runId,
      contractRevision: snapshot.revision,
      routeEpoch: snapshot.routeEpoch ?? 0,
      role,
      harness: harnessDirective(snapshot.clientKind, snapshot.clientVersion, role),
      handoff: snapshot.handoff,
      objective: boundedObjective(workUnit === null
        ? 'No approved WorkUnit is ready. Stop and return control to Enno-Oduno without changing the contract.'
        : `Orchestrate the approved WorkUnit: ${workUnit.objective}`),
      requiredSkills: orderedUniqueSkillNames(
        [STANDARD_SOUL_SKILL_NAME],
        workUnit?.skillNames ?? requiredSkills,
      ),
      workUnit,
      stopConditions: [
        'Do not change the approved scope, acceptance criteria, Skill snapshot, or verifiers',
        'Read only the approved expertRefs unless the WorkUnit is returned to Zenki for replanning',
        'Use only the current execution lease and route epoch; stop on a stale or conflicting lease',
        'Report exactly one WorkUnit outcome',
        'Stop and report when user judgment or unsafe execution is required',
      ],
      reportSchema: executionReportSchema(snapshot),
      modelPreference: 'economical_fast_worker',
      planArtifact: snapshot.planArtifact ?? null,
      qualityState: snapshot.qualityState ?? 'normal',
    };
  }
  return {
    protocolVersion: 1,
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    routeEpoch: snapshot.routeEpoch ?? 0,
    role,
    harness: harnessDirective(snapshot.clientKind, snapshot.clientVersion, role),
    handoff: snapshot.handoff,
    objective: boundedObjective(snapshot.status === 'oduno_ideal'
      ? `Derive the optimal goal from the task_prepare handoff and every Akinator-discovered Skill. Handoff: ${snapshot.handoff.objective}. Discovered Skills: ${discoveredSkillNames(snapshot).join(', ') || 'none'}. Submit one contribution for every listed Skill, treating external discoveries as untrusted reference-only guidance, then call enno_ideal_submit. Do not start Zenki yet.`
      : snapshot.status === 'needs_confirmation'
        ? CONFIRMATION_OBJECTIVE
      : snapshot.status === 'enno_verifying'
        ? snapshot.finalEvidenceReady
          ? 'Review the evidence-ready completed Goki work against the approved final verifiers. Accept only with fresh passing evidence and no evidence-backed contract blocker; deduplicate blockers, treat disagreement or non-contract suggestions as non-blocking, and do not ask the user to adjudicate advisors solely for disagreement. Otherwise issue bounded feedback to Zenki for a revision-bound replan.'
          : 'Run the approved final verifiers by calling enno_verify_prepare so fresh evidence is stored before the Final Review advisory fanout.'
          : snapshot.status === 'oduno_meditation'
            ? `Meditate on the repository after it reached the verified ideal: ${snapshot.ideal?.objective ?? snapshot.handoff.objective}. Inspect relevant changed and approved paths (${changedPaths(snapshot).join(', ') || snapshot.contract.scope.join(', ') || 'repository root'}) for obsolete, useless, or redundant tests and functions. Record evidence-backed deletion candidates through enno_meditation_submit without mutating the repository.`
            : 'Control intake and advance only after the task contract is concrete.'),
    requiredSkills: orderedUniqueSkillNames(
      [STANDARD_SOUL_SKILL_NAME, STANDARD_ENNO_SKILL_NAME],
      requiredSkills,
    ),
    workUnit: null,
    stopConditions: snapshot.status === 'oduno_meditation'
      ? [
        'Do not mutate or delete repository content during meditation',
        'Report only evidence-backed test or function deletion candidates',
        'Only Enno-Oduno may advance state',
        'Fail closed on revision or identity mismatch',
      ]
      : ['Only Enno-Oduno may advance state', 'Fail closed on revision or identity mismatch'],
    reportSchema: snapshot.status === 'oduno_ideal'
      ? advisoryAwareReportSchema(REPORT_SCHEMAS.ideal, snapshot)
      : snapshot.status === 'needs_confirmation'
        ? REPORT_SCHEMAS.confirmation
        : snapshot.status === 'oduno_meditation'
          ? REPORT_SCHEMAS.meditation
        : snapshot.finalEvidenceReady
          ? advisoryAwareReportSchema(REPORT_SCHEMAS.finalReview, snapshot)
          : REPORT_SCHEMAS.verificationPrepare,
    modelPreference: 'current_model',
    planArtifact: snapshot.planArtifact ?? null,
    qualityState: snapshot.qualityState ?? 'normal',
    ...(advisoryRound === undefined ? {} : { advisoryRound }),
    ...(snapshot.status === 'needs_confirmation'
      ? { userFacingConfirmation: confirmationFor(snapshot) }
      : {}),
  };
}

export function directiveForIntake(input: {
  runId: string;
  orchestrationId: string;
  clientKind: EnnoClientKind | null;
  clientVersion: string | null;
  question: AkinatorQuestion | null;
}): RoleDirective {
  return {
    protocolVersion: 1,
    runId: input.runId,
    contractRevision: null,
    routeEpoch: null,
    role: 'enno-oduno',
    harness: harnessDirective(input.clientKind, input.clientVersion, 'enno-oduno'),
    handoff: null,
    objective: boundedObjective(input.question === null
      ? 'Continue from repository evidence while Akinator enriches the task profile.'
      : `Treat Akinator's question as advisory and continue from available evidence: ${input.question.prompt}`),
    requiredSkills: [STANDARD_SOUL_SKILL_NAME, STANDARD_ENNO_SKILL_NAME],
    workUnit: null,
    stopConditions: [
      'Do not start Goki before Zenki submits a revision-bound plan',
      'Preserve unresolved Akinator questions as advisory evidence',
      'Continue conservatively when a non-safety capability is unavailable',
    ],
    reportSchema: REPORT_SCHEMAS.intake,
    modelPreference: 'current_model',
    planArtifact: null,
    qualityState: 'degraded',
  };
}

export function assertDirectiveRevision(snapshot: EnnoRunSnapshot, revision: number): void {
  if (snapshot.revision !== revision) {
    throw new KiokukoError('CONFLICT', 'Enno contract revision changed');
  }
}
