import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import type { JsonValue, LedgerEventInput } from '../ledger/types.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { parseStrictJson } from '../setup/strict-json.js';
import {
  parseEnnoContract,
  parseEnnoRequestHandoff,
  parseOdunoIdeal,
  parseOdunoMeditation,
  parseVerifierSpec,
  parseWorkReportResult,
  parseWorkPlan,
} from './schemas.js';
import {
  ADVISORY_OUTCOMES,
  ENNO_DEFAULT_MAX_ATTEMPTS,
  ENNO_APPLICABLE_TASK_TYPES,
  ENNO_CLIENT_KINDS,
  ENNO_STATUSES,
  type EnnoClientKind,
  type AdvisoryPhaseState,
  type EnnoOdunoContract,
  type EnnoExecutionLease,
  type EnnoRequestHandoff,
  type EnnoRunSnapshot,
  type EnnoStatus,
  type OdunoIdeal,
  type OdunoMeditation,
  type StoredWorkUnit,
  type VerifierRunResult,
  type VerifierRunStatus,
  type VerifierSpec,
  type WorkPlan,
  type WorkReportResult,
  type WorkUnitStatus,
} from './types.js';
import {
  advisoryContextForSnapshot,
  advisoryInputDigest,
  advisoryPhaseForStatus,
  advisorySlotDefinitions,
} from './advisory.js';
import type { SkillDiscoveryMode, SkillDiscoverySummary } from '../skills/types.js';
import { captureRepositoryState } from './repository-state.js';

interface ContractRow extends SqliteRow {
  run_id: string;
  workspace: string;
  orchestration_session_id: string;
  client_kind: EnnoClientKind | null;
  client_version: string | null;
  client_session_id: string | null;
  repository_root: string;
  task_type: EnnoRunSnapshot['taskType'];
  status: string;
  phase: string | null;
  revision: number;
  confirmation_state: EnnoRunSnapshot['confirmationState'];
  attempts: number;
  mutation_revision: number;
  route_epoch: number;
  contract_json: string;
  handoff_json: string;
  ideal_json: string | null;
  meditation_json: string | null;
  blocker: string | null;
}

interface WorkUnitRow extends SqliteRow {
  work_unit_json: string;
  status: WorkUnitStatus;
  attempt_count: number;
  result_json: string | null;
}

interface ReceiptRow extends SqliteRow {
  request_digest: string;
  state: 'started' | 'completed' | 'failed' | 'abandoned';
  response_json: string | null;
  lease_expires_at: string | null;
}

interface VerifierResultRow extends SqliteRow {
  verifier_id: string;
  verifier_json: string;
  status: VerifierRunStatus;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  stdout_preview: string;
  stderr_preview: string;
  stdout_digest: string;
  stderr_digest: string;
  repository_state_policy_version: number | null;
  pre_repository_digest: string | null;
  post_repository_digest: string | null;
  verifier_spec_digest: string | null;
  changed_during_verification: number | null;
  finished_at: string | null;
}

interface AdvisoryStateRow extends SqliteRow {
  inputDigest: string;
  state: 'advice_submitted' | 'aggregated' | 'consumed';
}

function advisoryPhaseState(
  database: SqliteDatabase,
  input: {
    runId: string;
    status: EnnoStatus;
    revision: number;
    mutationRevision: number;
    finalEvidenceReady: boolean;
    currentInputDigest: string | undefined;
  },
): AdvisoryPhaseState {
  const phase = advisoryPhaseForStatus(input.status);
  if (phase === null || (phase === 'final_review' && !input.finalEvidenceReady)) return { state: 'not_started' };
  const row = database.prepare(`
    SELECT input_digest AS inputDigest, state
    FROM enno_advisory_rounds
    WHERE run_id = ? AND contract_revision = ? AND mutation_revision = ? AND phase = ?
    ORDER BY created_at DESC, round_id DESC
    LIMIT 1
  `).get<AdvisoryStateRow>(input.runId, input.revision, input.mutationRevision, phase);
  if (row === undefined || row.inputDigest !== input.currentInputDigest) {
    return { state: 'fanout_requested', slots: advisorySlotDefinitions(phase) };
  }
  if (row.state === 'consumed') return { state: 'consumed', inputDigest: row.inputDigest };
  if (row.state !== 'aggregated') return integrity('Stored advisory lifecycle state is invalid');
  const contributions = database.prepare(`
    SELECT c.slot_id AS slotId, c.outcome
    FROM enno_advisory_contributions AS c
    JOIN enno_advisory_rounds AS r ON r.round_id = c.round_id
    WHERE r.run_id = ? AND r.contract_revision = ? AND r.mutation_revision = ?
      AND r.phase = ? AND r.input_digest = ?
    ORDER BY c.slot_rank
  `).all<{ slotId: string; outcome: string }>(
    input.runId,
    input.revision,
    input.mutationRevision,
    phase,
    row.inputDigest,
  );
  const slots = advisorySlotDefinitions(phase);
  if (contributions.length !== slots.length) return integrity('Stored advisory lifecycle contributions are invalid');
  return {
    state: 'aggregated',
    inputDigest: row.inputDigest,
    requiredDispositionSlots: slots.map((slot, index) => {
      const contribution = contributions[index];
      if (contribution?.slotId !== slot.slotId || !ADVISORY_OUTCOMES.includes(contribution.outcome as never)) {
        return integrity('Stored advisory lifecycle contributions are invalid');
      }
      const outcome = contribution.outcome as (typeof ADVISORY_OUTCOMES)[number];
      return {
        slotId: slot.slotId,
        outcome,
        allowedDispositions: outcome === 'completed'
          ? ['adopted', 'not_adopted']
          : ['unavailable'],
      };
    }),
  };
}

