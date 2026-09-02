import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { discoverSkills } from '../../src/skills/discovery-service.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { importSkillSnapshot, listExternalSkills } from '../../src/skills/store.js';
import { SkillSourceError } from '../../src/skills/source/github-fetcher.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillMaterializationAuthorization, SkillRequirement } from '../../src/skills/types.js';

const COMMIT_A = 'd'.repeat(40);
const COMMIT_B = 'f'.repeat(40);

const svelteFingerprint = {
  repositoryId: 'repo-svelte',
  languages: ['JavaScript'],
  frameworks: [{ name: 'Svelte', version: '5' }],
  databases: [],
  runtimes: ['Node.js'],
  tools: [],
  packages: [{ name: 'svelte', version: '5' }],
  manifestDigest: 'svelte',
};

const svelteRequirement: SkillRequirement = {
  id: 'svelte',
  technology: 'svelte',
  aliases: ['svelte'],
  queries: ['svelte'],
  owners: ['sveltejs'],
  repositories: ['sveltejs/ai-tools'],
  applicability: { frameworks: [{ name: 'Svelte' }] },
  signals: { packages: ['svelte'] },
  reason: 'Svelte test fixture.',
};

function candidate(
  provider: string,
  source: string,
  slug: string,
  officialStatus: SkillCandidate['officialStatus'],
  auditStatus?: SkillCandidate['auditStatus'],
): SkillCandidate {
  return {
    id: `${provider}:${source}:${slug}`,
    provider,
    name: slug,
    slug,
    source,
    sourceType: 'github',
    installUrl: `https://github.com/${source}`,
    installs: 1,
    duplicate: false,
    officialStatus,
    auditStatus: auditStatus ?? 'passed',
  };
}

function snapshot(skill: SkillCandidate, sourceCommit = COMMIT_A) {
  return validateSkillSnapshot({
    candidate: skill,
    sourceCommit,
    files: [{
      path: `skills/${skill.slug}/SKILL.md`,
      content: `---\nname: ${skill.name}\ndescription: Safe fixture\n---\n# ${skill.name}\n\nReference only.`,
      primary: true,
    }],
  });
}

async function passedAuditAuthorization(candidate: SkillCandidate): Promise<SkillMaterializationAuthorization> {
  const result = await authorizeSkillMaterialization({
    id: candidate.provider,
    async search() { throw new Error('materialization authorization fixture must not search'); },
    async audit(audited) {
      assert.equal(audited.id, candidate.id);
      assert.equal(audited.provider, candidate.provider);
      assert.equal(audited.source, candidate.source);
      assert.equal(audited.slug, candidate.slug);
      return { status: 'passed' };
    },
  }, candidate);
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') throw new Error('fixture audit did not issue materialization authority');
  return result.authorization;
}

function discoveryInput(mode: 'official' | 'community', capabilities?: unknown) {
  return {
    project: { workspace: 'workspace:svelte', repositoryRoot: '/fixture/svelte', repositoryId: 'repo-svelte' },
    fingerprint: svelteFingerprint,
    task: 'Implement a Svelte component',
    profile: { taskType: 'build' as const, target: 'Svelte component', expected: 'tests pass', constraints: null },
    recommendedTags: ['svelte'],
    ...(capabilities === undefined ? {} : { capabilities }),
    mode,
  };
}

