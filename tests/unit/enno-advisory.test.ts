import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advisoryContextForSnapshot,
  advisoryDirectiveForSnapshot,
  advisoryInputDigest,
  advisoryPhaseForStatus,
  advisoryRoundAggregate,
  advisorySlotDefinitions,
  normalizeAdvisoryContributions,
  projectRepositoryRelativePath,
} from '../../src/enno-oduno/advisory.js';
import { advisoryContributionSchemaPublic, parseStoredAdvisoryContribution } from '../../src/enno-oduno/schemas.js';
import { directiveForRun } from '../../src/enno-oduno/directives.js';
import { canonicalJson } from '../../src/serialization/validate.js';
import {
  ADVISORY_FAILURE_CODES,
  ADVISORY_MAX_ROUND_BYTES,
  ADVISORY_MAX_SLOT_BYTES,
  ADVISORY_SLOT_DEFINITIONS,
  type AdvisoryContribution,
  type AdvisoryPhase,
  type AdvisorySlotId,
  type EnnoRunSnapshot,
  type SkillSetEntry,
  type VerifierRunResult,
  type VerifierSpec,
} from '../../src/enno-oduno/types.js';

const REPOSITORY_ROOT = '/repo';

function phaseSlotIds(phase: AdvisoryPhase): AdvisorySlotId[] {
  return ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === phase).map((slot) => slot.slotId);
}

function completed(slotId: AdvisorySlotId, summary = 'ok', overrides: Partial<AdvisoryContribution> = {}): AdvisoryContribution {
  return { slotId, outcome: 'completed', summary, recommendations: [], risks: [], evidence: [], ...overrides };
}

function failed(slotId: AdvisorySlotId, reasonCode: AdvisoryContribution['reasonCode'] = 'invalid_response'): AdvisoryContribution {
  return { slotId, outcome: 'failed', reasonCode };
}

function advisoryContributions(phase: AdvisoryPhase, build: (slotId: AdvisorySlotId) => AdvisoryContribution): AdvisoryContribution[] {
  return phaseSlotIds(phase).map((slotId) => build(slotId));
}

function verifier(id: string, overrides: Partial<VerifierSpec> = {}): VerifierSpec {
  return {
    id,
    kind: 'test',
    executable: 'node',
    args: ['run', 'test'],
    cwd: '.',
    timeoutMs: 5_000,
    ...overrides,
  };
}

function skillEntry(name: string, availability: SkillSetEntry['availability'], required = false): SkillSetEntry {
  return { name, purposes: ['planning'], required, availability, referenceId: availability === 'external_reference' ? 'ext-1' : null };
}

function verifierResult(id: string, overrides: Partial<VerifierRunResult> = {}): VerifierRunResult {
  return {
    verifier: verifier(id),
    status: 'passed',
    exitCode: 0,
    signal: null,
    durationMs: 12,
    stdoutPreview: 'raw stdout must never be projected',
    stderrPreview: 'raw stderr must never be projected',
    stdoutDigest: 'a'.repeat(64),
    stderrDigest: 'b'.repeat(64),
    repositoryStatePolicyVersion: 1,
    repositoryStateDigest: 'c'.repeat(64),
    changedDuringVerification: false,
    ...overrides,
  };
}

