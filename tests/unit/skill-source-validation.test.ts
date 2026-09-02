import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { GitHubSkillSourceFetcher, SkillSourceError } from '../../src/skills/source/github-fetcher.js';
import { MAX_FRONTMATTER_BYTES, parseSkillFrontmatter } from '../../src/skills/source/frontmatter.js';
import { MAX_FILE_BYTES, MAX_PRIMARY_SKILL_BYTES, revalidateSkillSnapshot, validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillSourceFetchRequest } from '../../src/skills/types.js';
import { requirementForOfficialSkill, reviewedCatalogSkill, technologyDefinition } from '../../src/skills/official-catalog.js';
import { MAX_STRICT_JSON_DEPTH } from '../../src/setup/strict-json.js';

const SOURCE_COMMIT = 'd'.repeat(40);
const PRIMARY_PREFIX = '---\nname: fixture\n---\n';
const DISCOVERY_REQUEST = { purpose: 'discovery' } as const;

function githubJsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/vnd.github+json; charset=utf-8');
  return new Response(JSON.stringify(value), { ...init, headers });
}

function githubJsonText(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(body, { ...init, headers });
}

function primaryContentWithBytes(bytes: number): string {
  const prefixBytes = Buffer.byteLength(PRIMARY_PREFIX, 'utf8');
  assert.ok(bytes >= prefixBytes);
  const content = `${PRIMARY_PREFIX}${'x'.repeat(bytes - prefixBytes)}`;
  assert.equal(Buffer.byteLength(content, 'utf8'), bytes);
  return content;
}

const candidate: SkillCandidate = {
  id: 'fixture:owner/repo:fixture',
  provider: 'fixture',
  name: 'fixture',
  slug: 'fixture',
  source: 'owner/repo',
  sourceType: 'github',
  installUrl: 'https://github.com/owner/repo',
  installs: 0,
  duplicate: false,
  officialStatus: 'catalog-verified',
};

function assertInvalidFrontmatter(source: string): void {
  assert.throws(
    () => parseSkillFrontmatter(source),
    (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_validation_failed',
  );
}

test('parses only the exact supported frontmatter scalars', () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: fixture\ndescription: "safe reference"\ndisable-model-invocation: false\n---\n'), {
    name: 'fixture',
    description: 'safe reference',
    disableModelInvocation: false,
  });
  assert.deepEqual(parseSkillFrontmatter('---\n# supported comment\nname: \'Fixture One\'\ndescription: "safe \\"quoted\\" reference"\ndisable-model-invocation: true\n---\n'), {
    name: 'Fixture One',
    description: 'safe "quoted" reference',
    disableModelInvocation: true,
  });
  assert.deepEqual(parseSkillFrontmatter('---\nname: fixture\ndescription: ""\n---\n'), {
    name: 'fixture',
    description: '',
    disableModelInvocation: false,
  });
  assert.equal(parseSkillFrontmatter(`---\nname: fixture\ndescription: ${'x'.repeat(2_000)}\n---\n`).description?.length, 2_000);
});

test('rejects YAML syntax errors, duplicate or unknown keys, and graph features', () => {
  for (const source of [
    String.raw`---
name: fixture
description: "bad\q"
---
`,
    '---\nname: fixture\nname: other\n---\n',
    '---\nname: fixture\nunknown: value\n---\n',
    '---\nname: !!str fixture\n---\n',
    '---\nname: fixture\ndescription: !custom safe\n---\n',
    '---\nname: &identity fixture\n---\n',
    '---\nname: fixture\ndescription: *identity\n---\n',
    '---\nname: fixture\n<<: { description: safe }\n---\n',
    '---\n{name: fixture}\n---\n',
  ]) assertInvalidFrontmatter(source);
});

test('rejects collections, multiline values, and wrong scalar types', () => {
  for (const source of [
    '---\nname: fixture\ndescription: [safe]\n---\n',
    '---\nname: fixture\ndescription:\n  nested: safe\n---\n',
    '---\nname: fixture\ndescription: |\n  safe\n---\n',
    '---\nname: fixture\ndescription: >\n  safe\n---\n',
    '---\nname: fixture\ndescription: "safe\n  continuation"\n---\n',
    '---\nname: fixture\ndescription: safe\n  continuation\n---\n',
    '---\nname: 123\n---\n',
    '---\nname: fixture\ndescription: true\n---\n',
    '---\nname: fixture\ndescription: null\n---\n',
    '---\nname: fixture\ndescription:\n---\n',
    '---\nname: fixture\ndisable-model-invocation: yes\n---\n',
    '---\nname: fixture\ndisable-model-invocation: "false"\n---\n',
    '---\nname: fixture\ndisable-model-invocation: 0\n---\n',
  ]) assertInvalidFrontmatter(source);
});

