import * as z from 'zod/v4';
import { createHash, randomBytes } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { detectRepositoryRoot } from '../repository/detect-root.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { PACKAGE_VERSION } from '../package-version.js';
import { OPENCODE_HOOK_PROTOCOL_VERSION } from '../opencode/hook-protocol.js';
import { directiveForRun } from './directives.js';
import { PLAN_START_RECOVERY_BLOCKER_PREFIX } from './plan-recovery.js';
import {
  appendEnnoEventInTransaction,
  claimExecutionLeaseInTransaction,
  readEnnoSnapshot,
} from './store.js';
import {
  ENNO_CLIENT_KINDS,
  type EnnoClientKind,
  type EnnoOdunoState,
  type EnnoExecutionLease,
  type RoleDirective,
} from './types.js';

export const ENNO_ADAPTER_WARNING = 'Kiokuko Enno-Oduno adapter unavailable; allowing the client to stop.';
export type EnnoClient = EnnoClientKind;
const hookInputSchema = z.object({
  protocolVersion: z.literal(OPENCODE_HOOK_PROTOCOL_VERSION).optional(),
  packageVersion: z.string().min(1).max(100).optional(),
  session_id: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  terminalMessageId: z.string().min(1).max(256).optional(),
  cwd: z.string().min(1).max(4_096),
}).strict();

interface CandidateRow extends SqliteRow {
  runId: string;
  workspace: string;
  orchestrationId: string;
  clientKind: EnnoClient | null;
  clientVersion: string | null;
  clientSessionId: string | null;
  repositoryRoot: string;
  status: EnnoOdunoState['status'];
  routeEpoch: number;
}

export interface AdapterDecision {
  disposition: 'continue' | 'stop' | 'retry';
  code: 'continue' | 'no_active_run' | 'ambiguous_run' | 'continuation_limit' | 'adapter_unavailable';
  continue: boolean;
  runId: string | null;
  status: EnnoOdunoState['status'] | null;
  directive: RoleDirective | null;
  reason: string | null;
  warning: string | null;
  resumeToken: string | null;
  routeEpoch: number | null;
  executionLease: EnnoExecutionLease | null;
}

function exactSessionCandidates(
  database: SqliteDatabase,
  client: EnnoClient,
  sessionId: string,
  repositoryRoot: string,
): CandidateRow[] {
  return database.prepare(`
    SELECT ec.run_id AS runId, ec.workspace, ec.orchestration_session_id AS orchestrationId,
           ec.client_kind AS clientKind, ec.client_version AS clientVersion,
           ec.client_session_id AS clientSessionId,
           ec.repository_root AS repositoryRoot, ec.status, ec.route_epoch AS routeEpoch
    FROM enno_contracts AS ec
    WHERE ec.client_session_id = ?
      AND ec.client_kind = ?
      AND ec.repository_root = ?
      AND (ec.blocker IS NULL OR ec.blocker NOT LIKE ?)
      AND ec.status IN ('zenki_planning', 'goki_executing', 'enno_verifying')
  `).all<CandidateRow>(sessionId, client, repositoryRoot, `${PLAN_START_RECOVERY_BLOCKER_PREFIX}%`);
}

function repositoryCandidates(database: SqliteDatabase, repositoryRoot: string): CandidateRow[] {
  return database.prepare(`
    SELECT ec.run_id AS runId, ec.workspace, ec.orchestration_session_id AS orchestrationId,
           ec.client_kind AS clientKind, ec.client_version AS clientVersion,
           ec.client_session_id AS clientSessionId,
           ec.repository_root AS repositoryRoot, ec.status, ec.route_epoch AS routeEpoch
    FROM enno_contracts AS ec
    WHERE ec.repository_root = ?
      AND (ec.blocker IS NULL OR ec.blocker NOT LIKE ?)
      AND ec.status IN ('zenki_planning', 'goki_executing', 'enno_verifying')
  `).all<CandidateRow>(repositoryRoot, `${PLAN_START_RECOVERY_BLOCKER_PREFIX}%`);
}

