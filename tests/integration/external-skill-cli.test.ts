import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCli, runCli } from '../../src/cli.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { chunkSkillMarkdown } from '../../src/skills/chunking.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { SkillProviderError } from '../../src/skills/providers/schema.js';
import { SkillSourceError } from '../../src/skills/source/errors.js';
import { importSkillSnapshot, recordDiscoveredSkill, writePersistentSkillAuditFailure, writePersistentSkillSearchCache, writePersistentSkillSourceFailure } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRegistryProvider, SkillRequirement } from '../../src/skills/types.js';

const CLI_INITIAL_COMMIT = '1'.repeat(40);
const CLI_REFRESHED_COMMIT = '2'.repeat(40);
const CLI_BLOCKED_COMMIT = '3'.repeat(40);
const PROVIDER_A_COMMIT = '4'.repeat(40);
const PROVIDER_B_COMMIT = '5'.repeat(40);
const IMPORT_COMMIT = '6'.repeat(40);
const UNMATERIALIZED_COMMIT = '7'.repeat(40);
const BATCH_INITIAL_COMMIT = 'a'.repeat(40);
const BATCH_REFRESHED_COMMIT = 'b'.repeat(40);

const passedAuditProvider: SkillRegistryProvider = {
  id: 'fixture',
  async search() { return { provider: 'fixture', experimental: false, candidates: [] }; },
  async audit() { return { status: 'passed' }; },
};

function exactPassedAuditProvider(candidate: SkillCandidate): SkillRegistryProvider {
  return {
    id: candidate.provider,
    async search() { return { provider: candidate.provider, experimental: false, candidates: [] }; },
    async audit() { return { status: 'passed' }; },
  };
}

async function freshMaterializationAuthority(candidate: SkillCandidate) {
  const result = await authorizeSkillMaterialization(exactPassedAuditProvider(candidate), candidate);
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') assert.fail('fixture candidate did not receive materialization authority');
  return result.authorization;
}

function fixtureRequirement(candidate: SkillCandidate): SkillRequirement {
  return {
    id: candidate.slug, technology: candidate.slug, aliases: [candidate.slug], queries: [candidate.slug],
    owners: [candidate.source.split('/')[0]!], repositories: [candidate.source], applicability: { languages: ['TypeScript'] }, signals: {}, reason: 'fixture',
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function capture(operation: () => Promise<unknown>): Promise<Record<string, any>> {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  try { await operation(); } finally { process.stdout.write = original; }
  assert.match(output, /\n$/u);
  return JSON.parse(output) as Record<string, any>;
}

async function captureCli(operation: () => Promise<number>): Promise<{ exitCode: number; body: Record<string, any>; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stderr.write;
  try {
    const exitCode = await operation();
    assert.equal(stdout.split('\n').filter(Boolean).length, 1);
    return { exitCode, body: JSON.parse(stdout) as Record<string, any>, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

async function captureHumanCli(operation: () => Promise<number>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stderr.write;
  try {
    return { exitCode: await operation(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

test('skills CLI rejects invalid state and missing arguments with one stable JSON usage error', async () => {
  let databaseCalls = 0;
  const dependencies = {
    skills: {
      withDatabase: async <T>(_operation: (database: never) => T | Promise<T>): Promise<T> => {
        databaseCalls += 1;
        throw new Error('database should not be opened for invalid command usage');
      },
    },
  };

  const invalidState = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'list', '--state', 'garbage', '--json'], dependencies));
  assert.equal(invalidState.exitCode, 2);
  assert.equal(invalidState.stderr, '');
  assert.equal(invalidState.body.ok, false);
  assert.equal(invalidState.body.operation, 'skills.list');
  assert.equal(invalidState.body.error.code, 'USAGE_ERROR');
  assert.equal(invalidState.body.error.details.commanderCode, 'commander.invalidArgument');

  const missingSkill = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'show', '--json'], dependencies));
  assert.equal(missingSkill.exitCode, 2);
  assert.equal(missingSkill.stderr, '');
  assert.equal(missingSkill.body.operation, 'skills.show');
  assert.equal(missingSkill.body.error.code, 'USAGE_ERROR');
  assert.equal(missingSkill.body.error.details.commanderCode, 'commander.missingArgument');
  assert.equal(databaseCalls, 0);
});

test('skills CLI redacts arbitrary failures in JSON and human output', async () => {
  const sentinel = 'token=private-cli-sentinel /Users/example/private/database.sqlite3';
  const dependencies = {
    skills: {
      withDatabase: async <T>(): Promise<T> => {
        throw new Error(sentinel);
      },
    },
  };

  const json = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'list', '--json'], dependencies));
  assert.equal(json.exitCode, 8);
  assert.equal(json.stderr, '');
  assert.equal(json.body.error.code, 'INTEGRITY_ERROR');
  assert.equal(json.body.error.message, 'Unexpected internal error');
  assert.equal(JSON.stringify(json.body).includes(sentinel), false);

  const human = await captureHumanCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'list'], dependencies));
  assert.equal(human.exitCode, 8);
  assert.equal(human.stdout, '');
  assert.equal(human.stderr, 'Unexpected internal error\n');
  assert.equal(human.stderr.includes(sentinel), false);
});