test('enforces frontmatter block, field, and Unicode bounds before accepting it', () => {
  const boundedPrefix = 'name: fixture\n#';
  const exactBlock = `${boundedPrefix}${'x'.repeat(MAX_FRONTMATTER_BYTES - Buffer.byteLength(boundedPrefix, 'utf8'))}`;
  assert.equal(Buffer.byteLength(exactBlock, 'utf8'), MAX_FRONTMATTER_BYTES);
  assert.equal(parseSkillFrontmatter(`---\n${exactBlock}\n---\n`).name, 'fixture');
  assertInvalidFrontmatter(`---\n${exactBlock}x\n---\n`);
  assertInvalidFrontmatter(`---\nname: fixture\ndescription: ${'x'.repeat(2_001)}\n---\n`);
  assertInvalidFrontmatter('---\nname: fixture\ndescription: hidden\u200bcontrol\n---\n');
  assertInvalidFrontmatter('---\nname: fixture\ndescription: broken\ud800text\n---\n');
  assertInvalidFrontmatter('---\nname: fixture\ndescription: replacement\uFFFDtext\n---\n');
});

test('rejects traversal and secret-bearing snapshots before persistence', () => {
  assert.throws(() => validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: '../SKILL.md', content: '---\nname: fixture\n---\n', primary: true }],
  }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\npassword=not-for-storage', primary: true }],
  }), (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_secret_detected');
  assert.throws(() => validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/./fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }],
  }), /skill_validation_failed/u);
});

test('rejects a snapshot that disables model invocation', () => {
  assert.throws(() => validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\ndisable-model-invocation: true\n---\n# Fixture\n', primary: true }],
  }), (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_disabled_for_model_invocation');
});

test('enforces distinct inclusive byte boundaries for primary and reference files', () => {
  const accepted = validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [
      { path: 'skills/fixture/SKILL.md', content: primaryContentWithBytes(MAX_PRIMARY_SKILL_BYTES), primary: true },
      { path: 'skills/fixture/references/limit.txt', content: 'r'.repeat(MAX_FILE_BYTES), primary: false },
    ],
  });
  assert.equal(Buffer.byteLength(accepted.files.find((file) => file.primary)!.content, 'utf8'), 150_000);
  assert.equal(Buffer.byteLength(accepted.files.find((file) => !file.primary)!.content, 'utf8'), 100_000);

  assert.throws(() => validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/fixture/SKILL.md', content: primaryContentWithBytes(MAX_PRIMARY_SKILL_BYTES + 1), primary: true }],
  }), (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_too_large');
  assert.throws(() => validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [
      { path: 'skills/fixture/SKILL.md', content: PRIMARY_PREFIX, primary: true },
      { path: 'skills/fixture/references/too-large.txt', content: 'r'.repeat(MAX_FILE_BYTES + 1), primary: false },
    ],
  }), (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_too_large');
});

test('streams primary and reference files with their role-specific byte limits', async () => {
  const fetchSizedSnapshot = async (primaryBytes: number, referenceBytes: number) => {
    const fetcher = new GitHubSkillSourceFetcher({
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
        if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
        if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [
          { type: 'blob', mode: '100644', path: 'skills/fixture/SKILL.md' },
          { type: 'blob', mode: '100644', path: 'skills/fixture/references/limit.txt' },
        ] });
        if (url.pathname.endsWith('/SKILL.md')) return new Response(primaryContentWithBytes(primaryBytes));
        if (url.pathname.endsWith('/limit.txt')) return new Response('r'.repeat(referenceBytes));
        throw new Error(`unexpected URL ${url}`);
      },
    });
    return fetcher.fetch(candidate, DISCOVERY_REQUEST);
  };

  const accepted = await fetchSizedSnapshot(MAX_PRIMARY_SKILL_BYTES, MAX_FILE_BYTES);
  assert.equal(Buffer.byteLength(accepted.files.find((file) => file.primary)!.content, 'utf8'), 150_000);
  assert.equal(Buffer.byteLength(accepted.files.find((file) => !file.primary)!.content, 'utf8'), 100_000);
  await assert.rejects(
    () => fetchSizedSnapshot(MAX_PRIMARY_SKILL_BYTES + 1, 0),
    (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_too_large',
  );
  await assert.rejects(
    () => fetchSizedSnapshot(PRIMARY_PREFIX.length, MAX_FILE_BYTES + 1),
    (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_too_large',
  );
});

