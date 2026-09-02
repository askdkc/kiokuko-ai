import { successEnvelope } from '../../serialization/envelope.js';
import type { V1RouteHandler } from '../router.js';
import {
  decodeRunId,
  requireIdempotencyKey,
  requireNoQuery,
  runIdSegment,
  type AgentRouteContext,
} from './agent-runs.js';
import { agentRequestBindingHash } from './request-binding.js';

const CHECKPOINTS_SUFFIX = 'checkpoints';
const FEEDBACK_SUFFIX = 'feedback';

export function createTask5Route(context: AgentRouteContext): V1RouteHandler {
  const checkpoint = context.agentCheckpoint;
  return async (request) => {
    if (request.method === 'POST') {
      const rawCheckpointRunId = runIdSegment(request.url.pathname, CHECKPOINTS_SUFFIX);
      if (rawCheckpointRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawCheckpointRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestBindingHash = agentRequestBindingHash({
          operation: 'agent.checkpoint',
          pathRunId: runId,
          idempotencyKey,
          requestBody: request.body,
        });
        const data = await checkpoint.execute({
          runId,
          idempotencyKey,
          body: request.body,
          requestBindingHash,
        });
        return successEnvelope('agent.checkpoint', data);
      }

      const rawFeedbackRunId = runIdSegment(request.url.pathname, FEEDBACK_SUFFIX);
      if (rawFeedbackRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawFeedbackRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestBindingHash = agentRequestBindingHash({
          operation: 'agent.feedback',
          pathRunId: runId,
          idempotencyKey,
          requestBody: request.body,
        });
        const data = await context.enqueueWrite(() => context.feedbackService.feedback({ runId, idempotencyKey, request: request.body }));
        return successEnvelope('agent.feedback', { ...data, requestBindingHash });
      }
    }

    return undefined;
  };
}

export function task5Operation(method: string, pathname: string): string | undefined {
  if (method !== 'POST') return undefined;
  if (runIdSegment(pathname, CHECKPOINTS_SUFFIX) !== undefined) return 'agent.checkpoint';
  if (runIdSegment(pathname, FEEDBACK_SUFFIX) !== undefined) return 'agent.feedback';
  return undefined;
}
