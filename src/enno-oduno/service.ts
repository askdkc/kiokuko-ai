import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { assertCapabilityCatalogBinding } from '../akinator/capability-binding.js';
import { normalizeCapabilityCatalog } from '../akinator/capabilities.js';
import { getAkinatorContextService } from '../akinator/service.js';
import type { AkinatorQuestion, AkinatorReasoning, TaskProfile } from '../akinator/types.js';
import {
  claimTaskSkillDiscoveryAttempt,
  completeTaskSkillDiscoveryAttempt,
  failTaskSkillDiscoveryAttempt,
  readTaskSkillDiscoveryAttempt,
} from '../akinator/skill-discovery-attempt.js';
import {
  captureProjectManifestSnapshot,
  resolveProjectFingerprint,
} from '../repository/project-fingerprint.js';
import { discoverSkills } from '../skills/discovery-service.js';
import type { DiscoverSkillsInput, SkillDiscoverySummary } from '../skills/types.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { sanitizeJson } from '../security/sanitize.js';
import { LedgerStore } from '../ledger/store.js';
import { directiveForIntake, directiveForRun } from './directives.js';
import { advisoryContextForSnapshot, advisoryDirectiveForSnapshot, advisoryInputDigest, advisoryPhaseForStatus, normalizeAdvisoryContributions } from './advisory.js';
import {
  createAdvisoryRoundInTransaction,
  ensureAdvisoryRoundConsumedInTransaction,
  readAdvisoryRound,
  readSubmittedAdvisoryRound,
} from './advisory-store.js';
import { assertWorkPlanExpertCoverage } from './experts.js';
import { buildEnnoRequestHandoff } from './handoff.js';
import { identifyEnnoClientKind } from './harness.js';
import {
  ennoAnswerSchema,
  adviceReadSchema,
  finishSchema,
  idealSubmissionSchema,
  meditationSubmissionSchema,
  planSubmissionSchema,
  workReportSchema,
  assertContractVerifierCwds,
  parseEnnoAnswer,
  parseAdviceRead,
  parseAdviceSubmission,
  parseFinishRequest,
  parseIdealSubmission,
  parseMeditationSubmission,
  parseOdunoIdeal,
  parseOdunoMeditation,
  parsePlanSubmission,
  parseVerificationPrepare,
  parseWorkReport,
} from './schemas.js';
import {
  completeRequiredSkillList,
  createSkillSetEntries,
  orderedUniqueSkillNames,
  unavailableRequiredSkills,
} from './skills.js';
import {
  appendEnnoEventInTransaction,
  assertExecutionLeaseInTransaction,
  claimExecutionLeaseInTransaction,
  completeOperationInTransaction,
  createEnnoDraft,
  finishVerifierRunsInTransaction,
  readEnnoSnapshot,
  readFreshFinalVerifierResults,
  readOperationReceipt,
  releaseExecutionLeaseInTransaction,
  renewExecutionLeaseInTransaction,
  resolveEnnoIdentity,
  replaceWorkUnitsInTransaction,
  setWorkUnitStatusInTransaction,
  startOperationInTransaction,
  startVerifierRunsInTransaction,
  operationLeaseMsForVerifiers,
  terminalizeLedgerRunInTransaction,
  updateContractInTransaction,
  type EnnoIdentity,
  type OperationIdentity,
} from './store.js';
import {
  ENNO_APPLICABLE_TASK_TYPES,
  ENNO_MAX_EXTERNAL_SKILLS,
  ENNO_MAX_TOTAL_SKILL_QUERIES,
  ENNO_PROVENANCE_KEYS,
  type EnnoOdunoContract,
  type EnnoExecutionLease,
  type EnnoNextAction,
  type EnnoOdunoState,
  type EnnoRunSnapshot,
  type AdvisoryContext,
  type AdvisoryDisposition,
  type AdvisoryPhase,
  type AdvisoryContribution,
  type StoredAdvisoryRound,
  type OdunoIdeal,
  type OdunoMeditation,
  type VerifierSpec,
  type VerifierRunResult,
} from './types.js';
import { runVerifiers, type VerifierDependencies } from './verifier.js';
import {
  planStartRecoveryBlocker,
  planStartRecoveryError,
  planStartRecoveryReasonFromBlocker,
  type PlanStartRecoveryReason,
} from './plan-recovery.js';
import { ennoValidationError } from './validation-errors.js';
import { captureRepositoryState } from './repository-state.js';
import {
  sanitizeEnnoAnswer,
  sanitizeFinishRequest,
  sanitizeIdealSubmission,
  sanitizeMeditationSubmission,
  sanitizePlanSubmission,
  sanitizeWorkReport,
} from './sanitize.js';
import type * as z from 'zod/v4';
import {
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_SOUL_SKILL_NAME,
  STANDARD_UI_SKILL_NAME,
} from '../setup/standard-skills.js';

type PlanSubmission = z.infer<typeof planSubmissionSchema>;
type IdealSubmission = z.infer<typeof idealSubmissionSchema>;
type EnnoAnswer = z.infer<typeof ennoAnswerSchema>;
type WorkReport = z.infer<typeof workReportSchema>;
type FinishRequest = z.infer<typeof finishSchema>;
type MeditationSubmission = z.infer<typeof meditationSubmissionSchema>;

export interface EnnoOperationResponse {
  ennoOduno: EnnoOdunoState;
  verifierResults?: VerifierRunResult[];
  advisoryRound?: StoredAdvisoryRound;
  executionLease?: EnnoExecutionLease;
}

export interface EnnoAdviceReadResponse {
  protocolVersion: 1;
  advisoryRound: StoredAdvisoryRound;
  allowlistedContext: AdvisoryContext;
}

export interface EnnoServiceDependencies extends VerifierDependencies {
  discoverSkills?: typeof discoverSkills;
  fetchImpl?: typeof fetch;
}

interface PreparedTaskShape {
  project: { repositoryRoot: string; repositoryId: string; workspace: string };
  intake: {
    sessionId: string;
    status: 'needs_answer' | 'ready' | 'exhausted';
    profile: TaskProfile;
    question: AkinatorQuestion | null;
    reasoning: AkinatorReasoning;
  };
  run: { runId: string; status: 'intake' | 'active' };
  skillDiscovery: SkillDiscoverySummary;
}

function stateForSnapshot(snapshot: EnnoRunSnapshot): EnnoOdunoState {
  let nextAction: EnnoNextAction;
  if (snapshot.status === 'intake') nextAction = 'answer_intake';
  else if (snapshot.status === 'oduno_ideal') nextAction = 'submit_ideal';
  else if (snapshot.status === 'zenki_planning') nextAction = 'submit_plan';
  else if (snapshot.status === 'needs_confirmation') nextAction = 'ask_user_confirmation';
  else if (snapshot.status === 'goki_executing') nextAction = 'execute_work_unit';
  else if (snapshot.status === 'enno_verifying') nextAction = snapshot.finalEvidenceReady ? 'submit_final_review' : 'run_final_verification';
  else if (snapshot.status === 'oduno_meditation') nextAction = 'submit_meditation';
  else if (snapshot.status === 'blocked') nextAction = 'report_blocker';
  else nextAction = 'complete';
  const directive = directiveForRun(snapshot);
  return {
    applicable: true,
    status: snapshot.status,
    orchestrationId: snapshot.orchestrationId,
    clientBinding: {
      status: snapshot.clientSessionId === null ? 'pending' : 'bound',
      clientKind: snapshot.clientKind,
      clientVersion: snapshot.clientVersion,
      identified: snapshot.clientKind !== null,
    },
    contractRevision: snapshot.revision,
    routeEpoch: snapshot.routeEpoch ?? 0,
    ideal: snapshot.ideal,
    meditation: snapshot.meditation,
    currentRole: directive?.role ?? null,
    directive,
    nextAction,
    advisoryPhaseState: snapshot.advisoryPhaseState ?? { state: 'not_started' },
  };
}

