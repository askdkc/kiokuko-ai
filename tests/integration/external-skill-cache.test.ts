import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { discoverSkills, SkillDiscoveryService } from '../../src/skills/discovery-service.js';
import { SkillDiscoveryCache } from '../../src/skills/cache.js';
import { listExternalSkills, markExternalSkillRefreshFailure, readPersistentSkillSearchCache, writePersistentSkillSearchCache } from '../../src/skills/store.js';
import { SkillSourceError } from '../../src/skills/source/github-fetcher.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRegistryProvider } from '../../src/skills/types.js';
import { canonicalJson } from '../../src/serialization/validate.js';
import { SkillsShCompatibilityProvider } from '../../src/skills/providers/skills-sh-compat.js';

const COMMIT = 'd'.repeat(40);

test('binds persistent compatibility cache entries to the normalized provider origin', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-cache-origin-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const primary = new SkillsShCompatibilityProvider({ apiUrl: 'https://skills.sh' });
    const alternate = new SkillsShCompatibilityProvider({ apiUrl: 'http://127.0.0.1:4100' });
    writePersistentSkillSearchCache(database, {
      provider: primary.id, query: 'svelte', mode: 'official', outcome: 'empty',
      result: { provider: primary.id, experimental: false, candidates: [] },
      ttlMs: 60_000, now: '2026-08-25T00:00:00.000Z',
    });
    assert.equal(readPersistentSkillSearchCache(database, {
      provider: alternate.id, query: 'svelte', mode: 'official', now: '2026-08-25T00:00:30.000Z',
    }), null);
    writePersistentSkillSearchCache(database, {
      provider: alternate.id, query: 'svelte', mode: 'official', outcome: 'empty',
      result: { provider: alternate.id, experimental: false, candidates: [] },
      ttlMs: 60_000, now: '2026-08-25T00:00:30.000Z',
    });
    const providers = database.prepare('SELECT provider FROM skill_discovery_cache ORDER BY provider').all<{ provider: string }>().map((row) => row.provider);
    assert.equal(providers.length, 2);
    assert.deepEqual(providers, [...new Set([primary.id, alternate.id])].sort());
    assert.ok(providers.every((provider) => !provider.includes('skills.sh') && !provider.includes('127.0.0.1')));
  } finally {
    database.close();
  }
});

function reactDiscoveryInput(repositoryRoot: string) {
  return {
    project: { workspace: 'workspace:react', repositoryRoot, repositoryId: 'repo-react' },
    fingerprint: { repositoryId: 'repo-react', languages: ['JavaScript'], frameworks: [{ name: 'React', version: '19' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'react', version: '19' }], manifestDigest: 'react' },
    task: 'Build a React component',
    profile: { taskType: 'build' as const, target: 'React component', expected: 'tests pass', constraints: null },
    recommendedTags: ['react'],
    capabilities: [],
    mode: 'official' as const,
  };
}

