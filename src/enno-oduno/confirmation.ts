import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { findSecretInValue } from '../memory/secrets.js';
import { canonicalJson } from '../serialization/validate.js';
import type {
  ConfirmationBasis,
  ContractProvenance,
  EnnoProvenanceKey,
  EnnoRunSnapshot,
  ExpertRef,
  SkillSetEntry,
  UserFacingConfirmation,
  UserFacingExpertise,
  UserFacingSkill,
  UserFacingVerifier,
  UserFacingWorkItem,
  VerifierSpec,
  WorkUnit,
} from './types.js';

export const MAX_CONFIRMATION_JSON_BYTES = 64 * 1024;

const BASIS_BY_PROVENANCE = {
  explicit_user: 'user',
  repository_evidence: 'repository',
  inferred: 'proposal',
} as const satisfies Record<ContractProvenance, ConfirmationBasis>;

const EXPERT_AREAS = {
  'code.boundary.v1': 'Input and data boundaries',
  'code.domain.v1': 'Business rules and state transitions',
  'code.effects.v1': 'Database, filesystem, network, and process effects',
  'code.protocol.v1': 'Retries, conflicts, revisions, and compatibility',
  'code.verification.v1': 'Regression prevention and verification design',
  'code.modeling.v1': 'Problem shaping and representation design',
  'ui.interaction.v1': 'Interaction states and feedback',
  'ui.async.v1': 'Asynchronous work and recovery',
  'ui.forms.v1': 'Forms and input validation',
  'ui.accessibility.v1': 'Accessibility and navigation',
  'ui.layout.v1': 'Responsive layout',
  'ui.safety.v1': 'UI safety and review',
} as const satisfies Record<string, string>;

function basisFor(provenance: EnnoRunSnapshot['contract']['provenance'], key: EnnoProvenanceKey): ConfirmationBasis {
  return BASIS_BY_PROVENANCE[provenance[key]];
}

function displayDirectory(cwd: string, repositoryRoot: string): string {
  if (!path.isAbsolute(cwd)) return cwd === '' ? '.' : cwd;
  const relative = path.relative(repositoryRoot, cwd);
  if (relative === '') return '.';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored Enno verifier cwd escapes the repository root');
  }
  return relative;
}

function toUserFacingVerifier(verifier: VerifierSpec, repositoryRoot: string): UserFacingVerifier {
  return {
    category: verifier.kind,
    executable: verifier.executable,
    arguments: [...verifier.args],
    directory: displayDirectory(verifier.cwd, repositoryRoot),
    timeoutMs: verifier.timeoutMs,
  };
}

function toUserFacingSkill(entry: SkillSetEntry, basis: ConfirmationBasis): UserFacingSkill {
  return {
    label: entry.name,
    basis,
    required: entry.required,
    purposes: [...entry.purposes],
    referenceOnly: entry.availability === 'external_reference',
  };
}

function toUserFacingExpertise(reference: ExpertRef, basis: ConfirmationBasis): UserFacingExpertise {
  const area = EXPERT_AREAS[reference.id as keyof typeof EXPERT_AREAS];
  if (area === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored Enno expert selection is outside the registered expert set');
  }
  return { area, basis, reason: reference.reason };
}

function workItemNumbers(units: readonly WorkUnit[]): Map<string, number> {
  const numbers = new Map<string, number>();
  units.forEach((unit, index) => {
    numbers.set(unit.id, index + 1);
  });
  return numbers;
}

function toUserFacingWorkItem(
  unit: WorkUnit,
  number: number,
  numbers: Map<string, number>,
  basis: ConfirmationBasis,
  repositoryRoot: string,
): UserFacingWorkItem {
  return {
    number,
    summary: unit.objective,
    paths: [...unit.scope],
    dependsOn: unit.dependencies.map((dependency) => {
      const resolved = numbers.get(dependency);
      if (resolved === undefined) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored Enno WorkPlan dependency does not resolve to a displayed work item');
      }
      return resolved;
    }),
    doneWhen: [...unit.acceptanceCriteria],
    checks: unit.focusedVerifiers.map((verifier) => toUserFacingVerifier(verifier, repositoryRoot)),
    expertise: unit.expertRefs.map((reference) => toUserFacingExpertise(reference, basis)),
  };
}

function assertDisplaySafety(confirmation: UserFacingConfirmation): void {
  const secret = findSecretInValue(confirmation);
  if (secret !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'Plan confirmation resembles a secret and was not displayed', { kind: secret.kind });
  }
  if (Buffer.byteLength(canonicalJson(confirmation), 'utf8') > MAX_CONFIRMATION_JSON_BYTES) {
    throw new KiokukoError('VALIDATION_ERROR', 'Plan confirmation exceeds the 64 KiB display limit and must be replanned');
  }
}

export function buildUserFacingConfirmation(snapshot: EnnoRunSnapshot): UserFacingConfirmation | undefined {
  if (snapshot.status !== 'needs_confirmation') return undefined;
  const contract = snapshot.contract;
  const provenance = contract.provenance;
  const workPlanBasis = basisFor(provenance, 'workPlan');
  const skillBasis = basisFor(provenance, 'skillSet');
  const numbers = workItemNumbers(contract.workPlan.units);
  const confirmation: UserFacingConfirmation = {
    presentationVersion: 1,
    title: 'Plan approval',
    summary: { basis: workPlanBasis, text: contract.workPlan.objective },
    scope: { basis: basisFor(provenance, 'scope'), paths: [...contract.scope] },
    exclusions: { basis: basisFor(provenance, 'exclusions'), paths: [...contract.exclusions] },
    completion: {
      basis: basisFor(provenance, 'acceptanceCriteria'),
      items: contract.acceptanceCriteria.map((criterion) => criterion.description),
    },
    skills: contract.skillSet.entries.map((entry) => toUserFacingSkill(entry, skillBasis)),
    workItems: contract.workPlan.units.map((unit, index) => toUserFacingWorkItem(unit, index + 1, numbers, workPlanBasis, snapshot.repositoryRoot)),
    finalChecks: {
      basis: basisFor(provenance, 'finalVerifiers'),
      checks: contract.finalVerifiers.map((verifier) => toUserFacingVerifier(verifier, snapshot.repositoryRoot)),
    },
    attemptLimit: { basis: basisFor(provenance, 'maxAttempts'), maxAttempts: contract.maxAttempts },
    actions: ['approve', 'revise', 'cancel'],
  };
  assertDisplaySafety(confirmation);
  return confirmation;
}
