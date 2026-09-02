import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import {
  decideContinuationPolicy,
  identifyEnnoClientKind,
  resolveHarnessProfile,
  resolveTaskPrepareClient,
} from '../../src/enno-oduno/harness.js';
import { generateRoleDirective, parseRoleJson, serializeRoleOutput, MAX_ROLE_OUTPUT_BYTES } from '../../src/enno-oduno/role-runner.js';
import { runVerifier, runVerifiers } from '../../src/enno-oduno/verifier.js';
import { assertWorkPlanExpertCoverage } from '../../src/enno-oduno/experts.js';
import {
  completeRequiredSkillList,
  orderedUniqueSkillNames,
  unavailableRequiredSkills,
} from '../../src/enno-oduno/skills.js';
import { parseEnnoContract, parseIdealSubmission, parsePlanSubmission } from '../../src/enno-oduno/schemas.js';
import { sanitizePlanSubmission } from '../../src/enno-oduno/sanitize.js';
import type { EnnoRequestHandoff } from '../../src/enno-oduno/types.js';
import { captureRepositoryState } from '../../src/enno-oduno/repository-state.js';
import { operationLeaseMsForVerifiers } from '../../src/enno-oduno/store.js';
import {
  ENNO_INPUT_INVALID_DETAIL_KEY,
  ENNO_MAX_PUBLIC_ISSUES,
  publicEnnoValidationErrorSchema,
  type PublicEnnoValidationError,
} from '../../src/enno-oduno/validation-errors.js';

function validationDetail(operation: () => unknown): PublicEnnoValidationError {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof KiokukoError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    const parsed = publicEnnoValidationErrorSchema.safeParse(error.details[ENNO_INPUT_INVALID_DETAIL_KEY]);
    assert.equal(parsed.success, true);
    if (parsed.success) return parsed.data as PublicEnnoValidationError;
  }
  assert.fail('Expected a structured Enno validation error');
}

function requestHandoff(taskType: EnnoRequestHandoff['taskType']): EnnoRequestHandoff {
  return {
    sourceRole: 'enno-oduno',
    taskType,
    objective: taskType === 'debug' ? 'Repair the add function' : 'Build the requested change',
    target: 'src/add.js',
    expected: 'Tests pass',
    constraints: ['Keep the public API'],
    verification: ['Run the focused and final test verifiers'],
    stopConditions: ['Stop if the requested scope is unsafe'],
  };
}

test('OpenCode HarnessProfile derives policy only from equivalent capability evidence', () => {
  const evidence = {
    adapter: 'opencode',
    capabilities: {
      continuation: 'session_idle',
      executionLifetime: 'task_persistent',
      workspaceIsolation: 'isolated',
      advisors: 'verified_isolated_readonly',
      approvals: 'host_review',
      toolInventory: 'complete',
      filesystem: 'local_read_write',
      network: 'allowlisted',
      surfaces: ['task', 'progress', 'approval'],
    },
  };
  const opencode = resolveHarnessProfile(evidence);
  const equivalent = resolveHarnessProfile({
    ...evidence,
    adapter: 'opencode',
  });
  assert.equal(opencode.adapter, 'opencode');
  assert.deepEqual({ ...opencode, adapter: 'unknown' }, { ...equivalent, adapter: 'unknown' });
  assert.deepEqual(decideContinuationPolicy(opencode), {
    mode: 'automatic',
    allowAdvisorFanout: true,
    externalMutation: 'host_review',
    requireExplicitUserConfirmation: false,
    reasons: [],
  });
});

test('unknown HarnessProfile evidence fails closed', () => {
  const profile = resolveHarnessProfile({ adapter: 'other-adapter', prompt: 'session_idle' });
  assert.equal(profile.continuation, 'manual');
  assert.equal(profile.executionLifetime, 'unknown');
  assert.equal(profile.workspaceIsolation, 'unknown');
  assert.equal(profile.advisors, 'unknown');
  assert.equal(profile.approvals, 'unavailable');
  assert.equal(profile.toolInventory, 'unknown');
  assert.equal(profile.filesystem, 'unknown');
  assert.equal(profile.network, 'unknown');
  assert.deepEqual(profile.surfaces, []);
  assert.deepEqual(decideContinuationPolicy(profile), {
    mode: 'manual',
    allowAdvisorFanout: false,
    externalMutation: 'blocked',
    requireExplicitUserConfirmation: false,
    reasons: [
      'automatic_continuation_unverified',
      'advisor_isolation_unverified',
      'external_mutation_not_verified',
    ],
  });
});