test('allows text under references but rejects text files under docs', () => {
  const primary = { path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n# Fixture\n', primary: true };
  assert.doesNotThrow(() => validateSkillSnapshot({ candidate, sourceCommit: SOURCE_COMMIT, files: [primary, { path: 'skills/fixture/references/notes.txt', content: 'Reference.', primary: false }] }));
  assert.throws(() => validateSkillSnapshot({ candidate, sourceCommit: SOURCE_COMMIT, files: [primary, { path: 'skills/fixture/docs/notes.txt', content: 'Reference.', primary: false }] }), /skill_validation_failed/u);
});

test('preserves case-sensitive GitHub path identity across validation and replay', () => {
  const mixed = { ...candidate, id: 'fixture:owner/repo:MixedCase', name: 'MixedCase', slug: 'MixedCase' };
  const snapshot = validateSkillSnapshot({
    candidate: mixed,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/MixedCase/SKILL.md', content: '---\nname: MixedCase\ndescription: safe\n---\n# MixedCase\n', primary: true }],
  });
  assert.equal(snapshot.candidate.slug, 'MixedCase');
  assert.equal(revalidateSkillSnapshot(snapshot).candidate.slug, 'MixedCase');
});

test('requires exact path casing for reviewed-catalog authorization', () => {
  const exact = { source: 'sveltejs/ai-tools', slug: 'svelte-code-writer', name: 'Svelte Code Writer' };
  assert.ok(reviewedCatalogSkill(exact));
  assert.ok(requirementForOfficialSkill(exact));
  assert.equal(reviewedCatalogSkill({ ...exact, slug: 'Svelte-Code-Writer' }), undefined);
  assert.equal(requirementForOfficialSkill({ ...exact, slug: 'Svelte-Code-Writer' }), undefined);
});

test('supports one repository-root SKILL.md only with exact frontmatter identity binding', async () => {
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [
        { type: 'blob', mode: '100644', path: 'SKILL.md' },
        { type: 'blob', mode: '100644', path: 'references/notes.md' },
      ] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: fixture\ndescription: safe\n---\n# Fixture\n');
      if (url.pathname.endsWith('/notes.md')) return new Response('# Notes\n\nReference.');
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const snapshot = await fetcher.fetch(candidate, DISCOVERY_REQUEST);
  assert.equal(snapshot.files[0]?.path, 'SKILL.md');
  assert.deepEqual(snapshot.files.map((file) => file.path), ['SKILL.md', 'references/notes.md']);

  const mismatch = { ...candidate, id: 'fixture:owner/repo:other', name: 'other', slug: 'other' };
  await assert.rejects(() => fetcher.fetch(mismatch, DISCOVERY_REQUEST), /skill_validation_failed/u);
});

test('fails closed when discovery has multiple fuzzy primary paths', async () => {
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [
        { type: 'blob', mode: '100644', path: 'SKILL.md' },
        { type: 'blob', mode: '100644', path: 'skills/other/SKILL.md' },
      ] });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_validation_failed');
});

test('canonicalizes one fuzzy primary path only during discovery and pins refresh to the stored path', async () => {
  let rawFetches = 0;
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/fixture-helper/SKILL.md' }] });
      rawFetches += 1;
      return new Response('---\nname: fixture-helper\ndescription: safe\n---\n# Fixture Helper\n');
    },
  });
  const discovered = await fetcher.fetch(candidate, DISCOVERY_REQUEST);
  assert.equal(discovered.candidate.slug, 'fixture-helper');
  assert.equal(discovered.files.find((file) => file.primary)?.path, 'skills/fixture-helper/SKILL.md');
  assert.equal(rawFetches, 1);

  await assert.rejects(
    () => fetcher.fetch(candidate, { purpose: 'refresh', expectedPrimaryPath: 'skills/fixture/SKILL.md' }),
    (error: unknown) => error instanceof SkillSourceError && error.code === 'candidate_not_found_at_source',
  );
  assert.equal(rawFetches, 1, 'refresh must not fetch a moved primary path');
});

