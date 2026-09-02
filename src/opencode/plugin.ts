import type { Plugin } from '@opencode-ai/plugin';
import { createOpenCodeIdleHandler } from './idle.js';

/**
 * OpenCode's plugin entrypoint.
 *
 * Keep this boundary thin: OpenCode owns the injected SDK client and event
 * lifecycle; Kiokuko only supplies bounded policy/effect adapters.
 */
export const KiokukoPlugin: Plugin = async ({ client, directory }) => ({
  event: createOpenCodeIdleHandler(client, directory),
});

export default KiokukoPlugin;
