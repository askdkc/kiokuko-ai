import type { JsonObject } from '../ledger/types.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { normalizeCapabilityCatalog, type CapabilityDescriptor } from './capabilities.js';

export const CAPABILITY_CATALOG_BINDING_VERSION = 1 as const;
export const CAPABILITY_CATALOG_BINDING_METADATA_KEY = 'kiokukoCapabilityCatalogBinding' as const;

type CapabilityCatalogBinding = {
  version: typeof CAPABILITY_CATALOG_BINDING_VERSION;
  digest: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareDescriptor(left: CapabilityDescriptor, right: CapabilityDescriptor): number {
  const leftValue = `${left.kind}\u0000${left.name}\u0000${left.description ?? ''}`;
  const rightValue = `${right.kind}\u0000${right.name}\u0000${right.description ?? ''}`;
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function canonicalDescriptorSet(descriptors: CapabilityDescriptor[]): CapabilityDescriptor[] {
  const sorted = [...descriptors].sort(compareDescriptor);
  return sorted.filter((descriptor, index) => index === 0 || compareDescriptor(descriptor, sorted[index - 1]!) !== 0);
}

/**
 * Hash only the normalized effective catalog. Raw descriptions remain ephemeral,
 * while malformed/omitted catalogs retain distinct fail-closed identities.
 */
export function capabilityCatalogDigest(capabilities: unknown): string {
  const normalized = normalizeCapabilityCatalog(capabilities);
  const skills = canonicalDescriptorSet(normalized.skills);
  const tools = canonicalDescriptorSet(normalized.tools);
  const uniqueCount = skills.length + tools.length;
  const diagnostics = normalized.availability === 'unknown'
    ? normalized.diagnostics
    : {
        received: uniqueCount,
        accepted: uniqueCount,
        truncated: Math.min(normalized.diagnostics.truncated, uniqueCount),
        dropped: 0,
      };
  return canonicalContentHash({
    version: CAPABILITY_CATALOG_BINDING_VERSION,
    supplied: capabilities !== undefined,
    availability: normalized.availability,
    diagnostics,
    budgetExceeded: normalized.budgetExceeded,
    skills,
    tools,
  });
}

export function bindCapabilityCatalog(
  metadata: JsonObject,
  capabilities: unknown,
): JsonObject {
  if (Object.prototype.hasOwnProperty.call(metadata, CAPABILITY_CATALOG_BINDING_METADATA_KEY)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Run metadata contains a reserved capability binding');
  }
  const binding: CapabilityCatalogBinding = {
    version: CAPABILITY_CATALOG_BINDING_VERSION,
    digest: capabilityCatalogDigest(capabilities),
  };
  return { ...metadata, [CAPABILITY_CATALOG_BINDING_METADATA_KEY]: binding };
}

export function assertCapabilityCatalogBinding(
  metadata: JsonObject,
  capabilities: unknown,
): void {
  const value = metadata[CAPABILITY_CATALOG_BINDING_METADATA_KEY];
  if (!isPlainRecord(value)
    || Object.keys(value).length !== 2
    || value.version !== CAPABILITY_CATALOG_BINDING_VERSION
    || typeof value.digest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Run capability catalog binding is missing or invalid');
  }
  if (value.digest !== capabilityCatalogDigest(capabilities)) {
    throw new KiokukoError('CONFLICT', 'Capability catalog differs from the catalog bound when the run was opened');
  }
}
