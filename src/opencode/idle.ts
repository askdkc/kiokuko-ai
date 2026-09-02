import type { PluginInput } from '@opencode-ai/plugin';
import { findSecretInValue } from '../memory/secrets.js';
import { normalizeOpenCodeEvent } from './events.js';
import { runKiokukoHook, type HookDecision } from './hook-effect.js';

type OpenCodeClient = PluginInput['client'];

interface IdleMessage {
  info?: { id?: unknown };
}

export interface IdleContinuationDependencies {
  runHook?: typeof runKiokukoHook;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void> | void;
}

const processed = new Map<string, string>();
const MAX_PROCESSED = 512;

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

function remember(key: string, terminal: string): void {
  processed.set(key, terminal);
  while (processed.size > MAX_PROCESSED) processed.delete(processed.keys().next().value!);
}

async function safeLog(log: IdleContinuationDependencies['log'], message: string, extra?: Record<string, unknown>): Promise<void> {
  if (log === undefined) return;
  try {
    const safeExtra = extra === undefined || findSecretInValue(extra) !== undefined ? undefined : extra;
    await log(message, safeExtra);
  } catch {
    // Logging must never affect the OpenCode lifecycle.
  }
}

function promptText(decision: HookDecision): string | undefined {
  return decision.kind === 'continue' ? decision.text : undefined;
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
    await safeLog(dependencies.log, 'OpenCode idle event ignored', { reason: 'invalid_event' });
    return;
  }
  if (envelope.kind !== 'session.idle') return;
  const sessionId = envelope.sessionId;
  const requestedTerminal = eventMessageId(event);
  let processedKey: string | undefined;
  try {
    const session = await client.session.get({ path: { id: sessionId } });
    const sessionData = (session as { data?: { id?: string; parentID?: string } }).data;
    if (sessionData?.parentID !== undefined) {
      await safeLog(dependencies.log, 'OpenCode child session ignored', { reason: 'child_session' });
      return;
    }
    if (sessionData === undefined) throw new Error('session_lookup_failed');
    const messages = await client.session.messages({ path: { id: sessionId } });
    const terminal = terminalId((messages as { data?: unknown }).data);
    if (terminal === undefined) {
      await safeLog(dependencies.log, 'OpenCode idle event ignored', { reason: 'terminal_evidence_missing' });
      return;
    }
    if (requestedTerminal !== undefined && requestedTerminal !== terminal) {
      await safeLog(dependencies.log, 'OpenCode stale idle event ignored', { reason: 'stale_event' });
      return;
    }
    const key = `${sessionId}:${terminal}`;
    processedKey = key;
    if (processed.get(key) === terminal) return;
    remember(key, terminal);
    const runHook = dependencies.runHook ?? runKiokukoHook;
    const decision = await runHook({ sessionId, cwd: directory });
    const text = promptText(decision);
    if (text === undefined) {
      if (decision.kind === 'skip') await safeLog(dependencies.log, 'OpenCode continuation skipped', { reason: decision.reason });
      if (decision.kind === 'continue') processed.delete(key);
      return;
    }
    await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text }] },
    });
  } catch {
    if (processedKey !== undefined) processed.delete(processedKey);
    await safeLog(dependencies.log, 'OpenCode continuation failed open', { reason: 'lifecycle_error' });
  }
}

export function createOpenCodeIdleHandler(
  client: OpenCodeClient,
  directory: string,
  dependencies: IdleContinuationDependencies = {},
): (input: { event: unknown }) => Promise<void> {
  return ({ event }) => handleOpenCodeIdle(client, directory, event, {
    ...dependencies,
    log: dependencies.log ?? (async (message, extra) => {
      await client.app.log({
        body: { service: 'kiokuko', level: 'warn', message, ...(extra === undefined ? {} : { extra }) },
        query: { directory },
      });
    }),
  });
}
