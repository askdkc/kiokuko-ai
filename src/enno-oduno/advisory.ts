import path from 'node:path';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { findSecret, findSecretInValue } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';
import { ennoValidationError } from './validation-errors.js';
import { verifierCommandContainsSecret } from './sanitize.js';
import {
  ADVISORY_FAILURE_CODES,
  ADVISORY_MAX_ROUND_BYTES,
  ADVISORY_MAX_SLOT_BYTES,
  ADVISORY_OUTCOMES,
  ADVISORY_PHASES,
  ADVISORY_POLICY_VERSION,
  ADVISORY_SLOT_DEFINITIONS,
  type AdvisoryContext,
  type AdvisoryContribution,
  type AdvisoryFanoutDirective,
  type AdvisoryFinalVerifierEvidence,
  type AdvisoryPhase,
  type AdvisorySkillTrust,
  type AdvisorySlotId,
  type AdvisoryWorkUnitOutcome,
  type EnnoRunSnapshot,
  type SkillSetEntry,
} from './types.js';

const phaseSlots = (phase: AdvisoryPhase) => ADVISORY_SLOT_DEFINITIONS.filter((slot) => slot.phase === phase);
const secretArgument = /(?:^|\s)--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret)(?:=|\s+)\S+/iu;

export function advisorySlotDefinitions(phase: AdvisoryPhase): AdvisoryFanoutDirective['slots'] {
  return phaseSlots(phase).map((slot) => ({
    slotId: slot.slotId,
    rank: slot.rank,
    role: slot.role,
    instructions: `Act only as the ${slot.role}. Read-only isolation must be provided and verified by the parent host. Return a structured contribution for slot ${slot.slotId}; do not edit files, call Kiokuko tools, or claim independent execution guarantees.`,
  }));
}

export function advisoryInputDigest(input: {
  phase: AdvisoryPhase;
  contractRevision: number;
  mutationRevision: number;
  allowlistedContext: AdvisoryContext;
}): string {
  return canonicalContentHash({
    version: 1,
    phase: input.phase,
    contractRevision: input.contractRevision,
    mutationRevision: input.mutationRevision,
    slotDefinitions: advisorySlotDefinitions(input.phase),
    advisoryPolicyVersion: ADVISORY_POLICY_VERSION,
    allowlistedContext: input.allowlistedContext,
  });
}

export function advisoryPhaseForStatus(status: EnnoRunSnapshot['status']): AdvisoryPhase | null {
  if (status === 'oduno_ideal') return 'ideal';
  if (status === 'zenki_planning') return 'planning';
  if (status === 'enno_verifying') return 'final_review';
  return null;
}

function skillTrustFromEntries(entries: readonly SkillSetEntry[]): AdvisorySkillTrust[] {
  return entries.slice(0, 64).map((entry) => {
    const trustStatus = entry.availability === 'external_reference'
      ? 'reference_only' as const
      : entry.availability === 'unavailable'
        ? 'unavailable' as const
        : 'available' as const;
    return {
      name: entry.name,
      source: entry.availability,
      required: entry.required,
      trustStatus,
    };
  });
}

export function projectRepositoryRelativePath(repositoryRoot: string, value: string): string {
  if (value.includes('\0')) return '#redacted';
  if (value.split(/[\\/]/).includes('..')) return '#redacted';
  if (path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) return '#redacted';
  if (path.posix.isAbsolute(value)) {
    const relative = path.relative(repositoryRoot, value).split(path.sep).join('/');
    if (relative === '' || relative === '..' || relative.startsWith('../')) return '#redacted';
    return relative;
  }
  return value;
}

function projectChangedPaths(repositoryRoot: string, paths: readonly string[]): string[] {
  return paths.map((value) => projectRepositoryRelativePath(repositoryRoot, value));
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let projected = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    projected += character;
    bytes += characterBytes;
  }
  return projected;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function projectRepositoryText(repositoryRoot: string, value: string): string {
  if (findSecret(value) !== undefined) return '#redacted';
  const canonicalRoot = path.resolve(repositoryRoot);
  const variants = new Set([
    canonicalRoot,
    canonicalRoot.split(path.sep).join('/'),
    canonicalRoot.split(path.sep).join('\\'),
  ]);
  let projected = value;
  for (const variant of variants) {
    if (variant.length === 0) continue;
    projected = projected.replace(new RegExp(`${escapeRegExp(variant)}(?=$|[\\\\/\\s:;,)}\\]])`, 'gu'), '.');
  }
  return projected;
}

