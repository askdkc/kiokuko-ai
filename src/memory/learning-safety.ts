import { findSecretInValue } from './secrets.js';

/** Learning must also exclude session cookies and non-Bearer authentication. */
export function containsPrivateLearningData(value: unknown): boolean {
  if (findSecretInValue(value)) return true;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return typeof text === 'string' && /\b(?:cookie|set-cookie|session[_-]?(?:cookie|token))\s*[:=]\s*\S+|\bauthorization\s*:\s*(?:basic|digest)\s+\S+/iu.test(text);
}
