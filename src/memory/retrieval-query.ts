import { KiokukoError } from '../errors.js';

const MAX_QUERY_BYTES = 16 * 1024;
const MAX_TERMS = 64;
const MAX_TERM_LENGTH = 512;
const MAX_CJK_SUBSTRING_TERMS = 24;
const MAX_CJK_BIGRAM_TERMS = 6;
const JAPANESE_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u303B\u309D\u309E\u30FC\u30FD\u30FE]{2,}/gu;
const SAME_SCRIPT_JAPANESE_RUN = /(?:[\p{Script=Han}\u3005\u303B]{2,}|[\p{Script=Hiragana}\u309D\u309E]{2,}|[\p{Script=Katakana}\u30FC\u30FD\u30FE]{2,})/gu;
const STRUCTURED_SIGNAL = /(?:sqlstate\[[^\]]+\]|(?:[a-z_$][\w$]*)(?:::|->)[\w$:.()\\-]+|(?:[a-z_$][\w$]*\\)+[\w$.-]+|(?:^|\s)\/[\w./-]+|@[A-Za-z][\w.-]*|\$[A-Za-z_][\w$]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/gu;

export interface ParsedExactSignal {
  type: 'symbol' | 'path' | 'error' | 'package' | 'command' | 'unknown';
  value: string;
  normalizedValue: string;
}

export interface ParsedRetrievalQuery {
  raw: string;
  normalized: string;
  lexicalTerms: string[];
  phraseTerms: string[];
  substringTerms: string[];
  exactSignals: ParsedExactSignal[];
}

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Search query is invalid');
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function normalizedSignal(value: string): string {
  return normalize(value).toLowerCase();
}