export interface EnnoIdentity {
  runId: string;
  workspace: string;
  orchestrationId: string;
}

export function resolveEnnoIdentity(database: SqliteDatabase, input: {
  runId: string;
  workspace?: string | undefined;
  orchestrationId?: string | undefined;
  resumeToken?: string | undefined;
}): EnnoIdentity {
  if (input.workspace !== undefined && input.orchestrationId !== undefined && input.resumeToken === undefined) {
    return { runId: input.runId, workspace: input.workspace, orchestrationId: input.orchestrationId };
  }
  if (input.resumeToken === undefined || input.workspace !== undefined || input.orchestrationId !== undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'Enno identity requires either explicit identity or one resume token');
  }
  const tokenHash = createHash('sha256').update(input.resumeToken, 'utf8').digest('hex');
  const row = database.prepare(`
    SELECT ec.run_id AS runId, ec.workspace, ec.orchestration_session_id AS orchestrationId,
           ec.route_epoch AS routeEpoch, rt.route_epoch AS tokenRouteEpoch,
           rt.repository_root AS tokenRepositoryRoot, ec.repository_root AS repositoryRoot,
           rt.client_kind AS tokenClientKind, ec.client_kind AS clientKind,
           rt.client_session_id AS tokenClientSessionId, ec.client_session_id AS clientSessionId,
           rt.expires_at AS expiresAt
    FROM enno_resume_tokens AS rt
    JOIN enno_contracts AS ec ON ec.run_id = rt.run_id
    WHERE rt.token_hash = ? AND rt.run_id = ?
  `).get<{
    runId: string;
    workspace: string;
    orchestrationId: string;
    routeEpoch: number;
    tokenRouteEpoch: number;
    tokenRepositoryRoot: string;
    repositoryRoot: string;
    tokenClientKind: EnnoClientKind;
    clientKind: EnnoClientKind | null;
    tokenClientSessionId: string;
    clientSessionId: string | null;
    expiresAt: string;
  }>(tokenHash, input.runId);
  if (row === undefined) throw new KiokukoError('CONFLICT', 'Enno resume token is invalid or expired');
  const expiresAt = Date.parse(row.expiresAt);
  if (row.routeEpoch !== row.tokenRouteEpoch || row.repositoryRoot !== row.tokenRepositoryRoot
    || row.clientKind !== row.tokenClientKind || row.clientSessionId !== row.tokenClientSessionId
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new KiokukoError('CONFLICT', 'Enno resume token is stale');
  }
  return { runId: row.runId, workspace: row.workspace, orchestrationId: row.orchestrationId };
}

export interface OperationIdentity {
  operation: 'ideal_submit' | 'advice_submit' | 'plan_submit' | 'answer' | 'work_report' | 'finish' | 'meditation_submit' | 'verify_prepare';
  idempotencyKey: string;
  requestDigest: string;
}

const OPERATION_LEASE_MS = 6 * 60_000;
const VERIFIER_LEASE_GRACE_MS = 60_000;
const VERIFIER_TERMINATION_GRACE_MS = 1_000;

export function operationLeaseMsForVerifiers(verifiers: readonly VerifierSpec[]): number {
  const sequentialRuntime = verifiers.reduce(
    (total, verifier) => total + verifier.timeoutMs + VERIFIER_TERMINATION_GRACE_MS,
    VERIFIER_LEASE_GRACE_MS,
  );
  return Math.max(OPERATION_LEASE_MS, sequentialRuntime);
}

function integrity(message: string): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function parseCanonicalJson(value: string, message: string): unknown {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(
      value,
      { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
      message,
    );
  } catch {
    return integrity(message);
  }
  if (canonicalJson(parsed) !== value) return integrity(message);
  return parsed;
}

function contractRow(database: SqliteDatabase, runId: string): ContractRow | undefined {
  return database.prepare('SELECT * FROM enno_contracts WHERE run_id = ?').get<ContractRow>(runId);
}

function validateContractRow(row: ContractRow): void {
  if (!ENNO_STATUSES.includes(row.status as EnnoStatus)
    || !ENNO_APPLICABLE_TASK_TYPES.includes(row.task_type)
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 20
    || !Number.isSafeInteger(row.mutation_revision) || row.mutation_revision < 0
    || !Number.isSafeInteger(row.route_epoch) || row.route_epoch < 0) {
    integrity('Stored Enno run state is invalid');
  }
}

function exposedStatus(row: Pick<ContractRow, 'status' | 'phase'>): EnnoStatus {
  if (row.phase === null) return row.status as EnnoStatus;
  if (row.phase === 'oduno_ideal' && row.status === 'zenki_planning') return row.phase;
  if (row.phase === 'oduno_meditation' && row.status === 'enno_verifying') return row.phase;
  return integrity('Stored Oduno phase is inconsistent');
}

function persistedState(status: EnnoStatus): { status: string; phase: string | null } {
  if (status === 'oduno_ideal') return { status: 'zenki_planning', phase: status };
  if (status === 'oduno_meditation') return { status: 'enno_verifying', phase: status };
  return { status, phase: null };
}

