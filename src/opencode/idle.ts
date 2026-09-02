import { createHash } from 'node:crypto';
import type { PluginInput } from '@opencode-ai/plugin';
import { findSecretInValue } from '../memory/secrets.js';
import { normalizeOpenCodeEvent } from './events.js';
import {
  runKiokukoHook,
  type HookDecision,
  type HookFailureReason,
  type HookEffectInput,
  type HookEffectDependencies,
  type OpenCodeRuntimeInvocation,
} from './hook-effect.js';
import { OpenCodeIdleState, MAX_IDLE_RETRIES } from './idle-state.js';

type OpenCodeClient = PluginInput['client'];

interface IdleMessage {
  info?: { id?: unknown };
}

export interface IdleContinuationDependencies {
  runHook?: typeof runKiokukoHook;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void> | void;
  state?: OpenCodeIdleState;
  runtime?: OpenCodeRuntimeInvocation;
  runtimeFailure?: HookFailureReason;
}

function eventObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function eventMessageId(event: unknown): string | undefined {
  const properties = eventObject(eventObject(event)?.properties);
  for (const key of ['messageID', 'messageId', 'eventID', 'eventId', 'id']) {
    const value = properties?.[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)) {
      return value;
    }
  }
  return undefined;
}

function terminalId(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const last = messages[messages.length - 1] as IdleMessage | undefined;
  const id = last?.info?.id;
  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : undefined;
}

function containsMessage(messages: unknown, messageId: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => eventObject(eventObject(message)?.info)?.id === messageId);
}

function promptMessageId(sessionId: string, terminalMessageId: string): string {
  const digest = createHash('sha256')
    .update('kiokuko-opencode-prompt-v1\0', 'utf8')
    .update(sessionId, 'utf8')
    .update('\0', 'utf8')
    .update(terminalMessageId, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `msg_kiokuko_${digest}`;
}

async function safeLog(
  log: IdleContinuationDependencies['log'],
  message: string,
  reason: string,
  attempts?: number,
): Promise<void> {
  if (log === undefined) return;
  try {
    const extra: Record<string, unknown> = { reason };
    if (attempts !== undefined) extra.attempts = attempts;
    if (findSecretInValue(extra) !== undefined) return;
    await log(message, extra);
  } catch {
    // Logging must never affect the OpenCode lifecycle.
  }
}

function hookDependencies(dependencies: IdleContinuationDependencies): HookEffectDependencies {
  return {
    ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
    ...(dependencies.runtimeFailure === undefined ? {} : { runtimeFailure: dependencies.runtimeFailure }),
  };
}

async function sendPendingPrompt(
  client: OpenCodeClient,
  sessionId: string,
  key: string,
  state: OpenCodeIdleState,
  dependencies: IdleContinuationDependencies,
): Promise<void> {
  const pending = state.markPromptAttempt(key);
  if (pending === undefined) return;
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: { messageID: pending.messageId, parts: [{ type: 'text', text: pending.text }] },
    });
    state.markCompleted(key, 'continued');
  } catch {
    try {
      const messages = await client.session.messages({ path: { id: sessionId } });
      if (containsMessage((messages as { data?: unknown }).data, pending.messageId)) {
        state.markCompleted(key, 'reconciled');
        await safeLog(dependencies.log, 'OpenCode continuation reconciled', 'prompt_reconciled');
        return;
      }
    } catch {
      // Keep the pending prompt for an event-driven retry.
    }
    await safeLog(dependencies.log, 'OpenCode continuation prompt was not confirmed', 'prompt_not_confirmed');
    if (pending.promptAttempts >= MAX_IDLE_RETRIES) {
      state.markQuarantined(key, 'prompt_retry_exhausted');
      await safeLog(dependencies.log, 'OpenCode continuation prompt retry exhausted', 'prompt_retry_exhausted', pending.promptAttempts);
    }
  }
}

function handleDecision(
  decision: HookDecision,
  key: string,
  state: OpenCodeIdleState,
  dependencies: IdleContinuationDependencies,
): Promise<void> | undefined {
  if (decision.kind === 'continue') {
    const current = state.get(key);
    if (current?.state !== 'in_flight') return undefined;
    const [sessionId, terminalMessageId] = key.split('\0', 2);
    if (sessionId === undefined || terminalMessageId === undefined) return undefined;
    state.markPendingPrompt(key, promptMessageId(sessionId, terminalMessageId), decision.text);
    return undefined;
  }
  if (decision.kind === 'stop') {
    state.markCompleted(key, 'stopped');
    return safeLog(dependencies.log, 'OpenCode continuation stopped', decision.reason);
  }
  if (decision.retryable) {
    const current = state.get(key);
    const attempts = current?.state === 'in_flight' ? current.attempts : MAX_IDLE_RETRIES;
    state.markRetryableFailure(key, attempts, decision.reason);
    return safeLog(
      dependencies.log,
      'OpenCode continuation failed open',
      attempts >= MAX_IDLE_RETRIES ? 'retry_exhausted' : decision.reason,
      attempts,
    );
  }
  state.markQuarantined(key, decision.reason);
  return safeLog(dependencies.log, 'OpenCode continuation quarantined', decision.reason);
}