test('validates a provider-returned Laravel catalog candidate at its reviewed repository path', async () => {
  const slug = technologyDefinition('laravel')?.reviewedSkills?.[0]?.slug;
  assert.equal(slug, 'laravel-best-practices');
  const primaryPath = `.ai/laravel/skill/${slug}/SKILL.md`;
  const laravelCandidate: SkillCandidate = {
    ...candidate,
    id: `fixture:laravel/boost:${slug}`,
    name: slug,
    slug,
    source: 'laravel/boost',
    installUrl: 'https://github.com/laravel/boost',
  };
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/laravel/boost') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: primaryPath }] });
      if (url.pathname.endsWith(`/${primaryPath}`)) return new Response('---\nname: Laravel Best Practices\ndescription: safe\n---\n# Laravel\n\nReference.');
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const snapshot = await fetcher.fetch(laravelCandidate, DISCOVERY_REQUEST);
  assert.equal(snapshot.files[0]?.path, primaryPath);
  assert.equal(snapshot.candidate.slug, slug);
});

test('rejects an unreviewed suffix match for a provider-returned catalog candidate', async () => {
  const slug = 'laravel-best-practices';
  let rawFetches = 0;
  const providerCandidate: SkillCandidate = {
    ...candidate,
    id: `fixture:laravel/boost:${slug}`,
    name: slug,
    slug,
    source: 'laravel/boost',
    installUrl: 'https://github.com/laravel/boost',
  };
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/laravel/boost') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [
        { type: 'blob', mode: '100644', path: `evil/${slug}/SKILL.md` },
      ] });
      rawFetches += 1;
      return new Response('---\nname: malicious\n---\n');
    },
  });
  await assert.rejects(
    () => fetcher.fetch(providerCandidate, DISCOVERY_REQUEST),
    (error: unknown) => error instanceof SkillSourceError && error.code === 'candidate_not_found_at_source',
  );
  assert.equal(rawFetches, 0);
});

test('rejects an unsafe source candidate before making a network request', async () => {
  let calls = 0;
  const fetcher = new GitHubSkillSourceFetcher({ fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  await assert.rejects(() => fetcher.fetch({ ...candidate, slug: 'fixture?token=value' }, DISCOVERY_REQUEST), /skill_validation_failed/u);
  for (const source of ['../repo', 'owner/..', './repo', 'owner/.']) {
    await assert.rejects(() => fetcher.fetch({ ...candidate, source }, DISCOVERY_REQUEST), /skill_validation_failed/u);
  }
  for (const malformed of [
    { ...candidate, id: 'fixture:owner/repo:fixture\ud800' },
    { ...candidate, name: 'replacement\uFFFDname' },
    { ...candidate, provider: 'fixture\udfff' },
    { ...candidate, unexpected: true } as SkillCandidate,
    null as unknown as SkillCandidate,
  ]) {
    await assert.rejects(() => fetcher.fetch(malformed, DISCOVERY_REQUEST), /skill_validation_failed/u);
  }
  assert.equal(calls, 0);
});

test('requires one exact source-fetch purpose before making a network request', async () => {
  let calls = 0;
  const fetcher = new GitHubSkillSourceFetcher({ fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  for (const request of [
    undefined,
    {},
    { purpose: 'discovery', expectedPrimaryPath: 'skills/fixture/SKILL.md' },
    { purpose: 'refresh' },
    { purpose: 'refresh', expectedPrimaryPath: '../SKILL.md' },
    { purpose: 'unknown' },
  ]) {
    await assert.rejects(
      () => fetcher.fetch(candidate, request as SkillSourceFetchRequest),
      (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_validation_failed',
    );
  }
  assert.equal(calls, 0);
});

test('does not hash volatile registry metadata into the source snapshot', () => {
  const source = validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n# Fixture\n\nReference.', primary: true }],
  });
  const changedRegistryMetadata = validateSkillSnapshot({
    candidate: { ...candidate, id: 'replacement-provider:owner/repo:renamed', provider: 'replacement-provider', name: 'renamed', installs: 2_000, officialStatus: 'registry-only' },
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n# Fixture\n\nReference.', primary: true }],
  });
  assert.equal(changedRegistryMetadata.snapshotHash, source.snapshotHash);
});

test('canonicalizes file order and rejects duplicate snapshot paths', () => {
  const files = [
    { path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n# Fixture\n', primary: true },
    { path: 'skills/fixture/references/notes.md', content: '# Notes\n\nReference.', primary: false },
  ];
  const first = validateSkillSnapshot({ candidate, sourceCommit: SOURCE_COMMIT, files });
  const reversed = validateSkillSnapshot({ candidate: { ...candidate, source: 'OWNER/REPO' }, sourceCommit: SOURCE_COMMIT, files: [...files].reverse() });
  assert.equal(reversed.snapshotHash, first.snapshotHash);
  assert.equal(reversed.candidate.source, 'owner/repo');
  assert.equal(reversed.candidate.installUrl, 'https://github.com/owner/repo');
  assert.deepEqual(reversed.files.map((file) => file.path), files.map((file) => file.path));
  assert.throws(() => validateSkillSnapshot({ candidate, sourceCommit: SOURCE_COMMIT, files: [files[0]!, { ...files[0]!, primary: false }] }), /skill_validation_failed/u);
});

test('canonicalizes only reviewed skill repository roots', () => {
  const reviewed = validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'tools/skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n# Fixture\n', primary: true }],
  });
  assert.equal(reviewed.candidate.slug, 'fixture');
  assert.equal(reviewed.candidate.id, 'fixture:owner/repo:fixture');

  const arbitrary = validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'custom/fixture/SKILL.md', content: '---\nname: fixture\n---\n# Fixture\n', primary: true }],
  });
  assert.equal(arbitrary.candidate.slug, 'custom/fixture');
  assert.equal(arbitrary.candidate.id, 'fixture:owner/repo:custom/fixture');
});