test('skills CLI lists, shows, disables, enables, and prunes without destructive deletion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture:owner/repo:cli-skill', provider: 'fixture', name: 'cli-skill', slug: 'cli-skill', source: 'owner/repo', sourceType: 'github', installUrl: 'https://github.com/owner/repo', installs: 0, duplicate: false, officialStatus: 'catalog-verified', auditStatus: 'passed',
  };
  const snapshot = validateSkillSnapshot({ candidate, sourceCommit: CLI_INITIAL_COMMIT, files: [{ path: 'skills/cli-skill/SKILL.md', content: '---\nname: CLI skill\ndescription: safe\n---\n# CLI skill\n\nReference.', primary: true }] });
  const authorization = await freshMaterializationAuthority(snapshot.candidate);
  importSkillSnapshot(database, snapshot, chunkSkillMarkdown({ skillName: snapshot.frontmatter.name, sourcePath: snapshot.files[0]!.path, markdown: snapshot.files[0]!.content, summary: snapshot.frontmatter.description, stripFrontmatter: true }), fixtureRequirement(snapshot.candidate), undefined, authorization);
  const cli = buildCli({ skills: { withDatabase: async (operation) => operation(database), provider: passedAuditProvider } });
  try {
    const listed = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'list', '--json']));
    assert.equal(listed.operation, 'skills.list');
    assert.equal(listed.data.length, 1);
    const skillId = listed.data[0].skillId as string;
    const planIdentifier = 'owner/repo/cli-skill';
    const shownByInternalId = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'show', skillId, '--json']));
    assert.equal(shownByInternalId.data.skill.skillId, skillId);
    const shown = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'show', planIdentifier, '--json']));
    assert.equal(shown.operation, 'skills.show');
    assert.equal(shown.data.skill.skillId, skillId);
    assert.equal(shown.data.entries.length, 1);
    const disabled = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'disable', planIdentifier, '--json']));
    assert.equal(disabled.data.state, 'disabled');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 1);

    const staleOriginalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ message: 'not found' }, 404);
    try {
      await assert.rejects(
        () => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', planIdentifier, '--json']),
        (error: unknown) => error instanceof KiokukoError
          && error.code === 'NOT_FOUND'
          && error.details.failureCode === 'source_missing',
      );
      const staleRow = database.prepare('SELECT state, disabled_at AS disabledAt FROM external_skills WHERE skill_id = ?').get<{ state: string; disabledAt: string | null }>(skillId)!;
      assert.equal(staleRow.state, 'stale');
      assert.ok(staleRow.disabledAt);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(skillId)?.count, 0);
    } finally {
      globalThis.fetch = staleOriginalFetch;
    }

    const refreshOriginalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return jsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: CLI_REFRESHED_COMMIT });
      if (url.pathname.includes(`/git/trees/${CLI_REFRESHED_COMMIT}`)) return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/cli-skill/SKILL.md' }] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: CLI skill\ndescription: safe\n---\n# CLI skill\n\nRefreshed reference.', { status: 200 });
      throw new Error(`unexpected source URL ${url}`);
    };
    try {
      const refreshed = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', planIdentifier, '--json']));
      assert.equal(refreshed.data.results.length, 1);
      assert.equal(refreshed.data.failures.length, 0);
      const refreshedRow = database.prepare('SELECT state, source_commit FROM external_skills WHERE skill_id = ?').get<{ state: string; source_commit: string }>(skillId)!;
      assert.equal(refreshedRow.state, 'disabled');
      assert.equal(refreshedRow.source_commit, CLI_REFRESHED_COMMIT);
    } finally {
      globalThis.fetch = refreshOriginalFetch;
    }
    const blockedOriginalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return jsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: CLI_BLOCKED_COMMIT });
      if (url.pathname.includes(`/git/trees/${CLI_BLOCKED_COMMIT}`)) return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/cli-skill/SKILL.md' }] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: CLI skill\ndisable-model-invocation: true\n---\n# CLI skill\n', { status: 200 });
      throw new Error(`unexpected source URL ${url}`);
    };
    try {
      await assert.rejects(
        () => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', skillId, '--json']),
        (error: unknown) => error instanceof KiokukoError
          && error.code === 'SECURITY_REJECTION'
          && error.details.failureCode === 'skill_disabled_for_model_invocation'
          && (error as KiokukoError & { cause?: unknown }).cause instanceof SkillSourceError,
      );
      assert.equal(database.prepare('SELECT state FROM external_skills WHERE skill_id = ?').get<{ state: string }>(skillId)?.state, 'blocked');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(skillId)?.count, 0);
    } finally {
      globalThis.fetch = blockedOriginalFetch;
    }

    const recoveryOriginalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/repo') return jsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: CLI_REFRESHED_COMMIT });
      if (url.pathname.includes(`/git/trees/${CLI_REFRESHED_COMMIT}`)) return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/cli-skill/SKILL.md' }] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: CLI skill\ndescription: safe\n---\n# CLI skill\n\nRefreshed reference.', { status: 200 });
      throw new Error(`unexpected source URL ${url}`);
    };
    try {
      await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', skillId, '--json']));
      const recoveredRow = database.prepare('SELECT state, disabled_at AS disabledAt FROM external_skills WHERE skill_id = ?').get<{ state: string; disabledAt: string | null }>(skillId)!;
      assert.equal(recoveredRow.state, 'disabled');
      assert.ok(recoveredRow.disabledAt);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(skillId)?.count, 0);
    } finally {
      globalThis.fetch = recoveryOriginalFetch;
    }
    const enabled = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'enable', planIdentifier, '--json']));
    assert.equal(enabled.data.state, 'imported');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(skillId)?.count, 1);
    writePersistentSkillSearchCache(database, {
      provider: 'fixture', query: 'expired', mode: 'official', outcome: 'empty',
      result: { provider: 'fixture', experimental: false, candidates: [] },
      ttlMs: 1_000, now: '2020-01-01T00:00:00.000Z',
    });
    writePersistentSkillSearchCache(database, {
      provider: 'fixture', query: 'fresh', mode: 'official', outcome: 'empty',
      result: { provider: 'fixture', experimental: false, candidates: [] },
      ttlMs: 1_000, now: '2099-01-01T00:00:00.000Z',
    });
    writePersistentSkillSourceFailure(database, candidate, 'source_unavailable', 1_000, '2020-01-01T00:00:00.000Z');
    writePersistentSkillSourceFailure(database, { ...candidate, slug: 'fresh-cache' }, 'source_rate_limited', 1_000, '2099-01-01T00:00:00.000Z');
    writePersistentSkillAuditFailure(database, 'fixture-audit', candidate, 'registry_unavailable', 1_000, '2020-01-01T00:00:00.000Z');
    writePersistentSkillAuditFailure(database, 'fixture-audit', { ...candidate, slug: 'fresh-audit-cache' }, 'registry_rate_limited', 1_000, '2099-01-01T00:00:00.000Z');
    const pruned = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'prune-cache', '--json']));
    assert.equal(pruned.operation, 'skills.prune-cache');
    assert.deepEqual(pruned.data, { discovery: 1, sourceFailures: 1, auditFailures: 1, total: 3 });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('skills CLI create-only import does not let a second provider overwrite one source identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-ambiguous-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    for (const provider of ['provider-a', 'provider-b']) {
      const duplicate: SkillCandidate = {
        id: `${provider}:owner/repo:shared-skill`,
        provider,
        name: 'shared-skill',
        slug: 'shared-skill',
        source: 'owner/repo',
        sourceType: 'github',
        installUrl: 'https://github.com/owner/repo',
        installs: 0,
        duplicate: false,
        officialStatus: 'unknown',
        auditStatus: 'passed',
      };
      const duplicateSnapshot = validateSkillSnapshot({
        candidate: duplicate,
        sourceCommit: provider === 'provider-a' ? PROVIDER_A_COMMIT : PROVIDER_B_COMMIT,
        files: [{ path: 'skills/shared-skill/SKILL.md', content: `---\nname: shared-skill\ndescription: ${provider}\n---\n# Shared\n\nReference.`, primary: true }],
      });
      const authorization = await freshMaterializationAuthority(duplicateSnapshot.candidate);
      const operation = () => importSkillSnapshot(database, duplicateSnapshot, chunkSkillMarkdown({
        skillName: duplicateSnapshot.frontmatter.name,
        sourcePath: duplicateSnapshot.files[0]!.path,
        markdown: duplicateSnapshot.files[0]!.content,
        summary: duplicateSnapshot.frontmatter.description,
        stripFrontmatter: true,
      }), fixtureRequirement(duplicateSnapshot.candidate), undefined, authorization);
      if (provider === 'provider-a') operation();
      else assert.throws(operation, (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    }
    const cli = buildCli({ skills: { withDatabase: async (operation) => operation(database) } });
    const rows = database.prepare('SELECT skill_id, provider, source_commit FROM external_skills').all<{ skill_id: string; provider: string; source_commit: string }>();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.skill_id, 'github:owner/repo:shared-skill');
    assert.equal(rows[0]?.provider, 'provider-a');
    assert.equal(rows[0]?.source_commit, PROVIDER_A_COMMIT);
    const shown = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'show', 'owner/repo/shared-skill', '--json']));
    assert.equal(shown.data.skill.skillId, 'github:owner/repo:shared-skill');
  } finally {
    database.close();
  }
});