test('downgrades community discovery to official-only when the capability catalog is unknown', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-unknown-catalog-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const owners: Array<string | null> = [];
  let auditCalls = 0;
  const official = candidate('fixture', 'sveltejs/ai-tools', 'svelte', 'registry-only');
  const community = candidate('fixture', 'community/svelte-tools', 'svelte', 'registry-only');
  try {
    const result = await discoverSkills(database, discoveryInput('community'), {
      provider: {
        id: 'fixture',
        async search(input) {
          owners.push(input.owner ?? null);
          return { provider: 'fixture', experimental: false, candidates: [input.owner === undefined ? community : official] };
        },
        async audit() { auditCalls += 1; return { status: 'passed' }; },
      },
      sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.equal(result.mode, 'official');
    assert.ok(owners.length > 0);
    assert.ok(owners.every((owner) => owner === 'sveltejs'));
    assert.equal(auditCalls, 1);
    assert.ok(result.selected.length > 0);
    assert.ok(listExternalSkills(database).every((skill) => skill.sourceLocator === 'sveltejs/ai-tools'));
  } finally {
    database.close();
  }
});

test('re-audits the canonical skill identity and fails closed when only the registry alias passed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-canonical-audit-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const alias = candidate('fixture', 'community/svelte-tools', 'svelte', 'registry-only');
  const audited: string[] = [];
  try {
    const result = await discoverSkills(database, discoveryInput('community', []), {
      provider: {
        id: 'fixture',
        async search(input) {
          return { provider: 'fixture', experimental: false, candidates: input.owner === undefined ? [alias] : [] };
        },
        async audit(skill) {
          audited.push(`${skill.source}:${skill.slug}`);
          return { status: skill.slug === 'evil/svelte' ? 'failed' : 'passed' };
        },
      },
      sourceFetcher: {
        async fetch(skill) {
          if (skill.source !== alias.source) throw new SkillSourceError('candidate_not_found_at_source');
          return validateSkillSnapshot({
            candidate: skill,
            sourceCommit: COMMIT_A,
            files: [{ path: 'skills/evil/svelte/SKILL.md', content: '---\nname: Evil Svelte\ndescription: unsafe identity fixture\n---\n# Evil\n\nReference.', primary: true }],
          });
        },
      },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.ok(audited.includes('community/svelte-tools:svelte'));
    assert.ok(audited.includes('community/svelte-tools:evil/svelte'));
    assert.ok(result.failures.some((failure) => failure.code === 'community_audit_failed'));
    assert.equal(result.selected.length, 0);
    assert.equal(listExternalSkills(database).some((skill) => skill.sourceLocator === alias.source), false);
  } finally {
    database.close();
  }
});

test('rejects a manual community import without applicability', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-no-applicability-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const manual = candidate('manual', 'community/svelte-tools', 'svelte', 'unknown', 'passed');
  const manualSnapshot = snapshot(manual);
  try {
    const authorization = await passedAuditAuthorization(manualSnapshot.candidate);
    assert.throws(
      () => importSkillSnapshot(database, manualSnapshot, documentsFromSkillSnapshot(manualSnapshot), undefined, '2026-08-25T00:00:00.000Z', authorization),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && /applicability/iu.test((error as Error).message),
    );
    assert.equal(listExternalSkills(database).length, 0);
  } finally {
    database.close();
  }
});

test('rejects automatic materialization limits outside the explicit 1..2 bound before side effects', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-limit-policy-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  let providerCalls = 0;
  try {
    for (const maxSelectedSkills of [0, 3, 1.5]) {
      await assert.rejects(
        discoverSkills(database, { ...discoveryInput('official', []), maxSelectedSkills: maxSelectedSkills as 1 | 2 }, {
          provider: {
            id: 'unused',
            async search() { providerCalls += 1; return { provider: 'unused', experimental: false, candidates: [] }; },
          },
          sourceFetcher: { async fetch() { throw new Error('invalid limit must fail before source access'); } },
          now: () => '2026-08-25T00:00:00.000Z',
        }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && /limit must be 1 or 2/iu.test((error as Error).message),
      );
    }
    assert.equal(providerCalls, 0);
    assert.equal(listExternalSkills(database).length, 0);
  } finally {
    database.close();
  }
});

test('reuses a passed-audit import only in community mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-mode-policy-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const community = candidate('manual', 'community/svelte-tools', 'svelte', 'unknown', 'passed');
  const communitySnapshot = snapshot(community);
  try {
    const authorization = await passedAuditAuthorization(communitySnapshot.candidate);
    const imported = importSkillSnapshot(database, communitySnapshot, documentsFromSkillSnapshot(communitySnapshot), svelteRequirement, '2026-08-25T00:00:00.000Z', authorization);
    const reused = await discoverSkills(database, discoveryInput('community', []), {
      provider: { id: 'unused', async search() { throw new Error('fresh community import should be reused'); } },
      sourceFetcher: { async fetch() { throw new Error('fresh community import should be reused'); } },
      now: () => '2026-08-25T01:00:00.000Z',
    });
    assert.equal(reused.attempted, false);
    assert.equal(reused.selected[0]?.skillId, imported.skillId);

    const reviewed = candidate('fixture', 'sveltejs/ai-tools', 'svelte-code-writer', 'catalog-verified');
    let searchCalls = 0;
    const restricted = await discoverSkills(database, discoveryInput('official', []), {
      provider: {
        id: 'fixture',
        async search() { searchCalls += 1; return { provider: 'fixture', experimental: false, candidates: [reviewed] }; },
      },
      sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
      now: () => '2026-08-25T02:00:00.000Z',
    });
    assert.equal(restricted.attempted, true);
    assert.ok(searchCalls > 0);
    assert.equal(restricted.selected.length, 1);
    assert.notEqual(restricted.selected[0]?.skillId, imported.skillId);
    assert.equal(restricted.selected[0]?.source, reviewed.source);
  } finally {
    database.close();
  }
});