function snapshot(overrides: {
  status?: EnnoRunSnapshot['status'];
  ideal?: EnnoRunSnapshot['ideal'] | null;
  mutationRevision?: number;
  finalEvidenceReady?: boolean;
  finalEvidence?: VerifierRunResult[];
  workUnits?: EnnoRunSnapshot['workUnits'];
  skillEntries?: SkillSetEntry[];
  advisoryPhaseState?: EnnoRunSnapshot['advisoryPhaseState'];
} = {}): EnnoRunSnapshot {
  const contract: EnnoRunSnapshot['contract'] = {
    revision: 2,
    scope: ['src/api.ts'],
    exclusions: ['docs/'],
    acceptanceCriteria: [{ id: 'tests', description: 'Focused tests pass' }],
    workPlan: {
      objective: 'Build the API projection',
      units: [
        {
          id: 'unit-alpha',
          objective: 'Create the projection module',
          scope: ['src/api.ts'],
          dependencies: [],
          routes: ['code'], skillNames: ['kiokuko-soul'],
          expertRefs: [{ id: 'code.domain.v1', reason: 'deterministic mapping rules' }],
          acceptanceCriteria: ['Projection is deterministic'],
          focusedVerifiers: [verifier('alpha-check')],
        },
      ],
    },
    skillSet: {
      entries: overrides.skillEntries ?? [
        skillEntry('kiokuko-soul', 'local', true),
        skillEntry('external-guide', 'external_reference'),
        skillEntry('imported-guide', 'imported_fresh'),
        skillEntry('missing-guide', 'unavailable'),
      ],
      intakeDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
      zenkiDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
    },
    finalVerifiers: [verifier('final-check')],
    maxAttempts: 8,
    provenance: {
      scope: 'inferred', exclusions: 'inferred', acceptanceCriteria: 'inferred',
      workPlan: 'inferred', skillSet: 'inferred', finalVerifiers: 'inferred', maxAttempts: 'inferred',
    },
  };
  const ideal = overrides.ideal === undefined ? null : overrides.ideal;
  const workUnits = overrides.workUnits ?? contract.workPlan.units.map((workUnit) => ({
    workUnit,
    status: 'pending' as const,
    attemptCount: 0,
    result: null,
  }));
  return {
    runId: 'run-1',
    workspace: 'project:demo',
    orchestrationId: 'session-1',
    clientKind: 'opencode',
    clientVersion: '1.0.0',
    clientSessionId: null,
    repositoryRoot: REPOSITORY_ROOT,
    taskType: 'build',
    status: overrides.status ?? 'oduno_ideal',
    revision: contract.revision,
    confirmationState: 'pending',
    attempts: 0,
    mutationRevision: overrides.mutationRevision ?? 0,
    ideal,
    meditation: null,
    contract,
    handoff: {
      sourceRole: 'enno-oduno',
      taskType: 'build',
      objective: 'Build the API projection',
      target: 'src/api.ts',
      expected: 'Focused tests pass',
      constraints: ['Do not change the API'],
      verification: ['Focused tests pass', 'Build succeeds'],
      stopConditions: [],
    },
    workUnits,
    finalEvidenceReady: overrides.finalEvidenceReady ?? false,
    finalEvidence: overrides.finalEvidence ?? [],
    blocker: null,
    ...(overrides.advisoryPhaseState === undefined ? {} : { advisoryPhaseState: overrides.advisoryPhaseState }),
  };
}

test('advisory phase mapping follows the main Enno status', () => {
  assert.equal(advisoryPhaseForStatus('oduno_ideal'), 'ideal');
  assert.equal(advisoryPhaseForStatus('zenki_planning'), 'planning');
  assert.equal(advisoryPhaseForStatus('enno_verifying'), 'final_review');
  assert.equal(advisoryPhaseForStatus('goki_executing'), null);
  assert.equal(advisoryPhaseForStatus('completed'), null);
});

test('ideal context is phase-specific and carries no Enno identity', () => {
  const base = snapshot({ status: 'oduno_ideal' });
  const context = advisoryContextForSnapshot(base, 'ideal');
  assert.deepEqual(context.phase, 'ideal');
  assert.equal(context.objective, 'Build the API projection');
  assert.deepEqual(context.constraints, ['Do not change the API']);
  assert.equal(context.expectedOutcome, 'Focused tests pass');
  assert.deepEqual(context.successSignals, ['Focused tests pass', 'Build succeeds']);
  assert.ok(Array.isArray(context.skillTrust));
  assert.deepEqual(context.skillTrust.map((entry) => entry.name), ['kiokuko-soul', 'external-guide', 'imported-guide', 'missing-guide']);
  assert.deepEqual(context.skillTrust.map((entry) => entry.trustStatus), ['available', 'reference_only', 'available', 'unavailable']);
  const serialized = JSON.stringify(context);
  for (const forbidden of ['run-1', 'project:demo', 'session-1', 'orchestrationId', 'idempotencyKey', 'revision', 'mutationRevision']) {
    assert.equal(serialized.includes(forbidden), false, `ideal context leaked ${forbidden}`);
  }
});

test('planning context carries the persisted ideal plus skill availability', () => {
  const ideal = { objective: 'Reach the verified repair outcome', principles: ['Preserve constraints'], skillContributions: [], successSignals: ['tests pass'] };
  const base = snapshot({ status: 'zenki_planning', ideal });
  const context = advisoryContextForSnapshot(base, 'planning');
  assert.deepEqual(context.phase, 'planning');
  assert.equal(context.idealObjective, 'Reach the verified repair outcome');
  assert.deepEqual(context.acceptanceCriteria, ['Focused tests pass']);
  assert.deepEqual(context.planningConstraints, ['Do not change the API']);
  assert.deepEqual(context.skillAvailability.map((entry) => entry.source), ['local', 'external_reference', 'imported_fresh', 'unavailable']);
});

