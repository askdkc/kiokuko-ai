import type { SkillDiscoverySummary } from '../skills/types.js';

export const ENNO_STATUSES = [
  'intake',
  'oduno_ideal',
  'zenki_planning',
  'needs_confirmation',
  'goki_executing',
  'enno_verifying',
  'oduno_meditation',
  'completed',
  'blocked',
  'cancelled',
] as const;
export type EnnoStatus = (typeof ENNO_STATUSES)[number];

export const ENNO_ROLES = ['enno-oduno', 'zenki', 'goki'] as const;
export type EnnoRole = (typeof ENNO_ROLES)[number];

/** Public Enno routing supports the OpenCode plugin only. */
export const ENNO_CLIENT_KINDS = ['opencode'] as const;
export type EnnoClientKind = (typeof ENNO_CLIENT_KINDS)[number];

/**
 * A harness is described by observed capabilities, not by the product name
 * used to launch it.  Keep this contract independent from Enno's client kind:
 * an adapter can be known while one or more of its capabilities remain
 * unknown.
 */
export const HARNESS_ADAPTERS = ['opencode', 'unknown'] as const;
export type HarnessAdapter = (typeof HARNESS_ADAPTERS)[number];

export const HARNESS_CONTINUATIONS = ['session_idle', 'manual'] as const;
export type HarnessContinuation = (typeof HARNESS_CONTINUATIONS)[number];

export const HARNESS_EXECUTION_LIFETIMES = [
  'process_bound',
  'task_persistent',
  'scheduled',
  'unknown',
] as const;
export type HarnessExecutionLifetime = (typeof HARNESS_EXECUTION_LIFETIMES)[number];

export const HARNESS_WORKSPACE_ISOLATIONS = ['isolated', 'shared', 'unknown'] as const;
export type HarnessWorkspaceIsolation = (typeof HARNESS_WORKSPACE_ISOLATIONS)[number];

export const HARNESS_ADVISORS = [
  'verified_isolated_readonly',
  'shared_workspace',
  'unavailable',
  'unknown',
] as const;
export type HarnessAdvisorAvailability = (typeof HARNESS_ADVISORS)[number];

export const HARNESS_APPROVALS = ['host_review', 'explicit_user', 'unavailable'] as const;
export type HarnessApprovalSurface = (typeof HARNESS_APPROVALS)[number];

export const HARNESS_TOOL_INVENTORIES = ['complete', 'partial', 'unknown'] as const;
export type HarnessToolInventory = (typeof HARNESS_TOOL_INVENTORIES)[number];

export const HARNESS_FILESYSTEMS = [
  'local_read_write',
  'local_read_only',
  'remote_persistent',
  'ephemeral',
  'none',
  'unknown',
] as const;
export type HarnessFilesystem = (typeof HARNESS_FILESYSTEMS)[number];

export const HARNESS_NETWORKS = ['open', 'allowlisted', 'none', 'unknown'] as const;
export type HarnessNetwork = (typeof HARNESS_NETWORKS)[number];

export const HARNESS_SURFACES = ['progress', 'approval', 'artifact', 'browser', 'task'] as const;
export type HarnessSurface = (typeof HARNESS_SURFACES)[number];

export interface HarnessProfile {
  profileVersion: 1;
  adapter: HarnessAdapter;
  continuation: HarnessContinuation;
  executionLifetime: HarnessExecutionLifetime;
  workspaceIsolation: HarnessWorkspaceIsolation;
  advisors: HarnessAdvisorAvailability;
  approvals: HarnessApprovalSurface;
  toolInventory: HarnessToolInventory;
  filesystem: HarnessFilesystem;
  network: HarnessNetwork;
  surfaces: HarnessSurface[];
}

export const ENNO_NEXT_ACTIONS = [
  'answer_intake',
  'submit_ideal',
  'submit_plan',
  'ask_user_confirmation',
  'execute_work_unit',
  'run_final_verification',
  'submit_final_review',
  'submit_meditation',
  'report_blocker',
  'complete',
] as const;
export type EnnoNextAction = (typeof ENNO_NEXT_ACTIONS)[number];