test('role scripts reject revision conflicts and generate only the role owning the state', () => {
  const contract = {
    revision: 2,
    scope: ['src/add.js'],
    exclusions: [],
    acceptanceCriteria: [{ id: 'tests', description: 'Tests pass' }],
    workPlan: {
      objective: 'Fix add',
      units: [{
        id: 'fix-add', objective: 'Fix add', scope: ['src/add.js'], dependencies: [],
        routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'], acceptanceCriteria: ['Tests pass'], focusedVerifiers: [],
      }],
    },
    skillSet: {
      entries: [{
        name: 'kiokuko-single-purpose-functions', purposes: ['implementation'], required: true,
        availability: 'local', referenceId: null,
      }],
      intakeDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
      zenkiDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
    },
    finalVerifiers: [{ id: 'test', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 }],
    maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  };
  const input = {
    runId: 'run-1', taskType: 'debug', status: 'goki_executing', contractRevision: 2,
    clientKind: 'opencode', clientVersion: '1.0.0', routeEpoch: 7,
    advisoryPhaseState: { state: 'not_started' as const },
    finalEvidence: [{
      verifier: contract.finalVerifiers[0], status: 'passed' as const, exitCode: 0, signal: null,
      durationMs: 1, stdoutPreview: '', stderrPreview: '', stdoutDigest: '0'.repeat(64), stderrDigest: '0'.repeat(64),
      repositoryStatePolicyVersion: 1, repositoryStateDigest: '1'.repeat(64), changedDuringVerification: false,
    }],
    contract, handoff: requestHandoff('debug'),
    workUnits: [{ workUnit: contract.workPlan.units[0], status: 'in_progress', attemptCount: 0, result: null }],
  };
  assert.throws(() => parseEnnoContract({
    ...contract,
    finalVerifiers: [contract.finalVerifiers[0], contract.finalVerifiers[0]],
  }), /stored enno contract is invalid/iu);
  const directive = generateRoleDirective('goki', input);
  assert.equal(directive.role, 'goki');
  assert.equal(directive.workUnit?.id, 'fix-add');
  assert.equal(directive.handoff?.sourceRole, 'enno-oduno');
  assert.equal(directive.harness.kind, 'opencode');
  assert.equal(directive.routeEpoch, 7);
  assert.equal(directive.harness.continuation, 'session_idle_plugin');
  assert.match(directive.objective, /^Orchestrate the approved WorkUnit:/u);
  assert.deepEqual(directive.requiredSkills, [
    'kiokuko-soul',
    'kiokuko-single-purpose-functions',
  ]);
  assert.equal((directive.reportSchema.required as string[]).includes('leaseToken'), false);
  const leasedDirective = generateRoleDirective('goki', { ...input, clientSessionId: 'opencode-session' });
  assert.equal((leasedDirective.reportSchema.required as string[]).includes('leaseToken'), true);
  assert.throws(() => generateRoleDirective('zenki', input), /does not own/iu);
  assert.throws(() => generateRoleDirective('goki', { ...input, contractRevision: 1 }), /revision mismatch/iu);
  const ideal = generateRoleDirective('enno-oduno', {
    ...input,
    status: 'oduno_ideal',
    contract: {
      ...contract,
      skillSet: {
        ...contract.skillSet,
        intakeDiscovery: {
          ...contract.skillSet.intakeDiscovery,
          attempted: true,
          selected: [{
            skillId: 'external-debug-reference', name: 'external-debug-reference', source: 'official-catalog',
            officialStatus: 'catalog-verified', imported: false, updated: false,
          }],
        },
      },
    },
  });
  assert.match(ideal.objective, /optimal goal.*task_prepare handoff/iu);
  assert.match(ideal.objective, /external-debug-reference/u);
  assert.deepEqual(ideal.reportSchema.required, ['runId', 'expectedRevision', 'idempotencyKey', 'ideal']);
  const review = generateRoleDirective('enno-oduno', {
    ...input,
    status: 'enno_verifying',
    workUnits: [{ ...input.workUnits[0], status: 'completed' }],
  });
  assert.match(review.objective, /enno_verify_prepare.*Final Review advisory fanout/u);
  assert.deepEqual(review.requiredSkills, [
    'kiokuko-soul',
    'kiokuko-enno-oduno',
    'kiokuko-single-purpose-functions',
  ]);
  assert.ok(review.harness.instructions.some((instruction) => /Read and apply kiokuko-soul first, then kiokuko-enno-oduno/u.test(instruction)));
  assert.deepEqual(review.reportSchema.required, ['runId', 'expectedRevision', 'idempotencyKey']);
  const meditation = generateRoleDirective('enno-oduno', {
    ...input,
    status: 'oduno_meditation',
    ideal: {
      objective: 'Reach the verified optimal add implementation',
      principles: ['Preserve the public API'],
      skillContributions: [],
      successSignals: ['Tests pass'],
    },
    workUnits: [{
      ...input.workUnits[0],
      status: 'completed',
      result: { outcome: 'completed', summary: 'Repaired add', mutated: true, changedPaths: ['src/add.js'] },
    }],
  });
  assert.match(meditation.objective, /obsolete, useless, or redundant tests and functions/iu);
  assert.match(meditation.objective, /src\/add\.js/u);
  assert.ok(meditation.stopConditions.some((condition) => /Do not mutate or delete/iu.test(condition)));
  assert.deepEqual(meditation.reportSchema.required, ['runId', 'expectedRevision', 'idempotencyKey', 'meditation']);
  assert.throws(() => parseRoleJson(Buffer.from('{"x":1,"x":2}')), /strict JSON/iu);
});

