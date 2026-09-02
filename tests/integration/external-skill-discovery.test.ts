import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { curatorCandidateForEntry, globalizeCuratorCandidate } from '../../src/memory/curator.js';
import { readEntry } from '../../src/memory/entries.js';
import { discoverSkills } from '../../src/skills/discovery-service.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { importSkillSnapshot, listExternalSkills, markExternalSkillRefreshFailure, setExternalSkillState } from '../../src/skills/store.js';
import { SkillSourceError } from '../../src/skills/source/github-fetcher.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillMaterializationAuthorization } from '../../src/skills/types.js';

const fingerprint = {
  repositoryId: 'repo-svelte',
  languages: ['JavaScript', 'TypeScript'],
  frameworks: [{ name: 'SvelteKit', version: '2' }],
  databases: [],
  runtimes: ['Node.js'],
  tools: [],
  packages: [{ name: '@sveltejs/kit', version: '2' }],
  manifestDigest: 'fingerprint',
};

const COMMIT_A = 'd'.repeat(40);
const COMMIT_B = 'e'.repeat(40);

function response(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }); }
function textResponse(value: string): Response { return new Response(value, { status: 200, headers: { 'content-type': 'text/plain' } }); }

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

test('discovers, imports, reuses, and disables an external skill snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  let searchCalls = 0;
  let sourceCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'skills.sh') {
      searchCalls += 1;
      return response({ skills: [{ id: 'sveltejs/ai-tools/svelte-code-writer', source: 'sveltejs/ai-tools', name: 'svelte-code-writer', installs: 3 }] });
    }
    sourceCalls += 1;
    if (url.pathname === '/repos/sveltejs/ai-tools') return response({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return response({ sha: COMMIT_A });
    if (url.pathname.includes(`/git/trees/${COMMIT_A}`)) return response({ truncated: false, tree: [
      { type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' },
      { type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/references/lookup.md' },
    ] });
    if (url.pathname.endsWith('/SKILL.md')) return textResponse('---\nname: Svelte Code Writer\ndescription: Safe Svelte references\n---\n# Usage\n\nUse current repository evidence.');
    if (url.pathname.endsWith('/lookup.md')) return textResponse('# Lookup\n\nCheck the official Svelte documentation.');
    throw new Error(`unexpected fixture URL: ${url.pathname}`);
  };
  try {
    const input = {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint,
      task: 'Implement a SvelteKit component',
      profile: { taskType: 'build' as const, target: 'SvelteKit component', expected: 'tests pass', constraints: null },
      recommendedTags: ['sveltekit'],
      capabilities: [{ kind: 'skill', name: 'kiokuko-ui-design-soul' }],
      mode: 'official' as const,
      fetchImpl,
    };
    const first = await discoverSkills(database, input, { now: () => '2026-08-25T00:00:00.000Z' });
    assert.equal(first.selected.length, 1);
    assert.equal(first.selected[0]?.imported, true);
    const importedSkillId = first.selected[0]!.skillId;
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 2);
    const sourceCallsAfterFirst = sourceCalls;
    database.prepare('DELETE FROM skill_discovery_cache').run();
    let unexpectedNetworkCalls = 0;
    const second = await discoverSkills(database, { ...input, fetchImpl: async () => { unexpectedNetworkCalls += 1; throw new Error('fresh imports must be checked before network access'); } }, { now: () => '2026-08-25T01:00:00.000Z' });
    assert.equal(second.selected[0]?.imported, true);
    assert.equal(second.attempted, false);
    assert.equal(unexpectedNetworkCalls, 0);
    assert.equal(searchCalls, 3);
    assert.equal(sourceCalls, sourceCallsAfterFirst);
    database.prepare("UPDATE external_skills SET first_seen_at = '2026-08-01T00:00:00.000Z', last_seen_at = '2026-08-01T00:00:00.000Z', last_checked_at = '2026-08-01T00:00:00.000Z'").run();
    database.prepare('DELETE FROM skill_discovery_cache').run();
    const rateLimited = await discoverSkills(database, { ...input, fetchImpl: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === 'skills.sh') return response({ skills: [{ id: 'sveltejs/ai-tools/svelte-code-writer', source: 'sveltejs/ai-tools', name: 'svelte-code-writer', installs: 3 }] });
      return new Response(null, { status: 429 });
    } }, { now: () => '2026-09-02T00:00:00.000Z' });
    assert.ok(rateLimited.failures.some((failure) => failure.code === 'source_rate_limited' && failure.stage === 'source'));
    const row = listExternalSkills(database).find((skill) => skill.skillId === importedSkillId);
    assert.equal(row?.state, 'imported');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE active = 1').get<{ count: number }>()?.count, 2);
    assert.ok(row);
    const mapping = database.prepare('SELECT entry_id, entry_revision FROM external_skill_entries WHERE skill_id = ? ORDER BY source_path, chunk_index LIMIT 1').get<{ entry_id: string; entry_revision: number }>(row.skillId);
    assert.ok(mapping);
    const externalEntry = readEntry(database, { workspace: row.sourceWorkspace, entryId: mapping!.entry_id });
    assert.throws(
      () => curatorCandidateForEntry(database, { workspace: row.sourceWorkspace, entryId: externalEntry.id }),
      /not a curator candidate/u,
    );
    assert.throws(
      () => globalizeCuratorCandidate(database, { workspace: row.sourceWorkspace, entryId: externalEntry.id, expectedRevision: externalEntry.revision }),
      /External skill references cannot/u,
    );
    setExternalSkillState(database, row.skillId, 'disabled', '2026-08-25T02:00:00.000Z');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE active = 1').get<{ count: number }>()?.count, 0);
    setExternalSkillState(database, row.skillId, 'imported', '2026-08-25T03:00:00.000Z');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE active = 1').get<{ count: number }>()?.count, 2);
    const enabled = listExternalSkills(database).find((skill) => skill.skillId === row.skillId)!;
    markExternalSkillRefreshFailure(database, row.skillId, 'stale', { generation: enabled.generation, sourceCommit: enabled.sourceCommit, snapshotHash: enabled.snapshotHash, state: enabled.state, lastCheckedAt: enabled.lastCheckedAt }, '2026-08-25T04:00:00.000Z');
    assert.throws(
      () => setExternalSkillState(database, row.skillId, 'imported', '2026-08-25T05:00:00.000Z'),
      /verified snapshot can be enabled/u,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE active = 1').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('canonicalizes one verified primary path when an initial registry slug is stale', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-canonical-discovery-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const staleCandidate: SkillCandidate = {
    id: 'fixture:owner/repo:svelte-legacy', provider: 'fixture', name: 'svelte-legacy', slug: 'svelte-legacy', source: 'owner/repo', sourceType: 'github', installUrl: 'https://github.com/owner/repo', installs: 1, duplicate: false, officialStatus: 'registry-only',
  };
  let rawFetches = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/repos/owner/repo') return response({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return response({ sha: COMMIT_A });
    if (url.pathname.includes(`/git/trees/${COMMIT_A}`)) return response({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-helper/SKILL.md' }] });
    if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('/skills/svelte-helper/SKILL.md')) {
      rawFetches += 1;
      return textResponse('---\nname: svelte-helper\ndescription: safe\n---\n# Svelte Helper\n\nReference.');
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint,
      task: 'Implement a SvelteKit component',
      profile: { taskType: 'build', target: 'SvelteKit component', expected: 'tests pass', constraints: null },
      recommendedTags: ['sveltekit'], capabilities: [], mode: 'community',
    }, {
      provider: {
        id: staleCandidate.provider,
        async search() { return { provider: staleCandidate.provider, experimental: false, candidates: [staleCandidate] }; },
        async audit() { return { status: 'passed' }; },
      },
      fetchImpl,
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(result.failures.length, 0, JSON.stringify(result));
    assert.equal(result.selected.length, 1);
    assert.equal(rawFetches, 1);
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.slug, 'svelte-helper');
    assert.equal(rows[0]?.provider, staleCandidate.provider);
    assert.equal(rows[0]?.state, 'imported');
  } finally {
    database.close();
  }
});

