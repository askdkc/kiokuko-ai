import assert from 'node:assert/strict';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { withImmediateTransaction } from '../../src/db/transaction.js';
import { KiokukoError } from '../../src/errors.js';
import { decideAdapterContinuation } from '../../src/enno-oduno/adapters.js';
import { advisoryInputDigest } from '../../src/enno-oduno/advisory.js';
import { captureRepositoryState } from '../../src/enno-oduno/repository-state.js';
import { canonicalContentHash, canonicalJson } from '../../src/serialization/validate.js';
import {
  answerEnno,
  finishEnno,
  prepareEnnoVerification,
  reportEnnoWork,
  submitEnnoAdvice,
  submitEnnoPlan,
  submitOdunoIdeal,
  submitOdunoMeditation,
} from '../../src/enno-oduno/service.js';
import {
  completeOperationInTransaction,
  finishVerifierRunsInTransaction,
  readOperationReceipt,
  readEnnoSnapshot,
  replaceWorkUnitsInTransaction,
  startOperationInTransaction,
  startVerifierRunsInTransaction,
  terminalizeLedgerRunInTransaction,
  updateContractInTransaction,
} from '../../src/enno-oduno/store.js';
import { ADVISORY_SLOT_DEFINITIONS, type AdvisoryContext, type AdvisoryPhase } from '../../src/enno-oduno/types.js';
import { discoverSkills } from '../../src/skills/discovery-service.js';
import { createHash } from 'node:crypto';

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work to every applicable Kiokuko Skill.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Focused code contracts and tests.' },
  { kind: 'skill', name: 'kiokuko-ui-design-soul', description: 'UI interaction and accessibility guidance.' },
];

function advisoryContributions(phase: AdvisoryPhase) {
  return ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === phase).map((slot) => ({
    slotId: slot.slotId,
    outcome: 'completed' as const,
    summary: `Validated ${slot.slotId}`,
    recommendations: [],
    risks: [],
    evidence: [],
  }));
}

function advisoryDispositions(phase: AdvisoryPhase) {
  return ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === phase).map((slot) => ({
    slotId: slot.slotId,
    disposition: 'adopted' as const,
    rationale: `Applied ${slot.slotId}`,
  }));
}

function advisoryDigest(phase: AdvisoryPhase, contractRevision: number, mutationRevision: number, context: AdvisoryContext): string {
  return advisoryInputDigest({ phase, contractRevision, mutationRevision, allowlistedContext: context });
}

function executionCredentials(response: { executionLease?: { leaseToken: string; routeEpoch: number } | null | undefined }) {
  assert.ok(response.executionLease);
  return {
    leaseToken: response.executionLease.leaseToken,
    routeEpoch: response.executionLease.routeEpoch,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-db-'));
  const databasePath = path.join(databaseDirectory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  return { root, databasePath, database: openConnection(databasePath) };
}

function verifier(_root: string, id: string) {
  return { id, kind: 'test' as const, executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5000 };
}

function submitPreparedIdeal(
  database: ReturnType<typeof openConnection>,
  prepared: Awaited<ReturnType<typeof prepareOpenCodeTask>>,
  idempotencyKey: string,
  advisory?: {
    advisoryRoundDigest: string;
    advisoryDisposition: ReturnType<typeof advisoryDispositions>;
  },
) {
  return submitOdunoIdeal(database, {
    runId: prepared.run.runId,
    workspace: prepared.project.workspace,
    orchestrationId: prepared.intake.sessionId,
    expectedRevision: 1,
    idempotencyKey,
    ideal: {
      objective: `Reach the optimal verified outcome for ${prepared.intake.profile.target ?? 'the requested task'}`,
      principles: ['Realize the task handoff while preserving every explicit constraint'],
      skillContributions: prepared.skillDiscovery.selected.map((skill) => ({
        skillName: skill.name,
        contribution: `Use ${skill.name} as reference-only guidance when shaping the optimal outcome`,
      })),
      successSignals: [prepared.intake.profile.expected ?? 'Every acceptance criterion is verified'],
    },
    ...(advisory ?? {}),
  });
}

function submitMeditation(
  database: ReturnType<typeof openConnection>,
  identity: { runId: string; workspace: string; orchestrationId: string },
  expectedRevision: number,
  idempotencyKey: string,
  deletionCandidates: Array<{
    kind: 'test' | 'function';
    path: string;
    name: string;
    reason: string;
    evidence: string[];
  }> = [],
) {
  return submitOdunoMeditation(database, {
    ...identity,
    expectedRevision,
    idempotencyKey,
    meditation: {
      summary: 'Inspected the realized ideal for obsolete tests and functions without mutating the repository',
      inspectedPaths: ['src/add.js'],
      deletionCandidates,
    },
  });
}

async function plannedExecution(
  database: ReturnType<typeof openConnection>,
  root: string,
  requestId: string,
  finalVerifier: ReturnType<typeof verifier>,
  options: {
    maxAttempts?: number;
    focusedVerifiers?: ReturnType<typeof verifier>[];
    client?: 'opencode';
    clientVersion?: string;
    clientIdentity?: 'bound' | 'kind_only' | 'omitted';
  } = {},
) {
  const client = options.client ?? 'opencode';
  const clientVersion = options.clientVersion;
  const sessionId = `${client}-${requestId}`;
  const clientIdentity = options.clientIdentity ?? 'bound';
  const prepared = await prepareOpenCodeTask(database, {
    requestId, cwd: root, task: 'Repair the add function',
    profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
    capabilities,
    ...(clientIdentity === 'omitted' ? {} : {
      client: {
        kind: client,
        ...(clientVersion === undefined ? {} : { version: clientVersion }),
        ...(clientIdentity === 'bound' ? { sessionId } : {}),
      },
    }),
    skillDiscoveryMode: 'off',
  });
  const repositoryRoot = prepared.project.repositoryRoot;
  const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
  const idealized = submitPreparedIdeal(database, prepared, `ideal-${requestId}`);
  assert.equal(idealized.ennoOduno.status, 'zenki_planning');
  const response = await submitEnnoPlan(database, {
    ...identity, expectedRevision: 1, idempotencyKey: `plan-${requestId}`,
    scope: ['src/add.js'], exclusions: [], acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
    workPlan: { objective: 'Repair add', units: [{
      id: 'repair', objective: 'Repair add', scope: ['src/add.js'], dependencies: [], routes: ['code'], skillNames: [],
      expertRefs: [{ id: 'code.verification.v1', reason: 'Repair the reported regression with matching evidence' }],
      acceptanceCriteria: ['tests pass'], focusedVerifiers: (options.focusedVerifiers ?? []).map((item) => ({ ...item, cwd: '.' })),
    }] },
    skillRequirements: [], finalVerifiers: [{ ...finalVerifier, cwd: '.' }], maxAttempts: options.maxAttempts ?? 5,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
    capabilities,
  });
  assert.equal(response.ennoOduno.status, 'goki_executing');
  return { identity, repositoryRoot, hostSessionId: sessionId, prepared, idealized, executionLease: response.executionLease };
}

test('task_prepare derives the Oduno ideal before handing the request to harness-specific Zenki', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'pending-client-binding', verifier(root, 'pass'), {
      client: 'opencode',
      clientIdentity: 'kind_only',
    });
    assert.equal(planned.prepared.ennoOduno.status, 'oduno_ideal');
    assert.equal(planned.prepared.ennoOduno.orchestrationId, planned.prepared.intake.sessionId);
    assert.deepEqual(planned.prepared.ennoOduno.clientBinding, {
      status: 'pending',
      clientKind: 'opencode',
      clientVersion: null,
      identified: true,
    });
    assert.equal(planned.prepared.ennoOduno.directive?.role, 'enno-oduno');
    assert.equal(planned.prepared.ennoOduno.directive?.handoff?.sourceRole, 'enno-oduno');
    assert.equal(planned.prepared.ennoOduno.directive?.handoff?.taskType, 'debug');
    assert.match(planned.prepared.ennoOduno.directive?.handoff?.objective ?? '', /src\/add\.js/u);
    assert.match(planned.prepared.ennoOduno.directive?.handoff?.objective ?? '', /tests pass/u);
    assert.equal(planned.prepared.ennoOduno.directive?.harness.kind, 'opencode');
    assert.equal(planned.prepared.ennoOduno.directive?.harness.continuation, 'session_idle_plugin');
    assert.equal(planned.prepared.ennoOduno.nextAction, 'submit_ideal');
    assert.match(planned.prepared.ennoOduno.directive?.objective ?? '', /optimal goal/iu);
    assert.equal(planned.idealized.ennoOduno.status, 'zenki_planning');
    assert.equal(planned.idealized.ennoOduno.directive?.role, 'zenki');
    assert.deepEqual(planned.prepared.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-enno-oduno',
    ]);
    assert.match(planned.idealized.ennoOduno.directive?.objective ?? '', /one cohesive externally observable function or use-case contract/iu);
    assert.match(planned.idealized.ennoOduno.directive?.objective ?? '', /focused runnable test target/iu);

    const claimed = decideAdapterContinuation(database, 'opencode', {
      sessionId: planned.hostSessionId,
      cwd: root,
    });
    assert.equal(claimed.continue, true);
    assert.equal(claimed.directive?.role, 'goki');
    assert.deepEqual(claimed.directive?.requiredSkills, ['kiokuko-soul', 'kiokuko-single-purpose-functions']);
    assert.deepEqual(claimed.directive?.workUnit?.skillNames, ['kiokuko-soul', 'kiokuko-single-purpose-functions']);
    assert.deepEqual(claimed.directive?.workUnit?.expertRefs, [{
      id: 'code.verification.v1',
      reason: 'Repair the reported regression with matching evidence',
    }]);
    const binding = database.prepare(`
      SELECT client_kind AS clientKind, client_session_id AS clientSessionId
      FROM enno_contracts WHERE run_id = ?
    `).get<{ clientKind: string; clientSessionId: string }>(planned.identity.runId);
    assert.deepEqual(binding === undefined ? undefined : { ...binding }, {
      clientKind: 'opencode',
      clientSessionId: planned.hostSessionId,
    });
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type = 'enno.client_bound'
    `).get<{ count: number }>(planned.identity.runId)?.count, 1);

    assert.throws(() => decideAdapterContinuation(database, 'opencode', {
      sessionId: 'different-opencode-session',
      cwd: root,
    }), /active Enno WorkUnit lease/iu);
    assert.equal(database.prepare(`
      SELECT client_session_id AS clientSessionId FROM enno_contracts WHERE run_id = ?
    `).get<{ clientSessionId: string }>(planned.identity.runId)?.clientSessionId, planned.hostSessionId);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type = 'enno.client_rebound'
    `).get<{ count: number }>(planned.identity.runId)?.count, 0);

    assert.ok(claimed.resumeToken);
    assert.ok(claimed.executionLease);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM enno_resume_tokens
      WHERE run_id = ? AND token_hash = ?
    `).get<{ count: number }>(planned.identity.runId, claimed.resumeToken)?.count, 0);
    const reportedWithAdapterOutput = await reportEnnoWork(database, {
      runId: claimed.runId,
      resumeToken: claimed.resumeToken,
      leaseToken: claimed.executionLease.leaseToken,
      routeEpoch: claimed.routeEpoch,
      expectedRevision: 2,
      idempotencyKey: 'adapter-output-only-work',
      workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Used only adapter continuation credentials', mutated: false, changedPaths: [] },
    });
    assert.equal(reportedWithAdapterOutput.ennoOduno.status, 'enno_verifying');

    const rerouted = decideAdapterContinuation(database, 'opencode', {
      sessionId: 'new-opencode-session',
      cwd: root,
    });
    assert.equal(rerouted.continue, true);
    assert.ok(rerouted.resumeToken);
    assert.equal(rerouted.routeEpoch, (claimed.routeEpoch ?? 0) + 1);
    await assert.rejects(prepareEnnoVerification(database, {
      runId: planned.identity.runId,
      resumeToken: claimed.resumeToken,
      expectedRevision: 2,
      idempotencyKey: 'stale-route-verification',
    }), /resume token is stale/iu);
    const verifiedWithNewRoute = await prepareEnnoVerification(database, {
      runId: planned.identity.runId,
      resumeToken: rerouted.resumeToken,
      expectedRevision: 2,
      idempotencyKey: 'new-route-verification',
    });
    assert.equal(verifiedWithNewRoute.verifierResults?.[0]?.status, 'passed');
    const refreshedRoute = decideAdapterContinuation(database, 'opencode', {
      sessionId: 'latest-opencode-session', cwd: root,
    });
    assert.ok(refreshedRoute.resumeToken);
    const replayedWithRotatedCredentials = await prepareEnnoVerification(database, {
      runId: planned.identity.runId,
      resumeToken: refreshedRoute.resumeToken,
      expectedRevision: 2,
      idempotencyKey: 'new-route-verification',
    });
    assert.deepEqual(replayedWithRotatedCredentials, verifiedWithNewRoute);
  } finally {
    database.close();
  }
});

test('hook prefers an exact session and otherwise refuses ambiguous active repository runs', async () => {
  const { root, database } = await fixture();
  try {
    const first = await plannedExecution(database, root, 'pending-first', verifier(root, 'first'));
    const second = await plannedExecution(database, root, 'pending-second', verifier(root, 'second'), {
      clientIdentity: 'kind_only',
    });
    const decision = decideAdapterContinuation(database, 'opencode', {
      session_id: 'ambiguous-opencode-session',
      cwd: root,
    });
    assert.equal(decision.continue, false);
    assert.match(decision.warning ?? '', /without guessing/u);
    const bindings = database.prepare(`
      SELECT ec.run_id AS runId, ec.client_session_id AS clientSessionId,
             ec.status, lr.status AS ledgerStatus
      FROM enno_contracts AS ec
      JOIN ledger_runs AS lr ON lr.run_id = ec.run_id
      WHERE ec.run_id IN (?, ?) ORDER BY ec.run_id
    `).all<{ runId: string; clientSessionId: string | null; status: string; ledgerStatus: string }>(first.identity.runId, second.identity.runId)
      .map((row) => ({ ...row }));
    assert.deepEqual(new Map(bindings.map((binding) => [binding.runId, {
      clientSessionId: binding.clientSessionId,
      status: binding.status,
      ledgerStatus: binding.ledgerStatus,
    }])), new Map([
      [first.identity.runId, { clientSessionId: first.hostSessionId, status: 'goki_executing', ledgerStatus: 'active' }],
      [second.identity.runId, { clientSessionId: null, status: 'goki_executing', ledgerStatus: 'active' }],
    ]));
    const exact = decideAdapterContinuation(database, 'opencode', {
      session_id: first.hostSessionId,
      cwd: root,
    });
    assert.equal(exact.continue, true);
    assert.equal(exact.runId, first.identity.runId);
  } finally {
    database.close();
  }
});

test('the same OpenCode terminal is an exact replay and does not consume another receipt', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const planned = await plannedExecution(first.database, first.root, 'terminal-replay', verifier(first.root, 'pass'), {
      maxAttempts: 3,
    });
    const terminalMessageId = 'terminal-replay-message';
    const firstClaim = decideAdapterContinuation(first.database, 'opencode', {
      sessionId: planned.hostSessionId,
      terminalMessageId,
      cwd: first.root,
    });
    const replay = decideAdapterContinuation(first.database, 'opencode', {
      sessionId: planned.hostSessionId,
      terminalMessageId,
      cwd: first.root,
    });
    assert.equal(firstClaim.continue, true);
    assert.equal(replay.continue, true);
    assert.equal(databaseCount(first.database, planned.identity.runId), 1);

    const parallelRun = await plannedExecution(second.database, second.root, 'terminal-concurrent', verifier(second.root, 'pass'), {
      maxAttempts: 3,
    });
    const claims = await Promise.all([
      Promise.resolve(decideAdapterContinuation(second.database, 'opencode', {
        sessionId: parallelRun.hostSessionId,
        terminalMessageId: 'terminal-concurrent-message',
        cwd: second.root,
      })),
      Promise.resolve(decideAdapterContinuation(second.database, 'opencode', {
        sessionId: parallelRun.hostSessionId,
        terminalMessageId: 'terminal-concurrent-message',
        cwd: second.root,
      })),
    ]);
    assert.ok(claims.every((claim) => claim.continue));
    assert.equal(databaseCount(second.database, parallelRun.identity.runId), 1);
  } finally {
    first.database.close();
    second.database.close();
  }
});

test('a receipt reused after the Enno state changes fails closed', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'terminal-conflict', verifier(root, 'pass'));
    const terminalMessageId = 'terminal-conflict-message';
    const terminalHash = createHash('sha256')
      .update('kiokuko-opencode-terminal-v1\0', 'utf8')
      .update(planned.hostSessionId, 'utf8')
      .update('\0', 'utf8')
      .update(terminalMessageId, 'utf8')
      .digest('hex');
    database.prepare(`
      INSERT INTO enno_opencode_continuation_receipts (
        run_id, client_kind, source_session_id, source_terminal_hash,
        contract_revision, mutation_revision, attempts, directive_digest, route_epoch, created_at
      ) VALUES (?, 'opencode', ?, ?, 999, 999, 0, ?, 0, ?)
    `).run(planned.identity.runId, planned.hostSessionId, terminalHash, 'a'.repeat(64), new Date().toISOString());
    assert.throws(() => decideAdapterContinuation(database, 'opencode', {
      sessionId: planned.hostSessionId,
      terminalMessageId,
      cwd: root,
    }), /terminal receipt was reused/u);
  } finally {
    database.close();
  }
});

function databaseCount(database: ReturnType<typeof openConnection>, runId: string): number {
  return Number(database.prepare(`
    SELECT COUNT(*) AS count FROM enno_opencode_continuation_receipts
    WHERE run_id = ? AND client_kind = 'opencode'
  `).get<{ count: number }>(runId)?.count ?? 0);
}

test('an active WorkUnit lease prevents automatic rerouting to another local client', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'pending-opencode-kind', verifier(root, 'pass'), {
      client: 'opencode',
      clientVersion: 'opencode-1.2.3',
      clientIdentity: 'bound',
    });
    assert.deepEqual(planned.prepared.ennoOduno.clientBinding, {
      status: 'bound',
      clientKind: 'opencode',
      clientVersion: 'opencode-1.2.3',
      identified: true,
    });

    assert.throws(() => decideAdapterContinuation(database, 'opencode', {
      session_id: 'opencode-local-session',
      cwd: root,
    }), /active Enno WorkUnit lease/iu);
    const routedBinding = database.prepare(`
      SELECT client_kind AS clientKind, client_version AS clientVersion, client_session_id AS clientSessionId
      FROM enno_contracts WHERE run_id = ?
    `).get<{ clientKind: string; clientVersion: string | null; clientSessionId: string }>(planned.identity.runId);
    assert.deepEqual(routedBinding === undefined ? undefined : { ...routedBinding }, {
      clientKind: 'opencode', clientVersion: 'opencode-1.2.3', clientSessionId: planned.hostSessionId,
    });
    const rebound = database.prepare(`
      SELECT payload_json AS payloadJson FROM ledger_events
      WHERE run_id = ? AND event_type = 'enno.client_rebound'
      ORDER BY sequence DESC LIMIT 1
    `).get<{ payloadJson: string }>(planned.identity.runId);
    assert.equal(rebound, undefined);

    const returned = decideAdapterContinuation(database, 'opencode', {
      session_id: planned.hostSessionId,
      cwd: root,
    });
    assert.equal(returned.continue, true);
    assert.equal(returned.directive?.role, 'goki');
    assert.ok(returned.executionLease);
    await assert.rejects(reportEnnoWork(database, {
      ...planned.identity,
      expectedRevision: 2,
      idempotencyKey: 'lease-loser-report',
      leaseToken: 'invalid-current-lease-token',
      routeEpoch: returned.routeEpoch,
      workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Stale actor must lose', mutated: false, changedPaths: [] },
    }), /lease is stale or belongs to another actor/iu);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM enno_operation_receipts
      WHERE run_id = ? AND idempotency_key = 'lease-loser-report'
    `).get<{ count: number }>(planned.identity.runId)?.count, 0);

    database.prepare(`
      UPDATE enno_execution_leases SET lease_expires_at = ? WHERE run_id = ?
    `).run('2000-01-01T00:00:00.000Z', planned.identity.runId);
    const recovered = decideAdapterContinuation(database, 'opencode', {
      session_id: 'opencode-recovered-owner',
      cwd: root,
    });
    assert.equal(recovered.continue, true);
    assert.equal(recovered.routeEpoch, (returned.routeEpoch ?? 0) + 1);
    assert.ok(recovered.resumeToken);
    assert.ok(recovered.executionLease);
    await assert.rejects(reportEnnoWork(database, {
      ...planned.identity,
      expectedRevision: 2,
      idempotencyKey: 'expired-owner-report',
      leaseToken: returned.executionLease.leaseToken,
      routeEpoch: returned.routeEpoch,
      workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Expired owner must not report', mutated: false, changedPaths: [] },
    }), /lease is stale or belongs to another actor/iu);
    const completed = await reportEnnoWork(database, {
      runId: planned.identity.runId,
      resumeToken: recovered.resumeToken,
      expectedRevision: 2,
      idempotencyKey: 'recovered-owner-report',
      leaseToken: recovered.executionLease.leaseToken,
      routeEpoch: recovered.routeEpoch,
      workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Recovered owner completed the WorkUnit', mutated: false, changedPaths: [] },
    });
    assert.equal(completed.ennoOduno.status, 'enno_verifying');
  } finally {
    database.close();
  }
});