function intakeEnnoState(input: {
  runId: string;
  orchestrationId: string;
  clientKind: EnnoRunSnapshot['clientKind'];
  clientVersion: string | null;
  clientSessionId: string | null;
  question: AkinatorQuestion | null;
}): EnnoOdunoState {
  const directive = directiveForIntake(input);
  return {
    applicable: true,
    status: 'intake',
    orchestrationId: input.orchestrationId,
    clientBinding: {
      status: input.clientSessionId === null ? 'pending' : 'bound',
      clientKind: input.clientKind,
      clientVersion: input.clientVersion,
      identified: input.clientKind !== null,
    },
    contractRevision: null,
    routeEpoch: null,
    ideal: null,
    meditation: null,
    currentRole: 'enno-oduno',
    directive,
    nextAction: 'answer_intake',
    advisoryPhaseState: { state: 'not_started' },
  };
}

export function inapplicableEnnoState(): EnnoOdunoState {
  return {
    applicable: false,
    status: 'intake',
    orchestrationId: null,
    clientBinding: null,
    contractRevision: null,
    routeEpoch: null,
    ideal: null,
    meditation: null,
    currentRole: null,
    directive: null,
    nextAction: 'complete',
    advisoryPhaseState: { state: 'not_started' },
  };
}

export function ennoStateForPreparedTask(
  database: SqliteDatabase,
  prepared: PreparedTaskShape,
  client: { kind: string; version?: string; sessionId?: string } | undefined,
): EnnoOdunoState {
  const taskType = prepared.intake.profile.taskType;
  const clientKind = identifyEnnoClientKind(client?.kind);
  const clientVersion = clientKind === null ? null : client?.version ?? null;
  const clientSessionId = clientKind === null ? null : client?.sessionId ?? null;
  if (prepared.intake.status === 'needs_answer' && taskType === null) {
    return intakeEnnoState({
      runId: prepared.run.runId,
      orchestrationId: prepared.intake.sessionId,
      clientKind,
      clientVersion,
      clientSessionId,
      question: prepared.intake.question,
    });
  }
  if (taskType === null || !ENNO_APPLICABLE_TASK_TYPES.includes(taskType as (typeof ENNO_APPLICABLE_TASK_TYPES)[number])) {
    return inapplicableEnnoState();
  }
  if (prepared.intake.status === 'needs_answer') {
    return intakeEnnoState({
      runId: prepared.run.runId,
      orchestrationId: prepared.intake.sessionId,
      clientKind,
      clientVersion,
      clientSessionId,
      question: prepared.intake.question,
    });
  }
  const handoff = buildEnnoRequestHandoff(prepared.intake.profile, prepared.intake.reasoning);
  const snapshot = createEnnoDraft(database, {
    runId: prepared.run.runId,
    workspace: prepared.project.workspace,
    orchestrationId: prepared.intake.sessionId,
    repositoryRoot: prepared.project.repositoryRoot,
    taskType: taskType as (typeof ENNO_APPLICABLE_TASK_TYPES)[number],
    taskTarget: prepared.intake.profile.target,
    taskExpected: prepared.intake.profile.expected,
    handoff,
    skillDiscovery: prepared.skillDiscovery,
    ...(clientKind === null ? {} : { initialClientKind: clientKind }),
    ...(clientVersion === null ? {} : { initialClientVersion: clientVersion }),
    ...(clientSessionId === null ? {} : { initialClientSessionId: clientSessionId }),
  });
  return stateForSnapshot(snapshot);
}

function operationIdentity(
  operation: OperationIdentity['operation'],
  idempotencyKey: string,
  input: unknown,
): OperationIdentity {
  const semanticInput = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .filter(([key]) => !['workspace', 'orchestrationId', 'resumeToken', 'idempotencyKey'].includes(key)))
    : input;
  const requestDigest = canonicalContentHash({ version: 1, operation, input: semanticInput });
  return { operation, idempotencyKey, requestDigest };
}

function advisoryContextForSubmission(snapshot: EnnoRunSnapshot, phase: AdvisoryPhase): AdvisoryContext {
  if (advisoryPhaseForStatus(snapshot.status) !== phase
    || (phase === 'final_review' && !snapshot.finalEvidenceReady)) {
    throw new KiokukoError('CONFLICT', 'Advisory round is not valid for the current Enno phase');
  }
  return advisoryContextForSnapshot(snapshot, phase);
}

function assertAdvisoryRoundInput(
  snapshot: EnnoRunSnapshot,
  phase: AdvisoryPhase,
  mutationRevision: number,
  context: AdvisoryContext,
  inputDigest: string,
  validationOperation?: 'ideal_submit' | 'plan_submit' | 'finish',
): void {
  if (snapshot.mutationRevision !== mutationRevision) {
    throw new KiokukoError('CONFLICT', 'Enno mutation revision changed');
  }
  const expectedContext = advisoryContextForSubmission(snapshot, phase);
  if (canonicalJson(expectedContext) !== canonicalJson(context)) {
    throw new KiokukoError('CONFLICT', 'Advisory context does not match the current Enno phase');
  }
  const expectedDigest = advisoryInputDigest({
    phase,
    contractRevision: snapshot.revision,
    mutationRevision,
    allowlistedContext: context,
  });
  if (expectedDigest !== inputDigest) {
    if (validationOperation !== undefined) {
      throw ennoValidationError(validationOperation, [{
        path: ['advisoryRoundDigest'],
        reasonCode: 'advisory_digest_stale',
      }], 'refresh_state');
    }
    throw new KiokukoError('CONFLICT', 'Advisory round digest does not match the current contract');
  }
}

function requireAdvisoryRound(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  phase: AdvisoryPhase,
  mutationRevision: number,
  context: AdvisoryContext,
  inputDigest: string,
): void {
  const operation = phase === 'planning' ? 'plan_submit' : phase === 'ideal' ? 'ideal_submit' : 'finish';
  assertAdvisoryRoundInput(snapshot, phase, mutationRevision, context, inputDigest, operation);
  const round = readAdvisoryRound(database, {
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    mutationRevision,
    phase,
    inputDigest,
  });
  if (round === undefined) throw new KiokukoError('CONFLICT', 'Required advisory round was not submitted');
}

function assertDispositionCoversRound(
  operation: 'ideal_submit' | 'plan_submit' | 'finish',
  round: StoredAdvisoryRound,
  dispositions: readonly AdvisoryDisposition[],
): void {
  const expected = new Set(round.contributions.map((contribution) => contribution.slotId));
  const covered = new Set<AdvisoryDisposition['slotId']>();
  for (const [index, disposition] of dispositions.entries()) {
    if (!expected.has(disposition.slotId)) {
      throw ennoValidationError(operation, [{
        path: ['advisoryDisposition', index, 'slotId'],
        reasonCode: 'advisory_slot_missing',
        expected: { requiredSlotIds: [...expected] },
      }]);
    }
    if (covered.has(disposition.slotId)) {
      throw ennoValidationError(operation, [{
        path: ['advisoryDisposition', index, 'slotId'],
        reasonCode: 'advisory_slot_duplicate',
        expected: { requiredSlotIds: [...expected] },
      }]);
    }
    const contribution = round.contributions.find((item) => item.slotId === disposition.slotId)!;
    const compatible = contribution.outcome === 'completed'
      ? disposition.disposition === 'adopted' || disposition.disposition === 'not_adopted'
      : disposition.disposition === 'unavailable';
    if (!compatible) {
      throw ennoValidationError(operation, [{
        path: ['advisoryDisposition', index, 'disposition'],
        reasonCode: 'invalid_enum',
        expected: { allowedValues: contribution.outcome === 'completed' ? ['adopted', 'not_adopted'] : ['unavailable'] },
      }]);
    }
    covered.add(disposition.slotId);
  }
  for (const slotId of expected) {
    if (!covered.has(slotId)) {
      throw ennoValidationError(operation, [{
        path: ['advisoryDisposition'],
        reasonCode: 'advisory_slot_missing',
        expected: { requiredSlotIds: [...expected] },
      }]);
    }
  }
}

