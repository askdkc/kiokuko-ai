import path from 'node:path';
import { findSecret } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';
import { MAX_PREVIEW_BYTES, type JsonValue, type Redaction, type SanitizationOptions, type Sanitized } from '../ledger/types.js';

export const HARMLESS_ENV_KEYS = new Set(['CI', 'NODE_ENV', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE']);

const SENSITIVE_KEY = /(?:password|passwd|secret|token|apikey|api[-_]?key|authorization|cookie|credential|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token)/i;
const SENSITIVE_CONTAINER_KEY = /^(?:credentials|headers)$/i;
const HIDDEN_REASONING_KEY = /(?:chain[-_]?of[-_]?thought|hidden[-_]?reasoning|private[-_]?reasoning|internal[-_]?monologue)/i;
const PREVIEW_KEY = /^(?:stdout|stderr|output|preview|excerpt|diff)$/i;
const PATH_KEY = /(?:^|[-_])(path|file|filename|locator|cwd|directory|workspace|target)$/i;

function security(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function secretKey(): never {
  throw new KiokukoError('SECURITY_REJECTION', 'JSON object key contains secret material');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return isPlainObject(value) && Object.values(value).every(jsonValue);
}

function pathLabel(segments: string[]): string {
  return segments.length === 0 ? '$' : `$${segments.map((segment) => `[${JSON.stringify(segment)}]`).join('')}`;
}

function boundaryPrefix(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeAbsolutePath(value: string, options: SanitizationOptions): { value: string; kind: Redaction['kind'] } | undefined {
  if (!path.isAbsolute(value)) return undefined;
  const absolute = path.normalize(value);
  if (options.workspace) {
    const workspace = path.resolve(options.workspace);
    if (boundaryPrefix(workspace, absolute)) {
      const relative = path.relative(workspace, absolute).split(path.sep).join('/');
      return { value: relative || '.', kind: 'home_path' };
    }
  }
  if (options.home) {
    const home = path.resolve(options.home);
    if (boundaryPrefix(home, absolute)) {
      const relative = path.relative(home, absolute).split(path.sep).join('/');
      return { value: relative ? `<HOME>/${relative}` : '<HOME>', kind: 'home_path' };
    }
  }
  return undefined;
}

function normalizeUrl(value: string): string | undefined {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    const next = result + character;
    if (Buffer.byteLength(`${next}…`, 'utf8') > maxBytes) break;
    result = next;
  }
  return `${result}…`;
}

function sanitizeNode(value: unknown, segments: string[], options: SanitizationOptions, redactions: Redaction[], truncated: string[], keyHint?: string): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) security('Value must contain only finite JSON numbers');
    return value;
  }
  if (typeof value === 'string') {
    let text = value;
    const label = pathLabel(segments);
    const secret = findSecret(text);
    if (secret) {
      redactions.push({ path: label, kind: 'secret_pattern' });
      return `[REDACTED:${secret.kind}]`;
    }
    const url = normalizeUrl(text);
    if (url !== undefined) {
      if (url !== text) redactions.push({ path: label, kind: 'url' });
      text = url;
    } else if (PATH_KEY.test(keyHint ?? '') || path.isAbsolute(text)) {
      const normalized = normalizeAbsolutePath(text, options);
      if (normalized) {
        if (normalized.value !== text) redactions.push({ path: label, kind: normalized.kind });
        text = normalized.value;
      }
    }
    if (keyHint && PREVIEW_KEY.test(keyHint) && Buffer.byteLength(text, 'utf8') > MAX_PREVIEW_BYTES) {
      text = truncateUtf8(text, MAX_PREVIEW_BYTES);
      redactions.push({ path: label, kind: 'preview_truncated' });
      truncated.push(label);
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((child, index) => sanitizeNode(child, [...segments, String(index)], options, redactions, truncated, keyHint));
  if (!isPlainObject(value)) security('Value must be JSON-compatible');

  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (findSecret(key)) secretKey();
    const childPath = [...segments, key];
    const label = pathLabel(childPath);
    if (HIDDEN_REASONING_KEY.test(key)) {
      redactions.push({ path: label, kind: 'hidden_reasoning' });
      continue;
    }
    if (/^(?:env|environment)$/i.test(key)) {
      if (!isPlainObject(child)) {
        redactions.push({ path: label, kind: 'environment_value' });
        continue;
      }
      const environment: Record<string, JsonValue> = {};
      for (const [envKey, envValue] of Object.entries(child)) {
        if (!HARMLESS_ENV_KEYS.has(envKey)) {
          redactions.push({ path: pathLabel([...childPath, envKey]), kind: 'environment_value' });
          continue;
        }
        environment[envKey] = sanitizeNode(envValue, [...childPath, envKey], options, redactions, truncated, envKey);
      }
      result[key] = environment;
      continue;
    }
    if (SENSITIVE_KEY.test(key) && !SENSITIVE_CONTAINER_KEY.test(key)) {
      redactions.push({ path: label, kind: 'sensitive_key' });
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = sanitizeNode(child, childPath, options, redactions, truncated, key);
  }
  return result;
}

export function sanitizeJson(value: unknown, options: SanitizationOptions = {}): Sanitized<JsonValue> {
  if (!jsonValue(value)) security('Value must be JSON-compatible');
  const effectiveOptions: SanitizationOptions = {};
  if (options.workspace !== undefined) effectiveOptions.workspace = options.workspace;
  const home = options.home ?? process.env.HOME;
  if (home !== undefined) effectiveOptions.home = home;
  const redactions: Redaction[] = [];
  const truncated: string[] = [];
  const sanitized = sanitizeNode(value, [], effectiveOptions, redactions, truncated);
  redactions.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
  truncated.sort();
  return { value: sanitized, redactions, truncated };
}