test('Goki cannot start before Oduno derives the ideal and Zenki submits a plan', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'goki-before-plan',
      cwd: root,
      task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities,
      client: { kind: 'opencode', sessionId: 'opencode-before-plan' },
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.ennoOduno.status, 'oduno_ideal');
    assert.equal(prepared.ennoOduno.currentRole, 'enno-oduno');
    const planningContinuation = decideAdapterContinuation(database, 'opencode', {
      session_id: 'opencode-before-plan',
      cwd: root,
    });
    assert.equal(planningContinuation.continue, true);
    assert.equal(planningContinuation.directive?.role, 'enno-oduno');

    await assert.rejects(reportEnnoWork(database, {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
      expectedRevision: 1,
      idempotencyKey: 'illegal-goki-report',
      workUnitId: 'not-planned',
      result: {
        outcome: 'completed',
        summary: 'This work must not be accepted',
        mutated: false,
        changedPaths: [],
      },
    }), /not in the required state/iu);

    const idealized = submitPreparedIdeal(database, prepared, 'before-plan-ideal');
    assert.equal(idealized.ennoOduno.status, 'zenki_planning');
    assert.equal(idealized.ennoOduno.currentRole, 'zenki');
    assert.equal(decideAdapterContinuation(database, 'opencode', {
      session_id: 'opencode-before-plan',
      cwd: root,
    }).directive?.role, 'zenki');

    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type LIKE 'goki.%'
    `).get<{ count: number }>(prepared.run.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('a missing plan environment catalog returns a recoverable choice without consuming the run', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'plan-environment-missing', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-plan-environment-missing' }, skillDiscoveryMode: 'off',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    submitPreparedIdeal(database, prepared, 'plan-environment-missing-ideal');
    const completeInput = confirmationProjectionPlanInput(
      identity,
      prepared.project.repositoryRoot,
      'plan-environment-missing-retry',
      'Repair add without losing the planning run',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
    );
    const { capabilities: omittedCapabilities, ...missingInput } = completeInput;
    assert.ok(omittedCapabilities.length > 0);
    await assert.rejects(
      submitEnnoPlan(database, { ...missingInput, idempotencyKey: 'plan-environment-missing-first' }),
      (error: unknown) => {
        assert.ok(error instanceof KiokukoError);
        assert.equal(error.code, 'CONFLICT');
        assert.deepEqual(error.details, { planStartRecoveryReason: 'environment_information_missing' });
        return true;
      },
    );

    const snapshot = readEnnoSnapshot(database, identity);
    assert.equal(snapshot.status, 'zenki_planning');
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.workUnits.length, 0);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'active');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM enno_operation_receipts WHERE run_id = ? AND operation = 'plan_submit'")
      .get<{ count: number }>(identity.runId)?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_skill_discovery_attempts WHERE run_id = ? AND phase = 'zenki'")
      .get<{ count: number }>(identity.runId)?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_advisory_rounds WHERE run_id = ?')
      .get<{ count: number }>(identity.runId)?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ? AND event_type = 'zenki.plan_created'")
      .get<{ count: number }>(identity.runId)?.count, 0);
    assert.equal(decideAdapterContinuation(database, 'opencode', {
      session_id: 'opencode-plan-environment-missing', cwd: root,
    }).continue, false);

    const continued = await submitEnnoPlan(database, { ...completeInput, recoveryAction: 'continue_same_plan' });
    assert.equal(continued.ennoOduno.status, 'goki_executing');
    assert.equal(continued.ennoOduno.contractRevision, 2);
  } finally {
    database.close();
  }
});

test('a changed environment waits for a choice and explicit planning cancellation permits a clean restart', async () => {
  const { root, database } = await fixture();
  try {
    const sessionId = 'opencode-plan-environment-changed';
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'plan-environment-changed', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId }, skillDiscoveryMode: 'off',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    submitPreparedIdeal(database, prepared, 'plan-environment-changed-ideal');
    const changedInput = confirmationProjectionPlanInput(
      identity,
      prepared.project.repositoryRoot,
      'plan-environment-changed-submit',
      'Repair add under a changed environment',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
    );
    changedInput.capabilities = [...capabilities, {
      kind: 'mcp_tool',
      name: 'new-current-tool',
      description: 'A newly available tool changes the bound environment.',
    }];
    await assert.rejects(submitEnnoPlan(database, changedInput), (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'CONFLICT');
      assert.deepEqual(error.details, { planStartRecoveryReason: 'environment_changed' });
      return true;
    });
    const unchanged = readEnnoSnapshot(database, identity);
    assert.equal(unchanged.status, 'zenki_planning');
    assert.equal(unchanged.revision, 1);
    assert.equal(unchanged.mutationRevision, 0);
    assert.equal(unchanged.workUnits.length, 0);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'active');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM enno_operation_receipts WHERE run_id = ? AND operation = 'plan_submit'")
      .get<{ count: number }>(identity.runId)?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ? AND event_type = 'zenki.plan_created'")
      .get<{ count: number }>(identity.runId)?.count, 0);

    assert.throws(() => answerEnno(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'planning-approve-forbidden', action: 'approve',
    }), /not in the required state/iu);
    assert.throws(() => answerEnno(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'planning-revise-forbidden', action: 'revise',
      requestedChanges: 'This must still wait for normal plan confirmation',
    }), /not in the required state/iu);
    const cancelled = answerEnno(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'planning-explicit-cancel', action: 'cancel',
    });
    assert.equal(cancelled.ennoOduno.status, 'cancelled');
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'cancelled');

    const restarted = await prepareOpenCodeTask(database, {
      requestId: 'plan-environment-restarted', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId }, skillDiscoveryMode: 'off',
    });
    submitPreparedIdeal(database, restarted, 'plan-environment-restarted-ideal');
    const continuation = decideAdapterContinuation(database, 'opencode', { session_id: sessionId, cwd: root });
    assert.equal(continuation.continue, true);
    assert.equal(continuation.runId, restarted.run.runId);
    assert.equal(continuation.directive?.role, 'zenki');
  } finally {
    database.close();
  }
});

test('a legacy plan ended by a lost environment catalog returns restart choices without opening another run', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'legacy-plan-environment-ended', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-legacy-plan-ended' }, skillDiscoveryMode: 'off',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    submitPreparedIdeal(database, prepared, 'legacy-plan-environment-ended-ideal');
    const input = confirmationProjectionPlanInput(
      identity,
      prepared.project.repositoryRoot,
      'legacy-plan-environment-ended-retry',
      'Reuse the plan after the old submission lost its environment catalog',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
    );
    const planning = readEnnoSnapshot(database, identity);
    const legacyContract = {
      ...planning.contract,
      revision: 2,
      scope: [...input.scope],
      exclusions: [...input.exclusions],
      acceptanceCriteria: input.acceptanceCriteria.map((criterion) => ({ ...criterion })),
      workPlan: input.workPlan,
      skillSet: {
        ...planning.contract.skillSet,
        entries: [{
          name: 'kiokuko-soul',
          purposes: ['planning' as const, 'implementation' as const, 'testing' as const, 'review' as const],
          required: true,
          availability: 'unavailable' as const,
          referenceId: null,
        }],
      },
      finalVerifiers: input.finalVerifiers,
      maxAttempts: input.maxAttempts,
      provenance: input.provenance,
    };
    withImmediateTransaction(database, () => {
      updateContractInTransaction(database, planning, {
        contract: legacyContract,
        status: 'blocked',
        confirmationState: 'not_required',
        blocker: 'Required Skills unavailable: kiokuko-soul',
      });
      replaceWorkUnitsInTransaction(database, identity.runId, 2, input.workPlan);
      terminalizeLedgerRunInTransaction(database, identity.runId, 'failed');
    });
    const runCountBefore = database.prepare('SELECT COUNT(*) AS count FROM ledger_runs')
      .get<{ count: number }>()?.count;

    await assert.rejects(submitEnnoPlan(database, { ...input, expectedRevision: 2 }), (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'CONFLICT');
      assert.deepEqual(error.details, { planStartRecoveryReason: 'previous_attempt_ended' });
      return true;
    });

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs')
      .get<{ count: number }>()?.count, runCountBefore);
    assert.equal(readEnnoSnapshot(database, identity).status, 'blocked');
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'failed');
  } finally {
    database.close();
  }
});

test('persisted WorkUnits validate the complete dependency graph during read-back', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'stored-work-unit-dependencies', cwd: root, task: 'Build a dependent module pair',
      profileHints: { taskType: 'debug', target: 'src/prepare.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-stored-dependencies' }, skillDiscoveryMode: 'off',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    submitPreparedIdeal(database, prepared, 'stored-dependencies-ideal');
    const planned = await submitEnnoPlan(database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey: 'stored-dependencies-plan',
      scope: ['src/prepare.js', 'src/finalize.js'],
      exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: {
        objective: 'Build the dependent module pair',
        units: [
          {
            id: 'prepare', objective: 'Prepare the shared module', scope: ['src/prepare.js'], dependencies: [], routes: ['code'], skillNames: [],
            expertRefs: [{ id: 'code.domain.v1', reason: 'Keep the prerequisite module contract deterministic' }],
            acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
          },
          {
            id: 'finalize', objective: 'Finalize the dependent module', scope: ['src/finalize.js'], dependencies: ['prepare'], routes: ['code'], skillNames: [],
            expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the dependent module after its prerequisite completes' }],
            acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
          },
        ],
      },
      skillRequirements: [],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, 'stored-dependencies-final')],
      maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(planned.ennoOduno.status, 'goki_executing');
    const snapshot = readEnnoSnapshot(database, identity);
    assert.deepEqual(snapshot.workUnits.map((unit) => ({
      id: unit.workUnit.id,
      dependencies: unit.workUnit.dependencies,
      status: unit.status,
    })), [
      { id: 'prepare', dependencies: [], status: 'in_progress' },
      { id: 'finalize', dependencies: ['prepare'], status: 'pending' },
    ]);
  } finally {
    database.close();
  }
});

test('Zenki discovery uses a new plan digest and only the remaining run budget after replanning', async () => {
  const { root, database } = await fixture();
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
    const discoveryCapabilities = [
      ...capabilities,
      { kind: 'skill', name: 'memory-reasoning' },
      { kind: 'skill', name: 'svelte' },
    ];
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'zenki-discovery-budget', cwd: root, task: 'Repair a Svelte component',
      profileHints: { taskType: 'debug', target: 'src/component.ts', expected: 'tests pass', constraints: null },
      capabilities: discoveryCapabilities, client: { kind: 'opencode', sessionId: 'opencode-zenki-discovery-budget' },
      skillDiscoveryMode: 'official',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    submitPreparedIdeal(database, prepared, 'zenki-discovery-budget-ideal');
    const calls: Array<{ maxQueries: number | undefined; maxSelectedSkills: number | undefined; task: string }> = [];
    const discover = async (_database: Parameters<typeof discoverSkills>[0], input: Parameters<typeof discoverSkills>[1]) => {
      calls.push({ maxQueries: input.maxQueries, maxSelectedSkills: input.maxSelectedSkills, task: input.task });
      return {
        attempted: true,
        mode: input.mode,
        requirements: ['svelte'],
        queries: calls.length === 1 ? ['svelte'] : ['svelte', 'svelte debug'],
        cacheHits: 0,
        candidates: 0,
        selected: [],
        failures: [],
      };
    };
    const planInput = (expectedRevision: number, idempotencyKey: string, objective: string) => ({
      ...identity,
      expectedRevision,
      idempotencyKey,
      scope: ['src/component.ts'],
      exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective, units: [{
        id: 'repair', objective: 'Repair the Svelte component', scope: ['src/component.ts'], dependencies: [], routes: ['code'], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify each replanned component repair with focused evidence' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, 'zenki-discovery-final')],
      maxAttempts: 5,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities: discoveryCapabilities,
    });

    const firstPlan = await submitEnnoPlan(database, planInput(1, 'zenki-discovery-plan-1', 'Repair the first component plan'), {
      discoverSkills: discover,
    });
    assert.equal(firstPlan.ennoOduno.status, 'goki_executing');
    assert.deepEqual(calls[0], {
      maxQueries: 3,
      maxSelectedSkills: 2,
      task: 'Repair a Svelte component\nRepair the first component plan',
    });
    await reportEnnoWork(database, {
      ...identity,
      ...executionCredentials(firstPlan),
      expectedRevision: 2,
      idempotencyKey: 'zenki-discovery-work-1',
      workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Initial component repair', mutated: false, changedPaths: [] },
    });
    const verified = await prepareEnnoVerification(database, {
      ...identity,
      expectedRevision: 2,
      idempotencyKey: 'zenki-discovery-prepare-1',
    });
    assert.equal(verified.ennoOduno.nextAction, 'submit_final_review');
    const replanning = await finishEnno(database, {
      ...identity,
      expectedRevision: 2,
      idempotencyKey: 'zenki-discovery-replan-review',
      review: { decision: 'replan', summary: 'Use a narrower component plan' },
    });
    assert.equal(replanning.ennoOduno.status, 'zenki_planning');
    assert.equal(replanning.ennoOduno.contractRevision, 3);

    await assert.rejects(submitEnnoPlan(database, {
      ...planInput(3, 'zenki-discovery-exhausted-plan', 'Repair with an exhausted attempt budget'),
      maxAttempts: 1,
    }, { discoverSkills: discover }), (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(JSON.stringify(error.details), /maxAttempts/u);
      return true;
    });
    assert.equal(calls.length, 1);

    const secondPlan = await submitEnnoPlan(database, planInput(3, 'zenki-discovery-plan-2', 'Repair the narrower component plan'), {
      discoverSkills: discover,
    });
    assert.equal(secondPlan.ennoOduno.status, 'goki_executing');
    assert.deepEqual(calls.map((call) => ({ maxQueries: call.maxQueries, maxSelectedSkills: call.maxSelectedSkills })), [
      { maxQueries: 3, maxSelectedSkills: 2 },
      { maxQueries: 2, maxSelectedSkills: 2 },
    ]);
    const attempts = database.prepare(`
      SELECT phase, request_digest AS requestDigest,
             reserved_query_count AS reservedQueries, consumed_query_count AS consumedQueries,
             reserved_selection_count AS reservedSelections, consumed_selection_count AS consumedSelections
      FROM task_skill_discovery_attempts WHERE run_id = ? ORDER BY rowid
    `).all<{ phase: string; requestDigest: string; reservedQueries: number; consumedQueries: number; reservedSelections: number; consumedSelections: number }>(identity.runId)
      .map((row) => ({ ...row }));
    assert.equal(attempts.length, 3);
    const zenkiAttempts = attempts.filter((attempt) => attempt.phase === 'zenki');
    assert.equal(zenkiAttempts.length, 2);
    assert.notEqual(zenkiAttempts[0]?.requestDigest, zenkiAttempts[1]?.requestDigest);
    assert.deepEqual(zenkiAttempts.map(({ phase: _phase, requestDigest: _digest, ...budget }) => budget), [
      { reservedQueries: 3, consumedQueries: 1, reservedSelections: 2, consumedSelections: 0 },
      { reservedQueries: 2, consumedQueries: 2, reservedSelections: 2, consumedSelections: 0 },
    ]);
  } finally {
    database.close();
  }
});

test('Zenki preserves the run-wide budget after a failed discovery attempt', async () => {
  const prepare = async (requestId: string) => {
    const testFixture = await fixture();
    const discoveryCapabilities = [
      ...capabilities,
      { kind: 'skill', name: 'memory-reasoning' },
      { kind: 'skill', name: 'svelte' },
    ];
    const prepared = await prepareOpenCodeTask(testFixture.database, {
      requestId,
      cwd: testFixture.root,
      task: 'Repair a Svelte component',
      profileHints: { taskType: 'debug', target: 'src/component.ts', expected: 'tests pass', constraints: null },
      capabilities: discoveryCapabilities,
      client: { kind: 'opencode', sessionId: `opencode-${requestId}` },
      skillDiscoveryMode: 'official',
    });
    submitPreparedIdeal(testFixture.database, prepared, `${requestId}-ideal`);
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    const plan = {
      ...identity,
      expectedRevision: 1,
      idempotencyKey: `${requestId}-plan`,
      scope: ['src/component.ts'],
      exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Repair the Svelte component', units: [{
        id: 'repair', objective: 'Repair the Svelte component', scope: ['src/component.ts'], dependencies: [],
        routes: ['code'], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the recovered plan with focused evidence' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, `${requestId}-final`)],
      maxAttempts: 5,
      provenance: {
        scope: 'explicit_user' as const, exclusions: 'explicit_user' as const, acceptanceCriteria: 'explicit_user' as const,
        workPlan: 'explicit_user' as const, skillSet: 'explicit_user' as const, finalVerifiers: 'explicit_user' as const, maxAttempts: 'explicit_user' as const,
      },
      capabilities: discoveryCapabilities,
    };
    const digest = canonicalContentHash({
      version: 2,
      runId: prepared.run.runId,
      revision: 1,
      mode: prepared.skillDiscovery.mode,
      workPlan: plan.workPlan,
      capabilities: plan.capabilities,
      skillRequirements: plan.skillRequirements,
    });
    const insertFailedAttempt = (requestDigest: string) => testFixture.database.prepare(`
      INSERT INTO task_skill_discovery_attempts (
        run_id, phase, request_digest,
        reserved_query_count, reserved_selection_count,
        consumed_query_count, consumed_selection_count,
        state, summary_json, failure_json, started_at, finished_at
      ) VALUES (?, 'zenki', ?, 3, 2, 3, 2, 'failed', NULL, ?, ?, ?)
    `).run(
      prepared.run.runId,
      requestDigest,
      '{"code":"registry_invalid_response","kind":"skill_provider","retryAfterSeconds":null}',
      '2026-08-28T00:00:00.000Z',
      '2026-08-28T00:00:00.000Z',
    );
    return { ...testFixture, prepared, identity, plan, digest, insertFailedAttempt };
  };

  const context = await prepare('failed-discovery-changed-digest');
  try {
    context.insertFailedAttempt('e'.repeat(64));
    const planned = await submitEnnoPlan(context.database, context.plan);
    assert.equal(planned.ennoOduno.status, 'goki_executing');
    assert.deepEqual(context.database.prepare(`
        SELECT request_digest AS requestDigest, state,
               reserved_query_count AS reservedQueries, consumed_query_count AS consumedQueries,
               reserved_selection_count AS reservedSelections, consumed_selection_count AS consumedSelections
        FROM task_skill_discovery_attempts
        WHERE run_id = ? AND phase = 'zenki' ORDER BY request_digest
    `).all(context.identity.runId).map((row) => ({ ...row })), [
        {
          requestDigest: context.digest,
          state: 'completed',
          reservedQueries: 0,
          consumedQueries: 0,
          reservedSelections: 0,
          consumedSelections: 0,
        },
        {
          requestDigest: 'e'.repeat(64),
          state: 'failed',
          reservedQueries: 3,
          consumedQueries: 3,
          reservedSelections: 2,
          consumedSelections: 2,
        },
    ].sort((left, right) => left.requestDigest.localeCompare(right.requestDigest)));
  } finally {
    context.database.close();
  }
});

test('Zenki cannot submit a code WorkUnit without a selected expert fragment', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'missing-code-expert', cwd: root, task: 'Build a module',
      profileHints: { taskType: 'build', target: 'src/module.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-missing-expert' }, skillDiscoveryMode: 'off',
    });
    submitPreparedIdeal(database, prepared, 'missing-expert-ideal');
    await assert.rejects(submitEnnoPlan(database, {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
      expectedRevision: 1,
      idempotencyKey: 'missing-expert-plan',
      scope: ['src/module.js'], exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Build the module', units: [{
        id: 'module', objective: 'Build the module', scope: ['src/module.js'], dependencies: [],
        routes: ['code'], skillNames: [], acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, 'missing-expert-final')],
      maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    }), /Enno input is invalid/iu);
    assert.equal(database.prepare('SELECT revision FROM enno_contracts WHERE run_id = ?')
      .get<{ revision: number }>(prepared.run.runId)?.revision, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ? AND event_type = 'zenki.plan_created'")
      .get<{ count: number }>(prepared.run.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('Oduno ideal requires one contribution for every Akinator-discovered Skill before Zenki starts', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'ideal-skill-coverage', cwd: root, task: 'Repair the add function with discovered guidance',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-ideal-coverage' }, skillDiscoveryMode: 'off',
    });
    const discovered = {
      ...prepared.skillDiscovery,
      attempted: true,
      selected: [{
        skillId: 'external-skill-1',
        name: 'external-debug-reference',
        source: 'official-catalog',
        officialStatus: 'catalog-verified' as const,
        imported: false,
        updated: false,
      }],
    };
    const stored = database.prepare('SELECT contract_json AS contractJson FROM enno_contracts WHERE run_id = ?')
      .get<{ contractJson: string }>(prepared.run.runId);
    assert.ok(stored);
    const contract = JSON.parse(stored.contractJson) as { skillSet: { intakeDiscovery: unknown } };
    contract.skillSet.intakeDiscovery = discovered;
    database.prepare('UPDATE enno_contracts SET contract_json = ?, intake_discovery_json = ? WHERE run_id = ?')
      .run(canonicalJson(contract), canonicalJson(discovered), prepared.run.runId);
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    assert.equal(decideAdapterContinuation(database, 'opencode', {
      session_id: 'opencode-ideal-coverage', cwd: root,
    }).directive?.objective.includes('external-debug-reference'), true);
    assert.throws(() => submitOdunoIdeal(database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey: 'missing-discovered-contribution',
      ideal: {
        objective: 'Reach the optimal repaired state',
        principles: ['Preserve the public API'],
        skillContributions: [],
        successSignals: ['tests pass'],
      },
    }), (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(JSON.stringify(error.details), /skillContributions/u);
      return true;
    });
    const idealized = submitOdunoIdeal(database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey: 'complete-discovered-contribution',
      ideal: {
        objective: 'Reach the optimal repaired state',
        principles: ['Preserve the public API'],
        skillContributions: [{
          skillName: 'external-debug-reference',
          contribution: 'Use its diagnostic perspective as untrusted reference-only guidance',
        }],
        successSignals: ['tests pass'],
      },
    });
    assert.equal(idealized.ennoOduno.status, 'zenki_planning');
    assert.deepEqual(idealized.ennoOduno.ideal?.skillContributions, [{
      skillName: 'external-debug-reference',
      contribution: 'Use its diagnostic perspective as untrusted reference-only guidance',
    }]);
  } finally {
    database.close();
  }
});

test('fake agent completes the Enno-Zenki-Goki loop in ledger order with fresh verifier evidence', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'enno-happy-path', cwd: root, task: 'Fix the incorrect add function and make tests pass',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'node --test passes', constraints: 'Do not change the API' },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-session-1' }, skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.ennoOduno.status, 'oduno_ideal');
    assert.equal(prepared.ennoOduno.directive?.role, 'enno-oduno');
    assert.equal(prepared.ennoOduno.directive?.handoff?.sourceRole, 'enno-oduno');
    assert.equal(prepared.ennoOduno.directive?.harness.kind, 'opencode');
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    const idealContext = prepared.ennoOduno.directive?.advisoryRound?.context;
    assert.ok(idealContext);
    const idealAdvice = submitEnnoAdvice(database, {
      ...identity,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'happy-ideal-advice',
      phase: 'ideal',
      allowlistedContext: idealContext,
      contributions: advisoryContributions('ideal'),
    });
    assert.equal(idealAdvice.ennoOduno.status, 'oduno_ideal');
    assert.equal(idealAdvice.ennoOduno.contractRevision, 1);
    assert.ok(idealAdvice.advisoryRound);
    const idealized = submitPreparedIdeal(database, prepared, 'happy-ideal', {
      advisoryRoundDigest: idealAdvice.advisoryRound.inputDigest,
      advisoryDisposition: advisoryDispositions('ideal'),
    });
    assert.equal(idealized.ennoOduno.status, 'zenki_planning');
    assert.equal(idealized.ennoOduno.directive?.role, 'zenki');
    assert.match(idealized.ennoOduno.ideal?.objective ?? '', /optimal verified outcome/iu);
    const planningContext = idealized.ennoOduno.directive?.advisoryRound?.context;
    assert.ok(planningContext);
    const planningAdvice = submitEnnoAdvice(database, {
      ...identity,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'happy-planning-advice',
      phase: 'planning',
      allowlistedContext: planningContext,
      contributions: advisoryContributions('planning'),
    });
    assert.equal(planningAdvice.ennoOduno.status, 'zenki_planning');
    assert.ok(planningAdvice.advisoryRound);
    const plan = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'plan-1',
      advisoryRoundDigest: planningAdvice.advisoryRound.inputDigest,
      advisoryDisposition: advisoryDispositions('planning'),
      scope: ['src/add.js', 'test/add.test.js'], exclusions: ['package-lock.json'],
      acceptanceCriteria: [{ id: 'tests', description: 'node --test passes' }],
      workPlan: { objective: 'Repair add and test it', units: [{
        id: 'repair-add', objective: 'Repair the add implementation', scope: ['src/add.js'], dependencies: [],
        routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'], acceptanceCriteria: ['node --test passes'],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Prove the add regression through the focused test pipeline' }],
        focusedVerifiers: [verifier(repositoryRoot, 'focused-test')],
      }] },
      skillRequirements: [{ name: 'kiokuko-single-purpose-functions', purposes: ['implementation', 'testing'], required: true }],
      finalVerifiers: [verifier(repositoryRoot, 'final-test')], maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'repository_evidence',
        workPlan: 'repository_evidence', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(plan.ennoOduno.status, 'needs_confirmation');
    assert.deepEqual(plan.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-enno-oduno',
      'kiokuko-single-purpose-functions',
    ]);

    const approved = answerEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'approve-1', action: 'approve',
    });
    assert.equal(approved.ennoOduno.status, 'goki_executing');
    const hook = decideAdapterContinuation(database, 'opencode', { session_id: 'opencode-session-1', cwd: root });
    assert.equal(hook.continue, true);
    assert.equal(hook.directive?.role, 'goki');
    assert.deepEqual(hook.directive?.requiredSkills, ['kiokuko-soul', 'kiokuko-single-purpose-functions']);

    const worked = await reportEnnoWork(database, {
      ...identity, ...executionCredentials(hook), expectedRevision: 2, idempotencyKey: 'work-1', workUnitId: 'repair-add',
      result: { outcome: 'completed', summary: 'Fixed add and added coverage', mutated: true, changedPaths: ['src/add.js'] },
    });
    assert.equal(worked.ennoOduno.status, 'enno_verifying');
    assert.equal(worked.ennoOduno.nextAction, 'run_final_verification');
    const workedSnapshot = readEnnoSnapshot(database, identity);
    assert.equal(workedSnapshot.attempts, 0);
    assert.equal(workedSnapshot.workUnits.find((unit) => unit.workUnit.id === 'repair-add')?.attemptCount, 1);
    assert.equal(worked.ennoOduno.directive?.advisoryRound, undefined);
    assert.deepEqual(worked.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-enno-oduno',
      'kiokuko-single-purpose-functions',
    ]);
    assert.equal(worked.verifierResults?.[0]?.status, 'passed');

    const verified = await prepareEnnoVerification(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'verify-prepare-1',
    });
    assert.equal(verified.ennoOduno.status, 'enno_verifying');
    assert.equal(verified.ennoOduno.nextAction, 'submit_final_review');
    assert.equal(verified.verifierResults?.[0]?.status, 'passed');
    const finalReviewContext = verified.ennoOduno.directive?.advisoryRound?.context;
    assert.ok(finalReviewContext);
    const finalAdvice = submitEnnoAdvice(database, {
      ...identity,
      expectedRevision: 2,
      mutationRevision: 1,
      idempotencyKey: 'happy-final-advice',
      phase: 'final_review',
      allowlistedContext: finalReviewContext,
      contributions: advisoryContributions('final_review'),
    });
    assert.equal(finalAdvice.ennoOduno.status, 'enno_verifying');
    assert.ok(finalAdvice.advisoryRound);
    assert.equal(finalAdvice.advisoryRound.inputDigest, advisoryDigest('final_review', 2, 1, finalReviewContext));

    let finishSpawnCalls = 0;
    const finished = await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'finish-1',
      advisoryRoundDigest: finalAdvice.advisoryRound.inputDigest,
      advisoryDisposition: advisoryDispositions('final_review'),
      review: { decision: 'accept', summary: 'All acceptance criteria are satisfied' },
    }, {
      spawn: (() => {
        finishSpawnCalls += 1;
        throw new Error('final verifier must not be started during finish');
      }) as never,
    });
    assert.equal(finishSpawnCalls, 0);
    assert.equal(finished.ennoOduno.status, 'oduno_meditation');
    assert.equal(finished.ennoOduno.nextAction, 'submit_meditation');
    assert.equal(finished.ennoOduno.directive?.role, 'enno-oduno');
    assert.match(finished.ennoOduno.directive?.objective ?? '', /obsolete, useless, or redundant tests and functions/iu);
    assert.equal(finished.verifierResults?.[0]?.status, 'passed');
    assert.deepEqual(await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'finish-1',
      advisoryRoundDigest: finalAdvice.advisoryRound.inputDigest,
      advisoryDisposition: advisoryDispositions('final_review'),
      review: { decision: 'accept', summary: 'All acceptance criteria are satisfied' },
    }), finished);
    await assert.rejects(finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'finish-1',
      review: { decision: 'replan', summary: 'Changed Review input must not replay' },
    }), /idempotency key was reused with different input/iu);

    const meditationContinuation = decideAdapterContinuation(database, 'opencode', {
      session_id: 'opencode-after-finish', cwd: root,
    });
    assert.equal(meditationContinuation.continue, true);
    assert.equal(meditationContinuation.runId, identity.runId);
    assert.equal(meditationContinuation.status, 'oduno_meditation');
    assert.equal(meditationContinuation.directive?.role, 'enno-oduno');
    assert.match(meditationContinuation.directive?.objective ?? '', /obsolete, useless, or redundant tests and functions/iu);

    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'active');
    const deletionCandidates = [{
      kind: 'function' as const,
      path: 'src/add.js',
      name: 'legacyAdd',
      reason: 'The verified implementation supersedes this unused compatibility helper',
      evidence: ['No approved WorkUnit or verifier depends on legacyAdd'],
    }];
    const meditated = submitMeditation(database, identity, 2, 'meditation-1', deletionCandidates);
    assert.equal(meditated.ennoOduno.status, 'completed');
    assert.deepEqual(meditated.ennoOduno.meditation?.deletionCandidates, deletionCandidates);
    assert.deepEqual(submitMeditation(database, identity, 2, 'meditation-1', deletionCandidates), meditated);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(identity.runId)?.status, 'completed');

    const events = database.prepare(`
      SELECT event_type AS eventType FROM ledger_events
      WHERE run_id = ? AND (
        event_type LIKE 'enno.%' OR event_type LIKE 'oduno.%'
        OR event_type LIKE 'zenki.%' OR event_type LIKE 'goki.%'
      )
      ORDER BY sequence
    `).all<{ eventType: string }>(identity.runId).map((row) => row.eventType);
    assert.deepEqual(events, [
      'enno.started',
      'enno.advice_submitted',
      'enno.advice_disposition',
      'oduno.ideal_derived',
      'enno.advice_submitted',
      'enno.advice_disposition',
      'zenki.plan_created',
      'enno.plan_confirmed',
      'goki.work_started',
      'goki.work_completed',
      'enno.verification_started',
      'enno.advice_submitted',
      'enno.advice_disposition',
      'enno.review_started',
      'enno.verification_started',
      'enno.verification_passed',
      'enno.review_accepted',
      'enno.client_rebound',
      'oduno.meditation_completed',
      'enno.completed',
    ]);
    const evidence = database.prepare(`
      SELECT contract_revision AS revision, mutation_revision AS mutationRevision, status
      FROM enno_verifier_runs WHERE run_id = ? ORDER BY started_at
    `).all<{ revision: number; mutationRevision: number; status: string }>(identity.runId);
    assert.deepEqual(evidence.map((item) => item.status), ['passed', 'passed']);
    assert.deepEqual(evidence.map((item) => item.revision), [2, 2]);
    assert.deepEqual(evidence.map((item) => item.mutationRevision), [1, 1]);
  } finally {
    database.close();
  }
});

test('a passing single WorkUnit reaches final review with maxAttempts=1', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'minimum-success-budget', verifier(root, 'final-test'), {
      client: 'opencode',
      maxAttempts: 1,
      focusedVerifiers: [verifier(root, 'focused-test')],
    });
    const worked = await reportEnnoWork(database, {
      ...planned.identity,
      ...executionCredentials(planned),
      expectedRevision: 2,
      idempotencyKey: 'minimum-success-budget-work',
      workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Completed the approved WorkUnit', mutated: false, changedPaths: [] },
    });
    assert.equal(worked.ennoOduno.status, 'enno_verifying');
    assert.equal(worked.ennoOduno.nextAction, 'run_final_verification');
    const workedSnapshot = readEnnoSnapshot(database, planned.identity);
    assert.equal(workedSnapshot.attempts, 0);
    assert.equal(workedSnapshot.workUnits[0]?.attemptCount, 1);

    const verified = await prepareEnnoVerification(database, {
      ...planned.identity,
      expectedRevision: 2,
      idempotencyKey: 'minimum-success-budget-verify',
    });
    assert.equal(verified.ennoOduno.status, 'enno_verifying');
    assert.equal(verified.ennoOduno.nextAction, 'submit_final_review');
    assert.equal(verified.verifierResults?.[0]?.status, 'passed');
    const finalReviewContext = verified.ennoOduno.directive?.advisoryRound?.context;
    assert.ok(finalReviewContext);
    const finalAdvice = submitEnnoAdvice(database, {
      ...planned.identity,
      expectedRevision: 2,
      mutationRevision: 0,
      idempotencyKey: 'minimum-success-budget-advice',
      phase: 'final_review',
      allowlistedContext: finalReviewContext,
      contributions: advisoryContributions('final_review'),
    });
    const finished = await finishEnno(database, {
      ...planned.identity,
      expectedRevision: 2,
      idempotencyKey: 'minimum-success-budget-finish',
      advisoryRoundDigest: finalAdvice.advisoryRound?.inputDigest,
      advisoryDisposition: advisoryDispositions('final_review'),
      review: { decision: 'accept', summary: 'The minimum-budget lifecycle passed' },
    });
    assert.equal(finished.ennoOduno.status, 'oduno_meditation');
    assert.equal(readEnnoSnapshot(database, planned.identity).attempts, 1);
  } finally {
    database.close();
  }
});

function confirmationProjectionPlanInput(
  identity: { runId: string; workspace: string; orchestrationId: string },
  repositoryRoot: string,
  idempotencyKey: string,
  objective: string,
  provenance: Record<'scope' | 'exclusions' | 'acceptanceCriteria' | 'workPlan' | 'skillSet' | 'finalVerifiers' | 'maxAttempts', 'explicit_user' | 'repository_evidence' | 'inferred'>,
) {
  return {
    ...identity, expectedRevision: 1, idempotencyKey,
    scope: ['src/add.js'], exclusions: [],
    acceptanceCriteria: [{ id: 'tests', description: 'node --test passes' }],
    workPlan: { objective, units: [{
      id: 'repair-add', objective: 'Repair the add implementation', scope: ['src/add.js'], dependencies: [],
      routes: ['code' as const], skillNames: ['kiokuko-single-purpose-functions'],
      expertRefs: [{ id: 'code.verification.v1', reason: 'Prove the add regression with focused tests' }],
      acceptanceCriteria: ['node --test passes'],
      focusedVerifiers: [verifier(repositoryRoot, 'focused-test')],
    }] },
    skillRequirements: [],
    finalVerifiers: [verifier(repositoryRoot, 'final-test')], maxAttempts: 5,
    provenance,
    capabilities,
  };
}

test('a needs_confirmation plan presents a complete user-facing confirmation projection', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'confirmation-projection', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-confirmation' }, skillDiscoveryMode: 'off',
    });
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    submitPreparedIdeal(database, prepared, 'projection-ideal');
    const plan = await submitEnnoPlan(database, confirmationProjectionPlanInput(
      identity, repositoryRoot, 'projection-plan-1', 'Repair add behind the confirmation',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred',
      },
    ));
    assert.equal(plan.ennoOduno.status, 'needs_confirmation');
    assert.equal(plan.ennoOduno.nextAction, 'ask_user_confirmation');
    assert.match(plan.ennoOduno.directive?.objective ?? '', /Return every item in userFacingConfirmation to the user in the user's language/iu);
    assert.deepEqual(plan.ennoOduno.directive?.reportSchema.required, ['runId', 'expectedRevision', 'idempotencyKey', 'action']);
    const projection = plan.ennoOduno.directive?.userFacingConfirmation;
    assert.ok(projection !== undefined);
    assert.equal(projection.presentationVersion, 1);
    assert.deepEqual(projection.actions, ['approve', 'revise', 'cancel']);
    assert.deepEqual(projection.summary, { basis: 'proposal', text: 'Repair add behind the confirmation' });
    assert.deepEqual(projection.scope, { basis: 'user', paths: ['src/add.js'] });
    assert.deepEqual(projection.exclusions, { basis: 'user', paths: [] });
    assert.deepEqual(projection.completion, { basis: 'user', items: ['node --test passes'] });
    assert.equal(projection.workItems.length, 1);
    assert.equal(projection.workItems[0]?.number, 1);
    assert.equal(projection.workItems[0]?.summary, 'Repair the add implementation');
    assert.deepEqual(projection.workItems[0]?.dependsOn, []);
    assert.deepEqual(projection.workItems[0]?.expertise, [{
      area: 'Regression prevention and verification design', basis: 'proposal', reason: 'Prove the add regression with focused tests',
    }]);
    assert.deepEqual(projection.workItems[0]?.checks, [{
      category: 'test', executable: process.execPath, arguments: ['--eval', 'process.exit(0)'], directory: '.', timeoutMs: 5000,
    }]);
    assert.deepEqual(projection.finalChecks.checks[0]?.directory, '.');
    assert.deepEqual(projection.attemptLimit, { basis: 'proposal', maxAttempts: 5 });
    assert.equal(projection.skills.every((skill) => skill.referenceOnly === false), true);
    const rendered = JSON.stringify(projection);
    for (const forbidden of [
      'repair-add', 'focused-test', 'final-test', 'code.verification.v1',
      'WorkUnit', 'workPlan', 'expertRefs', 'focusedVerifiers', 'finalVerifiers',
      'workUnitId', 'skillNames', 'acceptanceCriteria', 'provenance',
    ]) {
      assert.equal(rendered.includes(forbidden), false, `projection leaked internal token: ${forbidden}`);
    }

    const replay = await submitEnnoPlan(database, confirmationProjectionPlanInput(
      identity, repositoryRoot, 'projection-plan-1', 'Repair add behind the confirmation',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred',
      },
    ));
    assert.deepEqual(replay, plan);

    const stale = answerEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'projection-stale-approve', action: 'approve',
    });
    assert.throws(() => answerEnno(database, {
      ...identity, expectedRevision: 99, idempotencyKey: 'projection-older-approve', action: 'approve',
    }), /revision changed/iu);
    assert.equal(stale.ennoOduno.status, 'goki_executing');
    assert.equal('userFacingConfirmation' in (stale.ennoOduno.directive ?? {}), false);
  } finally {
    database.close();
  }
});

test('revise returns to Zenki for a fresh projection and cancel terminates without one', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'confirmation-revise-cancel', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-revision' }, skillDiscoveryMode: 'off',
    });
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    submitPreparedIdeal(database, prepared, 'revision-ideal');
    const provenance = {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred',
    } as const;
    await submitEnnoPlan(database, confirmationProjectionPlanInput(
      identity, repositoryRoot, 'revision-plan-1', 'Repair add behind the confirmation', provenance,
    ));
    const revised = answerEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'revision-revise', action: 'revise',
      requestedChanges: 'Narrow the plan to the add regression only',
    });
    assert.equal(revised.ennoOduno.status, 'zenki_planning');
    assert.equal(revised.ennoOduno.contractRevision, 3);
    assert.equal('userFacingConfirmation' in (revised.ennoOduno.directive ?? {}), false);
    const replanned = await submitEnnoPlan(database, {
      ...confirmationProjectionPlanInput(identity, repositoryRoot, 'revision-plan-2', 'Repair add with a narrower scope', provenance),
      expectedRevision: 3,
    });
    assert.equal(replanned.ennoOduno.status, 'needs_confirmation');
    assert.equal(replanned.ennoOduno.contractRevision, 4);
    assert.equal(replanned.ennoOduno.directive?.userFacingConfirmation?.summary.text, 'Repair add with a narrower scope');
    const cancelled = answerEnno(database, {
      ...identity, expectedRevision: 4, idempotencyKey: 'revision-cancel', action: 'cancel',
    });
    assert.equal(cancelled.ennoOduno.status, 'cancelled');
    assert.equal(cancelled.ennoOduno.directive, null);
  } finally {
    database.close();
  }
});

test('an all-explicit plan skips confirmation and carries no projection', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'explicit-skips-confirmation', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-explicit' }, skillDiscoveryMode: 'off',
    });
    const repositoryRoot = prepared.project.repositoryRoot;
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    submitPreparedIdeal(database, prepared, 'explicit-ideal');
    const plan = await submitEnnoPlan(database, confirmationProjectionPlanInput(
      identity, repositoryRoot, 'explicit-plan-1', 'Repair add without confirmation',
      {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
    ));
    assert.equal(plan.ennoOduno.status, 'goki_executing');
    assert.equal('userFacingConfirmation' in (plan.ennoOduno.directive ?? {}), false);
  } finally {
    database.close();
  }
});

test('mixed UI, code, test, docs, and operations WorkUnits route experts and Skills locally', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'enno-code-ui-skills', cwd: root, task: 'Build an accessible settings panel',
      profileHints: { taskType: 'build', target: 'src/Settings.tsx', expected: 'UI tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-code-ui' }, skillDiscoveryMode: 'off',
    });
    const identity = {
      runId: prepared.run.runId,
      workspace: prepared.project.workspace,
      orchestrationId: prepared.intake.sessionId,
    };
    submitPreparedIdeal(database, prepared, 'code-ui-ideal');
    const plan = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'code-ui-plan',
      scope: ['src/Settings.tsx', 'src/catalog.ts', 'tests/settings.test.ts', 'README.md', '.gitignore'], exclusions: [],
      acceptanceCriteria: [{ id: 'ui-tests', description: 'UI tests pass' }],
      workPlan: { objective: 'Build the accessible settings panel', units: [
        {
          id: 'settings-ui', objective: 'Implement the settings panel', scope: ['src/Settings.tsx'], dependencies: [],
          routes: ['ui'], skillNames: ['kiokuko-ui-design-soul', 'kiokuko-soul'], acceptanceCriteria: ['UI tests pass'], focusedVerifiers: [],
          expertRefs: [
            { id: 'code.domain.v1', reason: 'Keep settings state transitions deterministic' },
            { id: 'ui.accessibility.v1', reason: 'The panel must support accessible labels, focus, and keyboard use' },
          ],
        },
        {
          id: 'catalog', objective: 'Convert the settings catalog', scope: ['src/catalog.ts'], dependencies: ['settings-ui'],
          routes: ['code'], skillNames: [], acceptanceCriteria: ['Catalog conversion is deterministic'], focusedVerifiers: [],
          expertRefs: [{ id: 'code.domain.v1', reason: 'Preserve catalog invariants' }],
        },
        {
          id: 'tests', objective: 'Add regression tests', scope: ['tests/settings.test.ts'], dependencies: ['catalog'],
          routes: ['test'], skillNames: [], expertRefs: [], acceptanceCriteria: ['Regression is covered'], focusedVerifiers: [],
        },
        {
          id: 'docs', objective: 'Update usage documentation', scope: ['README.md'], dependencies: ['tests'],
          routes: ['docs'], skillNames: [], expertRefs: [], acceptanceCriteria: ['Documentation matches behavior'], focusedVerifiers: [],
        },
        {
          id: 'residual', objective: 'Remove residual references', scope: ['.gitignore'], dependencies: ['docs'],
          routes: ['operations'], skillNames: [], expertRefs: [], acceptanceCriteria: ['No stale references remain'], focusedVerifiers: [],
        },
      ] },
      skillRequirements: [{ name: 'kiokuko-ui-design-soul', purposes: ['ui', 'implementation', 'testing'], required: true }],
      finalVerifiers: [verifier(prepared.project.repositoryRoot, 'code-ui-final')], maxAttempts: 8,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(plan.ennoOduno.status, 'goki_executing');
    assert.deepEqual(plan.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-single-purpose-functions',
      'kiokuko-ui-design-soul',
    ]);
    assert.deepEqual(plan.ennoOduno.directive?.workUnit?.skillNames, [
      'kiokuko-soul',
      'kiokuko-single-purpose-functions',
      'kiokuko-ui-design-soul',
    ]);
    assert.deepEqual(plan.ennoOduno.directive?.workUnit?.expertRefs.map((reference) => reference.id), [
      'code.domain.v1',
      'ui.accessibility.v1',
    ]);

    const catalog = await reportEnnoWork(database, {
      ...identity, ...executionCredentials(plan), expectedRevision: 2, idempotencyKey: 'code-ui-work', workUnitId: 'settings-ui',
      result: { outcome: 'completed', summary: 'Implemented the accessible settings panel', mutated: true, changedPaths: ['src/Settings.tsx'] },
    });
    assert.equal(catalog.ennoOduno.directive?.workUnit?.id, 'catalog');
    assert.deepEqual(catalog.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-single-purpose-functions',
    ]);
    const tests = await reportEnnoWork(database, {
      ...identity, ...executionCredentials(catalog), expectedRevision: 2, idempotencyKey: 'code-catalog-work', workUnitId: 'catalog',
      result: { outcome: 'completed', summary: 'Converted the settings catalog', mutated: true, changedPaths: ['src/catalog.ts'] },
    });
    assert.equal(tests.ennoOduno.directive?.workUnit?.id, 'tests');
    assert.deepEqual(tests.ennoOduno.directive?.requiredSkills, ['kiokuko-soul']);
    const docs = await reportEnnoWork(database, {
      ...identity, ...executionCredentials(tests), expectedRevision: 2, idempotencyKey: 'code-tests-work', workUnitId: 'tests',
      result: { outcome: 'completed', summary: 'Added regression tests', mutated: true, changedPaths: ['tests/settings.test.ts'] },
    });
    assert.equal(docs.ennoOduno.directive?.workUnit?.id, 'docs');
    assert.deepEqual(docs.ennoOduno.directive?.requiredSkills, ['kiokuko-soul']);
    const residual = await reportEnnoWork(database, {
      ...identity, ...executionCredentials(docs), expectedRevision: 2, idempotencyKey: 'code-docs-work', workUnitId: 'docs',
      result: { outcome: 'completed', summary: 'Updated usage documentation', mutated: true, changedPaths: ['README.md'] },
    });
    assert.equal(residual.ennoOduno.directive?.workUnit?.id, 'residual');
    assert.deepEqual(residual.ennoOduno.directive?.requiredSkills, ['kiokuko-soul']);
    const reviewed = await reportEnnoWork(database, {
      ...identity, ...executionCredentials(residual), expectedRevision: 2, idempotencyKey: 'code-residual-work', workUnitId: 'residual',
      result: { outcome: 'completed', summary: 'Removed residual references', mutated: true, changedPaths: ['.gitignore'] },
    });
    assert.equal(reviewed.ennoOduno.status, 'enno_verifying');
    assert.deepEqual(reviewed.ennoOduno.directive?.requiredSkills, [
      'kiokuko-soul',
      'kiokuko-enno-oduno',
      'kiokuko-single-purpose-functions',
      'kiokuko-ui-design-soul',
    ]);
  } finally {
    database.close();
  }
});

test('an Enno plan blocks when the exact local kiokuko-soul capability is absent', async () => {
  const { root, database } = await fixture();
  try {
    const capabilitiesWithoutSoul = [
      { kind: 'skill', name: 'kiokuko_soul', description: 'A non-canonical alias must not satisfy the master contract.' },
      ...capabilities.filter((capability) => capability.name !== 'kiokuko-soul'),
    ];
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'enno-missing-soul', cwd: root, task: 'Repair the add function',
      profileHints: { taskType: 'debug', target: 'src/add.js', expected: 'tests pass', constraints: null },
      capabilities: capabilitiesWithoutSoul,
      client: { kind: 'opencode', sessionId: 'opencode-missing-soul' }, skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.nextAction, 'required_capability_unavailable');
    submitPreparedIdeal(database, prepared, 'missing-soul-ideal');
    const blocked = await submitEnnoPlan(database, {
      runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId,
      expectedRevision: 1, idempotencyKey: 'missing-soul-plan', scope: ['src/add.js'], exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Repair add', units: [{
        id: 'repair', objective: 'Repair add', scope: ['src/add.js'], dependencies: [], routes: ['code'], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the repair while testing the missing required Skill gate' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [], finalVerifiers: [verifier(prepared.project.repositoryRoot, 'missing-soul-final')], maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities: capabilitiesWithoutSoul,
    });
    assert.equal(blocked.ennoOduno.status, 'blocked');
    assert.equal(blocked.ennoOduno.nextAction, 'report_blocker');
    assert.match(database.prepare('SELECT blocker FROM enno_contracts WHERE run_id = ?')
      .get<{ blocker: string }>(prepared.run.runId)?.blocker ?? '', /Required Skills unavailable: kiokuko-soul/u);
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
      .get<{ status: string }>(prepared.run.runId)?.status, 'failed');
  } finally {
    database.close();
  }
});

test('run identity rejects cross-run progress while trusted repository routing crosses sessions and clients', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'enno-session-binding', cwd: root, task: 'Build a small module',
      profileHints: { taskType: 'build', target: 'src/module.js', expected: 'tests pass', constraints: null },
      capabilities, client: { kind: 'opencode', sessionId: 'opencode-owner' }, skillDiscoveryMode: 'off',
    });
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: 'not-owner' };
    await assert.rejects(submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'wrong-owner', scope: ['src/module.js'], exclusions: [],
      acceptanceCriteria: [{ id: 'test', description: 'tests pass' }],
      workPlan: { objective: 'Build module', units: [{
        id: 'build', objective: 'Build module', scope: ['src/module.js'], dependencies: [], routes: ['code'], skillNames: [],
        expertRefs: [{ id: 'code.domain.v1', reason: 'Implement the module as deterministic domain behavior' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] }, skillRequirements: [], finalVerifiers: [verifier(root, 'test')], maxAttempts: 2,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      }, capabilities,
    }), /does not own/u);
    assert.throws(() => decideAdapterContinuation(database, 'opencode', {
      session_id: 'outside-repository', cwd: path.dirname(root),
    }), /No repository root found/u);
    const sameClient = decideAdapterContinuation(database, 'opencode', { session_id: 'another-session', cwd: root });
    assert.equal(sameClient.continue, true);
    assert.equal(sameClient.runId, prepared.run.runId);
    const crossClient = decideAdapterContinuation(database, 'opencode', { session_id: 'opencode-local', cwd: root });
    assert.equal(crossClient.continue, true);
    assert.equal(crossClient.runId, prepared.run.runId);
  } finally {
    database.close();
  }
});

test('failed Enno review returns to Zenki for a revision-bound replan before Goki can resume', async () => {
  const { root, database } = await fixture();
  try {
    const marker = path.join(root, 'verification-ready');
    const conditional = {
      id: 'conditional-final', kind: 'test' as const, executable: process.execPath,
      args: ['--eval', `import('node:fs').then(({existsSync}) => process.exit(existsSync(${JSON.stringify(marker)}) ? 0 : 1))`],
      cwd: root, timeoutMs: 5000,
    };
    const planned = await plannedExecution(database, root, 'fresh-evidence', conditional);
    const { identity, repositoryRoot } = planned;
    await reportEnnoWork(database, {
      ...identity, ...executionCredentials(planned), expectedRevision: 2, idempotencyKey: 'fresh-work-1', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Initial repair', mutated: true, changedPaths: ['src/add.js'] },
    });
    const preparedFresh = await prepareEnnoVerification(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'fresh-prepare-1',
    });
    assert.equal(preparedFresh.verifierResults?.[0]?.status, 'failed');
    const failed = await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'fresh-finish-1',
      review: { decision: 'accept', summary: 'The implementation appears complete' },
    });
    assert.equal(failed.ennoOduno.status, 'zenki_planning');
    assert.equal(failed.ennoOduno.contractRevision, 3);
    assert.equal(failed.ennoOduno.currentRole, 'zenki');
    assert.equal(failed.ennoOduno.nextAction, 'submit_plan');
    assert.equal(failed.ennoOduno.directive?.workUnit, null);
    assert.ok(failed.ennoOduno.directive?.requiredSkills.includes('kiokuko-single-purpose-functions'));
    assert.match(failed.ennoOduno.directive?.objective ?? '', /review rejected contract revision 2/iu);
    assert.match(failed.ennoOduno.directive?.objective ?? '', /focused runnable test target/iu);
    assert.equal(failed.verifierResults?.[0]?.status, 'failed');

    const planningContinuation = decideAdapterContinuation(database, 'opencode', {
      session_id: 'opencode-fresh-evidence', cwd: root,
    });
    assert.equal(planningContinuation.continue, true);
    assert.equal(planningContinuation.directive?.role, 'zenki');
    await assert.rejects(reportEnnoWork(database, {
      ...identity, expectedRevision: 3, idempotencyKey: 'illegal-old-plan-resume', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Old plan cannot resume', mutated: false, changedPaths: [] },
    }), /not in the required state/iu);

    const replanned = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 3, idempotencyKey: 'fresh-replan',
      scope: ['src/add.js'], exclusions: [], acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Replan repair after Enno review', units: [{
        id: 'repair', objective: 'Repair the final verification failure', scope: ['src/add.js'], dependencies: [], routes: ['code'], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Address the failed final verifier with fresh evidence' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [], finalVerifiers: [{ ...conditional, cwd: '.' }], maxAttempts: 5,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(replanned.ennoOduno.status, 'goki_executing');
    assert.equal(replanned.ennoOduno.contractRevision, 4);
    assert.equal(replanned.ennoOduno.currentRole, 'goki');

    await writeFile(marker, 'ready\n');
    await reportEnnoWork(database, {
      ...identity, ...executionCredentials(replanned), expectedRevision: 4, idempotencyKey: 'fresh-work-2', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Repaired final failure', mutated: true, changedPaths: ['src/add.js'] },
    });
    const preparedRevision4 = await prepareEnnoVerification(database, {
      ...identity, expectedRevision: 4, idempotencyKey: 'fresh-prepare-2',
    });
    assert.equal(preparedRevision4.verifierResults?.[0]?.status, 'passed');
    const passed = await finishEnno(database, {
      ...identity, expectedRevision: 4, idempotencyKey: 'fresh-finish-2',
      review: { decision: 'accept', summary: 'The revised plan satisfies every criterion' },
    });
    assert.equal(passed.ennoOduno.status, 'oduno_meditation');
    const completed = submitMeditation(database, identity, 4, 'fresh-meditation');
    assert.equal(completed.ennoOduno.status, 'completed');
    const finalRuns = database.prepare(`
      SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision, status FROM enno_verifier_runs
      WHERE run_id = ? AND work_unit_id IS NULL ORDER BY started_at, verifier_run_id
    `).all<{ contractRevision: number; mutationRevision: number; status: string }>(identity.runId)
      .map((row) => ({ ...row }));
    assert.deepEqual(finalRuns, [
      { contractRevision: 2, mutationRevision: 1, status: 'failed' },
      { contractRevision: 4, mutationRevision: 2, status: 'passed' },
    ]);
    const workHistory = database.prepare(`
      SELECT contract_revision AS contractRevision, work_unit_id AS workUnitId, status
      FROM enno_work_units WHERE run_id = ? ORDER BY contract_revision
    `).all<{ contractRevision: number; workUnitId: string; status: string }>(identity.runId).map((row) => ({ ...row }));
    assert.deepEqual(workHistory, [
      { contractRevision: 2, workUnitId: 'repair', status: 'completed' },
      { contractRevision: 4, workUnitId: 'repair', status: 'completed' },
    ]);
    const loopEvents = database.prepare(`
      SELECT event_type AS eventType FROM ledger_events
      WHERE run_id = ? AND event_type IN (
        'enno.verification_failed', 'enno.replan_requested', 'zenki.plan_created',
        'goki.work_started', 'enno.review_accepted', 'enno.completed'
      ) ORDER BY sequence
    `).all<{ eventType: string }>(identity.runId).map((row) => row.eventType);
    assert.deepEqual(loopEvents, [
      'zenki.plan_created',
      'goki.work_started',
      'enno.verification_failed',
      'enno.replan_requested',
      'zenki.plan_created',
      'goki.work_started',
      'enno.review_accepted',
      'enno.completed',
    ]);
  } finally {
    database.close();
  }
});

test('Enno can reject passing verifier evidence and require Zenki to replan', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'review-rejects-pass', verifier(root, 'pass'));
    const { identity } = planned;
    await reportEnnoWork(database, {
      ...identity, ...executionCredentials(planned), expectedRevision: 2, idempotencyKey: 'review-reject-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Implemented the approved unit', mutated: true, changedPaths: ['src/add.js'] },
    });
    await prepareEnnoVerification(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'review-reject-prepare',
    });
    const rejected = await finishEnno(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'review-reject-finish',
      review: { decision: 'replan', summary: 'The public API acceptance criterion is not covered by the plan' },
    });
    assert.equal(rejected.verifierResults?.[0]?.status, 'passed');
    assert.equal(rejected.ennoOduno.status, 'zenki_planning');
    assert.equal(rejected.ennoOduno.contractRevision, 3);
    assert.equal(rejected.ennoOduno.directive?.role, 'zenki');
    assert.match(rejected.ennoOduno.directive?.objective ?? '', /public API acceptance criterion/iu);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type IN ('enno.review_accepted', 'enno.completed')
    `).get<{ count: number }>(identity.runId)?.count, 0);
    assert.deepEqual(database.prepare(`
      SELECT event_type AS eventType FROM ledger_events
      WHERE run_id = ? AND event_type IN ('enno.verification_passed', 'enno.replan_requested')
      ORDER BY sequence
    `).all<{ eventType: string }>(identity.runId).map((row) => row.eventType), [
      'enno.verification_passed',
      'enno.replan_requested',
    ]);
  } finally {
    database.close();
  }
});

