import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { SkillsShCompatibilityProvider } from '../../src/skills/providers/skills-sh-compat.js';
import { SkillsShV1Provider } from '../../src/skills/providers/skills-sh-v1.js';
import { parseSkillCandidates, SkillProviderError } from '../../src/skills/providers/schema.js';
import { findSkills } from '../../src/skills/find.js';
import type { SkillCandidate } from '../../src/skills/types.js';

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function rawJson(value: string): Response {
  return new Response(value, { headers: { 'content-type': 'application/json' } });
}

function compatSkill(source: string, skillId: string, overrides: Record<string, unknown> = {}) {
  return { id: `${source}/${skillId}`, skillId, name: skillId, installs: 1, source, ...overrides };
}

function compatResponse(skills: unknown[], query = 'svelte') {
  return { query, searchType: query.includes(' ') ? 'semantic' : 'fuzzy', skills, count: skills.length, duration_ms: 1 };
}

function v1Skill(source: string, slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `${source}/${slug}`,
    slug,
    name: slug,
    source,
    installs: 1,
    sourceType: 'github',
    installUrl: `https://github.com/${source}`,
    url: `https://skills.sh/${source}/${slug}`,
    ...overrides,
  };
}

test('validates the current compatibility envelope without spawning npx', async () => {
  let seen = '';
  const provider = new SkillsShCompatibilityProvider({
    apiUrl: 'https://skills.sh',
    fetchImpl: async (input, init) => {
      seen = String(input);
      assert.equal(init?.redirect, 'manual');
      return json(compatResponse([compatSkill('sveltejs/ai-tools', 'svelte-code-writer', { installs: 12 })]));
    },
  });
  const result = await provider.search({ query: 'svelte', limit: 20 });
  assert.match(seen, /\/api\/search\?q=svelte/u);
  assert.equal(result.candidates[0]?.source, 'sveltejs/ai-tools');
  assert.equal(result.candidates[0]?.slug, 'svelte-code-writer');
  assert.equal(result.candidates[0]?.installUrl, 'https://github.com/sveltejs/ai-tools');
});

test('accepts the explicitly documented minimal compatibility envelope', async () => {
  const provider = new SkillsShCompatibilityProvider({ fetchImpl: async () => json({ skills: [
    { id: 'sveltejs/ai-tools/svelte-code-writer', name: 'svelte-code-writer', installs: 12, source: 'sveltejs/ai-tools' },
  ] }) });
  const result = await provider.search({ query: 'svelte', limit: 20 });
  assert.equal(result.candidates[0]?.slug, 'svelte-code-writer');
});