function storedWorkResult(value: unknown, repositoryRoot: string): WorkReportResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return parseWorkReportResult(value);
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.changedPaths)) return parseWorkReportResult(value);
  const changedPaths = result.changedPaths.map((candidate) => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return candidate;
    const relative = path.relative(repositoryRoot, candidate);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return candidate;
    return (relative || '.').split(path.sep).join('/');
  });
  return parseWorkReportResult({ ...result, changedPaths });
}

function workUnits(database: SqliteDatabase, runId: string, revision: number, repositoryRoot: string): StoredWorkUnit[] {
  const rows = database.prepare(`
    SELECT work_unit_json, status, attempt_count, result_json
    FROM enno_work_units
    WHERE run_id = ? AND contract_revision = ?
    ORDER BY order_index
  `).all<WorkUnitRow>(runId, revision);
  if (rows.length === 0) return [];
  const parsed = parseWorkPlan({
    objective: 'stored units',
    units: rows.map((row) => parseCanonicalJson(row.work_unit_json, 'Stored Enno WorkUnit is invalid')),
  });
  return rows.map((row, index) => ({
    workUnit: parsed.units[index]!,
    status: row.status,
    attemptCount: row.attempt_count,
    result: row.result_json === null
      ? null
      : storedWorkResult(parseCanonicalJson(row.result_json, 'Stored Enno work result is invalid'), repositoryRoot),
  }));
}

function assertLedgerIdentity(database: SqliteDatabase, identity: EnnoIdentity, repositoryRoot?: string): void {
  const run = new LedgerStore(database).readRun(identity.runId, identity.workspace);
  if (run === undefined) throw new KiokukoError('NOT_FOUND', 'Enno run was not found');
  const intake = database.prepare('SELECT session_id AS sessionId FROM run_intakes WHERE run_id = ?')
    .get<{ sessionId: string }>(identity.runId);
  if (intake?.sessionId !== identity.orchestrationId) {
    throw new KiokukoError('CONFLICT', 'Enno orchestration session does not own this run');
  }
  if (repositoryRoot !== undefined && contractRow(database, identity.runId)?.repository_root !== repositoryRoot) {
    throw new KiokukoError('CONFLICT', 'Enno repository binding changed');
  }
}

export function readEnnoSnapshot(database: SqliteDatabase, identity: EnnoIdentity): EnnoRunSnapshot {
  assertLedgerIdentity(database, identity);
  const row = contractRow(database, identity.runId);
  if (row === undefined) throw new KiokukoError('NOT_FOUND', 'Enno contract was not found');
  validateContractRow(row);
  if (row.workspace !== identity.workspace || row.orchestration_session_id !== identity.orchestrationId) {
    throw new KiokukoError('CONFLICT', 'Enno run identity changed');
  }
  if ((row.client_kind !== null && !ENNO_CLIENT_KINDS.includes(row.client_kind))
    || ((row.client_version !== null || row.client_session_id !== null) && row.client_kind === null)) {
    integrity('Stored Enno client routing metadata is invalid');
  }
  const contract = parseEnnoContract(parseCanonicalJson(row.contract_json, 'Stored Enno contract is invalid'));
  const handoff = parseEnnoRequestHandoff(parseCanonicalJson(row.handoff_json, 'Stored Enno request handoff is invalid'));
  const ideal = row.ideal_json === null
    ? null
    : parseOdunoIdeal(parseCanonicalJson(row.ideal_json, 'Stored Oduno ideal is invalid'));
  const meditation = row.meditation_json === null
    ? null
    : parseOdunoMeditation(parseCanonicalJson(row.meditation_json, 'Stored Oduno meditation is invalid'));
  const status = exposedStatus(row);
  if (contract.revision !== row.revision) integrity('Stored Enno contract revision is inconsistent');
  if (handoff.taskType !== row.task_type) integrity('Stored Enno request handoff is inconsistent');
  if (status === 'oduno_ideal' && ideal !== null) integrity('Stored Oduno ideal phase is inconsistent');
  if (status === 'oduno_meditation' && (ideal === null || meditation !== null)) {
    integrity('Stored Oduno meditation phase is inconsistent');
  }
  if (meditation !== null && status !== 'completed') integrity('Stored Oduno meditation result is inconsistent');
  const currentRepositoryDigest = status === 'enno_verifying' && contract.finalVerifiers.length > 0
    ? captureRepositoryState(row.repository_root).digest
    : undefined;
  const finalEvidenceReady = contract.finalVerifiers.length > 0
    && hasFreshFinalVerifierResults(database, {
      runId: row.run_id,
      revision: row.revision,
      mutationRevision: row.mutation_revision,
      verifiers: contract.finalVerifiers,
      ...(currentRepositoryDigest === undefined ? {} : { repositoryDigest: currentRepositoryDigest }),
    });
  const finalEvidence = finalEvidenceReady
    ? readFreshFinalVerifierResults(database, {
        runId: row.run_id,
        revision: row.revision,
        mutationRevision: row.mutation_revision,
        verifiers: contract.finalVerifiers,
        ...(currentRepositoryDigest === undefined ? {} : { repositoryDigest: currentRepositoryDigest }),
      }) ?? []
    : [];
  const snapshot: EnnoRunSnapshot = {
    runId: row.run_id,
    workspace: row.workspace,
    orchestrationId: row.orchestration_session_id,
    clientKind: row.client_kind,
    clientVersion: row.client_version,
    clientSessionId: row.client_session_id,
    repositoryRoot: row.repository_root,
    taskType: row.task_type,
    status,
    revision: row.revision,
    confirmationState: row.confirmation_state,
    attempts: row.attempts,
    mutationRevision: row.mutation_revision,
    routeEpoch: row.route_epoch,
    ideal,
    meditation,
    contract,
    handoff,
    workUnits: workUnits(database, identity.runId, row.revision, row.repository_root),
    finalEvidenceReady,
    finalEvidence,
    blocker: row.blocker,
    advisoryPhaseState: { state: 'not_started' },
  };
  const advisoryPhase = advisoryPhaseForStatus(status);
  const currentInputDigest = advisoryPhase === null || (advisoryPhase === 'final_review' && !finalEvidenceReady)
    ? undefined
    : advisoryInputDigest({
        phase: advisoryPhase,
        contractRevision: row.revision,
        mutationRevision: row.mutation_revision,
        allowlistedContext: advisoryContextForSnapshot(snapshot, advisoryPhase),
      });
  snapshot.advisoryPhaseState = advisoryPhaseState(database, {
    runId: row.run_id,
    status,
    revision: row.revision,
    mutationRevision: row.mutation_revision,
    finalEvidenceReady,
    currentInputDigest,
  });
  return snapshot;
}