test('allows an explicit bounded opt-in to materialize two relevant skills', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-same-repository-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const svelte = candidate('fixture', 'sveltejs/ai-tools', 'svelte', 'registry-only');
  const sveltekit = candidate('fixture', 'sveltejs/ai-tools', 'sveltekit', 'registry-only');
  const fetched: string[] = [];
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint: {
        ...svelteFingerprint,
        frameworks: [{ name: 'Svelte', version: '5' }, { name: 'SvelteKit', version: '2' }],
        packages: [{ name: 'svelte', version: '5' }, { name: '@sveltejs/kit', version: '2' }],
      },
      task: 'Implement Svelte and SvelteKit components',
      profile: { taskType: 'build', target: 'Svelte and SvelteKit components', expected: 'tests pass', constraints: null },
      recommendedTags: ['svelte', 'sveltekit'],
      capabilities: [],
      mode: 'official',
      maxSelectedSkills: 2,
    }, {
      provider: {
        id: 'fixture',
        async search() { return { provider: 'fixture', experimental: false, candidates: [svelte, sveltekit] }; },
        async audit() { return { status: 'passed' }; },
      },
      sourceFetcher: {
        async fetch(skill) { fetched.push(skill.slug); return snapshot(skill, skill.slug === 'svelte' ? COMMIT_A : COMMIT_B); },
      },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.deepEqual(result.selected.map((skill) => skill.name).sort(), ['svelte', 'sveltekit']);
    assert.deepEqual(fetched.sort(), ['svelte', 'sveltekit']);
    assert.equal(listExternalSkills(database).length, 2);
  } finally {
    database.close();
  }
});

test('imports a provider-returned reviewed Laravel candidate only from its exact primary path', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-laravel-reviewed-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const laravel = candidate('fixture', 'laravel/boost', 'laravel-best-practices', 'catalog-verified');
  let sourceCalls = 0;
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:laravel', repositoryRoot: directory, repositoryId: 'repo-laravel' },
      fingerprint: {
        repositoryId: 'repo-laravel', languages: ['PHP'], frameworks: [{ name: 'Laravel', version: '12' }],
        databases: [], runtimes: ['PHP'], tools: [], packages: [{ name: 'laravel/framework', version: '12' }], manifestDigest: 'laravel',
      },
      task: 'Implement a Laravel controller',
      profile: { taskType: 'build', target: 'Laravel controller', expected: 'tests pass', constraints: null },
      recommendedTags: ['laravel'], capabilities: [], mode: 'official',
    }, {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [laravel] }; } },
      sourceFetcher: {
        async fetch(skill) {
          sourceCalls += 1;
          return validateSkillSnapshot({
            candidate: skill,
            sourceCommit: COMMIT_A,
            files: [{
              path: '.ai/laravel/skill/laravel-best-practices/SKILL.md',
              content: '---\nname: Laravel Best Practices\ndescription: Safe Laravel reference\n---\n# Laravel Best Practices\n\nReference only.',
              primary: true,
            }],
          });
        },
      },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(sourceCalls, 1, JSON.stringify(result));
    assert.equal(result.selected.length, 1, JSON.stringify(result));
    assert.equal(result.selected[0]?.source, 'laravel/boost');
  } finally {
    database.close();
  }
});