test('final_review context binds fresh evidence projection with bounded output previews', () => {
  const workUnits: EnnoRunSnapshot['workUnits'] = [{
    workUnit: snapshot().contract.workPlan.units[0]!,
    status: 'completed',
    attemptCount: 1,
    result: { outcome: 'completed', summary: 'done', mutated: true, changedPaths: ['src/api.ts'] },
  }];
  const evidence = [verifierResult('final-check')];
  const base = snapshot({
    status: 'enno_verifying',
    finalEvidenceReady: true,
    finalEvidence: evidence,
    workUnits,
  });
  const directive = advisoryDirectiveForSnapshot(base);
  assert.ok(directive);
  assert.equal(directive.phase, 'final_review');
  const context = advisoryContextForSnapshot(base, 'final_review');
  assert.deepEqual(context.phase, 'final_review');
  assert.equal(context.workPlanSummary, 'Build the API projection');
  assert.deepEqual(context.acceptanceCriteria, [{ id: 'tests', description: 'Focused tests pass' }]);
  assert.deepEqual(context.workUnitOutcomes, [{
    id: 'unit-alpha',
    objective: 'Create the projection module',
    acceptanceCriteria: ['Projection is deterministic'],
    routes: ['code'],
    status: 'completed',
    summary: 'done',
    mutated: true,
    changedPaths: ['src/api.ts'],
  }]);
  assert.deepEqual(context.changedPaths, ['src/api.ts']);
  assert.deepEqual(context.verifierEvidence, [{
    id: 'final-check', kind: 'test', executable: 'node',
    args: ['run', 'test'], directory: '.', timeoutMs: 5_000,
    status: 'passed', exitCode: 0, signal: null,
    stdoutDigest: 'a'.repeat(64), stderrDigest: 'b'.repeat(64),
    stdoutPreview: 'raw stdout must never be projected',
    stderrPreview: 'raw stderr must never be projected',
    repositoryStatePolicyVersion: 1,
    repositoryStateDigest: 'c'.repeat(64),
  }]);
  assert.equal(context.repositoryStateDigest, 'c'.repeat(64));
  assert.equal(context.evidenceFreshnessPolicyVersion, 1);
  assert.match(context.evidenceSetDigest, /^[0-9a-f]{64}$/u);
  assert.match(context.freshnessMarker, /^[0-9a-f]{64}$/u);
  assert.ok(Buffer.byteLength(context.verifierEvidence[0]!.stdoutPreview, 'utf8') <= 2_048);
  assert.ok(Buffer.byteLength(context.verifierEvidence[0]!.stderrPreview, 'utf8') <= 2_048);
});

test('final_review projections hide embedded repository paths and truncate UTF-8 on code-point boundaries', () => {
  const workUnits: EnnoRunSnapshot['workUnits'] = [{
    workUnit: snapshot().contract.workPlan.units[0]!,
    status: 'completed',
    attemptCount: 1,
    result: {
      outcome: 'completed',
      summary: `Read ${REPOSITORY_ROOT}/private/build.log`,
      mutated: true,
      changedPaths: ['src/api.ts'],
    },
  }];
  const evidence = [verifierResult('final-check', {
    verifier: verifier('final-check', { args: [`--config=${REPOSITORY_ROOT}/private/config.json`] }),
    stdoutPreview: `${'a'.repeat(2_047)}😀`,
    stderrPreview: `Error at ${REPOSITORY_ROOT}/src/api.ts:1`,
  })];
  const context = advisoryContextForSnapshot(snapshot({
    status: 'enno_verifying',
    finalEvidenceReady: true,
    finalEvidence: evidence,
    workUnits,
  }), 'final_review');
  if (context.phase !== 'final_review') assert.fail('Expected final-review context');
  const serialized = canonicalJson(context);
  assert.equal(serialized.includes(REPOSITORY_ROOT), false);
  assert.ok(Buffer.byteLength(context.verifierEvidence[0]!.stdoutPreview, 'utf8') <= 2_048);
  assert.doesNotThrow(() => canonicalJson(context.verifierEvidence[0]!.stdoutPreview));
});