test('fails closed on forged persistent trust provenance and preserves it without a network retry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-cache-validation-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const forgedCandidate = { id: 'fixture:facebook/react-skills:react', provider: 'fixture', name: 'react', slug: 'react', source: 'facebook/react-skills', sourceType: 'github' as const, installUrl: 'https://github.com/facebook/react-skills', installs: 1, duplicate: false, officialStatus: 'curated' as const };
    assert.throws(() => writePersistentSkillSearchCache(database, {
      provider: 'fixture', query: 'react', owner: 'facebook', mode: 'official', now: '2026-08-25T00:00:00.000Z', ttlMs: 60_000, outcome: 'success',
      result: { provider: 'fixture', experimental: true, candidates: [forgedCandidate] },
    }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()?.count, 0);
    writePersistentSkillSearchCache(database, {
      provider: 'fixture', query: 'react', owner: 'facebook', mode: 'official', now: '2026-08-25T00:00:00.000Z', ttlMs: 60_000, outcome: 'success',
      result: { provider: 'fixture', experimental: true, candidates: [{ ...forgedCandidate, officialStatus: 'registry-only' }] },
    });
    database.prepare('UPDATE skill_discovery_cache SET response_json = ?').run(canonicalJson({
      provider: 'fixture',
      experimental: true,
      candidates: [forgedCandidate],
    }));
    assert.throws(
      () => readPersistentSkillSearchCache(database, { provider: 'fixture', query: 'react', owner: 'facebook', mode: 'official', now: '2026-08-25T00:00:30.000Z' }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    let searchCalls = 0;
    await assert.rejects(discoverSkills(database, reactDiscoveryInput(directory), {
      provider: { id: 'fixture', async search() { searchCalls += 1; return { provider: 'fixture', experimental: false, candidates: [] }; } },
      now: () => '2026-08-25T00:00:30.000Z',
    }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    assert.equal(searchCalls, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('fails closed on malformed persistent cache JSON without deleting evidence or retrying the network', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-cache-json-corruption-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    writePersistentSkillSearchCache(database, {
      provider: 'fixture', query: 'react', owner: 'facebook', mode: 'official', now: '2026-08-25T00:00:00.000Z', ttlMs: 60_000, outcome: 'empty',
      result: { provider: 'fixture', experimental: false, candidates: [] },
    });
    const corruptions = [
      '{"provider":',
      `{"candidates":${'{"nested":'.repeat(129)}null${'}'.repeat(129)},"experimental":false,"provider":"fixture"}`,
      '{"candidates":[],"experimental":false,"provider":"\\ud800"}',
    ];
    for (const corruption of corruptions) {
      database.prepare('UPDATE skill_discovery_cache SET response_json = ?').run(corruption);
      assert.throws(
        () => readPersistentSkillSearchCache(database, { provider: 'fixture', query: 'react', owner: 'facebook', mode: 'official', now: '2026-08-25T00:00:30.000Z' }),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
      );
    }
    let searchCalls = 0;
    await assert.rejects(discoverSkills(database, reactDiscoveryInput(directory), {
      provider: { id: 'fixture', async search() { searchCalls += 1; return { provider: 'fixture', experimental: false, candidates: [] }; } },
      now: () => '2026-08-25T00:00:30.000Z',
    }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
    assert.equal(searchCalls, 0);
    assert.equal(database.prepare('SELECT response_json AS responseJson FROM skill_discovery_cache').get<{ responseJson: string }>()?.responseJson, corruptions.at(-1));
  } finally {
    database.close();
  }
});

test('persists the curated provider result across discovery service instances', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cache-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture-v1:sveltejs/ai-tools:svelte-code-writer',
    provider: 'fixture-v1',
    name: 'svelte-code-writer',
    slug: 'svelte-code-writer',
    source: 'sveltejs/ai-tools',
    sourceType: 'github',
    installUrl: 'https://github.com/sveltejs/ai-tools',
    installs: 1,
    duplicate: false,
    officialStatus: 'curated',
  };
  let searchCalls = 0;
  let curatedCalls = 0;
  const provider: SkillRegistryProvider = {
    id: 'fixture-v1',
    async search() { searchCalls += 1; return { provider: 'fixture-v1', experimental: false, candidates: [] }; },
    async curated() { curatedCalls += 1; return [candidate]; },
  };
  const sourceFetcher = {
    async fetch(value: SkillCandidate) {
      return validateSkillSnapshot({
        candidate: value,
        sourceCommit: COMMIT,
        files: [{ path: 'skills/svelte-code-writer/SKILL.md', content: '---\nname: Svelte Code Writer\ndescription: safe\n---\n# Svelte\n\nReference only.', primary: true }],
      });
    },
  };
  const input = {
    project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
    fingerprint: {
      repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'SvelteKit', version: '2' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: '@sveltejs/kit', version: '2' }], manifestDigest: 'digest',
    },
    task: 'Build a SvelteKit component',
    profile: { taskType: 'build' as const, target: 'SvelteKit component', expected: 'tests pass', constraints: null },
    recommendedTags: ['sveltekit'],
    capabilities: [],
    mode: 'official' as const,
  };
  try {
    const first = await discoverSkills(database, input, { provider, sourceFetcher, now: () => '2026-08-25T00:00:00.000Z' });
    const searchCallsAfterFirst = searchCalls;
    const cacheTimesBefore = database.prepare('SELECT cache_key AS cacheKey, fetched_at AS fetchedAt FROM skill_discovery_cache ORDER BY cache_key')
      .all<{ cacheKey: string; fetchedAt: string }>();
    const current = listExternalSkills(database)[0]!;
    markExternalSkillRefreshFailure(database, current.skillId, 'stale', { generation: current.generation, sourceCommit: current.sourceCommit, snapshotHash: current.snapshotHash, state: current.state, lastCheckedAt: current.lastCheckedAt }, '2026-08-25T00:30:00.000Z');
    const second = await discoverSkills(database, input, { provider, sourceFetcher, now: () => '2026-08-25T01:00:00.000Z' });
    assert.equal(first.selected.length, 1);
    assert.equal(second.selected.length, 1);
    assert.ok(searchCallsAfterFirst > 0);
    assert.equal(searchCalls, searchCallsAfterFirst);
    assert.equal(curatedCalls, 1);
    assert.ok(second.cacheHits >= 3);
    assert.deepEqual(
      database.prepare('SELECT cache_key AS cacheKey, fetched_at AS fetchedAt FROM skill_discovery_cache ORDER BY cache_key')
        .all<{ cacheKey: string; fetchedAt: string }>(),
      cacheTimesBefore,
    );
  } finally {
    database.close();
  }
});

test('bounds community audit work before any source fetch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-community-audit-bound-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  let auditCalls = 0;
  const searchedOwners: Array<string | null> = [];
  const candidates: SkillCandidate[] = Array.from({ length: 20 }, (_, index) => ({
    id: `fixture-community:community/repo-${index}:sveltekit-${index}`,
    provider: 'fixture-community', name: `sveltekit-${index}`, slug: `sveltekit-${index}`, source: `community/repo-${index}`,
    sourceType: 'github', installUrl: `https://github.com/community/repo-${index}`, installs: 20 - index, duplicate: false, officialStatus: 'registry-only',
  }));
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint: { repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'SvelteKit', version: '2' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: '@sveltejs/kit', version: '2' }], manifestDigest: 'digest' },
      task: 'Build a SvelteKit component', profile: { taskType: 'build', target: 'SvelteKit component', expected: 'tests pass', constraints: null }, recommendedTags: ['sveltekit'], capabilities: [], mode: 'community',
    }, {
      provider: {
        id: 'fixture-community',
        async search(input) { searchedOwners.push(input.owner ?? null); return { provider: 'fixture-community', experimental: true, candidates }; },
        async audit() { auditCalls += 1; return { status: 'failed' }; },
      },
      sourceFetcher: { async fetch() { throw new SkillSourceError('candidate_not_found_at_source'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(auditCalls, 6);
    assert.deepEqual(searchedOwners, ['sveltejs', 'sveltejs', 'sveltejs', null, null, null]);
    assert.ok(result.failures.some((failure) => failure.code === 'community_audit_limit_reached'));
    assert.ok(result.selected.length <= 1);
  } finally {
    database.close();
  }
});

test('shares registry single-flight work between concurrent production discoveries', async () => {
  const firstDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-flight-a-'));
  const secondDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-flight-b-'));
  const first = openConnection(path.join(firstDirectory, 'data.sqlite3'));
  const second = openConnection(path.join(secondDirectory, 'data.sqlite3'));
  migrateDatabase(first);
  migrateDatabase(second);
  let searchCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'skills.sh') {
      searchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ skills: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/repos/sveltejs/ai-tools') return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: COMMIT }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.includes(`/git/trees/${COMMIT}`)) return new Response(JSON.stringify({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'tools/skills/svelte-code-writer/SKILL.md' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: Svelte Code Writer\ndescription: safe\n---\n# SvelteKit\n\nReference.', { status: 200 });
    throw new Error(`unexpected fixture URL: ${url.pathname}`);
  };
  const input = {
    project: { workspace: 'workspace:svelte', repositoryRoot: firstDirectory, repositoryId: 'repo-svelte' },
    fingerprint: { repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'SvelteKit', version: '2' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: '@sveltejs/kit', version: '2' }], manifestDigest: 'digest' },
    task: 'Build a SvelteKit component',
    profile: { taskType: 'build' as const, target: 'SvelteKit component', expected: 'tests pass', constraints: null },
    recommendedTags: ['sveltekit'],
    capabilities: [],
    mode: 'official' as const,
    fetchImpl,
  };
  try {
    const [left, right] = await Promise.all([
      discoverSkills(first, input),
      discoverSkills(second, { ...input, project: { ...input.project, workspace: 'workspace:svelte-2', repositoryRoot: secondDirectory } }),
    ]);
    assert.equal(left.selected.length, 0, JSON.stringify(left));
    assert.equal(right.selected.length, 0, JSON.stringify(right));
    assert.equal(searchCalls, 3);
  } finally {
    first.close();
    second.close();
  }
});

