import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { advisoryInputDigest } from '../../src/enno-oduno/advisory.js';
import { readPendingEnnoAdvice, submitEnnoAdvice, submitOdunoIdeal } from '../../src/enno-oduno/service.js';
import { readEnnoSnapshot } from '../../src/enno-oduno/store.js';
import { ADVISORY_SLOT_DEFINITIONS } from '../../src/enno-oduno/types.js';

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Routes work.' },
  { kind: 'skill', name: 'kiokuko-single-purpose-functions', description: 'Code contracts.' },
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-advisory-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-advisory-db-'));
  const databasePath = path.join(databaseDirectory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const prepared = await prepareOpenCodeTask(database, {
    requestId: 'advisory-request',
    cwd: root,
    task: 'Repair the add function',
    profileHints: { taskType: 'debug', target: 'src/add.ts', expected: 'tests pass', constraints: null },
    capabilities,
    client: { kind: 'opencode', sessionId: 'opencode-advisory' },
    skillDiscoveryMode: 'off',
  });
  return { root, database, databasePath, prepared };
}

function identity(prepared: Awaited<ReturnType<typeof prepareOpenCodeTask>>) {
  return {
    runId: prepared.run.runId,
    workspace: prepared.project.workspace,
    orchestrationId: prepared.intake.sessionId,
  };
}

function completed(slotId: string, summary = `Completed ${slotId}`) {
  return { slotId, outcome: 'completed' as const, summary, recommendations: [`Recommendation from ${slotId}`], risks: [], evidence: [] };
}

function unavailable(slotId: string) {
  return { slotId, outcome: 'unavailable' as const, reasonCode: 'host_read_only_unavailable' as const };
}

test('advisory directives are host-mediated and omit every Enno identity from advisor input', async () => {
  const { database, prepared } = await fixture();
  try {
    const directive = prepared.ennoOduno.directive?.advisoryRound;
    assert.ok(directive);
    assert.equal(directive.phase, 'ideal');
    assert.equal(directive.readOnlyRequired, true);
    assert.equal(directive.hostMustVerifyIsolation, true);
    assert.deepEqual(directive.slots.map((slot) => slot.slotId), [
      'constraint_guardian', 'skill_trust_analyst', 'success_signal_critic',
    ]);
    const serialized = JSON.stringify(directive);
    for (const forbidden of [prepared.run.runId, prepared.project.workspace, prepared.intake.sessionId, 'idempotencyKey', 'contractRevision', 'mutationRevision']) {
      assert.equal(serialized.includes(forbidden), false, `advisor input leaked ${forbidden}`);
    }
  } finally {
    database.close();
  }
});

test('advice submission sorts fixed slots, persists mutation revision zero, and exact-replays', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const input = {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-first',
      phase: 'ideal' as const,
      allowlistedContext: context,
      contributions: [completed('success_signal_critic'), completed('constraint_guardian'), completed('skill_trust_analyst')],
    };
    const first = submitEnnoAdvice(database, input);
    assert.equal(first.ennoOduno.status, 'oduno_ideal');
    assert.equal(first.advisoryRound?.degraded, false);
    assert.equal(first.advisoryRound?.source, 'host_reported');
    assert.deepEqual(first.advisoryRound?.contributions.map((item) => item.slotId), [
      'constraint_guardian', 'skill_trust_analyst', 'success_signal_critic',
    ]);
    const storedRound = database.prepare('SELECT mutation_revision AS mutationRevision, source FROM enno_advisory_rounds').get<{ mutationRevision: number; source: string }>();
    assert.equal(storedRound?.mutationRevision, 0);
    assert.equal(storedRound?.source, 'host_reported');
    const replay = submitEnnoAdvice(database, input);
    assert.deepEqual(replay, first);
    assert.throws(() => submitEnnoAdvice(database, { ...input, contributions: [completed('constraint_guardian', 'changed'), completed('skill_trust_analyst'), completed('success_signal_critic')] }), /idempotency/u);
  } finally {
    database.close();
  }
});

