import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUserFacingConfirmation } from '../../src/enno-oduno/confirmation.js';
import { canonicalJson } from '../../src/serialization/validate.js';
import type {
  ContractProvenance,
  EnnoProvenanceKey,
  EnnoRunSnapshot,
  VerifierSpec,
} from '../../src/enno-oduno/types.js';

const REPOSITORY_ROOT = '/repo';

function verifier(id: string, overrides: Partial<VerifierSpec> = {}): VerifierSpec {
  return {
    id,
    kind: 'test',
    executable: 'node',
    args: ['run', 'test'],
    cwd: REPOSITORY_ROOT,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function snapshot(overrides: {
  status?: EnnoRunSnapshot['status'];
  provenance?: Record<EnnoProvenanceKey, ContractProvenance>;
  dependencies?: string[];
  expertIds?: string[];
  skillEntries?: EnnoRunSnapshot['contract']['skillSet']['entries'];
  cwd?: string;
} = {}): EnnoRunSnapshot {
  const provenance = overrides.provenance ?? {
    scope: 'inferred', exclusions: 'inferred', acceptanceCriteria: 'inferred',
    workPlan: 'inferred', skillSet: 'inferred', finalVerifiers: 'inferred', maxAttempts: 'inferred',
  };
  const contract: EnnoRunSnapshot['contract'] = {
    revision: 3,
    scope: ['src/api.ts', 'src/api.test.ts'],
    exclusions: ['docs/'],
    acceptanceCriteria: [
      { id: 'tests', description: 'Focused tests pass' },
      { id: 'build', description: 'Build succeeds' },
    ],
    workPlan: {
      objective: 'Build the API projection',
      units: [
        {
          id: 'unit-alpha',
          objective: 'Create the projection module',
          scope: ['src/api.ts'],
          routes: ['code'],
          dependencies: [],
          skillNames: ['kiokuko-soul'],
          expertRefs: (overrides.expertIds ?? ['code.domain.v1', 'code.boundary.v1']).map((id) => ({
            id,
            reason: 'deterministic mapping rules',
          })),
          acceptanceCriteria: ['Projection is deterministic'],
          focusedVerifiers: [verifier('alpha-check', { cwd: overrides.cwd ?? REPOSITORY_ROOT })],
        },
        {
          id: 'unit-beta',
          objective: 'Wire the projection into responses',
          scope: ['src/api.test.ts'],
          routes: ['code'],
          dependencies: overrides.dependencies ?? ['unit-alpha'],
          skillNames: [],
          expertRefs: [],
          acceptanceCriteria: ['Replay matches the first response'],
          focusedVerifiers: [],
        },
      ],
    },
    skillSet: {
      entries: overrides.skillEntries ?? [
        { name: 'kiokuko-soul', purposes: ['planning', 'implementation'], required: true, availability: 'local', referenceId: null },
        { name: 'external-guide', purposes: ['planning'], required: false, availability: 'external_reference', referenceId: 'ext-1' },
      ],
      intakeDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
      zenkiDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
    },
    finalVerifiers: [verifier('final-check', { cwd: `${REPOSITORY_ROOT}/tests`, timeoutMs: 60_000 })],
    maxAttempts: 8,
    provenance,
  };
  return {
    runId: 'run-1',
    workspace: 'project:demo',
    orchestrationId: 'session-1',
    clientKind: 'opencode',
    clientVersion: '1.0.0',
    clientSessionId: null,
    repositoryRoot: REPOSITORY_ROOT,
    taskType: 'build',
    status: overrides.status ?? 'needs_confirmation',
    revision: contract.revision,
    confirmationState: 'pending',
    attempts: 0,
    mutationRevision: 0,
    ideal: null,
    meditation: null,
    contract,
    handoff: {
      sourceRole: 'enno-oduno',
      taskType: 'build',
      objective: 'Build the API projection',
      target: 'src/api.ts',
      expected: 'Focused tests pass',
      constraints: [],
      verification: [],
      stopConditions: [],
    },
    workUnits: contract.workPlan.units.map((workUnit) => ({
      workUnit,
      status: 'pending' as const,
      attemptCount: 0,
      result: null,
    })),
    finalEvidenceReady: false,
    finalEvidence: [],
    blocker: null,
  };
}

test('projection exists only while confirmation is pending', () => {
  assert.ok(buildUserFacingConfirmation(snapshot()) !== undefined);
  for (const status of ['zenki_planning', 'goki_executing', 'enno_verifying', 'blocked', 'completed'] as const) {
    assert.equal(buildUserFacingConfirmation(snapshot({ status })), undefined);
  }
});

test('every provenance key maps to exactly its designated display section', () => {
  const base = snapshot();
  const sectionsOf = (projection: NonNullable<ReturnType<typeof buildUserFacingConfirmation>>) => ({
    scope: projection.scope.basis,
    exclusions: projection.exclusions.basis,
    acceptanceCriteria: projection.completion.basis,
    workPlan: projection.summary.basis,
    skillSet: projection.skills[0]!.basis,
    finalVerifiers: projection.finalChecks.basis,
    maxAttempts: projection.attemptLimit.basis,
  });
  const allProposal = sectionsOf(buildUserFacingConfirmation(base)!);
  for (const value of Object.values(allProposal)) assert.equal(value, 'proposal');
  for (const key of Object.keys(allProposal) as EnnoProvenanceKey[]) {
    const flipped = { ...base.contract.provenance, [key]: 'explicit_user' } as Record<EnnoProvenanceKey, ContractProvenance>;
    const sections = sectionsOf(buildUserFacingConfirmation(snapshot({ provenance: flipped }))!);
    for (const [section, basis] of Object.entries(sections)) {
      if (section === key) assert.equal(basis, 'user');
      else assert.equal(basis, 'proposal');
    }
  }
  const repository = snapshot({
    provenance: { ...base.contract.provenance, finalVerifiers: 'repository_evidence' },
  });
  assert.equal(buildUserFacingConfirmation(repository)!.finalChecks.basis, 'repository');
});

test('projection carries every confirmation section without internal identifiers', () => {
  const projection = buildUserFacingConfirmation(snapshot())!;
  const rendered = canonicalJson(projection);
  assert.equal(projection.presentationVersion, 1);
  assert.deepEqual(projection.actions, ['approve', 'revise', 'cancel']);
  assert.deepEqual(projection.scope.paths, ['src/api.ts', 'src/api.test.ts']);
  assert.deepEqual(projection.exclusions.paths, ['docs/']);
  assert.deepEqual(projection.completion.items, ['Focused tests pass', 'Build succeeds']);
  assert.deepEqual(projection.attemptLimit, { basis: 'proposal', maxAttempts: 8 });
  for (const forbidden of [
    'unit-alpha', 'unit-beta', 'alpha-check', 'final-check',
    'code.domain.v1', 'code.boundary.v1',
    'WorkUnit', 'workPlan', 'expertRefs', 'focusedVerifiers', 'finalVerifiers',
    'workUnitId', 'skillNames', 'acceptanceCriteria', 'provenance',
    'explicit_user', 'repository_evidence', 'inferred',
  ]) {
    assert.equal(rendered.includes(forbidden), false, `projection leaked internal token: ${forbidden}`);
  }
});

test('dependencies become display numbers resolved from the stored contract order', () => {
  const projection = buildUserFacingConfirmation(snapshot())!;
  assert.deepEqual(projection.workItems.map((item) => item.number), [1, 2]);
  assert.deepEqual(projection.workItems[0]!.dependsOn, []);
  assert.deepEqual(projection.workItems[1]!.dependsOn, [1]);
  const chain = snapshot({ dependencies: ['unit-alpha', 'unit-beta'] });
  assert.deepEqual(buildUserFacingConfirmation(chain)!.workItems[1]!.dependsOn, [1, 2]);
  assert.throws(
    () => buildUserFacingConfirmation(snapshot({ dependencies: ['missing-unit'] })),
    /dependency does not resolve/iu,
  );
});

test('expert selections display registered areas with preserved reasons', () => {
  const projection = buildUserFacingConfirmation(snapshot({
    expertIds: ['code.effects.v1', 'ui.safety.v1', 'code.modeling.v1'],
  }))!;
  const [effects, safety, modeling] = projection.workItems[0]!.expertise;
  assert.equal(effects!.area, 'Database, filesystem, network, and process effects');
  assert.equal(safety!.area, 'UI safety and review');
  assert.equal(modeling!.area, 'Problem shaping and representation design');
  assert.equal(effects!.reason, 'deterministic mapping rules');
  assert.equal(effects!.basis, 'proposal');
  assert.throws(
    () => buildUserFacingConfirmation(snapshot({ expertIds: ['code.unknown.v9'] })),
    /outside the registered expert set/iu,
  );
});

test('skills distinguish local execution from reference-only guidance', () => {
  const projection = buildUserFacingConfirmation(snapshot())!;
  assert.deepEqual(projection.skills, [
    { label: 'kiokuko-soul', basis: 'proposal', required: true, purposes: ['planning', 'implementation'], referenceOnly: false },
    { label: 'external-guide', basis: 'proposal', required: false, purposes: ['planning'], referenceOnly: true },
  ]);
});

test('verifiers keep executable, arguments, directory, and timeout separate', () => {
  const base = buildUserFacingConfirmation(snapshot())!;
  assert.deepEqual(base.workItems[0]!.checks[0]!, {
    category: 'test',
    executable: 'node',
    arguments: ['run', 'test'],
    directory: '.',
    timeoutMs: 5_000,
  });
  assert.deepEqual(base.finalChecks.checks[0]!, {
    category: 'test',
    executable: 'node',
    arguments: ['run', 'test'],
    directory: 'tests',
    timeoutMs: 60_000,
  });
  const overridden = buildUserFacingConfirmation(snapshot({ cwd: `${REPOSITORY_ROOT}/tests` }))!;
  assert.equal(overridden.workItems[0]!.checks[0]!.directory, 'tests');
  assert.equal(canonicalJson(base).includes('node run test'), false);
  assert.throws(
    () => buildUserFacingConfirmation(snapshot({ cwd: '/elsewhere/checks' })),
    /escapes the repository root/iu,
  );
});

test('projection is deterministic and leaves the snapshot untouched', () => {
  const input = snapshot();
  const before = canonicalJson(input);
  const first = buildUserFacingConfirmation(input);
  const second = buildUserFacingConfirmation(input);
  assert.deepEqual(first, second);
  assert.equal(canonicalJson(input), before);
});

test('secret-shaped display values reject the confirmation without redaction', () => {
  const leaking = snapshot();
  leaking.contract.workPlan.units[0]!.focusedVerifiers[0]!.args = ['run', 'api-key=supersecretvalue123'];
  assert.throws(() => buildUserFacingConfirmation(leaking), (error: unknown) => {
    assert.ok(error instanceof Object);
    assert.equal((error as { code?: string }).code, 'SECURITY_REJECTION');
    return true;
  });
});

test('oversized confirmation rejects instead of truncating', () => {
  const oversized = snapshot();
  oversized.contract.workPlan.units[0]!.objective = 'x'.repeat(70_000);
  assert.throws(() => buildUserFacingConfirmation(oversized), (error: unknown) => {
    assert.ok(error instanceof Object);
    assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
    return true;
  });
});
