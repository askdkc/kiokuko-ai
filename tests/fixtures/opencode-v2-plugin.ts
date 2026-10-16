import type { Plugin } from '@opencode/plugin';

export function pluginContextFixture(directory = '/repo') {
  const hooks = new Map<string, (event: never) => unknown>();
  const values = new Map<string, unknown>();
  const register = (key: string, callback: (event: never) => unknown) => {
    const previous = hooks.get(key);
    hooks.set(key, async event => { await previous?.(event); await callback(event); });
  };
  const tools: unknown[] = []; const commands: unknown[] = [];
  let subscriptionClosed = false;
  const events: unknown[] = [];
  let wake: (() => void) | undefined;
  const ctx = {
    location: { directory, project: { id: 'prj' } },
    options: {},
    command: { transform: async (fn: (editor: unknown) => void) => fn({ add: (value: unknown) => commands.push(value) }) },
    tool: { transform: async (fn: (editor: unknown) => void) => fn({ add: (value: unknown) => tools.push(value) }), reload: async () => undefined, hook: async (name: string, callback: (event: never) => unknown) => { register(`tool:${name}`, callback); } },
    session: {
      hook: async (name: string, callback: (event: never) => unknown) => { register(`session:${name}`, callback); },
      get: async () => ({ id: 'ses_1', location: { directory }, projectID: 'prj', time: { updated: 1 } }),
      context: async () => [], wait: async () => undefined,
    },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        try {
          while (!signal.aborted) {
            if (events.length > 0) { yield events.shift(); continue; }
            await new Promise<void>(resolve => {
              wake = resolve;
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
        } finally { subscriptionClosed = true; }
      },
    }) },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, value); },
      scan: async () => ({ entries: [] }),
    },
  } as unknown as Plugin.Context;
  return { ctx, hooks, values, tools, commands,
    emit(event: unknown) { events.push(event); wake?.(); wake = undefined; },
    get subscriptionClosed() { return subscriptionClosed; } };
}
