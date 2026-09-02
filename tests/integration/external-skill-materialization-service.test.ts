import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { fetchMaterializableSkillSnapshot } from '../../src/skills/materialization-service.js';
import { SkillProviderError } from '../../src/skills/providers/schema.js';
import { SkillSourceError } from '../../src/skills/source/errors.js';
import { writePersistentSkillAuditFailure } from '../../src/skills/store.js';
import type { SkillCandidate, SkillRegistryProvider } from '../../src/skills/types.js';

const communityCandidate: SkillCandidate = {
  id: 'fixture-audit:community/tools:svelte-helper',
  provider: 'fixture-audit',
  name: 'svelte-helper',
  slug: 'svelte-helper',
  source: 'community/tools',
  sourceType: 'github',
  installUrl: 'https://github.com/community/tools',
  installs: 1,
  duplicate: false,
  officialStatus: 'registry-only',
  auditStatus: 'passed',
};

const catalogCandidate: SkillCandidate = {
  id: 'fixture-catalog:sveltejs/ai-tools:svelte-code-writer',
  provider: 'fixture-catalog',
  name: 'svelte-code-writer',
  slug: 'svelte-code-writer',
  source: 'sveltejs/ai-tools',
  sourceType: 'github',
  installUrl: 'https://github.com/sveltejs/ai-tools',
  installs: 0,
  duplicate: false,
  officialStatus: 'unknown',
};

async function databaseFixture(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  return database;
}

