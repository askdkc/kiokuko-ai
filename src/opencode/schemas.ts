import { z } from 'zod';

const identity = z.string().trim().min(1).max(4096).refine((value) => !value.includes('\0'));

export const openCodeEventEnvelopeSchema = z.object({
  kind: z.literal('session.idle'),
  sessionId: identity,
  directory: identity,
  eventIdentity: identity,
  capabilityEvidence: z.object({
    adapter: z.literal('opencode'),
    continuation: z.literal('session_idle'),
  }).strict(),
  terminalEvidence: z.object({
    eventType: z.string().min(1).max(128),
  }).strict(),
}).strict();

export type OpenCodeEventEnvelope = z.infer<typeof openCodeEventEnvelopeSchema>;
