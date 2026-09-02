import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { retrieveFederatedMemory } from '../../src/memory/federated-retrieval.js';
import { searchEntries } from '../../src/memory/retrieval.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { discoverSkills } from '../../src/skills/discovery-service.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { reviewedCatalogSkill } from '../../src/skills/official-catalog.js';
import { SkillProviderError } from '../../src/skills/providers/schema.js';
import { SkillSourceError } from '../../src/skills/source/github-fetcher.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import { importSkillSnapshot, listExternalSkills, markExternalSkillRefreshFailure, recordDiscoveredSkill, setExternalSkillState } from '../../src/skills/store.js';
import type { SkillCandidate, SkillMaterializationAuthorization, SkillRegistryProvider, SkillRequirement } from '../../src/skills/types.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const NEXT_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

const reactRequirement: SkillRequirement = {
  id: 'react',
  technology: 'react',
  aliases: ['react'],
  queries: ['react'],
  owners: ['facebook'],
  repositories: [],
  applicability: { frameworks: [{ name: 'React' }] },
  signals: { packages: ['react'] },
  reason: 'React fixture.',
};

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

const reactFingerprint = {
  repositoryId: 'repo-react',
  languages: ['JavaScript'],
  frameworks: [{ name: 'React', version: '19' }],
  databases: [],
  runtimes: ['Node.js'],
  tools: [],
  packages: [{ name: 'react', version: '19' }],
  manifestDigest: 'react',
};

function input(technology: 'svelte' | 'react', mode: 'official' | 'community') {
  return {
    project: { workspace: `workspace:${technology}`, repositoryRoot: `/fixture/${technology}`, repositoryId: `repo-${technology}` },
    fingerprint: technology === 'svelte' ? svelteFingerprint : reactFingerprint,
    task: `Build a ${technology} component`,
    profile: { taskType: 'build' as const, target: `${technology} component`, expected: 'tests pass', constraints: null },
    recommendedTags: [technology],
    capabilities: [],
    mode,
  };
}

function candidate(source: string, slug: string, officialStatus: SkillCandidate['officialStatus'] = 'registry-only'): SkillCandidate {
  return {
    id: `fixture:${source}:${slug}`,
    provider: 'fixture',
    name: slug,
    slug,
    source,
    sourceType: 'github',
    installUrl: `https://github.com/${source}`,
    installs: 1,
    duplicate: false,
    officialStatus,
    auditStatus: 'passed',
  };
}

function providerCandidate(value: SkillCandidate): SkillCandidate {
  const result = {
    ...value,
    officialStatus: reviewedCatalogSkill(value) === undefined ? 'registry-only' as const : 'catalog-verified' as const,
  };
  delete result.auditStatus;
  return result;
}

const reviewedSvelteCandidate = providerCandidate(candidate('sveltejs/ai-tools', 'svelte-code-writer'));

function snapshot(skill: SkillCandidate) {
  return validateSkillSnapshot({
    candidate: skill,
    sourceCommit: COMMIT,
    files: [{
      path: `skills/${skill.slug}/SKILL.md`,
      content: `---\nname: ${skill.name}\ndescription: Safe fixture\n---\n# ${skill.name}\n\nReference only.`,
      primary: true,
    }],
  });
}

