import { KiokukoError } from '../../errors.js';
import { successEnvelope } from '../../serialization/envelope.js';
import type { AgentGatewayService } from '../../gateway/agent-service.js';
import type { FeedbackService } from '../../gateway/checkpoint-service.js';
import type { ContextBroker } from '../../context/broker.js';
import type { AgentCheckpointUseCase } from '../agent-checkpoint-use-case.js';
import type { V1RouteHandler, V1RouteRequest } from '../router.js';
import { attachCapabilityGatedContext, requestCapabilityCatalog } from './agent-capability-gate.js';
import { agentRequestBindingHash } from './request-binding.js';

const RUNS_PATH = '/api/v1/agent/runs';
const CONTROL_CHARACTERS = /\p{Cc}/u;
const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_ID_LENGTH = 256;

type QueryField = 'workspace' | 'client' | 'status' | 'cursor' | 'limit' | 'after' | 'type';

export type AgentRouteContext = {
  readonly database: import('../../db/adapter.js').SqliteDatabase;
  readonly service: AgentGatewayService;
  readonly feedbackService: FeedbackService;
  readonly broker: ContextBroker;
  readonly enqueueWrite: <T>(operation: () => T | PromiseLike<T>) => Promise<T>;
  readonly agentCheckpoint: AgentCheckpointUseCase;
};

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Request is invalid');
}

export function queryParameters(url: URL, allowed: readonly QueryField[]): Map<QueryField, string> {
  const allowedSet = new Set<string>(allowed);
  const values = new Map<QueryField, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowedSet.has(key) || values.has(key as QueryField)) invalid();
    values.set(key as QueryField, value);
  }
  return values;
}

export function requireNoQuery(url: URL): void {
  if (url.search.length > 0) invalid();
}

export function decimalQuery(values: ReadonlyMap<QueryField, string>, field: 'limit' | 'after'): number | undefined {
  const value = values.get(field);
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

export function decodeRunId(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    invalid();
  }
  if (decoded.length === 0 || decoded.length > MAX_ID_LENGTH || decoded.includes('/') || decoded.includes('\\') || CONTROL_CHARACTERS.test(decoded)) {
    invalid();
  }
  return decoded;
}

export function runIdSegment(pathname: string, suffix?: string): string | undefined {
  const prefix = `${RUNS_PATH}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (suffix !== undefined) {
    const marker = `/${suffix}`;
    if (!rest.endsWith(marker)) return undefined;
    const raw = rest.slice(0, -marker.length);
    if (raw.includes('/')) return undefined;
    return raw;
  }
  if (rest.includes('/')) return undefined;
  return rest;
}

export function requireIdempotencyKey(request: V1RouteRequest): string {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value) || typeof value !== 'string' || value.trim().length === 0 || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES || CONTROL_CHARACTERS.test(value)) {
    invalid();
  }
  const rawHeaders = request.rawHeaders;
  if (rawHeaders !== undefined) {
    let occurrences = 0;
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === 'idempotency-key') occurrences += 1;
    }
    if (occurrences !== 1) invalid();
  }
  return value;
}

export function isRunsPath(pathname: string): boolean {
  return pathname === RUNS_PATH;
}

export function createAgentRunsRoute(context: AgentRouteContext): V1RouteHandler {
  return async (request) => {
    if (request.method === 'POST' && isRunsPath(request.url.pathname)) {
      requireNoQuery(request.url);
      const idempotencyKey = requireIdempotencyKey(request);
      const requestBindingHash = agentRequestBindingHash({
        operation: 'agent.open',
        pathRunId: null,
        idempotencyKey,
        requestBody: request.body,
      });
      const data = await context.enqueueWrite(() => context.service.openRun({
        idempotencyKey,
        request: request.body,
      }));
      const gated = await attachCapabilityGatedContext(
        context,
        data,
        requestCapabilityCatalog(request.body),
      );
      return successEnvelope('agent.open', { ...gated, requestBindingHash });
    }

    if (request.method === 'GET' && isRunsPath(request.url.pathname)) {
      const values = queryParameters(request.url, ['workspace', 'client', 'status', 'cursor', 'limit']);
      const workspace = values.get('workspace');
      if (workspace === undefined || workspace.length === 0) invalid();
      const input: Record<string, unknown> = { workspace };
      for (const field of ['client', 'status', 'cursor'] as const) {
        const value = values.get(field);
        if (value !== undefined) input[field] = value;
      }
      const limit = decimalQuery(values, 'limit');
      if (limit !== undefined) input.limit = limit;
      return successEnvelope('agent.runs.list', context.service.listRuns(input));
    }

    if (request.method === 'POST') {
      const rawRunId = runIdSegment(request.url.pathname, 'close');
      if (rawRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestBindingHash = agentRequestBindingHash({
          operation: 'agent.close',
          pathRunId: runId,
          idempotencyKey,
          requestBody: request.body,
        });
        const data = await context.enqueueWrite(() => context.service.closeRun({
          runId,
          idempotencyKey,
          request: request.body,
        }));
        return successEnvelope('agent.close', { ...data, requestBindingHash });
      }
    }

    if (request.method === 'GET') {
      const rawRunId = runIdSegment(request.url.pathname);
      if (rawRunId !== undefined) {
        requireNoQuery(request.url);
        return successEnvelope('agent.run.read', context.service.readRun({ runId: decodeRunId(rawRunId) }));
      }
    }

    return undefined;
  };
}

export function agentRunsOperation(method: string, pathname: string): string | undefined {
  if (method === 'POST' && isRunsPath(pathname)) return 'agent.open';
  if (method === 'GET' && isRunsPath(pathname)) return 'agent.runs.list';
  if (method === 'POST' && runIdSegment(pathname, 'close') !== undefined) return 'agent.close';
  if (method === 'GET' && runIdSegment(pathname) !== undefined) return 'agent.run.read';
  return undefined;
}

export { RUNS_PATH };