function consumeAdvisoryRoundIfPresent(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  phase: AdvisoryPhase,
  mutationRevision: number,
  context: AdvisoryContext | undefined,
  inputDigest: string | undefined,
  disposition: readonly AdvisoryDisposition[] | undefined,
): StoredAdvisoryRound | undefined {
  if (inputDigest === undefined) {
    const submitted = readSubmittedAdvisoryRound(database, {
      runId: snapshot.runId,
      contractRevision: snapshot.revision,
      mutationRevision,
      phase,
    });
    if (submitted !== undefined) {
      throw ennoValidationError(
        phase === 'planning' ? 'plan_submit' : phase === 'ideal' ? 'ideal_submit' : 'finish',
        [{
          path: ['advisoryRoundDigest'],
          reasonCode: 'advisory_consumption_required',
          expected: { requiredSlotIds: submitted.contributions.map((item) => item.slotId) },
        }],
      );
    }
    return undefined;
  }
  if (context === undefined) {
    throw new KiokukoError('CONFLICT', 'Advisory round is not valid for the current Enno phase');
  }
  const operation = phase === 'planning' ? 'plan_submit' : phase === 'ideal' ? 'ideal_submit' : 'finish';
  assertAdvisoryRoundInput(snapshot, phase, mutationRevision, context, inputDigest, operation);
  const dispositions = disposition ?? [];
  if (dispositions.length === 0) {
    throw ennoValidationError(
      phase === 'planning' ? 'plan_submit' : phase === 'ideal' ? 'ideal_submit' : 'finish',
      [{
        path: ['advisoryDisposition'],
        reasonCode: 'advisory_digest_requires_disposition',
      }],
    );
  }
  const pendingRound = readAdvisoryRound(database, {
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    mutationRevision,
    phase,
    inputDigest,
  });
  if (pendingRound === undefined) throw new KiokukoError('CONFLICT', 'Required advisory round was not submitted');
  assertDispositionCoversRound(operation, pendingRound, dispositions);
  const round = ensureAdvisoryRoundConsumedInTransaction(database, {
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    mutationRevision,
    phase,
    inputDigest,
  });
  appendEnnoEventInTransaction(database, snapshot.runId, 'enno.advice_disposition', 'enno-oduno', 'recorded', {
    phase,
    contractRevision: snapshot.revision,
    mutationRevision,
    inputDigest,
    dispositions: dispositions.map((entry) => ({ slotId: entry.slotId, disposition: entry.disposition, rationale: entry.rationale })),
  });
  return round;
}

export function submitEnnoAdvice(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoOperationResponse {
  const parsedInput = parseAdviceSubmission(rawInput);
  const input = {
    ...parsedInput,
    contributions: normalizeAdvisoryContributions(parsedInput.phase, parsedInput.contributions as AdvisoryContribution[]),
  };
  const before = readEnnoSnapshot(database, identity(database, input));
  const operation = operationIdentity('advice_submit', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const expectedPhase = advisoryPhaseForStatus(before.status);
  if (expectedPhase !== input.phase) throw new KiokukoError('CONFLICT', 'Advisory phase does not match the current Enno state');
  const context = input.allowlistedContext as AdvisoryContext;
  const inputDigest = advisoryInputDigest({
    phase: input.phase,
    contractRevision: before.revision,
    mutationRevision: input.mutationRevision,
    allowlistedContext: context,
  });
  return withImmediateTransaction(database, () => {
    const replayed = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
    if (replayed !== undefined) return replayed;
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, [
      input.phase === 'ideal' ? 'oduno_ideal' : input.phase === 'planning' ? 'zenki_planning' : 'enno_verifying',
    ]);
    assertAdvisoryRoundInput(current, input.phase, input.mutationRevision, context, inputDigest);
    const operationOwner = startOperationInTransaction(database, input.runId, operation);
    const existing = readAdvisoryRound(database, {
      runId: input.runId,
      contractRevision: current.revision,
      mutationRevision: input.mutationRevision,
      phase: input.phase,
      inputDigest,
    });
    let round: StoredAdvisoryRound;
    if (existing !== undefined) {
      const incoming = normalizeAdvisoryContributions(input.phase, input.contributions as AdvisoryContribution[]);
      if (canonicalJson(existing.contributions) !== canonicalJson(incoming)) {
        throw new KiokukoError('CONFLICT', 'Advisory round was already submitted with different contributions');
      }
      round = existing;
    } else {
      round = createAdvisoryRoundInTransaction(database, {
        runId: input.runId,
        contractRevision: current.revision,
        mutationRevision: input.mutationRevision,
        phase: input.phase,
        inputDigest,
        contributions: input.contributions as AdvisoryContribution[],
      });
    }
    appendEnnoEventInTransaction(database, input.runId, 'enno.advice_submitted', 'enno-oduno', 'aggregated', {
      phase: input.phase,
      contractRevision: current.revision,
      mutationRevision: input.mutationRevision,
      inputDigest,
      degraded: round.degraded,
    });
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(database, input))),
      advisoryRound: round,
    };
    completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
    return response;
  });
}

export function readPendingEnnoAdvice(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoAdviceReadResponse {
  const input = parseAdviceRead(rawInput);
  const snapshot = readEnnoSnapshot(database, identity(database, input));
  if (snapshot.revision !== input.expectedRevision) {
    throw new KiokukoError('CONFLICT', 'Enno contract revision changed');
  }
  const phase = advisoryPhaseForStatus(snapshot.status);
  if (phase === null || (phase === 'final_review' && !snapshot.finalEvidenceReady)) {
    throw new KiokukoError('CONFLICT', 'Advisory round is not valid for the current Enno phase');
  }
  if (snapshot.advisoryPhaseState?.state !== 'aggregated') {
    throw new KiokukoError('CONFLICT', 'Required advisory round is not aggregated');
  }
  if (snapshot.advisoryPhaseState.inputDigest !== input.advisoryRoundDigest) {
    throw ennoValidationError('advice_read', [{
      path: ['advisoryRoundDigest'],
      reasonCode: 'advisory_digest_stale',
    }], 'refresh_state');
  }
  const allowlistedContext = advisoryContextForSnapshot(snapshot, phase);
  const expectedDigest = advisoryInputDigest({
    phase,
    contractRevision: snapshot.revision,
    mutationRevision: snapshot.mutationRevision,
    allowlistedContext,
  });
  if (expectedDigest !== input.advisoryRoundDigest) {
    throw ennoValidationError('advice_read', [{
      path: ['advisoryRoundDigest'],
      reasonCode: 'advisory_digest_stale',
    }], 'refresh_state');
  }
  const advisoryRound = readAdvisoryRound(database, {
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    mutationRevision: snapshot.mutationRevision,
    phase,
    inputDigest: input.advisoryRoundDigest,
  });
  if (advisoryRound === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored pending advisory round is missing');
  }
  if (advisoryRound.state !== 'aggregated') {
    throw new KiokukoError('CONFLICT', 'Advisory round is no longer pending');
  }
  return {
    protocolVersion: 1,
    advisoryRound,
    allowlistedContext,
  };
}

function identity(database: SqliteDatabase, input: {
  runId: string;
  workspace?: string | undefined;
  orchestrationId?: string | undefined;
  resumeToken?: string | undefined;
}): EnnoIdentity {
  return resolveEnnoIdentity(database, input);
}

function assertExpected(snapshot: EnnoRunSnapshot, expectedRevision: number, statuses: readonly EnnoRunSnapshot['status'][]): void {
  if (snapshot.revision !== expectedRevision) throw new KiokukoError('CONFLICT', 'Enno contract revision changed');
  if (!statuses.includes(snapshot.status)) throw new KiokukoError('CONFLICT', 'Enno run is not in the required state');
}

function firstReadyUnit(snapshot: EnnoRunSnapshot): EnnoRunSnapshot['workUnits'][number] | undefined {
  const completed = new Set(snapshot.workUnits.filter((unit) => unit.status === 'completed').map((unit) => unit.workUnit.id));
  return snapshot.workUnits.find((unit) => unit.status === 'pending'
    && unit.workUnit.dependencies.every((dependency) => completed.has(dependency)));
}

function startFirstReadyUnit(database: SqliteDatabase, snapshot: EnnoRunSnapshot): EnnoExecutionLease | undefined {
  const next = firstReadyUnit(snapshot);
  if (next === undefined) {
    if (snapshot.workUnits.every((unit) => unit.status === 'completed')) return undefined;
    throw new KiokukoError('CONFLICT', 'Enno WorkPlan dependencies cannot advance');
  }
  setWorkUnitStatusInTransaction(database, {
    runId: snapshot.runId,
    contractRevision: snapshot.revision,
    workUnitId: next.workUnit.id,
    from: 'pending',
    to: 'in_progress',
  });
  appendEnnoEventInTransaction(database, snapshot.runId, 'goki.work_started', 'goki', 'started', {
    workUnitId: next.workUnit.id,
    contractRevision: snapshot.revision,
  });
  if (snapshot.clientKind === null || snapshot.clientSessionId === null) return undefined;
  return claimExecutionLeaseInTransaction(database, snapshot, next.workUnit.id, {
    clientKind: snapshot.clientKind,
    sessionId: snapshot.clientSessionId,
  });
}

function requiresConfirmation(provenance: EnnoOdunoContract['provenance']): boolean {
  return ENNO_PROVENANCE_KEYS.some((key) => provenance[key] !== 'explicit_user');
}

interface RunTaskContext {
  project: DiscoverSkillsInput['project'];
  fingerprint: DiscoverSkillsInput['fingerprint'];
  task: string;
  profile: TaskProfile;
  recommendedTags: string[];
}

async function readRunTaskContext(database: SqliteDatabase, snapshot: EnnoRunSnapshot): Promise<RunTaskContext> {
  const row = database.prepare(`
    SELECT r.repository_id AS repositoryId, ri.session_id AS sessionId
    FROM repositories AS r
    JOIN repository_locations AS l ON l.repository_id = r.repository_id
    JOIN run_intakes AS ri ON ri.run_id = ?
    WHERE r.workspace = ? AND l.canonical_root = ?
    LIMIT 1
  `).get<{ repositoryId: string; sessionId: string }>(snapshot.runId, snapshot.workspace, snapshot.repositoryRoot);
  if (row === undefined) throw new KiokukoError('CONFLICT', 'Enno repository or intake binding changed');
  const context = await getAkinatorContextService(database, {
    workspace: snapshot.workspace,
    sessionId: row.sessionId,
  });
  const project = {
    workspace: snapshot.workspace,
    repositoryRoot: snapshot.repositoryRoot,
    repositoryId: row.repositoryId,
    source: 'location' as const,
  };
  const manifest = captureProjectManifestSnapshot(project);
  return {
    project,
    fingerprint: resolveProjectFingerprint(database, project, manifest),
    task: context.session.task,
    profile: context.session.profile,
    recommendedTags: context.recommendedTags,
  };
}

function emptyDiscovery(mode: SkillDiscoverySummary['mode']): SkillDiscoverySummary {
  return { attempted: false, mode, requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] };
}

