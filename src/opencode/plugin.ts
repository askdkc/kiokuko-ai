import type { Plugin } from '@opencode-ai/plugin';
import { createOpenCodeIdleHandler, OpenCodeSessionFlights, reconcileOpenCodeIdle, type IdleContinuationDependencies } from './idle.js';
import { OpenCodeIdleState } from './idle-state.js';
import { parseOpenCodePluginOptions } from './runtime-invocation.js';
import { OpenCodeCompactionState } from './compaction.js';
import { OpenCodePluginLifecycle } from './lifecycle.js';

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
  const event = (input: { event: unknown }) => lifecycle.run(() => handleEvent(input));
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
    },
    dispose: () => lifecycle.dispose(() => clearInterval(timer)),
  };
};

export default KiokukoPlugin;
