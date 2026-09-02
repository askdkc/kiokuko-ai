import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { agentRequestBindingHash } from '../../src/server/routes/request-binding.js';

const binding = {
  operation: 'agent.checkpoint' as const,
  pathRunId: 'run-binding',
  idempotencyKey: 'binding-key',
  requestBody: {
    apiVersion: '1',
    capabilities: [{ kind: 'skill', name: 'memory-reasoning' }],
    currentGoal: 'verify request binding',
  },
};

test('hashes exactly the canonical four-field Agent request binding', () => {
  assert.equal(agentRequestBindingHash(binding), canonicalContentHash(binding));
  assert.equal(agentRequestBindingHash({
    requestBody: {
      currentGoal: 'verify request binding',
      capabilities: [{ name: 'memory-reasoning', kind: 'skill' }],
      apiVersion: '1',
    },
    idempotencyKey: 'binding-key',
    pathRunId: 'run-binding',
    operation: 'agent.checkpoint',
  }), canonicalContentHash(binding));
});

test('binds operation, path run, idempotency key, and the complete request body independently', () => {
  const baseline = agentRequestBindingHash(binding);
  const variants = [
    { ...binding, operation: 'agent.feedback' as const },
    { ...binding, pathRunId: 'other-run' },
    { ...binding, idempotencyKey: 'other-key' },
    { ...binding, requestBody: { ...binding.requestBody, currentGoal: 'changed' } },
  ];
  for (const variant of variants) assert.notEqual(agentRequestBindingHash(variant), baseline);
});

test('rejects partial, extended, and accessor-backed request bindings', () => {
  const accessor = { ...binding } as Record<string, unknown>;
  Object.defineProperty(accessor, 'operation', { enumerable: true, get: () => 'agent.checkpoint' });
  const invalid = [
    { operation: binding.operation, pathRunId: binding.pathRunId, idempotencyKey: binding.idempotencyKey },
    { ...binding, requestHash: 'unexpected' },
    { ...binding, operation: 'checkpoint' },
    { ...binding, pathRunId: undefined },
    { ...binding, idempotencyKey: '' },
    { ...binding, requestBody: [] },
    accessor,
    Object.assign(Object.create({ inherited: true }), binding),
  ];
  for (const value of invalid) {
    assert.throws(
      () => agentRequestBindingHash(value),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'VALIDATION_ERROR'
        && error.message === 'Agent request binding is invalid',
    );
  }
});