test('marks a newly discovered registry row stale when the source path is gone', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-stale-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint,
      task: 'Implement a SvelteKit component',
      profile: { taskType: 'build', target: 'SvelteKit component', expected: 'tests pass', constraints: null },
      recommendedTags: ['sveltekit'], capabilities: [], mode: 'official',
    }, {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [{ id: 'fixture:sveltejs/ai-tools:svelte-code-writer', provider: 'fixture', name: 'svelte-code-writer', slug: 'svelte-code-writer', source: 'sveltejs/ai-tools', sourceType: 'github', installUrl: 'https://github.com/sveltejs/ai-tools', installs: 1, duplicate: false, officialStatus: 'catalog-verified' }] }; } },
      sourceFetcher: { async fetch() { throw new SkillSourceError('candidate_not_found_at_source'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.ok(result.failures.some((failure) => failure.code === 'candidate_not_found_at_source'));
    assert.ok(listExternalSkills(database).length > 0);
    assert.ok(listExternalSkills(database).every((skill) => skill.state === 'stale'));
  } finally {
    database.close();
  }
});

test('does not replace a stale registry candidate with a fabricated catalog candidate', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-direct-fallback-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const staleCandidate = { id: 'fixture:sveltejs/ai-tools:obsolete-helper', provider: 'fixture', name: 'svelte-helper', slug: 'obsolete-helper', source: 'sveltejs/ai-tools', sourceType: 'github' as const, installUrl: 'https://github.com/sveltejs/ai-tools', installs: 10_000, duplicate: false, officialStatus: 'registry-only' as const };
  const fetched: string[] = [];
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' }, fingerprint,
      task: 'Implement a SvelteKit component', profile: { taskType: 'build', target: 'SvelteKit component', expected: 'tests pass', constraints: null }, recommendedTags: ['sveltekit'], capabilities: [], mode: 'official',
    }, {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [staleCandidate] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(candidate) { fetched.push(candidate.slug); throw new SkillSourceError('candidate_not_found_at_source'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(result.selected.length, 0);
    assert.deepEqual(fetched, ['obsolete-helper']);
    assert.equal(listExternalSkills(database)[0]?.state, 'stale');
  } finally {
    database.close();
  }
});

