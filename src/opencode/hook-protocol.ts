import * as z from 'zod/v4';
import { findSecretInValue } from '../memory/secrets.js';
import { PACKAGE_VERSION } from '../package-version.js';
import { KiokukoError } from '../errors.js';

export const OPENCODE_HOOK_PROTOCOL_VERSION = 1 as const;
export const OPENCODE_HOOK_MAX_TEXT_LENGTH = 64 * 1024;

const boundedText = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value.trim() === value)
  .refine((value) => !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u206f]/u.test(value));

const boundedMultilineText = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value.trim() === value)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u206f]/u.test(value));

const nullableMultilineText = (maximum: number) => z.union([boundedMultilineText(maximum), z.null()]);
const nullableText = (maximum: number) => z.union([boundedText(maximum), z.null()]);

const hookDirectiveSchema = z.object({}).passthrough();
const hookLeaseSchema = z.object({}).passthrough();

export const openCodeHookRequestSchema = z.object({
  protocolVersion: z.literal(OPENCODE_HOOK_PROTOCOL_VERSION),
  packageVersion: boundedText(100),
  sessionId: boundedText(256),
  terminalMessageId: boundedText(256),
  cwd: boundedText(4_096),
}).strict();

const hookCodeSchema = z.enum([
  'continue',
  'no_active_run',
  'ambiguous_run',
  'continuation_limit',
  'adapter_unavailable',
  'runtime_unavailable',
  'cli_unavailable',
  'spawn_failed',
  'timeout',
  'hook_failed',
  'invalid_response',
  'version_mismatch',
  'unsafe_continuation',
]);

export const openCodeHookResponseSchema = z.object({
  protocolVersion: z.literal(OPENCODE_HOOK_PROTOCOL_VERSION),
  packageVersion: boundedText(100),
  disposition: z.enum(['continue', 'stop', 'retry']),
  code: hookCodeSchema,
  continue: z.boolean(),
  runId: nullableText(256),
  status: nullableText(100),
  directive: z.union([hookDirectiveSchema, z.null()]),
  reason: nullableMultilineText(OPENCODE_HOOK_MAX_TEXT_LENGTH),
  warning: nullableMultilineText(OPENCODE_HOOK_MAX_TEXT_LENGTH),
  resumeToken: nullableText(512),
  routeEpoch: z.union([z.number().int().min(0), z.null()]),
  executionLease: z.union([hookLeaseSchema, z.null()]),
}).strict();

export type OpenCodeHookRequest = z.infer<typeof openCodeHookRequestSchema>;
export type OpenCodeHookResponse = z.infer<typeof openCodeHookResponseSchema>;
export type OpenCodeHookCode = z.infer<typeof hookCodeSchema>;
export type OpenCodeHookResponseParseResult =
  | { ok: true; value: OpenCodeHookResponse }
  | { ok: false; reason: 'invalid_response' | 'version_mismatch' | 'unsafe_continuation' };

export function parseOpenCodeHookRequest(value: unknown): OpenCodeHookRequest {
  const parsed = openCodeHookRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new KiokukoError('VALIDATION_ERROR', 'OpenCode hook request is invalid');
  }
  if (parsed.data.packageVersion !== PACKAGE_VERSION) {
    throw new KiokukoError('CONFLICT', 'OpenCode hook request package version does not match');
  }
  if (findSecretInValue(parsed.data) !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'OpenCode hook request contains secret-shaped data');
  }
  return parsed.data;
}

function responseContractIsConsistent(value: OpenCodeHookResponse): boolean {
  if (value.disposition === 'continue') {
    return value.code === 'continue' && value.continue === true
      && value.runId !== null && value.status !== null && value.directive !== null
      && value.reason !== null && value.warning === null && value.resumeToken !== null
      && value.routeEpoch !== null;
  }
  if (value.continue !== false || value.reason !== null || value.resumeToken !== null || value.executionLease !== null) return false;
  if (value.disposition === 'retry') {
    return ['adapter_unavailable', 'runtime_unavailable', 'cli_unavailable', 'spawn_failed', 'timeout', 'hook_failed']
      .includes(value.code) && value.runId === null && value.status === null
      && value.directive === null && value.routeEpoch === null;
  }
  if (value.code === 'continuation_limit') {
    return value.runId !== null && value.status !== null && value.directive === null && value.routeEpoch !== null;
  }
  if (value.code === 'no_active_run' || value.code === 'ambiguous_run') {
    return value.runId === null && value.status === null && value.directive === null && value.routeEpoch === null;
  }
  return ['invalid_response', 'version_mismatch', 'unsafe_continuation'].includes(value.code)
    && value.runId === null && value.status === null && value.directive === null && value.routeEpoch === null;
}

export function inspectOpenCodeHookResponse(value: unknown): OpenCodeHookResponseParseResult {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.protocolVersion === 'number' && typeof candidate.packageVersion === 'string'
      && (candidate.protocolVersion !== OPENCODE_HOOK_PROTOCOL_VERSION || candidate.packageVersion !== PACKAGE_VERSION)) {
      return { ok: false, reason: 'version_mismatch' };
    }
  }
  const parsed = openCodeHookResponseSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'invalid_response' };
  if (findSecretInValue(parsed.data) !== undefined) return { ok: false, reason: 'unsafe_continuation' };
  if (!responseContractIsConsistent(parsed.data)) return { ok: false, reason: 'invalid_response' };
  return { ok: true, value: parsed.data };
}

export function parseOpenCodeHookResponse(value: unknown): OpenCodeHookResponse | undefined {
  const result = inspectOpenCodeHookResponse(value);
  return result.ok ? result.value : undefined;
}
