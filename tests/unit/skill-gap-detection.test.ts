import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSkillGap } from '../../src/skills/gap-detection.js';
import { OFFICIAL_SKILL_REPOSITORIES, requirementsFromFingerprint, technologyDefinition } from '../../src/skills/official-catalog.js';

const fingerprint = {
  repositoryId: 'repo-test', languages: ['JavaScript'], frameworks: [{ name: 'SvelteKit', version: '2' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: '@sveltejs/kit', version: '2' }], manifestDigest: 'digest',
};
const profile = { taskType: 'build' as const, target: 'SvelteKit app', expected: 'tests pass', constraints: null };

test('detects a missing relevant skill despite an unrelated available skill', () => {
  const decision = detectSkillGap({ fingerprint, task: 'Implement a SvelteKit component', profile, capabilities: [{ kind: 'skill', name: 'kiokuko-ui-design-soul' }], mode: 'official' });
  assert.equal(decision.reason, 'relevant_skill_missing');
  assert.deepEqual(decision.missing.map((item) => item.id), ['sveltekit']);
});

test('accepts an aliased Svelte skill for a SvelteKit requirement', () => {
  const decision = detectSkillGap({ fingerprint, task: 'Implement a SvelteKit component', profile, capabilities: [{ kind: 'skill', name: 'svelte-code-writer' }], mode: 'official' });
  assert.equal(decision.reason, 'all_relevant_skills_available');
  assert.equal(decision.shouldDiscover, false);
});

test('does not infer availability from a generic skill description', () => {
  const decision = detectSkillGap({
    fingerprint,
    task: 'Implement a SvelteKit component',
    profile,
    capabilities: [{ kind: 'skill', name: 'generic-frontend-review', description: 'Supports React, Vue, or Svelte' }],
    mode: 'official',
  });
  assert.equal(decision.reason, 'relevant_skill_missing');
  assert.deepEqual(decision.missing.map((item) => item.id), ['sveltekit']);
});

test('does not treat the Svelte substring inside SvelteKit as a separate task request', () => {
  const result = detectSkillGap({
    fingerprint: {
      repositoryId: 'repo',
      languages: ['JavaScript'],
      frameworks: [{ name: 'SvelteKit', version: '2' }],
      databases: [],
      runtimes: ['Node.js'],
      tools: [],
      packages: [{ name: 'svelte', version: '5' }, { name: '@sveltejs/kit', version: '2' }],
      manifestDigest: 'digest',
    },
    task: 'Build a SvelteKit page',
    profile: { taskType: 'build', target: 'SvelteKit page', expected: 'tests pass', constraints: null },
    capabilities: [],
    mode: 'official',
  });
  assert.deepEqual(result.requirements.map((requirement) => requirement.id), ['sveltekit']);
});

test('keeps official repository trust limited to reviewed Skill sources', () => {
  assert.deepEqual(OFFICIAL_SKILL_REPOSITORIES, ['sveltejs/ai-tools', 'laravel/boost']);
});

test('builds Laravel and React requirements without treating framework source repos as Skills', () => {
  const laravel = detectSkillGap({
    fingerprint: { repositoryId: 'laravel', languages: ['PHP'], frameworks: [{ name: 'Laravel', version: '13' }], databases: [], runtimes: ['PHP'], tools: [], packages: [{ name: 'laravel/framework', version: '13' }], manifestDigest: 'laravel' },
    task: 'Build a Laravel endpoint', profile: { taskType: 'build', target: 'Laravel endpoint', expected: 'tests pass', constraints: null }, capabilities: [], mode: 'official',
  });
  assert.deepEqual(laravel.missing[0]?.repositories, ['laravel/boost']);
  assert.deepEqual(technologyDefinition('laravel')?.reviewedSkills, [{
    slug: 'laravel-best-practices',
    primaryPaths: ['.ai/laravel/skill/laravel-best-practices/SKILL.md'],
  }]);

  const react = detectSkillGap({
    fingerprint: { repositoryId: 'react', languages: ['JavaScript'], frameworks: [{ name: 'React', version: '19' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'react', version: '19' }], manifestDigest: 'react' },
    task: 'Build a React component', profile: { taskType: 'build', target: 'React component', expected: 'tests pass', constraints: null }, capabilities: [], mode: 'official',
  });
  assert.deepEqual(react.missing[0]?.repositories, []);
  assert.deepEqual(react.missing[0]?.owners, ['facebook']);
});