test('persists shared in-flight results per database without serializing cache-hit metadata', async () => {
  const firstDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-flight-clock-a-'));
  const secondDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-flight-clock-b-'));
  const first = openConnection(path.join(firstDirectory, 'data.sqlite3'));
  const second = openConnection(path.join(secondDirectory, 'data.sqlite3'));
  migrateDatabase(first);
  migrateDatabase(second);
  const cache = new SkillDiscoveryCache();
  let searchCalls = 0;
  const provider: SkillRegistryProvider = {
    id: 'fixture-flight-clock',
    async search() {
      searchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { provider: 'fixture-flight-clock', experimental: false, candidates: [] };
    },
  };
  const firstService = new SkillDiscoveryService({ provider, cache, now: () => '2026-08-25T00:00:00.000Z' });
  const secondService = new SkillDiscoveryService({ provider, cache, now: () => '2026-08-25T01:00:00.000Z' });
  try {
    await Promise.all([
      firstService.discover(first, reactDiscoveryInput(firstDirectory)),
      secondService.discover(second, {
        ...reactDiscoveryInput(secondDirectory),
        project: { workspace: 'workspace:react-2', repositoryRoot: secondDirectory, repositoryId: 'repo-react-2' },
      }),
    ]);
    const rows = (database: typeof first) => database.prepare(`
      SELECT response_json AS responseJson, fetched_at AS fetchedAt
        FROM skill_discovery_cache
       ORDER BY cache_key
    `).all<{ responseJson: string; fetchedAt: string }>();
    const firstRows = rows(first);
    const secondRows = rows(second);
    assert.ok(firstRows.length > 0);
    assert.equal(searchCalls, firstRows.length);
    assert.equal(secondRows.length, firstRows.length);
    assert.ok(firstRows.every((row) => row.fetchedAt === '2026-08-25T00:00:00.000Z'));
    assert.ok(secondRows.every((row) => row.fetchedAt === '2026-08-25T01:00:00.000Z'));
    assert.ok([...firstRows, ...secondRows].every((row) => !Object.prototype.hasOwnProperty.call(JSON.parse(row.responseJson), 'cached')));
  } finally {
    first.close();
    second.close();
  }
});

