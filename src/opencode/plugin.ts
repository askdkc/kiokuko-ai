import type { Plugin } from '@opencode-ai/plugin';
import { createOpenCodeIdleHandler } from './idle.js';
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
  return {
    event: createOpenCodeIdleHandler(client, directory, {
      state: new OpenCodeIdleState(),
      ...(options === undefined ? {} : runtime === undefined
        ? { runtimeFailure: 'version_mismatch' as const }
        : { runtime }),
    }),
  };
};

export default KiokukoPlugin;