type CandidateResolution =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'resolved'; candidate: CandidateRow };

function routeCandidateInTransaction(
  database: SqliteDatabase,
  candidate: CandidateRow,
  client: EnnoClient,
  sessionId: string,
): CandidateRow {
  if (candidate.clientKind === client && candidate.clientSessionId === sessionId) return candidate;
  const activeLease = database.prepare(`
    SELECT owner_client_kind AS clientKind, owner_session_id AS sessionId,
           lease_expires_at AS expiresAt
    FROM enno_execution_leases WHERE run_id = ?
  `).get<{ clientKind: EnnoClient; sessionId: string; expiresAt: string }>(candidate.runId);
  if (activeLease !== undefined && activeLease.expiresAt > new Date().toISOString()
    && (activeLease.clientKind !== client || activeLease.sessionId !== sessionId)) {
    throw new KiokukoError('CONFLICT', 'An active Enno WorkUnit lease prevents automatic rerouting');
  }
  const updated = database.prepare(`
    UPDATE enno_contracts
    SET client_kind = ?, client_version = NULL, client_session_id = ?,
        route_epoch = route_epoch + 1, updated_at = ?
    WHERE run_id = ?
      AND orchestration_session_id = ?
      AND client_kind IS ?
      AND client_version IS ?
      AND client_session_id IS ?
    RETURNING run_id AS runId, route_epoch AS routeEpoch
  `).get<{ runId: string; routeEpoch: number }>(
    client,
    sessionId,
    new Date().toISOString(),
    candidate.runId,
    candidate.orchestrationId,
    candidate.clientKind,
    candidate.clientVersion,
    candidate.clientSessionId,
  );
  if (updated?.runId !== candidate.runId) {
    throw new KiokukoError('CONFLICT', 'Enno client routing changed concurrently');
  }
  const firstBinding = candidate.clientSessionId === null;
  appendEnnoEventInTransaction(
    database,
    candidate.runId,
    firstBinding ? 'enno.client_bound' : 'enno.client_rebound',
    'enno-oduno',
    firstBinding ? 'bound' : 'rebound',
    {
      fromClientKind: candidate.clientKind,
      fromClientSessionId: candidate.clientSessionId,
      fromClientVersion: candidate.clientVersion,
      toClientKind: client,
      toClientSessionId: sessionId,
      toClientVersion: null,
    },
  );
  return {
    ...candidate,
    clientKind: client,
    clientVersion: null,
    clientSessionId: sessionId,
    routeEpoch: updated.routeEpoch,
  };
}

function resolveCandidateInTransaction(
  database: SqliteDatabase,
  client: EnnoClient,
  sessionId: string,
  repositoryRoot: string,
): CandidateResolution {
  const exact = exactSessionCandidates(database, client, sessionId, repositoryRoot);
  if (exact.length > 1) return { kind: 'ambiguous' };
  if (exact[0] !== undefined) return { kind: 'resolved', candidate: exact[0] };
  const repository = repositoryCandidates(database, repositoryRoot);
  if (repository.length === 0) return { kind: 'none' };
  if (repository.length > 1) return { kind: 'ambiguous' };
  return { kind: 'resolved', candidate: routeCandidateInTransaction(database, repository[0]!, client, sessionId) };
}

function continuationPrompt(
  directive: RoleDirective,
  resumeToken: string,
  routeEpoch: number,
  executionLease: EnnoExecutionLease | null,
): string {
  return `Enno-Oduno requires continuation. Follow this run-bound role directive exactly and do not claim completion early. Use the supplied resumeToken and routeEpoch for the next Enno operation; do not reuse credentials from an older route:\n${JSON.stringify({ resumeToken, routeEpoch, executionLease, directive })}`;
}

