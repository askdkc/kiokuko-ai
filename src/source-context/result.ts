import * as z from 'zod/v4';
import { canonicalContentHash } from '../serialization/validate.js';
import { findSecretInValue } from '../memory/secrets.js';
import { parseStrictJson } from '../setup/strict-json.js';
import { SourceFailure } from './process.js';
import type { SourceSnapshot } from './snapshot.js';

const text = z.string().max(256 * 1024);
const count = z.number().int().nonnegative();
const location = z.object({ p: text, n: text.optional(), t: text.optional(), l: count.optional(), id: text.optional(),
  sig: text.optional(), r: count.optional(), cx: count.optional(), ccx: count.optional(), in: count.optional(),
  doc: text.optional(), shared: count.optional(),
  rel: z.enum(['caller', 'callee']).optional(), body: text.optional(), truncated: z.boolean().optional(),
  calls_total: count.optional(), calls_capped: z.boolean().optional(),
  calls: z.array(z.object({ n: text, l: count.optional(), sig: text.optional() }).strict()).max(1000).optional(),
}).strict();
const testRow = z.union([text, z.object({ p: text, run: text.optional(), run_unknown: z.boolean().optional(), n: text.optional(), evidence: text.optional() }).strict()]);
export const ripwirePackSchema = z.object({
  task: text, route: text, root: text, budget_tokens: count, budget_bytes: count, budget_ceiling_bytes: count,
  ranking_capped: z.boolean(), ranking: z.array(location).max(1000),
  far_total: count, far_kept: count, far_of_top: count, far: z.array(location).max(1000),
  bodies_total: count, bodies_kept: count, bodies: z.array(location).max(1000),
  bodies_omitted: z.array(text).max(1000).optional(),
  callers_total: count, callers_kept: count, callers_of_top: count, callers: z.array(location).max(1000),
  notes_total: count, notes_kept: count, notes: z.array(z.unknown()).max(1000),
  tests_total: count, tests_kept: count, tests_to_run: z.array(testRow).max(1000),
}).strict();
export interface SourceSymbol { path: string; line: number | null; name: string | null; id: string | null; rank: number | null;
  signature: string | null; body: string | null; truncated: boolean; relation: 'caller' | 'callee' | null;
  unresolvedCallees: Array<{ name: string; signature: string | null }>;
  callsTotal: number | null; callsCapped: boolean | null }