test('oversized final-review context fails closed without echoing its raw content', () => {
  const oversized = snapshot({
    status: 'enno_verifying',
    finalEvidenceReady: true,
    finalEvidence: [verifierResult('final-check')],
  });
  const sentinel = 'oversized-final-review-sentinel';
  oversized.contract.acceptanceCriteria = Array.from({ length: 32 }, (_, index) => ({
    id: `criterion-${index}`,
    description: `${sentinel}-${index}-${'x'.repeat(3_000)}`,
  }));
  assert.throws(
    () => advisoryContextForSnapshot(oversized, 'final_review'),
    (error: unknown) => error instanceof Error
      && /context exceeds the safety limit/iu.test(error.message)
      && !error.message.includes(sentinel),
  );
});

test('final_review directive is withheld until evidence is prepared', () => {
  const unready = snapshot({ status: 'enno_verifying', finalEvidenceReady: false });
  assert.equal(advisoryDirectiveForSnapshot(unready), undefined);
  const ready = snapshot({ status: 'enno_verifying', finalEvidenceReady: true, finalEvidence: [verifierResult('final-check')] });
  assert.ok(advisoryDirectiveForSnapshot(ready));
  const directive = directiveForRun(ready);
  assert.ok(directive);
  assert.match(directive.objective, /evidence-backed contract blocker/iu);
  assert.match(directive.objective, /disagreement.*non-blocking/iu);
  assert.match(directive.objective, /do not ask the user to adjudicate advisors solely for disagreement/iu);
});

test('phase report schemas advertise advisory consumption only while an aggregate is pending', () => {
  const unaggregated = directiveForRun(snapshot({ status: 'zenki_planning' }));
  assert.ok(unaggregated);
  assert.equal(unaggregated.role, 'zenki');
  const unaggregatedSchema = unaggregated.reportSchema as { required?: string[]; properties?: Record<string, unknown>; advisoryConsumption?: unknown };
  assert.equal(unaggregatedSchema.required?.includes('advisoryRoundDigest'), false);
  assert.equal(unaggregatedSchema.required?.includes('advisoryDisposition'), false);
  assert.equal(Object.hasOwn(unaggregatedSchema.properties ?? {}, 'advisoryRoundDigest'), false);
  assert.equal(Object.hasOwn(unaggregatedSchema.properties ?? {}, 'advisoryDisposition'), false);
  assert.equal(unaggregatedSchema.advisoryConsumption, undefined);

  const aggregated = directiveForRun(snapshot({
    status: 'zenki_planning',
    advisoryPhaseState: {
      state: 'aggregated',
      inputDigest: 'd'.repeat(64),
      requiredDispositionSlots: [
        { slotId: 'workunit_architect', outcome: 'completed', allowedDispositions: ['adopted', 'not_adopted'] },
        { slotId: 'protocol_risk_reviewer', outcome: 'failed', allowedDispositions: ['unavailable'] },
        { slotId: 'verification_designer', outcome: 'completed', allowedDispositions: ['adopted', 'not_adopted'] },
      ],
    },
  }));
  assert.ok(aggregated);
  const aggregatedSchema = aggregated.reportSchema as {
    required?: string[];
    advisoryConsumption?: {
      advisoryRoundDigest: string;
      advisoryDisposition: Array<{ slotId: string; allowedDispositions: string[] }>;
    };
  };
  assert.ok(aggregatedSchema.required?.includes('advisoryRoundDigest'));
  assert.ok(aggregatedSchema.required?.includes('advisoryDisposition'));
  assert.deepEqual(aggregatedSchema.advisoryConsumption, {
    advisoryRoundDigest: 'd'.repeat(64),
    advisoryDisposition: [
      { slotId: 'workunit_architect', allowedDispositions: ['adopted', 'not_adopted'] },
      { slotId: 'protocol_risk_reviewer', allowedDispositions: ['unavailable'] },
      { slotId: 'verification_designer', allowedDispositions: ['adopted', 'not_adopted'] },
    ],
  });
});