function issueResumeTokenInTransaction(
  database: SqliteDatabase,
  snapshot: ReturnType<typeof readEnnoSnapshot>,
): string {
  if (snapshot.clientKind === null || snapshot.clientSessionId === null) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Enno resume token requires a bound client route');
  }
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  database.prepare('DELETE FROM enno_resume_tokens WHERE expires_at <= ?').run(now.toISOString());
  database.prepare(`
    INSERT INTO enno_resume_tokens (
      token_hash, run_id, repository_root, route_epoch, client_kind,
      client_session_id, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createHash('sha256').update(token, 'utf8').digest('hex'),
    snapshot.runId,
    snapshot.repositoryRoot,
    snapshot.routeEpoch ?? 0,
    snapshot.clientKind,
    snapshot.clientSessionId,
    expiresAt,
    now.toISOString(),
  );
  return token;
}

function claimContinuation(
  database: SqliteDatabase,
  client: EnnoClient,
  snapshot: ReturnType<typeof readEnnoSnapshot>,
  directiveDigest: string,
  terminalMessageId: string,
): { allowed: boolean; replayed: boolean } {
  if (snapshot.clientSessionId === null || snapshot.clientKind !== client) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Enno continuation requires the current client route');
  }
  const sourceTerminalHash = createHash('sha256')
    .update('kiokuko-opencode-terminal-v1\0', 'utf8')
    .update(snapshot.clientSessionId, 'utf8')
    .update('\0', 'utf8')
    .update(terminalMessageId, 'utf8')
    .digest('hex');
  const existing = database.prepare(`
    SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision,
           attempts, directive_digest AS directiveDigest, route_epoch AS routeEpoch
    FROM enno_opencode_continuation_receipts
    WHERE run_id = ? AND client_kind = ? AND source_session_id = ? AND source_terminal_hash = ?
  `).get<{
    contractRevision: number;
    mutationRevision: number;
    attempts: number;
    directiveDigest: string;
    routeEpoch: number;
  }>(
    snapshot.runId,
    client,
    snapshot.clientSessionId,
    sourceTerminalHash,
  );
  const aggregate = database.prepare(`
    SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision,
           attempts, directive_digest AS directiveDigest,
           continuation_count AS continuationCount, total_count AS totalCount
    FROM enno_opencode_continuations
    WHERE run_id = ? AND client_kind = ? AND source_session_id = ?
  `).get<{
    contractRevision: number;
    mutationRevision: number;
    attempts: number;
    directiveDigest: string;
    continuationCount: number;
    totalCount: number;
  }>(snapshot.runId, client, snapshot.clientSessionId);
  const unchanged = existing?.contractRevision === snapshot.revision
    && existing.mutationRevision === snapshot.mutationRevision
    && existing.attempts === snapshot.attempts
    && existing.directiveDigest === directiveDigest
    && existing.routeEpoch === (snapshot.routeEpoch ?? 0);
  if (existing !== undefined && !unchanged) {
    throw new KiokukoError('INTEGRITY_ERROR', 'OpenCode terminal receipt was reused for a different Enno state');
  }
  if (unchanged) return { allowed: true, replayed: true };

  const receiptCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM enno_opencode_continuation_receipts
    WHERE run_id = ? AND client_kind = ? AND source_session_id = ?
      AND contract_revision = ? AND mutation_revision = ? AND attempts = ? AND directive_digest = ?
  `).get<{ count: number }>(
    snapshot.runId,
    client,
    snapshot.clientSessionId,
    snapshot.revision,
    snapshot.mutationRevision,
    snapshot.attempts,
    directiveDigest,
  )?.count ?? 0);
  const receiptTotalCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM enno_opencode_continuation_receipts
    WHERE run_id = ? AND client_kind = ? AND source_session_id = ?
  `).get<{ count: number }>(snapshot.runId, client, snapshot.clientSessionId)?.count ?? 0);
  const aggregateUnchanged = aggregate?.contractRevision === snapshot.revision
    && aggregate.mutationRevision === snapshot.mutationRevision
    && aggregate.attempts === snapshot.attempts
    && aggregate.directiveDigest === directiveDigest;
  const count = Math.max(receiptCount, aggregateUnchanged ? aggregate.continuationCount : 0);
  const totalCount = Math.max(receiptTotalCount, aggregate?.totalCount ?? 0);
  const remaining = Math.max(0, snapshot.contract.maxAttempts - snapshot.attempts);
  const totalLimit = snapshot.contract.maxAttempts;
  if (count >= remaining || totalCount >= totalLimit) return { allowed: false, replayed: false };
  database.prepare(`
    INSERT INTO enno_opencode_continuation_receipts (
      run_id, client_kind, source_session_id, source_terminal_hash,
      contract_revision, mutation_revision, attempts, directive_digest, route_epoch, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.runId,
    client,
    snapshot.clientSessionId,
    sourceTerminalHash,
    snapshot.revision,
    snapshot.mutationRevision,
    snapshot.attempts,
    directiveDigest,
    snapshot.routeEpoch ?? 0,
    new Date().toISOString(),
  );
  database.prepare(`
    INSERT INTO enno_opencode_continuations (
      run_id, client_kind, source_session_id, contract_revision, mutation_revision,
      attempts, directive_digest, continuation_count, total_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
    ON CONFLICT(run_id, client_kind, source_session_id) DO UPDATE SET
      contract_revision = excluded.contract_revision,
      mutation_revision = excluded.mutation_revision,
      attempts = excluded.attempts,
      directive_digest = excluded.directive_digest,
      continuation_count = CASE
        WHEN enno_opencode_continuations.contract_revision = excluded.contract_revision
         AND enno_opencode_continuations.mutation_revision = excluded.mutation_revision
         AND enno_opencode_continuations.attempts = excluded.attempts
         AND enno_opencode_continuations.directive_digest = excluded.directive_digest
        THEN enno_opencode_continuations.continuation_count + 1
        ELSE 1
      END,
      total_count = enno_opencode_continuations.total_count + 1,
      updated_at = excluded.updated_at
  `).run(
    snapshot.runId,
    client,
    snapshot.clientSessionId,
    snapshot.revision,
    snapshot.mutationRevision,
    snapshot.attempts,
    directiveDigest,
    new Date().toISOString(),
  );
  return { allowed: true, replayed: false };
}