function finalReviewEvidence(
  repositoryRoot: string,
  evidence: readonly EnnoRunSnapshot['finalEvidence'][number][],
): AdvisoryFinalVerifierEvidence[] {
  return evidence.map((result) => {
    const unsafeCommand = verifierCommandContainsSecret(result.verifier);
    return {
      id: result.verifier.id,
      kind: result.verifier.kind,
      executable: unsafeCommand ? '#redacted' : projectRepositoryText(repositoryRoot, result.verifier.executable),
      args: unsafeCommand ? ['#redacted'] : result.verifier.args.map((argument) => projectRepositoryText(repositoryRoot, argument)),
      directory: projectRepositoryRelativePath(repositoryRoot, result.verifier.cwd),
      timeoutMs: result.verifier.timeoutMs,
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutDigest: result.stdoutDigest,
      stderrDigest: result.stderrDigest,
      stdoutPreview: truncateUtf8(projectRepositoryText(repositoryRoot, result.stdoutPreview), 2_048),
      stderrPreview: truncateUtf8(projectRepositoryText(repositoryRoot, result.stderrPreview), 2_048),
      repositoryStatePolicyVersion: result.repositoryStatePolicyVersion ?? null,
      repositoryStateDigest: result.repositoryStateDigest ?? null,
    };
  });
}

function finalReviewOutcomes(snapshot: EnnoRunSnapshot): AdvisoryWorkUnitOutcome[] {
  return snapshot.workUnits
    .filter((unit) => unit.status === 'completed' && unit.result !== null)
    .map((unit) => ({
      id: unit.workUnit.id,
      objective: projectRepositoryText(snapshot.repositoryRoot, unit.workUnit.objective),
      acceptanceCriteria: unit.workUnit.acceptanceCriteria.map((criterion) => projectRepositoryText(snapshot.repositoryRoot, criterion)),
      routes: [...(unit.workUnit.routes ?? [])],
      status: unit.result!.outcome,
      summary: projectRepositoryText(snapshot.repositoryRoot, unit.result!.summary),
      mutated: unit.result!.mutated,
      changedPaths: projectChangedPaths(snapshot.repositoryRoot, unit.result!.changedPaths),
    }));
}

const ADVISORY_MAX_CONTEXT_BYTES = 64 * 1024;

function boundedAdvisoryContext<T extends AdvisoryContext>(context: T): T {
  if (Buffer.byteLength(canonicalJson(context), 'utf8') > ADVISORY_MAX_CONTEXT_BYTES) {
    throw new KiokukoError('CONFLICT', 'Enno advisory context exceeds the safety limit');
  }
  return context;
}

export function advisoryContextForSnapshot(snapshot: EnnoRunSnapshot, phase: AdvisoryPhase): AdvisoryContext {
  if (phase === 'ideal') {
    return boundedAdvisoryContext({
      phase: 'ideal',
      objective: snapshot.handoff.objective,
      constraints: [...snapshot.handoff.constraints],
      expectedOutcome: snapshot.handoff.expected ?? '',
      successSignals: [...snapshot.handoff.verification],
      skillTrust: skillTrustFromEntries(snapshot.contract.skillSet.entries),
    });
  }
  if (phase === 'planning') {
    return boundedAdvisoryContext({
      phase: 'planning',
      idealObjective: snapshot.ideal?.objective ?? snapshot.handoff.objective,
      acceptanceCriteria: snapshot.contract.acceptanceCriteria.map((criterion) => criterion.description),
      planningConstraints: [...snapshot.handoff.constraints],
      skillAvailability: skillTrustFromEntries(snapshot.contract.skillSet.entries),
    });
  }
  const changedPaths = projectChangedPaths(
    snapshot.repositoryRoot,
    [...new Set(snapshot.workUnits.flatMap((unit) => unit.result?.changedPaths ?? []))],
  );
  const verifierEvidence = finalReviewEvidence(snapshot.repositoryRoot, snapshot.finalEvidence);
  const repositoryStateDigest = verifierEvidence[0]?.repositoryStateDigest;
  const evidenceFreshnessPolicyVersion = verifierEvidence[0]?.repositoryStatePolicyVersion;
  if (repositoryStateDigest === null || repositoryStateDigest === undefined
    || evidenceFreshnessPolicyVersion === null || evidenceFreshnessPolicyVersion === undefined) {
    throw new KiokukoError('CONFLICT', 'Final review requires repository-state-bound verifier evidence');
  }
  return boundedAdvisoryContext({
    phase: 'final_review',
    workPlanSummary: projectRepositoryText(snapshot.repositoryRoot, snapshot.contract.workPlan.objective),
    acceptanceCriteria: snapshot.contract.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      description: projectRepositoryText(snapshot.repositoryRoot, criterion.description),
    })),
    workUnitOutcomes: finalReviewOutcomes(snapshot),
    changedPaths,
    verifierEvidence,
    evidenceSetDigest: canonicalContentHash(verifierEvidence),
    repositoryStateDigest,
    evidenceFreshnessPolicyVersion,
    freshnessMarker: canonicalContentHash({
      revision: snapshot.revision,
      mutationRevision: snapshot.mutationRevision,
      evidenceProjection: verifierEvidence,
      repositoryStateDigest,
    }),
  });
}

