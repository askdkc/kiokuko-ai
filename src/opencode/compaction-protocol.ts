import * as z from 'zod/v4';
import { PACKAGE_VERSION } from '../package-version.js';
import { KiokukoError } from '../errors.js';
import { OPENCODE_HOOK_PROTOCOL_VERSION } from './hook-protocol.js';

const boundedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const digest = z.string().regex(/^[0-9a-f]{64}$/u);

const boundarySchema = z.object({
  runId: boundedText(256),
  workspace: boundedText(256),
  orchestrationId: boundedText(256),
  contractRevision: z.number().int().min(0).nullable(),
  contextRevision: z.number().int().min(0).nullable(),
  routeEpoch: z.number().int().min(0).nullable(),
  terminalMessageId: boundedText(256).nullable().optional(),
}).strict();

export const compactionHookRequestSchema = z.discriminatedUnion('phase', [
  z.object({
    protocolVersion: z.literal(OPENCODE_HOOK_PROTOCOL_VERSION),
    packageVersion: boundedText(100),
    phase: z.literal('before'),
    sessionId: boundedText(256),
    cwd: boundedText(4_096),
    boundary: boundarySchema,
  }).strict(),
  z.object({
    protocolVersion: z.literal(OPENCODE_HOOK_PROTOCOL_VERSION),
    packageVersion: boundedText(100),
    phase: z.literal('after'),
    sessionId: boundedText(256),
    cwd: boundedText(4_096),
    runId: boundedText(256).nullable().optional(),
    summaryMessageId: boundedText(256),
    summaryText: z.string().min(1).max(64 * 1024),
    summaryDigest: digest,
  }).strict(),
]);

export type CompactionHookRequest = z.infer<typeof compactionHookRequestSchema>;

export function parseCompactionHookRequest(value: unknown): CompactionHookRequest {
  const parsed = compactionHookRequestSchema.safeParse(value);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Compaction hook request is invalid');
  if (parsed.data.packageVersion !== PACKAGE_VERSION) {
    throw new KiokukoError('CONFLICT', 'Compaction hook package version does not match');
  }
  return parsed.data;
}
