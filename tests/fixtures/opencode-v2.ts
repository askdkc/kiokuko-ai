import type { Plugin } from '@opencode/plugin';
import type { ContinuationOperations } from '../../src/opencode/v2-continuation.js';
import type { TrackedOpenCodeSession } from '../../src/opencode/tracking.js';

export const trackedSession: TrackedOpenCodeSession = {
  sessionId: 'ses_1', runId: 'run_1', workspace: 'project:test',
  orchestrationId: 'orch_1', repositoryRoot: '/repo',
  revision: 1, mutationRevision: 1, routeEpoch: 1,
};

export function completedContext() {
  return [
    { type: 'user', id: 'msg_user_1', text: 'start', time: { created: 1 } },
    { type: 'assistant', id: 'msg_assistant_1', time: { created: 2, completed: 3 }, model: { providerID: 'fixture', id: 'model' } },
    { type: 'idle', id: 'msg_idle_1', outcome: 'succeeded', time: { created: 4 } },
  ];
}

export function continuationFixture(overrides: {
  messages?: unknown[];
  prompt?: (input: { sessionID: string; id: string; text: string }) => Promise<unknown>;
  hook?: ContinuationOperations['hook'];
  binding?: TrackedOpenCodeSession;
} = {}) {
  const values = new Map<string, unknown>();
  const prompts: Array<{ sessionID: string; id: string; text: string }> = [];
  const messages = overrides.messages ?? completedContext();
  const binding = overrides.binding ?? trackedSession;
  const ctx = {
    session: {
      get: async () => ({ id: binding.sessionId, projectID: 'prj', location: { directory: binding.repositoryRoot },
        time: { updated: 5 }, outcome: 'succeeded' }),
      context: async () => messages,
      prompt: async (input: { sessionID: string; id: string; text: string }) => {
        prompts.push(input);
        return overrides.prompt?.(input);
      },
    },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, value); },
      scan: async ({ prefix }: { prefix: string }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })) }),
    },
  } as unknown as Plugin.Context;
  const operations: ContinuationOperations = {
    tracked: async () => [binding],
    receipt: async () => ({ contractRevision: binding.revision, mutationRevision: binding.mutationRevision,
      routeEpoch: binding.routeEpoch, attempts: 0, directiveDigest: 'directive-1' }),
    hook: overrides.hook ?? (async () => ({ kind: 'continue', text: 'continue from Kiokuko' })),
  };
  return { ctx, values, prompts, messages, operations, binding };
}