async function discoverZenkiSkills(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  plan: PlanSubmission,
  dependencies: EnnoServiceDependencies,
): Promise<SkillDiscoverySummary> {
  const intake = snapshot.contract.skillSet.intakeDiscovery;
  if (intake.mode === 'off') return emptyDiscovery(intake.mode);
  const context = await readRunTaskContext(database, snapshot);
  const attempt = {
    runId: snapshot.runId,
    phase: 'zenki' as const,
    mode: intake.mode,
    requestDigest: canonicalContentHash({
      version: 2,
      runId: snapshot.runId,
      revision: snapshot.revision,
      mode: intake.mode,
      workPlan: plan.workPlan,
      capabilities: plan.capabilities ?? null,
      skillRequirements: plan.skillRequirements,
    }),
  };
  const replay = readTaskSkillDiscoveryAttempt(database, attempt);
  if (replay !== undefined) return replay.summary;
  const claimed = claimTaskSkillDiscoveryAttempt(database, attempt, {
    queryBudget: ENNO_MAX_TOTAL_SKILL_QUERIES,
    selectionBudget: ENNO_MAX_EXTERNAL_SKILLS,
  });
  if (claimed.kind === 'replay') return claimed.summary;
  if (claimed.queryBudget === 0 || claimed.selectionBudget === 0) {
    return completeTaskSkillDiscoveryAttempt(database, attempt, emptyDiscovery(intake.mode), () => {
      assertExpected(readEnnoSnapshot(database, identity(database, plan)), plan.expectedRevision, ['zenki_planning']);
    });
  }
  try {
    const summary = await (dependencies.discoverSkills ?? discoverSkills)(database, {
      ...context,
      task: `${context.task}\n${plan.workPlan.objective}`,
      capabilities: plan.capabilities,
      mode: intake.mode,
      maxQueries: claimed.queryBudget as 1 | 2 | 3,
      maxSelectedSkills: claimed.selectionBudget as 1 | 2,
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    }, {
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
      assertBeforePersist: () => assertExpected(readEnnoSnapshot(database, identity(database, plan)), plan.expectedRevision, ['zenki_planning']),
    });
    return completeTaskSkillDiscoveryAttempt(database, attempt, summary, () => {
      assertExpected(readEnnoSnapshot(database, identity(database, plan)), plan.expectedRevision, ['zenki_planning']);
    });
  } catch (error) {
    failTaskSkillDiscoveryAttempt(database, attempt, error);
  }
}

function planChangesCode(plan: PlanSubmission, taskType: EnnoRunSnapshot['taskType']): boolean {
  return plan.workPlan.units.some((unit) => unit.routes.includes('code') || unit.routes.includes('ui'))
    || (taskType !== 'review' && plan.skillRequirements.some((skill) => skill.purposes.includes('implementation')));
}

function planHasUi(plan: PlanSubmission): boolean {
  return plan.workPlan.units.some((unit) => unit.routes.includes('ui'));
}

function assertIdealSkillCoverage(snapshot: EnnoRunSnapshot, ideal: IdealSubmission['ideal']): void {
  const expected = snapshot.contract.skillSet.intakeDiscovery.selected.map((skill) => skill.name);
  if (new Set(expected).size !== expected.length) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Akinator-discovered Skill identities are inconsistent');
  }
  const actual = ideal.skillContributions.map((contribution) => contribution.skillName);
  if (actual.length !== expected.length || expected.some((name) => !actual.includes(name))) {
    throw ennoValidationError('ideal_submit', [{
      path: ['ideal', 'skillContributions'],
      reasonCode: actual.length < expected.length ? 'too_few_items' : 'undeclared_skill',
      ...(actual.length < expected.length ? { expected: { minItems: expected.length } } : {}),
    }]);
  }
}

function planCapabilityRecoveryReason(
  database: SqliteDatabase,
  input: Pick<PlanSubmission, 'runId' | 'capabilities'>,
  workspace: string,
): PlanStartRecoveryReason | null {
  if (input.capabilities === undefined) return 'environment_information_missing';
  const run = new LedgerStore(database).readRun(input.runId, workspace);
  if (run === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Enno ledger run disappeared during plan validation');
  try {
    assertCapabilityCatalogBinding(run.metadata, input.capabilities);
    return null;
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'CONFLICT') {
      return 'environment_changed';
    }
    throw error;
  }
}

function pausePlanStartRecovery(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  reason: PlanStartRecoveryReason,
): never {
  withImmediateTransaction(database, () => {
    const updated = database.prepare(`
      UPDATE enno_contracts
      SET blocker = ?, updated_at = ?
      WHERE run_id = ? AND revision = ? AND status = 'zenki_planning'
      RETURNING run_id AS runId
    `).get<{ runId: string }>(
      planStartRecoveryBlocker(reason),
      new Date().toISOString(),
      snapshot.runId,
      snapshot.revision,
    );
    if (updated?.runId !== snapshot.runId) throw new KiokukoError('CONFLICT', 'Enno plan state changed concurrently');
  });
  throw planStartRecoveryError(reason);
}

