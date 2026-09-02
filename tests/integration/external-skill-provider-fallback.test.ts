import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { discoverSkills } from '../../src/skills/discovery-service.js';
import { listExternalSkills } from '../../src/skills/store.js';

const COMMIT = 'd'.repeat(40);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function useExpiredV1Token(): () => void {
  const previousToken = process.env.KIOKUKO_SKILLS_V1_TOKEN;
  const previousUrl = process.env.KIOKUKO_SKILLS_API_URL;
  process.env.KIOKUKO_SKILLS_V1_TOKEN = 'expired-token-sentinel';
  process.env.KIOKUKO_SKILLS_API_URL = 'https://skills.sh';
  return () => {
    if (previousToken === undefined) delete process.env.KIOKUKO_SKILLS_V1_TOKEN; else process.env.KIOKUKO_SKILLS_V1_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.KIOKUKO_SKILLS_API_URL; else process.env.KIOKUKO_SKILLS_API_URL = previousUrl;
  };
}

test('keeps fallback search caches separate and never audits a noncatalog result through the failed primary provider', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-v1-auth-fallback-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const restore = useExpiredV1Token();
  const registryRequests: Array<{ path: string; query: string; owner: string | null; limit: string | null }> = [];
  let v1Searches = 0;
  let compatibilitySearches = 0;
  let auditRequests = 0;
  let sourceFetches = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'skills.sh') {
      if (url.pathname === '/api/v1/skills/audit/facebook/react-skills/react-guidance') {
        auditRequests += 1;
        return json({
          id: 'facebook/react-skills/react-guidance', source: 'facebook/react-skills', slug: 'react-guidance',
          audits: [{ provider: 'fixture', slug: 'fixture', status: 'pass', riskLevel: 'LOW', summary: 'Safe fixture.', auditedAt: '2026-08-25T00:00:00.000Z' }],
        });
      }
      registryRequests.push({
        path: url.pathname,
        query: url.searchParams.get('q') ?? '',
        owner: url.searchParams.get('owner'),
        limit: url.searchParams.get('limit'),
      });
      if (url.pathname === '/api/v1/skills/search') { v1Searches += 1; return new Response(null, { status: 401 }); }
      if (url.pathname === '/api/search') {
        compatibilitySearches += 1;
        return json({
          skills: [{
            id: 'facebook/react-skills/react-guidance',
            name: 'React Guidance',
            installs: 1,
            source: 'facebook/react-skills',
          }],
        });
      }
      throw new Error(`unexpected registry URL: ${url.pathname}`);
    }
    if (url.pathname === '/repos/facebook/react-skills') { sourceFetches += 1; return json({ default_branch: 'main' }); }
    if (url.pathname.endsWith('/commits/main')) return json({ sha: COMMIT });
    if (url.pathname.includes(`/git/trees/${COMMIT}`)) return json({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/react-guidance/SKILL.md' }] });
    if (url.hostname === 'raw.githubusercontent.com') return new Response('---\nname: React Guidance\ndescription: Safe React reference\n---\n# React\n\nReference only.', { status: 200 });
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  const input = {
    project: { workspace: 'workspace:react', repositoryRoot: directory, repositoryId: 'repo-react' },
    fingerprint: { repositoryId: 'repo-react', languages: ['JavaScript'], frameworks: [{ name: 'React', version: '19' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'react', version: '19' }], manifestDigest: 'react' },
    task: 'Build a React component',
    profile: { taskType: 'build' as const, target: 'React component', expected: 'tests pass', constraints: null },
    recommendedTags: ['react'],
    capabilities: [],
    mode: 'official' as const,
    fetchImpl,
  };
  try {
    const first = await discoverSkills(database, input);
    assert.deepEqual(registryRequests.map((request) => request.path), [
      '/api/v1/skills/search', '/api/search',
      '/api/v1/skills/search', '/api/search',
    ]);
    for (let index = 0; index < registryRequests.length; index += 2) {
      const primary = registryRequests[index]!;
      const fallback = registryRequests[index + 1]!;
      assert.deepEqual(
        { query: fallback.query, owner: fallback.owner, limit: fallback.limit },
        { query: primary.query, owner: primary.owner, limit: primary.limit },
      );
      assert.equal(primary.owner, 'facebook');
      assert.equal(primary.limit, '20');
    }
    assert.equal(first.selected.length, 0, JSON.stringify(first));
    assert.equal(auditRequests, 0);
    assert.equal(sourceFetches, 0);
    assert.ok(first.failures.some((failure) => failure.code === 'community_audit_unavailable'));
    const cacheRows = database.prepare('SELECT provider, query_text AS queryText, owner, mode, outcome, response_json FROM skill_discovery_cache ORDER BY provider, query_text').all<{ provider: string; queryText: string; owner: string | null; mode: string; outcome: string; response_json: string }>();
    assert.ok(cacheRows.some((row) => row.provider === 'skills-sh-v1' && row.outcome === 'unavailable' && JSON.parse(row.response_json).failureCode === 'registry_authentication_failed'));
    assert.ok(cacheRows.some((row) => /^skills-sh-compat-[0-9a-f]{16}$/u.test(row.provider) && row.outcome === 'success'));
    const v1Rows = cacheRows.filter((row) => row.provider === 'skills-sh-v1');
    const compatibilityRows = cacheRows.filter((row) => /^skills-sh-compat-[0-9a-f]{16}$/u.test(row.provider));
    assert.equal(v1Rows.length, compatibilityRows.length);
    for (const row of v1Rows) {
      assert.ok(compatibilityRows.some((candidate) => candidate.queryText === row.queryText && candidate.owner === row.owner && candidate.mode === row.mode));
    }

    assert.equal(listExternalSkills(database).length, 0);
  } finally {
    restore();
    database.close();
  }
});

test('imports an exact reviewed-catalog compatibility result without calling the failed primary audit endpoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-v1-direct-dedup-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const restore = useExpiredV1Token();
  let sourceFetches = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/skills/search') return new Response(null, { status: 401 });
    if (url.pathname === '/api/search') return json({
      skills: [{
        id: 'sveltejs/ai-tools/svelte-code-writer',
        name: 'Svelte Code Writer',
        installs: 1,
        source: 'sveltejs/ai-tools',
      }],
    });
    if (url.pathname === '/repos/sveltejs/ai-tools') { sourceFetches += 1; return json({ default_branch: 'main' }); }
    if (url.pathname.endsWith('/commits/main')) return json({ sha: COMMIT });
    if (url.pathname.includes(`/git/trees/${COMMIT}`)) return json({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }] });
    if (url.hostname === 'raw.githubusercontent.com') return new Response('---\nname: Svelte Code Writer\ndescription: Safe Svelte reference\n---\n# Svelte\n\nReference only.', { status: 200 });
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:svelte-dedup', repositoryRoot: directory, repositoryId: 'repo-svelte-dedup' },
      fingerprint: { repositoryId: 'repo-svelte-dedup', languages: ['JavaScript'], frameworks: [{ name: 'Svelte', version: '5' }], databases: [], runtimes: ['Node.js'], tools: [], packages: [{ name: 'svelte', version: '5' }], manifestDigest: 'svelte' },
      task: 'Build a Svelte component',
      profile: { taskType: 'build', target: 'Svelte component', expected: 'tests pass', constraints: null },
      recommendedTags: ['svelte'],
      capabilities: [],
      mode: 'official',
      fetchImpl,
    });
    assert.equal(result.selected.length, 1, JSON.stringify(result));
    assert.equal(sourceFetches, 1);
    assert.equal(listExternalSkills(database).length, 1);
  } finally {
    restore();
    database.close();
  }
});