test('pending advisory read restores the exact aggregate after reopen without writes', async () => {
  const { database, databasePath, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const submitted = submitEnnoAdvice(database, {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-read-source',
      phase: 'ideal',
      allowlistedContext: context,
      contributions: [completed('constraint_guardian'), completed('skill_trust_analyst'), completed('success_signal_critic')],
    });
    const digest = submitted.advisoryRound!.inputDigest;
    const counts = () => ({
      contracts: database.prepare('SELECT COUNT(*) AS count FROM enno_contracts').get<{ count: number }>()?.count,
      rounds: database.prepare('SELECT COUNT(*) AS count FROM enno_advisory_rounds').get<{ count: number }>()?.count,
      contributions: database.prepare('SELECT COUNT(*) AS count FROM enno_advisory_contributions').get<{ count: number }>()?.count,
      receipts: database.prepare('SELECT COUNT(*) AS count FROM enno_operation_receipts').get<{ count: number }>()?.count,
      events: database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count,
      verifiers: database.prepare('SELECT COUNT(*) AS count FROM enno_verifier_runs').get<{ count: number }>()?.count,
    });
    const before = counts();
    const first = readPendingEnnoAdvice(database, { ...id, expectedRevision: 1, advisoryRoundDigest: digest });
    assert.equal(first.protocolVersion, 1);
    assert.deepEqual(first.advisoryRound, submitted.advisoryRound);
    assert.deepEqual(first.allowlistedContext, context);
    assert.deepEqual(counts(), before);

    database.close();
    const reopened = openConnection(databasePath);
    try {
      const restored = readPendingEnnoAdvice(reopened, { ...id, expectedRevision: 1, advisoryRoundDigest: digest });
      assert.deepEqual(restored, first);
      assert.equal(JSON.stringify(restored).includes('provider'), false);
      assert.equal(JSON.stringify(restored).includes('model'), false);
    } finally {
      reopened.close();
    }
  } catch (error) {
    try { database.close(); } catch { /* already closed after reopen check */ }
    throw error;
  }
});

test('pending advisory read rejects stale identity, revision, digest, and non-advisory phase', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const submitted = submitEnnoAdvice(database, {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-read-boundary',
      phase: 'ideal',
      allowlistedContext: context,
      contributions: [completed('constraint_guardian'), completed('skill_trust_analyst'), completed('success_signal_critic')],
    });
    const digest = submitted.advisoryRound!.inputDigest;
    assert.throws(() => readPendingEnnoAdvice(database, { ...id, expectedRevision: 2, advisoryRoundDigest: digest }), /contract revision changed/iu);
    assert.throws(() => readPendingEnnoAdvice(database, { ...id, expectedRevision: 1, advisoryRoundDigest: '0'.repeat(64) }), /Enno input is invalid/iu);
    assert.throws(() => readPendingEnnoAdvice(database, { ...id, runId: 'other-run', expectedRevision: 1, advisoryRoundDigest: digest }), /run was not found|CONFLICT|invalid/iu);
    assert.throws(() => readPendingEnnoAdvice(database, { ...id, expectedRevision: 1, workspace: 'other-workspace', advisoryRoundDigest: digest }), /run was not found|CONFLICT|invalid/iu);
    assert.throws(() => readPendingEnnoAdvice(database, { ...id, expectedRevision: 1, orchestrationId: 'other-session', advisoryRoundDigest: digest }), /run was not found|session does not own|CONFLICT|invalid/iu);
  } finally {
    database.close();
  }
});

test('secret-shaped advisor output is persisted only as unsafe_output and unavailable slots remain auditable', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const result = submitEnnoAdvice(database, {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-unsafe',
      phase: 'ideal',
      allowlistedContext: context,
      contributions: [
        { ...completed('constraint_guardian'), recommendations: ['Run --api-key value'] },
        unavailable('skill_trust_analyst'),
        unavailable('success_signal_critic'),
      ],
    });
    assert.deepEqual(result.advisoryRound?.contributions, [
      { slotId: 'constraint_guardian', outcome: 'failed', reasonCode: 'unsafe_output' },
      { slotId: 'skill_trust_analyst', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
      { slotId: 'success_signal_critic', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
    ]);
    assert.equal(result.advisoryRound?.degraded, true);
    assert.equal(database.prepare('SELECT contribution_json FROM enno_advisory_contributions WHERE slot_id = ?').get<{ contribution_json: string }>('constraint_guardian')?.contribution_json.includes('--api-key'), false);
  } finally {
    database.close();
  }
});