test('shares a candidate snapshot fetch and keeps one entry during concurrent discovery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-source-flight-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  let sourceCalls = 0;
  const fetchedCandidates: string[] = [];
  const candidate: SkillCandidate = { id: 'fixture:sveltejs/ai-tools:sveltekit', provider: 'fixture', name: 'sveltekit', slug: 'sveltekit', source: 'sveltejs/ai-tools', sourceType: 'github', installUrl: 'https://github.com/sveltejs/ai-tools', installs: 1, duplicate: false, officialStatus: 'registry-only' };
  const service = new SkillDiscoveryService({
    provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [candidate] }; }, async audit() { return { status: 'passed' }; } },
    sourceFetcher: { async fetch(value) { sourceCalls += 1; fetchedCandidates.push(value.id); await new Promise((resolve) => setTimeout(resolve, 5)); return validateSkillSnapshot({ candidate: value, sourceCommit: COMMIT, files: [{ path: 'sveltekit/SKILL.md', content: '---\nname: SvelteKit\ndescription: safe\n---\n# SvelteKit\n\nReference.', primary: true }] }); } },
    now: () => '2026-08-25T00:00:00.000Z',
  });
  const input = {
    project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
    fingerprint: { repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'SvelteKit', version: '2' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: '@sveltejs/kit', version: '2' }], manifestDigest: 'digest' },
    task: 'Build a SvelteKit component', profile: { taskType: 'build' as const, target: 'SvelteKit component', expected: 'tests pass', constraints: null }, recommendedTags: ['sveltekit'], capabilities: [], mode: 'official' as const,
  };
  try {
    const [left, right] = await Promise.all([service.discover(database, input), service.discover(database, input)]);
    assert.equal(sourceCalls, 1, JSON.stringify(fetchedCandidates));
    assert.equal(left.selected.length, 1);
    assert.equal(right.selected.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('rejects an unknown community candidate when the provider has no audit result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-community-audit-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture-community:community/repo:sveltekit',
    provider: 'fixture-community',
    name: 'sveltekit-helper',
    slug: 'sveltekit',
    source: 'community/repo',
    sourceType: 'github',
    installUrl: 'https://github.com/community/repo',
    installs: 10,
    duplicate: false,
    officialStatus: 'registry-only',
  };
  const provider: SkillRegistryProvider = {
    id: 'fixture-community',
    async search() { return { provider: 'fixture-community', experimental: true, candidates: [candidate] }; },
  };
  const sourceFetcher = {
    async fetch(value: SkillCandidate) {
      if (value.source !== candidate.source) throw new SkillSourceError('candidate_not_found_at_source');
      return validateSkillSnapshot({ candidate: value, sourceCommit: COMMIT, files: [{ path: 'skills/sveltekit/SKILL.md', content: '---\nname: SvelteKit\ndescription: safe\n---\n# SvelteKit\n\nReference.', primary: true }] });
    },
  };
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint: { repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'SvelteKit', version: '2' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: '@sveltejs/kit', version: '2' }], manifestDigest: 'digest' },
      task: 'Build a SvelteKit component',
      profile: { taskType: 'build', target: 'SvelteKit component', expected: 'tests pass', constraints: null },
      recommendedTags: ['sveltekit'],
      capabilities: [],
      mode: 'community',
    }, { provider, sourceFetcher, now: () => '2026-08-25T00:00:00.000Z' });
    assert.ok(result.failures.some((failure) => failure.code === 'community_audit_unavailable'));
    assert.equal(listExternalSkills(database).some((row) => row.skillId === 'github:community/repo:sveltekit-helper'), false);
  } finally {
    database.close();
  }
});