test('rejects forged derived snapshot fields during revalidation', () => {
  const snapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\ndescription: safe\n---\n# Fixture\n', primary: true }],
  });
  assert.throws(() => revalidateSkillSnapshot({
    ...snapshot,
    files: snapshot.files.map((file) => ({ ...file, contentHash: '0'.repeat(64) })),
  }), /skill_validation_failed/u);
  assert.throws(() => revalidateSkillSnapshot({
    ...snapshot,
    frontmatter: { ...snapshot.frontmatter, name: 'forged' },
  }), /skill_validation_failed/u);
  assert.throws(() => revalidateSkillSnapshot({
    ...snapshot,
    candidate: { ...snapshot.candidate, slug: 'forged', id: 'fixture:owner/repo:forged' },
  }), /skill_validation_failed/u);
});

test('rejects malformed candidate identity before producing a snapshot', () => {
  assert.throws(() => validateSkillSnapshot({ candidate: { ...candidate, source: 'owner/repo/extra' }, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate: { ...candidate, slug: 'fixture/../escape' }, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate: { ...candidate, name: 'safe\u202Emoc' }, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate: { ...candidate, name: ' fixture ' }, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate: { ...candidate, id: ' fixture:owner/repo:fixture ' }, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate: { ...candidate, id: 'fixture:owner/repo:fixture\u200b' }, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate: { ...candidate, name: 'broken\ud800name' }, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate: { ...candidate, id: 'fixture:owner/repo:fixture\uFFFD' }, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate, sourceCommit: 'not-a-commit', files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true }] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate, sourceCommit: SOURCE_COMMIT, files: [
    { path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n', primary: true },
    { path: 'other/references/notes.md', content: 'Reference.', primary: false },
  ] }), /skill_validation_failed/u);
  assert.throws(() => validateSkillSnapshot({ candidate, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: fixture\n---\n\0binary', primary: true }] }), /skill_validation_failed/u);
  for (const malformed of ['\ud800', '\udfff', '\uFFFD']) {
    assert.throws(() => validateSkillSnapshot({ candidate, sourceCommit: SOURCE_COMMIT, files: [{ path: 'skills/fixture/SKILL.md', content: `---\nname: fixture\n---\n${malformed}`, primary: true }] }), /skill_validation_failed/u);
  }
});

test('derives the persisted candidate name from verified frontmatter and enforces it on replay', () => {
  const snapshot = validateSkillSnapshot({
    candidate: { ...candidate, name: 'Poisoned Registry Name' },
    sourceCommit: SOURCE_COMMIT,
    files: [{ path: 'skills/fixture/SKILL.md', content: '---\nname: Verified Source Name\n---\n# Fixture\n', primary: true }],
  });
  assert.equal(snapshot.candidate.name, 'Verified Source Name');
  assert.throws(
    () => revalidateSkillSnapshot({ ...snapshot, candidate: { ...snapshot.candidate, name: 'Poisoned Registry Name' } }),
    /skill_validation_failed/u,
  );
});

test('rejects non-GitHub source types before making a network request', async () => {
  let calls = 0;
  const fetcher = new GitHubSkillSourceFetcher({ fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  await assert.rejects(
    () => fetcher.fetch({ ...candidate, sourceType: 'well-known' as SkillCandidate['sourceType'] }, DISCOVERY_REQUEST),
    /skill_validation_failed/u,
  );
  assert.equal(calls, 0);
});

test('validates GitHub bearer tokens before use and keeps them out of object inspection', () => {
  const secret = 'ghp_private-token-sentinel';
  const fetcher = new GitHubSkillSourceFetcher({ token: secret });
  assert.equal(Object.keys(fetcher).includes('token'), false);
  assert.equal(JSON.stringify(fetcher).includes(secret), false);
  assert.equal(inspect(fetcher, { showHidden: true }).includes(secret), false);
  for (const invalid of [' token', 'token ', 'token:value', 'token\nvalue', 'token\uFFFD', 'token\ud800']) {
    assert.throws(
      () => new GitHubSkillSourceFetcher({ token: invalid }),
      (error: unknown) => error instanceof Error && error.message === 'GitHub token is invalid',
    );
  }
});

test('does not follow a redirect to a non-GitHub host', async () => {
  const seen: string[] = [];
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } });
    },
  });
  await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable');
  assert.deepEqual(seen, ['https://api.github.com/repos/owner/repo']);
});