export function advisoryDirectiveForSnapshot(snapshot: EnnoRunSnapshot): AdvisoryFanoutDirective | undefined {
  const phase = advisoryPhaseForStatus(snapshot.status);
  if (phase === null) return undefined;
  if (phase === 'final_review' && !snapshot.finalEvidenceReady) return undefined;
  if (snapshot.advisoryPhaseState !== undefined
    && snapshot.advisoryPhaseState.state !== 'fanout_requested') return undefined;
  return {
    protocolVersion: 1,
    phase,
    policyVersion: ADVISORY_POLICY_VERSION,
    readOnlyRequired: true,
    hostMustVerifyIsolation: true,
    context: advisoryContextForSnapshot(snapshot, phase),
    slots: advisorySlotDefinitions(phase),
  };
}

function unsafeText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return findSecret(value) !== undefined || secretArgument.test(value);
}

function contributionContainsSecret(contribution: AdvisoryContribution): boolean {
  return findSecretInValue(contribution) !== undefined
    || unsafeText(canonicalJson(contribution));
}

function unsafeContribution(slotId: AdvisorySlotId): AdvisoryContribution {
  return { slotId, outcome: 'failed', reasonCode: 'unsafe_output' };
}

function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function normalizeAdvisoryContributions(
  phase: AdvisoryPhase,
  rawContributions: readonly AdvisoryContribution[],
): AdvisoryContribution[] {
  const slots = phaseSlots(phase);
  const expected = new Set(slots.map((slot) => slot.slotId));
  if (rawContributions.length !== slots.length) {
    throw ennoValidationError('advice_submit', [{
      path: ['contributions'],
      reasonCode: 'advisory_slot_missing',
      expected: { requiredSlotIds: [...expected] },
    }]);
  }
  const bySlot = new Map<AdvisorySlotId, AdvisoryContribution>();
  for (const [index, contribution] of rawContributions.entries()) {
    if (!expected.has(contribution.slotId)) {
      throw ennoValidationError('advice_submit', [{
        path: ['contributions', index, 'slotId'],
        reasonCode: 'advisory_slot_missing',
        expected: { requiredSlotIds: [...expected] },
      }]);
    }
    if (bySlot.has(contribution.slotId)) {
      throw ennoValidationError('advice_submit', [{
        path: ['contributions', index, 'slotId'],
        reasonCode: 'advisory_slot_duplicate',
        expected: { requiredSlotIds: [...expected] },
      }]);
    }
    if (!ADVISORY_OUTCOMES.includes(contribution.outcome)) {
      throw ennoValidationError('advice_submit', [{
        path: ['contributions', index, 'outcome'],
        reasonCode: 'invalid_enum',
        expected: { allowedValues: [...ADVISORY_OUTCOMES] },
      }]);
    }
    if (contribution.outcome === 'completed' && contributionContainsSecret(contribution)) {
      bySlot.set(contribution.slotId, unsafeContribution(contribution.slotId));
      continue;
    }
    if (contribution.outcome !== 'completed'
      && (!contribution.reasonCode || !ADVISORY_FAILURE_CODES.includes(contribution.reasonCode))) {
      throw ennoValidationError('advice_submit', [{
        path: ['contributions', index, 'reasonCode'],
        reasonCode: 'missing_required_field',
      }]);
    }
    bySlot.set(contribution.slotId, { ...contribution });
  }
  if (bySlot.size !== slots.length) {
    throw ennoValidationError('advice_submit', [{
      path: ['contributions'],
      reasonCode: 'advisory_slot_missing',
      expected: { requiredSlotIds: [...expected] },
    }]);
  }
  const normalized = slots.map((slot) => bySlot.get(slot.slotId)!);
  if (normalized.some((contribution) => canonicalByteLength(contribution) > ADVISORY_MAX_SLOT_BYTES)) {
    throw ennoValidationError('advice_submit', [{
      path: ['contributions'],
      reasonCode: 'too_many_items',
    }]);
  }
  if (canonicalByteLength(normalized) > ADVISORY_MAX_ROUND_BYTES) {
    throw ennoValidationError('advice_submit', [{
      path: ['contributions'],
      reasonCode: 'too_many_items',
    }]);
  }
  return normalized;
}

export function advisoryRoundAggregate(contributions: readonly AdvisoryContribution[]): {
  contributions: AdvisoryContribution[];
  degraded: boolean;
} {
  return {
    contributions: contributions.map((contribution) => ({
      ...contribution,
      ...(contribution.recommendations === undefined ? {} : { recommendations: [...contribution.recommendations] }),
      ...(contribution.risks === undefined ? {} : { risks: [...contribution.risks] }),
      ...(contribution.evidence === undefined ? {} : { evidence: contribution.evidence.map((evidence) => ({ ...evidence })) }),
    })),
    degraded: contributions.every((contribution) => contribution.outcome !== 'completed'),
  };
}