test('requires canonical ASCII source casing in compatibility result identities', async () => {
  const provider = new SkillsShCompatibilityProvider({ fetchImpl: async () => json({ skills: [
    { id: 'COMMUNITY/REPO/safe', name: 'safe', installs: 1, source: 'community/repo' },
  ] }) });
  await assert.rejects(
    () => provider.search({ query: 'svelte', limit: 20 }),
    (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response',
  );
});

test('rejects duplicate raw JSON keys at every provider envelope depth', async () => {
  const token = 'test-token-123456789';
  const auditCandidate: SkillCandidate = {
    id: 'v1:community/repo:safe', provider: 'skills-sh-v1', name: 'safe', slug: 'safe', source: 'community/repo',
    sourceType: 'github', installUrl: null, installs: 1, duplicate: false, officialStatus: 'unknown',
  };
  const operations: Array<() => Promise<unknown>> = [
    () => new SkillsShCompatibilityProvider({ fetchImpl: async () => rawJson('{"skills":[],"skills":[]}') }).search({ query: 'svelte', limit: 20 }),
    () => new SkillsShCompatibilityProvider({ fetchImpl: async () => rawJson('{"skills":[{"id":"community/repo/safe","name":"safe","name":"poison","installs":1,"source":"community/repo"}]}') }).search({ query: 'svelte', limit: 20 }),
    () => new SkillsShV1Provider({ token, fetchImpl: async () => rawJson('{"data":[],"query":"svelte","searchType":"fuzzy","count":0,"count":0,"durationMs":1}') }).search({ query: 'svelte', limit: 20 }),
    () => new SkillsShV1Provider({ token, fetchImpl: async () => rawJson('{"data":[{"id":"community/repo/safe","slug":"safe","slug":"poison","name":"safe","source":"community/repo","installs":1,"sourceType":"github","installUrl":"https://github.com/community/repo","url":"https://skills.sh/community/repo/safe"}],"query":"svelte","searchType":"fuzzy","count":1,"durationMs":1}') }).search({ query: 'svelte', limit: 20 }),
    () => new SkillsShV1Provider({ token, fetchImpl: async () => rawJson('{"id":"community/repo/safe","source":"community/repo","slug":"safe","slug":"poison","audits":[{"provider":"fixture","slug":"fixture","status":"pass","summary":"safe","auditedAt":"2026-08-25T00:00:00.000Z"}]}') }).audit(auditCandidate),
    () => new SkillsShV1Provider({ token, fetchImpl: async () => rawJson('{"id":"community/repo/safe","source":"community/repo","slug":"safe","audits":[{"provider":"fixture","slug":"fixture","status":"pass","status":"fail","summary":"safe","auditedAt":"2026-08-25T00:00:00.000Z"}]}') }).audit(auditCandidate),
  ];
  for (const operation of operations) {
    await assert.rejects(operation(), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response');
  }
});

test('maps bounded strict-JSON syntax failures to an invalid provider response', async () => {
  const invalidBodies = [
    `\uFEFF${JSON.stringify({ skills: [] })}`,
    '{"skills":[],"duration_ms":1e999}',
    `${'['.repeat(129)}null${']'.repeat(129)}`,
  ];
  for (const body of invalidBodies) {
    const provider = new SkillsShCompatibilityProvider({ fetchImpl: async () => rawJson(body) });
    await assert.rejects(
      () => provider.search({ query: 'svelte', limit: 20 }),
      (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response',
    );
  }
});

test('uses the shared skills find operation for validated official-only results', async () => {
  const provider = new SkillsShCompatibilityProvider({
    officialRepositories: ['sveltejs/ai-tools'],
    fetchImpl: async () => json(compatResponse([
      compatSkill('community/repo', 'svelte-helper'),
      compatSkill('sveltejs/ai-tools', 'svelte-code-writer'),
    ])),
  });
  const result = await findSkills({ query: ' Svelte ', limit: 20, officialOnly: true }, { provider });
  assert.deepEqual(result.candidates.map((candidate) => candidate.source), ['sveltejs/ai-tools']);
});

test('does not call a provider for secret, arbitrary, or mismatched catalog scopes', async () => {
  let calls = 0;
  const provider = { id: 'spy', search: async () => { calls += 1; return { provider: 'spy', experimental: false, candidates: [] }; } };
  await assert.rejects(findSkills({ query: `ghp_${'x'.repeat(24)}` }, { provider }), (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION');
  await assert.rejects(findSkills({ query: 'customer repository' }, { provider }), /invalid/iu);
  await assert.rejects(findSkills({ query: 'svelte', owner: 'facebook' }, { provider }), /invalid/iu);
  await assert.rejects(findSkills({ query: 'svelte', limit: 0 }, { provider }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
  assert.equal(calls, 0);
});

test('rejects provider base URLs and repository trust not pinned by the local catalog', () => {
  assert.throws(() => new SkillsShCompatibilityProvider({ apiUrl: 'https://token@skills.sh' }), /invalid/u);
  assert.throws(() => new SkillsShCompatibilityProvider({ apiUrl: 'https://skills.sh/prefix' }), /invalid/u);
  assert.throws(() => new SkillsShCompatibilityProvider({ apiUrl: 'ftp://localhost/' }), /invalid/u);
  assert.throws(() => new SkillsShCompatibilityProvider({ apiUrl: 'file://localhost/' }), /invalid/u);
  assert.throws(() => new SkillsShV1Provider({ apiUrl: 'https://token@skills.sh', token: 'test-token-123456789' }), /invalid/u);
  assert.throws(() => new SkillsShV1Provider({ apiUrl: 'ftp://127.0.0.1/', token: 'test-token-123456789' }), /invalid/u);
  assert.throws(() => new SkillsShV1Provider({ apiUrl: 'http://127.0.0.1/', token: 'test-token-123456789' }), /invalid/u);
  assert.throws(() => new SkillsShV1Provider({ apiUrl: 'https://skills.sh:8443/', token: 'test-token-123456789' }), /invalid/u);
  assert.throws(() => new SkillsShV1Provider({ apiUrl: 'https://example.com/', token: 'test-token-123456789' }), /invalid/u);
  assert.throws(() => new SkillsShCompatibilityProvider({ officialRepositories: ['attacker/repo'] }), /local catalog/u);
});

test('validates v1 bearer tokens before use and keeps them out of object inspection', () => {
  const secret = 'v1-private-token-sentinel';
  const provider = new SkillsShV1Provider({ token: secret });
  assert.equal(Object.keys(provider).includes('token'), false);
  assert.equal(JSON.stringify(provider).includes(secret), false);
  assert.equal(inspect(provider, { showHidden: true }).includes(secret), false);
  for (const invalid of [' token', 'token ', 'token:value', 'token\nvalue', 'token\uFFFD', 'token\ud800']) {
    assert.throws(
      () => new SkillsShV1Provider({ token: invalid }),
      (error: unknown) => error instanceof Error && error.message === 'skills.sh token is invalid',
    );
  }
});

test('rejects unknown fields, invalid names, and partially malformed compatibility arrays as one invalid envelope', async () => {
  const payloads = [
    compatResponse([compatSkill('community/repo', 'safe', { officialStatus: 'curated' })]),
    compatResponse([compatSkill('community/repo', 'safe', { name: 'password = registry-sentinel' })]),
    compatResponse([compatSkill('community/repo', 'safe', { name: 'safe\u202Emoc' })]),
    compatResponse([compatSkill('community/repo', 'safe', { name: 'broken\ud800name' })]),
    compatResponse([compatSkill('community/repo', 'safe', { name: 'replacement\uFFFDname' })]),
    compatResponse([compatSkill('community/repo', 'safe'), null]),
    compatResponse([compatSkill('../user', 'safe')]),
  ];
  for (const payload of payloads) {
    const provider = new SkillsShCompatibilityProvider({ fetchImpl: async () => json(payload) });
    await assert.rejects(provider.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response');
  }
});

test('accepts official status only from a locally verified repository catalog', async () => {
  const provider = new SkillsShCompatibilityProvider({
    officialRepositories: ['sveltejs/ai-tools'],
    fetchImpl: async () => json(compatResponse([compatSkill('sveltejs/ai-tools', 'svelte-code-writer')])),
  });
  const result = await provider.search({ query: 'svelte', limit: 20 });
  assert.equal(result.candidates[0]?.officialStatus, 'catalog-verified');
  const unknownPath = new SkillsShCompatibilityProvider({
    officialRepositories: ['sveltejs/ai-tools'],
    fetchImpl: async () => json(compatResponse([compatSkill('sveltejs/ai-tools', 'unreviewed-helper')])),
  });
  assert.equal((await unknownPath.search({ query: 'svelte', limit: 20 })).candidates[0]?.officialStatus, 'registry-only');
});

test('rejects an envelope that violates the requested provider limit', async () => {
  const provider = new SkillsShCompatibilityProvider({
    fetchImpl: async () => json(compatResponse(Array.from({ length: 6 }, (_, index) => compatSkill(`owner/repo-${index}`, `skill-${index}`)))),
  });
  await assert.rejects(provider.search({ query: 'svelte', limit: 5 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response');
});

test('rejects an oversized registry response before parsing candidates', async () => {
  const provider = new SkillsShCompatibilityProvider({ fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '1000001' } }) });
  await assert.rejects(provider.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response');
});

test('requires an explicit JSON media type at the provider boundary', async () => {
  for (const headers of [{}, { 'content-type': 'text/plain' }]) {
    const provider = new SkillsShCompatibilityProvider({ fetchImpl: async () => new Response(JSON.stringify(compatResponse([])), { status: 200, headers }) });
    await assert.rejects(provider.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response');
  }
});

test('parses the documented v1 search shape strictly', async () => {
  const provider = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => json({
    data: [v1Skill('sveltejs/ai-tools', 'svelte-code-writer')], query: 'svelte', searchType: 'fuzzy', count: 1, durationMs: 2,
  }) });
  const result = await provider.search({ query: 'svelte', limit: 20 });
  assert.equal(result.candidates[0]?.source, 'sveltejs/ai-tools');
});

test('requires exact HTTP 200 for compatibility search and every v1 result boundary', async () => {
  const token = 'test-token-123456789';
  const auditCandidate: SkillCandidate = {
    id: 'v1:community/repo:safe',
    provider: 'skills-sh-v1',
    name: 'safe',
    slug: 'safe',
    source: 'community/repo',
    sourceType: 'github',
    installUrl: null,
    installs: 1,
    duplicate: false,
    officialStatus: 'unknown',
  };
  const response = (status: number, body: unknown): Response => status === 204
    ? new Response(null, { status, headers: { 'content-type': 'application/json' } })
    : json(body, status);
  const boundaries: Array<{ name: string; invoke: (status: number) => Promise<unknown> }> = [
    {
      name: 'compatibility search',
      invoke: (status) => new SkillsShCompatibilityProvider({
        fetchImpl: async () => response(status, compatResponse([compatSkill('community/repo', 'safe')])),
      }).search({ query: 'svelte', limit: 20 }),
    },
    {
      name: 'v1 search',
      invoke: (status) => new SkillsShV1Provider({
        token,
        fetchImpl: async () => response(status, {
          data: [v1Skill('community/repo', 'safe')],
          query: 'svelte',
          searchType: 'fuzzy',
          count: 1,
          durationMs: 1,
        }),
      }).search({ query: 'svelte', limit: 20 }),
    },
    {
      name: 'v1 curated',
      invoke: (status) => new SkillsShV1Provider({
        token,
        fetchImpl: async () => response(status, {
          data: [{
            owner: 'community',
            totalInstalls: 1,
            featuredRepo: 'repo',
            featuredSkill: 'safe',
            skills: [v1Skill('community/repo', 'safe')],
          }],
          totalOwners: 1,
          totalSkills: 1,
          generatedAt: '2026-08-25T00:00:00.000Z',
        }),
      }).curated(),
    },
    {
      name: 'v1 audit',
      invoke: (status) => new SkillsShV1Provider({
        token,
        fetchImpl: async () => response(status, {
          id: 'community/repo/safe',
          source: 'community/repo',
          slug: 'safe',
          audits: [{
            provider: 'fixture',
            slug: 'fixture',
            status: 'pass',
            riskLevel: 'LOW',
            summary: 'Safe fixture.',
            auditedAt: '2026-08-25T00:00:00.000Z',
          }],
        }),
      }).audit(auditCandidate),
    },
  ];
  for (const status of [201, 202, 204, 206, 299, 404]) {
    for (const boundary of boundaries) {
      await assert.rejects(
        boundary.invoke(status),
        (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_unavailable',
        `${boundary.name} accepted HTTP ${status}`,
      );
    }
  }
});

test('marks only a strict authenticated curated envelope as curated', async () => {
  const skill = v1Skill('community/repo', 'reviewed-skill');
  const provider = new SkillsShV1Provider({
    token: 'test-token-123456789',
    fetchImpl: async () => json({
      data: [{ owner: 'community', totalInstalls: 1, featuredRepo: 'repo', featuredSkill: 'reviewed-skill', skills: [skill] }],
      totalOwners: 1,
      totalSkills: 1,
      generatedAt: '2026-08-25T00:00:00.000Z',
    }),
  });
  const result = await provider.curated();
  assert.equal(result?.[0]?.officialStatus, 'curated');
  assert.equal(result?.[0]?.installUrl, 'https://github.com/community/repo');
});

test('accepts bounded curated cache sets larger than the search result cap', () => {
  const candidates = Array.from({ length: 21 }, (_, index) => {
    const source = `community/repo-${index}`;
    const slug = `skill-${index}`;
    return {
      id: `skills-sh-v1:${source}:${slug}`,
      provider: 'skills-sh-v1',
      name: slug,
      slug,
      source,
      sourceType: 'github',
      installUrl: `https://github.com/${source}`,
      installs: index,
      duplicate: false,
      officialStatus: 'curated',
    };
  });
  assert.equal(parseSkillCandidates(candidates, 'skills-sh-v1', 'curated').length, 21);
  assert.throws(
    () => parseSkillCandidates(candidates, 'skills-sh-v1', 'search'),
    (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response',
  );
});

test('reports malformed curated and audit responses as typed invalid responses', async () => {
  const curated = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => json({ data: [null], totalOwners: 1, totalSkills: 1, generatedAt: '2026-08-25T00:00:00.000Z' }) });
  await assert.rejects(curated.curated(), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response');
  const audit = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => json({ status: 'passed' }) });
  await assert.rejects(audit.audit({ id: 'v1:community/repo:sveltekit-helper', provider: 'skills-sh-v1', name: 'sveltekit-helper', slug: 'sveltekit-helper', source: 'community/repo', sourceType: 'github', installUrl: null, installs: 1, duplicate: false, officialStatus: 'unknown' }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response');
});

test('rejects malformed audit candidates as provider input before network access', async () => {
  let calls = 0;
  const provider = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => { calls += 1; return json({}); } });
  const base = { id: 'v1:community/repo:sveltekit-helper', provider: 'skills-sh-v1', name: 'sveltekit-helper', slug: 'sveltekit-helper', source: 'community/repo', sourceType: 'github' as const, installUrl: null, installs: 1, duplicate: false, officialStatus: 'unknown' as const };
  for (const malformed of [
    { ...base, slug: '../secret' },
    { ...base, source: '../repo' },
    { ...base, slug: `ghp_${'x'.repeat(24)}` },
    { ...base, name: 'broken\ud800name' },
    { ...base, id: 'replacement\uFFFDidentity' },
    { ...base, unexpected: true } as SkillCandidate,
  ]) {
    await assert.rejects(provider.audit(malformed), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response');
  }
  assert.equal(calls, 0);
});

test('returns typed rate-limit and authentication failures without exposing credentials', async () => {
  const compatibility = new SkillsShCompatibilityProvider({ fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '30' } }) });
  await assert.rejects(compatibility.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_rate_limited' && error.retryAfterSeconds === 30);
  const v1 = new SkillsShV1Provider({ token: 'expired-token-sentinel', fetchImpl: async () => new Response(null, { status: 401 }) });
  await assert.rejects(v1.search({ query: 'react', limit: 20, owner: 'facebook' }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_authentication_failed' && !error.message.includes('expired-token-sentinel'));
  for (const retryAfter of ['1e3', '0x10', '0']) {
    const malformed = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }) });
    await assert.rejects(
      malformed.search({ query: 'svelte', limit: 20 }),
      (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_rate_limited' && error.retryAfterSeconds === null,
    );
  }
});

test('falls back from an expired v1 token to the compatibility endpoint', async () => {
  const previousToken = process.env.KIOKUKO_SKILLS_V1_TOKEN;
  const previousUrl = process.env.KIOKUKO_SKILLS_API_URL;
  process.env.KIOKUKO_SKILLS_V1_TOKEN = 'expired-token-sentinel';
  process.env.KIOKUKO_SKILLS_API_URL = 'https://skills.sh';
  const requests: string[] = [];
  try {
    const result = await findSkills({ query: 'react', owner: 'facebook', limit: 20 }, {
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        if (url.pathname === '/api/v1/skills/search') return new Response(null, { status: 401 });
        if (url.pathname === '/api/search') return json(compatResponse([compatSkill('facebook/react-skills', 'react-guidance')], 'react'));
        throw new Error(`unexpected fixture URL: ${url.pathname}`);
      },
    });
    assert.deepEqual(requests, ['/api/v1/skills/search', '/api/search']);
    assert.match(result.provider, /^skills-sh-compat-[0-9a-f]{16}$/u);
  } finally {
    if (previousToken === undefined) delete process.env.KIOKUKO_SKILLS_V1_TOKEN; else process.env.KIOKUKO_SKILLS_V1_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.KIOKUKO_SKILLS_API_URL; else process.env.KIOKUKO_SKILLS_API_URL = previousUrl;
  }
});

test('does not downgrade a 403 response to the unauthenticated compatibility provider', async () => {
  let fallbackCalls = 0;
  const fallback = new SkillsShCompatibilityProvider({ fetchImpl: async () => { fallbackCalls += 1; return json(compatResponse([])); } });
  const provider = new SkillsShV1Provider({
    token: 'test-token-123456789',
    authenticationFallback: fallback,
    fetchImpl: async () => new Response(null, { status: 403 }),
  });
  await assert.rejects(
    findSkills({ query: 'react', limit: 20 }, { provider }),
    (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_unavailable',
  );
  assert.equal(fallbackCalls, 0);
});

test('binds compatibility provider identity to the normalized non-secret origin', () => {
  const primary = new SkillsShCompatibilityProvider({ apiUrl: 'https://skills.sh' });
  const alternate = new SkillsShCompatibilityProvider({ apiUrl: 'http://127.0.0.1:4100' });
  assert.match(primary.id, /^skills-sh-compat-[0-9a-f]{16}$/u);
  assert.match(alternate.id, /^skills-sh-compat-[0-9a-f]{16}$/u);
  assert.notEqual(primary.id, alternate.id);
  assert.doesNotMatch(primary.id, /skills\.sh|https|@/iu);
});

test('uses the authenticated provider audit endpoint and fails closed on warn', async () => {
  let seenAuthorization = '';
  const provider = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async (_input, init) => {
    seenAuthorization = new Headers(init?.headers).get('authorization') ?? '';
    return json({
      id: 'community/repo/sveltekit-helper', source: 'community/repo', slug: 'sveltekit-helper', audits: [
        { provider: 'Socket', slug: 'socket', status: 'warn', summary: 'Review required', auditedAt: '2026-08-25T00:00:00.000Z' },
      ],
    });
  } });
  const result = await provider.audit({ id: 'v1:community/repo:sveltekit-helper', provider: 'skills-sh-v1', name: 'sveltekit-helper', slug: 'sveltekit-helper', source: 'community/repo', sourceType: 'github', installUrl: null, installs: 1, duplicate: false, officialStatus: 'unknown' });
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(seenAuthorization, 'Bearer test-token-123456789');
});

test('binds provider audit authorization to the exact case-sensitive skill path', async () => {
  const provider = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => json({
    id: 'community/repo/mixedcase', source: 'community/repo', slug: 'mixedcase', audits: [
      { provider: 'Socket', slug: 'socket', status: 'pass', riskLevel: 'LOW', summary: 'Provider marked pass.', auditedAt: '2026-08-25T00:00:00.000Z' },
    ],
  }) });
  await assert.rejects(
    provider.audit({ id: 'v1:community/repo:MixedCase', provider: 'skills-sh-v1', name: 'MixedCase', slug: 'MixedCase', source: 'community/repo', sourceType: 'github', installUrl: null, installs: 1, duplicate: false, officialStatus: 'unknown' }),
    (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_invalid_response',
  );
});

test('fails closed when a passing audit reports MEDIUM-or-higher risk', async () => {
  for (const riskLevel of ['MEDIUM', 'HIGH', 'CRITICAL']) {
    const provider = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => json({
      id: 'community/repo/sveltekit-helper', source: 'community/repo', slug: 'sveltekit-helper', audits: [
        { provider: 'Socket', slug: 'socket', status: 'pass', riskLevel, summary: 'Provider marked pass.', auditedAt: '2026-08-25T00:00:00.000Z' },
      ],
    }) });
    const result = await provider.audit({ id: 'v1:community/repo:sveltekit-helper', provider: 'skills-sh-v1', name: 'sveltekit-helper', slug: 'sveltekit-helper', source: 'community/repo', sourceType: 'github', installUrl: null, installs: 1, duplicate: false, officialStatus: 'unknown' });
    assert.deepEqual(result, { status: 'failed' });
  }
});