test('does not follow a redirect to a different repository on an allowed GitHub host', async () => {
  const seen: string[] = [];
  const fetcher = new GitHubSkillSourceFetcher({
    token: 'token-sentinel',
    fetchImpl: async (input, init) => {
      seen.push(String(input));
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token-sentinel');
      return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repos/attacker/repo' } });
    },
  });
  await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable');
  assert.deepEqual(seen, ['https://api.github.com/repos/owner/repo']);
});

test('distinguishes missing, rate-limited, and ordinary unavailable GitHub responses', async () => {
  for (const status of [404, 410]) {
    const fetcher = new GitHubSkillSourceFetcher({ fetchImpl: async () => new Response(null, { status }) });
    await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'source_missing');
  }
  for (const response of [
    new Response(null, { status: 429 }),
    new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  ]) {
    const fetcher = new GitHubSkillSourceFetcher({ fetchImpl: async () => response });
    await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'source_rate_limited');
  }
  const retryAfter = new GitHubSkillSourceFetcher({ fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }) });
  await assert.rejects(
    () => retryAfter.fetch(candidate, DISCOVERY_REQUEST),
    (error: unknown) => error instanceof SkillSourceError && error.code === 'source_rate_limited' && error.retryAfterSeconds === 120,
  );
  const malformedRetryAfter = new GitHubSkillSourceFetcher({ fetchImpl: async () => new Response(null, { status: 403, headers: { 'retry-after': '1e3' } }) });
  await assert.rejects(
    () => malformedRetryAfter.fetch(candidate, DISCOVERY_REQUEST),
    (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable',
  );
  for (const status of [401, 403, 500]) {
    const fetcher = new GitHubSkillSourceFetcher({ fetchImpl: async () => new Response(null, { status }) });
    await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable');
  }
});

test('requires exact HTTP 200 for every GitHub source response', async () => {
  for (const status of [201, 202, 204, 206]) {
    let calls = 0;
    const fetcher = new GitHubSkillSourceFetcher({
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status, headers: { 'content-type': 'application/json' } });
      },
    });
    await assert.rejects(
      () => fetcher.fetch(candidate, DISCOVERY_REQUEST),
      (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable',
    );
    assert.equal(calls, 1);
  }
});

