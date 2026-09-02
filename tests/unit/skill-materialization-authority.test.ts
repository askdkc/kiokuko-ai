import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeSkillMaterialization, claimSkillMaterializationAuthorization } from '../../src/skills/materialization-authority.js';
import { SkillProviderError } from '../../src/skills/providers/schema.js';
import type { SkillCandidate, SkillRegistryProvider } from '../../src/skills/types.js';

const candidate: SkillCandidate = {
  id: 'fixture:community/tools:svelte-helper',
  provider: 'fixture',
  name: 'svelte-helper',
  slug: 'svelte-helper',
  source: 'community/tools',
  sourceType: 'github',
  installUrl: 'https://github.com/community/tools',
  installs: 1,
  duplicate: false,
  officialStatus: 'registry-only',
  auditStatus: 'passed',
};

function provider(audit: SkillRegistryProvider['audit']): SkillRegistryProvider {
  return {
    id: candidate.provider,
    async search() { return { provider: candidate.provider, experimental: false, candidates: [] }; },
    ...(audit === undefined ? {} : { audit }),
  };
}

test('provider audit mints an exact runtime grant without receiving persisted audit status', async () => {
  let audited: SkillCandidate | undefined;
  const result = await authorizeSkillMaterialization(provider(async (value) => {
    audited = value;
    return { status: 'passed' };
  }), candidate);
  assert.equal(result.status, 'passed');
  assert.equal(audited?.auditStatus, undefined);
  assert.equal(Object.isFrozen(audited), true);
  if (result.status !== 'passed') throw new Error('expected passed authority');

  assert.throws(
    () => claimSkillMaterializationAuthorization({ ...result.candidate, slug: 'other', id: 'fixture:community/tools:other' }, result.authorization),
    (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION',
  );
  assert.throws(
    () => claimSkillMaterializationAuthorization({ ...result.candidate, provider: 'other-provider', id: 'other-provider:community/tools:svelte-helper' }, result.authorization),
    (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION',
  );
  assert.equal(claimSkillMaterializationAuthorization(result.candidate, result.authorization).auditStatus, 'passed');
  assert.throws(
    () => claimSkillMaterializationAuthorization(result.candidate, result.authorization),
    (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION',
    'the process-local grant is one-shot',
  );
});

test('a structural lookalike and a passed candidate label cannot forge runtime authority', () => {
  assert.throws(
    () => claimSkillMaterializationAuthorization(candidate, Object.freeze({}) as never),
    (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION',
  );
  assert.throws(
    () => claimSkillMaterializationAuthorization(candidate, undefined),
    (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION',
  );
});

test('malformed provider audit output fails closed without issuing authority', async () => {
  await assert.rejects(
    () => authorizeSkillMaterialization(provider(async () => ({ status: 'passed', extra: true }) as never), candidate),
    (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response',
  );
});

test('normalizes a transport-local candidate id before auditing and binding authority', async () => {
  let auditedId: string | undefined;
  const result = await authorizeSkillMaterialization(provider(async (value) => {
    auditedId = value.id;
    return { status: 'passed' };
  }), { ...candidate, id: 'github:community/tools:svelte-helper' });
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') throw new Error('expected passed authority');
  assert.equal(auditedId, candidate.id);
  assert.equal(result.candidate.id, candidate.id);
  assert.equal(claimSkillMaterializationAuthorization(result.candidate, result.authorization).auditStatus, 'passed');
});

test('a different provider cannot audit or mint authority for the candidate', async () => {
  let auditCalls = 0;
  await assert.rejects(
    () => authorizeSkillMaterialization({
      id: 'other-provider',
      async search() { return { provider: 'other-provider', experimental: false, candidates: [] }; },
      async audit() { auditCalls += 1; return { status: 'passed' }; },
    }, candidate),
    (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION',
  );
  assert.equal(auditCalls, 0);
});

test('provider audit cannot mutate any authority-bound candidate identity', async () => {
  const mutations: Array<{ field: keyof SkillCandidate; value: unknown }> = [
    { field: 'id', value: 'fixture:community/tools:other' },
    { field: 'provider', value: 'other-provider' },
    { field: 'sourceType', value: 'other-source-type' },
    { field: 'source', value: 'other/repository' },
    { field: 'slug', value: 'other-skill' },
    { field: 'installUrl', value: 'https://github.com/other/repository' },
  ];
  for (const mutation of mutations) {
    let auditReturned = false;
    await assert.rejects(
      () => authorizeSkillMaterialization(provider(async (value) => {
        assert.equal(Object.isFrozen(value), true);
        await Promise.resolve();
        (value as unknown as Record<string, unknown>)[mutation.field] = mutation.value;
        auditReturned = true;
        return { status: 'passed' };
      }), candidate),
      (error: unknown) => error instanceof TypeError,
      mutation.field,
    );
    assert.equal(auditReturned, false, mutation.field);
    assert.throws(
      () => claimSkillMaterializationAuthorization(candidate, undefined),
      (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION',
      `${mutation.field} mutation must not leave claimable authority`,
    );
  }
});

test('exact reviewed catalog identity is independently authorized and rejects an unnecessary grant', async () => {
  const catalog: SkillCandidate = {
    ...candidate,
    id: 'fixture:sveltejs/ai-tools:svelte-code-writer',
    source: 'sveltejs/ai-tools',
    slug: 'svelte-code-writer',
    name: 'svelte-code-writer',
    installUrl: 'https://github.com/sveltejs/ai-tools',
  };
  let auditCalls = 0;
  const result = await authorizeSkillMaterialization(provider(async () => { auditCalls += 1; return { status: 'passed' }; }), catalog);
  assert.equal(result.status, 'not-required');
  assert.equal(auditCalls, 0);
  assert.equal(claimSkillMaterializationAuthorization(result.candidate, undefined).auditStatus, 'not-required');
});
