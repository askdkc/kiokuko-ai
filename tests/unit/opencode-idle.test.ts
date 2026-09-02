import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOpenCodeIdle } from '../../src/opencode/idle.js';
import { OpenCodeIdleState } from '../../src/opencode/idle-state.js';

function idle(sessionID: string, messageID?: string): object {
  return {
    type: 'session.idle',
    properties: { sessionID, ...(messageID === undefined ? {} : { messageID }) },
  };
}

test('idle continuation ignores child and stale events and deduplicates one terminal message', async () => {
  const prompts: string[] = [];
  const calls: Array<{ sessionId: string; cwd: string }> = [];
  const state = new OpenCodeIdleState();
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
  await handleOpenCodeIdle(client as never, '/repo', idle('child-session', 'terminal-a'), { runHook, state });
  assert.equal(calls.length, 0);

  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'old-terminal'), { runHook, state });
  assert.equal(calls.length, 0);

  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'terminal-a'), { runHook, state });
  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'terminal-a'), { runHook, state });
  assert.equal(calls.length, 1);
  assert.deepEqual(prompts, ['root-session:continue this bounded run']);

  terminal = 'terminal-b';
  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'terminal-b'), { runHook, state });
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
    runHook: async () => ({ kind: 'failure' as const, retryable: true, reason: 'timeout' as const }),
    log: (message, extra) => { warnings.push(extra === undefined ? { message } : { message, extra }); },
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.extra?.reason, 'timeout');
  assert.doesNotMatch(JSON.stringify(warnings), /failure-terminal|repo/u);
});

test('idle retries a transient hook failure and sends one prompt after recovery', async () => {
  const state = new OpenCodeIdleState();
  let hookCalls = 0;
  const prompts: string[] = [];
  const client = {
    session: {
      get: async () => ({ data: { id: 'recovery-session' } }),
      messages: async () => ({ data: [{ info: { id: 'recovery-terminal' } }] }),
      prompt: async ({ body }: { body: { messageID: string } }) => { prompts.push(body.messageID); },
    },
  };
  const runHook = async () => {
    hookCalls += 1;
    return hookCalls === 1
      ? { kind: 'failure' as const, retryable: true, reason: 'adapter_unavailable' as const }
      : { kind: 'continue' as const, text: 'resume after recovery' };
  };
  await handleOpenCodeIdle(client as never, '/repo', idle('recovery-session', 'recovery-terminal'), { runHook, state });
  await handleOpenCodeIdle(client as never, '/repo', idle('recovery-session', 'recovery-terminal'), { runHook, state });
  assert.equal(hookCalls, 2);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /^msg_kiokuko_[0-9a-f]{32}$/u);
});

test('ambiguous prompt result reconciles by deterministic message ID without rerunning the hook', async () => {
  const state = new OpenCodeIdleState();
  let hookCalls = 0;
  let promptMessageId: string | undefined;
  const client = {
    session: {
      get: async () => ({ data: { id: 'reconcile-session' } }),
      messages: async () => ({ data: [
        { info: { id: 'reconcile-terminal' } },
        ...(promptMessageId === undefined ? [] : [{ info: { id: promptMessageId } }]),
      ] }),
      prompt: async ({ body }: { body: { messageID: string } }) => {
        promptMessageId = body.messageID;
        throw new Error('transport result lost after server acceptance');
      },
    },
  };
  const runHook = async () => {
    hookCalls += 1;
    return { kind: 'continue' as const, text: 'reconcile this prompt' };
  };
  await handleOpenCodeIdle(client as never, '/repo', idle('reconcile-session', 'reconcile-terminal'), { runHook, state });
  await handleOpenCodeIdle(client as never, '/repo', idle('reconcile-session', 'reconcile-terminal'), { runHook, state });
  assert.equal(hookCalls, 1);
  assert.ok(promptMessageId?.startsWith('msg_kiokuko_'));
  assert.equal(state.get('reconcile-session\0reconcile-terminal')?.state, 'completed');
});

test('undelivered prompt remains pending and retries with the same message ID', async () => {
  const state = new OpenCodeIdleState();
  let hookCalls = 0;
  let prompts = 0;
  const messageIds: string[] = [];
  const client = {
    session: {
      get: async () => ({ data: { id: 'pending-session' } }),
      messages: async () => ({ data: [{ info: { id: 'pending-terminal' } }] }),
      prompt: async ({ body }: { body: { messageID: string } }) => {
        prompts += 1;
        messageIds.push(body.messageID);
        if (prompts === 1) throw new Error('not delivered');
      },
    },
  };
  const runHook = async () => {
    hookCalls += 1;
    return { kind: 'continue' as const, text: 'retry this exact prompt' };
  };
  await handleOpenCodeIdle(client as never, '/repo', idle('pending-session', 'pending-terminal'), { runHook, state });
  assert.equal(state.get('pending-session\0pending-terminal')?.state, 'pending_prompt');
  await handleOpenCodeIdle(client as never, '/repo', idle('pending-session', 'pending-terminal'), { runHook, state });
  assert.equal(hookCalls, 1);
  assert.equal(prompts, 2);
  assert.equal(messageIds[0], messageIds[1]);
  assert.equal(state.get('pending-session\0pending-terminal')?.state, 'completed');
});

test('one hundred concurrent idle events claim one terminal once', async () => {
  const state = new OpenCodeIdleState();
  let hookCalls = 0;
  let prompts = 0;
  const client = {
    session: {
      get: async () => ({ data: { id: 'concurrent-session' } }),
      messages: async () => ({ data: [{ info: { id: 'concurrent-terminal' } }] }),
      prompt: async () => { prompts += 1; },
    },
  };
  const runHook = async () => {
    hookCalls += 1;
    await Promise.resolve();
    return { kind: 'continue' as const, text: 'once' };
  };
  await Promise.all(Array.from({ length: 100 }, () => handleOpenCodeIdle(
    client as never,
    '/repo',
    idle('concurrent-session', 'concurrent-terminal'),
    { runHook, state },
  )));
  assert.equal(hookCalls, 1);
  assert.equal(prompts, 1);
});

test('idle state eviction never removes active entries', () => {
  const state = new OpenCodeIdleState();
  for (let index = 0; index < 512; index += 1) {
    const result = state.begin(`active-${index}`);
    assert.equal(result.kind, 'run_hook');
  }
  assert.equal(state.begin('overflow').kind, 'capacity_exceeded');
  state.markCompleted('active-0', 'stopped');
  assert.equal(state.begin('overflow').kind, 'run_hook');
  assert.equal(state.get('active-1')?.state, 'in_flight');
});