test('requires an exact accepted GitHub API JSON media type before parsing', async () => {
  const contentTypes: Array<string | null> = [
    null,
    'text/plain',
    'application/problem+json',
    'application/jsonp',
    'application/json; charset=utf-16',
    'application/json; charset=utf-8; profile=unsafe',
    'application/json, text/plain',
  ];
  for (const contentType of contentTypes) {
    let calls = 0;
    const bytes = new TextEncoder().encode('{"default_branch":"main"}');
    const fetcher = new GitHubSkillSourceFetcher({
      fetchImpl: async () => {
        calls += 1;
        return new Response(bytes, {
          status: 200,
          ...(contentType === null ? {} : { headers: { 'content-type': contentType } }),
        });
      },
    });
    await assert.rejects(
      () => fetcher.fetch(candidate, DISCOVERY_REQUEST),
      (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_validation_failed',
    );
    assert.equal(calls, 1);
  }
});

test('rejects unsafe GitHub API JSON bytes before making a dependent request', async () => {
  const tooDeep = `${'{"value":'.repeat(MAX_STRICT_JSON_DEPTH + 1)}null${'}'.repeat(MAX_STRICT_JSON_DEPTH + 1)}`;
  const bodies: BodyInit[] = [
    '\uFEFF{"default_branch":"main"}',
    '{"value":1e999,"default_branch":"main"}',
    tooDeep,
    new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x3a, 0xff, 0x7d]),
  ];
  for (const body of bodies) {
    let calls = 0;
    const fetcher = new GitHubSkillSourceFetcher({
      fetchImpl: async () => {
        calls += 1;
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      },
    });
    await assert.rejects(
      () => fetcher.fetch(candidate, DISCOVERY_REQUEST),
      (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_validation_failed',
    );
    assert.equal(calls, 1);
  }
});

test('requires repository metadata, a full commit, and a complete tree row', async () => {
  const scenarios: Array<{ responses: unknown[]; expectedCalls: number }> = [
    { responses: [{}], expectedCalls: 1 },
    { responses: [{ default_branch: 'main' }, { sha: 'd'.repeat(8) }], expectedCalls: 2 },
    { responses: [{ default_branch: 'main' }, { sha: SOURCE_COMMIT }, { truncated: false, tree: [{ type: 'blob', path: 'fixture/SKILL.md' }] }], expectedCalls: 3 },
  ];
  for (const scenario of scenarios) {
    let calls = 0;
    const fetcher = new GitHubSkillSourceFetcher({ fetchImpl: async () => {
      const response = scenario.responses[calls];
      calls += 1;
      if (response === undefined) throw new Error('unexpected fixture request');
      return githubJsonResponse(response);
    } });
    await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), /skill_validation_failed/u);
    assert.equal(calls, scenario.expectedCalls);
  }
});

test('rejects duplicate identity keys in GitHub source JSON before trusting either value', async () => {
  const scenarios: Array<{ responses: string[]; expectedCalls: number }> = [
    {
      responses: ['{"default_branch":"attacker","default_branch":"main"}'],
      expectedCalls: 1,
    },
    {
      responses: [
        '{"default_branch":"main"}',
        `{"sha":"${'a'.repeat(40)}","sha":"${SOURCE_COMMIT}"}`,
      ],
      expectedCalls: 2,
    },
    {
      responses: [
        '{"default_branch":"main"}',
        `{"sha":"${SOURCE_COMMIT}"}`,
        '{"truncated":true,"truncated":false,"tree":[]}',
      ],
      expectedCalls: 3,
    },
  ];

  for (const scenario of scenarios) {
    let calls = 0;
    const fetcher = new GitHubSkillSourceFetcher({
      fetchImpl: async () => {
        const body = scenario.responses[calls];
        calls += 1;
        if (body === undefined) throw new Error('unexpected fixture request');
        return githubJsonText(body);
      },
    });
    await assert.rejects(
      () => fetcher.fetch(candidate, DISCOVERY_REQUEST),
      (error: unknown) => error instanceof SkillSourceError && error.code === 'skill_validation_failed',
    );
    assert.equal(calls, scenario.expectedCalls);
  }
});