function snapshotAtPath(skill: SkillCandidate, slug: string, sourceCommit = COMMIT) {
  return validateSkillSnapshot({
    candidate: skill,
    sourceCommit,
    files: [{
      path: `skills/${slug}/SKILL.md`,
      content: `---\nname: ${slug}\ndescription: Safe fixture\n---\n# ${slug}\n\nReference only.`,
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

async function databaseFixture(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  return database;
}

function staleSkill(database: SqliteDatabase, skillId: string, now: string): void {
  const current = listExternalSkills(database).find((skill) => skill.skillId === skillId);
  assert.ok(current);
  markExternalSkillRefreshFailure(database, skillId, 'stale', {
    generation: current.generation,
    sourceCommit: current.sourceCommit,
    snapshotHash: current.snapshotHash,
    state: current.state,
    lastCheckedAt: current.lastCheckedAt,
  }, now);
}

test('does not fabricate a catalog source before general community search', async () => {
  const database = await databaseFixture('kiokuko-discovery-order-');
  const events: string[] = [];
  const community = candidate('community/svelte-helper', 'svelte-helper', 'unknown');
  try {
    const result = await discoverSkills(database, input('svelte', 'community'), {
      provider: {
        id: 'fixture',
        async search(searchInput) {
          const owner = searchInput.owner ?? null;
          events.push(`search:${owner ?? 'community'}`);
          return { provider: 'fixture', experimental: false, candidates: owner === null ? [providerCandidate(community)] : [] };
        },
        async audit() { return { status: 'passed' }; },
      },
      sourceFetcher: {
        async fetch(skill) {
          events.push(`fetch:${skill.source}:${skill.slug}`);
          return snapshot(skill);
        },
      },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    const communitySearch = events.indexOf('search:community');
    assert.ok(communitySearch >= 0, JSON.stringify(events));
    assert.deepEqual(events.filter((event) => event.startsWith('fetch:sveltejs/ai-tools:')), []);
    assert.deepEqual(events.filter((event) => event.startsWith('fetch:')), ['fetch:community/svelte-helper:svelte-helper']);
    assert.equal(result.selected[0]?.source, 'community/svelte-helper');
  } finally {
    database.close();
  }
});

test('does not treat an unrelated skill from an official owner as relevant', async () => {
  const database = await databaseFixture('kiokuko-discovery-relevance-');
  const unrelated = candidate('facebook/jest-skills', 'jest-helper');
  let sourceCalls = 0;
  try {
    const result = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(unrelated)] }; } },
      sourceFetcher: { async fetch() { sourceCalls += 1; throw new Error('must not fetch an irrelevant owner result'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.equal(result.candidates, 1);
    assert.equal(result.selected.length, 0);
    assert.equal(sourceCalls, 0);
  } finally {
    database.close();
  }
});

test('does not treat owner or curated labels as materialization authorization', async () => {
  for (const status of ['owner-verified', 'curated'] as const) {
    const database = await databaseFixture(`kiokuko-discovery-label-trust-${status}-`);
    const providerId = `fixture-${status}`;
    const labeled = {
      ...candidate(
        status === 'owner-verified' ? 'facebook/react-skills' : 'community/react-skills',
        'react-helper',
        status === 'owner-verified' ? 'registry-only' : 'curated',
      ),
      id: `${providerId}:${status === 'owner-verified' ? 'facebook/react-skills' : 'community/react-skills'}:react-helper`,
      provider: providerId,
    };
    delete labeled.auditStatus;
    let sourceCalls = 0;
    try {
      const result = await discoverSkills(database, input('react', 'official'), {
        provider: {
          id: providerId,
          async search() { return { provider: providerId, experimental: false, candidates: status === 'owner-verified' ? [labeled] : [] }; },
          ...(status === 'curated' ? { async curated() { return [labeled]; } } : {}),
        },
        sourceFetcher: { async fetch() { sourceCalls += 1; return snapshot(labeled); } },
      });
      assert.equal(result.selected.length, 0);
      assert.equal(sourceCalls, 0);
      assert.ok(result.failures.some((failure) => failure.code === 'community_audit_unavailable'));
      assert.equal(listExternalSkills(database).length, 0);
    } finally { database.close(); }
  }
});

test('rejects registry display-name poisoning after validating the fetched skill identity', async () => {
  const database = await databaseFixture('kiokuko-discovery-name-poisoning-');
  const poisoned = { ...candidate('community/svelte-poison', 'helper'), name: 'svelte' };
  let auditCalls = 0;
  let poisonedSourceCalls = 0;
  try {
    const result = await discoverSkills(database, input('svelte', 'community'), {
      provider: {
        id: 'fixture',
        async search(searchInput) {
          return {
            provider: 'fixture',
            experimental: false,
            candidates: searchInput.owner === undefined ? [providerCandidate(poisoned)] : [],
          };
        },
        async audit() { auditCalls += 1; return { status: 'passed' }; },
      },
      sourceFetcher: {
        async fetch(skill) {
          if (skill.source === 'sveltejs/ai-tools') throw new SkillSourceError('source_missing');
          poisonedSourceCalls += 1;
          assert.equal(skill.name, 'svelte');
          assert.equal(skill.slug, 'helper');
          return validateSkillSnapshot({
            candidate: skill,
            sourceCommit: COMMIT,
            files: [{
              path: 'skills/helper/SKILL.md',
              content: '---\nname: Unrelated Helper\ndescription: Safe fixture\n---\n# Unrelated Helper\n\nReference only.',
              primary: true,
            }],
          });
        },
      },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.equal(auditCalls, 1);
    assert.equal(poisonedSourceCalls, 1);
    assert.equal(result.selected.length, 0);
    assert.ok(result.failures.some((failure) => failure.stage === 'validation' && failure.code === 'skill_validation_failed'));
    assert.equal(listExternalSkills(database).some((skill) => skill.sourceLocator === poisoned.source), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects unknown search, curated, audit, and source failures', async (t) => {
  await t.test('search', async () => {
    const database = await databaseFixture('kiokuko-discovery-search-typeerror-');
    try {
      await assert.rejects(discoverSkills(database, input('react', 'official'), {
        provider: { id: 'fixture', async search() { throw new TypeError('provider programmer error'); } },
      }), /provider programmer error/u);
    } finally { database.close(); }
  });

  await t.test('curated', async () => {
    const database = await databaseFixture('kiokuko-discovery-curated-typeerror-');
    try {
      await assert.rejects(discoverSkills(database, input('react', 'official'), {
        provider: {
          id: 'fixture',
          async search() { return { provider: 'fixture', experimental: false, candidates: [] }; },
          async curated() { throw new TypeError('curated programmer error'); },
        },
      }), /curated programmer error/u);
    } finally { database.close(); }
  });

  await t.test('audit', async () => {
    const database = await databaseFixture('kiokuko-discovery-audit-typeerror-');
    const community = candidate('community/react-helper', 'react-helper', 'unknown');
    try {
      await assert.rejects(discoverSkills(database, input('react', 'community'), {
        provider: {
          id: 'fixture',
          async search(searchInput) { return { provider: 'fixture', experimental: false, candidates: searchInput.owner === undefined ? [providerCandidate(community)] : [] }; },
          async audit() { throw new TypeError('audit programmer error'); },
        },
      }), /audit programmer error/u);
    } finally { database.close(); }
  });

  await t.test('source', async () => {
    const database = await databaseFixture('kiokuko-discovery-source-typeerror-');
    try {
      await assert.rejects(discoverSkills(database, input('svelte', 'official'), {
        provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
        sourceFetcher: { async fetch() { throw new TypeError('source programmer error'); } },
      }), /source programmer error/u);
    } finally { database.close(); }
  });

  await t.test('source validation message spoof', async () => {
    const database = await databaseFixture('kiokuko-discovery-source-message-spoof-');
    try {
      await assert.rejects(discoverSkills(database, input('svelte', 'official'), {
        provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
        sourceFetcher: { async fetch() { throw new Error('skill_validation_failed'); } },
      }), (error: unknown) => error instanceof Error && !(error instanceof SkillSourceError) && error.message === 'skill_validation_failed');
    } finally { database.close(); }
  });

  await t.test('forged provider failure code', async () => {
    const database = await databaseFixture('kiokuko-discovery-forged-provider-code-');
    const forged = new SkillProviderError('registry_future_failure' as never);
    try {
      await assert.rejects(discoverSkills(database, input('react', 'official'), {
        provider: { id: 'fixture-forged-provider', async search() { throw forged; } },
        now: () => '2026-08-25T00:00:00.000Z',
      }), (error: unknown) => error === forged);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    } finally { database.close(); }
  });

  await t.test('forged audit failure code', async () => {
    const database = await databaseFixture('kiokuko-discovery-forged-audit-code-');
    const community = candidate('community/react-helper', 'react-helper', 'unknown');
    const providerId = 'fixture-forged-audit';
    const forged = new SkillProviderError('registry_future_failure' as never);
    let sourceCalls = 0;
    try {
      await assert.rejects(discoverSkills(database, input('react', 'community'), {
        provider: {
          id: providerId,
          async search(searchInput) {
            return {
              provider: providerId,
              experimental: false,
              candidates: searchInput.owner === undefined
                ? [{ ...providerCandidate(community), provider: providerId, id: `${providerId}:${community.source}:${community.slug}` }]
                : [],
            };
          },
          async audit() { throw forged; },
        },
        sourceFetcher: { async fetch() { sourceCalls += 1; return snapshot(community); } },
        now: () => '2026-08-25T00:00:00.000Z',
      }), (error: unknown) => error === forged);
      assert.equal(sourceCalls, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    } finally { database.close(); }
  });

  await t.test('forged source failure code', async () => {
    const database = await databaseFixture('kiokuko-discovery-forged-source-code-');
    const forged = new SkillSourceError('source_future_failure' as never);
    try {
      await assert.rejects(discoverSkills(database, input('svelte', 'official'), {
        provider: { id: 'fixture-forged-source', async search() { return { provider: 'fixture-forged-source', experimental: false, candidates: [{ ...reviewedSvelteCandidate, provider: 'fixture-forged-source', id: `fixture-forged-source:${reviewedSvelteCandidate.source}:${reviewedSvelteCandidate.slug}` }] }; } },
        sourceFetcher: { async fetch() { throw forged; } },
        now: () => '2026-08-25T00:00:00.000Z',
      }), (error: unknown) => error === forged);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    } finally { database.close(); }
  });

});

test('records a malformed registry response as an optional discovery failure without caching or fabricating a source path', async () => {
  const database = await databaseFixture('kiokuko-discovery-invalid-provider-response-');
  let searchCalls = 0;
  const fetched: string[] = [];
  try {
    const result = await discoverSkills(database, input('svelte', 'official'), {
      provider: { id: 'fixture-invalid', async search() { searchCalls += 1; throw new SkillProviderError('registry_invalid_response'); } },
      sourceFetcher: { async fetch(skill) { fetched.push(skill.slug); throw new SkillSourceError('candidate_not_found_at_source'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.equal(searchCalls, 1);
    assert.deepEqual(result.failures, [{ stage: 'search', code: 'registry_invalid_response' }]);
    assert.equal(result.candidates, 0);
    assert.deepEqual(result.selected, []);
    assert.deepEqual(fetched, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('records malformed curated and audit operations without caching or importing their candidates', async (t) => {
  await t.test('curated', async () => {
    const database = await databaseFixture('kiokuko-discovery-invalid-curated-response-');
    try {
      const result = await discoverSkills(database, input('react', 'official'), {
        provider: {
          id: 'fixture-invalid-curated',
          async search() { return { provider: 'fixture-invalid-curated', experimental: false, candidates: [] }; },
          async curated() { throw new SkillProviderError('registry_invalid_response'); },
        },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.deepEqual(result.failures, [{ stage: 'search', code: 'registry_invalid_response' }]);
      assert.deepEqual(result.selected, []);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM skill_discovery_cache WHERE query_text = '__curated__'").get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    } finally { database.close(); }
  });

  await t.test('audit', async () => {
    const database = await databaseFixture('kiokuko-discovery-invalid-audit-response-');
    const community = candidate('community/react-helper', 'react-helper', 'unknown');
    let sourceCalls = 0;
    try {
      const result = await discoverSkills(database, input('react', 'community'), {
        provider: {
          id: 'fixture-invalid-audit',
          async search(searchInput) { return { provider: 'fixture-invalid-audit', experimental: false, candidates: searchInput.owner === undefined ? [{ ...providerCandidate(community), provider: 'fixture-invalid-audit', id: `fixture-invalid-audit:${community.source}:${community.slug}` }] : [] }; },
          async audit() { throw new SkillProviderError('registry_invalid_response'); },
        },
        sourceFetcher: { async fetch() { sourceCalls += 1; return snapshot(community); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.deepEqual(result.failures, [{ stage: 'search', code: 'registry_invalid_response' }]);
      assert.deepEqual(result.selected, []);
      assert.equal(sourceCalls, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    } finally { database.close(); }
  });
});

test('rolls back and propagates an unexpected native SQLite constraint failure', async () => {
  const database = await databaseFixture('kiokuko-discovery-db-error-');
  database.exec(`
    CREATE TRIGGER fail_discovery_persistence
    BEFORE INSERT ON external_skill_entries
    BEGIN
      SELECT RAISE(ABORT, 'forced discovery persistence failure');
    END
  `);
  try {
    await assert.rejects(discoverSkills(database, input('svelte', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
      sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
    }), (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'ERR_SQLITE_ERROR'
      && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 0xff) === 19);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally { database.close(); }
});

test('rolls back a native SQLite busy failure and returns the bounded persistence code', async () => {
  const database = await databaseFixture('kiokuko-discovery-db-busy-');
  const busy = Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
    errstr: 'database is locked',
  });
  const busyDatabase: SqliteDatabase = {
    filePath: database.filePath,
    exec(sql) { database.exec(sql); },
    prepare(sql) {
      if (sql.includes('INSERT INTO external_skills')) throw busy;
      return database.prepare(sql);
    },
    close() { database.close(); },
  };
  try {
    const result = await discoverSkills(busyDatabase, input('svelte', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
      sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
    });
    assert.ok(result.failures.some((failure) => failure.stage === 'persistence' && failure.code === 'persistence_failed'));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally { database.close(); }
});

test('propagates validation and missing-state failures from atomic persistence', async () => {
  for (const code of ['VALIDATION_ERROR', 'NOT_FOUND'] as const) {
    const database = await databaseFixture(`kiokuko-discovery-persistence-${code.toLocaleLowerCase()}-`);
    const failure = new KiokukoError(code, 'forced persistence invariant failure');
    const failingDatabase: SqliteDatabase = {
      filePath: database.filePath,
      exec(sql) { database.exec(sql); },
      prepare(sql) {
        if (sql.includes('INSERT INTO external_skills')) throw failure;
        return database.prepare(sql);
      },
      close() { database.close(); },
    };
    try {
      await assert.rejects(discoverSkills(failingDatabase, input('svelte', 'official'), {
        provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
        sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
      }), (error: unknown) => error === failure);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    } finally { database.close(); }
  }
});

test('propagates a caller persistence assertion unchanged before import writes', async () => {
  const database = await databaseFixture('kiokuko-discovery-caller-assertion-');
  const failure = new KiokukoError('CONFLICT', 'Caller-owned discovery state changed');
  let assertionCalls = 0;
  try {
    await assert.rejects(discoverSkills(database, input('svelte', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
      sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
      assertBeforePersist: () => {
        assertionCalls += 1;
        throw failure;
      },
    }), (error: unknown) => error === failure);

    assert.equal(assertionCalls, 1);
    for (const table of ['external_skills', 'external_skill_entries', 'entries', 'entry_revisions']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()?.count, 0);
    }
  } finally { database.close(); }
});

test('allows only one authentication fallback attempt for self and cyclic providers', async () => {
  const scenarios = ['self', 'cycle'] as const;
  for (const scenario of scenarios) {
    const database = await databaseFixture(`kiokuko-discovery-${scenario}-fallback-`);
    const calls: string[] = [];
    const primary: SkillRegistryProvider = {
      id: `${scenario}-primary`,
      async search() {
        calls.push('primary');
        throw new SkillProviderError('registry_authentication_failed');
      },
    };
    const secondary: SkillRegistryProvider = scenario === 'self' ? primary : {
      id: 'cycle-secondary',
      async search() {
        calls.push('secondary');
        throw new SkillProviderError('registry_authentication_failed');
      },
    };
    Object.defineProperty(primary, 'authenticationFallback', { value: secondary, enumerable: true });
    if (scenario === 'cycle') Object.defineProperty(secondary, 'authenticationFallback', { value: primary, enumerable: true });
    try {
      const first = await discoverSkills(database, input('svelte', 'official'), { provider: primary });
      assert.ok(first.failures.some((failure) => failure.code === 'registry_authentication_failed'));
      assert.deepEqual(calls, scenario === 'self' ? ['primary'] : ['primary', 'secondary']);
      const callsAfterLiveAttempt = [...calls];
      const second = await discoverSkills(database, input('svelte', 'official'), { provider: primary });
      assert.ok(second.failures.some((failure) => failure.code === 'registry_authentication_failed'));
      assert.deepEqual(calls, callsAfterLiveAttempt, 'cached auth failures must remain one-shot');
    } finally { database.close(); }
  }
});

test('propagates a string-code SQLite lookalike instead of degrading it', async () => {
  const database = await databaseFixture('kiokuko-discovery-db-busy-spoof-');
  const spoof = Object.assign(new Error('programmer failure'), { code: 'SQLITE_BUSY' });
  const spoofingDatabase: SqliteDatabase = {
    filePath: database.filePath,
    exec(sql) { database.exec(sql); },
    prepare(sql) {
      if (sql.includes('INSERT INTO external_skills')) throw spoof;
      return database.prepare(sql);
    },
    close() { database.close(); },
  };
  try {
    await assert.rejects(discoverSkills(spoofingDatabase, input('svelte', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
      sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
    }), (error: unknown) => error === spoof);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
  } finally { database.close(); }
});

test('propagates SQLite corruption instead of relabeling it as a recoverable persistence failure', async () => {
  const database = await databaseFixture('kiokuko-discovery-db-corrupt-');
  const corruption = Object.assign(new Error('database disk image is malformed'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 11,
    errstr: 'database disk image is malformed',
  });
  const corruptingDatabase: SqliteDatabase = {
    filePath: database.filePath,
    exec(sql) { database.exec(sql); },
    prepare(sql) {
      if (sql.includes('INSERT INTO external_skills')) throw corruption;
      return database.prepare(sql);
    },
    close() { database.close(); },
  };
  try {
    await assert.rejects(discoverSkills(corruptingDatabase, input('svelte', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
      sourceFetcher: { async fetch(skill) { return snapshot(skill); } },
    }), (error: unknown) => error === corruption);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally { database.close(); }
});

test('degrades only typed provider/source failures and keeps attempts bounded', async (t) => {
  await t.test('provider availability', async () => {
    const database = await databaseFixture('kiokuko-discovery-provider-typed-');
    let calls = 0;
    try {
      const result = await discoverSkills(database, input('react', 'official'), {
        provider: { id: 'fixture', async search() { calls += 1; throw new SkillProviderError('registry_unavailable'); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.ok(calls > 0 && calls <= 3);
      assert.equal(result.selected.length, 0);
      assert.ok(result.failures.every((failure) => failure.code === 'registry_unavailable'));
      const firstCalls = calls;
      const cached = await discoverSkills(database, input('react', 'official'), {
        provider: { id: 'fixture', async search() { calls += 1; throw new Error('negative cache must suppress this request'); } },
        now: () => '2026-08-25T00:01:00.000Z',
      });
      assert.equal(calls, firstCalls);
      assert.ok(cached.cacheHits > 0);
      assert.ok(cached.failures.length > 0 && cached.failures.every((failure) => failure.code === 'registry_unavailable'));
    } finally { database.close(); }
  });

  await t.test('cached provider rate limit remains an explicit rate-limit failure', async () => {
    const database = await databaseFixture('kiokuko-discovery-provider-rate-cache-');
    let calls = 0;
    try {
      const first = await discoverSkills(database, input('react', 'official'), {
        provider: { id: 'fixture-rate', async search() { calls += 1; throw new SkillProviderError('registry_rate_limited', 600); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      const firstCalls = calls;
      assert.equal(firstCalls, 1, 'the first rate limit must latch every remaining provider scope for this run');
      const cached = await discoverSkills(database, input('react', 'official'), {
        provider: { id: 'fixture-rate', async search() { calls += 1; throw new Error('negative cache must suppress this request'); } },
        now: () => '2026-08-25T00:01:00.000Z',
      });
      assert.ok(first.failures.every((failure) => failure.code === 'registry_rate_limited'));
      assert.equal(calls, firstCalls);
      assert.ok(cached.cacheHits > 0);
      assert.ok(cached.failures.length > 0 && cached.failures.every((failure) => failure.code === 'registry_rate_limited'));
    } finally { database.close(); }
  });

  await t.test('a later provider failure suppresses audit calls for candidates collected earlier in the run', async () => {
    const database = await databaseFixture('kiokuko-discovery-provider-audit-latch-');
    const earlier = {
      ...providerCandidate(candidate('facebook/react-skills', 'react-helper', 'registry-only')),
      provider: 'fixture-provider-audit-latch',
      id: 'fixture-provider-audit-latch:facebook/react-skills:react-helper',
    };
    let searchCalls = 0;
    let auditCalls = 0;
    let sourceCalls = 0;
    try {
      const result = await discoverSkills(database, input('react', 'official'), {
        provider: {
          id: 'fixture-provider-audit-latch',
          async search() {
            searchCalls += 1;
            if (searchCalls === 1) return { provider: 'fixture-provider-audit-latch', experimental: false, candidates: [earlier] };
            throw new SkillProviderError('registry_rate_limited', 30);
          },
          async audit() { auditCalls += 1; return { status: 'passed' }; },
        },
        sourceFetcher: { async fetch() { sourceCalls += 1; throw new Error('provider latch must suppress source preparation'); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.equal(searchCalls, 2);
      assert.equal(auditCalls, 0);
      assert.equal(sourceCalls, 0);
      assert.equal(result.selected.length, 0);
      assert.ok(result.failures.some((failure) => failure.code === 'registry_rate_limited'));
      assert.ok(result.failures.some((failure) => failure.code === 'community_audit_unavailable'));
    } finally { database.close(); }
  });

  await t.test('uses a positive Retry-After as the negative-cache TTL', async () => {
    const database = await databaseFixture('kiokuko-discovery-provider-retry-after-');
    try {
      const result = await discoverSkills(database, input('react', 'official'), {
        provider: { id: 'fixture-retry-after', async search() { throw new SkillProviderError('registry_rate_limited', 30); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.ok(result.failures.length > 0 && result.failures.every((failure) => failure.code === 'registry_rate_limited'));
      const cached = database.prepare("SELECT fetched_at, expires_at FROM skill_discovery_cache WHERE provider = ? AND outcome = 'rate_limited'")
        .all<{ fetched_at: string; expires_at: string }>('fixture-retry-after');
      assert.ok(cached.length > 0);
      assert.ok(cached.every((row) => row.fetched_at === '2026-08-25T00:00:00.000Z' && row.expires_at === '2026-08-25T00:00:30.000Z'));
    } finally { database.close(); }
  });

  await t.test('curated rate limits preserve their exact outcome and Retry-After', async () => {
    const database = await databaseFixture('kiokuko-discovery-curated-rate-cache-');
    let curatedCalls = 0;
    try {
      const dependencies = {
        provider: {
          id: 'fixture-curated-rate',
          async search() { return { provider: 'fixture-curated-rate', experimental: false, candidates: [] }; },
          async curated(): Promise<SkillCandidate[]> { curatedCalls += 1; throw new SkillProviderError('registry_rate_limited', 30); },
        },
      };
      const first = await discoverSkills(database, input('react', 'official'), { ...dependencies, now: () => '2026-08-25T00:00:00.000Z' });
      assert.ok(first.failures.some((failure) => failure.code === 'registry_rate_limited'));
      assert.equal(curatedCalls, 1);
      const cachedRow = database.prepare("SELECT outcome, fetched_at, expires_at FROM skill_discovery_cache WHERE query_text = '__curated__'")
        .get<{ outcome: string; fetched_at: string; expires_at: string }>();
      assert.equal(cachedRow?.outcome, 'rate_limited');
      assert.equal(cachedRow?.fetched_at, '2026-08-25T00:00:00.000Z');
      assert.equal(cachedRow?.expires_at, '2026-08-25T00:00:30.000Z');
      const cached = await discoverSkills(database, input('react', 'official'), { ...dependencies, now: () => '2026-08-25T00:00:20.000Z' });
      assert.equal(curatedCalls, 1);
      assert.ok(cached.failures.some((failure) => failure.code === 'registry_rate_limited'));
    } finally { database.close(); }
  });

  await t.test('curated authentication failures retain their machine-readable identity', async () => {
    const database = await databaseFixture('kiokuko-discovery-curated-auth-cache-');
    let curatedCalls = 0;
    try {
      const dependencies = {
        provider: {
          id: 'fixture-curated-auth',
          async search() { return { provider: 'fixture-curated-auth', experimental: false, candidates: [] }; },
          async curated(): Promise<SkillCandidate[]> { curatedCalls += 1; throw new SkillProviderError('registry_authentication_failed'); },
        },
      };
      const first = await discoverSkills(database, input('react', 'official'), { ...dependencies, now: () => '2026-08-25T00:00:00.000Z' });
      assert.ok(first.failures.some((failure) => failure.code === 'registry_authentication_failed'));
      const cached = await discoverSkills(database, input('react', 'official'), { ...dependencies, now: () => '2026-08-25T00:01:00.000Z' });
      assert.equal(curatedCalls, 1);
      assert.ok(cached.failures.some((failure) => failure.code === 'registry_authentication_failed'));
    } finally { database.close(); }
  });

  await t.test('source availability', async () => {
    const database = await databaseFixture('kiokuko-discovery-source-typed-');
    let calls = 0;
    try {
      const result = await discoverSkills(database, input('svelte', 'official'), {
        provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
        sourceFetcher: { async fetch() { calls += 1; throw new SkillSourceError('source_unavailable'); } },
      });
      assert.equal(calls, 1);
      assert.equal(result.selected.length, 0);
      assert.ok(result.failures.some((failure) => failure.code === 'source_unavailable' && failure.stage === 'source'));
    } finally { database.close(); }
  });

  await t.test('a source rate limit latches later candidates in the same run', async () => {
    const database = await databaseFixture('kiokuko-discovery-source-rate-latch-');
    const candidates = [
      { ...providerCandidate(candidate('community/react-one', 'react-helper-one', 'unknown')), provider: 'fixture-source-rate-latch', id: 'fixture-source-rate-latch:community/react-one:react-helper-one' },
      { ...providerCandidate(candidate('community/react-two', 'react-helper-two', 'unknown')), provider: 'fixture-source-rate-latch', id: 'fixture-source-rate-latch:community/react-two:react-helper-two' },
    ];
    let sourceCalls = 0;
    try {
      const result = await discoverSkills(database, input('react', 'community'), {
        provider: {
          id: 'fixture-source-rate-latch',
          async search() { return { provider: 'fixture-source-rate-latch', experimental: true, candidates }; },
          async audit() { return { status: 'passed' }; },
        },
        sourceFetcher: { async fetch() { sourceCalls += 1; throw new SkillSourceError('source_rate_limited', 30); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.equal(sourceCalls, 1);
      assert.ok(result.failures.some((failure) => failure.code === 'source_rate_limited'));
      assert.equal(result.selected.length, 0);
    } finally { database.close(); }
  });

  await t.test('an unavailable community audit latches later candidates in the same run', async () => {
    const database = await databaseFixture('kiokuko-discovery-audit-latch-');
    const candidates = [
      { ...providerCandidate(candidate('community/react-one', 'react-helper-one', 'unknown')), provider: 'fixture-audit-latch', id: 'fixture-audit-latch:community/react-one:react-helper-one' },
      { ...providerCandidate(candidate('community/react-two', 'react-helper-two', 'unknown')), provider: 'fixture-audit-latch', id: 'fixture-audit-latch:community/react-two:react-helper-two' },
    ];
    let auditCalls = 0;
    let sourceCalls = 0;
    let unscopedSearchCalls = 0;
    try {
      const result = await discoverSkills(database, input('react', 'community'), {
        provider: {
          id: 'fixture-audit-latch',
          async search(searchInput) {
            if (searchInput.owner === undefined) unscopedSearchCalls += 1;
            return { provider: 'fixture-audit-latch', experimental: true, candidates };
          },
          async audit() { auditCalls += 1; return null; },
        },
        sourceFetcher: { async fetch() { sourceCalls += 1; throw new Error('latched audit must suppress every source request'); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.equal(auditCalls, 1);
      assert.equal(sourceCalls, 0);
      assert.equal(unscopedSearchCalls, 0);
      assert.equal(result.failures.filter((failure) => failure.code === 'community_audit_unavailable').length, 1);
      assert.equal(result.selected.length, 0);
    } finally { database.close(); }
  });

  await t.test('source rate limits use an exact persistent identity and Retry-After', async () => {
    const database = await databaseFixture('kiokuko-discovery-source-rate-cache-');
    let calls = 0;
    try {
      const provider = { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } };
      const first = await discoverSkills(database, input('svelte', 'official'), {
        provider,
        sourceFetcher: { async fetch() { calls += 1; throw new SkillSourceError('source_rate_limited', 30); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.equal(calls, 1);
      assert.ok(first.failures.some((failure) => failure.code === 'source_rate_limited' && failure.stage === 'source'));
      const cachedRow = database.prepare('SELECT outcome, fetched_at, expires_at FROM skill_source_failure_cache')
        .get<{ outcome: string; fetched_at: string; expires_at: string }>();
      assert.equal(cachedRow?.outcome, 'source_rate_limited');
      assert.equal(cachedRow?.fetched_at, '2026-08-25T00:00:00.000Z');
      assert.equal(cachedRow?.expires_at, '2026-08-25T00:00:30.000Z');
      const cached = await discoverSkills(database, input('svelte', 'official'), {
        provider,
        sourceFetcher: { async fetch() { calls += 1; throw new Error('source cache must suppress this fetch'); } },
        now: () => '2026-08-25T00:00:20.000Z',
      });
      assert.equal(calls, 1);
      assert.ok(cached.failures.some((failure) => failure.code === 'source_rate_limited' && failure.stage === 'source'));
      const recovered = await discoverSkills(database, input('svelte', 'official'), {
        provider,
        sourceFetcher: { async fetch(skill) { calls += 1; return snapshot(skill); } },
        now: () => '2026-08-25T00:00:31.000Z',
      });
      assert.equal(calls, 2);
      assert.equal(recovered.selected.length, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 0);
    } finally { database.close(); }
  });

  await t.test('corrupt source backoff fails closed without deleting evidence or retrying', async () => {
    const database = await databaseFixture('kiokuko-discovery-source-cache-corrupt-');
    let calls = 0;
    try {
      const provider = { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } };
      await discoverSkills(database, input('svelte', 'official'), {
        provider,
        sourceFetcher: { async fetch() { calls += 1; throw new SkillSourceError('source_unavailable'); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      database.prepare("UPDATE skill_source_failure_cache SET expires_at = 'not-a-time'").run();
      await assert.rejects(discoverSkills(database, input('svelte', 'official'), {
        provider,
        sourceFetcher: { async fetch() { calls += 1; throw new Error('corrupt cache must not trigger a fetch'); } },
        now: () => '2026-08-25T00:01:00.000Z',
      }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
      assert.equal(calls, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 1);
    } finally { database.close(); }
  });

  await t.test('source rate limit preserves an older active import', async () => {
    const database = await databaseFixture('kiokuko-discovery-source-rate-limit-');
    const react = candidate('facebook/react-skills', 'react', 'owner-verified');
    const initial = snapshotAtPath(react, 'react');
    const authorization = await passedAuditAuthorization(initial.candidate);
    const imported = importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-01T00:00:00.000Z', authorization);
    try {
      const result = await discoverSkills(database, input('react', 'official'), {
        provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(react)] }; }, async audit() { return { status: 'passed' }; } },
        sourceFetcher: { async fetch() { throw new SkillSourceError('source_rate_limited'); } },
        now: () => '2026-08-25T00:00:00.000Z',
      });
      assert.ok(result.failures.some((failure) => failure.code === 'source_rate_limited' && failure.stage === 'source'));
      const row = listExternalSkills(database).find((item) => item.skillId === imported.skillId);
      assert.equal(row?.state, 'imported');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 1);
    } finally { database.close(); }
  });

  await t.test('audit unavailability is latched across runs for the bounded cache TTL', async () => {
    const database = await databaseFixture('kiokuko-discovery-audit-typed-');
    const community = candidate('community/react-helper', 'react-helper', 'unknown');
    let auditCalls = 0;
    try {
      const provider = {
        id: 'fixture',
        async search(searchInput: { owner?: string }) { return { provider: 'fixture', experimental: false, candidates: searchInput.owner === undefined ? [providerCandidate(community)] : [] }; },
        async audit() { auditCalls += 1; throw new SkillProviderError('registry_unavailable'); },
      };
      const result = await discoverSkills(database, input('react', 'community'), {
        provider,
        now: () => '2026-08-25T00:00:00.000Z',
      });
      const cached = await discoverSkills(database, input('react', 'community'), {
        provider,
        now: () => '2026-08-25T00:01:00.000Z',
      });
      assert.equal(auditCalls, 1);
      assert.equal(result.selected.length, 0);
      assert.equal(cached.selected.length, 0);
      assert.ok(result.failures.some((failure) => failure.code === 'community_audit_unavailable'));
      assert.ok(cached.failures.some((failure) => failure.code === 'community_audit_unavailable'));
      const failure = database.prepare('SELECT outcome, fetched_at, expires_at FROM skill_audit_failure_cache').get<{ outcome: string; fetched_at: string; expires_at: string }>();
      assert.equal(failure?.outcome, 'registry_unavailable');
      assert.equal(failure?.fetched_at, '2026-08-25T00:00:00.000Z');
      assert.equal(failure?.expires_at, '2026-08-25T00:10:00.000Z');
    } finally { database.close(); }
  });

  await t.test('audit Retry-After suppresses the next run and clears after a later passed audit', async () => {
    const database = await databaseFixture('kiokuko-discovery-audit-retry-after-');
    const community = candidate('community/react-helper', 'react-helper', 'unknown');
    let auditCalls = 0;
    let sourceCalls = 0;
    let rateLimited = true;
    const provider: SkillRegistryProvider = {
      id: 'fixture-audit-retry-after',
      async search(searchInput: { owner?: string }) { return { provider: 'fixture-audit-retry-after', experimental: false, candidates: searchInput.owner === undefined ? [{ ...providerCandidate(community), provider: 'fixture-audit-retry-after', id: 'fixture-audit-retry-after:community/react-helper:react-helper' }] : [] }; },
      async audit() {
        auditCalls += 1;
        if (rateLimited) throw new SkillProviderError('registry_rate_limited', 30);
        return { status: 'passed' as const };
      },
    };
    try {
      const dependencies = {
        provider,
        sourceFetcher: { async fetch(skill: SkillCandidate) { sourceCalls += 1; return snapshotAtPath(skill, 'react-helper'); } },
      };
      const first = await discoverSkills(database, input('react', 'community'), { ...dependencies, now: () => '2026-08-25T00:00:00.000Z' });
      rateLimited = false;
      const cached = await discoverSkills(database, input('react', 'community'), { ...dependencies, now: () => '2026-08-25T00:00:20.000Z' });
      assert.equal(auditCalls, 1);
      assert.equal(sourceCalls, 0);
      assert.equal(first.selected.length, 0);
      assert.equal(cached.selected.length, 0);
      assert.equal(database.prepare('SELECT expires_at FROM skill_audit_failure_cache').get<{ expires_at: string }>()?.expires_at, '2026-08-25T00:00:30.000Z');
      const recovered = await discoverSkills(database, input('react', 'community'), { ...dependencies, now: () => '2026-08-25T00:00:31.000Z' });
      assert.equal(auditCalls, 2);
      assert.equal(sourceCalls, 1);
      assert.equal(recovered.selected.length, 1, JSON.stringify(recovered));
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 0);
    } finally { database.close(); }
  });
});

test('stales an aged imported snapshot when its exact source is deleted and removes it from every retrieval path', async () => {
  const database = await databaseFixture('kiokuko-discovery-source-deleted-');
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-discovery-source-deleted-project-'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  execFileSync('git', ['init', '-q', projectRoot]);
  const react = candidate('facebook/react-skills', 'react', 'owner-verified');
  const initial = snapshotAtPath(react, 'react');
  const authorization = await passedAuditAuthorization(initial.candidate);
  const imported = importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-01T00:00:00.000Z', authorization);
  try {
    const project = await resolveProjectWorkspace(database, projectRoot);
    assert.ok(project);
    const mapping = database.prepare('SELECT entry_id AS entryId FROM external_skill_entries WHERE skill_id = ? AND active = 1')
      .get<{ entryId: string }>(imported.skillId);
    assert.ok(mapping);
    assert.equal(searchEntries(database, { workspace: imported.sourceWorkspace, query: 'react' }).items.some((item) => item.id === mapping.entryId), true);
    const before = await retrieveFederatedMemory(database, { project, scope: 'ecosystem', query: 'react', limit: 20 });
    assert.equal(before.ecosystem?.items.some((item) => item.id === mapping.entryId), true);

    const result = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(react)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch() { throw new SkillSourceError('source_missing'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.ok(result.failures.some((failure) => failure.code === 'candidate_not_found_at_source'));
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.skillId, imported.skillId);
    assert.equal(rows[0]?.state, 'stale');
    assert.equal(database.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ? AND entry_id = ?')
      .get<{ active: number }>(imported.skillId, mapping.entryId)?.active, 0);
    assert.equal(searchEntries(database, { workspace: imported.sourceWorkspace, query: 'react' }).items.some((item) => item.id === mapping.entryId), false);
    const after = await retrieveFederatedMemory(database, { project, scope: 'ecosystem', query: 'react', limit: 20 });
    assert.equal(after.ecosystem?.items.some((item) => item.id === mapping.entryId) ?? false, false);
  } finally {
    database.close();
  }
});

test('does not fabricate an aged community refresh when provider search is empty', async () => {
  const database = await databaseFixture('kiokuko-discovery-aged-community-');
  const community = { ...candidate('community/react-helper', 'react-helper', 'unknown'), auditStatus: 'passed' as const };
  const initial = snapshotAtPath(community, 'react-helper');
  const authorization = await passedAuditAuthorization(initial.candidate);
  const imported = importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-01T00:00:00.000Z', authorization);
  let sourceCalls = 0;
  let auditCalls = 0;
  try {
    const result = await discoverSkills(database, input('react', 'community'), {
      provider: {
        id: 'fixture',
        async search() { return { provider: 'fixture', experimental: false, candidates: [] }; },
        async audit() { auditCalls += 1; return { status: 'passed' }; },
      },
      sourceFetcher: {
        async fetch(skill) {
          sourceCalls += 1;
          assert.equal(skill.source, community.source);
          assert.equal(skill.slug, community.slug);
          throw new SkillSourceError('source_missing');
        },
      },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.equal(sourceCalls, 0);
    assert.equal(auditCalls, 0);
    assert.equal(result.selected.length, 0);
    const row = listExternalSkills(database).find((item) => item.skillId === imported.skillId);
    assert.equal(row?.state, 'imported');
    assert.equal(row?.lastCheckedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1')
      .get<{ count: number }>(imported.skillId)?.count, 1);
  } finally {
    database.close();
  }
});

test('does not treat a missing registry alias as proof that an aged canonical skill was deleted', async () => {
  const database = await databaseFixture('kiokuko-discovery-aged-canonical-alias-');
  const canonical = candidate('facebook/react-skills', 'react-helper', 'owner-verified');
  const alias = candidate('facebook/react-skills', 'react', 'owner-verified');
  const initial = snapshotAtPath(canonical, 'react-helper');
  const authorization = await passedAuditAuthorization(initial.candidate);
  const imported = importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-01T00:00:00.000Z', authorization);
  const fetched: string[] = [];
  try {
    await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(alias)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(skill) { fetched.push(skill.slug); throw new SkillSourceError('source_missing'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.deepEqual(fetched, ['react']);
    const canonicalRow = listExternalSkills(database).find((item) => item.skillId === imported.skillId);
    assert.equal(canonicalRow?.state, 'imported');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1')
      .get<{ count: number }>(imported.skillId)?.count, 1);
  } finally {
    database.close();
  }
});

test('revalidates the entire fetched snapshot instead of trusting claimed hashes and paths', async () => {
  const database = await databaseFixture('kiokuko-discovery-snapshot-boundary-');
  try {
    const result = await discoverSkills(database, input('svelte', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [reviewedSvelteCandidate] }; } },
      sourceFetcher: {
        async fetch(skill) {
          return {
            candidate: { ...skill, source: 'attacker/forged', officialStatus: 'curated' },
            sourceCommit: COMMIT,
            snapshotHash: '0'.repeat(64),
            files: [{ path: '../escape/SKILL.md', content: '---\nname: Forged\n---\n# Forged', contentHash: '0'.repeat(64), primary: true }],
            frontmatter: { name: 'Forged', description: null, disableModelInvocation: false },
          };
        },
      },
    });

    assert.equal(result.selected.length, 0);
    assert.ok(result.failures.some((failure) => failure.code === 'skill_validation_failed'));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('atomically reconciles an observed unmaterialized alias with an existing canonical row', async () => {
  const database = await databaseFixture('kiokuko-discovery-alias-reconcile-');
  const alias = candidate('facebook/react-skills', 'react', 'owner-verified');
  const canonical = candidate('facebook/react-skills', 'react-helper', 'owner-verified');
  try {
    const initial = snapshotAtPath(canonical, 'react-helper');
    const authorization = await passedAuditAuthorization(initial.candidate);
    const imported = importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-25T00:00:00.000Z', authorization);
    staleSkill(database, imported.skillId, '2026-08-25T01:00:00.000Z');
    const discoveredAlias = recordDiscoveredSkill(database, alias, '2026-08-25T01:30:00.000Z');
    staleSkill(database, discoveredAlias.skillId, '2026-08-25T02:00:00.000Z');

    const result = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(alias)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(skill) { return snapshotAtPath(skill, 'react-helper', NEXT_COMMIT); } },
      now: () => '2026-08-25T03:00:00.000Z',
    });

    assert.equal(result.selected[0]?.skillId, imported.skillId);
    assert.equal(result.failures.length, 0, JSON.stringify(result));
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.skillId, imported.skillId);
    assert.equal(rows[0]?.state, 'imported');
    assert.equal(rows[0]?.sourceCommit, NEXT_COMMIT);
  } finally {
    database.close();
  }
});

test('rekeys a stale unmaterialized alias when a later provider query returns the canonical identity', async () => {
  const database = await databaseFixture('kiokuko-discovery-two-query-alias-');
  const alias = candidate('facebook/react-skills', 'react', 'owner-verified');
  const canonical = candidate('facebook/react-skills', 'react-helper', 'owner-verified');
  try {
    const first = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(alias)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch() { throw new SkillSourceError('candidate_not_found_at_source'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(first.selected.length, 0);
    assert.equal(listExternalSkills(database).length, 1);
    assert.equal(listExternalSkills(database)[0]?.state, 'stale');
    assert.equal(listExternalSkills(database)[0]?.slug, 'react');

    database.prepare('DELETE FROM skill_discovery_cache').run();
    const second = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(canonical)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(skill) { return snapshotAtPath(skill, 'react-helper', NEXT_COMMIT); } },
      now: () => '2026-08-25T01:00:00.000Z',
    });
    assert.equal(second.failures.length, 0, JSON.stringify(second));
    assert.equal(second.selected.length, 1);
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.slug, 'react-helper');
    assert.equal(rows[0]?.state, 'imported');
  } finally {
    database.close();
  }
});

test('marks a materialized alias stale instead of creating a new canonical identity', async () => {
  const database = await databaseFixture('kiokuko-discovery-materialized-move-');
  const alias = candidate('facebook/react-skills', 'react', 'owner-verified');
  try {
    const initial = snapshotAtPath(alias, 'react');
    const authorization = await passedAuditAuthorization(initial.candidate);
    const imported = importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-25T00:00:00.000Z', authorization);
    staleSkill(database, imported.skillId, '2026-08-25T01:00:00.000Z');

    const result = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(alias)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch(skill, request) {
        assert.deepEqual(request, { purpose: 'refresh', expectedPrimaryPath: 'skills/react/SKILL.md' });
        return snapshotAtPath(skill, 'react-helper', NEXT_COMMIT);
      } },
      now: () => '2026-08-25T02:00:00.000Z',
    });

    assert.equal(result.selected.length, 0);
    assert.ok(result.failures.some((failure) => failure.code === 'persistence_conflict'));
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.skillId, imported.skillId);
    assert.equal(rows[0]?.state, 'stale');
    assert.equal(rows.some((row) => row.slug === 'react-helper'), false);
  } finally {
    database.close();
  }
});

test('does not create a blocked row for an unverified registry alias', async () => {
  const database = await databaseFixture('kiokuko-discovery-unverified-block-');
  const alias = candidate('facebook/react-skills', 'react', 'owner-verified');
  try {
    const result = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(alias)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch() { throw new SkillSourceError('skill_secret_detected'); } },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.ok(result.failures.some((failure) => failure.code === 'skill_secret_detected'));
    assert.equal(listExternalSkills(database).length, 0);
  } finally {
    database.close();
  }
});

test('does not auto-import a moved same-source identity around a disabled managed skill', async () => {
  const database = await databaseFixture('kiokuko-discovery-disabled-source-move-');
  const oldCandidate = candidate('facebook/react-skills', 'react-helper', 'owner-verified');
  const movedCandidate = candidate('facebook/react-skills', 'react-helper-v2', 'owner-verified');
  const initial = snapshotAtPath(oldCandidate, 'react-helper');
  const authorization = await passedAuditAuthorization(initial.candidate);
  const imported = importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-25T00:00:00.000Z', authorization);
  setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T01:00:00.000Z');
  let sourceCalls = 0;
  try {
    const result = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(movedCandidate)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch() { sourceCalls += 1; return snapshotAtPath(movedCandidate, 'react-helper-v2', NEXT_COMMIT); } },
      now: () => '2026-08-25T02:00:00.000Z',
    });

    assert.equal(result.selected.length, 0);
    assert.equal(sourceCalls, 0);
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.skillId, imported.skillId);
    assert.equal(rows[0]?.state, 'disabled');
    assert.notEqual(rows[0]?.slug, movedCandidate.slug);
  } finally {
    database.close();
  }
});

test('does not auto-import a moved same-source identity around a stale managed skill', async () => {
  const database = await databaseFixture('kiokuko-discovery-stale-source-move-');
  const oldCandidate = candidate('facebook/react-skills', 'react-helper', 'owner-verified');
  const movedCandidate = candidate('facebook/react-skills', 'react-helper-v2', 'owner-verified');
  const initial = snapshotAtPath(oldCandidate, 'react-helper');
  const authorization = await passedAuditAuthorization(initial.candidate);
  const imported = importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-25T00:00:00.000Z', authorization);
  staleSkill(database, imported.skillId, '2026-08-25T01:00:00.000Z');
  let sourceCalls = 0;
  try {
    const result = await discoverSkills(database, input('react', 'official'), {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [providerCandidate(movedCandidate)] }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: { async fetch() { sourceCalls += 1; return snapshotAtPath(movedCandidate, 'react-helper-v2', NEXT_COMMIT); } },
      now: () => '2026-08-25T02:00:00.000Z',
    });

    assert.equal(result.selected.length, 0);
    assert.equal(sourceCalls, 1);
    assert.ok(result.failures.some((failure) => failure.code === 'persistence_conflict'));
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.skillId, imported.skillId);
    assert.equal(rows[0]?.state, 'stale');
    assert.notEqual(rows[0]?.slug, movedCandidate.slug);
  } finally {
    database.close();
  }
});

test('defaults aged refresh and new materialization work to one skill per task', async () => {
  const database = await databaseFixture('kiokuko-discovery-managed-refresh-limit-');
  const react = candidate('facebook/react-skills', 'react', 'owner-verified');
  const initial = snapshotAtPath(react, 'react');
  const authorization = await passedAuditAuthorization(initial.candidate);
  importSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), reactRequirement, '2026-08-01T00:00:00.000Z', authorization);
  const svelte = candidate('sveltejs/ai-tools', 'svelte', 'catalog-verified');
  const sveltekit = candidate('sveltejs/ai-tools', 'sveltekit', 'catalog-verified');
  const fetched: string[] = [];
  try {
    const result = await discoverSkills(database, {
      project: { workspace: 'workspace:multi-framework', repositoryRoot: '/fixture/multi-framework', repositoryId: 'repo-multi-framework' },
      fingerprint: {
        repositoryId: 'repo-multi-framework',
        languages: ['JavaScript'],
        frameworks: [{ name: 'React', version: '19' }, { name: 'Svelte', version: '5' }, { name: 'SvelteKit', version: '2' }],
        databases: [], runtimes: ['Node.js'], tools: [],
        packages: [{ name: 'react', version: '19' }, { name: 'svelte', version: '5' }, { name: '@sveltejs/kit', version: '2' }],
        manifestDigest: 'multi-framework',
      },
      task: 'Build React, Svelte, and SvelteKit components',
      profile: { taskType: 'build', target: 'React, Svelte, and SvelteKit components', expected: 'tests pass', constraints: null },
      recommendedTags: ['react', 'svelte', 'sveltekit'], capabilities: [], mode: 'official',
    }, {
      provider: { id: 'fixture', async search() { return { provider: 'fixture', experimental: false, candidates: [react, svelte, sveltekit].map(providerCandidate) }; }, async audit() { return { status: 'passed' }; } },
      sourceFetcher: {
        async fetch(skill) {
          fetched.push(skill.slug);
          return snapshotAtPath(skill, skill.slug, NEXT_COMMIT);
        },
      },
      now: () => '2026-08-25T00:00:00.000Z',
    });

    assert.equal(result.selected.length, 1);
    assert.equal(fetched.length, 1, JSON.stringify(fetched));
    assert.equal(listExternalSkills(database).filter((skill) => skill.sourceCommit === NEXT_COMMIT).length, 1);
  } finally {
    database.close();
  }
});