function endedBeforeWorkBecausePlanCatalogWasLost(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  capabilities: PlanSubmission['capabilities'],
): boolean {
  if (capabilities === undefined
    || snapshot.status !== 'blocked'
    || snapshot.blocker?.startsWith('Required Skills unavailable:') !== true
    || snapshot.workUnits.length === 0
    || snapshot.workUnits.some((unit) => unit.status !== 'pending')) return false;
  const soulEntry = snapshot.contract.skillSet.entries.find((entry) => (
    entry.name.normalize('NFKC').toLowerCase() === STANDARD_SOUL_SKILL_NAME
  ));
  if (soulEntry?.required !== true || soulEntry.availability !== 'unavailable') return false;
  const catalog = normalizeCapabilityCatalog(capabilities);
  if (!catalog.skills.some((skill) => skill.name.normalize('NFKC').toLowerCase() === STANDARD_SOUL_SKILL_NAME)) {
    return false;
  }
  const run = new LedgerStore(database).readRun(snapshot.runId, snapshot.workspace);
  if (run === undefined) return false;
  try {
    assertCapabilityCatalogBinding(run.metadata, capabilities);
    return true;
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'CONFLICT') return false;
    throw error;
  }
}

export function submitOdunoIdeal(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoOperationResponse {
  const parsedInput = parseIdealSubmission(rawInput);
  const before = readEnnoSnapshot(database, identity(database, parsedInput));
  const input = sanitizeIdealSubmission(parsedInput, before.repositoryRoot);
  const operation = operationIdentity('ideal_submit', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  assertExpected(before, input.expectedRevision, ['oduno_ideal']);
  if (input.advisoryRoundDigest !== undefined) {
    requireAdvisoryRound(database, before, 'ideal', before.mutationRevision, advisoryContextForSubmission(before, 'ideal'), input.advisoryRoundDigest);
  }
  const ideal = input.ideal;
  assertIdealSkillCoverage(before, ideal);
  return withImmediateTransaction(database, () => {
    const replayed = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
    if (replayed !== undefined) return replayed;
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, ['oduno_ideal']);
    assertIdealSkillCoverage(current, ideal);
    const operationOwner = startOperationInTransaction(database, input.runId, operation);
    const advisoryRound = consumeAdvisoryRoundIfPresent(
      database,
      current,
      'ideal',
      current.mutationRevision,
      advisoryContextForSubmission(current, 'ideal'),
      input.advisoryRoundDigest,
      input.advisoryDisposition as AdvisoryDisposition[] | undefined,
    );
    updateContractInTransaction(database, current, {
      contract: current.contract,
      status: 'zenki_planning',
      confirmationState: current.confirmationState,
      ideal,
    });
    appendEnnoEventInTransaction(database, input.runId, 'oduno.ideal_derived', 'enno-oduno', 'derived', {
      contractRevision: current.revision,
      discoveredSkillCount: ideal.skillContributions.length,
      principleCount: ideal.principles.length,
      successSignalCount: ideal.successSignals.length,
    });
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(database, input))),
      ...(advisoryRound === undefined ? {} : { advisoryRound }),
    };
    completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
    return response;
  });
}

export async function submitEnnoPlan(
  database: SqliteDatabase,
  rawInput: unknown,
  dependencies: EnnoServiceDependencies = {},
): Promise<EnnoOperationResponse> {
  const parsedInput = parsePlanSubmission(rawInput);
  const current = readEnnoSnapshot(database, identity(database, parsedInput));
  const input = sanitizePlanSubmission(parsedInput, current.repositoryRoot);
  if (endedBeforeWorkBecausePlanCatalogWasLost(database, current, input.capabilities)) {
    throw planStartRecoveryError('previous_attempt_ended');
  }
  const operation = operationIdentity('plan_submit', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = current;
  assertExpected(before, input.expectedRevision, ['zenki_planning']);
  const pendingRecovery = planStartRecoveryReasonFromBlocker(before.blocker);
  if (pendingRecovery === 'environment_information_missing') {
    if (input.recoveryAction === undefined) throw planStartRecoveryError(pendingRecovery);
  } else if (pendingRecovery !== null) {
    throw planStartRecoveryError(pendingRecovery);
  } else if (input.recoveryAction !== undefined) {
    throw new KiokukoError('CONFLICT', 'Enno plan has no pending same-run recovery choice');
  }
  if (input.maxAttempts <= before.attempts) {
    throw ennoValidationError('plan_submit', [{
      path: ['maxAttempts'],
      reasonCode: 'too_few_items',
      expected: { minItems: before.attempts + 1 },
    }]);
  }
  const recoveryReason = planCapabilityRecoveryReason(database, input, before.workspace);
  if (recoveryReason !== null) pausePlanStartRecovery(database, before, recoveryReason);
  if (input.advisoryRoundDigest !== undefined) {
    requireAdvisoryRound(database, before, 'planning', before.mutationRevision, advisoryContextForSubmission(before, 'planning'), input.advisoryRoundDigest);
  }
  const includesCodeChanges = planChangesCode(input, before.taskType);
  const includesUiWork = planHasUi(input);
  assertWorkPlanExpertCoverage(input.workPlan);
  assertContractVerifierCwds(before.repositoryRoot, {
    workPlan: input.workPlan,
    finalVerifiers: input.finalVerifiers,
  });
  const zenkiDiscovery = await discoverZenkiSkills(database, before, input, dependencies);
  const requirements = completeRequiredSkillList({
    requested: input.skillRequirements,
    includesCodeChanges,
    includesUiWork,
  });
  const entries = createSkillSetEntries(database, {
    requirements,
    capabilities: input.capabilities,
    discoveries: [before.contract.skillSet.intakeDiscovery, zenkiDiscovery],
  });
  const unavailable = unavailableRequiredSkills(entries);
  const nextRevision = input.expectedRevision + 1;
  const contract = {
    revision: nextRevision,
    scope: [...input.scope],
    exclusions: [...input.exclusions],
    acceptanceCriteria: input.acceptanceCriteria.map((item) => ({ ...item })),
    workPlan: {
      objective: input.workPlan.objective,
      units: input.workPlan.units.map((unit) => ({
        ...unit,
        scope: [...unit.scope],
        dependencies: [...unit.dependencies],
        routes: [...unit.routes],
        skillNames: orderedUniqueSkillNames([
          STANDARD_SOUL_SKILL_NAME,
          ...(unit.routes.includes('code') || unit.routes.includes('ui') ? [STANDARD_FUNCTION_SKILL_NAME] : []),
          ...(unit.routes.includes('ui') ? [STANDARD_UI_SKILL_NAME] : []),
        ], unit.skillNames),
        expertRefs: unit.expertRefs.map((reference) => ({ ...reference })),
        acceptanceCriteria: [...unit.acceptanceCriteria],
        focusedVerifiers: unit.focusedVerifiers.map((verifier) => ({ ...verifier, args: [...verifier.args] })),
      })),
    },
    skillSet: {
      entries,
      intakeDiscovery: before.contract.skillSet.intakeDiscovery,
      zenkiDiscovery,
    },
    finalVerifiers: input.finalVerifiers.map((verifier) => ({ ...verifier, args: [...verifier.args] })),
    maxAttempts: input.maxAttempts,
    provenance: { ...input.provenance },
  };
  assertContractVerifierCwds(before.repositoryRoot, contract);
  const needsConfirmation = requiresConfirmation(contract.provenance);
  return withImmediateTransaction(database, () => {
    const replayed = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
    if (replayed !== undefined) return replayed;
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, ['zenki_planning']);
    const operationOwner = startOperationInTransaction(database, input.runId, operation);
    const advisoryRound = consumeAdvisoryRoundIfPresent(
      database,
      current,
      'planning',
      current.mutationRevision,
      advisoryContextForSubmission(current, 'planning'),
      input.advisoryRoundDigest,
      input.advisoryDisposition as AdvisoryDisposition[] | undefined,
    );
    const status = unavailable.length > 0
      ? 'blocked' as const
      : needsConfirmation ? 'needs_confirmation' as const : 'goki_executing' as const;
    const blocker = unavailable.length === 0
      ? null
      : `Required Skills unavailable: ${unavailable.map((skill) => skill.name).join(', ')}`;
    updateContractInTransaction(database, current, {
      contract,
      status,
      confirmationState: needsConfirmation ? 'pending' : 'not_required',
      blocker,
      planDigest: canonicalContentHash(contract.workPlan),
    });
    replaceWorkUnitsInTransaction(database, input.runId, nextRevision, contract.workPlan);
    appendEnnoEventInTransaction(database, input.runId, 'zenki.plan_created', 'zenki', 'created', {
      contractRevision: nextRevision,
      workUnitIds: contract.workPlan.units.map((unit) => unit.id),
    });
    let updated = readEnnoSnapshot(database, identity(database, input));
    let executionLease: EnnoExecutionLease | undefined;
    if (status === 'blocked') {
      appendEnnoEventInTransaction(database, input.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
        reason: blocker,
        contractRevision: nextRevision,
      });
      terminalizeLedgerRunInTransaction(database, input.runId, 'failed');
    } else if (status === 'goki_executing') {
      appendEnnoEventInTransaction(database, input.runId, 'enno.plan_confirmed', 'enno-oduno', 'not_required', {
        contractRevision: nextRevision,
      });
      executionLease = startFirstReadyUnit(database, updated);
      updated = readEnnoSnapshot(database, identity(database, input));
    }
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(updated),
      ...(advisoryRound === undefined ? {} : { advisoryRound }),
      ...(executionLease === undefined ? {} : { executionLease }),
    };
    completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
    return response;
  });
}