export interface SourceResult {
  status: 'ready' | 'degraded' | 'unavailable'; reasons: string[];
  version: string | null; inputDigest: string; sourceDigest: string | null; resultDigest: string;
  durationMs: number; receivedBytes: number; reused: boolean;
  symbols: SourceSymbol[]; related: SourceSymbol[]; tests: Array<{ path: string; suggestedCommand: string | null }>;
  completeness: Record<string, number | boolean | string | null>;
  trust: 'untrusted_source';
}
export function finishSourceResult(result: SourceResult, maxBytes = 32 * 1024): SourceResult {
  const digest = () => canonicalContentHash({ ...result, durationMs: 0, reused: false, resultDigest: '' });
  result.resultDigest = digest();
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
    if (!result.reasons.includes('response_truncated')) result.reasons.push('response_truncated');
    result.status = 'degraded';
    const body = [...result.symbols].reverse().find(r => r.body !== null);
    if (body) { body.body = null; body.truncated = true; }
    else if (result.related.length) result.related.pop();
    else if (result.tests.length) result.tests.pop();
    else if (result.symbols.length) result.symbols.pop();
    else throw new SourceFailure('output_limit');
    result.resultDigest = digest();
  }
  return result;
}
export function unavailableSource(reason: string, inputDigest: string, durationMs: number): SourceResult {
  return finishSourceResult({ status: 'unavailable', reasons: [reason], version: null, inputDigest, sourceDigest: null,
    resultDigest: '', durationMs, receivedBytes: 0, reused: false, symbols: [], related: [], tests: [], completeness: {}, trust: 'untrusted_source' });
}
export function projectSourceOutput(stdout: Buffer, stderr: Buffer, snapshot: SourceSnapshot, inputDigest: string): SourceResult {
  let data;
  try {
    data = ripwirePackSchema.parse(parseStrictJson(new TextDecoder('utf8', { fatal: true }).decode(stdout), {
      allowTrailingComma: false, disallowComments: true, allowEmptyContent: false,
    }, 'Invalid source context response'));
  } catch { throw new SourceFailure('invalid_response'); }
  if (findSecretInValue(data)) throw new SourceFailure('unsafe_output');
  const locate = (p: string, line?: number) => {
    const match = /^(.*):(\d+)$/u.exec(p);
    const file = match ? match[1]! : p.replace(/^\.\//u, '');
    const actualLine = line ?? (match ? Number(match[2]) : null);
    if (!snapshot.files.has(file) || /[\p{Cc}\p{Cf}]/u.test(file)) throw new SourceFailure('unsafe_output_path');
    if (actualLine !== null && (actualLine < 1 || actualLine > snapshot.files.get(file)!.toString('utf8').split('\n').length))
      throw new SourceFailure('invalid_response');
    return { path: file, line: actualLine };
  };
  const symbol = (r: z.infer<typeof location>): SourceSymbol => ({ ...locate(r.p, r.l), name: r.n ?? null, id: r.id ?? null,
    rank: r.r ?? null, signature: r.sig ?? null, body: r.body ?? null, truncated: r.truncated ?? false, relation: r.rel ?? null,
    // Upstream call entries have no target path. Their line cannot be bound to a verified file.
    unresolvedCallees: (r.calls ?? []).map(c => ({ name: c.n, signature: c.sig ?? null })),
    callsTotal: r.calls_total ?? null, callsCapped: r.calls_capped ?? null });
  const symbols = data.ranking.map(symbol);
  for (const r of data.bodies) {
    const body = symbol(r);
    const existing = symbols.find(s => s.path === body.path && s.line === body.line && s.name === body.name);
    if (existing) {
      existing.body = body.body; existing.truncated = body.truncated;
      existing.unresolvedCallees = body.unresolvedCallees; existing.callsTotal = body.callsTotal; existing.callsCapped = body.callsCapped;
    }
    else symbols.push(body);
  }
  // v0.4.0 pack JSON does not expose complete parse-health/edge-confidence diagnostics.
  // Report that absence explicitly; a successful ranking is never a clean bill of health.
  const reasons = ['parse_health_unavailable', 'edge_confidence_unavailable', 'git_history_unavailable'];
  if (snapshot.excluded) reasons.push('files_excluded');
  if (stderr.length) reasons.push('parser_diagnostics');
  if (data.notes_total) reasons.push('notes_not_forwarded');
  if (data.ranking_capped || data.bodies_kept < data.bodies_total || data.callers_kept < data.callers_total || data.tests_kept < data.tests_total || data.far_kept < data.far_total
    || data.bodies_omitted?.length || data.bodies.some(r => r.truncated || r.calls_capped)) reasons.push('upstream_truncated');
  const tests = data.tests_to_run.map(r => ({ path: locate(typeof r === 'string' ? r : r.p).path,
    suggestedCommand: typeof r === 'string' ? null : r.run ?? null }));
  return { status: 'degraded', reasons, version: '0.4.0', inputDigest, sourceDigest: snapshot.digest,
    resultDigest: '', durationMs: 0, receivedBytes: stdout.length + stderr.length, reused: false, symbols,
    related: [...data.callers.map(r => symbol({ ...r, rel: 'caller' })), ...data.far.map(symbol)], tests, trust: 'untrusted_source',
    completeness: { rankingCapped: data.ranking_capped, bodiesTotal: data.bodies_total, bodiesKept: data.bodies_kept,
      bodiesOmitted: data.bodies_omitted?.length ?? null, farTotal: data.far_total, farKept: data.far_kept,
      callersTotal: data.callers_total, callersKept: data.callers_kept, testsTotal: data.tests_total, testsKept: data.tests_kept,
      excludedFiles: snapshot.excluded, parseHealth: null, graphAmbiguity: null, testsExhaustive: false } };
}