test('does not reuse a reviewed skill across incompatible persisted applicability', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-requirement-identity-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const reviewedCandidate = { id: 'fixture:sveltejs/ai-tools:svelte-code-writer', provider: 'fixture', name: 'svelte-code-writer', slug: 'svelte-code-writer', source: 'sveltejs/ai-tools', sourceType: 'github' as const, installUrl: 'https://github.com/sveltejs/ai-tools', installs: 1, duplicate: false, officialStatus: 'catalog-verified' as const };
  try {
    const first = await discoverSkills(database, {
      project: { workspace: 'workspace:sveltekit', repositoryRoot: directory, repositoryId: 'repo-sveltekit' }, fingerprint,
      task: 'Implement a SvelteKit component', profile: { taskType: 'build', target: 'SvelteKit component', expected: 'tests pass', constraints: null }, recommendedTags: ['sveltekit'], capabilities: [], mode: 'official',
    }, {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedCandidate] }; } },
      sourceFetcher: { async fetch(candidate) { return validateSkillSnapshot({ candidate, sourceCommit: COMMIT_A, files: [{ path: 'tools/skills/svelte-code-writer/SKILL.md', content: '---\nname: Svelte Code Writer\ndescription: safe\n---\n# SvelteKit\n\nReference.', primary: true }] }); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(first.selected.length, 1);
    let sourceCalls = 0;
    const second = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint: { repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'Svelte', version: '5' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'svelte', version: '5' }], manifestDigest: 'svelte' },
      task: 'Implement a Svelte component', profile: { taskType: 'build', target: 'Svelte component', expected: 'tests pass', constraints: null }, recommendedTags: ['svelte'], capabilities: [], mode: 'official',
    }, {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedCandidate] }; } },
      sourceFetcher: { async fetch(candidate) { sourceCalls += 1; return validateSkillSnapshot({ candidate, sourceCommit: COMMIT_B, files: [{ path: 'tools/skills/svelte-code-writer/SKILL.md', content: '---\nname: Svelte Code Writer\ndescription: safe\n---\n# Svelte\n\nReference.', primary: true }] }); } },
      now: () => '2026-08-25T01:00:00.000Z',
    });
    assert.equal(second.attempted, true);
    assert.equal(second.selected.length, 1);
    assert.equal(sourceCalls, 1);
    assert.equal(listExternalSkills(database).length, 1);
  } finally {
    database.close();
  }
});

