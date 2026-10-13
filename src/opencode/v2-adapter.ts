import type { Plugin } from '@opencode/plugin';
import type { TrackedOpenCodeSession } from './tracking.js';

type SessionDomain = Plugin.Context['session'];

export interface SessionSnapshot {
  id: string;
  directory: string;
  projectID: string;
  parentID?: string;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  updated: number;
}

export interface ContextBoundary {
  terminalMessageId: string;
  latestInputId: string;
  executionSucceeded: boolean;
  messages: Awaited<ReturnType<SessionDomain['context']>>;
}

/** Keep V2's domain response types at the boundary; no V1 message facade. */
export async function readSessionSnapshot(session: SessionDomain, sessionId: string): Promise<SessionSnapshot> {
  const value = await session.get({ sessionID: sessionId });
  return {
    id: value.id,
    directory: value.location.directory,
    projectID: value.projectID,
    ...(value.parentID === undefined ? {} : { parentID: value.parentID }),
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
    updated: value.time.updated,
  };
}

/** Only a completed assistant followed by a successful idle marker may continue. */
export async function readContextBoundary(session: SessionDomain, sessionId: string): Promise<ContextBoundary | null> {
  const messages = await session.context({ sessionID: sessionId });
  const last = messages.at(-1);
  if (last?.type !== 'idle' || last.outcome !== 'succeeded') return null;
  let assistantIndex = -1;
  let inputIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.type === 'assistant') assistantIndex = index;
    if (messages[index]?.type === 'user') inputIndex = index;
  }
  if (assistantIndex < 0 || inputIndex < 0 || inputIndex >= assistantIndex) return null;
  const assistant = messages[assistantIndex];
  if (assistant?.type !== 'assistant' || assistant.time.completed === undefined) return null;
  const input = messages[inputIndex];
  if (input?.type !== 'user') return null;
  return { terminalMessageId: assistant.id, latestInputId: input.id, executionSucceeded: true, messages };
}

export function validateSessionBinding(
  snapshot: SessionSnapshot,
  binding: TrackedOpenCodeSession,
  directory: string,
  projectID: string,
): boolean {
  return snapshot.id === binding.sessionId
    && snapshot.parentID === undefined
    && snapshot.directory === directory
    && snapshot.directory === binding.repositoryRoot
    && snapshot.projectID === projectID;
}

function modelReference(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const model = value as Record<string, unknown>;
  if (typeof model.providerID !== 'string' || typeof model.id !== 'string'
    || [model.providerID, model.id, model.variant ?? ''].some(part => typeof part !== 'string' || part.length > 200 || /[\p{Cc}\p{Cf}]/u.test(part))) return undefined;
  return `${model.providerID}/${model.id}${model.variant ? '#' + model.variant : ''}`;
}

export function v2EventSession(value: unknown): { id: string; type: string; sessionId: string; directory?: string; fromModel?: string; toModel?: string; compactionSummary?: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Record<string, unknown>;
  const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : null;
  const location = typeof event.location === 'object' && event.location !== null ? event.location as Record<string, unknown> : null;
  if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof data?.sessionID !== 'string') return null;
  const fromModel = event.type === 'session.model.selected' ? modelReference(data.previous) : undefined;
  const toModel = event.type === 'session.model.selected' ? modelReference(data.model) : undefined;
  const compactionSummary = event.type === 'session.compaction.ended' && typeof data.text === 'string'
    ? data.text.length <= 64 * 1024 ? data.text : '' : undefined;
  return {
    id: event.id,
    type: event.type,
    sessionId: data.sessionID,
    ...(typeof location?.directory === 'string' ? { directory: location.directory } : {}),
    ...(fromModel === undefined ? {} : { fromModel }),
    ...(toModel === undefined ? {} : { toModel }),
    ...(compactionSummary === undefined ? {} : { compactionSummary }),
  };
}
