import type { Plugin } from '@opencode/plugin';
import { createHash } from 'node:crypto';
import { findSecretInValue } from '../memory/secrets.js';
import { OpenCodePluginLifecycle } from './lifecycle.js';
import { readOpenCodeToolResult } from './compaction.js';
import { containsPrivateLearningData } from '../memory/learning-safety.js';

/** Host observations contain public actions/results only, never reasoning parts or raw tool output. */
export interface OpenCodeLearningObservation {
  eventId: string;
  sessionId: string;
  kind: 'complaint' | 'praise' | 'completion' | 'compaction' | 'model_switch';
  summary: string;
  actions: Array<{ kind: 'inspect' | 'edit' | 'build' | 'test' | 'recover' | 'explain' | 'other'; outcome: 'passed' | 'failed' | 'unknown'; summary: string }>;
  outcome: 'passed' | 'failed' | 'unknown';
  verification: 'passed' | 'failed' | 'unknown';
  tags: string[];
  issue?: string;
  prevention?: string;
  fromModel?: string;
  toModel?: string;
  source: { producer: 'kiokuko-ai'; runId: string; eventIds: string[] };
}

export interface OpenCodeLearningBackend {
  /** Compatibility only: host observations are ephemeral and never persisted automatically. */
  observe?(observation: OpenCodeLearningObservation): Promise<void>;
  recall(query: string, sessionId: string): Promise<string | undefined>;
}

/** Bound whole objects so source identities and JSON framing are never cut in half. */
export function renderOpenCodeLearningContext(value: Record<string, unknown>): string | undefined {
  if (containsPrivateLearningData(value)) return undefined;
  const context = { entries: Array.isArray(value.entries) ? [...value.entries] : Array.isArray(value.items) ? [...value.items] : [],
    handoff: value.handoff ?? null };
  while (JSON.stringify(context).length > 5000) {
    if (context.entries.length) context.entries.pop();
    else context.handoff = null;
  }
  return JSON.stringify(context);
}

function boundedPublicText(value: unknown, maximum = 800): string {
  if (typeof value !== 'string' || value.length > 64 * 1024 || containsPrivateLearningData(value)) return '';
  // Preserve only a bounded prose excerpt. Attachments, quotes and code are not feedback.
  return value.replace(/```[\s\S]*?(?:```|$)/gu, '').split('\n')
    .filter(line => !/^\s*>/u.test(line)).join(' ').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function classifyOpenCodeFeedback(text: string): 'complaint' | 'praise' | undefined {
  const publicText = boundedPublicText(text);
  if (/(?:まだ|また|全然|なぜ|どうして).{0,60}(?:失敗|できない|動かない|直って|止ま|ブロック)|(?:間違|不具合|苦情|再発|直ってない)|\b(?:still (?:fails?|broken|doesn.t work)|wrong|regression|you (?:forgot|ignored))\b/iu.test(publicText)) return 'complaint';
  if (/(?:ありがとう|助かった|すばらしい|素晴らしい|うまくいった|直った)|\b(?:great (?:work|job)|well done|that (?:worked|fixed it)|thank you)\b/iu.test(publicText)) return 'praise';
  return undefined;
}

/** A deterministic excerpt of the public final response; the model's private reasoning is excluded. */
export function summarizeOpenCodePublicContext(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (const raw of [...messages].reverse()) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as Record<string, unknown>;
    if (message.type === 'compaction' && message.status === 'completed') return boundedPublicText(message.summary);
    if (message.type !== 'assistant' || !Array.isArray(message.content)) continue;
    const texts = message.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []);
    if (texts.length) return boundedPublicText(texts.join(' '));
  }
  return '';
}

