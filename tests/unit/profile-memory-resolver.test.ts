import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMemoryResolution, parseProfileHintSnapshot, readProbeMode, runtimeProbeConfig } from '../../src/akinator/memory-probe-types.js';
import { resolveProfileTarget } from '../../src/akinator/profile-memory-resolver.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import type { ProfileDocument } from '../../src/akinator/profile-memory-store.js';

const profile = { taskType: 'build' as const, target: null, expected: null, constraints: null };
const ref = { runId: 'r', sessionId: 's', workspace: 'project:p', repositoryId: 'repo_p', profileHash: 'a'.repeat(64), sourcesHash: 'b'.repeat(64), score: 100 };
const document: ProfileDocument = { evidence: ref, sources: { target: 'user_answer' }, completed: true, targetOriginVerified: true,
  session: { id: 's', workspace: 'project:p', task: 'previous', profile: { ...profile, target: 'src/a.ts', expected: 'old' }, status: 'ready', questionCount: 1, createdAt: '', updatedAt: '' } };

test('configuration defaults off and invalid settings degrade only at the runtime boundary', () => {
  assert.equal(readProbeMode({}), 'off');
  for (const mode of ['off', 'shadow', 'suggest', 'resolve']) assert.equal(readProbeMode({ KIOKUKO_AKINATOR_MEMORY_MODE: mode }), mode);
  assert.throws(() => readProbeMode({ KIOKUKO_AKINATOR_MEMORY_MODE: 'yes' }), { code: 'VALIDATION_ERROR' });
  assert.deepEqual(runtimeProbeConfig({ KIOKUKO_AKINATOR_MEMORY_MODE: 'yes' }), { mode: 'off', warning: true });
});

test('score alone cannot adopt, incomplete results and existing fields remain unchanged', () => {
  const input = { profile, candidates: [document], verifiedTargets: new Set(['src/a.ts']), complete: true };
  assert.equal(resolveProfileTarget(input), document);
  assert.equal(resolveProfileTarget({ ...input, verifiedTargets: new Set() }), undefined);
  assert.equal(resolveProfileTarget({ ...input, complete: false }), undefined);
  assert.equal(resolveProfileTarget({ ...input, profile: { ...profile, target: 'other' } }), undefined);
  assert.equal(resolveProfileTarget({ ...input, candidates: [{ ...document, sources: { target: 'memory' } }] }), undefined);
  assert.equal(resolveProfileTarget({ ...input, candidates: [{ ...document, targetOriginVerified: false }] }), undefined);
  assert.equal(profile.target, null);
});

test('resolution and hint boundaries reject unknown fields, unlimited lists and non-finite scores', () => {
  const hash = canonicalContentHash(profile);
  const resolution = { policyVersion: 'profile-memory-v1', mode: 'resolve', status: 'complete', coverage: 'complete',
    baseProfileHash: hash, resultProfileHash: hash, candidates: [ref], adopted: null, scannedCandidates: 1, queryCount: 3, truncated: false };
  assert.equal(parseMemoryResolution(resolution).mode, 'resolve');
  for (const value of [{ ...resolution, unexpected: true }, { ...resolution, candidates: Array(65).fill(ref) },
    { ...resolution, candidates: [{ ...ref, score: Infinity }] }, { ...resolution, adopted: ref, truncated: true }, { ...resolution, adopted: { ...ref, workspace: 'project:other' } },
    { ...resolution, candidates: [ref, ref], scannedCandidates: 2 }]) {
    assert.throws(() => parseMemoryResolution(value), { code: 'INTEGRITY_ERROR' });
  }
  assert.throws(() => parseProfileHintSnapshot({ untrusted: true, status: 'complete', coverage: 'complete', truncated: false, candidates: Array(13).fill({}) }), { code: 'INTEGRITY_ERROR' });
});
