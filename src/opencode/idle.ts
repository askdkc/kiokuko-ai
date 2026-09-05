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
import { MAX_IDLE_ENTRIES, OpenCodeIdleState } from './idle-state.js';

type OpenCodeClient = PluginInput['client'];
export const KIOKUKO_OPENCODE_API_TIMEOUT_MS = 10_000;

interface IdleMessage {
  info?: { id?: unknown };
}

export interface IdleContinuationDependencies {
  runHook?: typeof runKiokukoHook;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void> | void;
  state?: OpenCodeIdleState;
  reconciliationState?: OpenCodeIdleReconciliationState;
  runtime?: OpenCodeRuntimeInvocation;
  runtimeFailure?: HookFailureReason;
  flights?: OpenCodeSessionFlights;
  signal?: AbortSignal;
  active?: () => boolean;
  apiTimeoutMs?: number;
}

export interface OpenCodeIdleReconciliationState {
  readonly sessionUpdates: Map<string, number>;
  readonly retrySessionIds: Set<string>;
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
  return completedAssistantMessage(last)
    && typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : undefined;
}

function containsMessage(messages: unknown, messageId: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => eventObject(eventObject(message)?.info)?.id === messageId);
}

export function openCodeIdleKey(directory: string, sessionId: string, terminalMessageId: string): string {
  return JSON.stringify([directory, sessionId, terminalMessageId]);
}

function sessionFlightKey(directory: string, sessionId: string): string {
  return JSON.stringify([directory, sessionId]);
}

function promptMessageId(directory: string, sessionId: string, terminalMessageId: string): string {
  const digest = createHash('sha256')
    .update('kiokuko-opencode-prompt-v1\0', 'utf8')
    .update(directory, 'utf8')
    .update('\0', 'utf8')
    .update(sessionId, 'utf8')
    .update('\0', 'utf8')
    .update(terminalMessageId, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `msg_kiokuko_${digest}`;
}

/** Aggregate work per repository/session while allowing unrelated sessions to proceed in parallel. */
export class OpenCodeSessionFlights {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly exact = new Map<string, Promise<void>>();

  run(sessionKey: string, logicalKey: string, operation: () => Promise<void>): Promise<void> {
    const exactKey = JSON.stringify([sessionKey, logicalKey]);
    const existing = this.exact.get(exactKey);
    if (existing !== undefined) return existing;
    const predecessor = this.tails.get(sessionKey) ?? Promise.resolve();
    const current = predecessor.catch(() => undefined).then(operation).finally(() => {
      if (this.exact.get(exactKey) === current) this.exact.delete(exactKey);
      if (this.tails.get(sessionKey) === current) this.tails.delete(sessionKey);
    });
    this.exact.set(exactKey, current);
    this.tails.set(sessionKey, current);
    return current;
  }
}

function isActive(dependencies: IdleContinuationDependencies): boolean {
  return dependencies.signal?.aborted !== true && dependencies.active?.() !== false;
}

function requestSignal(dependencies: IdleContinuationDependencies): { signal?: AbortSignal } {
  const timeout = AbortSignal.timeout(dependencies.apiTimeoutMs ?? KIOKUKO_OPENCODE_API_TIMEOUT_MS);
  return {
    signal: dependencies.signal === undefined
      ? timeout
      : AbortSignal.any([dependencies.signal, timeout]),
  };
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
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  };
}

async function readSessionMessages(
  client: OpenCodeClient,
  sessionId: string,
  dependencies: IdleContinuationDependencies,
): Promise<unknown> {
  const messages = await client.session.messages({ path: { id: sessionId }, ...requestSignal(dependencies) });
  return responseData(messages);
}