function emptyDiscovery(mode: SkillDiscoveryMode): SkillDiscoverySummary {
  return {
    attempted: false,
    mode,
    requirements: [],
    queries: [],
    cacheHits: 0,
    candidates: 0,
    selected: [],
    failures: [],
  };
}

export function createEnnoDraft(database: SqliteDatabase, input: EnnoIdentity & {
  repositoryRoot: string;
  taskType: EnnoRunSnapshot['taskType'];
  taskTarget: string | null;
  taskExpected: string | null;
  handoff: EnnoRequestHandoff;
  skillDiscovery: SkillDiscoverySummary;
  initialClientKind?: string;
  initialClientVersion?: string;
  initialClientSessionId?: string;
}): EnnoRunSnapshot {
  return withImmediateTransaction(database, () => {
    assertLedgerIdentity(database, input);
    const existing = contractRow(database, input.runId);
    if (existing !== undefined) return readEnnoSnapshot(database, input);
    const contract: EnnoOdunoContract = {
      revision: 1,
      scope: input.taskTarget === null ? [] : [input.taskTarget],
      exclusions: [],
      acceptanceCriteria: input.taskExpected === null ? [] : [{ id: 'task-expected', description: input.taskExpected }],
      workPlan: { objective: input.taskTarget ?? 'Plan the requested task', units: [] },
      skillSet: {
        entries: [],
        intakeDiscovery: input.skillDiscovery,
        zenkiDiscovery: emptyDiscovery(input.skillDiscovery.mode),
      },
      finalVerifiers: [],
      maxAttempts: ENNO_DEFAULT_MAX_ATTEMPTS,
      provenance: {
        scope: 'inferred',
        exclusions: 'inferred',
        acceptanceCriteria: 'inferred',
        workPlan: 'inferred',
        skillSet: 'inferred',
        finalVerifiers: 'inferred',
        maxAttempts: 'inferred',
      },
    };
    const recognizedClientKind = typeof input.initialClientKind === 'string'
      && ENNO_CLIENT_KINDS.includes(input.initialClientKind as EnnoClientKind)
      ? input.initialClientKind as EnnoClientKind
      : null;
    const clientVersion = recognizedClientKind === null ? null : input.initialClientVersion ?? null;
    const clientSessionId = recognizedClientKind === null ? null : input.initialClientSessionId ?? null;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, client_kind, client_version, client_session_id,
        repository_root, task_type, status, revision,
        confirmation_state, attempts, mutation_revision, contract_json, handoff_json,
        intake_discovery_json, plan_digest, blocker, created_at, updated_at
        , phase, ideal_json, meditation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zenki_planning', 1, 'not_required', 0, 0, ?, ?, ?, NULL, NULL, ?, ?, 'oduno_ideal', NULL, NULL)
    `).run(
      input.runId,
      input.workspace,
      input.orchestrationId,
      recognizedClientKind,
      clientVersion,
      clientSessionId,
      input.repositoryRoot,
      input.taskType,
      canonicalJson(contract),
      canonicalJson(input.handoff),
      canonicalJson(input.skillDiscovery),
      now,
      now,
    );
    appendEnnoEventInTransaction(database, input.runId, 'enno.started', 'enno-oduno', 'started', {
      contractRevision: 1,
      harnessKind: recognizedClientKind,
      clientBinding: clientSessionId === null ? 'pending' : 'bound',
    });
    return readEnnoSnapshot(database, input);
  });
}

export function appendEnnoEventInTransaction(
  database: SqliteDatabase,
  runId: string,
  eventType: LedgerEventInput['eventType'],
  actor: 'enno-oduno' | 'zenki' | 'goki',
  outcome: string,
  payload: JsonValue,
): void {
  new LedgerStore(database).appendBatchInTransaction(runId, { events: [{
    eventId: randomUUID(),
    eventType,
    actor,
    outcome,
    payload,
  }] });
}

export function updateContractInTransaction(database: SqliteDatabase, snapshot: EnnoRunSnapshot, input: {
  contract: EnnoOdunoContract;
  status: EnnoStatus;
  confirmationState: EnnoRunSnapshot['confirmationState'];
  blocker?: string | null;
  attempts?: number;
  mutationRevision?: number;
  planDigest?: string | null;
  ideal?: OdunoIdeal | null;
  meditation?: OdunoMeditation | null;
}): void {
  const nextState = persistedState(input.status);
  const currentState = persistedState(snapshot.status);
  const updated = database.prepare(`
    UPDATE enno_contracts
    SET status = ?, phase = ?, revision = ?, confirmation_state = ?, attempts = ?, mutation_revision = ?,
        contract_json = ?, ideal_json = ?, meditation_json = ?, plan_digest = ?, blocker = ?, updated_at = ?
    WHERE run_id = ? AND workspace = ? AND orchestration_session_id = ? AND revision = ?
      AND status = ? AND phase IS ?
    RETURNING run_id AS runId
  `).get<{ runId: string }>(
    nextState.status,
    nextState.phase,
    input.contract.revision,
    input.confirmationState,
    input.attempts ?? snapshot.attempts,
    input.mutationRevision ?? snapshot.mutationRevision,
    canonicalJson(input.contract),
    input.ideal === undefined
      ? snapshot.ideal === null ? null : canonicalJson(snapshot.ideal)
      : input.ideal === null ? null : canonicalJson(input.ideal),
    input.meditation === undefined
      ? snapshot.meditation === null ? null : canonicalJson(snapshot.meditation)
      : input.meditation === null ? null : canonicalJson(input.meditation),
    input.planDigest ?? null,
    input.blocker ?? null,
    new Date().toISOString(),
    snapshot.runId,
    snapshot.workspace,
    snapshot.orchestrationId,
    snapshot.revision,
    currentState.status,
    currentState.phase,
  );
  if (updated?.runId !== snapshot.runId) throw new KiokukoError('CONFLICT', 'Enno state changed concurrently');
}

export function replaceWorkUnitsInTransaction(database: SqliteDatabase, runId: string, revision: number, workPlan: WorkPlan): void {
  database.prepare('DELETE FROM enno_work_units WHERE run_id = ? AND contract_revision = ?').run(runId, revision);
  const statement = database.prepare(`
    INSERT INTO enno_work_units (
      run_id, work_unit_id, contract_revision, order_index, work_unit_json,
      status, attempt_count, result_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
  `);
  const now = new Date().toISOString();
  workPlan.units.forEach((unit, index) => {
    statement.run(runId, unit.id, revision, index, canonicalJson(unit), now, now);
  });
}

export function setWorkUnitStatusInTransaction(database: SqliteDatabase, input: {
  runId: string;
  contractRevision: number;
  workUnitId: string;
  from: WorkUnitStatus | readonly WorkUnitStatus[];
  to: WorkUnitStatus;
  attemptCount?: number;
  result?: WorkReportResult | null;
}): void {
  const from = Array.isArray(input.from) ? input.from : [input.from];
  const placeholders = from.map(() => '?').join(', ');
  const updated = database.prepare(`
    UPDATE enno_work_units
    SET status = ?,
        attempt_count = COALESCE(?, attempt_count),
        result_json = ?,
        updated_at = ?
    WHERE run_id = ? AND contract_revision = ? AND work_unit_id = ? AND status IN (${placeholders})
    RETURNING work_unit_id AS workUnitId
  `).get<{ workUnitId: string }>(
    input.to,
    input.attemptCount ?? null,
    input.result === undefined || input.result === null ? null : canonicalJson(input.result),
    new Date().toISOString(),
    input.runId,
    input.contractRevision,
    input.workUnitId,
    ...from,
  );
  if (updated?.workUnitId !== input.workUnitId) throw new KiokukoError('CONFLICT', 'Enno WorkUnit changed concurrently');
}

const EXECUTION_LEASE_MS = 15 * 60_000;

export function claimExecutionLeaseInTransaction(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  workUnitId: string,
  owner: { clientKind: EnnoClientKind; sessionId: string },
): EnnoExecutionLease {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const existing = database.prepare(`
    SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision,
           work_unit_id AS workUnitId, route_epoch AS routeEpoch,
           owner_client_kind AS ownerClientKind, owner_session_id AS ownerSessionId,
           lease_expires_at AS expiresAt
    FROM enno_execution_leases WHERE run_id = ?
  `).get<{
    contractRevision: number;
    mutationRevision: number;
    workUnitId: string;
    routeEpoch: number;
    ownerClientKind: EnnoClientKind;
    ownerSessionId: string;
    expiresAt: string;
  }>(snapshot.runId);
  if (existing !== undefined && existing.expiresAt > now
    && (existing.contractRevision !== snapshot.revision
      || existing.mutationRevision !== snapshot.mutationRevision
      || existing.workUnitId !== workUnitId
      || existing.routeEpoch !== (snapshot.routeEpoch ?? 0)
      || existing.ownerClientKind !== owner.clientKind
      || existing.ownerSessionId !== owner.sessionId)) {
    throw new KiokukoError('CONFLICT', 'Enno WorkUnit is leased to another current actor');
  }
  const leaseToken = randomUUID();
  const tokenHash = createHash('sha256').update(leaseToken, 'utf8').digest('hex');
  const expiresAt = new Date(nowDate.getTime() + EXECUTION_LEASE_MS).toISOString();
  database.prepare(`
    INSERT INTO enno_execution_leases (
      run_id, contract_revision, mutation_revision, work_unit_id, route_epoch,
      owner_client_kind, owner_session_id, lease_token_hash, lease_expires_at,
      heartbeat_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      contract_revision = excluded.contract_revision,
      mutation_revision = excluded.mutation_revision,
      work_unit_id = excluded.work_unit_id,
      route_epoch = excluded.route_epoch,
      owner_client_kind = excluded.owner_client_kind,
      owner_session_id = excluded.owner_session_id,
      lease_token_hash = excluded.lease_token_hash,
      lease_expires_at = excluded.lease_expires_at,
      heartbeat_at = excluded.heartbeat_at,
      updated_at = excluded.updated_at
  `).run(
    snapshot.runId,
    snapshot.revision,
    snapshot.mutationRevision,
    workUnitId,
    snapshot.routeEpoch ?? 0,
    owner.clientKind,
    owner.sessionId,
    tokenHash,
    expiresAt,
    now,
    now,
    now,
  );
  return {
    leaseToken,
    routeEpoch: snapshot.routeEpoch ?? 0,
    contractRevision: snapshot.revision,
    mutationRevision: snapshot.mutationRevision,
    workUnitId,
    expiresAt,
  };
}

export function assertExecutionLeaseInTransaction(database: SqliteDatabase, snapshot: EnnoRunSnapshot, input: {
  workUnitId: string;
  leaseToken?: string | undefined;
  routeEpoch?: number | undefined;
}): void {
  const row = database.prepare(`
    SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision,
           work_unit_id AS workUnitId, route_epoch AS routeEpoch,
           owner_client_kind AS ownerClientKind, owner_session_id AS ownerSessionId,
           lease_token_hash AS tokenHash, lease_expires_at AS expiresAt
    FROM enno_execution_leases WHERE run_id = ?
  `).get<{
    contractRevision: number;
    mutationRevision: number;
    workUnitId: string;
    routeEpoch: number;
    ownerClientKind: EnnoClientKind;
    ownerSessionId: string;
    tokenHash: string;
    expiresAt: string;
  }>(snapshot.runId);
  if (row === undefined) {
    if (input.leaseToken !== undefined || input.routeEpoch !== undefined) {
      throw new KiokukoError('CONFLICT', 'Enno execution lease is not active');
    }
    return;
  }
  const tokenHash = input.leaseToken === undefined
    ? null
    : createHash('sha256').update(input.leaseToken, 'utf8').digest('hex');
  if (row.expiresAt <= new Date().toISOString()
    || row.contractRevision !== snapshot.revision
    || row.mutationRevision !== snapshot.mutationRevision
    || row.workUnitId !== input.workUnitId
    || row.routeEpoch !== input.routeEpoch
    || row.routeEpoch !== (snapshot.routeEpoch ?? 0)
    || row.ownerClientKind !== snapshot.clientKind
    || row.ownerSessionId !== snapshot.clientSessionId
    || tokenHash !== row.tokenHash) {
    throw new KiokukoError('CONFLICT', 'Enno execution lease is stale or belongs to another actor');
  }
}

export function releaseExecutionLeaseInTransaction(database: SqliteDatabase, runId: string): void {
  database.prepare('DELETE FROM enno_execution_leases WHERE run_id = ?').run(runId);
}

export function renewExecutionLeaseInTransaction(
  database: SqliteDatabase,
  snapshot: EnnoRunSnapshot,
  input: { workUnitId: string; leaseToken?: string | undefined; routeEpoch?: number | undefined },
  minimumLeaseMs: number,
): void {
  assertExecutionLeaseInTransaction(database, snapshot, input);
  const existing = database.prepare('SELECT 1 AS present FROM enno_execution_leases WHERE run_id = ?')
    .get<{ present: number }>(snapshot.runId);
  if (existing === undefined) return;
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + Math.max(EXECUTION_LEASE_MS, minimumLeaseMs)).toISOString();
  const updated = database.prepare(`
    UPDATE enno_execution_leases
    SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
    WHERE run_id = ?
    RETURNING run_id AS runId
  `).get<{ runId: string }>(leaseExpiresAt, now.toISOString(), now.toISOString(), snapshot.runId);
  if (updated?.runId !== snapshot.runId) throw new KiokukoError('CONFLICT', 'Enno execution lease changed concurrently');
}

export function startVerifierRunsInTransaction(database: SqliteDatabase, input: {
  runId: string;
  workUnitId: string | null;
  revision: number;
  mutationRevision: number;
  verifiers: readonly VerifierSpec[];
  repositoryEvidence?: {
    policyVersion: number;
    preDigest: string;
    verifierSpecDigest: string;
  } | undefined;
}): string[] {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  database.prepare(`
    UPDATE enno_verifier_runs
    SET status = 'abandoned', failure_code = 'lease_expired', finished_at = ?
    WHERE run_id = ? AND status = 'started' AND lease_expires_at <= ?
  `).run(now, input.runId, now);
  const statement = database.prepare(`
    INSERT INTO enno_verifier_runs (
      verifier_run_id, run_id, work_unit_id, contract_revision, mutation_revision,
      verifier_id, verifier_json, status, owner_nonce, lease_expires_at, heartbeat_at,
      repository_state_policy_version, pre_repository_digest, verifier_spec_digest, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?)
  `);
  const leaseMs = operationLeaseMsForVerifiers(input.verifiers);
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  return input.verifiers.map((verifier) => {
    const verifierRunId = randomUUID();
    statement.run(
      verifierRunId,
      input.runId,
      input.workUnitId,
      input.revision,
      input.mutationRevision,
      verifier.id,
      canonicalJson(verifier),
      randomUUID(),
      leaseExpiresAt,
      now,
      input.repositoryEvidence?.policyVersion ?? null,
      input.repositoryEvidence?.preDigest ?? null,
      input.repositoryEvidence?.verifierSpecDigest ?? null,
      now,
    );
    return verifierRunId;
  });
}

export function finishVerifierRunsInTransaction(
  database: SqliteDatabase,
  verifierRunIds: readonly string[],
  results: readonly VerifierRunResult[],
  repositoryEvidence?: { postDigest: string; changedDuringVerification: boolean } | undefined,
): void {
  if (verifierRunIds.length !== results.length) integrity('Enno verifier result count is inconsistent');
  const finishedAt = new Date().toISOString();
  results.forEach((result, index) => {
    const verifierRunId = verifierRunIds[index];
    if (verifierRunId === undefined) integrity('Enno verifier result count is inconsistent');
    const updated = database.prepare(`
      UPDATE enno_verifier_runs
      SET status = ?, exit_code = ?, signal = ?, duration_ms = ?,
          stdout_preview = ?, stderr_preview = ?, stdout_digest = ?, stderr_digest = ?,
          post_repository_digest = ?, changed_during_verification = ?, finished_at = ?
      WHERE verifier_run_id = ? AND status = 'started'
      RETURNING verifier_run_id AS verifierRunId
    `).get<{ verifierRunId: string }>(
      result.status,
      result.exitCode,
      result.signal,
      result.durationMs,
      result.stdoutPreview,
      result.stderrPreview,
      result.stdoutDigest,
      result.stderrDigest,
      repositoryEvidence?.postDigest ?? null,
      repositoryEvidence === undefined ? null : repositoryEvidence.changedDuringVerification ? 1 : 0,
      finishedAt,
      verifierRunId,
    );
    if (updated?.verifierRunId !== verifierRunId) throw new KiokukoError('CONFLICT', 'Enno verifier state changed concurrently');
  });
}

export function readFreshFinalVerifierResults(database: SqliteDatabase, input: {
  runId: string;
  revision: number;
  mutationRevision: number;
  verifiers: readonly VerifierSpec[];
  repositoryDigest?: string | undefined;
}): VerifierRunResult[] | undefined {
  if (input.verifiers.length === 0) return undefined;
  const rows = database.prepare(`
    SELECT verifier_id, verifier_json, status, exit_code, signal, duration_ms,
           stdout_preview, stderr_preview, stdout_digest, stderr_digest,
           repository_state_policy_version, pre_repository_digest, post_repository_digest,
           verifier_spec_digest, changed_during_verification, finished_at
    FROM enno_verifier_runs
    WHERE run_id = ? AND work_unit_id IS NULL
      AND contract_revision = ? AND mutation_revision = ?
    ORDER BY verifier_id, finished_at DESC, verifier_run_id DESC
  `).all<VerifierResultRow>(input.runId, input.revision, input.mutationRevision);
  const completedRows = rows.filter((row) => row.status !== 'started' && row.status !== 'abandoned');
  const byId = new Map<string, VerifierResultRow>();
  for (const row of completedRows) if (!byId.has(row.verifier_id)) byId.set(row.verifier_id, row);
  if (byId.size !== input.verifiers.length || input.verifiers.some((verifier) => !byId.has(verifier.id))) return undefined;
  for (const verifier of input.verifiers) {
    const row = byId.get(verifier.id)!;
    const storedVerifier = parseVerifierSpec(parseCanonicalJson(row.verifier_json, 'Stored Enno verifier is invalid'));
    if (canonicalJson(storedVerifier) !== canonicalJson(verifier)) return undefined;
    if (row.changed_during_verification === 1) return undefined;
    if (input.repositoryDigest !== undefined
      && (row.pre_repository_digest !== input.repositoryDigest
        || row.post_repository_digest !== input.repositoryDigest
        || row.verifier_spec_digest !== canonicalContentHash(input.verifiers))) return undefined;
  }
  return input.verifiers.map((verifier) => {
    const row = byId.get(verifier.id)!;
    const storedVerifier = parseVerifierSpec(parseCanonicalJson(row.verifier_json, 'Stored Enno verifier is invalid'));
    return {
      verifier: { ...storedVerifier, args: [...storedVerifier.args] },
      status: row.status as Exclude<VerifierRunStatus, 'started' | 'abandoned'>,
      exitCode: row.exit_code,
      signal: row.signal,
      durationMs: row.duration_ms,
      stdoutPreview: row.stdout_preview,
      stderrPreview: row.stderr_preview,
      stdoutDigest: row.stdout_digest,
      stderrDigest: row.stderr_digest,
      ...(row.repository_state_policy_version === null ? {} : { repositoryStatePolicyVersion: row.repository_state_policy_version }),
      ...(row.post_repository_digest === null ? {} : { repositoryStateDigest: row.post_repository_digest }),
      ...(row.changed_during_verification === null ? {} : { changedDuringVerification: row.changed_during_verification === 1 }),
    };
  });
}

export function hasFreshFinalVerifierResults(database: SqliteDatabase, input: {
  runId: string;
  revision: number;
  mutationRevision: number;
  verifiers: readonly VerifierSpec[];
  repositoryDigest?: string | undefined;
}): boolean {
  try {
    return readFreshFinalVerifierResults(database, input) !== undefined;
  } catch {
    return false;
  }
}

export function readOperationReceipt<T>(database: SqliteDatabase, runId: string, operation: OperationIdentity): T | undefined {
  const row = database.prepare(`
    SELECT request_digest, state, response_json, lease_expires_at
    FROM enno_operation_receipts
    WHERE run_id = ? AND operation = ? AND idempotency_key = ?
  `).get<ReceiptRow>(runId, operation.operation, operation.idempotencyKey);
  if (row === undefined) return undefined;
  if (row.request_digest !== operation.requestDigest) {
    throw new KiokukoError('CONFLICT', 'Enno idempotency key was reused with different input');
  }
  if (row.state === 'started') {
    if (row.lease_expires_at === null || !Number.isFinite(Date.parse(row.lease_expires_at))) {
      return integrity('Stored Enno operation receipt lease is invalid');
    }
    const now = new Date().toISOString();
    if (row.lease_expires_at > now) throw new KiokukoError('CONFLICT', 'Enno operation is already in progress');
    const abandoned = database.prepare(`
      UPDATE enno_operation_receipts
      SET state = 'abandoned', failure_code = 'lease_expired', finished_at = ?
      WHERE run_id = ? AND operation = ? AND idempotency_key = ?
        AND request_digest = ? AND state = 'started' AND lease_expires_at <= ?
      RETURNING run_id AS runId
    `).get<{ runId: string }>(
      now,
      runId,
      operation.operation,
      operation.idempotencyKey,
      operation.requestDigest,
      now,
    );
    if (abandoned?.runId !== runId) throw new KiokukoError('CONFLICT', 'Enno operation state changed concurrently');
    return undefined;
  }
  if (row.state === 'failed' || row.state === 'abandoned') return undefined;
  if (row.response_json === null) integrity('Stored Enno operation receipt is invalid');
  return parseCanonicalJson(row.response_json, 'Stored Enno operation receipt is invalid') as T;
}

export function startOperationInTransaction(
  database: SqliteDatabase,
  runId: string,
  operation: OperationIdentity,
  leaseMs = OPERATION_LEASE_MS,
): string {
  const replay = readOperationReceipt<unknown>(database, runId, operation);
  if (replay !== undefined) throw new KiokukoError('CONFLICT', 'Completed Enno operation must be replayed before mutation');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < OPERATION_LEASE_MS) integrity('Enno operation lease duration is invalid');
  const nowDate = new Date();
  const now = nowDate.toISOString();
  database.prepare(`
    UPDATE enno_operation_receipts
    SET state = 'abandoned', failure_code = 'lease_expired', finished_at = ?
    WHERE run_id = ? AND state = 'started' AND lease_expires_at <= ?
  `).run(now, runId, now);
  const active = database.prepare(`
    SELECT operation FROM enno_operation_receipts
    WHERE run_id = ? AND state = 'started' AND lease_expires_at > ?
    LIMIT 1
  `).get<{ operation: string }>(runId, now);
  if (active !== undefined) throw new KiokukoError('CONFLICT', 'Another Enno operation is already in progress');
  const ownerNonce = randomUUID();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  const started = database.prepare(`
    INSERT INTO enno_operation_receipts (
      run_id, operation, idempotency_key, request_digest, state, response_json,
      owner_nonce, lease_expires_at, heartbeat_at, failure_code, created_at, finished_at
    ) VALUES (?, ?, ?, ?, 'started', NULL, ?, ?, ?, NULL, ?, NULL)
    ON CONFLICT(run_id, operation, idempotency_key) DO UPDATE SET
      state = 'started', response_json = NULL, owner_nonce = excluded.owner_nonce,
      lease_expires_at = excluded.lease_expires_at, heartbeat_at = excluded.heartbeat_at,
      failure_code = NULL, created_at = excluded.created_at, finished_at = NULL
    WHERE enno_operation_receipts.request_digest = excluded.request_digest
      AND enno_operation_receipts.state IN ('failed', 'abandoned')
    RETURNING run_id AS runId
  `).get<{ runId: string }>(
    runId,
    operation.operation,
    operation.idempotencyKey,
    operation.requestDigest,
    ownerNonce,
    leaseExpiresAt,
    now,
    now,
  );
  if (started?.runId !== runId) throw new KiokukoError('CONFLICT', 'Enno operation could not be claimed');
  return ownerNonce;
}

export function completeOperationInTransaction(
  database: SqliteDatabase,
  runId: string,
  operation: OperationIdentity,
  ownerNonce: string,
  response: unknown,
): void {
  const serialized = canonicalJson(response);
  const finishedAt = new Date().toISOString();
  const updated = database.prepare(`
    UPDATE enno_operation_receipts
    SET state = 'completed', response_json = ?, finished_at = ?
    WHERE run_id = ? AND operation = ? AND idempotency_key = ?
      AND request_digest = ? AND state = 'started' AND owner_nonce = ?
      AND lease_expires_at > ?
    RETURNING run_id AS runId
  `).get<{ runId: string }>(
    serialized,
    finishedAt,
    runId,
    operation.operation,
    operation.idempotencyKey,
    operation.requestDigest,
    ownerNonce,
    finishedAt,
  );
  if (updated?.runId !== runId) throw new KiokukoError('CONFLICT', 'Enno operation receipt changed concurrently');
}

export function terminalizeLedgerRunInTransaction(database: SqliteDatabase, runId: string, status: 'completed' | 'failed' | 'cancelled'): void {
  new LedgerStore(database).updateRunStatusInTransaction(runId, status);
}