export function decideAdapterContinuation(database: SqliteDatabase, client: string, rawInput: unknown): AdapterDecision {
  if (!ENNO_CLIENT_KINDS.includes(client as EnnoClientKind)) {
    throw new KiokukoError('UNSUPPORTED_CLIENT', 'Only the OpenCode adapter is supported');
  }
  const supportedClient = client as EnnoClient;
  const parsed = hookInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Enno client hook input is invalid');
  if (parsed.data.packageVersion !== undefined && parsed.data.packageVersion !== PACKAGE_VERSION) {
    throw new KiokukoError('CONFLICT', 'Enno client hook package version does not match');
  }
  const sessionId = parsed.data.session_id ?? parsed.data.sessionId;
  if (sessionId === undefined) throw new KiokukoError('VALIDATION_ERROR', 'Enno client session ID is required');
  const repositoryRoot = detectRepositoryRoot({ cwd: parsed.data.cwd }).root;
  const continuation = withImmediateTransaction(database, () => {
    const resolution = resolveCandidateInTransaction(database, supportedClient, sessionId, repositoryRoot);
    if (resolution.kind !== 'resolved') return resolution;
    const candidate = resolution.candidate;
    const snapshot = readEnnoSnapshot(database, {
      runId: candidate.runId,
      workspace: candidate.workspace,
      orchestrationId: candidate.orchestrationId,
    });
    if (snapshot.clientKind !== supportedClient || snapshot.clientSessionId !== sessionId) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Enno client routing is inconsistent');
    }
    const directive = directiveForRun(snapshot);
    if (directive === null) throw new KiokukoError('INTEGRITY_ERROR', 'Enno active run has no role directive');
    const directiveDigest = canonicalContentHash(directive);
    const terminalMessageId = parsed.data.terminalMessageId
      ?? `legacy-${snapshot.revision}-${snapshot.mutationRevision}-${snapshot.attempts}-${directiveDigest}`;
    const receipt = claimContinuation(database, supportedClient, snapshot, directiveDigest, terminalMessageId);
    const resumeToken = receipt.allowed ? issueResumeTokenInTransaction(database, snapshot) : null;
    const executionLease = receipt.allowed && directive.role === 'goki' && directive.workUnit !== null
      ? claimExecutionLeaseInTransaction(database, snapshot, directive.workUnit.id, { clientKind: supportedClient, sessionId })
      : null;
    return { kind: 'continuation', snapshot, directive, claimed: receipt.allowed, replayed: receipt.replayed, resumeToken, executionLease } as const;
  });
  if (continuation.kind === 'none') {
    return {
      disposition: 'stop',
      code: 'no_active_run',
      continue: false,
      runId: null,
      status: null,
      directive: null,
      reason: null,
      warning: null,
      resumeToken: null,
      routeEpoch: null,
      executionLease: null,
    };
  }
  if (continuation.kind === 'ambiguous') {
    return {
      disposition: 'stop',
      code: 'ambiguous_run',
      continue: false,
      runId: null,
      status: null,
      directive: null,
      reason: null,
      warning: 'Multiple Enno-Oduno runs match this client and repository; returning control without guessing.',
      resumeToken: null,
      routeEpoch: null,
      executionLease: null,
    };
  }
  const { snapshot } = continuation;
  if (!continuation.claimed) {
    return {
      disposition: 'stop',
      code: 'continuation_limit',
      continue: false,
      runId: snapshot.runId,
      status: snapshot.status,
      directive: null,
      reason: null,
      warning: 'Enno-Oduno continuation limit reached for this client session; the run remains active for another local project client.',
      resumeToken: null,
      routeEpoch: snapshot.routeEpoch ?? 0,
      executionLease: null,
    };
  }
  return {
    disposition: 'continue',
    code: 'continue',
    continue: true,
    runId: snapshot.runId,
    status: snapshot.status,
    directive: continuation.directive,
    reason: continuationPrompt(
      continuation.directive,
      continuation.resumeToken!,
      snapshot.routeEpoch ?? 0,
      continuation.executionLease,
    ),
    warning: null,
    resumeToken: continuation.resumeToken,
    routeEpoch: snapshot.routeEpoch ?? 0,
    executionLease: continuation.executionLease,
  };
}