test('skills CLI reports a moved source as an explicit committed stale outcome', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-moved-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const movedCommit = '8'.repeat(40);
  const candidate: SkillCandidate = {
    id: 'fixture:owner/moved:original-skill', provider: 'fixture', name: 'original-skill', slug: 'original-skill',
    source: 'owner/moved', sourceType: 'github', installUrl: 'https://github.com/owner/moved', installs: 0,
    duplicate: false, officialStatus: 'unknown', auditStatus: 'passed',
  };
  const initial = validateSkillSnapshot({
    candidate,
    sourceCommit: CLI_INITIAL_COMMIT,
    files: [{ path: 'skills/original-skill/SKILL.md', content: '---\nname: original-skill\ndescription: safe\n---\n# Original\n', primary: true }],
  });
  const imported = importSkillSnapshot(
    database,
    initial,
    chunkSkillMarkdown({
      skillName: initial.frontmatter.name,
      sourcePath: initial.files[0]!.path,
      markdown: initial.files[0]!.content,
      summary: initial.frontmatter.description,
      stripFrontmatter: true,
    }),
    fixtureRequirement(initial.candidate),
    undefined,
    await freshMaterializationAuthority(initial.candidate),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/repos/owner/moved') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: movedCommit });
    if (url.pathname.includes(`/git/trees/${movedCommit}`)) return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'tools/skills/original-skill/SKILL.md' }] });
    if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: original-skill\ndescription: safe\n---\n# Moved\n', { status: 200 });
    throw new Error(`unexpected moved source URL ${url}`);
  };
  try {
    const response = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'],
      { skills: { withDatabase: async (operation) => operation(database), provider: passedAuditProvider } },
    ));
    assert.equal(response.exitCode, 0, JSON.stringify(response.body));
    assert.equal(response.body.data.refreshed, 0);
    assert.equal(response.body.data.staled, 1);
    assert.equal(response.body.data.committed, 1);
    assert.equal(response.body.data.results.length, 1);
    assert.equal(response.body.data.results[0]?.kind, 'staled');
    assert.equal(response.body.data.results[0]?.skill.skillId, imported.skillId);
    assert.equal(database.prepare('SELECT state FROM external_skills WHERE skill_id = ?').get<{ state: string }>(imported.skillId)?.state, 'stale');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('skills CLI finds without saving and rejects unreviewed manual imports', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-import-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.KIOKUKO_SKILLS_V1_TOKEN;
  const originalApiUrl = process.env.KIOKUKO_SKILLS_API_URL;
  delete process.env.KIOKUKO_SKILLS_V1_TOKEN;
  process.env.KIOKUKO_SKILLS_API_URL = 'https://skills.sh';
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'skills.sh') return jsonResponse({
      query: 'svelte',
      searchType: 'fuzzy',
      skills: [{
        id: 'owner/repo/imported-skill',
        skillId: 'imported-skill',
        name: 'Imported skill',
        installs: 1,
        source: 'owner/repo',
      }],
      count: 1,
      duration_ms: 1,
    });
    if (url.pathname === '/repos/owner/repo') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: IMPORT_COMMIT });
    if (url.pathname.includes(`/git/trees/${IMPORT_COMMIT}`)) return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/imported-skill/SKILL.md' }] });
    if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: Imported skill\ndescription: safe\n---\n# Imported skill\n\nReference.', { status: 200 });
    throw new Error(`unexpected source URL ${url}`);
  };
  try {
    const cli = buildCli({ skills: { withDatabase: async (operation) => operation(database) } });
    const found = await capture(() => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'find', 'svelte', '--json']));
    assert.equal(found.operation, 'skills.find');
    assert.equal(found.data.candidates.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    const rejected = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'import', 'owner/repo/imported-skill', '--json'],
      { skills: { withDatabase: async (operation) => operation(database), provider: passedAuditProvider } },
    ));
    assert.equal(rejected.exitCode, 3);
    assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.KIOKUKO_SKILLS_V1_TOKEN; else process.env.KIOKUKO_SKILLS_V1_TOKEN = originalToken;
    if (originalApiUrl === undefined) delete process.env.KIOKUKO_SKILLS_API_URL; else process.env.KIOKUKO_SKILLS_API_URL = originalApiUrl;
    database.close();
  }
});