test('community mode reuses a shared audited snapshot for every learned requirement identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-shared-requirements-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const sharedCandidate = { id: 'fixture:sveltejs/ai-tools:shared-svelte', provider: 'fixture', name: 'shared-svelte', slug: 'shared-svelte', source: 'sveltejs/ai-tools', sourceType: 'github' as const, installUrl: 'https://github.com/sveltejs/ai-tools', installs: 1, duplicate: false, officialStatus: 'registry-only' as const, auditStatus: 'passed' as const };
  const shared = validateSkillSnapshot({ candidate: sharedCandidate, sourceCommit: COMMIT_A, files: [{ path: 'skills/shared-svelte/SKILL.md', content: '---\nname: Shared Svelte\ndescription: safe\n---\n# Shared Svelte\n\nReference.', primary: true }] });
  const svelteKitRequirement = {
    id: 'sveltekit', technology: 'sveltekit', aliases: ['sveltekit', 'svelte'], queries: ['sveltekit'], owners: ['sveltejs'], repositories: ['sveltejs/ai-tools'],
    applicability: { frameworks: [{ name: 'SvelteKit' }] }, signals: { packages: ['@sveltejs/kit'] }, reason: 'fixture',
  };
  try {
    const authorization = await passedAuditAuthorization(shared.candidate);
    const imported = importSkillSnapshot(database, shared, documentsFromSkillSnapshot(shared), svelteKitRequirement, '2026-08-25T00:00:00.000Z', authorization);
    const svelteInput = {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint: { repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'Svelte', version: '5' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'svelte', version: '5' }], manifestDigest: 'svelte' },
      task: 'Implement a Svelte component', profile: { taskType: 'build' as const, target: 'Svelte component', expected: 'tests pass', constraints: null }, recommendedTags: ['svelte'], capabilities: [], mode: 'community' as const,
    };
    const learned = await discoverSkills(database, svelteInput, {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [{ ...sharedCandidate, id: 'fixture:sveltejs/ai-tools:svelte', name: 'svelte', slug: 'svelte' }] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(candidate) { return validateSkillSnapshot({ candidate, sourceCommit: shared.sourceCommit, files: shared.files.map((file) => ({ path: file.path, content: file.content, primary: file.primary })) }); } },
      now: () => '2026-08-25T01:00:00.000Z',
    });
    assert.equal(learned.selected[0]?.skillId, imported.skillId);
    assert.equal(listExternalSkills(database).length, 1);

    let networkCalls = 0;
    const reused = await discoverSkills(database, {
      project: { workspace: 'workspace:sveltekit', repositoryRoot: directory, repositoryId: 'repo-sveltekit' }, fingerprint,
      task: 'Implement a SvelteKit component', profile: { taskType: 'build', target: 'SvelteKit component', expected: 'tests pass', constraints: null }, recommendedTags: ['sveltekit'], capabilities: [], mode: 'community',
    }, {
      provider: { id: 'unused', async search() { networkCalls += 1; throw new Error('merged requirement must reuse the fresh snapshot'); } },
      sourceFetcher: { async fetch() { networkCalls += 1; throw new Error('merged requirement must reuse the fresh snapshot'); } },
      now: () => '2026-08-25T02:00:00.000Z',
    });
    assert.equal(reused.attempted, false);
    assert.equal(reused.selected[0]?.skillId, imported.skillId);
    assert.equal(networkCalls, 0);
  } finally {
    database.close();
  }
});