export function answerEnno(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoOperationResponse {
  const parsedInput = parseEnnoAnswer(rawInput);
  const before = readEnnoSnapshot(database, identity(database, parsedInput));
  const input = sanitizeEnnoAnswer(parsedInput, before.repositoryRoot);
  const operation = operationIdentity('answer', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  return withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(
      current,
      input.expectedRevision,
      input.action === 'cancel' ? ['needs_confirmation', 'zenki_planning'] : ['needs_confirmation'],
    );
    const operationOwner = startOperationInTransaction(database, input.runId, operation);
    let next: EnnoRunSnapshot;
    let executionLease: EnnoExecutionLease | undefined;
    if (input.action === 'approve') {
      updateContractInTransaction(database, current, {
        contract: current.contract,
        status: 'goki_executing',
        confirmationState: 'approved',
      });
      appendEnnoEventInTransaction(database, input.runId, 'enno.plan_confirmed', 'enno-oduno', 'approved', {
        contractRevision: current.revision,
      });
      next = readEnnoSnapshot(database, identity(database, input));
      executionLease = startFirstReadyUnit(database, next);
      next = readEnnoSnapshot(database, identity(database, input));
    } else if (input.action === 'revise') {
      const revisedContract = {
        ...current.contract,
        revision: current.revision + 1,
      };
      updateContractInTransaction(database, current, {
        contract: revisedContract,
        status: 'zenki_planning',
        confirmationState: 'revision_requested',
        blocker: input.requestedChanges ?? null,
      });
      next = readEnnoSnapshot(database, identity(database, input));
    } else {
      updateContractInTransaction(database, current, {
        contract: current.contract,
        status: 'cancelled',
        confirmationState: 'cancelled',
      });
      appendEnnoEventInTransaction(database, input.runId, 'enno.cancelled', 'enno-oduno', 'cancelled', {
        contractRevision: current.revision,
      });
      terminalizeLedgerRunInTransaction(database, input.runId, 'cancelled');
      next = readEnnoSnapshot(database, identity(database, input));
    }
    const response = {
      ennoOduno: stateForSnapshot(next),
      ...(executionLease === undefined ? {} : { executionLease }),
    };
    completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
    return response;
  });
}

function sanitizedVerifierResults(results: VerifierRunResult[], repositoryRoot: string): VerifierRunResult[] {
  return results.map((result) => {
    const sanitized = sanitizeJson({
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
    }, { workspace: repositoryRoot }).value as { stdoutPreview: string; stderrPreview: string };
    return {
      ...result,
      stdoutPreview: sanitized.stdoutPreview,
      stderrPreview: sanitized.stderrPreview,
    };
  });
}

function spawnFailedVerifierResults(verifiers: readonly VerifierSpec[]): VerifierRunResult[] {
  const emptyDigest = createHash('sha256').digest('hex');
  return verifiers.map((verifier) => ({
    verifier: { ...verifier, args: [...verifier.args] },
    status: 'spawn_failed',
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdoutPreview: '',
    stderrPreview: '',
    stdoutDigest: emptyDigest,
    stderrDigest: emptyDigest,
  }));
}

function finalReviewFeedback(
  revision: number,
  reviewSummary: string,
  results: readonly VerifierRunResult[],
): string {
  const failed = results.filter((result) => result.status !== 'passed');
  const evidence = failed.length === 0
    ? 'all final verifiers passed'
    : failed.map((result) => {
      const exit = result.exitCode === null ? '' : `,exit=${result.exitCode}`;
      return `${result.verifier.id}=${result.status}${exit}`;
    }).join('; ');
  return `Enno-Oduno review rejected contract revision ${revision}: ${reviewSummary}. Verifier evidence: ${evidence}. Zenki must revise the WorkPlan; Goki must not resume the rejected plan.`
    .slice(0, 16_384);
}

function sanitizedReviewSummary(summary: string, repositoryRoot: string): string {
  return (sanitizeJson({ summary }, { workspace: repositoryRoot }).value as { summary: string }).summary;
}

function blockedForAttemptLimit(database: SqliteDatabase, snapshot: EnnoRunSnapshot, operation: OperationIdentity): EnnoOperationResponse {
  const operationOwner = startOperationInTransaction(database, snapshot.runId, operation);
  const activeUnit = snapshot.workUnits.find((candidate) => candidate.status === 'in_progress');
  if (activeUnit !== undefined) {
    setWorkUnitStatusInTransaction(database, {
      runId: snapshot.runId,
      contractRevision: snapshot.revision,
      workUnitId: activeUnit.workUnit.id,
      from: 'in_progress',
      to: 'blocked',
      attemptCount: activeUnit.attemptCount,
      result: activeUnit.result,
    });
  }
  releaseExecutionLeaseInTransaction(database, snapshot.runId);
  updateContractInTransaction(database, snapshot, {
    contract: snapshot.contract,
    status: 'blocked',
    confirmationState: snapshot.confirmationState,
    blocker: 'Enno attempt limit reached',
  });
  appendEnnoEventInTransaction(database, snapshot.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
    reason: 'attempt_limit',
    attempts: snapshot.attempts,
  });
  terminalizeLedgerRunInTransaction(database, snapshot.runId, 'failed');
  const response = { ennoOduno: stateForSnapshot(readEnnoSnapshot(database, {
    runId: snapshot.runId,
    workspace: snapshot.workspace,
    orchestrationId: snapshot.orchestrationId,
  })) };
  completeOperationInTransaction(database, snapshot.runId, operation, operationOwner, response);
  return response;
}