test('persists a successful audit decision with a community import', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-community-audit-pass-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture-community:community/repo:sveltekit-helper', provider: 'fixture-community', name: 'sveltekit-helper', slug: 'sveltekit-helper', source: 'community/repo', sourceType: 'github', installUrl: 'https://github.com/community/repo', installs: 10, duplicate: false, officialStatus: 'registry-only',
  };
  const provider: SkillRegistryProvider = {
    id: 'fixture-community',
    async search() { return { provider: 'fixture-community', experimental: true, candidates: [candidate] }; },
    async audit() { return { status: 'passed' }; },
  };
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint: { repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'SvelteKit', version: '2' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: '@sveltejs/kit', version: '2' }], manifestDigest: 'digest' },
      task: 'Build a SvelteKit component', profile: { taskType: 'build' as const, target: 'SvelteKit component', expected: 'tests pass', constraints: null }, recommendedTags: ['sveltekit'], capabilities: [], mode: 'community',
    }, {
      provider,
      sourceFetcher: { async fetch(value: SkillCandidate) {
        if (value.id !== candidate.id) throw new SkillSourceError('candidate_not_found_at_source');
        return validateSkillSnapshot({ candidate: value, sourceCommit: COMMIT, files: [{ path: 'skills/sveltekit-helper/SKILL.md', content: '---\nname: SvelteKit Helper\ndescription: safe\n---\n# SvelteKit\n\nReference.', primary: true }] });
      } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.ok(result.selected.length >= 1);
    assert.equal(listExternalSkills(database).find((row) => row.skillId === 'github:community/repo:sveltekit-helper')?.auditStatus, 'passed');
  } finally {
    database.close();
  }
});
