import { isProxy } from 'node:util/types';

export type BoundaryJsonValue =
  | null
  | boolean
  | number
  | string
  | BoundaryJsonValue[]
  | { [key: string]: BoundaryJsonValue };

export interface BoundaryJsonCloneOptions {
  readonly failure: () => Error;
  readonly maximumDepth?: number;
  readonly maximumNodes?: number;
  readonly maximumStringBytes?: number;
}

/** JSON text is Unicode data, not an arbitrary sequence of UTF-16 code units. */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xDC00 && trailing <= 0xDFFF)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return false;
  }
  return true;
}

function canonicalArrayIndex(value: string): boolean {
  if (value === '0') return true;
  if (!/^[1-9]\d*$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index < 4_294_967_295 && String(index) === value;
}

/** Clone a hostile JSON boundary through data descriptors only. */
export function cloneBoundaryJson(
  value: unknown,
  options: BoundaryJsonCloneOptions,
  seen = new Set<object>(),
  depth = 0,
  budget = { nodes: 0, stringBytes: 0 },
): BoundaryJsonValue {
  budget.nodes += 1;
  if (budget.nodes > (options.maximumNodes ?? Number.MAX_SAFE_INTEGER)) throw options.failure();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (!isWellFormedUnicode(value)) throw options.failure();
    budget.stringBytes += Buffer.byteLength(value, 'utf8');
    if (budget.stringBytes > (options.maximumStringBytes ?? Number.MAX_SAFE_INTEGER)) throw options.failure();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw options.failure();
    return value;
  }
  if (typeof value !== 'object' || isProxy(value)
    || seen.has(value) || depth >= (options.maximumDepth ?? 128)) throw options.failure();
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) throw options.failure();
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw options.failure();
      descriptors.set(key, descriptor);
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype
        || descriptors.size !== value.length + 1 || !descriptors.has('length')) throw options.failure();
      const result: BoundaryJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors.get(String(index));
        if (descriptor === undefined || descriptor.enumerable !== true || !canonicalArrayIndex(String(index))) {
          throw options.failure();
        }
        result.push(cloneBoundaryJson(descriptor.value, options, seen, depth + 1, budget));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw options.failure();
    const result = Object.create(null) as Record<string, BoundaryJsonValue>;
    for (const key of [...descriptors.keys()].sort()) {
      if (!isWellFormedUnicode(key)) throw options.failure();
      const descriptor = descriptors.get(key) as PropertyDescriptor;
      if (descriptor.enumerable !== true) throw options.failure();
      budget.stringBytes += Buffer.byteLength(key, 'utf8');
      if (budget.stringBytes > (options.maximumStringBytes ?? Number.MAX_SAFE_INTEGER)) throw options.failure();
      Object.defineProperty(result, key, {
        value: cloneBoundaryJson(descriptor.value, options, seen, depth + 1, budget),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Serialize an already-cloned JSON boundary without consulting inherited
 * `toJSON` hooks or any methods on caller-controlled arrays and objects. */
export function stringifyBoundaryJson(value: BoundaryJsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    let serialized = '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) serialized += ',';
      serialized += stringifyBoundaryJson(value[index] as BoundaryJsonValue);
    }
    return `${serialized}]`;
  }
  let serialized = '{';
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) serialized += ',';
    const key = keys[index] as string;
    serialized += `${JSON.stringify(key)}:${stringifyBoundaryJson(value[key] as BoundaryJsonValue)}`;
  }
  return `${serialized}}`;
}