export async function reportEnnoWork(
  database: SqliteDatabase,
  rawInput: unknown,
  dependencies: EnnoServiceDependencies = {},
): Promise<EnnoOperationResponse> {
  const parsedInput = parseWorkReport(rawInput);
  const initial = readEnnoSnapshot(database, identity(database, parsedInput));
  const input = sanitizeWorkReport(parsedInput, initial.repositoryRoot);
  const operation = operationIdentity('work_report', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = initial;
  assertExpected(before, input.expectedRevision, ['goki_executing']);
  const unit = before.workUnits.find((candidate) => candidate.workUnit.id === input.workUnitId);
  if (unit === undefined || unit.status !== 'in_progress') throw new KiokukoError('CONFLICT', 'Reported Enno WorkUnit is not active');
  if (before.attempts >= before.contract.maxAttempts) {
    return withImmediateTransaction(database, () => {
      const current = readEnnoSnapshot(database, identity(database, input));
      assertExpected(current, input.expectedRevision, ['goki_executing']);
      assertExecutionLeaseInTransaction(database, current, input);
      return blockedForAttemptLimit(database, current, operation);
    });
  }
  if (input.result.outcome !== 'completed') {
    return withImmediateTransaction(database, () => {
      const current = readEnnoSnapshot(database, identity(database, input));
      assertExpected(current, input.expectedRevision, ['goki_executing']);
      assertExecutionLeaseInTransaction(database, current, input);
      const operationOwner = startOperationInTransaction(database, input.runId, operation);
      const currentUnit = current.workUnits.find((candidate) => candidate.workUnit.id === input.workUnitId)!;
      const attempts = current.attempts + 1;
      const mustBlock = input.result.outcome === 'blocked' || attempts >= current.contract.maxAttempts;
      setWorkUnitStatusInTransaction(database, {
        runId: input.runId,
        contractRevision: current.revision,
        workUnitId: input.workUnitId,
        from: 'in_progress',
        to: mustBlock ? 'blocked' : 'in_progress',
        attemptCount: currentUnit.attemptCount + 1,
        result: input.result,
      });
      updateContractInTransaction(database, current, {
        contract: current.contract,
        status: mustBlock ? 'blocked' : 'goki_executing',
        confirmationState: current.confirmationState,
        attempts,
        blocker: mustBlock ? input.result.summary : null,
      });
      appendEnnoEventInTransaction(database, input.runId, 'goki.work_failed', 'goki', input.result.outcome, {
        workUnitId: input.workUnitId,
        attempt: attempts,
      });
      if (mustBlock) {
        releaseExecutionLeaseInTransaction(database, input.runId);
        appendEnnoEventInTransaction(database, input.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
          reason: input.result.summary,
        });
        terminalizeLedgerRunInTransaction(database, input.runId, 'failed');
      }
      const response = { ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(database, input))) };
      completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
      return response;
    });
  }

  let verifierRunIds: string[] = [];
  let operationOwner = '';
  const verifierLeaseMs = operationLeaseMsForVerifiers(unit.workUnit.focusedVerifiers);
  withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, ['goki_executing']);
    renewExecutionLeaseInTransaction(database, current, input, verifierLeaseMs);
    operationOwner = startOperationInTransaction(database, input.runId, operation, verifierLeaseMs);
    const currentUnit = current.workUnits.find((candidate) => candidate.workUnit.id === input.workUnitId);
    if (currentUnit === undefined || currentUnit.status !== 'in_progress') {
      throw new KiokukoError('CONFLICT', 'Reported Enno WorkUnit changed concurrently');
    }
    verifierRunIds = startVerifierRunsInTransaction(database, {
      runId: input.runId,
      workUnitId: input.workUnitId,
      revision: current.revision,
      mutationRevision: current.mutationRevision + (input.result.mutated ? 1 : 0),
      verifiers: currentUnit.workUnit.focusedVerifiers,
    });
  });
  let rawResults: VerifierRunResult[];
  try {
    rawResults = await runVerifiers(unit.workUnit.focusedVerifiers, before.repositoryRoot, dependencies);
  } catch {
    rawResults = spawnFailedVerifierResults(unit.workUnit.focusedVerifiers);
  }
  const results = sanitizedVerifierResults(rawResults, before.repositoryRoot);
  return withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, ['goki_executing']);
    assertExecutionLeaseInTransaction(database, current, input);
    finishVerifierRunsInTransaction(database, verifierRunIds, results);
    const passed = results.every((result) => result.status === 'passed');
    const unsafe = results.some((result) => result.status === 'spawn_failed');
    const attempts = current.attempts + (passed ? 0 : 1);
    const mustBlock = unsafe || (!passed && attempts >= current.contract.maxAttempts);
    const currentUnit = current.workUnits.find((candidate) => candidate.workUnit.id === input.workUnitId)!;
    setWorkUnitStatusInTransaction(database, {
      runId: input.runId,
      contractRevision: current.revision,
      workUnitId: input.workUnitId,
      from: 'in_progress',
      to: passed ? 'completed' : mustBlock ? 'blocked' : 'in_progress',
      attemptCount: currentUnit.attemptCount + 1,
      result: input.result,
    });
    updateContractInTransaction(database, current, {
      contract: current.contract,
      status: mustBlock ? 'blocked' : 'goki_executing',
      confirmationState: current.confirmationState,
      attempts,
      mutationRevision: current.mutationRevision + (input.result.mutated ? 1 : 0),
      blocker: mustBlock
        ? unsafe ? 'Focused verifier could not be started safely' : 'Focused verification failed at the attempt limit'
        : null,
    });
    appendEnnoEventInTransaction(database, input.runId, passed ? 'goki.work_completed' : 'goki.work_failed', 'goki', passed ? 'completed' : 'verification_failed', {
      workUnitId: input.workUnitId,
      mutated: input.result.mutated,
      changedPaths: input.result.changedPaths,
    });
    releaseExecutionLeaseInTransaction(database, input.runId);
    let next = readEnnoSnapshot(database, identity(database, input));
    let executionLease: EnnoExecutionLease | undefined;
    if (mustBlock) {
      appendEnnoEventInTransaction(database, input.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
        reason: unsafe ? 'spawn_failed' : 'focused_verification_failed',
      });
      terminalizeLedgerRunInTransaction(database, input.runId, 'failed');
    } else if (passed) {
      if (next.workUnits.every((candidate) => candidate.status === 'completed')) {
        updateContractInTransaction(database, next, {
          contract: next.contract,
          status: 'enno_verifying',
          confirmationState: next.confirmationState,
        });
      } else {
        executionLease = startFirstReadyUnit(database, next);
      }
      next = readEnnoSnapshot(database, identity(database, input));
    }
    const response = {
      ennoOduno: stateForSnapshot(next),
      verifierResults: results,
      ...(executionLease === undefined ? {} : { executionLease }),
    };
    completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
    return response;
  });
}

export async function prepareEnnoVerification(
  database: SqliteDatabase,
  rawInput: unknown,
  dependencies: EnnoServiceDependencies = {},
): Promise<EnnoOperationResponse> {
  const input = parseVerificationPrepare(rawInput);
  const before = readEnnoSnapshot(database, identity(database, input));
  const operation = operationIdentity('verify_prepare', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  assertExpected(before, input.expectedRevision, ['enno_verifying']);
  const preRepositoryState = captureRepositoryState(before.repositoryRoot);
  const verifierSpecDigest = canonicalContentHash(before.contract.finalVerifiers);
  if (before.attempts >= before.contract.maxAttempts) {
    return withImmediateTransaction(database, () => blockedForAttemptLimit(database, readEnnoSnapshot(database, identity(database, input)), operation));
  }
  let verifierRunIds: string[] = [];
  let operationOwner = '';
  let cachedResults: VerifierRunResult[] | undefined;
  const verifierLeaseMs = operationLeaseMsForVerifiers(before.contract.finalVerifiers);
  withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, ['enno_verifying']);
    operationOwner = startOperationInTransaction(database, input.runId, operation, verifierLeaseMs);
    cachedResults = readFreshFinalVerifierResults(database, {
      runId: input.runId,
      revision: current.revision,
      mutationRevision: current.mutationRevision,
      verifiers: current.contract.finalVerifiers,
      repositoryDigest: preRepositoryState.digest,
    });
    if (cachedResults === undefined) {
      verifierRunIds = startVerifierRunsInTransaction(database, {
        runId: input.runId,
        workUnitId: null,
        revision: current.revision,
        mutationRevision: current.mutationRevision,
        verifiers: current.contract.finalVerifiers,
        repositoryEvidence: {
          policyVersion: preRepositoryState.policyVersion,
          preDigest: preRepositoryState.digest,
          verifierSpecDigest,
        },
      });
    }
    appendEnnoEventInTransaction(database, input.runId, 'enno.verification_started', 'enno-oduno', cachedResults === undefined ? 'started' : 'reused', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      verifierIds: current.contract.finalVerifiers.map((verifier) => verifier.id),
    });
  });
  let results: VerifierRunResult[];
  if (cachedResults !== undefined) {
    results = cachedResults;
  } else {
    try {
      results = sanitizedVerifierResults(
        await runVerifiers(before.contract.finalVerifiers, before.repositoryRoot, dependencies),
        before.repositoryRoot,
      );
    } catch {
      results = spawnFailedVerifierResults(before.contract.finalVerifiers);
    }
  }
  const postRepositoryState = captureRepositoryState(before.repositoryRoot);
  const changedDuringVerification = postRepositoryState.digest !== preRepositoryState.digest
    || results.some((result) => result.changedDuringVerification === true);
  results = results.map((result) => ({
    ...result,
    repositoryStatePolicyVersion: postRepositoryState.policyVersion,
    repositoryStateDigest: postRepositoryState.digest,
    changedDuringVerification,
  }));
  return withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, ['enno_verifying']);
    if (verifierRunIds.length > 0) finishVerifierRunsInTransaction(database, verifierRunIds, results, {
      postDigest: postRepositoryState.digest,
      changedDuringVerification,
    });
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(database, input))),
      verifierResults: results,
    };
    completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
    return response;
  });
}

