import { isProxy } from 'node:util/types';
import { KiokukoError } from '../../errors.js';
import { canonicalContentHash } from '../../serialization/validate.js';

export const AGENT_MUTATION_OPERATIONS = [
  'agent.open',
  'agent.answer',
  'agent.events',
  'agent.close',
  'agent.checkpoint',
  'agent.feedback',
] as const;

export type AgentMutationOperation = (typeof AGENT_MUTATION_OPERATIONS)[number];

const BINDING_FIELDS = ['operation', 'pathRunId', 'idempotencyKey', 'requestBody'] as const;

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Agent request binding is invalid');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Hash the exact validated HTTP mutation identity before any durable write begins. */
export function agentRequestBindingHash(value: unknown): string {
  if (!plainObject(value)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== BINDING_FIELDS.length
    || keys.some((key) => typeof key !== 'string' || !BINDING_FIELDS.includes(key as (typeof BINDING_FIELDS)[number]))) {
    invalid();
  }
  for (const field of BINDING_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalid();
  }
  const operation = value.operation;
  const pathRunId = value.pathRunId;
  const idempotencyKey = value.idempotencyKey;
  const requestBody = value.requestBody;
  if (typeof operation !== 'string'
    || !AGENT_MUTATION_OPERATIONS.includes(operation as AgentMutationOperation)
    || pathRunId !== null && (typeof pathRunId !== 'string' || pathRunId.length === 0)
    || idempotencyKey !== null && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)
    || !plainObject(requestBody)) {
    invalid();
  }
  return canonicalContentHash({ operation, pathRunId, idempotencyKey, requestBody });
}