async function sendPendingPrompt(
  client: OpenCodeClient,
  sessionId: string,
  key: string,
  state: OpenCodeIdleState,
  dependencies: IdleContinuationDependencies,
): Promise<void> {
  const pending = state.claimPrompt(key);
  if (pending === undefined || !isActive(dependencies)) return;
  let preflightRead = false;
  try {
    const messages = await readSessionMessages(client, sessionId, dependencies);
    if (!isActive(dependencies)) return;
    preflightRead = true;
    if (containsMessage(messages, pending.messageId)) {
      state.markCompleted(key, 'reconciled', { state: 'prompt_in_flight', messageId: pending.messageId });
      await safeLog(dependencies.log, 'OpenCode continuation reconciled', 'prompt_reconciled');
      return;
    }
  } catch {
    if (!isActive(dependencies)) return;
  }
  if (!preflightRead && pending.deliveryAttempts > 0) {
    state.markPromptUnconfirmed(key, pending);
    await safeLog(dependencies.log, 'OpenCode continuation prompt read-back was unavailable', 'prompt_readback_unavailable');
    return;
  }
  const attempted = state.markPromptAttempt(key, pending);
  if (attempted === undefined || !isActive(dependencies)) return;
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        messageID: attempted.messageId,
        parts: [{ type: 'text', text: attempted.text, synthetic: true }],
      },
      ...requestSignal(dependencies),
    });
  } catch {
    // An error is ambiguous: the host may still have accepted the message.
  }
  if (!isActive(dependencies)) return;
  try {
    const messages = await readSessionMessages(client, sessionId, dependencies);
    if (!isActive(dependencies)) return;
    if (containsMessage(messages, attempted.messageId)) {
      state.markCompleted(key, 'continued', { state: 'prompt_in_flight', messageId: attempted.messageId });
      return;
    }
  } catch {
    // Keep the prompt pending; a later retry must read back before resending.
  }
  state.markPromptUnconfirmed(key, attempted);
  await safeLog(dependencies.log, 'OpenCode continuation prompt was not confirmed', 'prompt_not_confirmed');
  if (state.get(key)?.state === 'quarantined') {
    await safeLog(dependencies.log, 'OpenCode continuation prompt retry exhausted', 'prompt_retry_exhausted', attempted.deliveryAttempts);
  }
}

function handleDecision(
  decision: HookDecision,
  key: string,
  directory: string,
  sessionId: string,
  terminalMessageId: string,
  hookAttempts: number,
  state: OpenCodeIdleState,
  dependencies: IdleContinuationDependencies,
): Promise<void> | undefined {
  if (decision.kind === 'continue') {
    state.markPendingPrompt(key, hookAttempts, promptMessageId(directory, sessionId, terminalMessageId), decision.text);
    return undefined;
  }
  if (decision.kind === 'stop') {
    state.markCompleted(key, 'stopped', { state: 'in_flight', hookAttempts });
    return safeLog(dependencies.log, 'OpenCode continuation stopped', decision.reason);
  }
  if (decision.retryable) {
    state.markHookFailure(key, hookAttempts, decision.reason);
    return safeLog(
      dependencies.log,
      'OpenCode continuation failed open',
      state.get(key)?.state === 'quarantined' ? 'retry_exhausted' : decision.reason,
      hookAttempts,
    );
  }
  state.markHookQuarantined(key, hookAttempts, decision.reason);
  return safeLog(dependencies.log, 'OpenCode continuation quarantined', decision.reason);
}