test('allows only NONE, LOW, or an absent risk level when every audit passes', async () => {
  for (const riskLevel of [undefined, 'NONE', 'LOW']) {
    const provider = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => json({
      id: 'community/repo/sveltekit-helper', source: 'community/repo', slug: 'sveltekit-helper', audits: [
        {
          provider: 'Socket', slug: 'socket', status: 'pass',
          ...(riskLevel === undefined ? {} : { riskLevel }),
          summary: 'Provider marked pass.', auditedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    }) });
    const result = await provider.audit({ id: 'v1:community/repo:sveltekit-helper', provider: 'skills-sh-v1', name: 'sveltekit-helper', slug: 'sveltekit-helper', source: 'community/repo', sourceType: 'github', installUrl: null, installs: 1, duplicate: false, officialStatus: 'unknown' });
    assert.deepEqual(result, { status: 'passed' });
  }
});

test('never follows provider redirects and never masks internal exceptions', async () => {
  let calls = 0;
  const redirected = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async (_input, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  } });
  await assert.rejects(redirected.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_unavailable');
  assert.equal(calls, 1);
  const invariant = new SkillsShCompatibilityProvider({ fetchImpl: async () => { throw new Error('internal fixture invariant'); } });
  await assert.rejects(invariant.search({ query: 'svelte', limit: 20 }), /internal fixture invariant/u);
});