export async function finishEnno(
  database: SqliteDatabase,
  rawInput: unknown,
  dependencies: EnnoServiceDependencies = {},
): Promise<EnnoOperationResponse> {
  const parsedInput = parseFinishRequest(rawInput);
  const initial = readEnnoSnapshot(database, identity(database, parsedInput));
  const input = sanitizeFinishRequest(parsedInput, initial.repositoryRoot);
  const operation = operationIdentity('finish', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  const before = initial;
  assertExpected(before, input.expectedRevision, ['enno_verifying']);
  if (input.advisoryRoundDigest !== undefined) {
    if (!before.finalEvidenceReady) {
      throw ennoValidationError('finish', [{
        path: ['advisoryRoundDigest'],
        reasonCode: 'advisory_digest_stale',
      }], 'refresh_state');
    }
    requireAdvisoryRound(database, before, 'final_review', before.mutationRevision, advisoryContextForSubmission(before, 'final_review'), input.advisoryRoundDigest);
  }
  const reviewSummary = sanitizedReviewSummary(input.review.summary, before.repositoryRoot);
  if (before.attempts >= before.contract.maxAttempts) {
    return withImmediateTransaction(database, () => blockedForAttemptLimit(database, readEnnoSnapshot(database, identity(database, input)), operation));
  }
  return withImmediateTransaction(database, () => {
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, ['enno_verifying']);
    const currentRepositoryDigest = captureRepositoryState(current.repositoryRoot).digest;
    const results = readFreshFinalVerifierResults(database, {
      runId: input.runId,
      revision: current.revision,
      mutationRevision: current.mutationRevision,
      verifiers: current.contract.finalVerifiers,
      repositoryDigest: currentRepositoryDigest,
    });
    if (results === undefined) {
      throw new KiokukoError('CONFLICT', 'Final verification evidence is not prepared; call enno_verify_prepare first');
    }
    if (results.some((result) => result.repositoryStateDigest !== currentRepositoryDigest
      || result.changedDuringVerification !== false)) {
      throw new KiokukoError('CONFLICT', 'Final verification evidence is stale for the current repository state');
    }
    const advisoryRound = consumeAdvisoryRoundIfPresent(
      database,
      current,
      'final_review',
      current.mutationRevision,
      input.advisoryRoundDigest === undefined ? undefined : advisoryContextForSubmission(current, 'final_review'),
      input.advisoryRoundDigest,
      input.advisoryDisposition as AdvisoryDisposition[] | undefined,
    );
    const operationOwner = startOperationInTransaction(database, input.runId, operation);
    appendEnnoEventInTransaction(database, input.runId, 'enno.review_started', 'enno-oduno', 'started', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      requestedDecision: input.review.decision,
    });
    appendEnnoEventInTransaction(database, input.runId, 'enno.verification_started', 'enno-oduno', 'reused', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      verifierIds: current.contract.finalVerifiers.map((verifier) => verifier.id),
    });
    const passed = results.length > 0 && results.every((result) => result.status === 'passed');
    const unsafe = results.some((result) => result.status === 'spawn_failed');
    const attempts = current.attempts + 1;
    const accepted = passed && input.review.decision === 'accept';
    const mustBlock = unsafe || (!accepted && attempts >= current.contract.maxAttempts);
    const reviewFeedback = accepted || mustBlock
      ? null
      : finalReviewFeedback(current.revision, reviewSummary, results);
    const nextContract = reviewFeedback === null
      ? current.contract
      : { ...current.contract, revision: current.revision + 1 };
    const blockedReason = unsafe
      ? 'Final verifier could not be started safely'
      : input.review.decision === 'replan' && passed
        ? 'Enno review requested replanning at the attempt limit'
        : 'Final verification reached the attempt limit';
    updateContractInTransaction(database, current, {
      contract: nextContract,
      status: accepted ? 'oduno_meditation' : mustBlock ? 'blocked' : 'zenki_planning',
      confirmationState: reviewFeedback === null ? current.confirmationState : 'revision_requested',
      attempts,
      blocker: mustBlock ? blockedReason : reviewFeedback,
    });
    appendEnnoEventInTransaction(database, input.runId, passed ? 'enno.verification_passed' : 'enno.verification_failed', 'enno-oduno', passed ? 'passed' : 'failed', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      statuses: results.map((result) => ({ verifierId: result.verifier.id, status: result.status })),
    });
    let next = readEnnoSnapshot(database, identity(database, input));
    if (accepted) {
      appendEnnoEventInTransaction(database, input.runId, 'enno.review_accepted', 'enno-oduno', 'accepted', {
        contractRevision: current.revision,
        mutationRevision: current.mutationRevision,
        summary: reviewSummary,
      });
    } else if (mustBlock) {
      appendEnnoEventInTransaction(database, input.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
        reason: unsafe ? 'spawn_failed' : 'attempt_limit',
      });
      terminalizeLedgerRunInTransaction(database, input.runId, 'failed');
    } else {
      appendEnnoEventInTransaction(database, input.runId, 'enno.replan_requested', 'enno-oduno', 'requested', {
        fromContractRevision: current.revision,
        toContractRevision: next.revision,
        reason: reviewFeedback,
      });
      next = readEnnoSnapshot(database, identity(database, input));
    }
    const response: EnnoOperationResponse = {
      ennoOduno: stateForSnapshot(next),
      verifierResults: results,
      ...(advisoryRound === undefined ? {} : { advisoryRound }),
    };
    completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
    return response;
  });
}

export function submitOdunoMeditation(
  database: SqliteDatabase,
  rawInput: unknown,
): EnnoOperationResponse {
  const parsedInput = parseMeditationSubmission(rawInput);
  const before = readEnnoSnapshot(database, identity(database, parsedInput));
  const input = sanitizeMeditationSubmission(parsedInput, before.repositoryRoot);
  const operation = operationIdentity('meditation_submit', input.idempotencyKey, input);
  const replay = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
  if (replay !== undefined) return replay;
  assertExpected(before, input.expectedRevision, ['oduno_meditation']);
  if (before.ideal === null) throw new KiokukoError('INTEGRITY_ERROR', 'Oduno meditation requires a persisted ideal');
  const meditation = input.meditation;
  return withImmediateTransaction(database, () => {
    const replayed = readOperationReceipt<EnnoOperationResponse>(database, input.runId, operation);
    if (replayed !== undefined) return replayed;
    const current = readEnnoSnapshot(database, identity(database, input));
    assertExpected(current, input.expectedRevision, ['oduno_meditation']);
    if (current.ideal === null) throw new KiokukoError('INTEGRITY_ERROR', 'Oduno meditation requires a persisted ideal');
    const operationOwner = startOperationInTransaction(database, input.runId, operation);
    updateContractInTransaction(database, current, {
      contract: current.contract,
      status: 'completed',
      confirmationState: current.confirmationState,
      meditation,
    });
    appendEnnoEventInTransaction(database, input.runId, 'oduno.meditation_completed', 'enno-oduno', 'completed', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
      inspectedPathCount: meditation.inspectedPaths.length,
      deletionCandidateCount: meditation.deletionCandidates.length,
    });
    appendEnnoEventInTransaction(database, input.runId, 'enno.completed', 'enno-oduno', 'completed', {
      contractRevision: current.revision,
      mutationRevision: current.mutationRevision,
    });
    terminalizeLedgerRunInTransaction(database, input.runId, 'completed');
    const response = { ennoOduno: stateForSnapshot(readEnnoSnapshot(database, identity(database, input))) };
    completeOperationInTransaction(database, input.runId, operation, operationOwner, response);
    return response;
  });
}