test('replanning invalidates old final evidence and advisory digests', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'stale-final-review', verifier(root, 'stale-final'));
    await reportEnnoWork(database, {
      ...planned.identity, ...executionCredentials(planned), expectedRevision: 2, idempotencyKey: 'stale-initial-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Initial work is complete', mutated: false, changedPaths: [] },
    });
    await assert.rejects(finishEnno(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'unprepared-finish',
      review: { decision: 'accept', summary: 'Attempt to accept without prepared evidence' },
    }), /final verification evidence is not prepared/iu);
    assert.equal(readEnnoSnapshot(database, planned.identity).status, 'enno_verifying');
    const prepared = await prepareEnnoVerification(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'stale-initial-prepare',
    });
    const oldContext = prepared.ennoOduno.directive?.advisoryRound?.context;
    assert.ok(oldContext);
    const oldAdvice = submitEnnoAdvice(database, {
      ...planned.identity,
      expectedRevision: 2,
      mutationRevision: 0,
      idempotencyKey: 'stale-final-advice',
      phase: 'final_review',
      allowlistedContext: oldContext,
      contributions: advisoryContributions('final_review'),
    });
    assert.ok(oldAdvice.advisoryRound);
    const oldDigest = oldAdvice.advisoryRound.inputDigest;
    const replanned = await finishEnno(database, {
      ...planned.identity,
      expectedRevision: 2,
      idempotencyKey: 'stale-review-replan',
      advisoryRoundDigest: oldDigest,
      advisoryDisposition: advisoryDispositions('final_review'),
      review: { decision: 'replan', summary: 'Require a fresh contract review' },
    });
    assert.equal(replanned.ennoOduno.status, 'zenki_planning');
    assert.equal(replanned.ennoOduno.contractRevision, 3);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM enno_verifier_runs
      WHERE run_id = ? AND work_unit_id IS NULL AND contract_revision = 2 AND mutation_revision = 0
    `).get<{ count: number }>(planned.identity.runId)?.count, 1);

    const nextPlan = await submitEnnoPlan(database, {
      ...planned.identity,
      expectedRevision: 3,
      idempotencyKey: 'stale-replan-plan',
      scope: ['src/add.js'],
      exclusions: [],
      acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
      workPlan: { objective: 'Replan after stale review', units: [{
        id: 'repair', objective: 'Repair add with fresh review', scope: ['src/add.js'], dependencies: [], routes: ['code'], skillNames: [],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the revised contract with fresh evidence' }],
        acceptanceCriteria: ['tests pass'], focusedVerifiers: [],
      }] },
      skillRequirements: [],
      finalVerifiers: [verifier(planned.repositoryRoot, 'stale-final')],
      maxAttempts: 5,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
        workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(nextPlan.ennoOduno.status, 'goki_executing');
    assert.equal(nextPlan.ennoOduno.contractRevision, 4);
    await reportEnnoWork(database, {
      ...planned.identity, ...executionCredentials(nextPlan), expectedRevision: 4, idempotencyKey: 'stale-replanned-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Replanned work is complete', mutated: false, changedPaths: [] },
    });
    await assert.rejects(finishEnno(database, {
      ...planned.identity, expectedRevision: 4, idempotencyKey: 'stale-evidence-finish',
      review: { decision: 'accept', summary: 'Attempt to reuse old evidence' },
    }), /final verification evidence is not prepared/iu);
    assert.equal(readEnnoSnapshot(database, planned.identity).status, 'enno_verifying');

    const fresh = await prepareEnnoVerification(database, {
      ...planned.identity, expectedRevision: 4, idempotencyKey: 'stale-replanned-prepare',
    });
    assert.equal(fresh.verifierResults?.[0]?.status, 'passed');
    await assert.rejects(finishEnno(database, {
      ...planned.identity,
      expectedRevision: 4,
      idempotencyKey: 'stale-advisory-finish',
      advisoryRoundDigest: oldDigest,
      advisoryDisposition: advisoryDispositions('final_review'),
      review: { decision: 'accept', summary: 'Attempt to reuse old advisory digest' },
    }), /Enno input is invalid/iu);
    assert.equal(readEnnoSnapshot(database, planned.identity).status, 'enno_verifying');
    const finished = await finishEnno(database, {
      ...planned.identity, expectedRevision: 4, idempotencyKey: 'stale-fresh-finish',
      review: { decision: 'accept', summary: 'Accept newly prepared evidence' },
    });
    assert.equal(finished.ennoOduno.status, 'oduno_meditation');
  } finally {
    database.close();
  }
});

test('spawn failure blocks the run while continuation exhaustion only stops the current session', async () => {
  const first = await fixture();
  try {
    const unsafe = { ...verifier(first.root, 'missing'), executable: 'kiokuko-executable-that-does-not-exist' };
    const planned = await plannedExecution(first.database, first.root, 'spawn-failure', unsafe);
    const { identity } = planned;
    await reportEnnoWork(first.database, {
      ...identity, ...executionCredentials(planned), expectedRevision: 2, idempotencyKey: 'spawn-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Ready to verify', mutated: true, changedPaths: ['src/add.js'] },
    });
    const preparedUnsafe = await prepareEnnoVerification(first.database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'spawn-prepare',
    });
    assert.equal(preparedUnsafe.verifierResults?.[0]?.status, 'spawn_failed');
    const blocked = await finishEnno(first.database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'spawn-finish',
      review: { decision: 'accept', summary: 'The work is ready for final verification' },
    });
    assert.equal(blocked.ennoOduno.status, 'blocked');
    assert.equal(blocked.verifierResults?.[0]?.status, 'spawn_failed');
    assert.equal(first.database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(identity.runId)?.status, 'failed');
  } finally {
    first.database.close();
  }

  const second = await fixture();
  try {
    const planned = await plannedExecution(second.database, second.root, 'continuation-limit', verifier(second.root, 'pass'), { maxAttempts: 1 });
    assert.equal(decideAdapterContinuation(second.database, 'opencode', {
      session_id: planned.hostSessionId, terminalMessageId: 'limit-terminal-1', cwd: second.root,
    }).continue, true);
    const exhausted = decideAdapterContinuation(second.database, 'opencode', {
      session_id: planned.hostSessionId, terminalMessageId: 'limit-terminal-2', cwd: second.root,
    });
    assert.equal(exhausted.continue, false);
    assert.equal(exhausted.status, 'goki_executing');
    assert.match(exhausted.warning ?? '', /run remains active/iu);
    assert.equal(second.database.prepare('SELECT status FROM enno_contracts WHERE run_id = ?').get<{ status: string }>(planned.identity.runId)?.status, 'goki_executing');
    assert.equal(second.database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(planned.identity.runId)?.status, 'active');
    assert.throws(() => decideAdapterContinuation(second.database, 'opencode', {
      session_id: 'replacement-opencode-session', terminalMessageId: 'limit-terminal-3', cwd: second.root,
    }), /active Enno WorkUnit lease/iu);
  } finally {
    second.database.close();
  }
});

test('timeout final evidence cannot be accepted', async () => {
  const { root, database } = await fixture();
  try {
    const timeoutVerifier = {
      ...verifier(root, 'timeout-final'),
      args: ['--eval', 'setTimeout(() => {}, 1000)'],
      timeoutMs: 100,
    };
    const planned = await plannedExecution(database, root, 'timeout-final-review', timeoutVerifier);
    await reportEnnoWork(database, {
      ...planned.identity, ...executionCredentials(planned), expectedRevision: 2, idempotencyKey: 'timeout-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Ready for timeout verification', mutated: false, changedPaths: [] },
    });
    const verified = await prepareEnnoVerification(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'timeout-prepare',
    });
    assert.equal(verified.verifierResults?.[0]?.status, 'timeout');
    const rejected = await finishEnno(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'timeout-finish',
      review: { decision: 'accept', summary: 'Timeout evidence must not be accepted' },
    });
    assert.equal(rejected.ennoOduno.status, 'zenki_planning');
    assert.equal(rejected.ennoOduno.contractRevision, 3);
    assert.equal(rejected.verifierResults?.[0]?.status, 'timeout');
  } finally {
    database.close();
  }
});

test('focused verifier process can write the same database because no transaction is held while it runs', async () => {
  const { root, databasePath, database } = await fixture();
  try {
    database.exec('CREATE TABLE enno_lock_probe (value TEXT NOT NULL)');
    const probe = {
      id: 'lock-probe', kind: 'test' as const, executable: process.execPath,
      args: ['--eval', `import('node:sqlite').then(({DatabaseSync}) => { const db = new DatabaseSync(${JSON.stringify(databasePath)}); db.exec("INSERT INTO enno_lock_probe VALUES ('ok')"); db.close(); })`],
      cwd: root, timeoutMs: 5000,
    };
    const planned = await plannedExecution(database, root, 'no-db-lock', verifier(root, 'final'), { focusedVerifiers: [probe] });
    const { identity } = planned;
    const reported = await reportEnnoWork(database, {
      ...identity, ...executionCredentials(planned), expectedRevision: 2, idempotencyKey: 'lock-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Run lock probe', mutated: false, changedPaths: [] },
    });
    assert.equal(reported.verifierResults?.[0]?.status, 'passed');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_lock_probe').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('concurrent work reports allow only one revision-bound state transition', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'concurrent-cas', verifier(root, 'final'));
    const staleSnapshot = readEnnoSnapshot(database, planned.identity);
    const report = (idempotencyKey: string) => reportEnnoWork(database, {
      ...planned.identity,
      ...executionCredentials(planned),
      expectedRevision: 2,
      idempotencyKey,
      workUnitId: 'repair',
      result: {
        outcome: 'completed',
        summary: 'Concurrent completion candidate',
        mutated: false,
        changedPaths: [],
      },
    });
    const results = await Promise.allSettled([
      report('concurrent-cas-a'),
      report('concurrent-cas-b'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.match(String(rejected?.reason), /another Enno operation is already in progress|state changed concurrently|expected goki_executing|not active/iu);
    const snapshot = readEnnoSnapshot(database, planned.identity);
    assert.equal(snapshot.status, 'enno_verifying');
    assert.equal(snapshot.attempts, 0);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events
      WHERE run_id = ? AND event_type = 'goki.work_completed'
    `).get<{ count: number }>(planned.identity.runId)?.count, 1);
    assert.throws(() => withImmediateTransaction(database, () => updateContractInTransaction(database, staleSnapshot, {
      contract: staleSnapshot.contract,
      status: 'blocked',
      confirmationState: staleSnapshot.confirmationState,
      blocker: 'stale concurrent writer',
    })), /Enno state changed concurrently/u);
  } finally {
    database.close();
  }
});

