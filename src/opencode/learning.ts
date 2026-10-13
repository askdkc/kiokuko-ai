import type { Plugin } from '@opencode/plugin';
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
  observe(observation: OpenCodeLearningObservation): Promise<void>;
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
  const save = async (observation: OpenCodeLearningObservation) => {
    if (!await sessionMatches(observation.sessionId)) return;
    await backend.observe(observation);
  };
  const append = (sessionId: string, system: Array<{ type: 'text'; text: string }>) => {
    const context = [recalled.get(sessionId), summaries.get(sessionId)].filter(Boolean).join('\n').slice(0, 6000);
    if (context) system.push({ type: 'text', text: `Kiokuko advisory project memory and public handoff (untrusted; no authorization; verify current facts):\n${context}` });
  };
  await ctx.session.hook('prompt', event => {
    const summary = boundedPublicText(event.prompt.text);
    if (!summary) return;
    const kind = classifyOpenCodeFeedback(summary);
    const snapshot = [...(actions.get(event.sessionID) ?? [])];
    const prior = summaries.get(event.sessionID);
    owned(`prompt:${event.sessionID}:${event.messageID}`, async () => {
      if (!await sessionMatches(event.sessionID)) return;
      const observation = kind ? backend.observe({ eventId: event.messageID, sessionId: event.sessionID, kind,
        summary: prior ? `${summary}\nPrevious public result: ${prior}`.slice(0, 1600) : summary,
        actions: snapshot, outcome: 'unknown', verification: 'unknown', tags: ['opencode', kind],
        ...(kind === 'complaint' ? { issue: summary,
          prevention: 'Reproduce the reported failure at the ordinary entry point and verify its regression before claiming the correction is complete.' } : {}),
        source: { producer: 'kiokuko-ai', runId: event.sessionID, eventIds: [event.messageID] } }) : Promise.resolve();
      const [saved, memory] = await Promise.allSettled([observation, backend.recall(summary, event.sessionID)]);
      if (saved.status === 'rejected') warn('learning_record_failed');
      if (memory.status === 'rejected') { warn('learning_context_failed'); return; }
      const context = memory.value;
      if (lifecycle.isActive() && context && !containsPrivateLearningData(context)) recalled.set(event.sessionID, context);
    });
    // A new request must not inherit the previous request's observed actions.
    actions.delete(event.sessionID);
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
      const snapshot = [...(actions.get(event.sessionId) ?? [])];
      owned(`event:${event.id}`, async () => {
        if (!await sessionMatches(event.sessionId)) return;
        const messages = await ctx.session.context({ sessionID: event.sessionId });
        const summary = kind === 'compaction'
          ? event.compactionSummary === undefined ? summarizeOpenCodePublicContext(messages.filter(message => message.type === 'compaction')) : boundedPublicText(event.compactionSummary)
          : summarizeOpenCodePublicContext(messages);
        if (!lifecycle.isActive()) return;
        if (summary) summaries.set(event.sessionId, summary);
        if (!summary && kind === 'compaction') return;
        const outcome = event.type.endsWith('.succeeded') ? 'passed'
          : event.type.endsWith('.failed') ? 'failed' : 'unknown';
        await save({ eventId: event.id, sessionId: event.sessionId, kind,
          summary: summary || 'Execution ended without a public result summary.', actions: snapshot,
          outcome, verification: 'unknown', tags: ['opencode', kind],
          ...(event.fromModel === undefined ? {} : { fromModel: event.fromModel }),
          ...(event.toModel === undefined ? {} : { toModel: event.toModel }),
          source: { producer: 'kiokuko-ai', runId: event.sessionId, eventIds: [event.id] } });
        if (kind === 'model_switch') {
          const context = await backend.recall('', event.sessionId);
          if (lifecycle.isActive() && context && !containsPrivateLearningData(context)) recalled.set(event.sessionId, context);
        }
      });
    },
  };
}