export function renderStopHookDecision(decision: AdapterDecision): object {
  return decision.continue && decision.reason !== null
    ? { decision: 'block', reason: decision.reason }
    : decision.warning === null ? {} : { systemMessage: decision.warning };
}

export function renderOpenCodeDecision(decision: AdapterDecision): object {
  return {
    protocolVersion: OPENCODE_HOOK_PROTOCOL_VERSION,
    packageVersion: PACKAGE_VERSION,
    ...decision,
  };
}

export function failOpenAdapterOutput(
  client: EnnoClient,
  code: 'adapter_unavailable' | 'invalid_response' | 'version_mismatch' = 'adapter_unavailable',
): object {
  return client === 'opencode'
    ? {
      protocolVersion: OPENCODE_HOOK_PROTOCOL_VERSION,
      packageVersion: PACKAGE_VERSION,
      disposition: code === 'adapter_unavailable' ? 'retry' : 'stop',
      code,
      continue: false,
      runId: null,
      status: null,
      directive: null,
      reason: null,
      warning: code === 'adapter_unavailable' ? ENNO_ADAPTER_WARNING : null,
      resumeToken: null,
      routeEpoch: null,
      executionLease: null,
    }
    : {
      protocolVersion: OPENCODE_HOOK_PROTOCOL_VERSION,
      packageVersion: PACKAGE_VERSION,
      disposition: 'retry',
      code: 'adapter_unavailable',
      continue: false,
      runId: null,
      status: null,
      directive: null,
      reason: null,
      warning: ENNO_ADAPTER_WARNING,
      resumeToken: null,
      routeEpoch: null,
      executionLease: null,
    };
}