test('expired operation and verifier owners are abandoned before an atomic reclaim', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'crash-recovery', verifier(root, 'crash-recovery-final'));
    const operation = {
      operation: 'verify_prepare' as const,
      idempotencyKey: 'crashed-verification',
      requestDigest: 'a'.repeat(64),
    };
    const firstOwner = withImmediateTransaction(database, () => startOperationInTransaction(
      database,
      planned.identity.runId,
      operation,
    ));
    database.prepare(`
      UPDATE enno_operation_receipts SET lease_expires_at = ?
      WHERE run_id = ? AND operation = ? AND idempotency_key = ?
    `).run('2000-01-01T00:00:00.000Z', planned.identity.runId, operation.operation, operation.idempotencyKey);
    assert.equal(readOperationReceipt(database, planned.identity.runId, operation), undefined);
    assert.equal(database.prepare(`
      SELECT state FROM enno_operation_receipts
      WHERE run_id = ? AND operation = ? AND idempotency_key = ?
    `).get<{ state: string }>(planned.identity.runId, operation.operation, operation.idempotencyKey)?.state, 'abandoned');
    assert.throws(() => readOperationReceipt(database, planned.identity.runId, {
      ...operation,
      requestDigest: 'b'.repeat(64),
    }), /different input/iu);
    const secondOwner = withImmediateTransaction(database, () => startOperationInTransaction(
      database,
      planned.identity.runId,
      operation,
    ));
    assert.notEqual(secondOwner, firstOwner);
    assert.throws(() => completeOperationInTransaction(
      database,
      planned.identity.runId,
      operation,
      firstOwner,
      { stale: true },
    ), /receipt changed concurrently/iu);
    withImmediateTransaction(database, () => completeOperationInTransaction(
      database,
      planned.identity.runId,
      operation,
      secondOwner,
      { recovered: true },
    ));
    assert.deepEqual(readOperationReceipt(database, planned.identity.runId, operation), { recovered: true });

    const snapshot = readEnnoSnapshot(database, planned.identity);
    const abandonedVerifierIds = startVerifierRunsInTransaction(database, {
      runId: planned.identity.runId,
      workUnitId: null,
      revision: snapshot.revision,
      mutationRevision: snapshot.mutationRevision,
      verifiers: snapshot.contract.finalVerifiers,
    });
    const abandonedVerifierId = abandonedVerifierIds[0];
    assert.ok(abandonedVerifierId);
    database.prepare(`
      UPDATE enno_verifier_runs SET lease_expires_at = ?
      WHERE verifier_run_id = ?
    `).run('2000-01-01T00:00:00.000Z', abandonedVerifierId);
    const reclaimedVerifierIds = startVerifierRunsInTransaction(database, {
      runId: planned.identity.runId,
      workUnitId: null,
      revision: snapshot.revision,
      mutationRevision: snapshot.mutationRevision,
      verifiers: snapshot.contract.finalVerifiers,
    });
    const reclaimedVerifierId = reclaimedVerifierIds[0];
    assert.ok(reclaimedVerifierId);
    assert.equal(database.prepare('SELECT status FROM enno_verifier_runs WHERE verifier_run_id = ?')
      .get<{ status: string }>(abandonedVerifierId)?.status, 'abandoned');
    assert.equal(database.prepare('SELECT status FROM enno_verifier_runs WHERE verifier_run_id = ?')
      .get<{ status: string }>(reclaimedVerifierId)?.status, 'started');
  } finally {
    database.close();
  }
});

