import { satisfies, subset, valid, validRange } from 'semver';

export type FrameworkVersionCompatibility = 'exact' | 'compatible' | 'unknown' | 'incompatible';

function normalizeExactVersion(value: string): string | null {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u);
  if (match === null) return null;
  return valid(`${match[1]}.${match[2] ?? '0'}.${match[3] ?? '0'}${match[4] ?? ''}`);
}

/**
 * Compare an observed framework version or range with a required version or range.
 * Unknown syntax fails closed at callers. An observed range is compatible only
 * when every version it permits is also permitted by the requirement.
 */
export function satisfiesFrameworkVersion(actual: string, requirement: string): FrameworkVersionCompatibility {
  const normalizedActual = normalizeExactVersion(actual);
  const requirementRange = validRange(requirement);
  if (requirementRange === null) return 'unknown';

  const exactRequirement = valid(requirement);
  if (normalizedActual !== null) {
    if (exactRequirement !== null) return normalizedActual === exactRequirement ? 'exact' : 'incompatible';
    return satisfies(normalizedActual, requirementRange) ? 'compatible' : 'incompatible';
  }

  const actualRange = validRange(actual);
  if (actualRange === null) return 'unknown';
  return subset(actualRange, requirementRange) ? 'compatible' : 'incompatible';
}
