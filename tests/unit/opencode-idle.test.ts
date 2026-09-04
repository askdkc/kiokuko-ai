import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOpenCodeIdle, openCodeIdleKey, OpenCodeSessionFlights, reconcileOpenCodeIdle } from '../../src/opencode/idle.js';
import { OpenCodeIdleState } from '../../src/opencode/idle-state.js';

function idle(sessionID: string, messageID?: string): object {
  return {
    type: 'session.idle',
    properties: { sessionID, ...(messageID === undefined ? {} : { messageID }) },
  };
}

function assistant(id: string): object {
  return { info: { id, role: 'assistant', time: { completed: 1 } } };
}

test('idle continuation ignores child and stale events and deduplicates one terminal message', async () => {
  const prompts: string[] = [];
  const calls: Array<{ sessionId: string; cwd: string }> = [];
  const state = new OpenCodeIdleState();
  let terminal = 'terminal-a';
  let delivered: string | undefined;
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({
        data: path.id === 'child-session'
          ? { id: path.id, parentID: 'root-session', directory: '/repo' }
          : { id: path.id, directory: '/repo' },
      }),
      messages: async () => ({ data: [assistant(terminal), ...(delivered === undefined ? [] : [{ info: { id: delivered } }])] }),
      prompt: async ({ path, body }: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
        prompts.push(`${path.id}:${body.parts[0]!.text}`);
        delivered = (body as unknown as { messageID: string }).messageID;
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
  delivered = undefined;
  await handleOpenCodeIdle(client as never, '/repo', idle('root-session', 'terminal-b'), { runHook, state });
  assert.equal(calls.length, 2);
  assert.equal(prompts.length, 2);
});

test('idle failure is fail-open and only emits bounded sanitized diagnostics', async () => {
  const warnings: Array<{ message: string; extra?: Record<string, unknown> }> = [];
  const client = {
    session: {
      get: async () => ({ data: { id: 'failure-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant('failure-terminal')] }),
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
  let delivered: string | undefined;
  const client = {
    session: {
      get: async () => ({ data: { id: 'recovery-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant('recovery-terminal'), ...(delivered === undefined ? [] : [{ info: { id: delivered } }])] }),
      prompt: async ({ body }: { body: { messageID: string } }) => { prompts.push(body.messageID); delivered = body.messageID; },
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
      get: async () => ({ data: { id: 'reconcile-session', directory: '/repo' } }),
      messages: async () => ({ data: [
        assistant('reconcile-terminal'),
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
  assert.equal(state.get(openCodeIdleKey('/repo', 'reconcile-session', 'reconcile-terminal'))?.state, 'completed');
});

test('undelivered prompt remains pending and retries with the same message ID', async () => {
  const state = new OpenCodeIdleState();
  let hookCalls = 0;
  let prompts = 0;
  const messageIds: string[] = [];
  let delivered: string | undefined;
  const client = {
    session: {
      get: async () => ({ data: { id: 'pending-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant('pending-terminal'), ...(delivered === undefined ? [] : [{ info: { id: delivered } }])] }),
      prompt: async ({ body }: { body: { messageID: string } }) => {
        prompts += 1;
        messageIds.push(body.messageID);
        if (prompts === 1) throw new Error('not delivered');
        delivered = body.messageID;
      },
    },
  };
  const runHook = async () => {
    hookCalls += 1;
    return { kind: 'continue' as const, text: 'retry this exact prompt' };
  };
  await handleOpenCodeIdle(client as never, '/repo', idle('pending-session', 'pending-terminal'), { runHook, state });
  assert.equal(state.get(openCodeIdleKey('/repo', 'pending-session', 'pending-terminal'))?.state, 'pending_prompt');
  await handleOpenCodeIdle(client as never, '/repo', idle('pending-session', 'pending-terminal'), { runHook, state });
  assert.equal(hookCalls, 1);
  assert.equal(prompts, 2);
  assert.equal(messageIds[0], messageIds[1]);
  assert.equal(state.get(openCodeIdleKey('/repo', 'pending-session', 'pending-terminal'))?.state, 'completed');
});

test('undelivered prompt is quarantined after three unconfirmed sends', async () => {
  const state = new OpenCodeIdleState();
  let hookCalls = 0;
  let prompts = 0;
  const messageIds: string[] = [];
  const client = {
    session: {
      get: async () => ({ data: { id: 'exhausted-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant('exhausted-terminal')] }),
      prompt: async ({ body }: { body: { messageID: string } }) => {
        prompts += 1;
        messageIds.push(body.messageID);
        throw new Error('not delivered');
      },
    },
  };
  const runHook = async () => {
    hookCalls += 1;
    return { kind: 'continue' as const, text: 'retry until exhausted' };
  };
  const input = idle('exhausted-session', 'exhausted-terminal');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await handleOpenCodeIdle(client as never, '/repo', input, { runHook, state });
  }
  assert.equal(hookCalls, 1);
  assert.equal(prompts, 3);
  assert.equal(new Set(messageIds).size, 1);
  assert.deepEqual(state.get(openCodeIdleKey('/repo', 'exhausted-session', 'exhausted-terminal')), {
    state: 'quarantined',
    reason: 'prompt_retry_exhausted',
  });
});

test('one hundred concurrent idle events claim one terminal once', async () => {
  const state = new OpenCodeIdleState();
  let hookCalls = 0;
  let prompts = 0;
  let delivered: string | undefined;
  const client = {
    session: {
      get: async () => ({ data: { id: 'concurrent-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant('concurrent-terminal'), ...(delivered === undefined ? [] : [{ info: { id: delivered } }])] }),
      prompt: async ({ body }: { body: { messageID: string } }) => { prompts += 1; delivered = body.messageID; },
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

test('prompt API success remains pending until messages read-back confirms delivery', async () => {
  const state = new OpenCodeIdleState();
  let prompts = 0;
  const client = {
    session: {
      get: async () => ({ data: { id: 'unconfirmed-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant('unconfirmed-terminal')] }),
      prompt: async () => { prompts += 1; },
    },
  };
  await handleOpenCodeIdle(client as never, '/repo', idle('unconfirmed-session', 'unconfirmed-terminal'), {
    state,
    runHook: async () => ({ kind: 'continue' as const, text: 'confirm me' }),
  });
  assert.equal(prompts, 1);
  assert.equal(state.get(openCodeIdleKey('/repo', 'unconfirmed-session', 'unconfirmed-terminal'))?.state, 'pending_prompt');
});

test('concurrent pending retries claim one prompt delivery attempt', async () => {
  const state = new OpenCodeIdleState();
  let prompts = 0;
  let delivered: string | undefined;
  const client = {
    session: {
      get: async () => ({ data: { id: 'retry-once-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant('retry-once-terminal'), ...(delivered === undefined ? [] : [{ info: { id: delivered } }])] }),
      prompt: async ({ body }: { body: { messageID: string } }) => {
        prompts += 1;
        if (prompts === 1) throw new Error('first delivery is unconfirmed');
        delivered = body.messageID;
        await Promise.resolve();
      },
    },
  };
  const dependencies = { state, runHook: async () => ({ kind: 'continue' as const, text: 'retry once' }) };
  const event = idle('retry-once-session', 'retry-once-terminal');
  await handleOpenCodeIdle(client as never, '/repo', event, dependencies);
  await Promise.all(Array.from({ length: 20 }, () => handleOpenCodeIdle(client as never, '/repo', event, dependencies)));
  assert.equal(prompts, 2);
  assert.equal(state.get(openCodeIdleKey('/repo', 'retry-once-session', 'retry-once-terminal'))?.state, 'completed');
});

test('a reloaded plugin reconciles an accepted deterministic prompt before rerunning the hook', async () => {
  let delivered: string | undefined;
  let hookCalls = 0;
  const client = {
    session: {
      get: async () => ({ data: { id: 'reload-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant('reload-terminal'), ...(delivered === undefined ? [] : [{ info: { id: delivered } }])] }),
      prompt: async ({ body }: { body: { messageID: string } }) => { delivered = body.messageID; },
    },
  };
  const event = idle('reload-session', 'reload-terminal');
  await handleOpenCodeIdle(client as never, '/repo', event, {
    state: new OpenCodeIdleState(),
    runHook: async () => { hookCalls += 1; return { kind: 'continue' as const, text: 'persist externally' }; },
  });
  await handleOpenCodeIdle(client as never, '/repo', event, {
    state: new OpenCodeIdleState(),
    runHook: async () => { hookCalls += 1; return { kind: 'continue' as const, text: 'must not run' }; },
  });
  assert.equal(hookCalls, 1);
});

test('session flights serialize one session while different sessions remain parallel', async () => {
  const flights = new OpenCodeSessionFlights();
  const state = new OpenCodeIdleState();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delivered = new Set<string>();
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: '/repo' } }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: [
        assistant(`terminal-${path.id}`),
        ...[...delivered].filter((id) => id.includes(path.id)).map((id) => ({ info: { id } })),
      ] }),
      prompt: async ({ path, body }: { path: { id: string }; body: { messageID: string } }) => { delivered.add(`${path.id}-${body.messageID}`); },
    },
  };
  const runHook = async ({ sessionId }: { sessionId: string }) => {
    started.push(sessionId);
    await gate;
    return { kind: 'stop' as const, reason: 'no_active_run' as const };
  };
  const first = handleOpenCodeIdle(client as never, '/repo', idle('one', 'terminal-one'), { state, flights, runHook });
  const duplicate = handleOpenCodeIdle(client as never, '/repo', idle('one', 'terminal-one'), { state, flights, runHook });
  const second = handleOpenCodeIdle(client as never, '/repo', idle('two', 'terminal-two'), { state, flights, runHook });
  for (let index = 0; index < 20 && started.length < 2; index += 1) await Promise.resolve();
  const observed = [...started].sort();
  release();
  await Promise.all([first, duplicate, second]);
  assert.deepEqual(observed, ['one', 'two']);
});

test('session flights queue a newer terminal instead of dropping it behind an older event', async () => {
  const flights = new OpenCodeSessionFlights();
  const state = new OpenCodeIdleState();
  const called: string[] = [];
  let terminal = 'terminal-a';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = {
    session: {
      get: async () => ({ data: { id: 'queued-session', directory: '/repo' } }),
      messages: async () => ({ data: [assistant(terminal)] }),
      prompt: async () => undefined,
    },
  };
  const runHook = async ({ terminalMessageId }: { terminalMessageId: string }) => {
    called.push(terminalMessageId);
    if (terminalMessageId === 'terminal-a') await gate;
    return { kind: 'stop' as const, reason: 'no_active_run' as const };
  };
  const first = handleOpenCodeIdle(client as never, '/repo', idle('queued-session', 'terminal-a'), { state, flights, runHook });
  for (let index = 0; index < 20 && called.length === 0; index += 1) await Promise.resolve();
  terminal = 'terminal-b';
  const second = handleOpenCodeIdle(client as never, '/repo', idle('queued-session', 'terminal-b'), { state, flights, runHook });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(called, ['terminal-a', 'terminal-b']);
});

test('an event cannot bind a session from another directory', async () => {
  let hookCalls = 0;
  const client = {
    session: {
      get: async () => ({ data: { id: 'moved-session', directory: '/other-repo' } }),
      messages: async () => ({ data: [assistant('moved-terminal')] }),
      prompt: async () => undefined,
    },
  };
  await handleOpenCodeIdle(client as never, '/repo', idle('moved-session', 'moved-terminal'), {
    runHook: async () => { hookCalls += 1; return { kind: 'stop' as const, reason: 'no_active_run' as const }; },
  });
  assert.equal(hookCalls, 0);
});

test('idle reconciliation recovers a silent host event stream and ignores child sessions', async () => {
  const state = new OpenCodeIdleState();
  const reconciliationState = { sessionUpdates: new Map<string, number>(), retrySessionIds: new Set<string>() };
  let hookCalls = 0;
  const prompts: string[] = [];
  let delivered: string | undefined;
  const client = {
    session: {
      list: async () => ({ data: [
        { id: 'root-session', directory: '/repo', time: { updated: 2 } },
        { id: 'child-session', directory: '/repo', parentID: 'root-session', time: { updated: 2 } },
      ] }),
      status: async () => ({ data: {
        'root-session': { type: 'idle' },
        'child-session': { type: 'idle' },
      } }),
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: '/repo' } }),
      messages: async () => ({ data: [{ info: {
        id: 'terminal-session', role: 'assistant', time: { completed: 1 },
      } }, ...(delivered === undefined ? [] : [{ info: { id: delivered } }])] }),
      prompt: async ({ path, body }: { path: { id: string }; body: { messageID: string } }) => { prompts.push(path.id); delivered = body.messageID; },
    },
  };
  await reconcileOpenCodeIdle(client as never, '/repo', {
    state,
    reconciliationState,
    runHook: async () => {
      hookCalls += 1;
      return { kind: 'continue' as const, text: 'resume once' };
    },
  });
  await reconcileOpenCodeIdle(client as never, '/repo', {
    state,
    reconciliationState,
    runHook: async () => {
      hookCalls += 1;
      return { kind: 'continue' as const, text: 'must not replay unchanged session' };
    },
  });
  assert.equal(hookCalls, 1);
  assert.deepEqual(prompts, ['root-session']);
});

test('silent host reconciliation retries the same completed terminal after a transient hook failure', async () => {
  const state = new OpenCodeIdleState();
  const reconciliationState = { sessionUpdates: new Map<string, number>(), retrySessionIds: new Set<string>() };
  let hookCalls = 0;
  let promptCalls = 0;
  let delivered: string | undefined;
  const client = {
    session: {
      list: async () => ({ data: [{ id: 'retry-session', directory: '/repo', time: { updated: 3 } }] }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { id: 'retry-session', directory: '/repo' } }),
      messages: async () => ({ data: [{ info: {
        id: 'retry-terminal', role: 'assistant', time: { completed: 1 },
      } }, ...(delivered === undefined ? [] : [{ info: { id: delivered } }])] }),
      prompt: async ({ body }: { body: { messageID: string } }) => { promptCalls += 1; delivered = body.messageID; },
    },
  };
  const runHook = async () => {
    hookCalls += 1;
    return hookCalls === 1
      ? { kind: 'failure' as const, retryable: true, reason: 'timeout' as const }
      : { kind: 'continue' as const, text: 'retry the same terminal' };
  };
  await reconcileOpenCodeIdle(client as never, '/repo', { state, reconciliationState, runHook });
  await reconcileOpenCodeIdle(client as never, '/repo', { state, reconciliationState, runHook });
  assert.equal(hookCalls, 2);
  assert.equal(promptCalls, 1);
  assert.deepEqual(reconciliationState.retrySessionIds, new Set());
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

test('reconciliation recovers an omitted idle session while a sibling is busy, then recovers the sibling', async () => {
  const calls: string[] = [];
  const reads: string[] = [];
  let statuses: Record<string, { type: string }> = { busy: { type: 'busy' } };
  const client = { session: {
    list: async () => ({ data: ['idle', 'busy'].map((id) => ({ id, directory: '/repo', time: { updated: 1 } })) }),
    status: async () => ({ data: statuses }),
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: '/repo' } }),
    messages: async ({ path }: { path: { id: string } }) => { reads.push(path.id); return { data: [assistant(`terminal-${path.id}`)] }; },
  } };
  const dependencies = {
    state: new OpenCodeIdleState(),
    reconciliationState: { sessionUpdates: new Map<string, number>(), retrySessionIds: new Set<string>() },
    runHook: async ({ sessionId }: { sessionId: string }) => { calls.push(sessionId); return { kind: 'stop' as const, reason: 'no_active_run' as const }; },
  };
  await reconcileOpenCodeIdle(client as never, '/repo', dependencies);
  assert.deepEqual(calls, ['idle']);
  assert.equal(reads.includes('busy'), false);
  assert.equal(dependencies.reconciliationState.sessionUpdates.has('busy'), false);
  statuses = {};
  await reconcileOpenCodeIdle(client as never, '/repo', dependencies);
  assert.deepEqual(calls, ['idle', 'busy']);
  const readCount = reads.length;
  await reconcileOpenCodeIdle(client as never, '/repo', dependencies);
  assert.equal(reads.length, readCount);
});

test('reconciliation retains failed reads without starving another idle session', async () => {
  let fail = true;
  const calls: string[] = [];
  const client = { session: {
    list: async () => ({ data: ['failed', 'healthy'].map((id) => ({ id, directory: '/repo', time: { updated: 1 } })) }),
    status: async () => ({ data: {} }),
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, directory: '/repo' } }),
    messages: async ({ path }: { path: { id: string } }) => {
      if (fail && path.id === 'failed') throw new Error('temporary transport failure');
      return { data: [assistant(`terminal-${path.id}`)] };
    },
  } };
  const dependencies = {
    state: new OpenCodeIdleState(),
    reconciliationState: { sessionUpdates: new Map<string, number>(), retrySessionIds: new Set<string>() },
    runHook: async ({ sessionId }: { sessionId: string }) => { calls.push(sessionId); return { kind: 'stop' as const, reason: 'no_active_run' as const }; },
  };
  await reconcileOpenCodeIdle(client as never, '/repo', dependencies);
  assert.deepEqual(calls, ['healthy']);
  assert.deepEqual([...dependencies.reconciliationState.retrySessionIds], ['failed']);
  fail = false;
  await reconcileOpenCodeIdle(client as never, '/repo', dependencies);
  assert.deepEqual(calls, ['healthy', 'failed']);
  assert.equal(dependencies.reconciliationState.retrySessionIds.size, 0);
});