test('parent-host timeout is persisted as a bounded slot outcome without starting verifier work', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const result = submitEnnoAdvice(database, {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-host-timeout',
      phase: 'ideal',
      allowlistedContext: context,
      contributions: [
        { slotId: 'constraint_guardian', outcome: 'timeout', reasonCode: 'host_timeout' },
        { slotId: 'skill_trust_analyst', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
        completed('success_signal_critic'),
      ],
    });
    assert.deepEqual(result.advisoryRound?.contributions.map((contribution) => ({
      slotId: contribution.slotId,
      outcome: contribution.outcome,
      reasonCode: contribution.reasonCode,
    })), [
      { slotId: 'constraint_guardian', outcome: 'timeout', reasonCode: 'host_timeout' },
      { slotId: 'skill_trust_analyst', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
      { slotId: 'success_signal_critic', outcome: 'completed', reasonCode: undefined },
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_verifier_runs').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE event_type LIKE 'goki.%'").get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('advice round digest binds the allowlisted context and is consumed by the existing ideal submit', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const digest = advisoryInputDigest({ phase: 'ideal', contractRevision: 1, mutationRevision: 0, allowlistedContext: context });
    submitEnnoAdvice(database, {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-consume',
      phase: 'ideal',
      allowlistedContext: context,
      contributions: ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === 'ideal').map((slot) => completed(slot.slotId)),
    });
    assert.throws(() => submitOdunoIdeal(database, {
      ...id,
      expectedRevision: 1,
      idempotencyKey: 'ideal-secret-disposition',
      advisoryRoundDigest: digest,
      advisoryDisposition: [
        { slotId: 'constraint_guardian', disposition: 'adopted', rationale: '--api-key abcdefghijkl' },
        { slotId: 'skill_trust_analyst', disposition: 'not_adopted', rationale: 'Guide is reference-only' },
        { slotId: 'success_signal_critic', disposition: 'adopted', rationale: 'Signals are accepted' },
      ],
      ideal: {
        objective: 'Reach the verified repair outcome',
        principles: ['Preserve the request constraints'],
        skillContributions: prepared.skillDiscovery.selected.map((skill) => ({ skillName: skill.name, contribution: `Use ${skill.name} as reference-only guidance` })),
        successSignals: ['tests pass'],
      },
    }), /Enno input is invalid/iu);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM enno_operation_receipts WHERE idempotency_key = 'ideal-secret-disposition'").get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE event_type = 'enno.advice_disposition'").get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare("SELECT state FROM enno_advisory_rounds WHERE phase = 'ideal'").get<{ state: string }>()?.state, 'aggregated');
    const afterRejectedConsumption = readEnnoSnapshot(database, id);
    assert.equal(afterRejectedConsumption.advisoryPhaseState?.state, 'aggregated');
    assert.equal(afterRejectedConsumption.finalEvidenceReady, false);
    assert.equal(afterRejectedConsumption.status, 'oduno_ideal');
    assert.equal(afterRejectedConsumption.advisoryPhaseState?.state === 'aggregated'
      ? afterRejectedConsumption.advisoryPhaseState.inputDigest
      : null, digest);
    assert.equal(afterRejectedConsumption.advisoryPhaseState?.state === 'aggregated'
      ? afterRejectedConsumption.advisoryPhaseState.requiredDispositionSlots.length
      : 0, 3);
    assert.equal(afterRejectedConsumption.advisoryPhaseState?.state === 'aggregated'
      ? afterRejectedConsumption.advisoryPhaseState.requiredDispositionSlots.every((slot) => slot.allowedDispositions.length > 0)
      : false, true);
    const ideal = submitOdunoIdeal(database, {
      ...id,
      expectedRevision: 1,
      idempotencyKey: 'ideal-after-advice',
      advisoryRoundDigest: digest,
      advisoryDisposition: [
        { slotId: 'constraint_guardian', disposition: 'adopted', rationale: 'Accepts the constraint guard' },
        { slotId: 'skill_trust_analyst', disposition: 'not_adopted', rationale: 'Guide is reference-only' },
        { slotId: 'success_signal_critic', disposition: 'adopted', rationale: 'Signals are accepted' },
      ],
      ideal: {
        objective: 'Reach the verified repair outcome',
        principles: ['Preserve the request constraints'],
        skillContributions: prepared.skillDiscovery.selected.map((skill) => ({ skillName: skill.name, contribution: `Use ${skill.name} as reference-only guidance` })),
        successSignals: ['tests pass'],
      },
    });
    assert.equal(ideal.ennoOduno.status, 'zenki_planning');
    assert.equal(database.prepare("SELECT state FROM enno_advisory_rounds WHERE phase = 'ideal'").get<{ state: string }>()?.state, 'consumed');
  } finally {
    database.close();
  }
});

