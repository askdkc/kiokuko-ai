import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { findSecret, findSecretInValue } from './secrets.js';
import type { ReplayMemoryProposal } from './replay-review.js';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const safe = (v: unknown, n = 2048): string => {
  if (typeof v !== 'string') return '';
  // Redact the whole bounded field when a secret is present; truncation never hides a credential suffix.
  if (findSecret(v)) return '[redacted secret-bearing field]';
  return v.replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\n' || character === '\t' ? character : ' ').slice(0, n);
};
async function bounded(file: string, root: string, max: number): Promise<Buffer> {
  const canonical = await realpath(file);
  if (!canonical.startsWith(root + path.sep)) throw new Error('replay_scope_mismatch');
  const info = await stat(canonical);
  if (!info.isFile() || info.size > max) throw new Error('replay_source_bound');
  const bytes = await readFile(canonical);
  if (bytes.length > max) throw new Error('replay_source_bound');
  return bytes;
}
/** Read only explicit user messages and public call/result fields, never reasoning or system prompts. */
export async function extractReplayProposal(input: { cwd: string; traceDirectory: string; taskId: string; sessionId: string; workspace: string }): Promise<ReplayMemoryProposal> {
  const root = await realpath(input.cwd), directory = await realpath(input.traceDirectory);
  const runs = await realpath(path.join(root, '.agenticreplay', 'runs'));
  if (!runs.startsWith(root + path.sep) || !directory.startsWith(runs + path.sep)) throw new Error('replay_scope_mismatch');
  const manifest = object(JSON.parse((await bounded(path.join(directory, 'manifest.json'), directory, 65536)).toString('utf8')));
  if (manifest.schema_version !== '0.4.0' || typeof manifest.run_id !== 'string' || !/^run_[0-9a-f]{6,32}$/u.test(manifest.run_id)) throw new Error('replay_contract_mismatch');
  const candidates: Buffer[] = [];
  for (const name of ['events.jsonl', 'event.jsonl']) {
    try { candidates.push(await bounded(path.join(directory, name), directory, 8 * 1024 * 1024)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (candidates.length !== 1) throw new Error('replay_event_file_ambiguous_or_missing');
  const bytes = candidates[0]!, digest = hash(bytes), integrity = object(manifest.integrity);
  if (integrity.events_sha256 !== undefined && integrity.events_sha256 !== digest) throw new Error('replay_integrity_mismatch');
  const gaps: string[] = ['whole selected replay run; task/session labels supplied by the reviewer, not verified by the trace', ...(integrity.events_sha256 ? [] : ['unsealed trace; completeness is unknown'])];
  const events: Array<{ raw: Record<string, unknown>; payload: Record<string, unknown>; ref: string; payloadHash: string }> = [];
  let sequence = -1, blobBytes = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    if (events.length >= 10000) throw new Error('replay_event_bound');
    const raw = object(JSON.parse(line));
    if (!Number.isSafeInteger(raw.seq) || Number(raw.seq) <= sequence || typeof raw.type !== 'string') throw new Error('replay_event_invalid');
    sequence = Number(raw.seq);
    let payload = object(raw.payload), payloadHash = hash(JSON.stringify(payload));
    if ('$blob' in payload) {
      const match = typeof payload.$blob === 'string' && /^sha256:([a-f0-9]{64})$/u.exec(payload.$blob);
      if (!match || !Number.isSafeInteger(payload.bytes) || Number(payload.bytes) < 0) throw new Error('replay_blob_invalid');
      const data = await bounded(path.join(directory, 'blobs', match[1]!.slice(0, 2), match[1]!), directory, 2 * 1024 * 1024);
      blobBytes += data.length;
      if (blobBytes > 32 * 1024 * 1024 || data.length !== payload.bytes || hash(data) !== match[1]) throw new Error('replay_blob_integrity');
      payloadHash = match[1]!; payload = object(JSON.parse(data.toString('utf8')));
    }
    events.push({ raw, payload, ref: `${manifest.run_id}:${sequence}`, payloadHash });
  }
  const requestTexts = new Map<string, string>();
  for (const event of events) {
    if (event.raw.type === 'user.message') { const text = safe(event.payload.text); if (text) requestTexts.set(text, event.ref); }
    if (event.raw.type !== 'model.request' || !Array.isArray(event.payload.messages)) continue;
    for (const message of event.payload.messages) {
      const m = object(message);
      if (m.role !== 'user') continue;
      const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(p => { const b = object(p); return b.type === 'text' ? b.text : ''; }).filter(v => typeof v === 'string').join('\n') : '';
      const text = safe(content); if (text && requestTexts.size < 20) requestTexts.set(text, event.ref);
    }
  }
  const attempts: ReplayMemoryProposal['attempts'] = [];
  for (const call of events.filter(e => e.raw.type === 'tool.call' || e.raw.type === 'shell.call')) {
    if (attempts.length >= 100) { gaps.push('only first 100 calls represented'); break; }
    const attrs = object(call.raw.attrs), identity = attrs.attemptId ?? attrs.callId;
    if (typeof attrs.taskId === 'string' && attrs.taskId !== input.taskId) continue;
    const taskId = typeof attrs.taskId === 'string' ? attrs.taskId : null;
    const calls = events.filter(e => e.raw.type === 'tool.call' || e.raw.type === 'shell.call');
    const sameIdentity = calls.filter(e => {const a=object(e.raw.attrs);return identity!==undefined && (a.attemptId??a.callId)===identity;});
    const matches = events.filter(e => {
      if (!/^(tool|shell)\.result$/u.test(String(e.raw.type)) || Number(e.raw.seq)<=Number(call.raw.seq)) return false;
      const resultAttrs=object(e.raw.attrs), resultIdentity=resultAttrs.attemptId??resultAttrs.callId;
      const causes=Array.isArray(e.raw.causes)?e.raw.causes:[];
      const causedCalls=calls.filter(c=>causes.includes(c.raw.seq));
      if(causedCalls.length) return causedCalls.length===1 && causedCalls[0]===call && (identity===undefined||resultIdentity===undefined||identity===resultIdentity);
      // Identity-only association is safe only if it selects one call in the whole trace.
      return identity!==undefined && resultIdentity===identity && sameIdentity.length===1;
    });
    const result = matches.length === 1 ? matches[0] : undefined;
    const ra = object(result?.raw.attrs), rp = result?.payload ?? {};
    const exit = typeof ra.exit_code === 'number' && Number.isSafeInteger(ra.exit_code) ? ra.exit_code : undefined;
    const denied = ra.execution_status === 'denied' || ra.permission_decision === 'deny';
    const execution = denied ? 'denied' : result && exit !== undefined ? 'completed' : ra.execution_status === 'started' ? 'started' : result ? 'unknown' : 'attempted';
    const outcome = denied ? 'unknown' : ra.signal || ra.cancelled === true ? 'cancelled' : exit !== undefined ? exit === 0 ? 'succeeded' : 'failed' : ra.is_error === true ? 'failed' : 'unknown';
    const limitations = [ ...(taskId === null ? ['unassigned session-trace evidence; not verified as belonging to the reviewed task'] : []), ...(result ? [] : [matches.length > 1 ? 'ambiguous results' : 'result missing']), ...(denied ? ['execution was denied; not an executed command failure'] : []), ...(exit === undefined ? ['structured exit metadata unavailable'] : []), 'tool outcome does not establish task success'];
    const content = typeof rp.output === 'string' ? rp.output : typeof rp.stdout === 'string' ? rp.stdout : Array.isArray(rp.content) ? rp.content.map(v => { const b = object(v); return b.type === 'text' ? b.text : ''; }).filter(v => typeof v === 'string').join('\n') : '';
    let argumentsValue: unknown = call.payload.arguments ?? call.payload.input ?? call.payload;
    if (typeof argumentsValue === 'string' && argumentsValue.length <= 65536) { try { argumentsValue=JSON.parse(argumentsValue); } catch { argumentsValue={}; } }
    const argumentsObject=object(argumentsValue);
    const rawCommand=argumentsObject.command ?? argumentsObject.cmd;
    const command = safe(rawCommand);
    if(typeof rawCommand==='string' && rawCommand.length>2048)limitations.push('command excerpt truncated at 2048 characters');
    if(content.length>2048)limitations.push('output excerpt truncated at 2048 characters');
    attempts.push({ taskId, attemptId: safe(identity ?? call.ref, 256), tool: safe(attrs.name ?? 'shell', 100), ...(command ? { command } : {}), callRef: call.ref,
      ...(result ? { resultRef: result.ref } : {}), outcome, execution, ...(exit === undefined ? {} : { exitCode: exit }),
      ...(content ? { outputExcerpt: safe(content) } : {}), payloadHashes: [call.payloadHash, ...(result ? [result.payloadHash] : [])], limitations });
  }
  const languages: ReplayMemoryProposal['languages'] = [];
  for (const [name, pattern] of [['TypeScript', /(?:\.tsx?\b|\btsc\b)/u], ['JavaScript', /(?:\.m?js\b|\bnode\b)/u], ['Python', /(?:\.py\b|\bpython3?\b)/u], ['Rust', /(?:\.rs\b|\bcargo\b)/u]] as const) {
    const refs = attempts.filter(a => pattern.test(a.command ?? '')).map(a => a.callRef);
    if (refs.length) languages.push({ name, basis: 'inferred', evidenceRefs: refs });
  }
  const text = [...requestTexts.keys()].join('\n').slice(0, 4096);
  if (text) gaps.push('request text from recorded user-role messages; current human identity and exact task binding require review');
  if (!text) gaps.push('user request unavailable');
  const findings: ReplayMemoryProposal['findings'] = attempts.filter(a => a.outcome === 'succeeded' || a.outcome === 'failed').map(a => ({ taskId: a.taskId ?? null, kind: a.outcome === 'succeeded' ? 'worked' : 'failed', text: `${a.tool}: ${a.command ?? 'recorded call'}; tool outcome ${a.outcome}. Task-level effectiveness remains unverified.`, basis: 'observed', evidenceRefs: [a.callRef, ...(a.resultRef ? [a.resultRef] : [])] }));
  const proposal: ReplayMemoryProposal = { schemaVersion: 1, proposalId: '', revision: 1, source: { workspace: input.workspace, taskId: input.taskId, sessionId: input.sessionId,
    traces: [{ runId: manifest.run_id, eventsSha256: digest, eventsRead: events.length, totalEvents: integrity.events_sha256 ? events.length : null, digestScope: 'complete', complete: gaps.length === 0, gaps }] }, request: { text, evidenceRefs: [...new Set(requestTexts.values())] }, languages, attempts, findings,
    tags: ['agenticreplay', ...languages.map(l => l.name.toLowerCase())], keywords: [...new Set((text + ' ' + attempts.map(a => a.command ?? a.tool).join(' ')).toLowerCase().match(/[\p{L}\p{N}_.-]{2,64}/gu) ?? [])].slice(0, 64) };
  if (findSecretInValue(proposal)) throw new Error('unsafe_extraction');
  return proposal;
}
