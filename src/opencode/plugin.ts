import type { Plugin } from '@opencode-ai/plugin';
import { createOpenCodeIdleHandler, KIOKUKO_OPENCODE_API_TIMEOUT_MS, OpenCodeSessionFlights, reconcileOpenCodeIdle, type IdleContinuationDependencies } from './idle.js';
import { OpenCodeIdleState } from './idle-state.js';
import { parseOpenCodePluginOptions } from './runtime-invocation.js';
import { OpenCodeCompactionState } from './compaction.js';
import { OpenCodePluginLifecycle } from './lifecycle.js';
import { runKiokukoCompactionHook } from './hook-effect.js';
import { canonicalContentHash } from '../serialization/validate.js';

/**
 * OpenCode's plugin entrypoint.
 *
 * Keep this boundary thin: OpenCode owns the injected SDK client and event
 * lifecycle; Kiokuko only supplies bounded policy/effect adapters.
 */
export const KiokukoPlugin: Plugin = async ({ client, directory }, options) => {
  const runtime = options === undefined ? undefined : parseOpenCodePluginOptions(options);
  const state = new OpenCodeIdleState();
  const compactionState = new OpenCodeCompactionState();
  const flights = new OpenCodeSessionFlights();
  const lifecycle = new OpenCodePluginLifecycle();
  const compactionFlights = new Map<string, Promise<void>>();
  const reconciliationState = { sessionUpdates: new Map<string, number>(), retrySessionIds: new Set<string>() };
  const idleDependencies: IdleContinuationDependencies = {
    state,
    flights,
    reconciliationState,
    signal: lifecycle.signal,
    active: () => lifecycle.isActive(),
    ...(options === undefined ? {} : runtime === undefined
      ? { runtimeFailure: 'version_mismatch' as const }
      : { runtime }),
    log: async (message, extra) => {
      await client.app.log({
        body: { service: 'kiokuko', level: 'warn', message, ...(extra === undefined ? {} : { extra }) },
        query: { directory },
      });
    },
  };
  const handleEvent = createOpenCodeIdleHandler(client, directory, idleDependencies);
  const compactionHookDependencies = {
    signal: lifecycle.signal,
    timeoutMs: 1_500,
    ...(options === undefined ? {} : runtime === undefined
      ? { runtimeFailure: 'version_mismatch' as const }
      : { runtime }),
  };
  const postCompaction = (sessionId: string): void => {
    if (!lifecycle.isActive() || compactionFlights.has(sessionId)) return;
    const operation = lifecycle.run(async () => {
      try {
        for (let attempt = 0; attempt < 3 && lifecycle.isActive(); attempt += 1) {
          if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, attempt * 50));
          const response = await client.session.messages({
            path: { id: sessionId },
            signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(KIOKUKO_OPENCODE_API_TIMEOUT_MS)]),
          });
          if (!lifecycle.isActive()) return;
          const messages = typeof response === 'object' && response !== null && 'data' in response
            ? (response as { data?: unknown }).data
            : response;
          if (!Array.isArray(messages)) continue;
          const summary = [...messages].reverse().find((message) => {
            const info = typeof message === 'object' && message !== null && 'info' in message
              ? (message as { info?: unknown }).info
              : undefined;
            return typeof info === 'object' && info !== null && (info as { summary?: unknown }).summary === true;
          }) as { info?: { id?: unknown }; parts?: unknown } | undefined;
          if (summary === undefined || typeof summary.info?.id !== 'string' || !Array.isArray(summary.parts)) continue;
          const summaryText = summary.parts.flatMap((part) => {
            if (typeof part !== 'object' || part === null) return [];
            const value = part as { type?: unknown; text?: unknown };
            return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
          }).join('\n').trim();
          if (summaryText.length === 0 || summaryText.length > 64 * 1024) return;
          const boundary = compactionState.boundary(sessionId);
          await runKiokukoCompactionHook({
            phase: 'after',
            sessionId,
            cwd: directory,
            runId: boundary?.runId ?? null,
            summaryMessageId: summary.info.id,
            summaryText,
            summaryDigest: canonicalContentHash(summaryText),
          }, compactionHookDependencies);
          return;
        }
      } catch (error) {
        if (!lifecycle.signal.aborted) await idleDependencies.log?.('OpenCode compaction meditation enqueue failed', { reason: 'compaction_post_failed' });
      }
    });
    compactionFlights.set(sessionId, operation);
    void operation.finally(() => compactionFlights.delete(sessionId)).catch(() => undefined);
  };
  const event = (input: { event: unknown }) => {
    const value = typeof input.event === 'object' && input.event !== null
      ? input.event as { type?: unknown; properties?: { sessionID?: unknown } }
      : undefined;
    if (value?.type === 'session.compacted' && typeof value.properties?.sessionID === 'string') {
      postCompaction(value.properties.sessionID);
    }
    return lifecycle.run(() => handleEvent(input));
  };
  const reconcile = () => lifecycle.reconcile(async () => {
    try {
      await reconcileOpenCodeIdle(client, directory, idleDependencies);
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      throw error;
    }
  });
  const reportReconcileFailure = async (): Promise<void> => {
    try {
      await client.app.log({
        body: { service: 'kiokuko', level: 'warn', message: 'OpenCode reconciliation failed', extra: { reason: 'reconciliation_error' } },
        query: { directory },
      });
    } catch {
      // Logging must not create another lifecycle failure.
    }
  };
  const timer = setInterval(() => {
    void reconcile().catch(reportReconcileFailure);
  }, 1_000);
  timer.unref?.();
  void reconcile().catch(reportReconcileFailure);
  return {
    event,
    'tool.execute.after': async ({ tool, sessionID }, output) => {
      if (!lifecycle.isActive()) return;
      compactionState.observe(sessionID, tool, output.output);
    },
    'experimental.session.compacting': async ({ sessionID }, output) => {
      if (!lifecycle.isActive()) return;
      compactionState.appendContext(sessionID, output.context);
      const boundary = compactionState.boundary(sessionID);
      if (boundary !== null) {
        await runKiokukoCompactionHook({
          phase: 'before',
          sessionId: sessionID,
          cwd: directory,
          boundary,
        }, compactionHookDependencies);
      }
    },
    'experimental.compaction.autocontinue': async ({ sessionID }) => {
      if (lifecycle.isActive()) postCompaction(sessionID);
    },
    dispose: () => lifecycle.dispose(() => clearInterval(timer)),
  };
};

export default KiokukoPlugin;
