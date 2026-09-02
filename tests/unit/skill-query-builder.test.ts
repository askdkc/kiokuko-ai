import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSkillQueries, validateSkillOwner, validateSkillQuery, validateSkillSearchScope } from '../../src/skills/query-builder.js';

const svelteRequirement = {
  id: 'svelte',
  technology: 'svelte',
  aliases: ['svelte'],
  queries: ['svelte'],
  owners: ['sveltejs'],
  repositories: ['sveltejs/ai-tools'],
  applicability: {},
  signals: {},
  reason: 'fixture',
};

test('builds bounded technology-only queries', () => {
  const queries = buildSkillQueries({
    requirements: [svelteRequirement],
    profile: { taskType: 'build', target: '/private/customer/repo', expected: 'tests pass', constraints: null },
  });
  assert.deepEqual(queries, ['svelte', 'svelte testing']);
  assert.equal(queries.some((query) => query.includes('customer') || query.includes('private')), false);
});

test('revalidates requirement provenance instead of forwarding supplied query fields', () => {
  assert.throws(() => buildSkillQueries({ requirements: [{ ...svelteRequirement, queries: ['customer repository'] }] }), /official catalog/iu);
  assert.throws(() => buildSkillQueries({ requirements: [{ ...svelteRequirement, owners: ['facebook'] }] }), /official catalog/iu);
  assert.throws(() => buildSkillQueries({ requirements: [{ ...svelteRequirement, repositories: ['customer/internal'] }] }), /official catalog/iu);
  assert.throws(() => buildSkillQueries({ requirements: [{ ...svelteRequirement, technology: 'react' }] }), /official catalog/iu);
});

test('requires query and owner to come from the same catalog definition', () => {
  assert.deepEqual(validateSkillSearchScope('sveltekit', 'sveltejs'), { query: 'sveltekit', owner: 'sveltejs' });
  assert.throws(() => validateSkillSearchScope('svelte', 'facebook'), /invalid for the query/iu);
});

test('rejects path, secret, and oversized registry queries', () => {
  assert.throws(() => validateSkillQuery('../private'), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
  assert.throws(() => validateSkillQuery('api token'), /invalid/iu);
  assert.throws(() => validateSkillQuery('x'.repeat(81)), /invalid/iu);
});

test('rejects known credential formats before query normalization', () => {
  assert.throws(() => validateSkillQuery(`ghp_${'x'.repeat(24)}`), (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION');
  assert.throws(() => validateSkillQuery(`AKIA${'A'.repeat(16)}`), (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION');
  assert.throws(() => validateSkillQuery(['api-key', '=', 'x'.repeat(20)].join('')), (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION');
  assert.throws(() => validateSkillOwner(`owner-${'x'.repeat(101)}`), /invalid/iu);
  assert.throws(() => validateSkillOwner(`ghp_${'x'.repeat(24)}`), (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION');
});
