import { successEnvelope } from '../../serialization/envelope.js';
import type { V1RouteHandler } from '../router.js';
import {
  decodeRunId,
  decimalQuery,
  queryParameters,
  requireIdempotencyKey,
  requireNoQuery,
  runIdSegment,
  type AgentRouteContext,
} from './agent-runs.js';
import { agentRequestBindingHash } from './request-binding.js';

const EVENTS_SUFFIX = 'events';

export function createAgentEventsRoute(context: AgentRouteContext): V1RouteHandler {
  return async (request) => {
    const rawRunId = runIdSegment(request.url.pathname, EVENTS_SUFFIX);
    if (rawRunId === undefined || (request.method !== 'POST' && request.method !== 'GET')) return undefined;
    const runId = decodeRunId(rawRunId);

    if (request.method === 'POST') {
      requireNoQuery(request.url);
      const idempotencyKey = requireIdempotencyKey(request);
      const requestBindingHash = agentRequestBindingHash({
        operation: 'agent.events',
        pathRunId: runId,
        idempotencyKey,
        requestBody: request.body,
      });
      const data = await context.enqueueWrite(() => context.service.appendEvents({
        runId,
        idempotencyKey,
        request: request.body,
      }));
      return successEnvelope('agent.events', { ...data, requestBindingHash });
    }

    if (request.method === 'GET') {
      const values = queryParameters(request.url, ['after', 'type', 'limit']);
      const input: Record<string, unknown> = { runId };
      const type = values.get('type');
      if (type !== undefined) input.type = type;
      const after = decimalQuery(values, 'after');
      if (after !== undefined) input.after = after;
      const limit = decimalQuery(values, 'limit');
      if (limit !== undefined) input.limit = limit;
      return successEnvelope('agent.events.list', context.service.listEvents(input));
    }

    return undefined;
  };
}

export function agentEventsOperation(method: string, pathname: string): string | undefined {
  if (runIdSegment(pathname, EVENTS_SUFFIX) === undefined) return undefined;
  if (method === 'POST') return 'agent.events';
  if (method === 'GET') return 'agent.events.list';
  return undefined;
}