test('does not treat an ambiguous Next or Go name fragment as an available skill', () => {
  const next = detectSkillGap({
    fingerprint: { repositoryId: 'next', languages: ['JavaScript'], frameworks: [{ name: 'Next.js', version: '15' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'next', version: '15' }], manifestDigest: 'next' },
    task: 'Build a Next.js page', profile, capabilities: [{ kind: 'skill', name: 'next-step-planner' }], mode: 'official',
  });
  assert.deepEqual(next.missing.map((requirement) => requirement.id), ['nextjs']);

  const go = detectSkillGap({
    fingerprint: { repositoryId: 'go', languages: ['Go'], frameworks: [], databases: [], runtimes: [], tools: [], packages: [], manifestDigest: 'go' },
    task: 'Build a Go service', profile: { taskType: 'build', target: 'Go service', expected: 'tests pass', constraints: null }, capabilities: [{ kind: 'skill', name: 'go-to-market' }], mode: 'official',
  });
  assert.deepEqual(go.missing.map((requirement) => requirement.id), ['go']);
});

test('does not treat a verified owner or repository identity as a technology skill', () => {
  const react = detectSkillGap({
    fingerprint: { repositoryId: 'react', languages: ['JavaScript'], frameworks: [{ name: 'React', version: '19' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'react', version: '19' }], manifestDigest: 'react' },
    task: 'Build a React component',
    profile: { taskType: 'build', target: 'React component', expected: 'tests pass', constraints: null },
    capabilities: [{ kind: 'skill', name: 'facebook' }],
    mode: 'official',
  });
  assert.deepEqual(react.missing.map((requirement) => requirement.id), ['react']);

  const next = detectSkillGap({
    fingerprint: { repositoryId: 'next', languages: ['JavaScript'], frameworks: [{ name: 'Next.js', version: '15' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'next', version: '15' }], manifestDigest: 'next' },
    task: 'Build a Next.js page',
    profile,
    capabilities: [{ kind: 'skill', name: 'vercel' }],
    mode: 'official',
  });
  assert.deepEqual(next.missing.map((requirement) => requirement.id), ['nextjs']);

  const sveltekit = detectSkillGap({
    fingerprint,
    task: 'Implement a SvelteKit component',
    profile,
    capabilities: [{ kind: 'skill', name: 'sveltejs/ai-tools' }],
    mode: 'official',
  });
  assert.deepEqual(sveltekit.missing.map((requirement) => requirement.id), ['sveltekit']);
});

test('accepts verified owner or repository qualification coupled to a technology alias', () => {
  const react = detectSkillGap({
    fingerprint: { repositoryId: 'react', languages: ['JavaScript'], frameworks: [{ name: 'React', version: '19' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'react', version: '19' }], manifestDigest: 'react' },
    task: 'Build a React component',
    profile: { taskType: 'build', target: 'React component', expected: 'tests pass', constraints: null },
    capabilities: [{ kind: 'skill', name: 'facebook/react-guidance' }],
    mode: 'official',
  });
  assert.equal(react.reason, 'all_relevant_skills_available');

  const next = detectSkillGap({
    fingerprint: { repositoryId: 'next', languages: ['JavaScript'], frameworks: [{ name: 'Next.js', version: '15' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'next', version: '15' }], manifestDigest: 'next' },
    task: 'Build a Next.js page',
    profile,
    capabilities: [{ kind: 'skill', name: 'vercel/next-guidance' }],
    mode: 'official',
  });
  assert.equal(next.reason, 'all_relevant_skills_available');

  const sveltekit = detectSkillGap({
    fingerprint,
    task: 'Implement a SvelteKit component',
    profile,
    capabilities: [{ kind: 'skill', name: 'sveltejs/ai-tools:sveltekit-guidance' }],
    mode: 'official',
  });
  assert.equal(sveltekit.reason, 'all_relevant_skills_available');
});

test('does not accept a technology alias hidden behind an unverified qualifier', () => {
  for (const name of ['attacker/sveltekit', 'attacker:sveltekit', 'attacker/sveltekit-helper']) {
    const decision = detectSkillGap({
      fingerprint,
      task: 'Implement a SvelteKit component',
      profile,
      capabilities: [{ kind: 'skill', name }],
      mode: 'official',
    });
    assert.deepEqual(decision.missing.map((requirement) => requirement.id), ['sveltekit']);
    assert.equal(decision.reason, 'relevant_skill_missing');
  }
});

test('suppresses fingerprint-only requirements for an explicitly non-code task', () => {
  const decision = detectSkillGap({
    fingerprint,
    task: 'Fix a typo in README.md',
    profile: { taskType: 'debug', target: 'README.md', expected: 'spelling corrected', constraints: null },
    capabilities: [],
    mode: 'official',
  });
  assert.deepEqual(decision.requirements, []);
  assert.equal(decision.shouldDiscover, false);
  assert.equal(decision.reason, 'no_supported_technology');

  const explicit = detectSkillGap({
    fingerprint,
    task: 'Fix the SvelteKit documentation example',
    profile: { taskType: 'debug', target: 'SvelteKit docs', expected: 'example corrected', constraints: null },
    capabilities: [],
    mode: 'official',
  });
  assert.deepEqual(explicit.missing.map((requirement) => requirement.id), ['sveltekit']);
});