export const ENNO_APPLICABLE_TASK_TYPES = ['build', 'debug', 'review', 'devops'] as const;
export const ENNO_DEFAULT_MAX_ATTEMPTS = 8;
export const ENNO_MIN_ATTEMPTS = 1;
export const ENNO_MAX_ATTEMPTS = 20;
export const ENNO_MAX_TOTAL_SKILL_QUERIES = 3;
export const ENNO_MAX_EXTERNAL_SKILLS = 2;

export const ADVISORY_POLICY_VERSION = 1;
export const ADVISORY_MAX_SLOT_BYTES = 16 * 1024;
export const ADVISORY_MAX_ROUND_BYTES = 48 * 1024;
export const ADVISORY_PHASES = ['ideal', 'planning', 'final_review'] as const;
export type AdvisoryPhase = (typeof ADVISORY_PHASES)[number];
export const ADVISORY_OUTCOMES = ['completed', 'failed', 'timeout', 'unavailable'] as const;
export type AdvisoryOutcome = (typeof ADVISORY_OUTCOMES)[number];
export const ADVISORY_FAILURE_CODES = [
  'unsafe_output',
  'host_read_only_unavailable',
  'host_execution_failed',
  'host_timeout',
  'invalid_response',
] as const;
export type AdvisoryFailureCode = (typeof ADVISORY_FAILURE_CODES)[number];

export const ADVISORY_SLOT_DEFINITIONS = [
  { phase: 'ideal', slotId: 'constraint_guardian', rank: 0, role: 'Constraint guardian' },
  { phase: 'ideal', slotId: 'skill_trust_analyst', rank: 1, role: 'Skill trust analyst' },
  { phase: 'ideal', slotId: 'success_signal_critic', rank: 2, role: 'Success-signal critic' },
  { phase: 'planning', slotId: 'workunit_architect', rank: 0, role: 'WorkUnit architect' },
  { phase: 'planning', slotId: 'protocol_risk_reviewer', rank: 1, role: 'Protocol-risk reviewer' },
  { phase: 'planning', slotId: 'verification_designer', rank: 2, role: 'Verification designer' },
  { phase: 'final_review', slotId: 'acceptance_auditor', rank: 0, role: 'Acceptance auditor' },
  { phase: 'final_review', slotId: 'regression_adversary', rank: 1, role: 'Regression adversary' },
  { phase: 'final_review', slotId: 'evidence_freshness_reviewer', rank: 2, role: 'Evidence-freshness reviewer' },
] as const;
export type AdvisorySlotId = (typeof ADVISORY_SLOT_DEFINITIONS)[number]['slotId'];
export type AdvisorySource = 'host_reported';

export type AdvisoryDispositionKind = 'adopted' | 'not_adopted' | 'unavailable';

export type AdvisoryPhaseState =
  | { state: 'not_started' }
  | { state: 'fanout_requested'; slots: AdvisorySlotDirective[] }
  | {
      state: 'aggregated';
      inputDigest: string;
      requiredDispositionSlots: Array<{
        slotId: AdvisorySlotId;
        outcome: AdvisoryOutcome;
        allowedDispositions: AdvisoryDispositionKind[];
      }>;
    }
  | { state: 'consumed'; inputDigest: string };

export interface AdvisoryDisposition {
  slotId: AdvisorySlotId;
  disposition: AdvisoryDispositionKind;
  rationale: string;
}

export interface AdvisoryEvidence {
  path: string;
  statement: string;
}

export interface AdvisoryContribution {
  slotId: AdvisorySlotId;
  outcome: AdvisoryOutcome;
  summary?: string;
  recommendations?: string[];
  risks?: string[];
  evidence?: AdvisoryEvidence[];
  reasonCode?: AdvisoryFailureCode;
}

export interface AdvisorySkillTrust {
  name: string;
  source: 'local' | 'imported_fresh' | 'external_reference' | 'unavailable';
  required: boolean;
  trustStatus: 'available' | 'reference_only' | 'unavailable';
}

