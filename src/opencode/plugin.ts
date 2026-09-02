import type { Plugin } from '@opencode-ai/plugin';
import { createOpenCodeIdleHandler, reconcileOpenCodeIdle, type IdleContinuationDependencies } from './idle.js';
import { OpenCodeIdleState } from './idle-state.js';
import { parseOpenCodePluginOptions } from './runtime-invocation.js';

/**
 * OpenCode's plugin entrypoint.
 *
 * Keep this boundary thin: OpenCode owns the injected SDK client and event
 * lifecycle; Kiokuko only supplies bounded policy/effect adapters.
 */
export const KiokukoPlugin: Plugin = async ({ client, directory }, options) => {
  const runtime = options === undefined ? undefined : parseOpenCodePluginOptions(options);
  const state = new OpenCodeIdleState();
  const reconciliationState = { sessionUpdates: new Map<string, number>(), retrySessionIds: new Set<string>() };
  const idleDependencies: IdleContinuationDependencies = {
    state,
    reconciliationState,
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
  const event = createOpenCodeIdleHandler(client, directory, idleDependencies);
  const reconcile = () => reconcileOpenCodeIdle(client, directory, idleDependencies).catch(() => undefined);
  const timer = setInterval(reconcile, 1_000);
  timer.unref?.();
  void reconcile();
  return {
    event,
    dispose: async () => {
      clearInterval(timer);
    },
  };
};

export default KiokukoPlugin;