test('work-report secrets are sanitized before result, event, and receipt persistence', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'work-secret-sanitization', verifier(root, 'work-secret-final'));
    const secret = 'password=supersecretvalue12345';
    const response = await reportEnnoWork(database, {
      ...planned.identity,
      ...executionCredentials(planned),
      expectedRevision: 2,
      idempotencyKey: 'work-secret-report',
      workUnitId: 'repair',
      result: { outcome: 'completed', summary: `Completed with ${secret}`, mutated: false, changedPaths: [] },
    });
    assert.equal(response.ennoOduno.status, 'enno_verifying');
    const persisted = {
      workUnit: database.prepare(`
        SELECT result_json AS value FROM enno_work_units
        WHERE run_id = ? AND work_unit_id = 'repair'
      `).get<{ value: string }>(planned.identity.runId)?.value,
      event: database.prepare(`
        SELECT payload_json AS value FROM ledger_events
        WHERE run_id = ? AND event_type = 'goki.work_completed'
        ORDER BY sequence DESC LIMIT 1
      `).get<{ value: string }>(planned.identity.runId)?.value,
      receipt: database.prepare(`
        SELECT response_json AS value FROM enno_operation_receipts
        WHERE run_id = ? AND idempotency_key = 'work-secret-report'
      `).get<{ value: string }>(planned.identity.runId)?.value,
      blocker: database.prepare('SELECT blocker AS value FROM enno_contracts WHERE run_id = ?')
        .get<{ value: string | null }>(planned.identity.runId)?.value,
    };
    const serialized = JSON.stringify(persisted);
    assert.equal(serialized.includes(secret), false);
    assert.match(serialized, /REDACTED/iu);
  } finally {
    database.close();
  }
});