test('does not bypass a disabled Svelte alias by canonicalizing it to the reviewed skill path', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-disabled-svelte-alias-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const alias: SkillCandidate = {
    id: 'manual:sveltejs/ai-tools:svelte',
    provider: 'manual',
    name: 'svelte',
    slug: 'svelte',
    source: 'sveltejs/ai-tools',
    sourceType: 'github',
    installUrl: 'https://github.com/sveltejs/ai-tools',
    installs: 1,
    duplicate: false,
    officialStatus: 'registry-only',
  };
  const aliasSnapshot = validateSkillSnapshot({
    candidate: alias,
    sourceCommit: COMMIT_A,
    files: [{
      path: 'skills/svelte/SKILL.md',
      content: '---\nname: Svelte Alias\ndescription: safe alias fixture\n---\n# Svelte Alias\n\nReference.',
      primary: true,
    }],
  });
  const svelteRequirement = {
    id: 'svelte', technology: 'svelte', aliases: ['svelte'], queries: ['svelte'], owners: ['sveltejs'], repositories: ['sveltejs/ai-tools'],
    applicability: { frameworks: [{ name: 'Svelte' }] }, signals: { packages: ['svelte'] }, reason: 'fixture',
  };
  try {
    const authorization = await passedAuditAuthorization(aliasSnapshot.candidate);
    const imported = importSkillSnapshot(database, aliasSnapshot, documentsFromSkillSnapshot(aliasSnapshot), svelteRequirement, '2026-08-25T00:00:00.000Z', authorization);
    setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T01:00:00.000Z');

    let sourceCalls = 0;
    const providerAlias: SkillCandidate = { ...alias, id: 'fixture:sveltejs/ai-tools:svelte', provider: 'fixture' };
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint: {
        repositoryId: 'repo-svelte', languages: ['JavaScript'], frameworks: [{ name: 'Svelte', version: '5' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'svelte', version: '5' }], manifestDigest: 'svelte',
      },
      task: 'Implement a Svelte component',
      profile: { taskType: 'build', target: 'Svelte component', expected: 'tests pass', constraints: null },
      recommendedTags: ['svelte'], capabilities: [], mode: 'official',
    }, {
      provider: {
        id: 'fixture',
        async search() { return { provider: 'fixture', experimental: false, candidates: [providerAlias] }; },
        async audit() { return { status: 'passed' }; },
      },
      sourceFetcher: {
        async fetch(candidate) {
          sourceCalls += 1;
          return validateSkillSnapshot({
            candidate,
            sourceCommit: COMMIT_B,
            files: [{
              path: 'skills/svelte-code-writer/SKILL.md',
              content: '---\nname: Svelte Code Writer\ndescription: reviewed canonical fixture\n---\n# Svelte Code Writer\n\nReference.',
              primary: true,
            }],
          });
        },
      },
      now: () => '2026-08-25T02:00:00.000Z',
    });

    assert.equal(result.selected.length, 0);
    assert.equal(sourceCalls, 0);
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.skillId, imported.skillId);
    assert.equal(rows[0]?.slug, 'svelte');
    assert.equal(rows[0]?.state, 'disabled');
    assert.equal(rows.some((row) => row.slug === 'svelte-code-writer'), false);
  } finally {
    database.close();
  }
});