test('confirmation directives carry the projection, fixed instruction, and confirmation report schema', () => {
  const discovery = { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] };
  const contract = {
    revision: 2,
    scope: ['src/add.js'],
    exclusions: [],
    acceptanceCriteria: [{ id: 'tests', description: 'node --test passes' }],
    workPlan: {
      objective: 'Fix add behind the confirmation',
      units: [{
        id: 'fix-add', objective: 'Fix add', scope: ['src/add.js'], dependencies: [],
        routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'],
        expertRefs: [{ id: 'code.verification.v1', reason: 'Prove the regression with focused tests' }],
        acceptanceCriteria: ['node --test passes'], focusedVerifiers: [],
      }],
    },
    skillSet: {
      entries: [{
        name: 'kiokuko-single-purpose-functions', purposes: ['implementation'], required: true,
        availability: 'local', referenceId: null,
      }],
      intakeDiscovery: discovery,
      zenkiDiscovery: discovery,
    },
    finalVerifiers: [{ id: 'test', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 }],
    maxAttempts: 5,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'explicit_user', maxAttempts: 'inferred',
    },
  };
  const input = {
    runId: 'run-confirm', taskType: 'debug', status: 'needs_confirmation', contractRevision: 2,
    confirmationState: 'pending', clientKind: 'opencode', clientVersion: '1.0.0',
    contract, handoff: requestHandoff('debug'),
    workUnits: [{ workUnit: contract.workPlan.units[0], status: 'pending', attemptCount: 0, result: null }],
  };
  const directive = generateRoleDirective('enno-oduno', input);
  assert.equal(directive.role, 'enno-oduno');
  assert.match(directive.objective, /Return every item in userFacingConfirmation to the user in the user's language/iu);
  assert.match(directive.objective, /Do not expose raw directive JSON, internal field names/iu);
  assert.match(directive.objective, /Wait for explicit approve, revise, or cancel before calling enno_answer/iu);
  assert.deepEqual(directive.reportSchema.required, ['runId', 'expectedRevision', 'idempotencyKey', 'action']);
  const projection = directive.userFacingConfirmation;
  assert.ok(projection !== undefined);
  assert.equal(projection.summary.basis, 'proposal');
  assert.equal(projection.scope.basis, 'user');
  assert.equal(projection.skills[0]?.basis, 'repository');
  assert.equal(projection.skills[0]?.referenceOnly, false);
  assert.equal(projection.workItems[0]?.expertise[0]?.area, 'Regression prevention and verification design');
  assert.deepEqual(projection.actions, ['approve', 'revise', 'cancel']);
  const serialized = serializeRoleOutput(directive);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= MAX_ROLE_OUTPUT_BYTES);
  assert.deepEqual(JSON.parse(serialized), directive);
  const goki = generateRoleDirective('goki', { ...input, status: 'goki_executing', confirmationState: 'approved' });
  assert.equal('userFacingConfirmation' in goki, false);
  const zenki = generateRoleDirective('zenki', { ...input, status: 'zenki_planning', confirmationState: 'revision_requested' });
  assert.equal('userFacingConfirmation' in zenki, false);
  const verification = generateRoleDirective('enno-oduno', { ...input, status: 'enno_verifying', confirmationState: 'approved' });
  assert.equal('userFacingConfirmation' in verification, false);
  assert.deepEqual(verification.reportSchema.required, ['runId', 'expectedRevision', 'idempotencyKey']);
});

test('Zenki directive binds Akinator, repository, local capability, and reference-only Skill context', () => {
  const discovery = { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] };
  const directive = generateRoleDirective('zenki', {
    runId: 'planning', taskType: 'build', status: 'zenki_planning', contractRevision: 1,
    clientKind: 'opencode', clientVersion: '0.13.0',
    contract: {
      revision: 1, scope: ['src/App.tsx'], exclusions: [], acceptanceCriteria: [],
      workPlan: { objective: 'Plan the UI', units: [] },
      skillSet: { entries: [], intakeDiscovery: discovery, zenkiDiscovery: discovery },
      finalVerifiers: [], maxAttempts: 8,
      provenance: {
        scope: 'inferred', exclusions: 'inferred', acceptanceCriteria: 'inferred', workPlan: 'inferred',
        skillSet: 'inferred', finalVerifiers: 'inferred', maxAttempts: 'inferred',
      },
    },
    handoff: requestHandoff('build'),
    workUnits: [],
    akinatorProfile: { taskType: 'build', target: 'React settings panel', expected: 'Accessible tests pass', constraints: 'Keep the API' },
    repositoryFingerprint: { languages: ['TypeScript'], frameworks: [{ name: 'React', version: '19' }], databases: [], runtimes: ['Node.js'], tools: ['Vitest'] },
    capabilityCatalog: [{ kind: 'skill', name: 'kiokuko-ui-design-soul' }],
    discoveredSkills: [{ name: 'external-react-reference', source: 'official-catalog' }],
  });
  assert.match(directive.objective, /React settings panel/u);
  assert.match(directive.objective, /React@19/u);
  assert.match(directive.objective, /kiokuko-ui-design-soul/u);
  assert.match(directive.objective, /external-react-reference/u);
  assert.match(directive.objective, /reference-only/u);
  assert.match(directive.objective, /compact kiokuko-single-purpose-functions index/iu);
  assert.match(directive.objective, /one cohesive externally observable function or use-case contract/iu);
  assert.match(directive.objective, /focused runnable test target/iu);
  assert.match(directive.objective, /without meaningless micro-functions/iu);
  assert.match(directive.objective, /one to three versioned expertRefs/iu);
  assert.deepEqual(directive.requiredSkills, [
    'kiokuko-soul',
    'kiokuko-single-purpose-functions',
  ]);
  assert.ok(directive.harness.instructions.some((instruction) => /read and apply kiokuko-soul first/iu.test(instruction)));
  assert.ok(directive.stopConditions.some((condition) => /one cohesive function or use-case contract/iu.test(condition)));
  assert.equal(directive.handoff?.sourceRole, 'enno-oduno');
  assert.equal(directive.harness.kind, 'opencode');
  assert.equal(directive.harness.continuation, 'session_idle_plugin');
});