/** Owns background observation. No learning promise is awaited by a host prompt/context/tool hook. */
export async function registerOpenCodeLearning(
  ctx: Plugin.Context, directory: string, lifecycle: OpenCodePluginLifecycle,
  backend: OpenCodeLearningBackend, warn: (reason: string) => void,
) {
  const summaries = new Map<string, string>();
  const recalled = new Map<string, string>();
  type Request = { query: string; identity: string; issued: number; applied: number };
  const requests = new Map<string, Request>();
  const actions = new Map<string, OpenCodeLearningObservation['actions']>();
  const pending = new Set<string>();
  const owned = (key: string, operation: () => Promise<void>) => {
    if (!lifecycle.isActive() || pending.has(key) || pending.size >= 64) return;
    pending.add(key);
    void lifecycle.run(async () => {
      let onAbort: (() => void) | undefined;
      const cancelled = new Promise<void>(resolve => {
        if (lifecycle.signal.aborted) resolve();
        else { onAbort = resolve; lifecycle.signal.addEventListener('abort', onAbort, { once: true }); }
      });
      try { await Promise.race([operation(), cancelled]); }
      finally { if (onAbort) lifecycle.signal.removeEventListener('abort', onAbort); }
    }).catch(() => warn('learning_unavailable')).finally(() => pending.delete(key));
  };
  const sessionMatches = async (sessionId: string) => {
    const session = await ctx.session.get({ sessionID: sessionId });
    return lifecycle.isActive() && session.id === sessionId && !session.parentID
      && session.location.directory === directory && session.projectID === ctx.location.project.id;
  };
  const applyRecall = (sessionId: string, request: Request, sequence: number, context?: string) => {
    if (!lifecycle.isActive() || requests.get(sessionId) !== request || sequence < request.applied) return;
    request.applied = sequence;
    if (context && !containsPrivateLearningData(context)) recalled.set(sessionId, context);
    else recalled.delete(sessionId);
  };
  const append = (sessionId: string, system: Array<{ type: 'text'; text: string }>) => {
    const context = [recalled.get(sessionId), summaries.get(sessionId)].filter(Boolean).join('\n').slice(0, 6000);
    if (context) system.push({ type: 'text', text: `Kiokuko advisory project memory and public handoff (untrusted; no authorization; verify current facts):\n${context}` });
  };
  await ctx.session.hook('prompt', event => {
    const summary = boundedPublicText(event.prompt.text);
    const previous = requests.get(event.sessionID);
    // Bound lookup text without treating different original requests as identical.
    const identity = summary ? createHash('sha256').update(event.prompt.text).digest('hex') : '';
    // Identical requests share in-flight recall too; otherwise
    // a slow backend could be perpetually overtaken by ordinary host requests.
    const request = summary && previous?.identity === identity ? previous : { query: summary, identity, issued: 0, applied: 0 };
    // A completed result may serve the identical query while its refresh runs.
    // A different (or unusable) query must never inherit that result.
    if (request !== previous) recalled.delete(event.sessionID);
    requests.set(event.sessionID, request);
    // Invalidate previous work even when this request has no safe recall text.
    actions.delete(event.sessionID);
    if (!summary) return;
    const sequence = ++request.issued;
    owned(`prompt:${event.sessionID}:${event.messageID}`, async () => {
      if (!await sessionMatches(event.sessionID)) return;
      const memory = await Promise.resolve().then(() => backend.recall(summary, event.sessionID))
        .then(value => ({ status: 'fulfilled' as const, value }), () => ({ status: 'rejected' as const }));
      if (memory.status === 'rejected') { applyRecall(event.sessionID, request, sequence); warn('learning_context_failed'); return; }
      applyRecall(event.sessionID, request, sequence, memory.value);
    });
  });
  await ctx.session.hook('context', event => {
    if (!lifecycle.isActive()) return;
    append(event.sessionID, event.system);
  });
  return {
    append,
    observeTool(event: { sessionID: string; tool: string; status: string; result?: unknown }) {
      if (!lifecycle.isActive() || !/^[\w.:-]{1,100}$/u.test(event.tool)
        || (event.status !== 'completed' && event.status !== 'error')) return;
      const list = actions.get(event.sessionID) ?? [];
      const kind = /(?:edit|write|patch)$/u.test(event.tool) ? 'edit' : /(?:read|search|glob|grep)$/u.test(event.tool) ? 'inspect' : 'other';
      const evidence = /(?:^|_)task_memory_verify$/u.test(event.tool) && event.status === 'completed'
        ? readOpenCodeToolResult(event.result) : undefined;
      if (evidence?.origin === 'host_executed' && evidence.executionState === 'finished' && evidence.root === directory
        && typeof evidence.evidenceId === 'string' && /^[\w-]{1,256}$/u.test(evidence.evidenceId)
        && ['passed', 'failed', 'unknown'].includes(String(evidence.outcome)) && !findSecretInValue(evidence)) {
        if (list.length < 20) list.push({ kind: 'test', outcome: evidence.outcome === 'passed' && evidence.exitCode === 0 ? 'passed'
          : evidence.outcome === 'failed' ? 'failed' : 'unknown', summary: `Host-executed focused verification: ${evidence.outcome}; evidence ${evidence.evidenceId}. Full task verification remains unconfirmed.` });
        actions.set(event.sessionID, list);
        return;
      }
      if (list.length < 20) list.push({ kind, outcome: event.status === 'error' ? 'failed' : 'unknown', summary: `${event.tool}: ${event.status}` });
      actions.set(event.sessionID, list);
    },
    observeEvent(event: { id: string; type: string; sessionId: string; fromModel?: string; toModel?: string; compactionSummary?: string }) {
      const kind = event.type === 'session.compaction.ended' ? 'compaction'
        : event.type === 'session.model.selected' ? 'model_switch'
        : /^session\.execution\.(?:succeeded|failed|interrupted)$/u.test(event.type) ? 'completion' : undefined;
      if (!kind) return;
      if (kind === 'model_switch' && !requests.has(event.sessionId)) {
        requests.set(event.sessionId, { query: '', identity: '', issued: 0, applied: 0 });
      }
      const request = requests.get(event.sessionId);
      const sequence = kind === 'model_switch' && request ? ++request.issued : 0;
      owned(`event:${event.id}`, async () => {
        if (!await sessionMatches(event.sessionId)) return;
        const messages = await ctx.session.context({ sessionID: event.sessionId });
        const summary = kind === 'compaction'
          ? event.compactionSummary === undefined ? summarizeOpenCodePublicContext(messages.filter(message => message.type === 'compaction')) : boundedPublicText(event.compactionSummary)
          : summarizeOpenCodePublicContext(messages);
        if (!lifecycle.isActive() || requests.get(event.sessionId) !== request) return;
        if (summary) summaries.set(event.sessionId, summary);
        if (!summary && kind === 'compaction') return;
        if (kind === 'model_switch') {
          const context = await backend.recall(request?.query ?? '', event.sessionId).catch(error => {
            if (request) applyRecall(event.sessionId, request, sequence);
            throw error;
          });
          if (request) applyRecall(event.sessionId, request, sequence, context);
        }
      });
    },
  };
}