function signalType(value: string): ParsedExactSignal['type'] {
  if (/^sqlstate\[/iu.test(value) || /\b(?:error|exception|fatal|e\d{3,})\b/iu.test(value)) return 'error';
  if (value.includes('/') && !value.startsWith('@')) return value.startsWith('/') || value.includes('\\') ? 'path' : 'package';
  if (value.startsWith('@') || value.startsWith('$')) return 'symbol';
  if (value.includes('::') || value.includes('->')) return 'symbol';
  if (/\s/.test(value)) return 'command';
  return 'unknown';
}

function unique(values: string[]): string[] {
  return [...new Set(values)].filter((value) => value.length > 0).slice(0, MAX_TERMS);
}

function japaneseScript(value: string): 'han' | 'hiragana' | 'katakana' {
  if (/[\p{Script=Han}\u3005\u303B]/u.test(value)) return 'han';
  if (/[\p{Script=Hiragana}\u309D\u309E]/u.test(value)) return 'hiragana';
  return 'katakana';
}

function windows(value: string, lengths: readonly number[]): string[] {
  const points = Array.from(value);
  const pools = lengths.map((length) => {
    if (points.length < length) return undefined;
    const lastStart = points.length - length;
    const candidateStarts = lastStart + 1 <= MAX_CJK_SUBSTRING_TERMS
      ? Array.from({ length: lastStart + 1 }, (_, index) => index)
      : Array.from(
        { length: MAX_CJK_SUBSTRING_TERMS },
        (_, index) => Math.round(index * lastStart / (MAX_CJK_SUBSTRING_TERMS - 1)),
      );
    const boundaryStarts = points.flatMap((point, index) => index > 0
      && japaneseScript(points[index - 1]!) !== japaneseScript(point)
      ? [Math.max(0, Math.min(lastStart, index - Math.floor(length / 2)))]
      : []);
    const starts = [...new Set([
      0,
      Math.ceil(lastStart / 2),
      lastStart,
      ...boundaryStarts,
      ...candidateStarts,
    ])].slice(0, MAX_CJK_SUBSTRING_TERMS);
    return starts.map((start) => points.slice(start, start + length).join(''));
  }).filter((pool): pool is string[] => pool !== undefined);
  const result: string[] = [];
  for (let offset = 0; pools.some((pool) => offset < pool.length); offset += 1) {
    for (const pool of pools) if (offset < pool.length) result.push(pool[offset]!);
  }
  return result;
}

function takeRoundRobin(pools: readonly string[][], limit: number, seen: Set<string>): string[] {
  const offsets = pools.map(() => 0);
  const result: string[] = [];
  while (result.length < limit) {
    let consumed = false;
    for (let index = 0; index < pools.length && result.length < limit; index += 1) {
      const pool = pools[index]!;
      while (offsets[index]! < pool.length) {
        const candidate = pool[offsets[index]!]!;
        offsets[index] = offsets[index]! + 1;
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        result.push(candidate);
        consumed = true;
        break;
      }
    }
    if (!consumed) break;
  }
  return result;
}

function mixedScriptBoundaryTerms(runs: readonly string[]): string[] {
  const result: string[] = [];
  for (const run of runs) {
    const points = Array.from(run);
    for (let index = 1; index < points.length; index += 1) {
      if (japaneseScript(points[index - 1]!) === japaneseScript(points[index]!)) continue;
      for (const length of [3, 4]) {
        if (points.length < length) continue;
        const start = Math.max(0, Math.min(points.length - length, index - Math.floor(length / 2)));
        result.push(points.slice(start, start + length).join(''));
      }
    }
  }
  return result;
}

/** Allocate bounded overlapping CJK windows without allowing one long run to starve later runs. */
function cjkSubstringTerms(runs: readonly string[], mixedRuns: readonly string[]): string[] {
  const normalizedRuns = [...new Set(runs)].filter((run) => Array.from(run).length >= 2);
  const seen = new Set<string>();
  const primaryLimit = MAX_CJK_SUBSTRING_TERMS - MAX_CJK_BIGRAM_TERMS;
  const primary = takeRoundRobin(
    normalizedRuns.map((run) => windows(run, [3, 4])),
    primaryLimit,
    seen,
  );
  const mixed = unique(mixedScriptBoundaryTerms(mixedRuns))
    .filter((term) => !seen.has(term))
    .slice(0, MAX_CJK_SUBSTRING_TERMS - primary.length);
  for (const term of mixed) seen.add(term);
  const auxiliary = takeRoundRobin(
    normalizedRuns.map((run) => windows(run, [2])),
    MAX_CJK_SUBSTRING_TERMS - primary.length - mixed.length,
    seen,
  );
  return [...primary, ...mixed, ...auxiliary];
}

export function parseRetrievalQuery(input: unknown): ParsedRetrievalQuery {
  if (typeof input !== 'string') invalid();
  if (input.length === 0 || Buffer.byteLength(input, 'utf8') > MAX_QUERY_BYTES) invalid();
  const raw = input;
  const normalized = normalize(input);
  if (normalized.length === 0) {
    return { raw, normalized, lexicalTerms: [], phraseTerms: [], substringTerms: [], exactSignals: [] };
  }

  const exactValues = [...normalized.matchAll(STRUCTURED_SIGNAL)]
    .map((match) => match[0].trim())
    .filter((value) => value.length > 1 && value.length <= MAX_TERM_LENGTH);
  const exactSignals = unique(exactValues).map((value) => ({
    type: signalType(value),
    value,
    normalizedValue: normalizedSignal(value),
  }));

  const lexicalTerms = unique(normalized.match(/[\p{L}\p{N}_$@]+/gu) ?? [])
    .map((term) => term.slice(0, MAX_TERM_LENGTH));
  const phraseTerms = unique(normalized.split(/\s+/u).filter((term) => term.length > 1))
    .map((term) => term.slice(0, MAX_TERM_LENGTH));
  const cjkRuns = normalized.match(SAME_SCRIPT_JAPANESE_RUN) ?? [];
  const mixedRuns = (normalized.match(JAPANESE_RUN) ?? [])
    .filter((run) => new Set(Array.from(run).map(japaneseScript)).size > 1);
  const substringTerms = unique([
    ...exactSignals.map((signal) => signal.value),
    ...cjkSubstringTerms(cjkRuns, mixedRuns),
    ...lexicalTerms.filter((term) => term.length >= 2),
  ]).map((term) => term.slice(0, MAX_TERM_LENGTH));

  return { raw, normalized, lexicalTerms, phraseTerms, substringTerms, exactSignals };
}

export function normalizeSearchSignal(value: string): string {
  return normalizedSignal(value);
}
