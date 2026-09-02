import { isProxy } from 'node:util/types';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readRunIntakeLink } from '../akinator/store.js';
import { LedgerStore } from '../ledger/store.js';
import { validateTimestamp } from '../ledger/validate.js';
import type { JsonValue } from '../ledger/types.js';
import { executeIdempotentInTransaction } from '../server/idempotency.js';
import type { Recommendation } from '../context/recommendations.js';
import type { DeliveredNudge } from '../context/nudges.js';
import {
  recordContextFeedbackInTransaction,
  recordIntakeFeedbackInTransaction,
  recordRunFeedbackInTransaction,
  validateFeedbackTimestamp,
} from '../context/feedback.js';
import { CheckpointMutationService, type CheckpointMutationResult } from './checkpoint-mutation-service.js';
import { NudgeDeliveryService, type ValidatedNudgeDeliveryRequest } from './nudge-delivery-service.js';

export { CheckpointMutationService } from './checkpoint-mutation-service.js';
export type { CheckpointMutationResult } from './checkpoint-mutation-service.js';
export { NudgeDeliveryService } from './nudge-delivery-service.js';
export type { ValidatedNudgeDeliveryRequest } from './nudge-delivery-service.js';

export interface CheckpointResponse extends Omit<CheckpointMutationResult, 'preliminaryRecommendations'> {
  readonly recommendations: readonly Recommendation[];
  readonly nudge: DeliveredNudge | null;
  readonly context: null;
  readonly untrusted: true;
}

function validation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Invalid gateway request');
}

function assertPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) validation();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) validation();
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /\p{Cc}/u.test(value)) validation();
  return value;
}

export class CheckpointService {
  private readonly mutation: CheckpointMutationService;
  private readonly nudgeDelivery: NudgeDeliveryService;

  constructor(database: SqliteDatabase, now: () => string = () => new Date().toISOString()) {
    this.mutation = new CheckpointMutationService(database, now);
    this.nudgeDelivery = new NudgeDeliveryService(database, now);
  }

  checkpoint(input: unknown): CheckpointResponse {
    const result = this.mutation.checkpoint(input);
    const { preliminaryRecommendations: _preliminaryRecommendations, ...mutation } = result;
    return {
      ...mutation,
      recommendations: [...result.preliminaryRecommendations],
      nudge: null,
      context: null,
      untrusted: true,
    };
  }

  deliverNudge(input: ValidatedNudgeDeliveryRequest): DeliveredNudge | null {
    return this.nudgeDelivery.deliver(input);
  }
}

export interface FeedbackResponse {
  category: 'context' | 'recommendation' | 'intake' | 'run';
  record: unknown;
  untrusted: true;
}

function feedbackRequest(raw: unknown): Record<string, unknown> {
  const input = assertPlainObject(raw);
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') validation();
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) validation();
    value[key] = descriptor.value;
  }
  if (value.apiVersion !== '1' || typeof value.category !== 'string' || !['context', 'recommendation', 'intake', 'run'].includes(value.category)) validation();
  const categoryFields = value.category === 'context'
    ? ['deliveryId', 'entryId', 'verdict']
    : value.category === 'intake'
      ? ['sessionId', 'questionId', 'profileField', 'verdict']
      : ['outcome', 'recommendationCode', 'recommendationVerdict', 'rating'];
  const allowed = new Set(['apiVersion', 'category', 'feedbackId', 'actor', 'createdAt', 'comment', ...categoryFields]);
  if (keys.some((field) => typeof field !== 'string' || !allowed.has(field))) validation();
  if (Object.hasOwn(value, 'createdAt')) validateFeedbackTimestamp(value.createdAt);
  if (value.category === 'intake' && Object.hasOwn(value, 'sessionId')) boundedString(value.sessionId, 256);
  return value;
}

function feedbackField(value: Record<string, unknown>, field: string): unknown {
  return Object.hasOwn(value, field) ? value[field] : undefined;
}

function feedbackValue(database: SqliteDatabase, runId: string, key: string, value: Record<string, unknown>, now: string): FeedbackResponse {
  const run = new LedgerStore(database).readRun(runId);
  if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
  const category = value.category as FeedbackResponse['category'];
  const actor = Object.hasOwn(value, 'actor') ? boundedString(value.actor) : 'kiokuko-feedback';
  const feedbackId = boundedString(value.feedbackId, 256);
  const createdAt = Object.hasOwn(value, 'createdAt') ? validateFeedbackTimestamp(value.createdAt) : now;
  const common = { workspace: run.workspace, feedbackId, actor, createdAt, idempotencyKey: key };
  let record: unknown;
  if (category === 'context') {
    record = recordContextFeedbackInTransaction(database, {
      ...common,
      deliveryId: boundedString(feedbackField(value, 'deliveryId'), 256),
      entryId: boundedString(feedbackField(value, 'entryId'), 256),
      runId,
      verdict: feedbackField(value, 'verdict'),
      ...(feedbackField(value, 'comment') === undefined ? {} : { comment: feedbackField(value, 'comment') }),
    });
  } else if (category === 'intake') {
    const link = readRunIntakeLink(database, { workspace: run.workspace, runId });
    record = recordIntakeFeedbackInTransaction(database, {
      ...common,
      runId,
      sessionId: Object.hasOwn(value, 'sessionId') ? boundedString(value.sessionId, 256) : link.sessionId,
      questionId: value.questionId ?? null,
      profileField: value.profileField ?? null,
      verdict: feedbackField(value, 'verdict'),
      comment: value.comment ?? null,
    });
  } else {
    record = recordRunFeedbackInTransaction(database, {
      ...common,
      runId,
      outcome: value.outcome ?? null,
      recommendationCode: value.recommendationCode ?? null,
      recommendationVerdict: value.recommendationVerdict ?? null,
      rating: value.rating ?? null,
      comment: value.comment ?? null,
    });
  }
  return { category, record, untrusted: true };
}

export class FeedbackService {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  feedback(input: unknown): FeedbackResponse {
    const value = assertPlainObject(input);
    if (typeof value.runId !== 'string' || value.runId.length === 0 || typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length === 0) validation();
    const run = new LedgerStore(this.database).readRun(value.runId);
    if (!run) throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
    const now = validateTimestamp(this.now(), 'createdAt');
    const request = feedbackRequest(value.request);
    return withImmediateTransaction(this.database, () => executeIdempotentInTransaction(
      this.database,
      { scope: `agent.feedback.${value.runId}`, key: value.idempotencyKey, request, createdAt: now },
      () => feedbackValue(this.database, value.runId as string, value.idempotencyKey as string, request, now) as unknown as JsonValue,
    ) as unknown as FeedbackResponse);
  }
}