test('source backoff suppresses repeated provider and GitHub calls without materializing state', async () => {
  const database = await databaseFixture('kiokuko-materializable-source-backoff-');
  let auditCalls = 0;
  let sourceCalls = 0;
  let queueDepth = 0;
  let queueCalls = 0;
  const provider: SkillRegistryProvider = {
    id: communityCandidate.provider,
    async search() { return { provider: communityCandidate.provider, experimental: false, candidates: [] }; },
    async audit(candidate) {
      assert.equal(queueDepth, 0, 'provider network work must run outside the write queue');
      assert.equal(candidate.auditStatus, undefined, 'descriptive persisted status must not reach the audit boundary');
      auditCalls += 1;
      return { status: 'passed' };
    },
  };
  const cacheWrite = async <T>(operation: () => T): Promise<T> => {
    queueCalls += 1;
    queueDepth += 1;
    try { return operation(); }
    finally { queueDepth -= 1; }
  };
  const operation = () => fetchMaterializableSkillSnapshot(database, communityCandidate, {
    provider,
    sourceFetcher: {
      async fetch() {
        assert.equal(queueDepth, 0, 'GitHub network work must run outside the write queue');
        sourceCalls += 1;
        throw new SkillSourceError('source_rate_limited', 30);
      },
    },
    sourceRequest: { purpose: 'discovery' },
    cacheWrite,
    now: '2026-08-25T00:00:00.000Z',
  });
  try {
    await assert.rejects(operation, (error: unknown) => error instanceof SkillSourceError && error.code === 'source_rate_limited');
    await assert.rejects(operation, (error: unknown) => error instanceof SkillSourceError && error.code === 'source_rate_limited');
    assert.equal(auditCalls, 1);
    assert.equal(sourceCalls, 1);
    assert.equal(queueCalls, 2, 'only the successful audit clear and first source-failure write mutate cache state');
    assert.deepEqual({ ...database.prepare(`
      SELECT source_type, source_locator, slug, outcome, fetched_at, expires_at
        FROM skill_source_failure_cache
    `).get<Record<string, unknown>>() }, {
      source_type: 'github',
      source_locator: communityCandidate.source,
      slug: communityCandidate.slug,
      outcome: 'source_rate_limited',
      fetched_at: '2026-08-25T00:00:00.000Z',
      expires_at: '2026-08-25T00:00:30.000Z',
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('provider-audit backoff suppresses a repeated exact community audit', async () => {
  const database = await databaseFixture('kiokuko-materializable-audit-backoff-');
  let auditCalls = 0;
  let sourceCalls = 0;
  const provider: SkillRegistryProvider = {
    id: communityCandidate.provider,
    async search() { return { provider: communityCandidate.provider, experimental: false, candidates: [] }; },
    async audit() {
      auditCalls += 1;
      throw new SkillProviderError('registry_rate_limited', 45);
    },
  };
  const operation = () => fetchMaterializableSkillSnapshot(database, communityCandidate, {
    provider,
    sourceFetcher: { async fetch() { sourceCalls += 1; throw new Error('audit denial must precede source access'); } },
    sourceRequest: { purpose: 'discovery' },
    now: '2026-08-25T00:00:00.000Z',
  });
  try {
    await assert.rejects(operation, (error: unknown) => (error as { code?: string }).code === 'SERVICE_UNAVAILABLE');
    await assert.rejects(operation, (error: unknown) => (error as { code?: string }).code === 'SERVICE_UNAVAILABLE');
    assert.equal(auditCalls, 1);
    assert.equal(sourceCalls, 0);
    assert.deepEqual({ ...database.prepare(`
      SELECT provider, source_type, source_locator, slug, outcome, fetched_at, expires_at
        FROM skill_audit_failure_cache
    `).get<Record<string, unknown>>() }, {
      provider: communityCandidate.provider,
      source_type: 'github',
      source_locator: communityCandidate.source,
      slug: communityCandidate.slug,
      outcome: 'registry_rate_limited',
      fetched_at: '2026-08-25T00:00:00.000Z',
      expires_at: '2026-08-25T00:00:45.000Z',
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('a wrong provider fails before cached backoff can mask the identity mismatch', async () => {
  const database = await databaseFixture('kiokuko-materializable-provider-mismatch-');
  const now = '2026-08-25T00:00:00.000Z';
  const wrongProviderId = 'wrong-provider';
  writePersistentSkillAuditFailure(database, wrongProviderId, communityCandidate, 'registry_rate_limited', 45_000, now);
  const cachedBefore = { ...database.prepare(`
    SELECT provider, source_type, source_locator, slug, outcome, fetched_at, expires_at
      FROM skill_audit_failure_cache
  `).get<Record<string, unknown>>() };
  let auditCalls = 0;
  let sourceCalls = 0;
  try {
    await assert.rejects(
      () => fetchMaterializableSkillSnapshot(database, communityCandidate, {
        provider: {
          id: wrongProviderId,
          async search() { return { provider: wrongProviderId, experimental: false, candidates: [] }; },
          async audit() { auditCalls += 1; return { status: 'passed' }; },
        },
        sourceFetcher: { async fetch() { sourceCalls += 1; throw new Error('provider mismatch must precede source access'); } },
        sourceRequest: { purpose: 'discovery' },
        now,
      }),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'SECURITY_REJECTION'
        && error.message === 'External skill audit provider does not match the candidate provider',
    );
    assert.equal(auditCalls, 0);
    assert.equal(sourceCalls, 0);
    assert.deepEqual({ ...database.prepare(`
      SELECT provider, source_type, source_locator, slug, outcome, fetched_at, expires_at
        FROM skill_audit_failure_cache
    `).get<Record<string, unknown>>() }, cachedBefore);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('reviewed catalog source backoff suppresses repeated create-only fetch attempts', async () => {
  const database = await databaseFixture('kiokuko-materializable-catalog-backoff-');
  let auditCalls = 0;
  let sourceCalls = 0;
  const provider: SkillRegistryProvider = {
    id: 'wrong-catalog-provider',
    async search() { return { provider: 'wrong-catalog-provider', experimental: false, candidates: [] }; },
    async audit() { auditCalls += 1; return { status: 'passed' }; },
  };
  const operation = () => fetchMaterializableSkillSnapshot(database, catalogCandidate, {
    provider,
    sourceFetcher: {
      async fetch() {
        sourceCalls += 1;
        throw new SkillSourceError('source_unavailable');
      },
    },
    sourceRequest: { purpose: 'discovery' },
    now: '2026-08-25T00:00:00.000Z',
  });
  try {
    await assert.rejects(operation, (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable');
    await assert.rejects(operation, (error: unknown) => error instanceof SkillSourceError && error.code === 'source_unavailable');
    assert.equal(auditCalls, 0, 'exact reviewed catalog identity is independently authorized');
    assert.equal(sourceCalls, 1);
    assert.deepEqual({ ...database.prepare(`
      SELECT source_locator, slug, outcome, fetched_at, expires_at
        FROM skill_source_failure_cache
    `).get<Record<string, unknown>>() }, {
      source_locator: catalogCandidate.source,
      slug: catalogCandidate.slug,
      outcome: 'source_unavailable',
      fetched_at: '2026-08-25T00:00:00.000Z',
      expires_at: '2026-08-25T00:10:00.000Z',
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('cache queue backpressure aborts before source access and leaves every cache table unchanged', async () => {
  const database = await databaseFixture('kiokuko-materializable-cache-backpressure-');
  let auditCalls = 0;
  let sourceCalls = 0;
  const provider: SkillRegistryProvider = {
    id: communityCandidate.provider,
    async search() { return { provider: communityCandidate.provider, experimental: false, candidates: [] }; },
    async audit() { auditCalls += 1; return { status: 'passed' }; },
  };
  try {
    await assert.rejects(
      () => fetchMaterializableSkillSnapshot(database, communityCandidate, {
        provider,
        sourceFetcher: { async fetch() { sourceCalls += 1; throw new Error('source must not run after queue rejection'); } },
        sourceRequest: { purpose: 'discovery' },
        cacheWrite: async () => { throw new KiokukoError('BACKPRESSURE', 'write queue is full'); },
        now: '2026-08-25T00:00:00.000Z',
      }),
      (error: unknown) => (error as { code?: string }).code === 'BACKPRESSURE',
    );
    assert.equal(auditCalls, 1);
    assert.equal(sourceCalls, 0);
    for (const table of ['skill_discovery_cache', 'skill_source_failure_cache', 'skill_audit_failure_cache', 'external_skills', 'entries']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()?.count, 0, table);
    }
  } finally {
    database.close();
  }
});

test('an unknown runtime provider failure is rethrown without cache or materialization mutation', async () => {
  const database = await databaseFixture('kiokuko-materializable-unknown-provider-code-');
  const forged = new SkillProviderError('registry_future_failure' as never);
  let sourceCalls = 0;
  try {
    await assert.rejects(
      () => fetchMaterializableSkillSnapshot(database, communityCandidate, {
        provider: {
          id: communityCandidate.provider,
          async search() { return { provider: communityCandidate.provider, experimental: false, candidates: [] }; },
          async audit() { throw forged; },
        },
        sourceFetcher: { async fetch() { sourceCalls += 1; throw new Error('source must not run'); } },
        sourceRequest: { purpose: 'discovery' },
        now: '2026-08-25T00:00:00.000Z',
      }),
      (error: unknown) => error === forged,
    );
    assert.equal(sourceCalls, 0);
    for (const table of ['skill_source_failure_cache', 'skill_audit_failure_cache', 'external_skills', 'entries']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()?.count, 0, table);
    }
  } finally {
    database.close();
  }
});

test('an unknown runtime source failure is rethrown without cache or materialization mutation', async () => {
  const database = await databaseFixture('kiokuko-materializable-unknown-source-code-');
  const forged = new SkillSourceError('source_future_failure' as never);
  try {
    await assert.rejects(
      () => fetchMaterializableSkillSnapshot(database, catalogCandidate, {
        provider: {
          id: catalogCandidate.provider,
          async search() { return { provider: catalogCandidate.provider, experimental: false, candidates: [] }; },
        },
        sourceFetcher: { async fetch() { throw forged; } },
        sourceRequest: { purpose: 'discovery' },
        now: '2026-08-25T00:00:00.000Z',
      }),
      (error: unknown) => error === forged,
    );
    for (const table of ['skill_source_failure_cache', 'skill_audit_failure_cache', 'external_skills', 'entries']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()?.count, 0, table);
    }
  } finally {
    database.close();
  }
});