test('repository-relative path projection canonicalizes and redacts escapes', () => {
  assert.equal(projectRepositoryRelativePath(REPOSITORY_ROOT, '/repo/src/api.ts'), 'src/api.ts');
  assert.equal(projectRepositoryRelativePath(REPOSITORY_ROOT, 'src/api.ts'), 'src/api.ts');
  assert.equal(projectRepositoryRelativePath(REPOSITORY_ROOT, '/outside/path'), '#redacted');
  assert.equal(projectRepositoryRelativePath(REPOSITORY_ROOT, '../escape'), '#redacted');
  assert.equal(projectRepositoryRelativePath(REPOSITORY_ROOT, 'C:\\data\\x'), '#redacted');
  assert.equal(projectRepositoryRelativePath(REPOSITORY_ROOT, '/repo/../../x'), '#redacted');
});

test('advisory input digest is deterministic and sensitive to bound input', () => {
  const context = advisoryContextForSnapshot(snapshot({ status: 'oduno_ideal' }), 'ideal');
  const digest = advisoryInputDigest({ phase: 'ideal', contractRevision: 2, mutationRevision: 0, allowlistedContext: context });
  assert.equal(digest, advisoryInputDigest({ phase: 'ideal', contractRevision: 2, mutationRevision: 0, allowlistedContext: context }));
  assert.notEqual(digest, advisoryInputDigest({ phase: 'ideal', contractRevision: 3, mutationRevision: 0, allowlistedContext: context }));
  assert.notEqual(digest, advisoryInputDigest({ phase: 'ideal', contractRevision: 2, mutationRevision: 1, allowlistedContext: context }));
  assert.notEqual(digest, advisoryInputDigest({ phase: 'planning', contractRevision: 2, mutationRevision: 0, allowlistedContext: context }));
  const changed = advisoryContextForSnapshot(snapshot({ status: 'oduno_ideal', skillEntries: [skillEntry('kiokuko-soul', 'unavailable', true)] }), 'ideal');
  assert.notEqual(digest, advisoryInputDigest({ phase: 'ideal', contractRevision: 2, mutationRevision: 0, allowlistedContext: changed }));
  const staged = snapshot({ status: 'enno_verifying', finalEvidenceReady: true, finalEvidence: [verifierResult('final-check', { status: 'failed', exitCode: 1 })] });
  const finalDigest = advisoryInputDigest({ phase: 'final_review', contractRevision: 2, mutationRevision: 0, allowlistedContext: advisoryContextForSnapshot(staged, 'final_review') });
  const stagedPassed = snapshot({ status: 'enno_verifying', finalEvidenceReady: true, finalEvidence: [verifierResult('final-check')] });
  const finalDigestPassed = advisoryInputDigest({ phase: 'final_review', contractRevision: 2, mutationRevision: 0, allowlistedContext: advisoryContextForSnapshot(stagedPassed, 'final_review') });
  assert.notEqual(finalDigest, finalDigestPassed);
  assert.equal(canonicalJson(advisoryContextForSnapshot(staged, 'final_review')), canonicalJson(advisoryContextForSnapshot(staged, 'final_review')));
});

test('advisory slot fanout exposes exactly three fixed slots in slot-rank order', () => {
  for (const phase of ['ideal', 'planning', 'final_review'] as const) {
    const slots = advisorySlotDefinitions(phase);
    assert.equal(slots.length, 3);
    assert.deepEqual(slots.map((slot) => slot.slotId), phaseSlotIds(phase));
    assert.deepEqual(slots.map((slot) => slot.rank), [0, 1, 2]);
    const expectedRoles = ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === phase).map((slot) => slot.role);
    assert.deepEqual(slots.map((slot) => slot.role), expectedRoles);
    for (const slot of slots) {
      assert.match(slot.instructions, /read-only isolation must be provided and verified by the parent host/iu);
      assert.match(slot.instructions, /do not edit files, call Kiokuko tools/iu);
    }
  }
});

test('normalize rejects duplicate, missing, and unknown advisory slots', () => {
  const ideal = (slotId: AdvisorySlotId) => completed(slotId);
  assert.throws(() => normalizeAdvisoryContributions('ideal', [ideal('constraint_guardian'), ideal('constraint_guardian'), ideal('success_signal_critic')]), /Enno input is invalid/iu);
  assert.throws(() => normalizeAdvisoryContributions('ideal', [ideal('constraint_guardian'), ideal('skill_trust_analyst')]), /Enno input is invalid/iu);
  assert.throws(() => normalizeAdvisoryContributions('ideal', [ideal('constraint_guardian'), ideal('skill_trust_analyst'), { slotId: 'workunit_architect', outcome: 'completed', summary: 'x', recommendations: [], risks: [], evidence: [] }]), /Enno input is invalid/iu);
});