test('does not re-import a disabled canonical skill through a different provider and alias slug', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-provider-switch-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const laravelFingerprint = { repositoryId: 'repo-laravel', languages: ['PHP'], frameworks: [{ name: 'Laravel', version: '13' }], databases: [], runtimes: ['PHP'], tools: [], packages: [{ name: 'laravel/framework', version: '13' }], manifestDigest: 'laravel' };
  const input = { project: { workspace: 'workspace:laravel', repositoryRoot: directory, repositoryId: 'repo-laravel' }, fingerprint: laravelFingerprint, task: 'Build a Laravel endpoint', profile: { taskType: 'build' as const, target: 'Laravel endpoint', expected: 'tests pass', constraints: null }, recommendedTags: ['laravel'], capabilities: [], mode: 'official' as const };
  const oldCandidate = { id: 'old:laravel/boost:laravel', provider: 'old', name: 'laravel', slug: 'laravel', source: 'laravel/boost', sourceType: 'github' as const, installUrl: 'https://github.com/laravel/boost', installs: 1, duplicate: false, officialStatus: 'registry-only' as const };
  try {
    const first = await discoverSkills(database, input, {
      provider: { id: 'old', async search() { return { provider: 'old', experimental: false, candidates: [oldCandidate] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(candidate) { return validateSkillSnapshot({ candidate, sourceCommit: COMMIT_A, files: [{ path: 'skills/laravel-helper/SKILL.md', content: '---\nname: Laravel Helper\ndescription: safe\n---\n# Laravel\n\nReference.', primary: true }] }); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(first.selected.length, 1);
    setExternalSkillState(database, listExternalSkills(database)[0]!.skillId, 'disabled', '2026-08-25T01:00:00.000Z');
    let sourceCalls = 0;
    const newCandidate = { ...oldCandidate, id: 'new:laravel/boost:laravel', provider: 'new' };
    const second = await discoverSkills(database, input, {
      provider: { id: 'new', async search() { return { provider: 'new', experimental: false, candidates: [newCandidate] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(candidate) { sourceCalls += 1; return validateSkillSnapshot({ candidate, sourceCommit: COMMIT_B, files: [{ path: 'skills/laravel-helper/SKILL.md', content: '---\nname: Laravel Helper\ndescription: safe\n---\n# Laravel\n\nChanged reference.', primary: true }] }); } },
      now: () => '2026-08-25T02:00:00.000Z',
    });
    assert.equal(second.selected.length, 0);
    assert.equal(sourceCalls, 0);
    assert.equal(listExternalSkills(database).length, 1);
    assert.equal(listExternalSkills(database)[0]?.state, 'disabled');
  } finally {
    database.close();
  }
});

test('refreshes an existing source identity instead of duplicating it after a provider switch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-provider-refresh-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const laravelFingerprint = { repositoryId: 'repo-laravel', languages: ['PHP'], frameworks: [{ name: 'Laravel', version: '13' }], databases: [], runtimes: ['PHP'], tools: [], packages: [{ name: 'laravel/framework', version: '13' }], manifestDigest: 'laravel' };
  const input = { project: { workspace: 'workspace:laravel', repositoryRoot: directory, repositoryId: 'repo-laravel' }, fingerprint: laravelFingerprint, task: 'Build a Laravel endpoint', profile: { taskType: 'build' as const, target: 'Laravel endpoint', expected: 'tests pass', constraints: null }, recommendedTags: ['laravel'], capabilities: [], mode: 'official' as const };
  const oldCandidate = { id: 'old:laravel/boost:laravel', provider: 'old', name: 'laravel', slug: 'laravel', source: 'laravel/boost', sourceType: 'github' as const, installUrl: 'https://github.com/laravel/boost', installs: 1, duplicate: false, officialStatus: 'registry-only' as const };
  try {
    const first = await discoverSkills(database, input, {
      provider: { id: 'old', async search() { return { provider: 'old', experimental: false, candidates: [oldCandidate] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(candidate) { return validateSkillSnapshot({ candidate, sourceCommit: COMMIT_A, files: [{ path: 'laravel/SKILL.md', content: '---\nname: Laravel\ndescription: safe\n---\n# Laravel\n\nReference.', primary: true }] }); } },
      now: () => '2026-08-01T00:00:00.000Z',
    });
    const oldSkillId = first.selected[0]!.skillId;
    const newCandidate = { ...oldCandidate, id: 'new:laravel/boost:laravel', provider: 'new', installs: 2 };
    const second = await discoverSkills(database, input, {
      provider: { id: 'new', async search() { return { provider: 'new', experimental: false, candidates: [newCandidate] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(candidate) { return validateSkillSnapshot({ candidate, sourceCommit: COMMIT_B, files: [{ path: 'laravel/SKILL.md', content: '---\nname: Laravel\ndescription: safe\n---\n# Laravel\n\nUpdated reference.', primary: true }] }); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(second.selected[0]?.skillId, oldSkillId);
    assert.equal(listExternalSkills(database).length, 1);
    assert.equal(listExternalSkills(database)[0]?.provider, 'new');
    assert.equal(listExternalSkills(database)[0]?.sourceCommit, COMMIT_B);
  } finally {
    database.close();
  }
});

test('never auto-imports a duplicate candidate even when its owner is official', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-duplicate-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  let sourceCalls = 0;
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:react', repositoryRoot: directory, repositoryId: 'repo-react' },
      fingerprint: { repositoryId: 'repo-react', languages: ['JavaScript'], frameworks: [{ name: 'React', version: '19' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'react', version: '19' }], manifestDigest: 'react' },
      task: 'Build a React component', profile: { taskType: 'build', target: 'React component', expected: 'tests pass', constraints: null }, recommendedTags: ['react'], capabilities: [], mode: 'official',
    }, {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [{ id: 'fixture:facebook/skills:react', provider: 'fixture', name: 'react', slug: 'react', source: 'facebook/skills', sourceType: 'github', installUrl: 'https://github.com/facebook/skills', installs: 1_000_000, duplicate: true, officialStatus: 'registry-only' }] }; } },
      sourceFetcher: { async fetch() { sourceCalls += 1; throw new Error('duplicate must not be fetched'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(result.selected.length, 0);
    assert.equal(sourceCalls, 0);
    assert.equal(listExternalSkills(database).length, 0);
  } finally {
    database.close();
  }
});