test('propagates arbitrary provider TypeErrors but types native transport failures', async () => {
  const compatibilityInvariant = new SkillsShCompatibilityProvider({ fetchImpl: async () => { throw new TypeError('programmer-bug-sentinel'); } });
  await assert.rejects(compatibilityInvariant.search({ query: 'svelte', limit: 20 }), /programmer-bug-sentinel/u);
  const v1Invariant = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => { throw new TypeError('programmer-bug-sentinel'); } });
  await assert.rejects(v1Invariant.search({ query: 'svelte', limit: 20 }), /programmer-bug-sentinel/u);
  const compatibilityMessageOnly = new TypeError('fetch failed');
  const compatibilityMessageInvariant = new SkillsShCompatibilityProvider({ fetchImpl: async () => { throw compatibilityMessageOnly; } });
  await assert.rejects(compatibilityMessageInvariant.search({ query: 'svelte', limit: 20 }), (error: unknown) => error === compatibilityMessageOnly);
  const v1MessageOnly = new TypeError('fetch failed');
  const v1MessageInvariant = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => { throw v1MessageOnly; } });
  await assert.rejects(v1MessageInvariant.search({ query: 'svelte', limit: 20 }), (error: unknown) => error === v1MessageOnly);

  const compatibilityTransport = new SkillsShCompatibilityProvider({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  await assert.rejects(compatibilityTransport.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_unavailable');
  const v1Transport = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENETUNREACH' } }); } });
  await assert.rejects(v1Transport.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_unavailable');
  const tlsTransport = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }); } });
  await assert.rejects(tlsTransport.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_unavailable');

  const streamResponse = (error: unknown) => new Response(new ReadableStream({ start(controller) { controller.error(error); } }), { headers: { 'content-type': 'application/json' } });
  const terminated = Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
  const compatibilityStream = new SkillsShCompatibilityProvider({ fetchImpl: async () => streamResponse(terminated) });
  await assert.rejects(compatibilityStream.search({ query: 'svelte', limit: 20 }), (error: unknown) => error instanceof SkillProviderError && error.code === 'registry_unavailable');
  const invariantStream = new SkillsShV1Provider({ token: 'test-token-123456789', fetchImpl: async () => streamResponse(new TypeError('programmer-bug-sentinel')) });
  await assert.rejects(invariantStream.search({ query: 'svelte', limit: 20 }), /programmer-bug-sentinel/u);
});
