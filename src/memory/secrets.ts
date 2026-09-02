export interface SecretFinding {
  kind: 'private_key' | 'authorization_header' | 'credential_assignment' | 'known_token_prefix';
}

const PATTERNS: Array<[SecretFinding['kind'], RegExp]> = [
  ['credential_assignment', /(?:^|\s)--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret)(?:=|\s+)["']?[A-Za-z0-9_./+=:-]{12,}/i],
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ['authorization_header', /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
  ['known_token_prefix', /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})\b/],
  ['credential_assignment', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=:-]{12,}/i],
];

export function findSecret(value: string): SecretFinding | undefined {
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(value)) return { kind };
  }
  return undefined;
}

/** Scan structured persisted input without relying on JSON punctuation around field names. */
export function findSecretInValue(value: unknown): SecretFinding | undefined {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): SecretFinding | undefined => {
    if (typeof current === 'string') return findSecret(current);
    if (typeof current !== 'object' || current === null) return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) {
        const finding = visit(item);
        if (finding !== undefined) return finding;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const keyFinding = findSecret(key);
      if (keyFinding !== undefined) return keyFinding;
      if (typeof child === 'string') {
        const assignmentFinding = findSecret(`${key}: ${child}`);
        if (assignmentFinding !== undefined) return assignmentFinding;
      }
      const childFinding = visit(child);
      if (childFinding !== undefined) return childFinding;
    }
    return undefined;
  };
  return visit(value);
}

export function containsSecret(value: string): boolean {
  return findSecret(value) !== undefined;
}