async function handleNormalizedOpenCodeIdle(
  client: OpenCodeClient,
  directory: string,
  event: unknown,
  sessionId: string,
  dependencies: IdleContinuationDependencies,
): Promise<void> {
  const state = dependencies.state ?? new OpenCodeIdleState();
  if (!isActive(dependencies)) return;
  const requestedTerminal = eventMessageId(event);
  const provisionalKey = requestedTerminal === undefined
    ? undefined
    : openCodeIdleKey(directory, sessionId, requestedTerminal);
  const provisional = provisionalKey === undefined ? undefined : state.begin(provisionalKey);
  if (provisional?.kind === 'ignored') return;
  if (provisional?.kind === 'capacity_exceeded') {
    await safeLog(dependencies.log, 'OpenCode idle state capacity exceeded', 'state_capacity_exceeded');
    return;
  }
  try {
    const session = await client.session.get({ path: { id: sessionId }, ...requestSignal(dependencies) });
    if (!isActive(dependencies)) return;
    const sessionData = (session as { data?: { id?: string; parentID?: string; directory?: string } }).data;
    if (sessionData?.parentID !== undefined) {
      if (provisionalKey !== undefined && provisional?.kind === 'run_hook') {
        state.release(provisionalKey, provisional.hookAttempts);
      }
      await safeLog(dependencies.log, 'OpenCode child session ignored', 'child_session');
      return;
    }
    if (sessionData?.id !== sessionId || sessionData.directory !== directory) {
      if (provisionalKey !== undefined && provisional?.kind === 'run_hook') {
        state.release(provisionalKey, provisional.hookAttempts);
      }
      await safeLog(dependencies.log, 'OpenCode session identity was inconsistent', 'session_identity_mismatch');
      return;
    }
    const messageData = await readSessionMessages(client, sessionId, dependencies);
    if (!isActive(dependencies)) return;
    if (requestedTerminal !== undefined
      && containsMessage(messageData, promptMessageId(directory, sessionId, requestedTerminal))) {
      state.markCompleted(provisionalKey!, 'reconciled');
      return;
    }
    const terminal = terminalId(messageData);
    if (terminal === undefined) {
      if (provisionalKey !== undefined && provisional?.kind === 'run_hook') {
        state.release(provisionalKey, provisional.hookAttempts);
      }
      await safeLog(dependencies.log, 'OpenCode idle event ignored', 'terminal_evidence_missing');
      return;
    }
    if (requestedTerminal !== undefined && requestedTerminal !== terminal) {
      if (provisionalKey !== undefined && provisional?.kind === 'run_hook') {
        state.release(provisionalKey, provisional.hookAttempts);
      }
      await safeLog(dependencies.log, 'OpenCode stale idle event ignored', 'stale_event');
      return;
    }
    const key = openCodeIdleKey(directory, sessionId, terminal);
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
    if (!isActive(dependencies)) return;
    await handleDecision(decision, key, directory, sessionId, terminal, started.hookAttempts, state, dependencies);
    if (decision.kind === 'continue') await sendPendingPrompt(client, sessionId, key, state, dependencies);
  } catch {
    if (!isActive(dependencies)) return;
    if (provisionalKey !== undefined && provisional?.kind === 'run_hook') {
      state.markHookFailure(provisionalKey, provisional.hookAttempts, 'lifecycle_error');
    }
    await safeLog(dependencies.log, 'OpenCode continuation failed open', 'lifecycle_error');
  }
}

/** Handle one normalized OpenCode session.idle lifecycle event. */
export async function handleOpenCodeIdle(
  client: OpenCodeClient,
  directory: string,
  event: unknown,
  dependencies: IdleContinuationDependencies = {},
): Promise<void> {
  let envelope;
  try {
    envelope = normalizeOpenCodeEvent({ event, directory });
  } catch {
    await safeLog(dependencies.log, 'OpenCode idle event ignored', 'invalid_event');
    return;
  }
  if (envelope.kind !== 'session.idle') return;
  const operation = () => handleNormalizedOpenCodeIdle(client, directory, event, envelope.sessionId, dependencies);
  return dependencies.flights === undefined
    ? operation()
    : dependencies.flights.run(
      sessionFlightKey(directory, envelope.sessionId),
      eventMessageId(event) ?? envelope.eventIdentity,
      operation,
    );
}

function responseData(value: unknown): unknown {
  const record = eventObject(value);
  return record !== undefined && 'data' in record ? record.data : value;
}

function completedAssistantMessage(value: unknown): boolean {
  const message = eventObject(value);
  const info = eventObject(message?.info);
  if (info?.role !== 'assistant') return false;
  const time = eventObject(info.time);
  return typeof time?.completed === 'number' || typeof info.finish === 'string';
}

/**
 * Reconcile idle root sessions when the host does not deliver lifecycle
 * events. OpenCode exposes the status endpoint independently of its event
 * stream, so this is also a bounded recovery path for a silent event bus.
 */
