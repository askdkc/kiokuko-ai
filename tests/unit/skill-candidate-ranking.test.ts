import assert from 'node:assert/strict';
import test from 'node:test';
import { rankSkillCandidates } from '../../src/skills/candidate-ranking.js';
import type { SkillCandidate, SkillRequirement } from '../../src/skills/types.js';

const requirement: SkillRequirement = {
  id: 'sveltekit', technology: 'sveltekit', aliases: ['sveltekit', 'svelte'], queries: ['sveltekit'], owners: ['sveltejs'], repositories: ['sveltejs/ai-tools'], applicability: {}, signals: {}, reason: 'fixture',
};
const profile = { taskType: 'build' as const, target: 'SvelteKit component', expected: 'tests pass', constraints: null };
function candidate(overrides: Partial<SkillCandidate>): SkillCandidate {
  return { id: 'fixture:id', provider: 'fixture', name: 'helper', slug: 'helper', source: 'other/repo', sourceType: 'github', installUrl: null, installs: 1, duplicate: false, officialStatus: 'unknown', ...overrides };
}

test('official mode ranks catalog and owner matches above unrelated registry rows', () => {
  const ranked = rankSkillCandidates({ mode: 'official', requirement, task: 'Build a SvelteKit component', profile, candidates: [
    candidate({ id: 'unrelated', source: 'other/repo', officialStatus: 'unknown' }),
    candidate({ id: 'owner', source: 'sveltejs/community', officialStatus: 'owner-verified' }),
    candidate({ id: 'catalog', source: 'sveltejs/ai-tools', slug: 'sveltekit', name: 'sveltekit', officialStatus: 'catalog-verified' }),
  ] });
  assert.deepEqual(ranked.map((item) => item.candidate.id), ['catalog', 'owner']);
  assert.ok(ranked[0]!.reasons.includes('exact_repository'));
});

test('community mode keeps duplicate penalty and stable id tie-breaking', () => {
  const ranked = rankSkillCandidates({ mode: 'community', requirement, task: 'Build a SvelteKit component', profile, candidates: [
    candidate({ id: 'b', source: 'community/b', installs: 10 }),
    candidate({ id: 'a', source: 'community/a', installs: 10 }),
    candidate({ id: 'duplicate', source: 'community/duplicate', installs: 100, duplicate: true }),
  ] });
  assert.deepEqual(ranked.map((item) => item.candidate.id), ['a', 'b', 'duplicate']);
  assert.ok(ranked.at(-1)!.score < ranked[0]!.score);
});

test('candidate tie-breaking uses canonical code-unit order instead of host collation', () => {
  const ranked = rankSkillCandidates({ mode: 'community', requirement, task: 'Build a SvelteKit component', profile, candidates: [
    candidate({ id: 'a', source: 'community/a', installs: 10 }),
    candidate({ id: 'Z', source: 'community/z', installs: 10 }),
  ] });
  assert.deepEqual(ranked.map((item) => item.candidate.id), ['Z', 'a']);
});

test('community mode prefers an audited candidate over an otherwise equal row', () => {
  const ranked = rankSkillCandidates({ mode: 'community', requirement, task: 'Build a SvelteKit component', profile, candidates: [
    candidate({ id: 'unaudited', source: 'community/a', installs: 10 }),
    candidate({ id: 'audited', source: 'community/b', installs: 10, auditStatus: 'passed' }),
  ] });
  assert.equal(ranked[0]?.candidate.id, 'audited');
  assert.ok(ranked[0]?.reasons.includes('audit_passed'));
});

test('uses bounded non-technology task tokens without treating generic labels as relevance', () => {
  const ranked = rankSkillCandidates({
    mode: 'community',
    requirement,
    task: 'Add testing coverage for the component',
    profile,
    candidates: [
      candidate({ id: 'generic', name: 'svelte-helper', slug: 'svelte-helper', source: 'community/a', installs: 10 }),
      candidate({ id: 'testing', name: 'svelte-testing', slug: 'svelte-testing', source: 'community/b', installs: 10 }),
    ],
  });
  assert.equal(ranked[0]?.candidate.id, 'testing');
  assert.ok(ranked[0]?.reasons.includes('task_relevance'));
  assert.equal(ranked[1]?.reasons.includes('task_relevance'), false);
});