/** Handle one normalized OpenCode session.idle lifecycle event. */
export async function handleOpenCodeIdle(
  client: OpenCodeClient,
  directory: string,
  event: unknown,
  dependencies: IdleContinuationDependencies = {},
): Promise<void> {
  const state = dependencies.state ?? new OpenCodeIdleState();
  let envelope;
  try {
    envelope = normalizeOpenCodeEvent({ event, directory });
  } catch {
    await safeLog(dependencies.log, 'OpenCode idle event ignored', 'invalid_event');
    return;
  }
  if (envelope.kind !== 'session.idle') return;
  const sessionId = envelope.sessionId;
  const requestedTerminal = eventMessageId(event);
  const provisionalKey = requestedTerminal === undefined ? undefined : `${sessionId}\0${requestedTerminal}`;
  const provisional = provisionalKey === undefined ? undefined : state.begin(provisionalKey);
  if (provisional?.kind === 'ignored') return;
  if (provisional?.kind === 'capacity_exceeded') {
    await safeLog(dependencies.log, 'OpenCode idle state capacity exceeded', 'state_capacity_exceeded');
    return;
  }
  try {
    const session = await client.session.get({ path: { id: sessionId } });
    const sessionData = (session as { data?: { id?: string; parentID?: string } }).data;
    if (sessionData?.parentID !== undefined) {
      if (provisionalKey !== undefined && provisional?.kind === 'run_hook') state.release(provisionalKey);
      await safeLog(dependencies.log, 'OpenCode child session ignored', 'child_session');
      return;
    }
    if (sessionData === undefined) throw new Error('session_lookup_failed');
    const messages = await client.session.messages({ path: { id: sessionId } });
    const messageData = (messages as { data?: unknown }).data;
    const terminal = terminalId(messageData);
    if (terminal === undefined) {
      if (provisionalKey !== undefined && provisional?.kind === 'run_hook') state.release(provisionalKey);
      await safeLog(dependencies.log, 'OpenCode idle event ignored', 'terminal_evidence_missing');
      return;
    }
    if (requestedTerminal !== undefined && requestedTerminal !== terminal) {
      if (provisionalKey !== undefined && provisional?.kind === 'run_hook') state.release(provisionalKey);
      await safeLog(dependencies.log, 'OpenCode stale idle event ignored', 'stale_event');
      return;
    }
    const key = `${sessionId}\0${terminal}`;
    const started = provisional ?? state.begin(key);
    if (started.kind === 'ignored') return;
    if (started.kind === 'capacity_exceeded') {
      await safeLog(dependencies.log, 'OpenCode idle state capacity exceeded', 'state_capacity_exceeded');
      return;
    }
    if (started.kind === 'send_pending') {
      await sendPendingPrompt(client, sessionId, key, state, dependencies);
      return;
    }
    const runHook = dependencies.runHook ?? ((input: HookEffectInput) => runKiokukoHook(input, hookDependencies(dependencies)));
    let decision: HookDecision;
    try {
      decision = await runHook({ sessionId, terminalMessageId: terminal, cwd: directory });
    } catch {
      decision = { kind: 'failure', retryable: true, reason: 'hook_failed' };
    }
    await handleDecision(decision, key, state, dependencies);
    if (decision.kind === 'continue') {
      await sendPendingPrompt(client, sessionId, key, state, dependencies);
    }
  } catch {
    if (provisionalKey !== undefined && provisional?.kind === 'run_hook') {
      state.markRetryableFailure(provisionalKey, provisional.attempts, 'lifecycle_error');
    }
    await safeLog(dependencies.log, 'OpenCode continuation failed open', 'lifecycle_error');
  }
}

export function createOpenCodeIdleHandler(
  client: OpenCodeClient,
  directory: string,
  dependencies: IdleContinuationDependencies = {},
): (input: { event: unknown }) => Promise<void> {
  const state = dependencies.state ?? new OpenCodeIdleState();
  return ({ event }) => handleOpenCodeIdle(client, directory, event, {
    ...dependencies,
    state,
    log: dependencies.log ?? (async (message, extra) => {
      await client.app.log({
        body: { service: 'kiokuko', level: 'warn', message, ...(extra === undefined ? {} : { extra }) },
        query: { directory },
      });
    }),
  });
}
