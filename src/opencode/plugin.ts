import { Plugin } from '@opencode/plugin';
import { canonicalContentHash } from '../serialization/validate.js';
import { parseOpenCodePluginOptions } from './runtime-invocation.js';
import { OpenCodeCompactionState } from './compaction.js';
import { OpenCodePluginLifecycle } from './lifecycle.js';
import { readKiokukoTrackedSessions, runKiokukoCompactionHook, type HookEffectDependencies } from './hook-effect.js';
import { registerExecutionHooks } from './execution.js';
import { OpenCodeV2Continuation } from './v2-continuation.js';
import { v2EventSession } from './v2-adapter.js';

const MAX_SUMMARY_CHARS = 64 * 1024;
type CompletedCompaction = { id: string; summary: string };

/** V2 context contains the latest compaction boundary, not all history. */
export function extractOpenCodeCompactionSummary(messages: unknown): CompletedCompaction | null {
  if (!Array.isArray(messages)) return null;
  for (const message of [...messages].reverse()) {
    if (typeof message !== 'object' || message === null) continue;
    const item = message as Record<string, unknown>;
    if (item.type !== 'compaction' || item.status !== 'completed') continue;
    if (typeof item.id !== 'string' || typeof item.summary !== 'string') return null;
    const summary = item.summary.trim();
    if (!summary || summary.length > MAX_SUMMARY_CHARS) return null;
    return { id: item.id, summary };
  }
  return null;
}