export async function reconcileOpenCodeIdle(
  client: OpenCodeClient,
  directory: string,
  dependencies: IdleContinuationDependencies = {},
): Promise<void> {
  const sessionApi = client.session as typeof client.session & {
    list?: (input: { query: { directory: string } }) => Promise<unknown>;
    status?: (input: { query: { directory: string } }) => Promise<unknown>;
  };
  if (typeof sessionApi.list !== 'function' || typeof sessionApi.status !== 'function') return;

  const [sessionsResponse, statusesResponse] = await Promise.all([
    sessionApi.list({ query: { directory }, ...requestSignal(dependencies) }),
    sessionApi.status({ query: { directory }, ...requestSignal(dependencies) }),
  ]);
  if (!isActive(dependencies)) return;
  const sessions = responseData(sessionsResponse);
  const statuses = responseData(statusesResponse);
  if (!Array.isArray(sessions)) return;
  const rootSessions = new Map<string, { updated: number | undefined }>();
  for (const session of sessions) {
    const record = eventObject(session);
    const id = record?.id;
    if (record?.parentID !== undefined || record?.directory !== directory
      || typeof id !== 'string' || id.length === 0) continue;
    if (rootSessions.size >= MAX_IDLE_ENTRIES) continue;
    const time = eventObject(record.time);
    const updated = typeof time?.updated === 'number' && Number.isSafeInteger(time.updated) ? time.updated : undefined;
    rootSessions.set(id, { updated });
  }
  const rootSessionIds = new Set(rootSessions.keys());
  const reconciliationState = dependencies.reconciliationState ?? { sessionUpdates: new Map(), retrySessionIds: new Set<string>() };
  for (const sessionId of reconciliationState.sessionUpdates.keys()) {
    if (!rootSessionIds.has(sessionId)) reconciliationState.sessionUpdates.delete(sessionId);
  }
  for (const sessionId of reconciliationState.retrySessionIds) {
    if (!rootSessionIds.has(sessionId)) reconciliationState.retrySessionIds.delete(sessionId);
  }
  const statusEntries = eventObject(statuses);
  if (statusEntries === undefined) return;
  const state = dependencies.state ?? new OpenCodeIdleState();
  // OpenCode omits idle sessions from this map. A busy sibling must not
  // suppress recovery, and observing a timestamp is not processing it.
  for (const sessionId of rootSessions.keys()) {
    if (Object.hasOwn(statusEntries, sessionId) && eventObject(statusEntries[sessionId])?.type !== 'idle') {
      reconciliationState.retrySessionIds.add(sessionId);
    }
  }
  const candidates = [...rootSessions.entries()]
    .filter(([sessionId, session]) => session.updated === undefined
      || reconciliationState.sessionUpdates.get(sessionId) !== session.updated
      || reconciliationState.retrySessionIds.has(sessionId)
      || eventObject(statusEntries[sessionId])?.type === 'idle')
    .sort((left, right) => (right[1].updated ?? 0) - (left[1].updated ?? 0));

  for (const [sessionId, session] of candidates) {
    if (!isActive(dependencies)) return;
    if (Object.hasOwn(statusEntries, sessionId) && eventObject(statusEntries[sessionId])?.type !== 'idle') continue;
    reconciliationState.retrySessionIds.add(sessionId);
    try {
      const messages = await readSessionMessages(client, sessionId, dependencies);
      if (!isActive(dependencies)) return;
      const terminal = terminalId(messages);
      if (terminal === undefined) continue;
      await handleOpenCodeIdle(client, directory, {
        type: 'session.idle',
        properties: { sessionID: sessionId, messageID: terminal },
      }, { ...dependencies, state });
      const entry = state.get(openCodeIdleKey(directory, sessionId, terminal));
      if (entry?.state === 'completed' || entry?.state === 'quarantined') {
        if (session.updated !== undefined) reconciliationState.sessionUpdates.set(sessionId, session.updated);
        reconciliationState.retrySessionIds.delete(sessionId);
      }
    } catch {
      if (!isActive(dependencies)) return;
      // Retain this candidate and keep recovering unrelated sessions.
      await safeLog(dependencies.log, 'OpenCode reconciliation read failed', 'lifecycle_error');
    }
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