test('work plans reject multi-unit dependency cycles', () => {
  const contract = {
    objective: 'Reject a deadlocked plan',
    units: [
      { id: 'a', objective: 'A', scope: ['a.ts'], dependencies: ['b'], routes: ['code'], skillNames: [], acceptanceCriteria: ['A done'], focusedVerifiers: [] },
      { id: 'b', objective: 'B', scope: ['b.ts'], dependencies: ['a'], routes: ['code'], skillNames: [], acceptanceCriteria: ['B done'], focusedVerifiers: [] },
    ],
  };
  assert.throws(() => generateRoleDirective('zenki', {
    runId: 'cycle', taskType: 'build', status: 'zenki_planning', contractRevision: 1,
    contract: {
      revision: 1, scope: [], exclusions: [], acceptanceCriteria: [], workPlan: contract,
      skillSet: {
        entries: [],
        intakeDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
        zenkiDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
      },
      finalVerifiers: [], maxAttempts: 8,
      provenance: {
        scope: 'inferred', exclusions: 'inferred', acceptanceCriteria: 'inferred', workPlan: 'inferred',
        skillSet: 'inferred', finalVerifiers: 'inferred', maxAttempts: 'inferred',
      },
    },
    handoff: requestHandoff('build'),
    workUnits: [],
  }), /input is invalid/iu);
});

test('WorkUnits select a bounded versioned expert mixture for their actual routes', () => {
  const workPlan = {
    objective: 'Build an accessible save flow',
    units: [{
      id: 'save', objective: 'Implement save', scope: ['src/Save.tsx'], dependencies: [],
      routes: ['ui' as const], skillNames: ['kiokuko-single-purpose-functions', 'kiokuko-ui-design-soul'],
      expertRefs: [
        { id: 'code.effects.v1', reason: 'Persist the settings atomically' },
        { id: 'ui.async.v1', reason: 'Expose processing, failure, and retry' },
      ],
      acceptanceCriteria: ['Save is recoverable'], focusedVerifiers: [],
    }],
  };
  assert.doesNotThrow(() => assertWorkPlanExpertCoverage(workPlan));
  assert.throws(() => assertWorkPlanExpertCoverage({
    ...workPlan,
    units: workPlan.units.map((unit) => ({
      ...unit,
      expertRefs: [{ id: 'ui.async.v1', reason: 'Only the UI risk was selected' }],
    })),
  }), /Enno input is invalid/iu);
  assert.throws(() => assertWorkPlanExpertCoverage({
    ...workPlan,
    units: workPlan.units.map((unit) => ({
      ...unit,
      expertRefs: [{ id: 'code.effects.v1', reason: 'Only the code risk was selected' }],
    })),
  }), /Enno input is invalid/iu);
  assert.doesNotThrow(() => assertWorkPlanExpertCoverage({
    objective: 'Define a public article representation',
    units: [{
      id: 'article-shape', objective: 'Map domain articles to the public response', scope: ['src/article.ts'], dependencies: [],
      routes: ['code' as const], skillNames: ['kiokuko-single-purpose-functions'],
      expertRefs: [{ id: 'code.modeling.v1', reason: 'Separate domain and public article representations' }],
      acceptanceCriteria: ['The public response contains only consumer-facing fields'], focusedVerifiers: [],
    }],
  }));
});

