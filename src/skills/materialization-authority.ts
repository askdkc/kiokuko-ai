import { KiokukoError } from '../errors.js';
import { reviewedCatalogSkill } from './official-catalog.js';
import { SkillProviderError } from './providers/schema.js';
import { validateSkillCandidate } from './source/snapshot-validator.js';
import type {
  SkillCandidate,
  SkillMaterializationAuthorization,
  SkillMaterializationAuthorizationResult,
  SkillRegistryProvider,
} from './types.js';

interface AuthorizationBinding {
  id: string;
  provider: string;
  sourceType: SkillCandidate['sourceType'];
  source: string;
  slug: string;
}

const authorizationBindings = new WeakMap<object, AuthorizationBinding>();

function binding(candidate: SkillCandidate): AuthorizationBinding {
  return {
    id: candidate.id,
    provider: candidate.provider,
    sourceType: candidate.sourceType,
    source: candidate.source,
    slug: candidate.slug,
  };
}

function sameBinding(left: AuthorizationBinding, right: AuthorizationBinding): boolean {
  return left.id === right.id
    && left.provider === right.provider
    && left.sourceType === right.sourceType
    && left.source === right.source
    && left.slug === right.slug;
}

function issueAuthorization(candidate: SkillCandidate): SkillMaterializationAuthorization {
  const authorization = Object.freeze(Object.create(null)) as SkillMaterializationAuthorization;
  authorizationBindings.set(authorization as object, binding(candidate));
  return authorization;
}

/** Audit one exact provider/candidate identity and issue a process-local grant. */
export async function authorizeSkillMaterialization(
  provider: SkillRegistryProvider,
  candidate: SkillCandidate,
  signal?: AbortSignal,
): Promise<SkillMaterializationAuthorizationResult> {
  const validated = validateSkillCandidate(candidate);
  const canonicalCandidate = {
    ...validated,
    id: `${validated.provider}:${validated.source}:${validated.slug}`,
  };
  const { auditStatus: _descriptiveAuditStatus, ...auditableCandidate } = canonicalCandidate;
  if (reviewedCatalogSkill(auditableCandidate) !== undefined) {
    return {
      status: 'not-required',
      candidate: { ...auditableCandidate, officialStatus: 'catalog-verified', auditStatus: 'not-required' },
    };
  }
  if (provider.id !== auditableCandidate.provider) {
    throw new KiokukoError('SECURITY_REJECTION', 'External skill audit provider does not match the candidate provider');
  }
  if (provider.audit === undefined) return { status: 'unavailable', candidate: auditableCandidate };
  const expectedBinding = binding(auditableCandidate);
  const auditInput = Object.freeze({ ...auditableCandidate });
  const result = await provider.audit(auditInput, signal);
  const postAuditCandidate = validateSkillCandidate(auditInput);
  if (!sameBinding(expectedBinding, binding(postAuditCandidate))) {
    throw new SkillProviderError('registry_invalid_response');
  }
  if (result === null) return { status: 'unavailable', candidate: postAuditCandidate };
  if (typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 1 || !Object.prototype.hasOwnProperty.call(result, 'status')
    || result.status !== 'passed' && result.status !== 'failed') {
    throw new SkillProviderError('registry_invalid_response');
  }
  if (result.status === 'failed') return { status: 'failed', candidate: postAuditCandidate };
  const authorized = { ...postAuditCandidate, auditStatus: 'passed' as const };
  return { status: 'passed', candidate: authorized, authorization: issueAuthorization(authorized) };
}

/** Verify without consuming a grant, for a same-run convergence decision. */
export function hasSkillMaterializationAuthorization(
  candidate: SkillCandidate,
  authorization: SkillMaterializationAuthorization | undefined,
): boolean {
  if (reviewedCatalogSkill(candidate) !== undefined) return authorization === undefined;
  if (authorization === undefined || typeof authorization !== 'object' || authorization === null) return false;
  const authorized = authorizationBindings.get(authorization as object);
  return authorized !== undefined && sameBinding(authorized, binding(candidate));
}

/**
 * Consume the one-shot grant and derive the descriptive audit status stored
 * with the materialized snapshot. Candidate.auditStatus is never authority.
 */
export function claimSkillMaterializationAuthorization(
  candidate: SkillCandidate,
  authorization: SkillMaterializationAuthorization | undefined,
): SkillCandidate {
  const validated = validateSkillCandidate(candidate);
  if (reviewedCatalogSkill(validated) !== undefined) {
    if (authorization !== undefined) {
      throw new KiokukoError('SECURITY_REJECTION', 'Reviewed catalog materialization must not carry provider audit authority');
    }
    return { ...validated, officialStatus: 'catalog-verified', auditStatus: 'not-required' };
  }
  if (!hasSkillMaterializationAuthorization(validated, authorization)) {
    throw new KiokukoError('SECURITY_REJECTION', 'External skill materialization requires a fresh provider audit authority');
  }
  authorizationBindings.delete(authorization as object);
  return { ...validated, auditStatus: 'passed' };
}