test('does not reuse version-constrained applicability when the project version is missing or invalid', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-version-reuse-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const community = candidate('manual', 'community/svelte-tools', 'svelte', 'unknown', 'passed');
  const communitySnapshot = snapshot(community);
  try {
    const authorization = await passedAuditAuthorization(communitySnapshot.candidate);
    importSkillSnapshot(database, communitySnapshot, documentsFromSkillSnapshot(communitySnapshot), {
      ...svelteRequirement,
      applicability: { frameworks: [{ name: 'Svelte', version: '^5.0.0' }] },
    }, '2026-08-25T00:00:00.000Z', authorization);
    for (const version of [undefined, 'not-semver']) {
      const base = discoveryInput('community', []);
      const result = await discoverSkills(database, {
        ...base,
        fingerprint: { ...base.fingerprint, frameworks: [{ name: 'Svelte', ...(version === undefined ? {} : { version }) }] },
      }, {
        provider: { id: 'fixture-version', async search() { return { provider: 'fixture-version', experimental: false, candidates: [] }; } },
        sourceFetcher: { async fetch() { throw new Error('an incompatible fresh snapshot must not be reused or refreshed'); } },
        now: () => '2026-08-25T01:00:00.000Z',
      });
      assert.equal(result.attempted, true);
      assert.equal(result.selected.length, 0);
    }
  } finally {
    database.close();
  }
});

test('reuses a fresh import without network access when the project framework range is a compatible subset', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-range-reuse-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const community = candidate('fixture-range', 'community/svelte-tools', 'svelte', 'registry-only', 'passed');
  const firstInput = {
    ...discoveryInput('community', []),
    project: { workspace: 'workspace:svelte-range', repositoryRoot: directory, repositoryId: 'repo-svelte-range' },
    fingerprint: {
      ...svelteFingerprint,
      repositoryId: 'repo-svelte-range',
      frameworks: [{ name: 'Svelte', version: '>=5 <6' }],
      packages: [{ name: 'svelte', version: '>=5 <6' }],
      manifestDigest: 'svelte-range-first',
    },
  };
  try {
    const first = await discoverSkills(database, firstInput, {
      provider: {
        id: 'fixture-range',
        async search(input) {
          return { provider: 'fixture-range', experimental: false, candidates: input.owner === undefined ? [community] : [] };
        },
        async audit() { return { status: 'passed' }; },
      },
      sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(first.selected.length, 1, JSON.stringify(first));

    let networkCalls = 0;
    const second = await discoverSkills(database, {
      ...firstInput,
      fingerprint: {
        ...firstInput.fingerprint,
        frameworks: [{ name: 'Svelte', version: '^5.2.0' }],
        packages: [{ name: 'svelte', version: '^5.2.0' }],
        manifestDigest: 'svelte-range-second',
      },
    }, {
      provider: {
        id: 'unused-range',
        async search() {
          networkCalls += 1;
          throw new Error('a compatible fresh framework range must be reused before provider access');
        },
      },
      sourceFetcher: {
        async fetch() {
          networkCalls += 1;
          throw new Error('a compatible fresh framework range must be reused before source access');
        },
      },
      now: () => '2026-08-25T01:00:00.000Z',
    });

    assert.equal(second.attempted, false);
    assert.equal(second.selected[0]?.skillId, first.selected[0]?.skillId);
    assert.equal(networkCalls, 0);
  } finally {
    database.close();
  }
});
