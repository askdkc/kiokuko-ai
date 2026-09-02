import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOpenCodeIdle } from '../../src/opencode/idle.js';

function idle(sessionID: string, messageID?: string): object {
  return {
    type: 'session.idle',
    properties: { sessionID, ...(messageID === undefined ? {} : { messageID }) },
  };
}

test('idle continuation ignores child and stale events and deduplicates one terminal message', async () => {
  const prompts: string[] = [];
  const calls: Array<{ sessionId: string; cwd: string }> = [];
  let terminal = 'terminal-a';
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({
        data: path.id === 'child-session' ? { id: path.id, parentID: 'root-session' } : { id: path.id },
      }),
      messages: async () => ({ data: [{ info: { id: terminal } }] }),
      prompt: async ({ path, body }: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
        prompts.push(`${path.id}:${body.parts[0]!.text}`);
      },
    },
  };
  const runHook = async (input: { sessionId: string; cwd: string }) => {
    calls.push(input);
    return { kind: 'continue' as const, text: 'continue this bounded run' };
  };
  await handleOpenCodeIdle(client as never, '/repo', idle('child-session', 'terminal-a'), { runHook });
  assert.equal(calls.length, 0);

  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'old-terminal'), { runHook });
  assert.equal(calls.length, 0);

  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'terminal-a'), { runHook });
  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'terminal-a'), { runHook });
  assert.equal(calls.length, 1);
  assert.deepEqual(prompts, ['root-session:continue this bounded run']);

  terminal = 'terminal-b';
  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'terminal-b'), { runHook });
  assert.equal(calls.length, 2);
  assert.equal(prompts.length, 2);
});

test('idle failure is fail-open and only emits bounded sanitized diagnostics', async () => {
  const warnings: Array<{ message: string; extra?: Record<string, unknown> }> = [];
  const client = {
    session: {
      get: async () => ({ data: { id: 'failure-session' } }),
      messages: async () => ({ data: [{ info: { id: 'failure-terminal' } }] }),
      prompt: async () => { throw new Error('prompt must not be called'); },
    },
  };
  await handleOpenCodeIdle(client as never, '/repo', idle('failure-session', 'failure-terminal'), {
    runHook: async () => ({ kind: 'skip' as const, reason: 'timeout' }),
    log: (message, extra) => { warnings.push(extra === undefined ? { message } : { message, extra }); },
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.extra?.reason, 'timeout');
  assert.doesNotMatch(JSON.stringify(warnings), /failure-terminal|repo/u);
});