test('final verifier evidence is reused for the same revision and mutation without a second subprocess', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'final-evidence-replay', verifier(root, 'final-replay'));
    await reportEnnoWork(database, {
      ...planned.identity, ...executionCredentials(planned), expectedRevision: 2, idempotencyKey: 'final-replay-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Prepared final verification', mutated: false, changedPaths: [] },
    });
    const current = readEnnoSnapshot(database, planned.identity);
    const verifierSpec = current.contract.finalVerifiers[0]!;
    const repositoryState = captureRepositoryState(current.repositoryRoot);
    const verifierRunIds = startVerifierRunsInTransaction(database, {
      runId: planned.identity.runId,
      workUnitId: null,
      revision: current.revision,
      mutationRevision: current.mutationRevision,
      verifiers: current.contract.finalVerifiers,
      repositoryEvidence: {
        policyVersion: repositoryState.policyVersion,
        preDigest: repositoryState.digest,
        verifierSpecDigest: canonicalContentHash(current.contract.finalVerifiers),
      },
    });
    finishVerifierRunsInTransaction(database, verifierRunIds, [{
      verifier: verifierSpec,
      status: 'passed',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutPreview: '',
      stderrPreview: '',
      stdoutDigest: '0'.repeat(64),
      stderrDigest: '0'.repeat(64),
    }], { postDigest: repositoryState.digest, changedDuringVerification: false });
    let spawnCalls = 0;
    const finished = await finishEnno(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'final-replay-finish',
      review: { decision: 'accept', summary: 'Reuse the fresh final evidence' },
    }, {
      spawn: (() => {
        spawnCalls += 1;
        throw new Error('final verifier must not be started again');
      }) as never,
    });
    assert.equal(finished.ennoOduno.status, 'oduno_meditation');
    assert.equal(finished.verifierResults?.[0]?.status, 'passed');
    assert.equal(spawnCalls, 0);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM enno_verifier_runs
      WHERE run_id = ? AND work_unit_id IS NULL AND contract_revision = ? AND mutation_revision = ?
    `).get<{ count: number }>(planned.identity.runId, current.revision, current.mutationRevision)?.count, 1);
  } finally {
    database.close();
  }
});

test('final verification preparation reuses fresh evidence across keys and finish never spawns', async () => {
  const { root, database } = await fixture();
  try {
    const planned = await plannedExecution(database, root, 'final-evidence-cross-key', verifier(root, 'final-cross-key'));
    await reportEnnoWork(database, {
      ...planned.identity, ...executionCredentials(planned), expectedRevision: 2, idempotencyKey: 'cross-key-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Prepared final verification', mutated: false, changedPaths: [] },
    });
    let spawnCalls = 0;
    const countingSpawn = ((...args: unknown[]) => {
      spawnCalls += 1;
      return (nodeSpawn as unknown as (...items: unknown[]) => ReturnType<typeof nodeSpawn>)(...args);
    }) as unknown as typeof nodeSpawn;
    const first = await prepareEnnoVerification(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'cross-key-prepare-1',
    }, { spawn: countingSpawn });
    assert.equal(first.verifierResults?.[0]?.status, 'passed');
    assert.equal(spawnCalls, 1);
    const second = await prepareEnnoVerification(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'cross-key-prepare-2',
    }, { spawn: countingSpawn });
    assert.deepEqual(second.verifierResults, first.verifierResults);
    assert.equal(spawnCalls, 1);
    const finished = await finishEnno(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'cross-key-finish',
      review: { decision: 'accept', summary: 'Fresh evidence is sufficient' },
    }, { spawn: countingSpawn });
    assert.equal(finished.ennoOduno.status, 'oduno_meditation');
    assert.equal(spawnCalls, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM enno_verifier_runs
      WHERE run_id = ? AND work_unit_id IS NULL AND contract_revision = 2 AND mutation_revision = 0
    `).get<{ count: number }>(planned.identity.runId)?.count, 1);
  } finally {
    database.close();
  }
});

