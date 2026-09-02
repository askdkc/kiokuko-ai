import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURATOR_DRAFT_VERSION,
  CURATOR_MEMORY_ACTOR,
  isTrustedCuratorGlobalMemory,
} from '../../src/memory/curator-trust.js';

type CuratorTrustInput = Parameters<typeof isTrustedCuratorGlobalMemory>[0];

function managedCuratorMemory(): CuratorTrustInput {
  const createdAt = '2026-08-26T00:00:00.000Z';
  return {
    workspace: 'global',
    status: 'verified',
    scope: { schemaVersion: 1, visibility: 'global', retrievalScope: 'global' },
    provenance: {
      type: 'curator_globalize',
      reference: `source-entry@1#${CURATOR_DRAFT_VERSION}`,
      sourceWorkspace: 'project:source',
      clientKind: CURATOR_MEMORY_ACTOR,
      timestamp: createdAt,
    },
    trustLevel: 'system_verified',
    revision: 1,
    verifiedAt: '2026-08-26T00:00:00.000Z',
    createdBy: CURATOR_MEMORY_ACTOR,
    createdAt,
    updatedAt: createdAt,
    tags: [`curator:${CURATOR_DRAFT_VERSION}`, 'global', 'skill:curated'],
  };
}

test('recognizes only the complete deterministic Curator global identity without mutating it', () => {
  const memory = managedCuratorMemory();
  const snapshot = structuredClone(memory);

  assert.equal(isTrustedCuratorGlobalMemory(memory), true);
  assert.deepEqual(memory, snapshot);
  assert.equal(isTrustedCuratorGlobalMemory({ ...memory, createdBy: 'forged-client' }), false);
  assert.equal(isTrustedCuratorGlobalMemory({ ...memory, provenance: { ...memory.provenance, type: 'manual' } }), false);
  assert.equal(isTrustedCuratorGlobalMemory({ ...memory, scope: { ...memory.scope, schemaVersion: 99 } }), false);
  assert.equal(isTrustedCuratorGlobalMemory({ ...memory, revision: 2 }), false);
  assert.equal(isTrustedCuratorGlobalMemory({ ...memory, tags: ['global'] }), false);
  assert.equal(isTrustedCuratorGlobalMemory({ ...memory, status: 'candidate', trustLevel: 'untrusted', verifiedAt: null }), false);
  assert.equal(isTrustedCuratorGlobalMemory({ ...memory, status: 'candidate', trustLevel: 'untrusted', verifiedAt: null }), false);
});