export const KiokukoPlugin = Plugin.define({
  id: 'kiokuko-ai',
  async setup(ctx) {
    const directory = ctx.location.directory;
    const runtime = parseOpenCodePluginOptions(ctx.options);
    const trackingAvailable = runtime !== undefined;
    const lifecycle = new OpenCodePluginLifecycle();
    const state = new OpenCodeCompactionState();
    const dependencies: HookEffectDependencies = runtime
      ? { runtime, signal: lifecycle.signal, timeoutMs: 10_000 }
      : { runtimeFailure: 'version_mismatch', signal: lifecycle.signal, timeoutMs: 10_000 };
    const warn = (reason: string) => { console.warn(`kiokuko-ai: ${reason}`); };
    if (!trackingAvailable) warn('runtime_unavailable');
    const continuation = new OpenCodeV2Continuation(ctx, directory, ctx.location.project.id, dependencies, () => lifecycle.isActive(), warn);
    const tracked = async (sessionID: string) => trackingAvailable
      ? (await readKiokukoTrackedSessions(directory, dependencies))
        .find(item => item.sessionId === sessionID && item.repositoryRoot === directory)
      : undefined;
    const execution = await registerExecutionHooks(ctx, directory, dependencies);
    await ctx.tool.hook('execute.after', event => {
      if (!lifecycle.isActive() || event.status !== 'completed') return;
      state.observe(event.sessionID, event.tool, event.result);
    });
    await ctx.session.hook('compaction', async event => {
      if (!lifecycle.isActive()) return;
      await lifecycle.run(async () => {
        const binding = await tracked(event.sessionID);
        if (!binding) return;
        const observed = state.boundary(event.sessionID);
        const matches = observed?.runId === binding.runId && observed.workspace === binding.workspace
          && observed.orchestrationId === binding.orchestrationId
          && observed.contractRevision === binding.revision && observed.routeEpoch === binding.routeEpoch;
        const boundary = {
          runId: binding.runId, workspace: binding.workspace, orchestrationId: binding.orchestrationId,
          contractRevision: binding.revision, contextRevision: matches ? observed.contextRevision : null,
          routeEpoch: binding.routeEpoch, terminalMessageId: null,
        };
        const accepted = await runKiokukoCompactionHook({ phase: 'before', sessionId: event.sessionID, cwd: directory, boundary }, dependencies);
        if (!accepted || !lifecycle.isActive()) { warn('compaction_boundary_unavailable'); return; }
        await ctx.storage.set(`compaction/pending/${canonicalContentHash([directory, event.sessionID])}`, {
          runId: binding.runId, revision: binding.revision, routeEpoch: binding.routeEpoch,
        });
        event.system.push({ type: 'text', text: `Preserve this Kiokuko run identity through compaction: ${JSON.stringify(boundary)}. Restore current lease and execution state from Kiokuko, not from the summary.` });
        if (matches) {
          const context: string[] = [];
          state.appendContext(event.sessionID, context);
          for (const text of context) event.system.push({ type: 'text', text });
        }
      });
    });
    const saveCompaction = async (sessionID: string) => {
      if (!lifecycle.isActive()) return;
      const session = await ctx.session.get({ sessionID });
      if (session.location.directory !== directory || session.projectID !== ctx.location.project.id) return;
      const summary = extractOpenCodeCompactionSummary(await ctx.session.context({ sessionID }));
      if (!summary) { warn('compaction_summary_unavailable_or_opaque'); return; }
      const key = `compaction/${canonicalContentHash([directory, sessionID, summary.id])}`;
      if (await ctx.storage.get(key) === 'accepted') return;
      const binding = await tracked(sessionID);
      const pending = await ctx.storage.get(`compaction/pending/${canonicalContentHash([directory, sessionID])}`) as Record<string, unknown> | undefined;
      if (!binding || pending?.runId !== binding.runId || pending.revision !== binding.revision
        || pending.routeEpoch !== binding.routeEpoch) { warn('compaction_binding_changed'); return; }
      const accepted = await runKiokukoCompactionHook({
        phase: 'after', sessionId: sessionID, cwd: directory, runId: binding.runId,
        summaryMessageId: summary.id, summaryText: summary.summary, summaryDigest: canonicalContentHash(summary.summary),
      }, dependencies);
      if (accepted && lifecycle.isActive()) await ctx.storage.set(key, 'accepted');
      else warn('compaction_summary_save_failed');
    };
    const observe = (raw: unknown) => {
      const event = v2EventSession(raw);
      if (!event || (event.directory !== undefined && event.directory !== directory)) return;
      if (event.type === 'session.execution.succeeded') {
        // wait() is observational and may not be abortable in 2.0.18.
        void ctx.session.wait({ sessionID: event.sessionId }).then(() => {
          if (lifecycle.isActive()) void lifecycle.run(() => continuation.run(event.sessionId, true));
        }).catch(() => { if (lifecycle.isActive()) warn('session_wait_failed'); });
      }
      if (event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted'
        || event.type === 'session.execution.succeeded') {
        void lifecycle.run(() => execution.onSessionEnded(event.sessionId)).catch(() => warn('execution_reconciliation_failed'));
      }
      if (event.type === 'session.compaction.ended') {
        void lifecycle.run(() => saveCompaction(event.sessionId)).catch(() => warn('compaction_summary_read_failed'));
      }
    };
    const subscribeController = new AbortController();
    const subscribe = async () => {
      let backoff = 250;
      while (lifecycle.isActive()) {
        try {
          for await (const event of ctx.event.subscribe({ signal: subscribeController.signal })) {
            if (!lifecycle.isActive()) return;
            observe(event);
            backoff = 250;
          }
        } catch {
          if (lifecycle.isActive()) warn('event_subscription_disconnected');
        }
        if (!lifecycle.isActive()) return;
        if (trackingAvailable) await lifecycle.reconcile(async () => {
          try { await continuation.reconcileTracked(); } catch { warn('session_reconciliation_failed'); }
        });
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, backoff);
          lifecycle.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        backoff = Math.min(10_000, backoff * 2);
      }
    };
    void subscribe();
    const timer = trackingAvailable ? setInterval(() => {
      void lifecycle.reconcile(async () => {
        try { await continuation.reconcileTracked(); } catch { warn('session_reconciliation_failed'); }
      });
    }, 1_000) : undefined;
    timer?.unref?.();
    if (trackingAvailable) void lifecycle.reconcile(async () => {
      try { await continuation.reconcileTracked(); } catch { warn('session_reconciliation_failed'); }
    });
    return () => lifecycle.dispose(() => {
      if (timer) clearInterval(timer);
      subscribeController.abort();
    });
  },
});

export default KiokukoPlugin;