test('propagates arbitrary TypeError invariants but types native transport failures', async () => {
  const invariant = new GitHubSkillSourceFetcher({ fetchImpl: async () => { throw new TypeError('programmer-bug-sentinel'); } });
  await assert.rejects(() => invariant.fetch(candidate, DISCOVERY_REQUEST), /programmer-bug-sentinel/u);
  const messageOnly = new TypeError('fetch failed');
  const messageInvariant = new GitHubSkillSourceFetcher({ fetchImpl: async () => { throw messageOnly; } });
  await assert.rejects(() => messageInvariant.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error === messageOnly);
  const transport = new GitHubSkillSourceFetcher({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(() => transport.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable');
  const tlsTransport = new GitHubSkillSourceFetcher({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); } });
  await assert.rejects(() => tlsTransport.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable');
});

test('pins every raw file to the returned commit and excludes script tree entries', async () => {
  const seen: URL[] = [];
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      seen.push(url);
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [
        { type: 'blob', mode: '100644', path: 'skills/fixture/SKILL.md' },
        { type: 'blob', mode: '100644', path: 'skills/fixture/references/notes.md' },
        { type: 'blob', mode: '100644', path: 'skills/fixture/scripts/install.sh' },
        { type: 'blob', mode: '100644', path: 'skills/fixture/install.sh' },
      ] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: fixture\ndescription: safe\n---\n# Fixture\n\nUse the reference.');
      if (url.pathname.endsWith('/notes.md')) return new Response('# Notes\n\nReference only.');
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const snapshot = await fetcher.fetch(candidate, DISCOVERY_REQUEST);
  assert.deepEqual(snapshot.files.map((file) => file.path), ['skills/fixture/SKILL.md', 'skills/fixture/references/notes.md']);
  assert.equal(snapshot.sourceCommit, SOURCE_COMMIT);
  const rawPaths = seen.filter((url) => url.hostname === 'raw.githubusercontent.com').map((url) => url.pathname);
  assert.deepEqual(rawPaths, [
    `/owner/repo/${SOURCE_COMMIT}/skills/fixture/SKILL.md`,
    `/owner/repo/${SOURCE_COMMIT}/skills/fixture/references/notes.md`,
  ]);
  assert.equal(rawPaths.some((path) => path.includes('/main/') || path.endsWith('.sh')), false);
});

test('types body-stream transport failures without masking stream invariants', async () => {
  const streamResponse = (error: unknown) => new Response(
    new ReadableStream({ start(controller) { controller.error(error); } }),
    { headers: { 'content-type': 'application/json' } },
  );
  const terminated = Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
  for (const error of [new DOMException('aborted', 'AbortError'), terminated]) {
    const fetcher = new GitHubSkillSourceFetcher({ fetchImpl: async () => streamResponse(error) });
    await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), (caught: unknown) => caught instanceof SkillSourceError && caught.code === 'source_unavailable');
  }
  const messageOnly = new TypeError('fetch failed');
  const invariant = new GitHubSkillSourceFetcher({ fetchImpl: async () => streamResponse(messageOnly) });
  await assert.rejects(() => invariant.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error === messageOnly);
});

test('rejects a GitHub symlink selected as the primary skill document', async () => {
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '120000', path: 'fixture/SKILL.md' }] });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), /skill_validation_failed/u);
});

test('rejects ambiguous primary skill paths instead of selecting the first tree row', async () => {
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [
        { type: 'blob', mode: '100644', path: 'one/fixture/SKILL.md' },
        { type: 'blob', mode: '100644', path: 'two/fixture/SKILL.md' },
      ] });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), /skill_validation_failed/u);
});

test('rejects a symlinked reference beneath a real primary document', async () => {
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [
        { type: 'blob', mode: '100644', path: 'fixture/SKILL.md' },
        { type: 'blob', mode: '120000', path: 'fixture/references/unsafe.md' },
      ] });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), /skill_validation_failed/u);
});

test('rejects an executable-mode primary document', async () => {
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100755', path: 'fixture/SKILL.md' }] });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), /skill_validation_failed/u);
});

test('rejects a tree with more than the bounded number of raw items', async () => {
  const fetcher = new GitHubSkillSourceFetcher({
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return githubJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return githubJsonResponse({ sha: SOURCE_COMMIT });
      if (url.pathname.includes(`/git/trees/${SOURCE_COMMIT}`)) return githubJsonResponse({ truncated: false, tree: Array.from({ length: 1_001 }, () => null) });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await assert.rejects(() => fetcher.fetch(candidate, DISCOVERY_REQUEST), (error: unknown) => error instanceof SkillSourceError && error.code === 'source_tree_truncated');
});