test('normalize rejects invalid outcomes and failing contributions without a fixed reason code', () => {
  const unknownOutcome = { ...completed('constraint_guardian'), outcome: 'accepted' } as unknown as AdvisoryContribution;
  assert.throws(() => normalizeAdvisoryContributions('ideal', [unknownOutcome, completed('skill_trust_analyst'), completed('success_signal_critic')]), /Enno input is invalid/iu);
  const noReasonCode = { ...completed('constraint_guardian'), outcome: 'failed' } as unknown as AdvisoryContribution;
  assert.throws(() => normalizeAdvisoryContributions('ideal', [noReasonCode, completed('skill_trust_analyst'), completed('success_signal_critic')]), /Enno input is invalid/iu);
  const badReasonCode = { ...completed('constraint_guardian'), outcome: 'timeout', reasonCode: 'unexpected' } as unknown as AdvisoryContribution;
  assert.throws(() => normalizeAdvisoryContributions('ideal', [badReasonCode, completed('skill_trust_analyst'), completed('success_signal_critic')]), /Enno input is invalid/iu);
  const valid = advisoryContributions('ideal', (slotId) => failed(slotId, 'host_read_only_unavailable'));
  assert.equal(normalizeAdvisoryContributions('ideal', valid).length, 3);
});

test('normalize preserves parent-host timeout and unavailable outcomes as fixed slot failures', () => {
  const normalized = normalizeAdvisoryContributions('final_review', [
    { slotId: 'acceptance_auditor', outcome: 'timeout', reasonCode: 'host_timeout' },
    failed('regression_adversary', 'host_execution_failed'),
    { slotId: 'evidence_freshness_reviewer', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
  ]);
  assert.deepEqual(normalized.map((contribution) => ({
    slotId: contribution.slotId,
    outcome: contribution.outcome,
    reasonCode: contribution.reasonCode,
  })), [
    { slotId: 'acceptance_auditor', outcome: 'timeout', reasonCode: 'host_timeout' },
    { slotId: 'regression_adversary', outcome: 'failed', reasonCode: 'host_execution_failed' },
    { slotId: 'evidence_freshness_reviewer', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
  ]);
  assert.equal(advisoryRoundAggregate(normalized).degraded, true);
});

test('normalize converts secret-shaped completed output to unsafe_output without re-exposing it', () => {
  const withSecret = advisoryContributions('ideal', (slotId) => completed(slotId, 'ok', {
    evidence: slotId === 'constraint_guardian' ? [{ path: 'src/a.ts', statement: 'password=hunter2secretvalue' }] : [],
  }));
  const normalized = normalizeAdvisoryContributions('ideal', withSecret);
  const guard = normalized.find((contribution) => contribution.slotId === 'constraint_guardian')!;
  assert.equal(guard.outcome, 'failed');
  assert.equal(guard.reasonCode, 'unsafe_output');
  assert.equal(normalized.filter((contribution) => contribution.outcome === 'completed').length, 2);
  assert.equal(JSON.stringify(normalized).includes('hunter2secretvalue'), false);
  const secretInSummary = advisoryContributions('ideal', (slotId) => completed(slotId, 'password=hunter2secretvalue'));
  assert.equal(normalizeAdvisoryContributions('ideal', secretInSummary).every((contribution) => contribution.outcome === 'failed'), true);
});

test('normalize enforces 16 KiB slot and 48 KiB round byte boundaries', () => {
  const contributions = normalizeAdvisoryContributions('ideal', [
    completed('constraint_guardian', 'a'.repeat(800)),
    completed('skill_trust_analyst', 'a'.repeat(800)),
    completed('success_signal_critic', 'a'.repeat(800)),
  ]);
  assert.equal(contributions.length, 3);
  const overSlot = advisoryContributions('ideal', (slotId) => completed(slotId, 'a'.repeat(ADVISORY_MAX_SLOT_BYTES + 1)));
  assert.throws(() => normalizeAdvisoryContributions('ideal', overSlot), /Enno input is invalid/iu);
  const bytes = (value: AdvisoryContribution): number => Buffer.byteLength(canonicalJson(value), 'utf8');
  const overRound = phaseSlotIds('ideal').map((slotId) => {
    const summaryLen = ADVISORY_MAX_SLOT_BYTES - bytes(completed(slotId, ''));
    return completed(slotId, 'j'.repeat(summaryLen));
  });
  assert.ok(overRound.every((contribution) => bytes(contribution) <= ADVISORY_MAX_SLOT_BYTES));
  assert.throws(() => normalizeAdvisoryContributions('ideal', overRound), /Enno input is invalid/iu);
});

test('normalize measures multibyte content by UTF-8 bytes, not character count', () => {
  assert.equal(normalizeAdvisoryContributions('ideal', advisoryContributions('ideal', (slotId) => completed(slotId, 'a'.repeat(6_000)))).length, 3);
  const exceedingByBytes = advisoryContributions('ideal', (slotId) => completed(slotId, 'う'.repeat(6_000)));
  assert.throws(() => normalizeAdvisoryContributions('ideal', exceedingByBytes), /Enno input is invalid/iu);
});

test('normalize does not mutate caller-owned input arrays', () => {
  const input = advisoryContributions('ideal', (slotId) => completed(slotId, 'ok', { recommendations: ['r'] }));
  const emittedBefore = JSON.stringify(input);
  assert.doesNotThrow(() => normalizeAdvisoryContributions('ideal', input));
  assert.equal(JSON.stringify(input), emittedBefore);
});

test('advisory round aggregate deep-copies nested arrays and reports degraded judgement', () => {
  const source = advisoryContributions('final_review', (slotId) => completed(slotId, 'ok', {
    recommendations: ['r'],
    risks: ['risk'],
    evidence: [{ path: 'src/a.ts', statement: 'fact' }],
  }));
  const aggregate = advisoryRoundAggregate(source);
  assert.equal(aggregate.degraded, false);
  aggregate.contributions[0]!.recommendations!.push('mutated');
  aggregate.contributions[0]!.risks!.push('mutated-risk');
  aggregate.contributions[0]!.evidence!.push({ path: 'b', statement: 'added' });
  assert.deepEqual(source[0]!.recommendations, ['r']);
  assert.deepEqual(source[0]!.risks, ['risk']);
  assert.deepEqual(source[0]!.evidence, [{ path: 'src/a.ts', statement: 'fact' }]);
  const allFailed = advisoryContributions('final_review', (slotId) => failed(slotId, 'unsafe_output'));
  assert.equal(advisoryRoundAggregate(allFailed).degraded, true);
  const mixed = advisoryContributions('final_review', (slotId) => slotId === 'acceptance_auditor' ? failed(slotId, 'invalid_response') : completed(slotId));
  assert.equal(advisoryRoundAggregate(mixed).degraded, false);
});

test('advisory contribution schema rejects control characters, extra fields, and invalid outcomes', () => {
  const valid = completed('constraint_guardian');
  assert.equal(advisoryContributionSchemaPublic.safeParse(valid).success, true);
  assert.equal(advisoryContributionSchemaPublic.safeParse({ ...valid, summary: 'has\u0007bel' }).success, false);
  assert.equal(advisoryContributionSchemaPublic.safeParse({ ...valid, summary: 'bell\u200bzw' }).success, false);
  assert.equal(advisoryContributionSchemaPublic.safeParse({ ...valid, bogus: true }).success, false);
  assert.equal(advisoryContributionSchemaPublic.safeParse({ ...valid, outcome: 'accepted' }).success, false);
  assert.equal(advisoryContributionSchemaPublic.safeParse({ slotId: 'constraint_guardian', outcome: 'failed' }).success, false);
  assert.equal(advisoryContributionSchemaPublic.safeParse({ slotId: 'constraint_guardian', outcome: 'failed', reasonCode: 'unexpected' }).success, false);
  assert.equal(advisoryContributionSchemaPublic.safeParse({ slotId: 'constraint_guardian', outcome: 'failed', reasonCode: 'invalid_response' }).success, true);
});

test('parseStoredAdvisoryContribution throws INTEGRITY_ERROR on a corrupt stored contribution', () => {
  assert.doesNotThrow(() => parseStoredAdvisoryContribution({ slotId: 'constraint_guardian', outcome: 'completed', summary: 'ok', recommendations: [], risks: [], evidence: [] }));
  assert.throws(() => parseStoredAdvisoryContribution({ slotId: 'constraint_guardian', outcome: 'completed', summary: 'ok', extra: true }), /Stored advisory contribution is invalid/iu);
  assert.throws(() => parseStoredAdvisoryContribution('not-an-object'), /Stored advisory contribution is invalid/iu);
});
