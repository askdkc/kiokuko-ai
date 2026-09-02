import { createHash } from 'node:crypto';
import { withImmediateTransaction } from '../../db/transaction.js';
import { KiokukoError } from '../../errors.js';
import { executeIdempotentInTransaction } from '../idempotency.js';
import type { JsonValue } from '../../ledger/types.js';
import { promoteLedgerProposalInTransaction } from '../../ledger/promotion.js';
import { successEnvelope } from '../../serialization/envelope.js';
import type { V1RouteHandler } from '../router.js';
import {
  decodeRunId,
  requireIdempotencyKey,
  requireNoQuery,
  runIdSegment,
  type AgentRouteContext,
} from './agent-runs.js';

const PROMOTIONS_SUFFIX = 'promotions';
const PROMOTION_FIELDS = new Set(['apiVersion', 'proposalEventId', 'deliveryId', 'actor', 'createdAt', 'confirmed']);

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Request is invalid');
}

function promotionBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((field) => !PROMOTION_FIELDS.has(field))) invalid();
  if (body.apiVersion !== '1') invalid();
  const { apiVersion: _apiVersion, ...promotion } = body;
  return promotion;
}

function promotionScope(runId: string): string {
  return `agent.promotions.${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`;
}

export function createAgentPromotionsRoute(context: AgentRouteContext): V1RouteHandler {
  return async (request) => {
    const rawRunId = runIdSegment(request.url.pathname, PROMOTIONS_SUFFIX);
    if (rawRunId === undefined || request.method !== 'POST') return undefined;
    requireNoQuery(request.url);
    const runId = decodeRunId(rawRunId);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = promotionBody(request.body);
    const data = await context.enqueueWrite(() => {
      const run = context.service.readRun({ runId });
      return withImmediateTransaction(context.database, () => executeIdempotentInTransaction(
        context.database,
        {
          scope: promotionScope(runId),
          key: idempotencyKey,
          request: { runId, body },
          createdAt: new Date().toISOString(),
        },
        () => promoteLedgerProposalInTransaction(context.database, {
          ...body,
          workspace: run.workspace,
          runId,
        }) as unknown as JsonValue,
      ));
    });
    return successEnvelope('agent.promotions', data);
  };
}

export function agentPromotionsOperation(method: string, pathname: string): string | undefined {
  return method === 'POST' && runIdSegment(pathname, PROMOTIONS_SUFFIX) !== undefined ? 'agent.promotions' : undefined;
}