test('skills CLI converts only recognized find and import domain failures to bounded public errors', async () => {
  // Let node:test flush the preceding test-complete event before this test
  // temporarily captures process.stdout for the CLI JSON envelope.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const providerFailure = await captureCli(() => runCli(
    ['node', 'kiokuko-ai', 'skills', 'find', 'svelte', '--json'],
    { skills: {
      withDatabase: async <T>(): Promise<T> => { throw new Error('find must not open the database'); },
      provider: {
        id: 'fixture-provider-failure',
        async search() { throw new SkillProviderError('registry_rate_limited', 30); },
      },
    } },
  ));
  assert.equal(providerFailure.exitCode, 6);
  assert.equal(providerFailure.stderr, '');
  assert.equal(providerFailure.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(providerFailure.body.error.message, 'External skill registry is temporarily unavailable');
  assert.deepEqual(providerFailure.body.error.details, {
    failureCode: 'registry_rate_limited',
    retryAfterSeconds: 30,
  });

  const programmerError = new TypeError('provider-programmer-sentinel');
  const programmerCli = buildCli({ skills: {
    withDatabase: async <T>(): Promise<T> => { throw new Error('find must not open the database'); },
    provider: {
      id: 'fixture-provider-programmer-error',
      async search() { throw programmerError; },
    },
  } });
  await assert.rejects(
    () => programmerCli.parseAsync(['node', 'kiokuko-ai', 'skills', 'find', 'svelte', '--json']),
    (error: unknown) => error === programmerError,
  );

  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-import-domain-error-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ message: 'upstream-private-body-sentinel' }, 404);
  try {
    const sourceFailure = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'import', 'sveltejs/ai-tools/svelte-code-writer', '--json'],
      { skills: { withDatabase: async (operation) => operation(database) } },
    ));
    assert.equal(sourceFailure.exitCode, 4);
    assert.equal(sourceFailure.stderr, '');
    assert.equal(sourceFailure.body.error.code, 'NOT_FOUND');
    assert.equal(sourceFailure.body.error.message, 'External skill source was not found');
    assert.deepEqual(sourceFailure.body.error.details, { failureCode: 'source_missing' });
    assert.equal(JSON.stringify(sourceFailure.body).includes('upstream-private-body-sentinel'), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('skills CLI import is create-only when the identity appears after both source fetches', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-create-race-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const firstDatabase = openConnection(databasePath);
  migrateDatabase(firstDatabase);
  const secondDatabase = openConnection(databasePath);
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const commit = '8'.repeat(40);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/repos/sveltejs/ai-tools') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: commit });
    if (url.pathname.includes(`/git/trees/${commit}`)) return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }] });
    if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: svelte-code-writer\ndescription: safe\n---\n# Svelte\n\nReference.', { status: 200 });
    throw new Error(`unexpected source URL ${url}`);
  };
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let arrivals = 0;
  let release!: () => void;
  const bothFetched = new Promise<void>((resolve) => { release = resolve; });
  const dependency = (database: typeof firstDatabase) => ({
    withDatabase: async <T>(operation: (value: typeof firstDatabase) => T | Promise<T>): Promise<T> => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothFetched;
      return operation(database);
    },
  });
  try {
    const firstCli = buildCli({ skills: dependency(firstDatabase) });
    const secondCli = buildCli({ skills: dependency(secondDatabase) });
    const results = await Promise.allSettled([
      firstCli.parseAsync(['node', 'kiokuko-ai', 'skills', 'import', 'sveltejs/ai-tools/svelte-code-writer', '--json']),
      secondCli.parseAsync(['node', 'kiokuko-ai', 'skills', 'import', 'sveltejs/ai-tools/svelte-code-writer', '--json']),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.ok(rejected);
    assert.equal((rejected.reason as { code?: string }).code, 'CONFLICT');
    assert.match((rejected.reason as Error).message, /already exists; use refresh/iu);
    assert.equal(firstDatabase.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 1);
    assert.equal(firstDatabase.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 1);
    assert.equal(firstDatabase.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(firstDatabase.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count, 1);
    const winner = firstDatabase.prepare('SELECT provider, source_commit AS sourceCommit, generation FROM external_skills').get<{ provider: string; sourceCommit: string; generation: number }>();
    assert.equal(winner?.provider, 'kiokuko-reviewed-catalog');
    assert.equal(winner?.sourceCommit, commit);
    assert.equal(winner?.generation, 2);
    const tags = firstDatabase.prepare('SELECT tag FROM entry_revision_tags ORDER BY tag').all<{ tag: string }>().map((row) => row.tag);
    assert.ok(tags.includes('provider:kiokuko-reviewed-catalog'));
    assert.equal(tags.includes('provider:skills-sh'), false);
    assert.equal(firstDatabase.prepare('SELECT COUNT(*) AS count FROM external_skill_generation_tokens').get<{ count: number }>()?.count, 1);
    assert.equal(firstDatabase.prepare('SELECT value FROM external_skill_generation_clock WHERE singleton = 1').get<{ value: number }>()?.value, 2);
  } finally {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
    secondDatabase.close();
    firstDatabase.close();
  }
});

test('skills CLI refresh rejects an unverified row without persisted applicability', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-unmaterialized-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture:owner/recovery:recovery-skill', provider: 'fixture', name: 'recovery-skill', slug: 'recovery-skill', source: 'owner/recovery', sourceType: 'github', installUrl: 'https://github.com/owner/recovery', installs: 0, duplicate: false, officialStatus: 'unknown',
  };
  const discovered = recordDiscoveredSkill(database, candidate, '2026-08-25T00:00:00.000Z');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/repos/owner/recovery') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: UNMATERIALIZED_COMMIT });
    if (url.pathname.includes(`/git/trees/${UNMATERIALIZED_COMMIT}`)) return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/recovery-skill/SKILL.md' }] });
    if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: Recovery skill\ndescription: safe\n---\n# Recovery\n\nRecovered.', { status: 200 });
    throw new Error(`unexpected recovery source URL ${url}`);
  };
  try {
    const refreshed = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', discovered.skillId, '--json'],
      { skills: { withDatabase: async (operation) => operation(database) } },
    ));
    assert.equal(refreshed.exitCode, 7);
    assert.equal(refreshed.body.ok, false);
    assert.equal(refreshed.body.error.code, 'SECURITY_REJECTION');
    const stored = database.prepare('SELECT state, source_commit, snapshot_hash FROM external_skills WHERE skill_id = ?').get<{ state: string; source_commit: string | null; snapshot_hash: string | null }>(discovered.skillId)!;
    assert.equal(stored.state, 'discovered');
    assert.equal(stored.source_commit, null);
    assert.equal(stored.snapshot_hash, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ?').get<{ count: number }>(discovered.skillId)?.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('targeted refresh exposes bounded source-missing and rate-limit contracts in JSON and human modes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-targeted-source-errors-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture:owner/public-errors:public-errors',
    provider: 'fixture',
    name: 'public-errors',
    slug: 'public-errors',
    source: 'owner/public-errors',
    sourceType: 'github',
    installUrl: 'https://github.com/owner/public-errors',
    installs: 0,
    duplicate: false,
    officialStatus: 'registry-only',
    auditStatus: 'passed',
  };
  const snapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: BATCH_INITIAL_COMMIT,
    files: [{
      path: 'skills/public-errors/SKILL.md',
      content: '---\nname: public-errors\ndescription: safe\n---\n# Public errors\n',
      primary: true,
    }],
  });
  const authorization = await freshMaterializationAuthority(snapshot.candidate);
  const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
    skillName: snapshot.frontmatter.name,
    sourcePath: snapshot.files[0]!.path,
    markdown: snapshot.files[0]!.content,
    summary: snapshot.frontmatter.description,
    stripFrontmatter: true,
  }), fixtureRequirement(snapshot.candidate), undefined, authorization);
  const dependencies = { skills: { withDatabase: async <T>(operation: (value: typeof database) => T | Promise<T>): Promise<T> => operation(database), provider: passedAuditProvider } };
  const originalFetch = globalThis.fetch;
  let failure: 'missing' | 'rate-limited' = 'missing';
  globalThis.fetch = async () => failure === 'missing'
    ? jsonResponse({ message: 'upstream-missing-body-sentinel' }, 404)
    : new Response('', { status: 429, headers: { 'retry-after': '45' } });
  try {
    const missingJson = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'],
      dependencies,
    ));
    assert.equal(missingJson.exitCode, 4);
    assert.equal(missingJson.stderr, '');
    assert.equal(missingJson.body.error.code, 'NOT_FOUND');
    assert.equal(missingJson.body.error.message, 'External skill source was not found');
    assert.deepEqual(missingJson.body.error.details, { failureCode: 'source_missing' });
    assert.equal(JSON.stringify(missingJson.body).includes('upstream-missing-body-sentinel'), false);
    assert.equal(database.prepare('SELECT state FROM external_skills WHERE skill_id = ?').get<{ state: string }>(imported.skillId)?.state, 'stale');

    const missingHuman = await captureHumanCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId],
      dependencies,
    ));
    assert.equal(missingHuman.exitCode, 4);
    assert.equal(missingHuman.stdout, '');
    assert.equal(missingHuman.stderr, 'External skill source was not found\n');

    failure = 'rate-limited';
    const rateLimitedJson = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'],
      dependencies,
    ));
    assert.equal(rateLimitedJson.exitCode, 6);
    assert.equal(rateLimitedJson.stderr, '');
    assert.equal(rateLimitedJson.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(rateLimitedJson.body.error.message, 'External skill source is temporarily unavailable');
    assert.deepEqual(rateLimitedJson.body.error.details, {
      failureCode: 'source_rate_limited',
      retryAfterSeconds: 45,
    });

    const rateLimitedHuman = await captureHumanCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId],
      dependencies,
    ));
    assert.equal(rateLimitedHuman.exitCode, 6);
    assert.equal(rateLimitedHuman.stdout, '');
    assert.equal(rateLimitedHuman.stderr, 'External skill source is temporarily unavailable\n');
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('batch refresh stops on the first source rate limit and reports remaining work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-rate-limit-stop-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const imported: string[] = [];
  for (const prefix of ['aa', 'bb', 'cc']) {
    const candidate: SkillCandidate = {
      id: `fixture:${prefix}/repo:${prefix}-skill`, provider: 'fixture', name: `${prefix}-skill`, slug: `${prefix}-skill`,
      source: `${prefix}/repo`, sourceType: 'github', installUrl: `https://github.com/${prefix}/repo`, installs: 0,
      duplicate: false, officialStatus: 'unknown', auditStatus: 'passed',
    };
    const snapshot = validateSkillSnapshot({
      candidate,
      sourceCommit: BATCH_INITIAL_COMMIT,
      files: [{ path: `skills/${candidate.slug}/SKILL.md`, content: `---\nname: ${candidate.name}\ndescription: safe\n---\n# ${candidate.name}\n`, primary: true }],
    });
    const result = importSkillSnapshot(
      database,
      snapshot,
      chunkSkillMarkdown({
        skillName: snapshot.frontmatter.name,
        sourcePath: snapshot.files[0]!.path,
        markdown: snapshot.files[0]!.content,
        summary: snapshot.frontmatter.description,
        stripFrontmatter: true,
      }),
      fixtureRequirement(snapshot.candidate),
      undefined,
      await freshMaterializationAuthority(snapshot.candidate),
    );
    imported.push(result.skillId);
  }
  const originalFetch = globalThis.fetch;
  let sourceRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/repos/')) {
      sourceRequests += 1;
      return new Response('', { status: 429, headers: { 'retry-after': '60' } });
    }
    throw new Error(`unexpected rate-limit source URL ${url}`);
  };
  try {
    const response = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', '--json'],
      { skills: { withDatabase: async (operation) => operation(database), provider: passedAuditProvider } },
    ));
    assert.equal(response.exitCode, 9);
    assert.equal(sourceRequests, 1);
    assert.deepEqual(response.body.error.details, {
      attempted: 1,
      completed: 1,
      succeeded: 0,
      staled: 0,
      committed: 0,
      failed: 1,
      remaining: 2,
      failures: [{ skillId: imported[0], code: 'source_rate_limited' }],
      truncated: false,
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM external_skills WHERE state = 'imported'").get<{ count: number }>()?.count, 3);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('batch refresh marks 404 sources stale and returns a bounded typed partial-failure envelope', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-partial-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidates: SkillCandidate[] = [
    {
      id: 'fixture:owner/success:skill-success', provider: 'fixture', name: 'skill-success', slug: 'skill-success', source: 'owner/success', sourceType: 'github', installUrl: 'https://github.com/owner/success', installs: 0, duplicate: false, officialStatus: 'unknown', auditStatus: 'passed',
    },
    ...Array.from({ length: 21 }, (_, index): SkillCandidate => ({
      id: `fixture:owner/fail-${index}:skill-${index}`, provider: 'fixture', name: `skill-${index}`, slug: `skill-${index}`, source: `owner/fail-${index}`, sourceType: 'github', installUrl: `https://github.com/owner/fail-${index}`, installs: 0, duplicate: false, officialStatus: 'unknown', auditStatus: 'passed',
    })),
  ];
  for (const candidate of candidates) {
    const snapshot = validateSkillSnapshot({
      candidate,
      sourceCommit: BATCH_INITIAL_COMMIT,
      files: [{ path: `skills/${candidate.slug}/SKILL.md`, content: `---\nname: ${candidate.name}\ndescription: safe\n---\n# ${candidate.name}\n`, primary: true }],
    });
    const authorization = await freshMaterializationAuthority(snapshot.candidate);
    importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
      skillName: snapshot.frontmatter.name,
      sourcePath: snapshot.files[0]!.path,
      markdown: snapshot.files[0]!.content,
      summary: snapshot.frontmatter.description,
      stripFrontmatter: true,
    }), fixtureRequirement(snapshot.candidate), undefined, authorization);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/repos/owner/fail-')) return jsonResponse({ message: 'not found' }, 404);
    if (url.pathname === '/repos/owner/success') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: BATCH_REFRESHED_COMMIT });
    if (url.pathname.includes(`/git/trees/${BATCH_REFRESHED_COMMIT}`)) return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/skill-success/SKILL.md' }] });
    if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: skill-success\ndescription: safe\n---\n# skill-success\n\nRefreshed.', { status: 200 });
    throw new Error('unexpected success source URL');
  };
  try {
    const refreshed = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', '--json'],
      { skills: { withDatabase: async (operation) => operation(database), provider: passedAuditProvider } },
    ));
    assert.equal(refreshed.exitCode, 9);
    assert.equal(refreshed.stderr, '');
    assert.equal(refreshed.body.ok, false);
    assert.equal(refreshed.body.operation, 'skills.refresh');
    assert.equal(refreshed.body.error.code, 'PARTIAL_FAILURE');
    assert.equal(refreshed.body.error.details.attempted, 22);
    assert.equal(refreshed.body.error.details.completed, 22);
    assert.equal(refreshed.body.error.details.succeeded, 1);
    assert.equal(refreshed.body.error.details.staled, 21);
    assert.equal(refreshed.body.error.details.committed, 22);
    assert.equal(refreshed.body.error.details.failed, 21);
    assert.equal(refreshed.body.error.details.remaining, 0);
    assert.equal(refreshed.body.error.details.failures.length, 20);
    assert.equal(refreshed.body.error.details.truncated, true);
    assert.ok(refreshed.body.error.details.failures.every((failure: Record<string, unknown>) => failure.code === 'source_missing'));
    assert.equal(database.prepare('SELECT source_commit FROM external_skills WHERE source_locator = ?').get<{ source_commit: string }>('owner/success')?.source_commit, BATCH_REFRESHED_COMMIT);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM external_skills WHERE source_locator LIKE 'owner/fail-%' AND state = 'stale'").get<{ count: number }>()?.count, 21);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM external_skill_entries AS e JOIN external_skills AS s ON s.skill_id = e.skill_id WHERE s.source_locator LIKE 'owner/fail-%' AND e.active = 1").get<{ count: number }>()?.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('batch refresh reports the exact later audit cause after an exact reviewed-catalog replay commits', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-post-commit-audit-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const reviewedCandidate: SkillCandidate = {
    id: 'fixture:sveltejs/ai-tools:svelte-code-writer',
    provider: 'fixture',
    name: 'svelte-code-writer',
    slug: 'svelte-code-writer',
    source: 'sveltejs/ai-tools',
    sourceType: 'github',
    installUrl: 'https://github.com/sveltejs/ai-tools',
    installs: 0,
    duplicate: false,
    officialStatus: 'catalog-verified',
    auditStatus: 'not-required',
  };
  const communityCandidate: SkillCandidate = {
    id: 'fixture:zz-community/refresh:community-helper',
    provider: 'fixture',
    name: 'community-helper',
    slug: 'community-helper',
    source: 'zz-community/refresh',
    sourceType: 'github',
    installUrl: 'https://github.com/zz-community/refresh',
    installs: 0,
    duplicate: false,
    officialStatus: 'registry-only',
    auditStatus: 'passed',
  };
  const reviewedInitial = validateSkillSnapshot({
    candidate: reviewedCandidate,
    sourceCommit: BATCH_INITIAL_COMMIT,
    files: [{
      path: 'skills/svelte-code-writer/SKILL.md',
      content: '---\nname: svelte-code-writer\ndescription: reviewed\n---\n# Svelte\n\nInitial.',
      primary: true,
    }],
  });
  const communityInitial = validateSkillSnapshot({
    candidate: communityCandidate,
    sourceCommit: BATCH_INITIAL_COMMIT,
    files: [{
      path: 'skills/community-helper/SKILL.md',
      content: '---\nname: community-helper\ndescription: community\n---\n# Community\n\nInitial.',
      primary: true,
    }],
  });
  const reviewed = importSkillSnapshot(
    database,
    reviewedInitial,
    chunkSkillMarkdown({
      skillName: reviewedInitial.frontmatter.name,
      sourcePath: reviewedInitial.files[0]!.path,
      markdown: reviewedInitial.files[0]!.content,
      summary: reviewedInitial.frontmatter.description,
      stripFrontmatter: true,
    }),
    fixtureRequirement(reviewedInitial.candidate),
  );
  const community = importSkillSnapshot(
    database,
    communityInitial,
    chunkSkillMarkdown({
      skillName: communityInitial.frontmatter.name,
      sourcePath: communityInitial.files[0]!.path,
      markdown: communityInitial.files[0]!.content,
      summary: communityInitial.frontmatter.description,
      stripFrontmatter: true,
    }),
    fixtureRequirement(communityInitial.candidate),
    undefined,
    await freshMaterializationAuthority(communityInitial.candidate),
  );
  const reviewedGenerationBefore = database.prepare('SELECT generation FROM external_skills WHERE skill_id = ?')
    .get<{ generation: number }>(reviewed.skillId)!.generation;
  const originalFetch = globalThis.fetch;
  let communitySourceFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/zz-community/refresh')) {
      communitySourceFetches += 1;
      throw new Error('community source must not be fetched before a passed fresh audit');
    }
    if (url.pathname === '/repos/sveltejs/ai-tools') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: BATCH_INITIAL_COMMIT });
    if (url.pathname.includes(`/git/trees/${BATCH_INITIAL_COMMIT}`)) {
      return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }] });
    }
    if (url.pathname.endsWith('/SKILL.md')) {
      return new Response('---\nname: svelte-code-writer\ndescription: reviewed\n---\n# Svelte\n\nInitial.', { status: 200 });
    }
    throw new Error(`unexpected reviewed source URL ${url}`);
  };
  try {
    const cli = buildCli({
      skills: {
        withDatabase: async (operation) => operation(database),
        provider: {
          id: communityCandidate.provider,
          async search() { return { provider: communityCandidate.provider, experimental: false, candidates: [] }; },
        },
      },
    });
    await assert.rejects(
      () => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', '--json']),
      (error: unknown) => {
        assert.ok(error instanceof KiokukoError);
        assert.equal(error.code, 'PARTIAL_FAILURE');
        assert.deepEqual(error.details, {
          attempted: 2,
          completed: 1,
          succeeded: 1,
          staled: 0,
          committed: 1,
          failed: 1,
          remaining: 0,
          failures: [],
          truncated: false,
          cause: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'External skill provider audit is unavailable',
            details: { failureCode: 'registry_unavailable' },
          },
        });
        const cause = (error as KiokukoError & { cause?: unknown }).cause;
        assert.ok(cause instanceof KiokukoError);
        assert.equal(cause.code, 'SERVICE_UNAVAILABLE');
        assert.equal(cause.details.failureCode, 'registry_unavailable');
        return true;
      },
    );
    assert.equal(communitySourceFetches, 0);
    const reviewedAfter = database.prepare('SELECT generation, source_commit FROM external_skills WHERE skill_id = ?')
      .get<{ generation: number; source_commit: string }>(reviewed.skillId)!;
    assert.ok(reviewedAfter.generation > reviewedGenerationBefore);
    assert.equal(reviewedAfter.source_commit, BATCH_INITIAL_COMMIT);
    assert.equal(database.prepare('SELECT source_commit FROM external_skills WHERE skill_id = ?').get<{ source_commit: string }>(community.skillId)?.source_commit, BATCH_INITIAL_COMMIT);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('batch refresh reports an unknown later source code as fatal after preserving an earlier commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-post-commit-source-code-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidates: SkillCandidate[] = [
    {
      id: 'fixture:aa-success/repo:success-skill',
      provider: 'fixture',
      name: 'success-skill',
      slug: 'success-skill',
      source: 'aa-success/repo',
      sourceType: 'github',
      installUrl: 'https://github.com/aa-success/repo',
      installs: 0,
      duplicate: false,
      officialStatus: 'registry-only',
      auditStatus: 'passed',
    },
    {
      id: 'fixture:zz-fail/repo:fail-skill',
      provider: 'fixture',
      name: 'fail-skill',
      slug: 'fail-skill',
      source: 'zz-fail/repo',
      sourceType: 'github',
      installUrl: 'https://github.com/zz-fail/repo',
      installs: 0,
      duplicate: false,
      officialStatus: 'registry-only',
      auditStatus: 'passed',
    },
  ];
  const imported = [];
  for (const candidate of candidates) {
    const snapshot = validateSkillSnapshot({
      candidate,
      sourceCommit: BATCH_INITIAL_COMMIT,
      files: [{
        path: `skills/${candidate.slug}/SKILL.md`,
        content: `---\nname: ${candidate.name}\ndescription: safe\n---\n# ${candidate.name}\n\nInitial.`,
        primary: true,
      }],
    });
    imported.push({
      candidate,
      snapshot,
      result: importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
        skillName: snapshot.frontmatter.name,
        sourcePath: snapshot.files[0]!.path,
        markdown: snapshot.files[0]!.content,
        summary: snapshot.frontmatter.description,
        stripFrontmatter: true,
      }), fixtureRequirement(snapshot.candidate), undefined, await freshMaterializationAuthority(snapshot.candidate)),
    });
  }
  const lifecycle = (skillId: string) => ({ ...database.prepare(`
    SELECT state, generation, source_commit AS sourceCommit, snapshot_hash AS snapshotHash,
           last_checked_at AS lastCheckedAt, disabled_at AS disabledAt
      FROM external_skills
     WHERE skill_id = ?
  `).get<Record<string, unknown>>(skillId) });
  const successBefore = lifecycle(imported[0]!.result.skillId);
  const failedBefore = lifecycle(imported[1]!.result.skillId);
  const failedActiveBefore = database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1')
    .get<{ count: number }>(imported[1]!.result.skillId)?.count;
  const forgedSourceFailure = new SkillSourceError('source_future_failure' as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/repos/zz-fail/repo')) throw forgedSourceFailure;
    if (url.pathname === '/repos/aa-success/repo') return jsonResponse({ default_branch: 'main' });
    if (url.pathname.endsWith('/commits/main')) return jsonResponse({ sha: BATCH_INITIAL_COMMIT });
    if (url.pathname.includes(`/git/trees/${BATCH_INITIAL_COMMIT}`)) {
      return jsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/success-skill/SKILL.md' }] });
    }
    if (url.pathname.endsWith('/SKILL.md')) {
      return new Response('---\nname: success-skill\ndescription: safe\n---\n# success-skill\n\nInitial.', { status: 200 });
    }
    throw new Error(`unexpected success source URL ${url}`);
  };
  try {
    const cli = buildCli({ skills: { withDatabase: async (operation) => operation(database), provider: passedAuditProvider } });
    await assert.rejects(
      () => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', '--json']),
      (error: unknown) => {
        assert.ok(error instanceof KiokukoError);
        assert.equal(error.code, 'PARTIAL_FAILURE');
        assert.deepEqual(error.details, {
          attempted: 2,
          completed: 1,
          succeeded: 1,
          staled: 0,
          committed: 1,
          failed: 1,
          remaining: 0,
          failures: [],
          truncated: false,
          cause: { code: 'source_future_failure' },
        });
        assert.equal((error as KiokukoError & { cause?: unknown }).cause, forgedSourceFailure);
        return true;
      },
    );
    const successAfter = lifecycle(imported[0]!.result.skillId);
    assert.ok(Number(successAfter.generation) > Number(successBefore.generation));
    assert.equal(successAfter.sourceCommit, successBefore.sourceCommit);
    assert.deepEqual(lifecycle(imported[1]!.result.skillId), failedBefore);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1')
      .get<{ count: number }>(imported[1]!.result.skillId)?.count, failedActiveBefore);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('skills CLI does not reuse a stored passed audit to authorize a new source snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-fresh-audit-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture:community/refresh:react-helper', provider: 'fixture', name: 'react-helper', slug: 'react-helper', source: 'community/refresh', sourceType: 'github', installUrl: 'https://github.com/community/refresh', installs: 0, duplicate: false, officialStatus: 'registry-only', auditStatus: 'passed',
  };
  const snapshot = validateSkillSnapshot({ candidate, sourceCommit: BATCH_INITIAL_COMMIT, files: [{ path: 'skills/react-helper/SKILL.md', content: '---\nname: react-helper\ndescription: safe\n---\n# React\n', primary: true }] });
  const authorization = await freshMaterializationAuthority(snapshot.candidate);
  const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
    skillName: snapshot.frontmatter.name, sourcePath: snapshot.files[0]!.path, markdown: snapshot.files[0]!.content,
    summary: snapshot.frontmatter.description, stripFrontmatter: true,
  }), fixtureRequirement(snapshot.candidate), undefined, authorization);
  const before = database.prepare('SELECT generation, source_commit AS sourceCommit FROM external_skills WHERE skill_id = ?').get<{ generation: number; sourceCommit: string }>(imported.skillId)!;
  const originalFetch = globalThis.fetch;
  let sourceCalls = 0;
  globalThis.fetch = async () => { sourceCalls += 1; throw new Error('fresh audit rejection must happen before GitHub fetch'); };
  try {
    const rejected = await captureCli(() => runCli(
      ['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'],
      { skills: {
        withDatabase: async (operation) => operation(database),
        provider: { id: candidate.provider, async search() { return { provider: candidate.provider, experimental: false, candidates: [] }; } },
      } },
    ));
    assert.equal(rejected.exitCode, 6);
    assert.equal(rejected.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(rejected.body.error.details.failureCode, 'registry_unavailable');
    assert.equal(sourceCalls, 0);
    assert.deepEqual(database.prepare('SELECT generation, source_commit AS sourceCommit FROM external_skills WHERE skill_id = ?').get(imported.skillId), before);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

for (const scenario of [
  { label: 'rate limit', code: 'registry_rate_limited', retryAfterSeconds: 23 },
  { label: 'unavailable response', code: 'registry_unavailable', retryAfterSeconds: null },
] as const) {
  test(`targeted community refresh persists exact audit ${scenario.label} backoff without changing lifecycle`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-external-skill-cli-audit-backoff-${scenario.code}-`));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    const candidate: SkillCandidate = {
      id: `fixture-audit-backoff:community/backoff:${scenario.code}`,
      provider: 'fixture-audit-backoff',
      name: scenario.code,
      slug: scenario.code,
      source: 'community/backoff',
      sourceType: 'github',
      installUrl: 'https://github.com/community/backoff',
      installs: 0,
      duplicate: false,
      officialStatus: 'registry-only',
      auditStatus: 'passed',
    };
    const snapshot = validateSkillSnapshot({
      candidate,
      sourceCommit: BATCH_INITIAL_COMMIT,
      files: [{
        path: `skills/${candidate.slug}/SKILL.md`,
        content: `---\nname: ${candidate.name}\ndescription: safe\n---\n# Audit backoff\n`,
        primary: true,
      }],
    });
    const authorization = await freshMaterializationAuthority(snapshot.candidate);
    const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
      skillName: snapshot.frontmatter.name,
      sourcePath: snapshot.files[0]!.path,
      markdown: snapshot.files[0]!.content,
      summary: snapshot.frontmatter.description,
      stripFrontmatter: true,
    }), fixtureRequirement(snapshot.candidate), undefined, authorization);
    const lifecycle = () => database.prepare(`
      SELECT state, generation, source_commit AS sourceCommit, snapshot_hash AS snapshotHash,
             last_checked_at AS lastCheckedAt, disabled_at AS disabledAt
        FROM external_skills
       WHERE skill_id = ?
    `).get(imported.skillId);
    const before = lifecycle();
    const activeBefore = database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1')
      .get<{ count: number }>(imported.skillId)?.count;
    let auditCalls = 0;
    let sourceCalls = 0;
    const provider: SkillRegistryProvider = {
      id: candidate.provider,
      async search() { return { provider: candidate.provider, experimental: false, candidates: [] }; },
      async audit() {
        auditCalls += 1;
        throw new SkillProviderError(scenario.code, scenario.retryAfterSeconds);
      },
    };
    const dependencies = { skills: { withDatabase: async <T>(operation: (value: typeof database) => T | Promise<T>): Promise<T> => operation(database), provider } };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      sourceCalls += 1;
      throw new Error('audit backoff must reject before source retrieval');
    };
    try {
      const first = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'], dependencies));
      assert.equal(first.exitCode, 6);
      assert.equal(first.body.error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(first.body.error.details.failureCode, scenario.code);
      if (scenario.retryAfterSeconds !== null) assert.equal(first.body.error.details.retryAfterSeconds, scenario.retryAfterSeconds);
      assert.equal(auditCalls, 1);
      assert.equal(sourceCalls, 0);
      assert.deepEqual(lifecycle(), before);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1')
        .get<{ count: number }>(imported.skillId)?.count, activeBefore);

      const cached = database.prepare(`
        SELECT outcome, fetched_at AS fetchedAt, expires_at AS expiresAt
          FROM skill_audit_failure_cache
         WHERE provider = ? AND source_locator = ? AND slug = ?
      `).get<{ outcome: string; fetchedAt: string; expiresAt: string }>(candidate.provider, candidate.source, candidate.slug)!;
      assert.equal(cached.outcome, scenario.code);
      if (scenario.retryAfterSeconds !== null) {
        assert.equal(Date.parse(cached.expiresAt) - Date.parse(cached.fetchedAt), scenario.retryAfterSeconds * 1_000);
      }

      const second = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'], dependencies));
      assert.equal(second.exitCode, 6);
      assert.equal(second.body.error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(second.body.error.details.failureCode, scenario.code);
      assert.equal(auditCalls, 1);
      assert.equal(sourceCalls, 0);
      assert.deepEqual(lifecycle(), before);

      if (scenario.retryAfterSeconds !== null) {
        database.prepare(`
          UPDATE skill_audit_failure_cache
             SET fetched_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-01T00:00:01.000Z'
           WHERE provider = ? AND source_locator = ? AND slug = ?
        `).run(candidate.provider, candidate.source, candidate.slug);
        const afterExpiry = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'], dependencies));
        assert.equal(afterExpiry.exitCode, 6);
        assert.equal(auditCalls, 2);
        assert.equal(sourceCalls, 0);
        assert.deepEqual(lifecycle(), before);
      }
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });
}