export interface AdvisoryFinalVerifierEvidence {
  id: string;
  kind: VerifierSpec['kind'];
  executable: string;
  args: string[];
  directory: string;
  timeoutMs: number;
  status: 'passed' | 'failed' | 'timeout' | 'spawn_failed';
  exitCode: number | null;
  signal: string | null;
  stdoutDigest: string;
  stderrDigest: string;
  stdoutPreview: string;
  stderrPreview: string;
  repositoryStatePolicyVersion: number | null;
  repositoryStateDigest: string | null;
}

export interface AdvisoryWorkUnitOutcome {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  routes: WorkUnitRoute[];
  status: 'completed' | 'failed' | 'blocked';
  summary: string;
  mutated: boolean;
  changedPaths: string[];
}

export interface IdealAdvisoryContext {
  phase: 'ideal';
  objective: string;
  constraints: string[];
  expectedOutcome: string;
  successSignals: string[];
  skillTrust: AdvisorySkillTrust[];
}

export interface PlanningAdvisoryContext {
  phase: 'planning';
  idealObjective: string;
  acceptanceCriteria: string[];
  planningConstraints: string[];
  skillAvailability: AdvisorySkillTrust[];
}

export interface FinalReviewAdvisoryContext {
  phase: 'final_review';
  workPlanSummary: string;
  acceptanceCriteria: AcceptanceCriterion[];
  workUnitOutcomes: AdvisoryWorkUnitOutcome[];
  changedPaths: string[];
  verifierEvidence: AdvisoryFinalVerifierEvidence[];
  freshnessMarker: string;
  evidenceSetDigest: string;
  repositoryStateDigest: string;
  evidenceFreshnessPolicyVersion: number;
}

export type AdvisoryContext =
  | IdealAdvisoryContext
  | PlanningAdvisoryContext
  | FinalReviewAdvisoryContext;

export interface AdvisorySlotDirective {
  slotId: AdvisorySlotId;
  rank: number;
  role: string;
  instructions: string;
}

export interface AdvisoryFanoutDirective {
  protocolVersion: 1;
  phase: AdvisoryPhase;
  policyVersion: number;
  readOnlyRequired: true;
  hostMustVerifyIsolation: true;
  context: AdvisoryContext;
  slots: AdvisorySlotDirective[];
}

export interface StoredAdvisoryRound {
  phase: AdvisoryPhase;
  contractRevision: number;
  mutationRevision: number;
  inputDigest: string;
  policyVersion: number;
  source: AdvisorySource;
  state: 'advice_submitted' | 'aggregated' | 'consumed';
  degraded: boolean;
  contributions: AdvisoryContribution[];
}

export type SkillPurpose = 'planning' | 'implementation' | 'ui' | 'testing' | 'review' | 'operations';
export type ContractProvenance = 'explicit_user' | 'repository_evidence' | 'inferred';
export const ENNO_PROVENANCE_KEYS = [
  'scope',
  'exclusions',
  'acceptanceCriteria',
  'workPlan',
  'skillSet',
  'finalVerifiers',
  'maxAttempts',
] as const;
export type EnnoProvenanceKey = (typeof ENNO_PROVENANCE_KEYS)[number];

export interface AcceptanceCriterion {
  id: string;
  description: string;
}