test('accepts explicit high-signal aliases for Next, Go, and Svelte', () => {
  const next = detectSkillGap({
    fingerprint: { repositoryId: 'next', languages: ['JavaScript'], frameworks: [{ name: 'Next.js', version: '15' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'next', version: '15' }], manifestDigest: 'next' },
    task: 'Build a Next.js page', profile, capabilities: [{ kind: 'skill', name: 'nextjs-helper' }], mode: 'official',
  });
  assert.equal(next.reason, 'all_relevant_skills_available');

  const go = detectSkillGap({
    fingerprint: { repositoryId: 'go', languages: ['Go'], frameworks: [], databases: [], runtimes: [], tools: [], packages: [], manifestDigest: 'go' },
    task: 'Build a Go service', profile: { taskType: 'build', target: 'Go service', expected: 'tests pass', constraints: null }, capabilities: [{ kind: 'skill', name: 'golang-helper' }], mode: 'official',
  });
  assert.equal(go.reason, 'all_relevant_skills_available');
});

test('keeps applicability scoped to the technology target axes', () => {
  const requirements = requirementsFromFingerprint({
    repositoryId: 'mixed',
    languages: ['Go', 'Python'],
    frameworks: [],
    databases: ['PostgreSQL', 'MySQL'],
    runtimes: ['Go', 'Python'],
    tools: [],
    packages: [],
    manifestDigest: 'mixed',
  });
  const python = requirements.find((requirement) => requirement.id === 'python')!;
  const go = requirements.find((requirement) => requirement.id === 'go')!;
  const postgres = requirements.find((requirement) => requirement.id === 'postgresql')!;
  const mysql = requirements.find((requirement) => requirement.id === 'mysql')!;
  assert.deepEqual(python.applicability, { languages: ['Python'], runtimes: ['Python'] });
  assert.deepEqual(go.applicability, { languages: ['Go'], runtimes: ['Go'] });
  assert.deepEqual(postgres.applicability, { databases: ['PostgreSQL'] });
  assert.deepEqual(mysql.applicability, { databases: ['MySQL'] });
});

test('recognizes explicit safe aliases without accepting ambiguous fragments', () => {
  const cases = [
    ['laravel', 'laravel-boost'], ['react', 'react-best-practices'], ['python', 'python-testing'],
    ['rust', 'rust-guide'], ['typescript', 'typescript-helper'], ['postgresql', 'postgresql-helper'],
    ['mysql', 'mysql-helper'], ['sqlite', 'sqlite-helper'],
  ] as const;
  for (const [technology, capabilityName] of cases) {
    const requirement = requirementsFromFingerprint({
      repositoryId: technology,
      languages: technology === 'python' ? ['Python'] : technology === 'rust' ? ['Rust'] : technology === 'typescript' ? ['TypeScript'] : technology === 'laravel' ? ['PHP'] : ['JavaScript'],
      frameworks: technology === 'laravel' ? [{ name: 'Laravel' }] : technology === 'react' ? [{ name: 'React' }] : [],
      databases: technology === 'postgresql' ? ['PostgreSQL'] : technology === 'mysql' ? ['MySQL'] : technology === 'sqlite' ? ['SQLite'] : [],
      runtimes: [], tools: technology === 'typescript' ? ['typescript'] : [], packages: [], manifestDigest: technology,
    }).find((item) => item.id === technology);
    assert.ok(requirement);
    const decision = detectSkillGap({ fingerprint: {
      repositoryId: technology,
      languages: technology === 'python' ? ['Python'] : technology === 'rust' ? ['Rust'] : technology === 'typescript' ? ['TypeScript'] : technology === 'laravel' ? ['PHP'] : ['JavaScript'],
      frameworks: technology === 'laravel' ? [{ name: 'Laravel' }] : technology === 'react' ? [{ name: 'React' }] : [],
      databases: technology === 'postgresql' ? ['PostgreSQL'] : technology === 'mysql' ? ['MySQL'] : technology === 'sqlite' ? ['SQLite'] : [],
      runtimes: [], tools: technology === 'typescript' ? ['typescript'] : [], packages: [], manifestDigest: technology,
    }, task: `Build ${technology}`, profile: { taskType: 'build', target: technology, expected: 'tests pass', constraints: null }, capabilities: [{ kind: 'skill', name: capabilityName }], mode: 'official' });
    assert.equal(decision.reason, 'all_relevant_skills_available');
  }
});