test('final evidence is invalidated by repository changes after preparation', async () => {
  const { root, database } = await fixture();
  try {
    await writeFile(path.join(root, 'tracked.js'), 'export const value = 1;\n');
    execFileSync('git', ['-C', root, 'add', 'tracked.js']);
    const planned = await plannedExecution(database, root, 'repository-evidence-stale', verifier(root, 'repository-evidence-final'));
    await reportEnnoWork(database, {
      ...planned.identity, ...executionCredentials(planned), expectedRevision: 2,
      idempotencyKey: 'repository-evidence-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Prepared work for repository evidence', mutated: false, changedPaths: [] },
    });
    const prepared = await prepareEnnoVerification(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'repository-evidence-prepare',
    });
    assert.equal(prepared.verifierResults?.[0]?.status, 'passed');
    assert.equal(prepared.verifierResults?.[0]?.changedDuringVerification, false);
    await writeFile(path.join(root, 'tracked.js'), 'export const value = 2;\n');
    await assert.rejects(finishEnno(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'repository-evidence-finish',
      review: { decision: 'accept', summary: 'Attempt to accept stale evidence' },
    }), /final verification evidence is not prepared/iu);
    assert.equal(readEnnoSnapshot(database, planned.identity).status, 'enno_verifying');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM enno_operation_receipts WHERE run_id = ? AND operation = 'finish'")
      .get<{ count: number }>(planned.identity.runId)?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ? AND event_type = 'enno.review_started'")
      .get<{ count: number }>(planned.identity.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('a verifier that mutates repository state cannot produce acceptable final evidence', async () => {
  const { root, database } = await fixture();
  try {
    const mutatingVerifier = {
      id: 'mutating-final',
      kind: 'test' as const,
      executable: process.execPath,
      args: ['--eval', "require('node:fs').writeFileSync('verifier-mutated.txt', 'changed')"],
      cwd: '.',
      timeoutMs: 5_000,
    };
    const planned = await plannedExecution(database, root, 'repository-evidence-mutation', mutatingVerifier);
    await reportEnnoWork(database, {
      ...planned.identity, ...executionCredentials(planned), expectedRevision: 2,
      idempotencyKey: 'repository-mutation-work', workUnitId: 'repair',
      result: { outcome: 'completed', summary: 'Prepared work for a mutating verifier', mutated: false, changedPaths: [] },
    });
    const prepared = await prepareEnnoVerification(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'repository-mutation-prepare',
    });
    assert.equal(prepared.verifierResults?.[0]?.status, 'passed');
    assert.equal(prepared.verifierResults?.[0]?.changedDuringVerification, true);
    assert.equal(readEnnoSnapshot(database, planned.identity).finalEvidenceReady, false);
    await assert.rejects(finishEnno(database, {
      ...planned.identity, expectedRevision: 2, idempotencyKey: 'repository-mutation-finish',
      review: { decision: 'accept', summary: 'Mutating verifier evidence must be rejected' },
    }), /final verification evidence is not prepared/iu);
  } finally {
    database.close();
  }
});
