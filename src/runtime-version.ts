const MINIMUM_NODE_VERSION_COMPONENTS = [24, 16, 0] as const;

export const MINIMUM_NODE_MAJOR = MINIMUM_NODE_VERSION_COMPONENTS[0];
export const MINIMUM_NODE_VERSION = MINIMUM_NODE_VERSION_COMPONENTS.join('.');

export function nodeMajor(version: string): number | undefined {
  const match = /^(\d+)\./u.exec(version);
  if (!match?.[1]) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

export function supportsNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (actual.some((component) => !Number.isSafeInteger(component))) return false;
  for (let index = 0; index < MINIMUM_NODE_VERSION_COMPONENTS.length; index += 1) {
    const component = actual[index];
    const required = MINIMUM_NODE_VERSION_COMPONENTS[index];
    if (component === undefined || required === undefined) return false;
    if (component > required) return true;
    if (component < required) return false;
  }
  return true;
}

export function unsupportedNodeMessage(version: string): string {
  return `Kiokuko requires Node.js ${MINIMUM_NODE_VERSION} or newer; current runtime is Node.js ${version}.`;
}
