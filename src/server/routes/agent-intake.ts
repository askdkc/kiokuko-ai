import { successEnvelope } from '../../serialization/envelope.js';
import type { V1RouteHandler } from '../router.js';
import {
  decodeRunId,
  isRunsPath,
  requireIdempotencyKey,
  requireNoQuery,
  runIdSegment,
  type AgentRouteContext,
} from './agent-runs.js';
import { attachCapabilityGatedContext, requestCapabilityCatalog } from './agent-capability-gate.js';
import { agentRequestBindingHash } from './request-binding.js';

const ANSWERS_SUFFIX = 'intake/answers';
const INTAKE_SUFFIX = 'intake';

export function createAgentIntakeRoute(context: AgentRouteContext): V1RouteHandler {
  return async (request) => {
    if (isRunsPath(request.url.pathname)) return undefined;

    if (request.method === 'POST') {
      const rawRunId = runIdSegment(request.url.pathname, ANSWERS_SUFFIX);
      if (rawRunId !== undefined) {
        const runId = decodeRunId(rawRunId);
        requireNoQuery(request.url);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestBindingHash = agentRequestBindingHash({
          operation: 'agent.answer',
          pathRunId: runId,
          idempotencyKey,
          requestBody: request.body,
        });
        const data = await context.enqueueWrite(() => context.service.answerIntake({
          runId,
          idempotencyKey,
          request: request.body,
        }));
        const gated = await attachCapabilityGatedContext(
          context,
          data,
          requestCapabilityCatalog(request.body),
        );
        return successEnvelope('agent.answer', { ...gated, requestBindingHash });
      }
    }

    if (request.method === 'GET') {
      const rawRunId = runIdSegment(request.url.pathname, INTAKE_SUFFIX);
      if (rawRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawRunId);
        return successEnvelope('agent.intake.read', context.service.readIntake({ runId }));
      }
    }

    return undefined;
  };
}

export function agentIntakeOperation(method: string, pathname: string): string | undefined {
  if (method === 'POST' && runIdSegment(pathname, ANSWERS_SUFFIX) !== undefined) return 'agent.answer';
  if (method === 'GET' && runIdSegment(pathname, INTAKE_SUFFIX) !== undefined) return 'agent.intake.read';
  return undefined;
}
