import { findSecretInValue } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';
import { openCodeEventEnvelopeSchema, type OpenCodeEventEnvelope } from './schemas.js';

interface RawEventInput {
  event: unknown;
  directory: unknown;
}

export type OpenCodeEventInput = RawEventInput;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0') || value.length > 4096) {
    throw new KiokukoError('VALIDATION_ERROR', `${field} must be a non-empty bounded string`);
  }
  return value;
}

function rejectSecrets(value: unknown): void {
  if (findSecretInValue(value) !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'OpenCode event contains secret-shaped data');
  }
}

function envelope(input: {
  kind: OpenCodeEventEnvelope['kind'];
  sessionId: unknown;
  directory: unknown;
  eventIdentity: string;
  eventType: string;
}): OpenCodeEventEnvelope {
  const candidate = {
    kind: input.kind,
    sessionId: requiredIdentity(input.sessionId, 'sessionID'),
    directory: requiredIdentity(input.directory, 'directory'),
    eventIdentity: requiredIdentity(input.eventIdentity, 'eventIdentity'),
    capabilityEvidence: { adapter: 'opencode' as const, continuation: 'session_idle' as const },
    terminalEvidence: { eventType: input.eventType },
  };
  const parsed = openCodeEventEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'OpenCode event envelope is invalid');
  return parsed.data;
}

/** Normalize only the event identities needed by the OpenCode plugin. */
export function normalizeOpenCodeEvent(input: OpenCodeEventInput): OpenCodeEventEnvelope {
  rejectSecrets(input);
  const event = object(input.event);
  const properties = object(event?.properties);
  if (event?.type !== 'session.idle' || properties === undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'Unsupported or malformed OpenCode event');
  }
  const sessionId = requiredIdentity(properties.sessionID, 'sessionID');
  return envelope({
    kind: 'session.idle',
    sessionId,
    directory: input.directory,
    eventIdentity: `session.idle:${sessionId}`,
    eventType: 'session.idle',
  });
}