export interface VerifierSpec {
  id: string;
  kind: 'test' | 'typecheck' | 'build' | 'lint' | 'custom';
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export const WORK_UNIT_ROUTES = ['code', 'ui', 'test', 'docs', 'operations'] as const;
export type WorkUnitRoute = (typeof WORK_UNIT_ROUTES)[number];

export const WORK_UNIT_RESOURCE_ACCESS = ['read', 'write', 'quota'] as const;
export type WorkUnitResourceAccess = (typeof WORK_UNIT_RESOURCE_ACCESS)[number];

export interface WorkUnitResourceClaim {
  key: string;
  access: WorkUnitResourceAccess;
}

export const WORK_UNIT_ISOLATION_PREFERENCES = ['read_only', 'isolated_worktree', 'shared_serial'] as const;
export type WorkUnitIsolationPreference = (typeof WORK_UNIT_ISOLATION_PREFERENCES)[number];

export interface ExpertRef {
  id: string;
  reason: string;
}

export interface WorkUnit {
  id: string;
  objective: string;
  scope: string[];
  dependencies: string[];
  skillNames: string[];
  expertRefs: ExpertRef[];
  acceptanceCriteria: string[];
  focusedVerifiers: VerifierSpec[];
  routes: WorkUnitRoute[];
  /** Optional on legacy/input objects; persisted v2 plans always materialize it. */
  resourceClaims?: WorkUnitResourceClaim[] | undefined;
  /** Optional on legacy/input objects; persisted v2 plans always materialize it. */
  isolationPreference?: WorkUnitIsolationPreference | undefined;
  /** SHA-256 over the immutable WorkUnit inputs. */
  inputManifestDigest?: string | undefined;
  /** Bounded description of the result that the worker must return. */
  outputContract?: string | undefined;
}

export interface WorkPlan {
  objective: string;
  units: WorkUnit[];
}

export interface SkillSetEntry {
  name: string;
  purposes: SkillPurpose[];
  required: boolean;
  availability: 'local' | 'imported_fresh' | 'external_reference' | 'unavailable';
  referenceId: string | null;
}

export interface SkillSetSnapshot {
  entries: SkillSetEntry[];
  intakeDiscovery: SkillDiscoverySummary;
  zenkiDiscovery: SkillDiscoverySummary;
}

export interface EnnoOdunoContract {
  revision: number;
  scope: string[];
  exclusions: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  workPlan: WorkPlan;
  skillSet: SkillSetSnapshot;
  finalVerifiers: VerifierSpec[];
  maxAttempts: number;
  provenance: Record<EnnoProvenanceKey, ContractProvenance>;
}

export interface OdunoIdealSkillContribution {
  skillName: string;
  contribution: string;
}

export interface OdunoIdeal {
  objective: string;
  principles: string[];
  skillContributions: OdunoIdealSkillContribution[];
  successSignals: string[];
}

export interface OdunoDeletionCandidate {
  kind: 'test' | 'function';
  path: string;
  name: string;
  reason: string;
  evidence: string[];
}

export interface OdunoMeditation {
  summary: string;
  inspectedPaths: string[];
  deletionCandidates: OdunoDeletionCandidate[];
}

export interface PlanArtifact {
  path: string;
  digest: string;
  state: 'pending' | 'published' | 'failed';
}

export type ModelPreference = 'high_capability_planner' | 'economical_fast_worker' | 'current_model';
export type QualityState = 'normal' | 'degraded';

export interface EnnoRequestHandoff {
  sourceRole: 'enno-oduno';
  taskType: (typeof ENNO_APPLICABLE_TASK_TYPES)[number];
  objective: string;
  target: string | null;
  expected: string | null;
  constraints: string[];
  verification: string[];
  stopConditions: string[];
}

export interface EnnoHarnessDirective {
  kind: EnnoClientKind | null;
  version: string | null;
  continuation: 'session_idle_plugin' | 'unidentified';
  instructions: string[];
}

export type ConfirmationBasis = 'user' | 'repository' | 'proposal';

export type UserFacingConfirmationAction = 'approve' | 'revise' | 'cancel';

export interface UserFacingVerifier {
  category: 'test' | 'typecheck' | 'build' | 'lint' | 'custom';
  executable: string;
  arguments: string[];
  directory: string;
  timeoutMs: number;
}

export interface UserFacingSkill {
  label: string;
  basis: ConfirmationBasis;
  required: boolean;
  purposes: string[];
  referenceOnly: boolean;
}

export interface UserFacingExpertise {
  area: string;
  basis: ConfirmationBasis;
  reason: string;
}

export interface UserFacingWorkItem {
  number: number;
  summary: string;
  paths: string[];
  dependsOn: number[];
  doneWhen: string[];
  checks: UserFacingVerifier[];
  expertise: UserFacingExpertise[];
}

export interface UserFacingConfirmation {
  presentationVersion: 1;
  title: string;
  summary: { basis: ConfirmationBasis; text: string };
  scope: { basis: ConfirmationBasis; paths: string[] };
  exclusions: { basis: ConfirmationBasis; paths: string[] };
  completion: { basis: ConfirmationBasis; items: string[] };
  skills: UserFacingSkill[];
  workItems: UserFacingWorkItem[];
  finalChecks: { basis: ConfirmationBasis; checks: UserFacingVerifier[] };
  attemptLimit: { basis: ConfirmationBasis; maxAttempts: number };
  actions: [UserFacingConfirmationAction, UserFacingConfirmationAction, UserFacingConfirmationAction];
}

export interface RoleDirective {
  protocolVersion: 1;
  runId: string;
  contractRevision: number | null;
  routeEpoch: number | null;
  role: EnnoRole;
  harness: EnnoHarnessDirective;
  handoff: EnnoRequestHandoff | null;
  objective: string;
  requiredSkills: string[];
  workUnit: WorkUnit | null;
  stopConditions: string[];
  reportSchema: Record<string, unknown>;
  modelPreference: ModelPreference;
  planArtifact: PlanArtifact | null;
  qualityState: QualityState;
  advisoryRound?: AdvisoryFanoutDirective;
  userFacingConfirmation?: UserFacingConfirmation;
}

export interface EnnoOdunoState {
  applicable: boolean;
  status: EnnoStatus;
  orchestrationId: string | null;
  /** Current continuation route only; this is not authorization or run ownership. */
  clientBinding: {
    status: 'pending' | 'bound';
    clientKind: EnnoClientKind | null;
    clientVersion: string | null;
    identified: boolean;
  } | null;
  contractRevision: number | null;
  routeEpoch: number | null;
  ideal: OdunoIdeal | null;
  meditation: OdunoMeditation | null;
  currentRole: EnnoRole | null;
  directive: RoleDirective | null;
  nextAction: EnnoNextAction;
  advisoryPhaseState: AdvisoryPhaseState;
  planArtifact: PlanArtifact | null;
  qualityState: QualityState;
}

export interface EnnoExecutionLease {
  leaseToken: string;
  routeEpoch: number;
  contractRevision: number;
  mutationRevision: number;
  workUnitId: string;
  attempt: number;
  inputManifestDigest: string;
  expiresAt: string;
}

export type WorkUnitStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export interface StoredWorkUnit {
  workUnit: WorkUnit;
  status: WorkUnitStatus;
  attemptCount: number;
  result: WorkReportResult | null;
}

export interface WorkReportResult {
  outcome: 'completed' | 'failed' | 'blocked';
  summary: string;
  mutated: boolean;
  changedPaths: string[];
}

export interface EnnoFinalReview {
  decision: 'accept' | 'replan';
  summary: string;
}

export type VerifierRunStatus = 'started' | 'passed' | 'failed' | 'timeout' | 'spawn_failed' | 'abandoned';

export interface VerifierRunResult {
  verifier: VerifierSpec;
  status: Exclude<VerifierRunStatus, 'started' | 'abandoned'>;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutDigest: string;
  stderrDigest: string;
  repositoryStatePolicyVersion?: number | undefined;
  repositoryStateDigest?: string | undefined;
  changedDuringVerification?: boolean | undefined;
}

export interface EnnoRunSnapshot {
  runId: string;
  workspace: string;
  orchestrationId: string;
  clientKind: EnnoClientKind | null;
  clientVersion: string | null;
  clientSessionId: string | null;
  repositoryRoot: string;
  taskType: (typeof ENNO_APPLICABLE_TASK_TYPES)[number];
  status: EnnoStatus;
  revision: number;
  confirmationState: 'not_required' | 'pending' | 'approved' | 'revision_requested' | 'cancelled';
  attempts: number;
  mutationRevision: number;
  routeEpoch?: number | undefined;
  ideal: OdunoIdeal | null;
  meditation: OdunoMeditation | null;
  contract: EnnoOdunoContract;
  handoff: EnnoRequestHandoff;
  workUnits: StoredWorkUnit[];
  finalEvidenceReady: boolean;
  finalEvidence: VerifierRunResult[];
  blocker: string | null;
  advisoryPhaseState?: AdvisoryPhaseState | undefined;
  planArtifact?: PlanArtifact | null | undefined;
  qualityState?: QualityState | undefined;
}