for (const scenario of [
  { label: 'rate limit', outcome: 'source_rate_limited', status: 429, retryAfterSeconds: 19 },
  { label: 'unavailable response', outcome: 'source_unavailable', status: 503, retryAfterSeconds: null },
] as const) {
  test(`targeted reviewed refresh persists exact source ${scenario.label} backoff without upstream retry or state mutation`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-external-skill-cli-source-backoff-${scenario.outcome}-`));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    const candidate: SkillCandidate = {
      id: 'kiokuko-reviewed-catalog:sveltejs/ai-tools:svelte-code-writer',
      provider: 'kiokuko-reviewed-catalog',
      name: 'svelte-code-writer',
      slug: 'svelte-code-writer',
      source: 'sveltejs/ai-tools',
      sourceType: 'github',
      installUrl: 'https://github.com/sveltejs/ai-tools',
      installs: 0,
      duplicate: false,
      officialStatus: 'catalog-verified',
      auditStatus: 'not-required',
    };
    const snapshot = validateSkillSnapshot({
      candidate,
      sourceCommit: BATCH_INITIAL_COMMIT,
      files: [{
        path: 'skills/svelte-code-writer/SKILL.md',
        content: '---\nname: svelte-code-writer\ndescription: safe\n---\n# Source backoff\n',
        primary: true,
      }],
    });
    const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
      skillName: snapshot.frontmatter.name,
      sourcePath: snapshot.files[0]!.path,
      markdown: snapshot.files[0]!.content,
      summary: snapshot.frontmatter.description,
      stripFrontmatter: true,
    }), fixtureRequirement(snapshot.candidate));
    const lifecycle = () => database.prepare(`
      SELECT state, generation, source_commit AS sourceCommit, snapshot_hash AS snapshotHash,
             last_checked_at AS lastCheckedAt, disabled_at AS disabledAt
        FROM external_skills
       WHERE skill_id = ?
    `).get(imported.skillId);
    const before = lifecycle();
    const activeBefore = database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1')
      .get<{ count: number }>(imported.skillId)?.count;
    const originalFetch = globalThis.fetch;
    let sourceCalls = 0;
    globalThis.fetch = async () => {
      sourceCalls += 1;
      return new Response('', {
        status: scenario.status,
        ...(scenario.retryAfterSeconds === null ? {} : { headers: { 'retry-after': String(scenario.retryAfterSeconds) } }),
      });
    };
    const dependencies = { skills: { withDatabase: async <T>(operation: (value: typeof database) => T | Promise<T>): Promise<T> => operation(database), provider: passedAuditProvider } };
    try {
      const first = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'], dependencies));
      assert.equal(first.exitCode, 6);
      assert.equal(first.body.error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(first.body.error.details.failureCode, scenario.outcome);
      if (scenario.retryAfterSeconds !== null) assert.equal(first.body.error.details.retryAfterSeconds, scenario.retryAfterSeconds);
      assert.equal(sourceCalls, 1);
      assert.deepEqual(lifecycle(), before);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1')
        .get<{ count: number }>(imported.skillId)?.count, activeBefore);

      const cached = database.prepare(`
        SELECT outcome, fetched_at AS fetchedAt, expires_at AS expiresAt
          FROM skill_source_failure_cache
         WHERE source_locator = ? AND slug = ?
      `).get<{ outcome: string; fetchedAt: string; expiresAt: string }>(candidate.source, candidate.slug)!;
      assert.equal(cached.outcome, scenario.outcome);
      if (scenario.retryAfterSeconds !== null) {
        assert.equal(Date.parse(cached.expiresAt) - Date.parse(cached.fetchedAt), scenario.retryAfterSeconds * 1_000);
      }

      const second = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'], dependencies));
      assert.equal(second.exitCode, 6);
      assert.equal(second.body.error.details.failureCode, scenario.outcome);
      assert.equal(sourceCalls, 1);
      assert.deepEqual(lifecycle(), before);

      if (scenario.retryAfterSeconds !== null) {
        database.prepare(`
          UPDATE skill_source_failure_cache
             SET fetched_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-01T00:00:01.000Z'
           WHERE source_locator = ? AND slug = ?
        `).run(candidate.source, candidate.slug);
        const afterExpiry = await captureCli(() => runCli(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json'], dependencies));
        assert.equal(afterExpiry.exitCode, 6);
        assert.equal(sourceCalls, 2);
        assert.deepEqual(lifecycle(), before);
      }
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });
}

test('exact reviewed create-only import reuses source rate-limit backoff and creates no skill rows', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-import-source-backoff-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const originalFetch = globalThis.fetch;
  let sourceCalls = 0;
  const retryAfterSeconds = 17;
  globalThis.fetch = async () => {
    sourceCalls += 1;
    return new Response('', { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } });
  };
  const dependencies = { skills: { withDatabase: async <T>(operation: (value: typeof database) => T | Promise<T>): Promise<T> => operation(database) } };
  const command = ['node', 'kiokuko-ai', 'skills', 'import', 'sveltejs/ai-tools/svelte-code-writer', '--json'];
  try {
    const first = await captureCli(() => runCli(command, dependencies));
    assert.equal(first.exitCode, 6);
    assert.equal(first.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.deepEqual(first.body.error.details, { failureCode: 'source_rate_limited', retryAfterSeconds });
    assert.equal(sourceCalls, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);

    const cached = database.prepare(`
      SELECT outcome, fetched_at AS fetchedAt, expires_at AS expiresAt
        FROM skill_source_failure_cache
       WHERE source_locator = 'sveltejs/ai-tools' AND slug = 'svelte-code-writer'
    `).get<{ outcome: string; fetchedAt: string; expiresAt: string }>()!;
    assert.equal(cached.outcome, 'source_rate_limited');
    assert.equal(Date.parse(cached.expiresAt) - Date.parse(cached.fetchedAt), retryAfterSeconds * 1_000);

    const second = await captureCli(() => runCli(command, dependencies));
    assert.equal(second.exitCode, 6);
    assert.deepEqual(second.body.error.details, { failureCode: 'source_rate_limited' });
    assert.equal(sourceCalls, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);

    database.prepare(`
      UPDATE skill_source_failure_cache
         SET fetched_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-01T00:00:01.000Z'
       WHERE source_locator = 'sveltejs/ai-tools' AND slug = 'svelte-code-writer'
    `).run();
    const afterExpiry = await captureCli(() => runCli(command, dependencies));
    assert.equal(afterExpiry.exitCode, 6);
    assert.equal(sourceCalls, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('skills CLI propagates arbitrary and integrity refresh errors instead of aggregating them', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cli-fail-close-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture:owner/fail-close:fail-close-skill', provider: 'fixture', name: 'fail-close-skill', slug: 'fail-close-skill', source: 'owner/fail-close', sourceType: 'github', installUrl: 'https://github.com/owner/fail-close', installs: 0, duplicate: false, officialStatus: 'unknown', auditStatus: 'passed',
  };
  const snapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: BATCH_INITIAL_COMMIT,
    files: [{ path: 'skills/fail-close-skill/SKILL.md', content: '---\nname: fail-close-skill\ndescription: safe\n---\n# Fail close\n', primary: true }],
  });
  const authorization = await freshMaterializationAuthority(snapshot.candidate);
  const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
    skillName: snapshot.frontmatter.name,
    sourcePath: snapshot.files[0]!.path,
    markdown: snapshot.files[0]!.content,
    summary: snapshot.frontmatter.description,
    stripFrontmatter: true,
  }), fixtureRequirement(snapshot.candidate), undefined, authorization);
  const originalFetch = globalThis.fetch;
  const programmerError = new TypeError('programmer-bug-sentinel');
  globalThis.fetch = async () => { throw programmerError; };
  try {
    const cli = buildCli({ skills: { withDatabase: async (operation) => operation(database), provider: passedAuditProvider } });
    await assert.rejects(
      () => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json']),
      (error: unknown) => error === programmerError,
    );
    assert.equal(database.prepare('SELECT state FROM external_skills WHERE skill_id = ?').get<{ state: string }>(imported.skillId)?.state, 'imported');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 1);

    const forgedSourceFailure = new SkillSourceError('source_future_failure' as never);
    globalThis.fetch = async () => { throw forgedSourceFailure; };
    await assert.rejects(
      () => cli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json']),
      (error: unknown) => error === forgedSourceFailure,
    );
    assert.deepEqual({ ...database.prepare(`
      SELECT state, source_commit AS sourceCommit, snapshot_hash AS snapshotHash
        FROM external_skills
       WHERE skill_id = ?
    `).get<Record<string, unknown>>(imported.skillId) }, {
      state: 'imported',
      sourceCommit: BATCH_INITIAL_COMMIT,
      snapshotHash: snapshot.snapshotHash,
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 0);

    let databaseCall = 0;
    const integrityError = new KiokukoError('INTEGRITY_ERROR', 'integrity-sentinel');
    globalThis.fetch = async () => jsonResponse({ message: 'not found' }, 404);
    const integrityCli = buildCli({ skills: { provider: passedAuditProvider, withDatabase: async (operation) => {
      databaseCall += 1;
      if (databaseCall === 2) throw integrityError;
      return operation(database);
    } } });
    await assert.rejects(
      () => integrityCli.parseAsync(['node', 'kiokuko-ai', 'skills', 'refresh', imported.skillId, '--json']),
      (error: unknown) => error === integrityError,
    );
    assert.equal(database.prepare('SELECT state FROM external_skills WHERE skill_id = ?').get<{ state: string }>(imported.skillId)?.state, 'imported');
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