test('advice rejects control-bearing and oversized structured text at the boundary', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const base = {
      ...id,
      expectedRevision: 1,
      mutationRevision: 0,
      idempotencyKey: 'advice-boundary',
      phase: 'ideal' as const,
      allowlistedContext: context,
      contributions: [completed('constraint_guardian'), completed('skill_trust_analyst'), completed('success_signal_critic')],
    };
    assert.throws(() => submitEnnoAdvice(database, { ...base, contributions: [{ ...completed('constraint_guardian'), summary: 'bad\nvalue' }, base.contributions[1], base.contributions[2]] }), /invalid/u);
    assert.throws(() => submitEnnoAdvice(database, { ...base, contributions: [{ ...completed('constraint_guardian'), summary: 'あ'.repeat(20_000) }, base.contributions[1], base.contributions[2]] }), /invalid/u);
  } finally {
    database.close();
  }
});

test('a submitted advisory round cannot advance the phase without its digest and disposition', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const contributions = ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === 'ideal').map((slot) => completed(slot.slotId));
    submitEnnoAdvice(database, {
      ...id, expectedRevision: 1, mutationRevision: 0, idempotencyKey: 'adv-omitted', phase: 'ideal', allowlistedContext: context, contributions,
    });
    assert.throws(() => submitOdunoIdeal(database, {
      ...id, expectedRevision: 1, idempotencyKey: 'ideal-no-digest',
      ideal: { objective: 'Reach a verified outcome', principles: ['Preserve constraints'], skillContributions: [], successSignals: ['tests pass'] },
    }), /Enno input is invalid/iu);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE event_type = 'enno.advice_disposition'").get<{ count: number }>()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test('same-round different-key identical contributions replay and differing contributions conflict', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const contributions = ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === 'ideal').map((slot) => completed(slot.slotId));
    const first = submitEnnoAdvice(database, {
      ...id, expectedRevision: 1, mutationRevision: 0, idempotencyKey: 'collide-a', phase: 'ideal', allowlistedContext: context, contributions,
    });
    const replayed = submitEnnoAdvice(database, {
      ...id, expectedRevision: 1, mutationRevision: 0, idempotencyKey: 'collide-b', phase: 'ideal', allowlistedContext: context, contributions,
    });
    assert.deepEqual(replayed, first);
    assert.throws(() => submitEnnoAdvice(database, {
      ...id, expectedRevision: 1, mutationRevision: 0, idempotencyKey: 'collide-c', phase: 'ideal', allowlistedContext: context,
      contributions: [completed('constraint_guardian', 'changed'), contributions[1], contributions[2]],
    }), /different contributions/iu);
  } finally {
    database.close();
  }
});

test('stored contribution corruption is rejected as INTEGRITY_ERROR without re-exposure', async () => {
  const { database, prepared } = await fixture();
  try {
    const id = identity(prepared);
    const context = prepared.ennoOduno.directive!.advisoryRound!.context;
    const contributions = ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === 'ideal').map((slot) => completed(slot.slotId));
    submitEnnoAdvice(database, {
      ...id, expectedRevision: 1, mutationRevision: 0, idempotencyKey: 'corrupt-a', phase: 'ideal', allowlistedContext: context, contributions,
    });
    database.prepare(`
      UPDATE enno_advisory_contributions
      SET contribution_json = ? WHERE slot_id = 'constraint_guardian'
    `).run(JSON.stringify({ slotId: 'constraint_guardian', outcome: 'completed', summary: 'corrupt', recommendations: [], risks: [], evidence: [], bogus: true }));
    assert.throws(() => submitEnnoAdvice(database, {
      ...id, expectedRevision: 1, mutationRevision: 0, idempotencyKey: 'corrupt-b', phase: 'ideal', allowlistedContext: context, contributions,
    }), /Stored advisory contribution is invalid/iu);
  } finally {
    database.close();
  }
});