test('WorkUnit expertRefs reject unknown, duplicate, or oversized mixtures', () => {
  const base = {
    runId: 'run', workspace: 'workspace', orchestrationId: 'session', expectedRevision: 1, idempotencyKey: 'plan',
    scope: ['src/a.ts'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Done' }],
    skillRequirements: [], finalVerifiers: [{
      id: 'test', kind: 'test', executable: process.execPath, args: [], cwd: '.', timeoutMs: 1000,
    }], maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  };
  const submission = (expertRefs: { id: string; reason: string }[]) => ({
    ...base,
    workPlan: { objective: 'Build', units: [{
      id: 'build', objective: 'Build', scope: ['src/a.ts'], dependencies: [], routes: ['code'], skillNames: [],
      expertRefs, acceptanceCriteria: ['Done'], focusedVerifiers: [],
    }] },
  });
  assert.throws(() => parsePlanSubmission(submission([
    { id: 'code.unknown.v1', reason: 'Not registered' },
  ])), /Enno input is invalid/iu);
  assert.throws(() => parsePlanSubmission(submission([
    { id: 'code.domain.v1', reason: 'First' },
    { id: 'code.domain.v1', reason: 'Duplicate' },
  ])), /Enno input is invalid/iu);
  assert.throws(() => parsePlanSubmission(submission([
    { id: 'code.boundary.v1', reason: 'One' },
    { id: 'code.domain.v1', reason: 'Two' },
    { id: 'code.effects.v1', reason: 'Three' },
    { id: 'code.protocol.v1', reason: 'Four is too many' },
  ])), /Enno input is invalid/iu);
  assert.doesNotThrow(() => parsePlanSubmission(submission([
    { id: 'code.modeling.v1', reason: 'Define the public representation before serialization' },
  ])));
  const validSubmission = submission([]);
  assert.throws(() => parsePlanSubmission({
    ...validSubmission,
    finalVerifiers: [validSubmission.finalVerifiers[0], { ...validSubmission.finalVerifiers[0] }],
  }), /Enno input is invalid/iu);
});

test('plan validation diagnostics are bounded, value-free, and directly corrective', () => {
  const base = {
    runId: 'diagnostic-run', workspace: 'workspace', orchestrationId: 'orchestration',
    expectedRevision: 1, idempotencyKey: 'diagnostic-plan',
    scope: ['src/a.ts'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Done' }],
    workPlan: { objective: 'Build', units: [{
      id: 'build', objective: 'Build', scope: ['src/a.ts'], dependencies: [], routes: ['code'], skillNames: [],
      expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the change' }],
      acceptanceCriteria: ['Done'], focusedVerifiers: [],
    }] },
    skillRequirements: [],
    finalVerifiers: [{ id: 'test', kind: 'test', executable: process.execPath, args: [], cwd: '.', timeoutMs: 1_000 }],
    maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  };

  const oversizedExperts = validationDetail(() => parsePlanSubmission({
    ...base,
    workPlan: { ...base.workPlan, units: [{
      ...base.workPlan.units[0],
      expertRefs: [
        { id: 'code.boundary.v1', reason: 'Boundary' },
        { id: 'code.domain.v1', reason: 'Domain' },
        { id: 'code.effects.v1', reason: 'Effects' },
        { id: 'code.protocol.v1', reason: 'Protocol' },
      ],
    }] },
  }));
  assert.deepEqual(oversizedExperts.issues[0], {
    path: ['workPlan', 'units', 0, 'expertRefs'],
    reasonCode: 'too_many_items',
    expected: { maxItems: 3 },
  });
  assert.equal(oversizedExperts.retry, 'correct_input');
  assert.equal(oversizedExperts.mutationApplied, false);

  const missingSlot = validationDetail(() => parsePlanSubmission({
    ...base,
    advisoryRoundDigest: 'a'.repeat(64),
    advisoryDisposition: [{ disposition: 'adopted', rationale: 'Use the advice' }],
  }));
  assert.deepEqual(missingSlot.issues[0], {
    path: ['advisoryDisposition', 0, 'slotId'],
    reasonCode: 'missing_required_field',
  });

  const absoluteDirectory = '/private/tmp/secret-repository-path';
  const invalidDirectory = validationDetail(() => parsePlanSubmission({
    ...base,
    finalVerifiers: [{ ...base.finalVerifiers[0], cwd: absoluteDirectory }],
  }));
  assert.deepEqual(invalidDirectory.issues[0], {
    path: ['finalVerifiers', 0, 'cwd'],
    reasonCode: 'invalid_verifier_directory',
    expected: { directoryPolicy: 'repository_relative' },
  });
  assert.equal(JSON.stringify(invalidDirectory).includes(absoluteDirectory), false);

  const tooManyIssues = validationDetail(() => parsePlanSubmission({
    ...base,
    workPlan: {
      objective: 'Build',
      units: Array.from({ length: ENNO_MAX_PUBLIC_ISSUES + 5 }, (_, index) => ({
        id: `unit-${index}`, objective: 'Build', scope: [`src/${index}.ts`], dependencies: [], skillNames: [],
        expertRefs: [], acceptanceCriteria: ['Done'], focusedVerifiers: [],
      })),
    },
  }));
  assert.equal(tooManyIssues.issues.length, ENNO_MAX_PUBLIC_ISSUES);
  assert.deepEqual(tooManyIssues.issues.map((issue) => issue.path[2]), Array.from({ length: ENNO_MAX_PUBLIC_ISSUES }, (_, index) => index));

  const oversizedIdeal = validationDetail(() => parseIdealSubmission({
    runId: 'diagnostic-run', workspace: 'workspace', orchestrationId: 'orchestration',
    expectedRevision: 1, idempotencyKey: 'diagnostic-ideal',
    ideal: {
      objective: 'x'.repeat(16_385),
      principles: ['Keep the contract'],
      skillContributions: [],
      successSignals: ['Tests pass'],
    },
  }));
  assert.deepEqual(oversizedIdeal.issues[0], {
    path: ['ideal', 'objective'],
    reasonCode: 'too_many_items',
    expected: { maxItems: 16_384 },
  });
});

test('plan sanitization rejects split credentials without rewriting safe verifier commands', () => {
  const base = parsePlanSubmission({
    runId: 'sanitize-run', workspace: 'workspace', orchestrationId: 'orchestration',
    expectedRevision: 1, idempotencyKey: 'sanitize-plan',
    scope: ['src/a.ts'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Done' }],
    workPlan: { objective: 'Build', units: [{
      id: 'build', objective: 'Build', scope: ['src/a.ts'], dependencies: [], routes: ['code'], skillNames: [],
      expertRefs: [{ id: 'code.boundary.v1', reason: 'Protect the boundary' }],
      acceptanceCriteria: ['Done'],
      focusedVerifiers: [{
        id: 'focused', kind: 'test', executable: '/repo/scripts/check.mjs',
        args: ['https://example.test/check?mode=strict#expected'], cwd: 'subdir', timeoutMs: 1_000,
      }],
    }] },
    skillRequirements: [],
    finalVerifiers: [{
      id: 'final', kind: 'test', executable: 'curl',
      args: ['https://example.test/check?mode=strict#expected'], cwd: '.', timeoutMs: 1_000,
    }],
    maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  });

  const sanitized = sanitizePlanSubmission(base, '/repo');
  assert.deepEqual(sanitized.finalVerifiers, base.finalVerifiers);
  assert.deepEqual(sanitized.workPlan.units[0]?.focusedVerifiers, base.workPlan.units[0]?.focusedVerifiers);

  assert.throws(
    () => sanitizePlanSubmission({
      ...base,
      finalVerifiers: [{ ...base.finalVerifiers[0]!, args: ['--password', 'correct-horse'] }],
    }, '/repo'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'SECURITY_REJECTION',
  );
});

test('mixed WorkUnit routes enforce experts locally and do not infect test or docs units', () => {
  const mixedPlan = {
    objective: 'Implement a mixed product change',
    units: [
      {
        id: 'ui', objective: 'Implement the UI', scope: ['src/ui.ts'], dependencies: [], routes: ['ui' as const], skillNames: [],
        expertRefs: [
          { id: 'code.effects.v1', reason: 'Control UI effects' },
          { id: 'ui.async.v1', reason: 'Represent async UI state' },
        ],
        acceptanceCriteria: ['UI works'], focusedVerifiers: [],
      },
      {
        id: 'data', objective: 'Convert catalog data', scope: ['src/data.ts'], dependencies: [], routes: ['code' as const], skillNames: [],
        expertRefs: [{ id: 'code.domain.v1', reason: 'Preserve catalog invariants' }],
        acceptanceCriteria: ['Data converts'], focusedVerifiers: [],
      },
      {
        id: 'tests', objective: 'Add tests', scope: ['tests/data.test.ts'], dependencies: ['data'], routes: ['test' as const], skillNames: [],
        expertRefs: [], acceptanceCriteria: ['Tests cover conversion'], focusedVerifiers: [],
      },
      {
        id: 'docs', objective: 'Update docs', scope: ['README.md'], dependencies: [], routes: ['docs' as const], skillNames: [],
        expertRefs: [], acceptanceCriteria: ['Docs match behavior'], focusedVerifiers: [],
      },
      {
        id: 'residual', objective: 'Check residual references', scope: ['.gitignore'], dependencies: [], routes: ['operations' as const], skillNames: [],
        expertRefs: [], acceptanceCriteria: ['No stale references'], focusedVerifiers: [],
      },
    ],
  };
  assert.doesNotThrow(() => assertWorkPlanExpertCoverage(mixedPlan));
  const missingUi = validationDetail(() => assertWorkPlanExpertCoverage({
    ...mixedPlan,
    units: mixedPlan.units.map((unit, index) => index === 0
      ? { ...unit, expertRefs: [{ id: 'code.effects.v1', reason: 'Only code expertise' }] }
      : unit),
  }));
  assert.deepEqual(missingUi.issues[0], {
    path: ['workPlan', 'units', 0, 'expertRefs'],
    reasonCode: 'missing_ui_expert',
    expected: { requiredExpertKinds: ['ui'] },
  });
});

test('canonical WorkPlan text rejects embedded control and format characters', () => {
  const submission = (objective: string) => ({
    runId: 'canonical-text', workspace: 'workspace', orchestrationId: 'session', expectedRevision: 1, idempotencyKey: 'canonical-plan',
    scope: ['src/a.ts'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Done' }],
    workPlan: { objective, units: [{
      id: 'build', objective: 'Build', scope: ['src/a.ts'], dependencies: [], routes: ['code'], skillNames: [],
      expertRefs: [{ id: 'code.verification.v1', reason: 'Verify the canonical text boundary' }],
      acceptanceCriteria: ['Done'], focusedVerifiers: [],
    }] },
    skillRequirements: [],
    finalVerifiers: [{ id: 'test', kind: 'test', executable: process.execPath, args: [], cwd: '.', timeoutMs: 1000 }],
    maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  });
  for (const control of ['\r', '\n', '\t', '\u0000', '\u007f', '\u200b']) {
    assert.throws(() => parsePlanSubmission(submission(`Repair${control}the module`)), /Enno input is invalid/iu);
  }
});

test('Enno identifies OpenCode and rejects unknown or contradictory client identity', () => {
  assert.equal(identifyEnnoClientKind('other-mcp-client'), null);
  assert.equal(identifyEnnoClientKind('unrelated-ai'), null);
  assert.equal(identifyEnnoClientKind('opencode'), 'opencode');
  assert.equal(identifyEnnoClientKind('unrelated-client'), null);

  assert.deepEqual(resolveTaskPrepareClient(undefined, {
    name: 'opencode',
    version: '1.2.3',
  }), {
    kind: 'opencode',
    version: '1.2.3',
  });
  assert.throws(() => resolveTaskPrepareClient({ kind: 'other-client' }, {
    name: 'opencode',
    version: '1.2.3',
  }), /conflicts with the MCP client/iu);
});

test('mandatory SOUL assignment is deterministic and does not duplicate requirements', () => {
  const requirements = completeRequiredSkillList({
    requested: [
      { name: 'kiokuko-soul', purposes: ['review'], required: false },
      { name: 'kiokuko-single-purpose-functions', purposes: ['testing'], required: false },
    ],
    includesCodeChanges: true,
    includesUiWork: true,
  });
  assert.deepEqual(requirements.map((item) => item.name), [
    'kiokuko-soul',
    'kiokuko-single-purpose-functions',
    'kiokuko-ui-design-soul',
  ]);
  assert.equal(requirements[0]?.required, true);
  assert.deepEqual(orderedUniqueSkillNames(
    ['kiokuko-soul', 'kiokuko-single-purpose-functions'],
    ['kiokuko_soul', 'external-review'],
  ), ['kiokuko-soul', 'kiokuko-single-purpose-functions', 'external-review']);
});

test('reference-only Skills cannot satisfy a required executable Skill contract', () => {
  assert.deepEqual(unavailableRequiredSkills([
    { name: 'local', purposes: ['implementation'], required: true, availability: 'local', referenceId: null },
    { name: 'fresh', purposes: ['testing'], required: true, availability: 'imported_fresh', referenceId: 'skill-2' },
    { name: 'reference', purposes: ['implementation'], required: true, availability: 'external_reference', referenceId: 'skill-1' },
    { name: 'optional', purposes: ['review'], required: false, availability: 'unavailable', referenceId: null },
  ]).map((entry) => entry.name), ['reference']);
});

test('a WorkUnit cannot smuggle an undeclared Skill into the role directive', () => {
  assert.throws(() => parsePlanSubmission({
    runId: 'run', workspace: 'workspace', orchestrationId: 'session', expectedRevision: 1, idempotencyKey: 'plan',
    scope: ['src/a.ts'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Done' }],
    workPlan: { objective: 'Build', units: [{
      id: 'build', objective: 'Build', scope: ['src/a.ts'], dependencies: [], routes: ['code'], skillNames: ['undeclared'],
      acceptanceCriteria: ['Done'], focusedVerifiers: [],
    }] },
    skillRequirements: [], finalVerifiers: [{
      id: 'test', kind: 'test', executable: process.execPath, args: [], cwd: '.', timeoutMs: 1000,
    }], maxAttempts: 8,
    provenance: {
      scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user',
      workPlan: 'explicit_user', skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
    },
  }), /Enno input is invalid/iu);
});

test('verifier uses shell false semantics, bounds output, and rejects repository escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-verifier-'));
  const passed = await runVerifier({
    id: 'pass', kind: 'test', executable: process.execPath,
    args: ['--eval', 'process.stdout.write("x".repeat(20000))'], cwd: root, timeoutMs: 5000,
  }, root);
  assert.equal(passed.status, 'passed');
  assert.ok(Buffer.byteLength(passed.stdoutPreview) <= 8192);
  assert.match(passed.stdoutDigest, /^[0-9a-f]{64}$/u);
  await assert.rejects(runVerifier({
    id: 'escape', kind: 'custom', executable: process.execPath, args: [], cwd: path.dirname(root), timeoutMs: 1000,
  }, root), /inside the canonical repository root/iu);
  await assert.rejects(runVerifier({
    id: 'shell', kind: 'custom', executable: 'node --eval', args: [], cwd: root, timeoutMs: 1000,
  }, root), /verifier is invalid/iu);
  const outside = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-verifier-outside-'));
  await symlink(outside, path.join(root, 'escape-link'));
  await assert.rejects(runVerifier({
    id: 'symlink-escape', kind: 'custom', executable: process.execPath, args: [], cwd: 'escape-link', timeoutMs: 1000,
  }, root), /inside the canonical repository root/iu);
  const timeout = await runVerifier({
    id: 'timeout', kind: 'test', executable: process.execPath,
    args: ['--eval', 'setTimeout(() => {}, 10000)'], cwd: root, timeoutMs: 100,
  }, root);
  assert.equal(timeout.status, 'timeout');
});

test('verifier batches remember transient and delayed descendant repository mutations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-verifier-mutation-'));
  const tracked = path.join(root, 'tracked.txt');
  await writeFile(tracked, 'original\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'tests@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Kiokuko Tests']);
  execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  const mutateRestore = await runVerifiers([{
    id: 'mutate-restore', kind: 'test', executable: process.execPath,
    args: ['--eval', `const fs=require('node:fs');const p=${JSON.stringify(tracked)};const v=fs.readFileSync(p);fs.writeFileSync(p,'temporary\\n');setTimeout(()=>fs.writeFileSync(p,v),60);`],
    cwd: root,
    timeoutMs: 5_000,
  }], root, { descendantSettleMs: 100 });
  assert.equal(mutateRestore[0]?.status, 'passed');
  assert.equal(mutateRestore[0]?.changedDuringVerification, true);

  const delayedDescendant = await runVerifiers([{
    id: 'delayed-descendant', kind: 'test', executable: process.execPath,
    args: ['--eval', `const {spawn}=require('node:child_process');const p=${JSON.stringify(tracked)};spawn(process.execPath,['--eval',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(tracked)},'late\\n'),100)`)}],{detached:true,stdio:'ignore'}).unref();`],
    cwd: root,
    timeoutMs: 5_000,
  }], root, { descendantSettleMs: 300 });
  assert.equal(delayedDescendant[0]?.status, 'passed');
  assert.equal(delayedDescendant[0]?.changedDuringVerification, true);
});

test('verifier ignores generated files under ignored directories but detects normal untracked files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-verifier-ignored-'));
  await writeFile(path.join(root, '.gitignore'), 'dist/\n');
  await writeFile(path.join(root, 'tracked.txt'), 'original\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'tests@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Kiokuko Tests']);
  execFileSync('git', ['-C', root, 'add', '.gitignore', 'tracked.txt']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);

  const ignoredOutput = await runVerifiers([{
    id: 'ignored-output', kind: 'build', executable: process.execPath,
    args: ['--eval', "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/generated.js','build');"],
    cwd: '.', timeoutMs: 5_000,
  }], root, { descendantSettleMs: 100 });
  assert.equal(ignoredOutput[0]?.status, 'passed');
  assert.equal(ignoredOutput[0]?.changedDuringVerification, false);

  const untrackedFile = await runVerifiers([{
    id: 'untracked-output', kind: 'test', executable: process.execPath,
    args: ['--eval', "require('node:fs').writeFileSync('untracked.txt','changed');"],
    cwd: '.', timeoutMs: 5_000,
  }], root, { descendantSettleMs: 100 });
  assert.equal(untrackedFile[0]?.status, 'passed');
  assert.equal(untrackedFile[0]?.changedDuringVerification, true);
});

test('repository-state evidence changes for staged, untracked, renamed, and symlink state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-state-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'tests@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Kiokuko Tests']);
  await writeFile(path.join(root, 'tracked.txt'), 'initial\n');
  await writeFile(path.join(root, 'target-a.txt'), 'a\n');
  await writeFile(path.join(root, 'target-b.txt'), 'b\n');
  await symlink('target-a.txt', path.join(root, 'current-target'));
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  const initial = captureRepositoryState(root);

  await writeFile(path.join(root, 'tracked.txt'), 'staged\n');
  execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
  const staged = captureRepositoryState(root);
  assert.notEqual(staged.digest, initial.digest);

  await writeFile(path.join(root, 'untracked.txt'), 'new\n');
  const untracked = captureRepositoryState(root);
  assert.notEqual(untracked.digest, staged.digest);

  await rename(path.join(root, 'target-b.txt'), path.join(root, 'renamed.txt'));
  const renamed = captureRepositoryState(root);
  assert.notEqual(renamed.digest, untracked.digest);

  execFileSync('git', ['-C', root, 'rm', 'current-target']);
  await symlink('renamed.txt', path.join(root, 'current-target'));
  const changedSymlink = captureRepositoryState(root);
  assert.notEqual(changedSymlink.digest, renamed.digest);
  assert.equal(changedSymlink.policyVersion, 1);
});

test('repository-state evidence includes dirty submodule contents', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-submodule-source-'));
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'config', 'user.email', 'tests@example.invalid']);
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Kiokuko Tests']);
  await writeFile(path.join(source, 'nested.txt'), 'committed\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);

  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-submodule-root-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'tests@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Kiokuko Tests']);
  execFileSync('git', ['-C', root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'module']);
  execFileSync('git', ['-C', root, 'commit', '-qam', 'add submodule']);

  await writeFile(path.join(root, 'module', 'nested.txt'), 'dirty-a\n');
  const dirtyA = captureRepositoryState(root);
  await writeFile(path.join(root, 'module', 'nested.txt'), 'dirty-b\n');
  const dirtyB = captureRepositoryState(root);
  assert.notEqual(dirtyB.digest, dirtyA.digest);
});

test('verifier waits for close and escalates when termination emits an error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-verifier-cleanup-'));
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: string[] = [];
  const fakeChild = Object.assign(child, {
    stdout,
    stderr,
    kill(signal: string) {
      signals.push(signal);
      if (signal === 'SIGTERM') {
        queueMicrotask(() => child.emit('error', new Error('termination failed')));
      } else {
        queueMicrotask(() => {
          stdout.end();
          stderr.end();
          child.emit('close', null, 'SIGKILL');
        });
      }
      return true;
    },
  });
  const result = await runVerifier({
    id: 'cleanup', kind: 'test', executable: 'node', args: [], cwd: root, timeoutMs: 100,
  }, root, { spawn: (() => fakeChild) as never });
  assert.equal(result.status, 'timeout');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('operation lease covers the full sequential verifier timeout budget', () => {
  const leaseMs = operationLeaseMsForVerifiers([
    { id: 'first', kind: 'test', executable: 'node', args: [], cwd: '.', timeoutMs: 300_000 },
    { id: 'second', kind: 'test', executable: 'node', args: [], cwd: '.', timeoutMs: 300_000 },
  ]);
  assert.equal(leaseMs, 662_000);
});
