import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { readEntry, recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { chunkSkillMarkdown } from '../../src/skills/chunking.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { canonicalContentHash, canonicalEntryRevisionContentHash, canonicalJson } from '../../src/serialization/validate.js';
import { externalSkillListVersion, externalSkillRequirement, externalSkillWorkspace, importSkillSnapshot, listExternalSkills, listExternalSkillsPage, markExternalSkillRefreshFailure, persistExistingSkillImport, persistPreparedSkillRefresh, persistSkillImport, pruneExternalSkillCaches, readExternalSkill, readPersistentSkillAuditFailure, readPersistentSkillSearchCache, readPersistentSkillSourceFailure, recordDiscoveredSkill, refreshExternalSkillSnapshot, resolveExternalSkillIdentifier, setExternalSkillState, writePersistentSkillAuditFailure, writePersistentSkillSearchCache, writePersistentSkillSourceFailure, type ExternalSkillRecord } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { PreparedSkillDocument, PreparedSkillImport, SkillCandidate, SkillRequirement, SkillSnapshot } from '../../src/skills/types.js';

const candidate: SkillCandidate = {
  id: 'fixture:owner/repo:sveltekit-helper',
  provider: 'fixture',
  name: 'sveltekit-helper',
  slug: 'sveltekit-helper',
  source: 'owner/repo',
  sourceType: 'github',
  installUrl: 'https://github.com/owner/repo',
  installs: 1,
  duplicate: false,
  officialStatus: 'catalog-verified',
  auditStatus: 'passed',
};

const requirement: SkillRequirement = {
  id: 'sveltekit',
  technology: 'sveltekit',
  aliases: ['sveltekit', 'svelte'],
  queries: ['sveltekit'],
  owners: ['owner'],
  repositories: ['owner/repo'],
  applicability: { frameworks: [{ name: 'SvelteKit' }] },
  signals: { packages: ['@sveltejs/kit'] },
  reason: 'fixture',
};

const COMMIT_A = 'd'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const COMMIT_C = 'c'.repeat(40);

function refreshExpectation(current: ExternalSkillRecord) {
  return {
    generation: current.generation,
    sourceCommit: current.sourceCommit,
    snapshotHash: current.snapshotHash,
    state: current.state,
    lastCheckedAt: current.lastCheckedAt,
  };
}

function transitionRefreshFailure(database: ReturnType<typeof openConnection>, skillId: string, state: 'stale' | 'blocked', now: string) {
  const current = listExternalSkills(database).find((skill) => skill.skillId === skillId);
  assert.ok(current);
  return markExternalSkillRefreshFailure(database, skillId, state, refreshExpectation(current), now);
}

async function passedMaterializationAuthorization(materializedCandidate: SkillCandidate) {
  const result = await authorizeSkillMaterialization({
    id: materializedCandidate.provider,
    search: async () => ({ provider: materializedCandidate.provider, experimental: false, candidates: [] }),
    audit: async () => ({ status: 'passed' as const }),
  }, materializedCandidate);
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') throw new Error('Test provider did not issue materialization authority');
  return result.authorization;
}

async function importAuditedSkillSnapshot(
  database: ReturnType<typeof openConnection>,
  snapshot: SkillSnapshot,
  documents: PreparedSkillDocument[],
  importedRequirement?: SkillRequirement,
  now?: string,
) {
  return importSkillSnapshot(
    database,
    snapshot,
    documents,
    importedRequirement,
    now,
    await passedMaterializationAuthorization(snapshot.candidate),
  );
}

async function persistAuditedSkillImport(database: ReturnType<typeof openConnection>, input: PreparedSkillImport, now?: string) {
  return persistSkillImport(database, input, now, await passedMaterializationAuthorization(input.skill));
}

async function persistAuditedPreparedSkillRefresh(
  database: ReturnType<typeof openConnection>,
  input: PreparedSkillImport,
  expected: ReturnType<typeof refreshExpectation>,
  now?: string,
) {
  return persistPreparedSkillRefresh(database, input, expected, now, await passedMaterializationAuthorization(input.skill));
}

async function persistAuditedExistingSkillImport(
  database: ReturnType<typeof openConnection>,
  skillId: string,
  input: PreparedSkillImport,
  expected: ReturnType<typeof refreshExpectation>,
  now?: string,
  canonicalTarget?: { skillId: string; expected: ReturnType<typeof refreshExpectation> },
) {
  return persistExistingSkillImport(
    database,
    skillId,
    input,
    expected,
    now,
    canonicalTarget,
    await passedMaterializationAuthorization(input.skill),
  );
}

async function refreshAuditedExternalSkillSnapshot(
  database: ReturnType<typeof openConnection>,
  skillId: string,
  snapshot: SkillSnapshot,
  documents: PreparedSkillDocument[],
  refreshedRequirement: SkillRequirement | undefined,
  expected: ReturnType<typeof refreshExpectation>,
  now?: string,
) {
  return refreshExternalSkillSnapshot(
    database,
    skillId,
    snapshot,
    documents,
    refreshedRequirement,
    expected,
    now,
    await passedMaterializationAuthorization(snapshot.candidate),
  );
}

async function refreshSkillSnapshot(
  database: ReturnType<typeof openConnection>,
  snapshot: ReturnType<typeof importedSnapshot>,
  documents: PreparedSkillDocument[],
  refreshedRequirement: SkillRequirement | undefined,
  now: string,
) {
  const current = listExternalSkills(database).find((skill) => skill.sourceLocator === snapshot.candidate.source
    && skill.slug === snapshot.candidate.slug);
  assert.ok(current);
  const outcome = await refreshAuditedExternalSkillSnapshot(database, current.skillId, snapshot, documents, refreshedRequirement, refreshExpectation(current), now);
  assert.equal(outcome.kind, 'refreshed');
  if (outcome.kind !== 'refreshed') throw new Error('Expected a refreshed Skill snapshot');
  return outcome.result;
}

test('keeps long external source workspaces bounded and collision-resistant', () => {
  const owner = 'o'.repeat(100);
  const left = externalSkillWorkspace({ ...candidate, source: `${owner}/${'r'.repeat(99)}a` });
  const right = externalSkillWorkspace({ ...candidate, source: `${owner}/${'r'.repeat(99)}b` });
  assert.ok(left.length <= 240);
  assert.ok(right.length <= 240);
  assert.notEqual(left, right);
  const slashLeft = externalSkillWorkspace({ ...candidate, source: 'foo-bar/baz' });
  const slashRight = externalSkillWorkspace({ ...candidate, source: 'foo/bar-baz' });
  assert.notEqual(slashLeft, slashRight);
  assert.equal(slashLeft, externalSkillWorkspace({ ...candidate, source: 'foo-bar/baz' }));
  assert.ok(slashLeft.length <= 240);
});

test('external source workspace hash casing is independent of Turkish locale rules', () => {
  const original = String.prototype.toLocaleLowerCase;
  Object.defineProperty(String.prototype, 'toLocaleLowerCase', {
    configurable: true,
    writable: true,
    value(this: string) { return original.call(this, 'tr-TR'); },
  });
  try {
    assert.equal('I'.toLocaleLowerCase(), 'ı');
    const uppercaseSuffix = externalSkillWorkspace({ ...candidate, source: 'OWNER/REPOI' }).slice(-16);
    const canonicalSuffix = externalSkillWorkspace({ ...candidate, source: 'owner/repoi' }).slice(-16);
    assert.equal(uppercaseSuffix, canonicalSuffix);
  } finally {
    Object.defineProperty(String.prototype, 'toLocaleLowerCase', {
      configurable: true,
      writable: true,
      value: original,
    });
  }
});

test('rejects corrupt persistent search cache identity and timestamps without deleting evidence', async () => {
  const corruptions: Array<{ name: string; sql: string; parameters: Array<string | null> }> = [
    { name: 'cache key mismatch', sql: 'UPDATE skill_discovery_cache SET cache_key = ?', parameters: ['0'] },
    { name: 'invalid expiry', sql: 'UPDATE skill_discovery_cache SET expires_at = ?', parameters: ['zzzz'] },
    { name: 'invalid fetch time', sql: 'UPDATE skill_discovery_cache SET fetched_at = ?', parameters: ['not-a-time'] },
    { name: 'expiry before fetch', sql: 'UPDATE skill_discovery_cache SET fetched_at = ?, expires_at = ?', parameters: ['2026-08-25T00:02:00.000Z', '2026-08-25T00:01:00.000Z'] },
    { name: 'provider mismatch', sql: 'UPDATE skill_discovery_cache SET provider = ?', parameters: ['attacker'] },
    { name: 'query mismatch', sql: 'UPDATE skill_discovery_cache SET query_text = ?', parameters: ['other'] },
    { name: 'owner mismatch', sql: 'UPDATE skill_discovery_cache SET owner = ?', parameters: ['other'] },
    { name: 'mode mismatch', sql: 'UPDATE skill_discovery_cache SET mode = ?', parameters: ['community'] },
  ];
  for (const corruption of corruptions) {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cache-integrity-'));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    try {
      writePersistentSkillSearchCache(database, {
        provider: 'fixture',
        query: 'sveltekit',
        owner: 'owner',
        mode: 'official',
        result: { provider: 'fixture', experimental: true, candidates: [{ ...candidate, officialStatus: 'registry-only' }] },
        outcome: 'success',
        ttlMs: 60_000,
        now: '2026-08-25T00:00:00.000Z',
      });
      assert.equal(readPersistentSkillSearchCache(database, { provider: 'fixture', query: 'sveltekit', owner: 'owner', mode: 'official', now: '2026-08-25T00:00:15.000Z' })?.candidates.length, 1);
      database.prepare(corruption.sql).run(...corruption.parameters);
      assert.throws(
        () => readPersistentSkillSearchCache(database, { provider: 'fixture', query: 'sveltekit', owner: 'owner', mode: 'official', now: '2026-08-25T00:00:30.000Z' }),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
        corruption.name,
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()?.count, 1);
    } finally {
      database.close();
    }
  }
});

test('cache readers reject a wrong key for the same source or audit identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cache-key-integrity-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    writePersistentSkillSourceFailure(database, candidate, 'source_unavailable', 30_000, '2026-08-25T00:00:00.000Z');
    writePersistentSkillAuditFailure(database, 'fixture-audit', candidate, 'registry_unavailable', 30_000, '2026-08-25T00:00:00.000Z');
    database.prepare("UPDATE skill_source_failure_cache SET cache_key = 'source-corrupt'").run();
    database.prepare("UPDATE skill_audit_failure_cache SET cache_key = 'audit-corrupt'").run();

    assert.throws(
      () => readPersistentSkillSourceFailure(database, candidate, '2026-08-25T00:00:20.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.throws(
      () => readPersistentSkillAuditFailure(database, 'fixture-audit', candidate, '2026-08-25T00:00:20.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('cache pruning validates every stored identity, response, and outcome before deleting anything', async () => {
  const corruptions: Array<{
    name: string;
    sql: string;
    bypassCheck?: boolean;
  }> = [
    { name: 'search response body', sql: "UPDATE skill_discovery_cache SET response_json = '{'" },
    { name: 'search cache key', sql: "UPDATE skill_discovery_cache SET cache_key = '0'" },
    { name: 'search outcome', sql: "UPDATE skill_discovery_cache SET outcome = 'forged'", bypassCheck: true },
    { name: 'search non-text outcome', sql: "UPDATE skill_discovery_cache SET outcome = CAST('empty' AS BLOB)", bypassCheck: true },
    { name: 'source cache key', sql: "UPDATE skill_source_failure_cache SET cache_key = '0'" },
    { name: 'source outcome', sql: "UPDATE skill_source_failure_cache SET outcome = 'forged'", bypassCheck: true },
    { name: 'source non-text outcome', sql: "UPDATE skill_source_failure_cache SET outcome = CAST('source_unavailable' AS BLOB)", bypassCheck: true },
    { name: 'source expiry', sql: "UPDATE skill_source_failure_cache SET expires_at = 'not-a-time'" },
    { name: 'audit cache key', sql: "UPDATE skill_audit_failure_cache SET cache_key = '0'" },
    { name: 'audit outcome', sql: "UPDATE skill_audit_failure_cache SET outcome = 'forged'", bypassCheck: true },
    { name: 'audit non-text outcome', sql: "UPDATE skill_audit_failure_cache SET outcome = CAST('registry_unavailable' AS BLOB)", bypassCheck: true },
  ];

  for (const corruption of corruptions) {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-cache-prune-integrity-'));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    try {
      writePersistentSkillSearchCache(database, {
        provider: 'fixture', query: 'expired', mode: 'official', outcome: 'empty',
        result: { provider: 'fixture', experimental: false, candidates: [] },
        ttlMs: 1_000, now: '2020-01-01T00:00:00.000Z',
      });
      writePersistentSkillSourceFailure(database, candidate, 'source_unavailable', 1_000, '2020-01-01T00:00:00.000Z');
      writePersistentSkillAuditFailure(database, 'fixture-audit', candidate, 'registry_unavailable', 1_000, '2020-01-01T00:00:00.000Z');
      if (corruption.bypassCheck) database.exec('PRAGMA ignore_check_constraints = ON');
      try {
        database.prepare(corruption.sql).run();
      } finally {
        if (corruption.bypassCheck) database.exec('PRAGMA ignore_check_constraints = OFF');
      }

      assert.throws(
        () => pruneExternalSkillCaches(database, '2026-08-25T00:00:00.000Z'),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
        corruption.name,
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()?.count, 1, corruption.name);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 1, corruption.name);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 1, corruption.name);
    } finally {
      database.close();
    }
  }
});

test('binds audit backoff to provider and exact case-sensitive skill identity and fails closed on corruption', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-audit-cache-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    writePersistentSkillAuditFailure(database, 'fixture-audit', candidate, 'registry_rate_limited', 30_000, '2026-08-25T00:00:00.000Z');
    assert.deepEqual(readPersistentSkillAuditFailure(database, 'fixture-audit', candidate, '2026-08-25T00:00:20.000Z'), {
      code: 'registry_rate_limited',
      fetchedAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-08-25T00:00:30.000Z',
    });
    assert.equal(readPersistentSkillAuditFailure(database, 'other-audit', candidate, '2026-08-25T00:00:20.000Z'), null);
    assert.equal(readPersistentSkillAuditFailure(database, 'fixture-audit', { ...candidate, slug: 'SvelteKit-Helper', id: 'fixture:owner/repo:SvelteKit-Helper' }, '2026-08-25T00:00:20.000Z'), null);
    database.prepare("UPDATE skill_audit_failure_cache SET source_locator = 'attacker/repo'").run();
    assert.throws(
      () => readPersistentSkillAuditFailure(database, 'fixture-audit', candidate, '2026-08-25T00:00:20.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

function importedSnapshot(value: string, metadata = candidate) {
  const content = `---\nname: SvelteKit Helper\ndescription: safe\n---\n# SvelteKit\n\n${value}`;
  return validateSkillSnapshot({
    candidate: metadata,
    sourceCommit: COMMIT_A,
    files: [{ path: 'skills/sveltekit-helper/SKILL.md', content, primary: true }],
  });
}

test('keeps case-sensitive source-path identities distinct through import and refresh', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-path-case-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const mixedCandidate: SkillCandidate = { ...candidate, id: 'fixture:owner/repo:MixedCase', name: 'MixedCase', slug: 'MixedCase' };
    const lowerCandidate: SkillCandidate = { ...candidate, id: 'fixture:owner/repo:mixedcase', name: 'mixedcase', slug: 'mixedcase' };
    const snapshot = (skill: SkillCandidate, commit: string, body: string) => validateSkillSnapshot({
      candidate: skill,
      sourceCommit: commit,
      files: [{
        path: `skills/${skill.slug}/SKILL.md`,
        content: `---\nname: ${skill.name}\ndescription: safe\n---\n# ${skill.name}\n\n${body}`,
        primary: true,
      }],
    });
    const mixedA = snapshot(mixedCandidate, COMMIT_A, 'Mixed path A.');
    const lowerA = snapshot(lowerCandidate, COMMIT_A, 'Lower path A.');
    const mixedImport = await importAuditedSkillSnapshot(database, mixedA, documentsFromSkillSnapshot(mixedA), requirement, '2026-08-25T00:00:00.000Z');
    const lowerImport = await importAuditedSkillSnapshot(database, lowerA, documentsFromSkillSnapshot(lowerA), requirement, '2026-08-25T00:00:01.000Z');

    assert.notEqual(mixedImport.skillId, lowerImport.skillId);
    assert.equal(resolveExternalSkillIdentifier(database, 'owner/repo/MixedCase').skillId, mixedImport.skillId);
    assert.equal(resolveExternalSkillIdentifier(database, 'owner/repo/mixedcase').skillId, lowerImport.skillId);
    assert.throws(
      () => resolveExternalSkillIdentifier(database, 'https://github.com/owner/repo/MixedCase'),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => resolveExternalSkillIdentifier(database, 'owner/repo.git/MixedCase'),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
    );
    assert.throws(
      () => resolveExternalSkillIdentifier(database, 'owner/repo/MIXEDCASE'),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
    );

    const current = listExternalSkills(database).find((skill) => skill.skillId === mixedImport.skillId);
    assert.ok(current);
    const mixedB = snapshot(mixedCandidate, COMMIT_B, 'Mixed path B.');
    await refreshAuditedExternalSkillSnapshot(
      database,
      mixedImport.skillId,
      mixedB,
      documentsFromSkillSnapshot(mixedB),
      requirement,
      refreshExpectation(current),
      '2026-08-25T01:00:00.000Z',
    );
    assert.equal(readExternalSkill(database, mixedImport.skillId)?.skill.slug, 'MixedCase');
    assert.equal(readExternalSkill(database, lowerImport.skillId)?.skill.slug, 'mixedcase');
  } finally {
    database.close();
  }
});

test('refresh materializes unverified discovered and stale rows through strict CAS', async () => {
  for (const initialState of ['discovered', 'stale'] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-external-skill-refresh-${initialState}-`));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    try {
      const discovered = recordDiscoveredSkill(database, candidate, '2026-08-25T00:00:00.000Z');
      const current = initialState === 'stale'
        ? transitionRefreshFailure(database, discovered.skillId, 'stale', '2026-08-25T01:00:00.000Z')
        : discovered;
      const snapshot = importedSnapshot(`Recovered from ${initialState}.`);
      const documents = documentsFromSkillSnapshot(snapshot);
      const result = await refreshAuditedExternalSkillSnapshot(database, current.skillId, snapshot, documents, requirement, {
        generation: current.generation,
        sourceCommit: null,
        snapshotHash: null,
        state: initialState,
        lastCheckedAt: current.lastCheckedAt,
      }, '2026-08-25T02:00:00.000Z');

      assert.equal(result.kind, 'refreshed');
      if (result.kind !== 'refreshed') throw new Error('Expected a refreshed Skill snapshot');
      assert.equal(result.result.skillId, current.skillId);
      assert.equal(result.result.imported, documents.length);
      assert.equal(result.result.updated, false);
      const detail = readExternalSkill(database, current.skillId)!;
      assert.equal(detail.skill.state, 'imported');
      assert.equal(detail.skill.sourceCommit, snapshot.sourceCommit);
      assert.equal(detail.skill.snapshotHash, snapshot.snapshotHash);
      assert.equal(detail.entries.length, documents.length);
      assert.ok(detail.entries.every((entry) => entry.active));
      assert.deepEqual(externalSkillRequirement(database, current.skillId)?.applicability.frameworks, [{ name: 'SvelteKit' }]);
    } finally {
      database.close();
    }
  }
});

test('refresh refuses a stale generation while leaving an unmaterialized row untouched', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-refresh-unmaterialized-cas-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const discovered = recordDiscoveredSkill(database, candidate, '2026-08-25T00:00:00.000Z');
    transitionRefreshFailure(database, discovered.skillId, 'stale', '2026-08-25T01:00:00.000Z');
    const snapshot = importedSnapshot('Must not cross a stale generation.');
    await assert.rejects(
      () => refreshAuditedExternalSkillSnapshot(database, discovered.skillId, snapshot, documentsFromSkillSnapshot(snapshot), requirement, {
        generation: discovered.generation,
        sourceCommit: null,
        snapshotHash: null,
        state: 'discovered',
        lastCheckedAt: discovered.lastCheckedAt,
      }, '2026-08-25T02:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    const detail = readExternalSkill(database, discovered.skillId)!;
    assert.equal(detail.skill.state, 'stale');
    assert.equal(detail.skill.sourceCommit, null);
    assert.equal(detail.skill.snapshotHash, null);
    assert.equal(detail.entries.length, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries WHERE workspace = ?').get<{ count: number }>(detail.skill.sourceWorkspace)?.count, 0);
  } finally {
    database.close();
  }
});

test('refresh fails closed on an unmaterialized row with a pre-existing mapping', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-refresh-unmaterialized-mapping-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const discovered = recordDiscoveredSkill(database, candidate, '2026-08-25T00:00:00.000Z');
    const injected = recordEntry(database, {
      workspace: discovered.sourceWorkspace,
      kind: 'reference',
      title: 'Injected mapping',
      body: 'This mapping must not be adopted.',
      createdBy: 'test',
      actor: 'test',
    }, { now: '2026-08-25T00:30:00.000Z' });
    database.prepare(`
      INSERT INTO external_skill_entries (
        skill_id, source_path, chunk_index, entry_id, entry_revision,
        content_hash, primary_document, active, imported_at
      ) VALUES (?, ?, 0, ?, ?, ?, 1, 0, ?)
    `).run(discovered.skillId, 'skills/sveltekit-helper/SKILL.md', injected.id, injected.revision, injected.contentHash, '2026-08-25T00:30:00.000Z');
    const snapshot = importedSnapshot('Must reject the injected mapping.');

    await assert.rejects(
      () => refreshAuditedExternalSkillSnapshot(database, discovered.skillId, snapshot, documentsFromSkillSnapshot(snapshot), requirement, {
        generation: discovered.generation,
        sourceCommit: null,
        snapshotHash: null,
        state: 'discovered',
        lastCheckedAt: discovered.lastCheckedAt,
      }, '2026-08-25T01:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /unmaterialized external skill has stored mappings/iu.test((error as Error).message),
    );
    const stored = database.prepare('SELECT state, source_commit, snapshot_hash FROM external_skills WHERE skill_id = ?').get<{ state: string; source_commit: string | null; snapshot_hash: string | null }>(discovered.skillId)!;
    assert.equal(stored.state, 'discovered');
    assert.equal(stored.source_commit, null);
    assert.equal(stored.snapshot_hash, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ?').get<{ count: number }>(discovered.skillId)?.count, 1);
  } finally {
    database.close();
  }
});

test('does not revise an identical snapshot and scope when a provider label changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-store-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const firstSnapshot = importedSnapshot('Reference one.');
    const firstDocuments = chunkSkillMarkdown({ skillName: firstSnapshot.frontmatter.name, sourcePath: firstSnapshot.files[0]!.path, markdown: firstSnapshot.files[0]!.content, summary: firstSnapshot.frontmatter.description, stripFrontmatter: true });
    const first = await importAuditedSkillSnapshot(database, firstSnapshot, firstDocuments, requirement, '2026-08-25T00:00:00.000Z');
    const firstMapping = database.prepare('SELECT entry_id, entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number }>(first.skillId)!;
    const changedMetadata = { ...candidate, id: 'replacement-provider:owner/repo:renamed', provider: 'replacement-provider', name: 'renamed', installs: 2_000 };
    const metadataSnapshot = importedSnapshot('Reference one.', changedMetadata);
    assert.equal(metadataSnapshot.snapshotHash, firstSnapshot.snapshotHash);
    assert.equal(externalSkillWorkspace(changedMetadata), externalSkillWorkspace(candidate));
    const metadataDocuments = chunkSkillMarkdown({ skillName: metadataSnapshot.frontmatter.name, sourcePath: metadataSnapshot.files[0]!.path, markdown: metadataSnapshot.files[0]!.content, summary: metadataSnapshot.frontmatter.description, stripFrontmatter: true });
    const unchanged = await refreshSkillSnapshot(database, metadataSnapshot, metadataDocuments, requirement, '2026-08-25T01:00:00.000Z');
    const unchangedMapping = database.prepare('SELECT entry_id, entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number }>(first.skillId)!;
    assert.equal(unchanged.updated, false);
    assert.equal(unchanged.skillId, first.skillId);
    assert.equal(unchangedMapping.entry_id, firstMapping.entry_id);
    assert.equal(unchangedMapping.entry_revision, firstMapping.entry_revision);
    assert.equal(listExternalSkills(database)[0]?.provider, 'fixture');
    const unchangedEntry = readEntry(database, { workspace: first.sourceWorkspace, entryId: firstMapping.entry_id });
    assert.ok(unchangedEntry.tags.includes('provider:fixture'));
    assert.equal(unchangedEntry.tags.includes('provider:replacement-provider'), false);

    const changedSnapshot = importedSnapshot('Reference two.');
    const changedDocuments = chunkSkillMarkdown({ skillName: changedSnapshot.frontmatter.name, sourcePath: changedSnapshot.files[0]!.path, markdown: changedSnapshot.files[0]!.content, summary: changedSnapshot.frontmatter.description, stripFrontmatter: true });
    const updated = await refreshSkillSnapshot(database, changedSnapshot, changedDocuments, requirement, '2026-08-25T02:00:00.000Z');
    const updatedMapping = database.prepare('SELECT entry_id, entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number }>(first.skillId)!;
    assert.equal(updated.updated, true);
    assert.equal(updatedMapping.entry_id, firstMapping.entry_id);
    assert.equal(updatedMapping.entry_revision, firstMapping.entry_revision + 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries WHERE workspace = ?').get<{ count: number }>(externalSkillWorkspace(candidate))?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions WHERE entry_id = ?').get<{ count: number }>(firstMapping.entry_id)?.count, 2);
    const refreshed = readEntry(database, { workspace: externalSkillWorkspace(candidate), entryId: firstMapping.entry_id });
    assert.match(refreshed.body, /Reference two/u);
    assert.deepEqual((refreshed.scope.applicability as Record<string, unknown>).frameworks, [{ name: 'SvelteKit' }]);
    assert.deepEqual((refreshed.scope.signals as Record<string, unknown>).packages, ['@sveltejs/kit']);
    assert.deepEqual(externalSkillRequirement(database, first.skillId)?.applicability.frameworks, [{ name: 'SvelteKit' }]);
  } finally {
    database.close();
  }
});

test('merges applicability deterministically when the same snapshot satisfies another requirement', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-requirement-merge-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const svelteRequirement: SkillRequirement = {
    ...requirement,
    id: 'svelte', technology: 'svelte', aliases: ['svelte'], queries: ['svelte'],
    applicability: { frameworks: [{ name: 'Svelte' }], languages: ['TypeScript'] },
    signals: { packages: ['svelte'] },
  };
  try {
    const snapshot = importedSnapshot('Shared reference.');
    const documents = documentsFromSkillSnapshot(snapshot);
    const first = await importAuditedSkillSnapshot(database, snapshot, documents, requirement, '2026-08-25T00:00:00.000Z');
    const initial = database.prepare('SELECT entry_id, entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number }>(first.skillId)!;
    const merged = await refreshSkillSnapshot(database, snapshot, documents, svelteRequirement, '2026-08-25T01:00:00.000Z');
    const changed = database.prepare('SELECT entry_id, entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number }>(first.skillId)!;
    assert.equal(merged.updated, false);
    assert.equal(changed.entry_id, initial.entry_id);
    assert.equal(changed.entry_revision, initial.entry_revision + 1);
    const entry = readEntry(database, { workspace: first.sourceWorkspace, entryId: changed.entry_id });
    assert.deepEqual((entry.scope.applicability as Record<string, unknown>).frameworks, [{ name: 'Svelte' }, { name: 'SvelteKit' }]);
    assert.deepEqual((entry.scope.applicability as Record<string, unknown>).languages, ['TypeScript']);
    assert.deepEqual((entry.scope.signals as Record<string, unknown>).packages, ['@sveltejs/kit', 'svelte']);
    assert.deepEqual(externalSkillRequirement(database, first.skillId)?.applicability.frameworks, [{ name: 'Svelte' }, { name: 'SvelteKit' }]);

    await refreshSkillSnapshot(database, snapshot, documents, svelteRequirement, '2026-08-25T02:00:00.000Z');
    assert.equal(database.prepare('SELECT entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_revision: number }>(first.skillId)?.entry_revision, changed.entry_revision);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions WHERE entry_id = ?').get<{ count: number }>(changed.entry_id)?.count, 2);
    await refreshSkillSnapshot(database, snapshot, documents, requirement, '2026-08-25T03:00:00.000Z');
    assert.equal(database.prepare('SELECT entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_revision: number }>(first.skillId)?.entry_revision, changed.entry_revision);
    assert.ok(externalSkillRequirement(database, first.skillId)?.aliases.includes('svelte'));
    assert.ok(externalSkillRequirement(database, first.skillId)?.aliases.includes('sveltekit'));
  } finally {
    database.close();
  }
});

test('persists non-ASCII requirement identities in locale-independent UTF-16 order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-canonical-order-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Canonical ordering reference.');
    const unicodeRequirement: SkillRequirement = {
      ...requirement,
      id: 'é',
      technology: 'é',
      aliases: ['ä', 'z', 'Å'],
    };
    const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), unicodeRequirement, '2026-08-25T00:00:00.000Z');
    const stored = readExternalSkill(database, imported.skillId)!.skill;
    assert.deepEqual(stored.metadata.requirementAliases, ['z', 'Å', 'ä', 'é']);
    assert.deepEqual(externalSkillRequirement(database, imported.skillId)?.aliases, ['z', 'Å', 'ä', 'é']);
  } finally {
    database.close();
  }
});

test('keeps identical chunks in separate entries and updates only the changed mapping', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-chunk-identity-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const firstSnapshot = importedSnapshot('Reference shared by two chunks.');
    const firstDocument = chunkSkillMarkdown({ skillName: firstSnapshot.frontmatter.name, sourcePath: firstSnapshot.files[0]!.path, markdown: firstSnapshot.files[0]!.content, summary: firstSnapshot.frontmatter.description, stripFrontmatter: true })[0]!;
    const firstDocuments = [
      { ...firstDocument, chunkIndex: 0, primary: true },
      { ...firstDocument, chunkIndex: 1, primary: false },
    ];
    const first = await persistAuditedSkillImport(database, { skill: firstSnapshot.candidate, sourceWorkspace: externalSkillWorkspace(firstSnapshot.candidate), sourceCommit: firstSnapshot.sourceCommit, snapshotHash: firstSnapshot.snapshotHash, frontmatter: firstSnapshot.frontmatter, documents: firstDocuments, requirement }, '2026-08-25T00:00:00.000Z');
    const initialMappings = database.prepare('SELECT source_path, chunk_index, entry_id, entry_revision, content_hash FROM external_skill_entries WHERE skill_id = ? ORDER BY chunk_index').all<{ source_path: string; chunk_index: number; entry_id: string; entry_revision: number; content_hash: string }>(first.skillId);
    assert.equal(initialMappings.length, 2);
    assert.notEqual(initialMappings[0]?.entry_id, initialMappings[1]?.entry_id);
    for (const mapping of initialMappings) {
      const entry = readEntry(database, { workspace: first.sourceWorkspace, entryId: mapping.entry_id });
      assert.equal(mapping.content_hash, entry.contentHash);
    }

    const changedSnapshot = importedSnapshot('Reference changed in the first chunk.');
    const changedDocument = chunkSkillMarkdown({ skillName: changedSnapshot.frontmatter.name, sourcePath: changedSnapshot.files[0]!.path, markdown: changedSnapshot.files[0]!.content, summary: changedSnapshot.frontmatter.description, stripFrontmatter: true })[0]!;
    const changedDocuments = [
      { ...changedDocument, chunkIndex: 0, primary: true },
      { ...firstDocument, chunkIndex: 1, primary: false },
    ];
    const current = readExternalSkill(database, first.skillId)!.skill;
    const changed = await persistAuditedPreparedSkillRefresh(database, { skill: changedSnapshot.candidate, sourceWorkspace: externalSkillWorkspace(changedSnapshot.candidate), sourceCommit: changedSnapshot.sourceCommit, snapshotHash: changedSnapshot.snapshotHash, frontmatter: changedSnapshot.frontmatter, documents: changedDocuments, requirement }, refreshExpectation(current), '2026-08-25T01:00:00.000Z');
    const updatedMappings = database.prepare('SELECT source_path, chunk_index, entry_id, entry_revision, content_hash FROM external_skill_entries WHERE skill_id = ? ORDER BY chunk_index').all<{ source_path: string; chunk_index: number; entry_id: string; entry_revision: number; content_hash: string }>(first.skillId);
    assert.equal(changed.updated, true);
    assert.equal(updatedMappings[0]?.entry_id, initialMappings[0]?.entry_id);
    assert.equal(updatedMappings[1]?.entry_id, initialMappings[1]?.entry_id);
    assert.equal(updatedMappings[0]?.entry_revision, (initialMappings[0]?.entry_revision ?? 0) + 1);
    assert.equal(updatedMappings[1]?.entry_revision, initialMappings[1]?.entry_revision);
    assert.match(readEntry(database, { workspace: first.sourceWorkspace, entryId: updatedMappings[0]!.entry_id }).body, /changed in the first/u);
    assert.match(readEntry(database, { workspace: first.sourceWorkspace, entryId: updatedMappings[1]!.entry_id }).body, /shared by two chunks/u);
    for (const mapping of updatedMappings) {
      const entry = readEntry(database, { workspace: first.sourceWorkspace, entryId: mapping.entry_id });
      assert.equal(mapping.content_hash, entry.contentHash);
    }
    const revisionCount = database.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count;
    const reimportedRecord = readExternalSkill(database, first.skillId)!.skill;
    const reimported = await persistAuditedPreparedSkillRefresh(database, { skill: changedSnapshot.candidate, sourceWorkspace: externalSkillWorkspace(changedSnapshot.candidate), sourceCommit: changedSnapshot.sourceCommit, snapshotHash: changedSnapshot.snapshotHash, frontmatter: changedSnapshot.frontmatter, documents: changedDocuments, requirement }, refreshExpectation(reimportedRecord), '2026-08-25T02:00:00.000Z');
    assert.equal(reimported.updated, false);
    assert.equal(reimported.imported, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count, revisionCount);
  } finally {
    database.close();
  }
});

test('rolls back instead of mapping an exact-content entry with elevated trust', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-trust-collision-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const now = '2026-08-25T00:00:00.000Z';
    const snapshot = importedSnapshot('Collision reference.');
    const document = documentsFromSkillSnapshot(snapshot)[0]!;
    const workspace = externalSkillWorkspace(candidate);
    const scope = buildStructuredScope({ visibility: 'project', retrievalScope: 'ecosystem', memoryClass: 'reference', applicability: requirement.applicability, signals: requirement.signals });
    const provenance = {
      type: 'external_skill',
      reference: `https://github.com/owner/repo/blob/${COMMIT_A}/skills/sveltekit-helper/SKILL.md`,
      externalSkillId: 'github:owner/repo:sveltekit-helper',
      requirementScopeHash: canonicalContentHash({
        technology: requirement.technology,
        identities: ['svelte', 'sveltekit'],
        applicability: requirement.applicability,
        signals: requirement.signals,
      }),
      sourceRepositoryId: 'github:owner/repo',
      sourceWorkspace: workspace,
      sourceCommit: COMMIT_A,
      sourcePath: 'skills/sveltekit-helper/SKILL.md',
      sourceChunkIndex: 0,
      timestamp: now,
    };
    const tags = ['external:skill', 'provider:fixture', 'source:owner/repo', 'skill:sveltekit-helper', 'official:catalog-verified', 'technology:sveltekit']
      .sort();
    const attacker = recordEntry(database, {
      workspace,
      kind: 'reference',
      status: 'verified',
      title: document.title,
      body: document.body,
      summary: document.summary,
      scope,
      provenance,
      trustLevel: 'source_verified',
      confidence: 0.7,
      tags,
      createdBy: 'attacker',
      actor: 'attacker',
    }, { now });

    await assert.rejects(
      () => importAuditedSkillSnapshot(database, snapshot, [document], requirement, now),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && /different record metadata/iu.test((error as Error).message),
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
    const unchanged = readEntry(database, { workspace, entryId: attacker.id });
    assert.equal(unchanged.status, 'verified');
    assert.equal(unchanged.trustLevel, 'source_verified');
    assert.equal(unchanged.createdBy, 'attacker');
  } finally {
    database.close();
  }
});

test('fails replay, refresh, and activation when a mapped entry lifecycle is elevated', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-mapped-trust-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Managed reference.');
    const documents = documentsFromSkillSnapshot(snapshot);
    const imported = await importAuditedSkillSnapshot(database, snapshot, documents, requirement, '2026-08-25T00:00:00.000Z');
    const importedRecord = readExternalSkill(database, imported.skillId)!.skill;
    const mapping = database.prepare('SELECT entry_id FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string }>(imported.skillId)!;
    database.prepare("UPDATE entries SET status = 'verified', trust_level = 'source_verified', created_by = 'attacker', verified_at = ? WHERE id = ?")
      .run('2026-08-25T00:30:00.000Z', mapping.entry_id);

    await assert.rejects(
      () => refreshSkillSnapshot(database, snapshot, documents, requirement, '2026-08-25T01:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    const changed = importedSnapshot('Changed managed reference.');
    const expectation = {
      generation: importedRecord.generation,
      sourceCommit: snapshot.sourceCommit,
      snapshotHash: snapshot.snapshotHash,
      state: 'imported',
      lastCheckedAt: '2026-08-25T00:00:00.000Z',
    };
    await assert.rejects(
      () => refreshAuditedExternalSkillSnapshot(database, imported.skillId, changed, documentsFromSkillSnapshot(changed), requirement, expectation, '2026-08-25T02:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.equal(database.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 1);
  } finally {
    database.close();
  }

  const activationDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-activation-trust-'));
  const activationDatabase = openConnection(path.join(activationDirectory, 'data.sqlite3'));
  migrateDatabase(activationDatabase);
  try {
    const snapshot = importedSnapshot('Disabled managed reference.');
    const imported = await importAuditedSkillSnapshot(activationDatabase, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    setExternalSkillState(activationDatabase, imported.skillId, 'disabled', '2026-08-25T01:00:00.000Z');
    const mapping = activationDatabase.prepare('SELECT entry_id FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string }>(imported.skillId)!;
    activationDatabase.prepare("UPDATE entries SET status = 'verified', trust_level = 'source_verified', created_by = 'attacker', verified_at = ? WHERE id = ?")
      .run('2026-08-25T01:30:00.000Z', mapping.entry_id);
    assert.throws(
      () => setExternalSkillState(activationDatabase, imported.skillId, 'imported', '2026-08-25T02:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.equal(activationDatabase.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 0);
    assert.equal(activationDatabase.prepare('SELECT state FROM external_skills WHERE skill_id = ?').get<{ state: string }>(imported.skillId)?.state, 'disabled');
  } finally {
    activationDatabase.close();
  }
});

test('rejects every corrupt current-mapping shape on exact replay', async () => {
  const mutations: Array<{ name: string; apply: (database: ReturnType<typeof openConnection>, skillId: string) => void }> = [
    { name: 'zero mappings', apply: (database, skillId) => { database.prepare('DELETE FROM external_skill_entries WHERE skill_id = ?').run(skillId); } },
    { name: 'inactive current mapping', apply: (database, skillId) => { database.prepare('UPDATE external_skill_entries SET active = 0 WHERE skill_id = ?').run(skillId); } },
    { name: 'stale entry revision', apply: (database, skillId) => {
      const mapping = database.prepare('SELECT entry_id FROM external_skill_entries WHERE skill_id = ? AND primary_document = 1').get<{ entry_id: string }>(skillId)!;
      database.prepare(`
        INSERT INTO entry_revisions (
          entry_id, workspace, revision, kind, title, body, summary,
          scope_json, provenance_json, content_hash, created_by, created_at
        )
        SELECT entry_id, workspace, 2, kind, title, body, summary,
               scope_json, provenance_json, ?, 'attacker', created_at
          FROM entry_revisions
         WHERE entry_id = ? AND revision = 1
      `).run('1'.repeat(64), mapping.entry_id);
      database.prepare('UPDATE external_skill_entries SET entry_revision = 2, content_hash = ? WHERE skill_id = ? AND primary_document = 1').run('1'.repeat(64), skillId);
    } },
    { name: 'revision hash mismatch', apply: (database, skillId) => { database.prepare('UPDATE external_skill_entries SET content_hash = ? WHERE skill_id = ? AND primary_document = 1').run('0'.repeat(64), skillId); } },
    { name: 'no primary', apply: (database, skillId) => { database.prepare('UPDATE external_skill_entries SET primary_document = 0 WHERE skill_id = ?').run(skillId); } },
    { name: 'multiple primaries', apply: (database, skillId) => { database.prepare('UPDATE external_skill_entries SET primary_document = 1 WHERE skill_id = ?').run(skillId); } },
  ];
  for (const mutation of mutations) {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-corrupt-mapping-'));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    try {
      const snapshot = validateSkillSnapshot({ candidate, sourceCommit: COMMIT_A, files: [
        { path: 'skills/sveltekit-helper/SKILL.md', content: '---\nname: SvelteKit Helper\ndescription: safe\n---\n# Main\n\nReference.', primary: true },
        { path: 'skills/sveltekit-helper/references/extra.md', content: '# Extra\n\nReference.', primary: false },
      ] });
      const documents = documentsFromSkillSnapshot(snapshot);
      const imported = await importAuditedSkillSnapshot(database, snapshot, documents, requirement, '2026-08-25T00:00:00.000Z');
      mutation.apply(database, imported.skillId);
      await assert.rejects(
        () => refreshSkillSnapshot(database, snapshot, documents, requirement, '2026-08-25T01:00:00.000Z'),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
        mutation.name,
      );
      assert.equal(database.prepare('SELECT state FROM external_skills WHERE skill_id = ?').get<{ state: string }>(imported.skillId)?.state, 'imported');
    } finally {
      database.close();
    }
  }
});

test('requires complete, valid materialized metadata without compatibility reconstruction', async () => {
  const corruptions: Array<{ name: string; apply: (metadata: Record<string, unknown>) => void }> = [
    ...['documents', 'frontmatter', 'auditStatus', 'technology', 'requirementAliases', 'applicability', 'signals', 'currentMappings', 'officialStatus'].map((field) => ({
      name: `missing ${field}`,
      apply: (metadata: Record<string, unknown>) => { delete metadata[field]; },
    })),
    { name: 'invalid auditStatus', apply: (metadata) => { metadata.auditStatus = 'trusted'; } },
    { name: 'invalid technology', apply: (metadata) => { metadata.technology = ''; } },
    { name: 'invalid requirementAliases', apply: (metadata) => { metadata.requirementAliases = []; } },
    { name: 'invalid applicability', apply: (metadata) => { metadata.applicability = []; } },
    { name: 'invalid signals', apply: (metadata) => { metadata.signals = []; } },
    { name: 'invalid currentMappings', apply: (metadata) => { metadata.currentMappings = []; } },
    { name: 'documents mismatch', apply: (metadata) => { metadata.documents = 64; } },
    { name: 'invalid frontmatter name', apply: (metadata) => { (metadata.frontmatter as Record<string, unknown>).name = 'SvelteKit\uFFFDHelper'; } },
    { name: 'unknown frontmatter field', apply: (metadata) => { (metadata.frontmatter as Record<string, unknown>).legacy = true; } },
    { name: 'unknown metadata field', apply: (metadata) => { metadata.legacyFallback = true; } },
    { name: 'format-control technology', apply: (metadata) => { metadata.technology = 'svelte\u202Ekit'; } },
    { name: 'officialStatus mismatch', apply: (metadata) => { metadata.officialStatus = 'unknown'; } },
  ];
  for (const corruption of corruptions) {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-corrupt-metadata-'));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    try {
      const snapshot = importedSnapshot('Metadata reference.');
      const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
      const stored = database.prepare('SELECT metadata_json FROM external_skills WHERE skill_id = ?').get<{ metadata_json: string }>(imported.skillId)!;
      const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
      corruption.apply(metadata);
      database.prepare('UPDATE external_skills SET metadata_json = ? WHERE skill_id = ?').run(JSON.stringify(metadata), imported.skillId);
      assert.throws(
        () => listExternalSkills(database),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
        corruption.name,
      );
    } finally {
      database.close();
    }
  }
});

test('rejects noncanonical or serializer-invalid materialized metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-noncanonical-metadata-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Metadata reference.');
    const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    const stored = database.prepare('SELECT metadata_json FROM external_skills WHERE skill_id = ?').get<{ metadata_json: string }>(imported.skillId)!;
    const corruptions = [
      ` ${stored.metadata_json}`,
      `${'{"nested":'.repeat(129)}null${'}'.repeat(129)}`,
      '{"technology":"\\ud800"}',
    ];
    for (const corruption of corruptions) {
      database.prepare('UPDATE external_skills SET metadata_json = ? WHERE skill_id = ?').run(corruption, imported.skillId);
      assert.throws(() => readExternalSkill(database, imported.skillId), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
      assert.equal(database.prepare('SELECT metadata_json FROM external_skills WHERE skill_id = ?').get<{ metadata_json: string }>(imported.skillId)?.metadata_json, corruption);
    }
  } finally {
    database.close();
  }
});

test('recording a discovered candidate cannot renew a materialized source check', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-discovery-freshness-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Freshness reference.');
    const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    const recorded = recordDiscoveredSkill(database, snapshot.candidate, '2026-08-25T05:00:00.000Z');
    assert.equal(recorded.skillId, imported.skillId);
    assert.equal(recorded.lastSeenAt, '2026-08-25T05:00:00.000Z');
    assert.equal(recorded.lastCheckedAt, '2026-08-25T00:00:00.000Z');
    assert.equal(recorded.state, 'imported');
  } finally {
    database.close();
  }
});

test('keeps materialized candidate fields stable until a renamed snapshot commits atomically', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-rename-refresh-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const original = importedSnapshot('Original named reference.');
    const imported = await importAuditedSkillSnapshot(database, original, documentsFromSkillSnapshot(original), requirement, '2026-08-25T00:00:00.000Z');
    const renamed = validateSkillSnapshot({
      candidate: { ...candidate, name: 'Renamed SvelteKit Helper', installs: 99 },
      sourceCommit: COMMIT_B,
      files: [{
        path: 'skills/sveltekit-helper/SKILL.md',
        content: '---\nname: Renamed SvelteKit Helper\ndescription: safe\n---\n# Renamed helper\n\nRenamed reference.',
        primary: true,
      }],
    });

    const observed = recordDiscoveredSkill(database, renamed.candidate, '2026-08-25T01:00:00.000Z');
    assert.equal(observed.skillId, imported.skillId);
    assert.equal(observed.name, original.frontmatter.name);
    assert.equal(observed.installs, original.candidate.installs);
    assert.equal((observed.metadata.frontmatter as { name: string }).name, original.frontmatter.name);

    const outcome = await refreshAuditedExternalSkillSnapshot(
      database,
      imported.skillId,
      renamed,
      documentsFromSkillSnapshot(renamed),
      requirement,
      refreshExpectation(observed),
      '2026-08-25T02:00:00.000Z',
    );
    assert.equal(outcome.kind, 'refreshed');
    const stored = readExternalSkill(database, imported.skillId)!.skill;
    assert.equal(stored.name, 'Renamed SvelteKit Helper');
    assert.equal(stored.installs, 99);
    assert.equal((stored.metadata.frontmatter as { name: string }).name, 'Renamed SvelteKit Helper');
  } finally {
    database.close();
  }
});

test('rejects an unscoped community import before writing unreachable data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-unscoped-metadata-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const communityCandidate = { ...candidate, officialStatus: 'registry-only' as const, auditStatus: 'passed' as const };
    const snapshot = importedSnapshot('Unscoped reference.', communityCandidate);
    const documents = documentsFromSkillSnapshot(snapshot);
    await assert.rejects(
      () => importAuditedSkillSnapshot(database, snapshot, documents, undefined, '2026-08-25T00:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && /applicability/iu.test((error as Error).message),
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects a signals-only requirement without explicit applicability', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-signals-only-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const signalsOnly: SkillRequirement = {
      ...requirement,
      id: 'svelte-package',
      technology: 'svelte-package',
      aliases: ['svelte-package'],
      queries: ['svelte package'],
      applicability: {},
      signals: { packages: ['svelte'] },
    };
    const snapshot = importedSnapshot('Signals-only reference.');
    const documents = documentsFromSkillSnapshot(snapshot);
    await assert.rejects(
      () => importAuditedSkillSnapshot(database, snapshot, documents, signalsOnly, '2026-08-25T00:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && /applicability/iu.test((error as Error).message),
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects metadata on an unmaterialized discovery row instead of preserving a legacy shape', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-unmaterialized-metadata-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const discovered = recordDiscoveredSkill(database, candidate, '2026-08-25T00:00:00.000Z');
    database.prepare('UPDATE external_skills SET metadata_json = ? WHERE skill_id = ?').run(JSON.stringify({ legacy: true }), discovered.skillId);
    assert.throws(
      () => listExternalSkills(database),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.equal(database.prepare('SELECT metadata_json FROM external_skills WHERE skill_id = ?').get<{ metadata_json: string }>(discovered.skillId)?.metadata_json, '{"legacy":true}');
  } finally {
    database.close();
  }
});

test('validates every unmaterialized row with the canonical candidate validator', async () => {
  const corruptions = [
    { name: 'noncanonical provider', column: 'provider', value: '.' },
    { name: 'noncanonical name', column: 'name', value: ' padded-name ' },
  ] as const;
  for (const corruption of corruptions) {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-unmaterialized-candidate-'));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    try {
      const unmaterialized: SkillCandidate = { ...candidate, officialStatus: 'registry-only' };
      delete unmaterialized.auditStatus;
      const discovered = recordDiscoveredSkill(database, unmaterialized, '2026-08-25T00:00:00.000Z');
      assert.equal(discovered.auditStatus, 'unavailable');
      database.prepare(`UPDATE external_skills SET ${corruption.column} = ? WHERE skill_id = ?`).run(corruption.value, discovered.skillId);
      assert.throws(
        () => listExternalSkills(database),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
        corruption.name,
      );
    } finally {
      database.close();
    }
  }
});

test('rejects noncanonical or contradictory external-skill lifecycle timestamps', async () => {
  const corruptions: Array<{ name: string; sql: string; parameters: string[] }> = [
    { name: 'invalid first seen', sql: 'UPDATE external_skills SET first_seen_at = ?', parameters: ['not-a-time'] },
    { name: 'invalid last seen', sql: 'UPDATE external_skills SET last_seen_at = ?', parameters: ['2026-08-25'] },
    { name: 'invalid last checked', sql: 'UPDATE external_skills SET last_checked_at = ?', parameters: ['2026-08-25T00:00:00Z'] },
    { name: 'first seen after last seen', sql: 'UPDATE external_skills SET first_seen_at = ?, last_seen_at = ?', parameters: ['2026-08-25T02:00:00.000Z', '2026-08-25T01:00:00.000Z'] },
    { name: 'first seen after last checked', sql: 'UPDATE external_skills SET first_seen_at = ?, last_seen_at = ?, last_checked_at = ?', parameters: ['2026-08-25T02:00:00.000Z', '2026-08-25T03:00:00.000Z', '2026-08-25T01:00:00.000Z'] },
    { name: 'invalid disabled time', sql: "UPDATE external_skills SET state = 'disabled', disabled_at = ?", parameters: ['not-a-time'] },
    { name: 'imported row with disabled time', sql: 'UPDATE external_skills SET disabled_at = ?', parameters: ['2026-08-25T01:00:00.000Z'] },
  ];
  for (const corruption of corruptions) {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-lifecycle-time-'));
    const database = openConnection(path.join(directory, 'data.sqlite3'));
    migrateDatabase(database);
    try {
      const snapshot = importedSnapshot('Timestamp reference.');
      const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
      database.prepare(corruption.sql).run(...corruption.parameters);
      assert.throws(
        () => listExternalSkills(database),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
        corruption.name,
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills WHERE skill_id = ?').get<{ count: number }>(imported.skillId)?.count, 1);
    } finally {
      database.close();
    }
  }
});

test('refreshes a disabled snapshot while keeping every mapping inactive', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-disabled-refresh-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const firstSnapshot = importedSnapshot('Reference one.');
    const first = await importAuditedSkillSnapshot(database, firstSnapshot, documentsFromSkillSnapshot(firstSnapshot), requirement, '2026-08-25T00:00:00.000Z');
    const firstMapping = database.prepare('SELECT entry_id, entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number }>(first.skillId)!;
    setExternalSkillState(database, first.skillId, 'disabled', '2026-08-25T01:00:00.000Z');

    const replay = await refreshSkillSnapshot(database, firstSnapshot, documentsFromSkillSnapshot(firstSnapshot), undefined, '2026-08-25T01:30:00.000Z');
    const replayedMapping = database.prepare('SELECT entry_id, entry_revision, active FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number; active: number }>(first.skillId)!;
    assert.equal(replay.updated, false);
    assert.equal(listExternalSkills(database)[0]?.state, 'disabled');
    assert.equal(replayedMapping.active, 0);
    assert.equal(replayedMapping.entry_id, firstMapping.entry_id);
    assert.equal(replayedMapping.entry_revision, firstMapping.entry_revision);

    const changedSnapshot = importedSnapshot('Reference refreshed while disabled.');
    const changed = await refreshSkillSnapshot(database, changedSnapshot, documentsFromSkillSnapshot(changedSnapshot), undefined, '2026-08-25T02:00:00.000Z');
    const mapping = database.prepare('SELECT entry_id, entry_revision, active FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number; active: number }>(first.skillId)!;
    assert.equal(changed.updated, true);
    assert.equal(listExternalSkills(database)[0]?.state, 'disabled');
    assert.equal(mapping.active, 0);
    assert.equal(mapping.entry_id, firstMapping.entry_id);
    assert.equal(mapping.entry_revision, firstMapping.entry_revision + 1);
    assert.match(readEntry(database, { workspace: externalSkillWorkspace(candidate), entryId: mapping.entry_id }).body, /refreshed while disabled/u);
  } finally {
    database.close();
  }
});

test('fails closed when the current mapping metadata is missing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-mapping-integrity-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Reference one.');
    const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T01:00:00.000Z');
    database.prepare("UPDATE external_skills SET metadata_json = '{}' WHERE skill_id = ?").run(imported.skillId);

    assert.throws(
      () => setExternalSkillState(database, imported.skillId, 'imported', '2026-08-25T02:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /metadata/iu.test((error as Error).message),
    );
    assert.equal(database.prepare('SELECT state FROM external_skills WHERE skill_id = ?').get<{ state: string }>(imported.skillId)?.state, 'disabled');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects an out-of-order refresh that was fetched from an older snapshot generation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-refresh-race-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const initial = importedSnapshot('Initial reference.');
    const imported = await importAuditedSkillSnapshot(database, initial, documentsFromSkillSnapshot(initial), requirement, '2026-08-25T00:00:00.000Z');
    const initialRecord = readExternalSkill(database, imported.skillId)!.skill;
    const expected = refreshExpectation(initialRecord);
    const newer = validateSkillSnapshot({
      candidate,
      sourceCommit: COMMIT_C,
      files: [{ path: 'skills/sveltekit-helper/SKILL.md', content: '---\nname: SvelteKit Helper\ndescription: safe\n---\n# SvelteKit\n\nNewest response.', primary: true }],
    });
    const older = validateSkillSnapshot({
      candidate,
      sourceCommit: COMMIT_B,
      files: [{ path: 'skills/sveltekit-helper/SKILL.md', content: '---\nname: SvelteKit Helper\ndescription: safe\n---\n# SvelteKit\n\nOlder in-flight response.', primary: true }],
    });

    await refreshAuditedExternalSkillSnapshot(database, imported.skillId, newer, documentsFromSkillSnapshot(newer), requirement, expected, '2026-08-25T01:00:00.000Z');
    await assert.rejects(
      () => refreshAuditedExternalSkillSnapshot(database, imported.skillId, older, documentsFromSkillSnapshot(older), requirement, expected, '2026-08-25T02:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && /snapshot changed during refresh/iu.test((error as Error).message),
    );
    assert.throws(
      () => markExternalSkillRefreshFailure(database, imported.skillId, 'stale', expected, '2026-08-25T03:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && /snapshot changed during refresh/iu.test((error as Error).message),
    );

    const current = readExternalSkill(database, imported.skillId)!;
    assert.equal(current.skill.sourceCommit, COMMIT_C);
    const active = current.entries.find((entry) => entry.active);
    assert.ok(active);
    assert.match(readEntry(database, { workspace: current.skill.sourceWorkspace, entryId: active.entryId }).body, /Newest response/u);

    const currentExpectation = {
      generation: current.skill.generation,
      sourceCommit: current.skill.sourceCommit,
      snapshotHash: current.skill.snapshotHash,
      state: current.skill.state,
      lastCheckedAt: current.skill.lastCheckedAt,
    };
    markExternalSkillRefreshFailure(database, imported.skillId, 'blocked', currentExpectation, '2026-08-25T03:00:00.000Z');
    await assert.rejects(
      () => refreshAuditedExternalSkillSnapshot(database, imported.skillId, older, documentsFromSkillSnapshot(older), requirement, currentExpectation, '2026-08-25T04:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && /snapshot changed during refresh/iu.test((error as Error).message),
    );
    const blocked = readExternalSkill(database, imported.skillId)!;
    assert.equal(blocked.skill.state, 'blocked');
    assert.equal(blocked.skill.sourceCommit, COMMIT_C);
    assert.equal(blocked.entries.some((entry) => entry.active), false);
    assert.match(readEntry(database, { workspace: blocked.skill.sourceWorkspace, entryId: active.entryId }).body, /Newest response/u);
  } finally {
    database.close();
  }
});

test('rejects a stale expectation after state returns to the same visible snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-generation-aba-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('ABA reference.');
    const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    const original = readExternalSkill(database, imported.skillId)!.skill;
    const staleExpectation = refreshExpectation(original);
    setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T01:00:00.000Z');
    const restored = setExternalSkillState(database, imported.skillId, 'imported', '2026-08-25T02:00:00.000Z');
    assert.equal(restored.sourceCommit, original.sourceCommit);
    assert.equal(restored.snapshotHash, original.snapshotHash);
    assert.equal(restored.state, original.state);
    assert.equal(restored.lastCheckedAt, original.lastCheckedAt);
    assert.ok(restored.generation > original.generation);
    assert.throws(
      () => markExternalSkillRefreshFailure(database, imported.skillId, 'stale', staleExpectation, '2026-08-25T03:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
  } finally {
    database.close();
  }
});

test('never reuses a deleted alias generation after an identical recreation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-generation-reinsert-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Canonical reference.');
    const canonical = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    const aliasCandidate = { ...candidate, provider: 'alias-provider', id: 'alias-provider:owner/repo:legacy-alias', slug: 'legacy-alias', name: 'legacy-alias' };
    const alias = recordDiscoveredSkill(database, aliasCandidate, '2026-08-25T00:30:00.000Z');
    const staleAlias = transitionRefreshFailure(database, alias.skillId, 'stale', '2026-08-25T01:00:00.000Z');
    const canonicalRow = readExternalSkill(database, canonical.skillId)!.skill;
    await persistAuditedExistingSkillImport(database, alias.skillId, {
      skill: snapshot.candidate,
      sourceWorkspace: externalSkillWorkspace(snapshot.candidate),
      sourceCommit: snapshot.sourceCommit,
      snapshotHash: snapshot.snapshotHash,
      frontmatter: snapshot.frontmatter,
      documents: documentsFromSkillSnapshot(snapshot),
      requirement,
    }, refreshExpectation(staleAlias), '2026-08-25T02:00:00.000Z', { skillId: canonicalRow.skillId, expected: refreshExpectation(canonicalRow) });
    const replacement = recordDiscoveredSkill(database, aliasCandidate, '2026-08-25T00:30:00.000Z');
    const replacementStale = markExternalSkillRefreshFailure(database, replacement.skillId, 'stale', refreshExpectation(replacement), '2026-08-25T01:00:00.000Z');
    assert.equal(replacementStale.state, staleAlias.state);
    assert.equal(replacementStale.lastCheckedAt, staleAlias.lastCheckedAt);
    assert.ok(replacementStale.generation > staleAlias.generation);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM external_skill_generation_tokens WHERE generation = ?').get<{ count: number }>(staleAlias.generation)?.count,
      0,
      'obsolete row tokens must be pruned while sqlite_sequence retains the high-water mark',
    );
    assert.throws(
      () => markExternalSkillRefreshFailure(database, replacement.skillId, 'stale', refreshExpectation(staleAlias), '2026-08-25T03:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
  } finally {
    database.close();
  }
});

test('bounds generation tokens to live skills across repeated candidate upserts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-generation-bound-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    for (let index = 0; index < 100; index += 1) {
      recordDiscoveredSkill(database, { ...candidate, installs: index }, new Date(Date.UTC(2026, 7, 25, 0, 0, index)).toISOString());
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_generation_tokens').get<{ count: number }>()?.count, 1);
    const clock = database.prepare('SELECT value FROM external_skill_generation_clock WHERE singleton = 1').get<{ value: number }>()!.value;
    const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'external_skill_generation_tokens'").get<{ seq: number }>()!.seq;
    assert.equal(clock, 100);
    assert.equal(sequence, clock);
    assert.equal(listExternalSkills(database)[0]?.generation, clock);
  } finally {
    database.close();
  }
});

test('fails closed when the durable generation clock is rewound', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-generation-rewind-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Clock reference.');
    await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    const maximum = database.prepare('SELECT MAX(generation) AS value FROM external_skills').get<{ value: number }>()!.value;
    database.prepare('UPDATE external_skill_generation_clock SET value = ? WHERE singleton = 1').run(maximum - 1);
    assert.throws(
      () => listExternalSkills(database),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /generation allocator/iu.test((error as Error).message),
    );
  } finally {
    database.close();
  }
});

test('pages a strict external-skill snapshot and rejects unbound or stale anchors', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-list-page-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const first = recordDiscoveredSkill(database, { ...candidate, source: 'alpha/repo', slug: 'alpha', name: 'alpha', installUrl: 'https://github.com/alpha/repo' }, '2026-08-25T00:00:00.000Z');
    const second = recordDiscoveredSkill(database, { ...candidate, source: 'beta/repo', slug: 'beta', name: 'beta', installUrl: 'https://github.com/beta/repo' }, '2026-08-25T00:00:01.000Z');
    const page = listExternalSkillsPage(database, { limit: 1 });
    assert.equal(page.skills[0]?.skillId, first.skillId);
    assert.equal(page.version, externalSkillListVersion(database));
    assert.equal(page.truncated, true);
    const anchor = { sourceLocator: first.sourceLocator, slug: first.slug, provider: first.provider, skillId: first.skillId };
    const continuation = listExternalSkillsPage(database, { limit: 1, after: anchor, expectedVersion: page.version });
    assert.equal(continuation.skills[0]?.skillId, second.skillId);
    assert.equal(continuation.truncated, false);
    assert.throws(() => listExternalSkillsPage(database, { limit: 1, expectedVersion: page.version }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    assert.throws(() => listExternalSkillsPage(database, { limit: 1, after: anchor }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    assert.throws(
      () => listExternalSkillsPage(database, { limit: 1, after: { ...anchor, provider: 'forged' }, expectedVersion: page.version }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    assert.throws(
      () => listExternalSkillsPage(database, { state: 'stale', limit: 1, after: anchor, expectedVersion: page.version }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    markExternalSkillRefreshFailure(database, second.skillId, 'stale', refreshExpectation(second), '2026-08-25T00:00:02.000Z');
    assert.throws(
      () => listExternalSkillsPage(database, { limit: 1, after: anchor, expectedVersion: page.version }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
      'a non-anchor mutation invalidates the entire list snapshot',
    );
  } finally {
    database.close();
  }
});

test('materializes only exact catalog identities or freshly passed audited candidates', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-materialization-trust-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    for (const untrusted of [
      { officialStatus: 'registry-only' as const, auditStatus: 'failed' as const },
      { officialStatus: 'registry-only' as const, auditStatus: 'unavailable' as const },
      { officialStatus: 'owner-verified' as const, auditStatus: 'not-required' as const },
      { officialStatus: 'curated' as const, auditStatus: 'not-required' as const },
      { officialStatus: 'catalog-verified' as const, auditStatus: 'not-required' as const },
      { officialStatus: 'registry-only' as const, auditStatus: 'passed' as const },
    ]) {
      const forged = importedSnapshot('Rejected trust reference.', { ...candidate, ...untrusted });
      assert.throws(
        () => importSkillSnapshot(database, forged, documentsFromSkillSnapshot(forged), requirement, '2026-08-25T00:00:00.000Z'),
        (error: unknown) => (error as { code?: string }).code === 'SECURITY_REJECTION',
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    }
    const { auditStatus: forgedAuditLabel, ...candidateWithoutAuditLabel } = candidate;
    assert.equal(forgedAuditLabel, 'passed');
    const audited = importedSnapshot('Passed audit reference.', { ...candidateWithoutAuditLabel, officialStatus: 'registry-only' });
    assert.equal(Object.prototype.hasOwnProperty.call(audited.candidate, 'auditStatus'), false);
    assert.equal(audited.candidate.auditStatus, undefined);
    await importAuditedSkillSnapshot(database, audited, documentsFromSkillSnapshot(audited), requirement, '2026-08-25T01:00:00.000Z');
    const row = readExternalSkill(database, listExternalSkills(database)[0]!.skillId)!.skill;
    assert.equal(row.auditStatus, 'passed');
    assert.equal(row.metadata.auditStatus, 'passed');
    const metadata = { ...row.metadata, auditStatus: 'failed' };
    database.prepare('UPDATE external_skills SET metadata_json = ? WHERE skill_id = ?').run(JSON.stringify(metadata), row.skillId);
    assert.throws(() => readExternalSkill(database, row.skillId), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
  } finally {
    database.close();
  }
});

test('rejects malformed inactive historical mappings on read', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-inactive-mapping-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const first = validateSkillSnapshot({ candidate, sourceCommit: COMMIT_A, files: [
      { path: 'skills/sveltekit-helper/SKILL.md', content: '---\nname: SvelteKit Helper\n---\n# Main\n\nReference.', primary: true },
      { path: 'skills/sveltekit-helper/references/old.md', content: '# Old\n\nReference.', primary: false },
    ] });
    const imported = await importAuditedSkillSnapshot(database, first, documentsFromSkillSnapshot(first), requirement, '2026-08-25T00:00:00.000Z');
    const second = importedSnapshot('Current reference.');
    await refreshSkillSnapshot(database, second, documentsFromSkillSnapshot(second), requirement, '2026-08-25T01:00:00.000Z');
    database.prepare("UPDATE external_skill_entries SET imported_at = 'not-a-time' WHERE skill_id = ? AND active = 0").run(imported.skillId);
    assert.throws(() => readExternalSkill(database, imported.skillId), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR');
  } finally {
    database.close();
  }
});

test('binds every inactive historical mapping to its canonical parent skill identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-inactive-parent-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const first = validateSkillSnapshot({ candidate, sourceCommit: COMMIT_A, files: [
      { path: 'skills/sveltekit-helper/SKILL.md', content: '---\nname: SvelteKit Helper\ndescription: safe\n---\n# Main\n\nReference.', primary: true },
      { path: 'skills/sveltekit-helper/references/old.md', content: '# Old\n\nHistorical reference.', primary: false },
    ] });
    const imported = await importAuditedSkillSnapshot(database, first, documentsFromSkillSnapshot(first), requirement, '2026-08-25T00:00:00.000Z');
    const second = importedSnapshot('Current reference.');
    await refreshSkillSnapshot(database, second, documentsFromSkillSnapshot(second), requirement, '2026-08-25T01:00:00.000Z');
    const mapping = database.prepare(`
      SELECT entry_id AS entryId, entry_revision AS entryRevision
        FROM external_skill_entries
       WHERE skill_id = ? AND active = 0
    `).get<{ entryId: string; entryRevision: number }>(imported.skillId)!;
    const entry = readEntry(database, { workspace: imported.sourceWorkspace, entryId: mapping.entryId });
    const provenance = { ...entry.provenance, externalSkillId: 'github:attacker/other:forged-skill' };
    const contentHash = canonicalEntryRevisionContentHash({
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      summary: entry.summary,
      scope: entry.scope,
      provenance,
      tags: entry.tags,
    });
    database.exec('DROP TRIGGER entry_revisions_immutable_update');
    database.prepare('UPDATE entry_revisions SET provenance_json = ?, content_hash = ? WHERE entry_id = ? AND revision = ?')
      .run(canonicalJson(provenance), contentHash, mapping.entryId, mapping.entryRevision);
    database.prepare('UPDATE external_skill_entries SET content_hash = ? WHERE skill_id = ? AND entry_id = ?')
      .run(contentHash, imported.skillId, mapping.entryId);
    assert.throws(
      () => readExternalSkill(database, imported.skillId),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /parent identity/iu.test((error as Error).message),
    );
  } finally {
    database.close();
  }
});

test('rejects tampered description and requirement aliases before they can become retrieval authority', async (t) => {
  for (const corruption of [
    { name: 'frontmatter description', mutate: (metadata: Record<string, unknown>) => { (metadata.frontmatter as Record<string, unknown>).description = 'forged summary'; } },
    { name: 'requirement aliases', mutate: (metadata: Record<string, unknown>) => { metadata.requirementAliases = ['forged-alias']; } },
  ]) {
    await t.test(corruption.name, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-derived-metadata-'));
      const database = openConnection(path.join(directory, 'data.sqlite3'));
      migrateDatabase(database);
      try {
        const snapshot = importedSnapshot('Bound metadata reference.');
        const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
        const stored = database.prepare('SELECT metadata_json FROM external_skills WHERE skill_id = ?').get<{ metadata_json: string }>(imported.skillId)!;
        const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
        corruption.mutate(metadata);
        database.prepare('UPDATE external_skills SET metadata_json = ? WHERE skill_id = ?').run(canonicalJson(metadata), imported.skillId);
        assert.throws(
          () => externalSkillRequirement(database, imported.skillId),
          (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
        );
      } finally {
        database.close();
      }
    });
  }
});

test('refresh-failure transition validates before mutation and rolls back post-write corruption', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-refresh-failure-integrity-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Refresh failure integrity reference.');
    const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    const original = readExternalSkill(database, imported.skillId)!.skill;
    const mapping = database.prepare('SELECT entry_id, content_hash, active FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; content_hash: string; active: number }>(imported.skillId)!;
    const originalClock = externalSkillListVersion(database);

    database.prepare('UPDATE external_skill_entries SET content_hash = ? WHERE skill_id = ?').run('0'.repeat(64), imported.skillId);
    assert.throws(
      () => markExternalSkillRefreshFailure(database, imported.skillId, 'stale', refreshExpectation(original), '2026-08-25T01:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.deepEqual(
      { ...database.prepare('SELECT state, generation, last_checked_at FROM external_skills WHERE skill_id = ?').get<Record<string, unknown>>(imported.skillId) },
      { state: original.state, generation: original.generation, last_checked_at: original.lastCheckedAt },
    );
    assert.equal(externalSkillListVersion(database), originalClock);
    database.prepare('UPDATE external_skill_entries SET content_hash = ? WHERE skill_id = ?').run(mapping.content_hash, imported.skillId);

    database.exec(`
      CREATE TRIGGER corrupt_refresh_failure_mapping
      AFTER UPDATE OF state ON external_skills
      BEGIN
        UPDATE external_skill_entries SET content_hash = '${'f'.repeat(64)}' WHERE skill_id = NEW.skill_id;
      END
    `);
    assert.throws(
      () => markExternalSkillRefreshFailure(database, imported.skillId, 'stale', refreshExpectation(original), '2026-08-25T02:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    assert.deepEqual(
      { ...database.prepare('SELECT state, generation, last_checked_at FROM external_skills WHERE skill_id = ?').get<Record<string, unknown>>(imported.skillId) },
      { state: original.state, generation: original.generation, last_checked_at: original.lastCheckedAt },
    );
    assert.deepEqual(
      { ...database.prepare('SELECT entry_id, content_hash, active FROM external_skill_entries WHERE skill_id = ?').get<Record<string, unknown>>(imported.skillId) },
      { ...mapping },
    );
    assert.equal(externalSkillListVersion(database), originalClock);

    database.exec('DROP TRIGGER corrupt_refresh_failure_mapping');
    const stale = markExternalSkillRefreshFailure(database, imported.skillId, 'stale', refreshExpectation(original), '2026-08-25T03:00:00.000Z');
    assert.equal(stale.state, 'stale');
    assert.equal(readExternalSkill(database, imported.skillId)?.entries.every((entry) => !entry.active), true);
  } finally {
    database.close();
  }
});

test('records refresh failures after disable and refuses stale or blocked re-enable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-disabled-failure-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const failureSnapshot = importedSnapshot('Failure reference.');
    const imported = await importAuditedSkillSnapshot(database, failureSnapshot, documentsFromSkillSnapshot(failureSnapshot), requirement, '2026-08-25T00:00:00.000Z');
    setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T01:00:00.000Z');
    transitionRefreshFailure(database, imported.skillId, 'stale', '2026-08-25T02:00:00.000Z');
    assert.equal(listExternalSkills(database)[0]?.state, 'stale');
    assert.equal(database.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 0);
    assert.throws(() => setExternalSkillState(database, imported.skillId, 'imported'), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');

    const recoveredSnapshot = importedSnapshot('Recovered reference.');
    const refreshed = await refreshSkillSnapshot(database, recoveredSnapshot, documentsFromSkillSnapshot(recoveredSnapshot), requirement, '2026-08-25T03:00:00.000Z');
    assert.equal(refreshed.skillId, imported.skillId);
    assert.equal(listExternalSkills(database)[0]?.state, 'disabled');
    assert.equal(database.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 0);
    setExternalSkillState(database, imported.skillId, 'imported', '2026-08-25T04:00:00.000Z');
    assert.equal(database.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 1);

    setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T05:00:00.000Z');
    transitionRefreshFailure(database, imported.skillId, 'blocked', '2026-08-25T06:00:00.000Z');
    assert.equal(listExternalSkills(database)[0]?.state, 'blocked');
    assert.throws(() => setExternalSkillState(database, imported.skillId, 'imported'), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    const recoveredBlockedSnapshot = importedSnapshot('Recovered after blocked refresh.');
    const recoveredFromBlocked = await refreshSkillSnapshot(database, recoveredBlockedSnapshot, documentsFromSkillSnapshot(recoveredBlockedSnapshot), requirement, '2026-08-25T07:00:00.000Z');
    assert.equal(recoveredFromBlocked.skillId, imported.skillId);
    assert.equal(listExternalSkills(database)[0]?.state, 'disabled');
    assert.equal(database.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 0);
    setExternalSkillState(database, imported.skillId, 'imported', '2026-08-25T08:00:00.000Z');
    assert.equal(database.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 1);
  } finally {
    database.close();
  }
});

test('refuses to downgrade a blocked managed skill to stale', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-blocked-downgrade-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Blocked reference.');
    const imported = await importAuditedSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, '2026-08-25T00:00:00.000Z');
    const blocked = transitionRefreshFailure(database, imported.skillId, 'blocked', '2026-08-25T01:00:00.000Z');
    assert.throws(
      () => markExternalSkillRefreshFailure(database, imported.skillId, 'stale', {
        generation: blocked.generation,
        sourceCommit: blocked.sourceCommit,
        snapshotHash: blocked.snapshotHash,
        state: blocked.state,
        lastCheckedAt: blocked.lastCheckedAt,
      }, '2026-08-25T02:00:00.000Z'),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && /blocked/iu.test((error as Error).message),
    );
    assert.equal(readExternalSkill(database, imported.skillId)?.skill.state, 'blocked');
    assert.equal(readExternalSkill(database, imported.skillId)?.entries.some((entry) => entry.active), false);
  } finally {
    database.close();
  }
});

test('marks an existing skill stale instead of importing a moved primary path', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-moved-primary-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const first = importedSnapshot('Original path reference.');
    const imported = await importAuditedSkillSnapshot(database, first, documentsFromSkillSnapshot(first), requirement, '2026-08-25T00:00:00.000Z');
    const moved = validateSkillSnapshot({ candidate: { ...candidate, slug: 'sveltekit-helper-v2', id: 'fixture:owner/repo:sveltekit-helper-v2' }, sourceCommit: COMMIT_A, files: [{ path: 'skills/sveltekit-helper-v2/SKILL.md', content: first.files[0]!.content, primary: true }] });
    const firstRecord = readExternalSkill(database, imported.skillId)!.skill;
    const movedOutcome = await refreshAuditedExternalSkillSnapshot(database, imported.skillId, moved, documentsFromSkillSnapshot(moved), requirement, refreshExpectation(firstRecord));
    assert.equal(movedOutcome.kind, 'staled');
    if (movedOutcome.kind !== 'staled') throw new Error('Expected a staled Skill snapshot');
    assert.equal(movedOutcome.skill.skillId, imported.skillId);
    assert.equal(listExternalSkills(database).length, 1);
    assert.equal(listExternalSkills(database)[0]?.state, 'stale');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 0);

    // A disabled skill must not be bypassed by the same moved-path refresh.
    await refreshSkillSnapshot(database, first, documentsFromSkillSnapshot(first), requirement, '2026-08-25T01:00:00.000Z');
    setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T02:00:00.000Z');
    const disabledRecord = readExternalSkill(database, imported.skillId)!.skill;
    const disabledMovedOutcome = await refreshAuditedExternalSkillSnapshot(database, imported.skillId, moved, documentsFromSkillSnapshot(moved), requirement, refreshExpectation(disabledRecord), '2026-08-25T03:00:00.000Z');
    assert.equal(disabledMovedOutcome.kind, 'staled');
    const disabledMoved = listExternalSkills(database)[0];
    assert.equal(disabledMoved?.state, 'stale');
    assert.ok(disabledMoved?.disabledAt);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 0);
  } finally {
    database.close();
  }
});

test('atomically rekeys an explicit stale alias when a provider returns the canonical source path', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-alias-recovery-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const alias = { ...candidate, provider: 'old-provider', id: 'old-provider:owner/repo:fixture', name: 'fixture', slug: 'fixture' };
    const discovered = recordDiscoveredSkill(database, alias, '2026-08-25T00:00:00.000Z');
    const stale = transitionRefreshFailure(database, discovered.skillId, 'stale', '2026-08-25T01:00:00.000Z');
    const canonical = validateSkillSnapshot({ candidate: { ...candidate, provider: 'new-provider', id: 'new-provider:owner/repo:fixture-helper', name: 'fixture-helper', slug: 'fixture-helper' }, sourceCommit: COMMIT_A, files: [{ path: 'skills/fixture-helper/SKILL.md', content: '---\nname: Fixture Helper\ndescription: safe\n---\n# Fixture Helper\n\nReference.', primary: true }] });
    const documents = documentsFromSkillSnapshot(canonical);
    const result = await persistAuditedExistingSkillImport(database, discovered.skillId, { skill: canonical.candidate, sourceWorkspace: externalSkillWorkspace(canonical.candidate), sourceCommit: canonical.sourceCommit, snapshotHash: canonical.snapshotHash, frontmatter: canonical.frontmatter, documents, requirement }, refreshExpectation(stale));
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(result.skillId, 'github:owner/repo:fixture-helper');
    assert.equal(rows[0]?.slug, 'fixture-helper');
    assert.equal(rows[0]?.provider, 'new-provider');
    assert.equal(database.prepare('SELECT source_path FROM external_skill_entries WHERE skill_id = ?').get<{ source_path: string }>(result.skillId)?.source_path, 'skills/fixture-helper/SKILL.md');
    const replay = await refreshSkillSnapshot(database, canonical, documents, requirement, '2026-08-25T02:00:00.000Z');
    assert.equal(replay.imported, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('refuses to rekey a blocked unmaterialized alias into an active canonical skill', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-blocked-alias-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const alias = { ...candidate, provider: 'old-provider', id: 'old-provider:owner/repo:helper', name: 'helper', slug: 'helper' };
    const discovered = recordDiscoveredSkill(database, alias, '2026-08-25T00:00:00.000Z');
    const blocked = transitionRefreshFailure(database, discovered.skillId, 'blocked', '2026-08-25T01:00:00.000Z');
    const canonical = validateSkillSnapshot({ candidate: { ...candidate, provider: 'new-provider', id: 'new-provider:owner/repo:helper-pro', name: 'helper-pro', slug: 'helper-pro' }, sourceCommit: COMMIT_A, files: [{ path: 'skills/helper-pro/SKILL.md', content: '---\nname: Helper Pro\ndescription: safe\n---\n# Helper Pro\n\nReference.', primary: true }] });
    await assert.rejects(
      () => persistAuditedExistingSkillImport(database, discovered.skillId, { skill: canonical.candidate, sourceWorkspace: externalSkillWorkspace(canonical.candidate), sourceCommit: canonical.sourceCommit, snapshotHash: canonical.snapshotHash, frontmatter: canonical.frontmatter, documents: chunkSkillMarkdown({ skillName: canonical.frontmatter.name, sourcePath: canonical.files[0]!.path, markdown: canonical.files[0]!.content, summary: canonical.frontmatter.description, stripFrontmatter: true }), requirement }, refreshExpectation(blocked)),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.skillId, discovered.skillId);
    assert.equal(rows[0]?.provider, 'old-provider');
    assert.equal(rows[0]?.slug, 'helper');
    assert.equal(rows[0]?.state, 'blocked');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('fails closed when an explicit stale alias would collide with an existing canonical row', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-alias-ambiguity-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const alias = { ...candidate, provider: 'old-provider', id: 'old-provider:owner/repo:helper', name: 'helper', slug: 'helper' };
    const canonicalCandidate = { ...candidate, provider: 'new-provider', id: 'new-provider:owner/repo:helper-pro', name: 'helper-pro', slug: 'helper-pro' };
    const discovered = recordDiscoveredSkill(database, alias, '2026-08-25T00:00:00.000Z');
    const staleAlias = transitionRefreshFailure(database, discovered.skillId, 'stale', '2026-08-25T01:00:00.000Z');
    const canonicalRow = recordDiscoveredSkill(database, canonicalCandidate, '2026-08-25T01:30:00.000Z');
    const canonical = validateSkillSnapshot({ candidate: canonicalCandidate, sourceCommit: COMMIT_A, files: [{ path: 'skills/helper-pro/SKILL.md', content: '---\nname: Helper Pro\ndescription: safe\n---\n# Helper Pro\n\nReference.', primary: true }] });
    await assert.rejects(
      () => persistAuditedExistingSkillImport(database, discovered.skillId, { skill: canonical.candidate, sourceWorkspace: externalSkillWorkspace(canonical.candidate), sourceCommit: canonical.sourceCommit, snapshotHash: canonical.snapshotHash, frontmatter: canonical.frontmatter, documents: chunkSkillMarkdown({ skillName: canonical.frontmatter.name, sourcePath: canonical.files[0]!.path, markdown: canonical.files[0]!.content, summary: canonical.frontmatter.description, stripFrontmatter: true }), requirement }, refreshExpectation(staleAlias)),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    const rows = listExternalSkills(database);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.skillId === discovered.skillId)?.state, 'stale');
    assert.equal(rows.find((row) => row.skillId === canonicalRow.skillId)?.state, 'discovered');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count, 0);

    const reconciled = await persistAuditedExistingSkillImport(
      database,
      discovered.skillId,
      { skill: canonical.candidate, sourceWorkspace: externalSkillWorkspace(canonical.candidate), sourceCommit: canonical.sourceCommit, snapshotHash: canonical.snapshotHash, frontmatter: canonical.frontmatter, documents: chunkSkillMarkdown({ skillName: canonical.frontmatter.name, sourcePath: canonical.files[0]!.path, markdown: canonical.files[0]!.content, summary: canonical.frontmatter.description, stripFrontmatter: true }), requirement },
      refreshExpectation(staleAlias),
      '2026-08-25T02:00:00.000Z',
      { skillId: canonicalRow.skillId, expected: refreshExpectation(canonicalRow) },
    );
    assert.equal(reconciled.skillId, canonicalRow.skillId);
    assert.equal(listExternalSkills(database).length, 1);
    assert.equal(listExternalSkills(database)[0]?.state, 'imported');
  } finally {
    database.close();
  }
});

test('does not turn stale or blocked skills into disabled skills', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-state-transition-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const initialSnapshot = importedSnapshot('State transition reference.');
    const imported = await importAuditedSkillSnapshot(database, initialSnapshot, documentsFromSkillSnapshot(initialSnapshot), requirement, '2026-08-25T00:00:00.000Z');
    transitionRefreshFailure(database, imported.skillId, 'stale', '2026-08-25T01:00:00.000Z');
    assert.throws(() => setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T02:00:00.000Z'), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    assert.equal(listExternalSkills(database)[0]?.state, 'stale');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 0);

    const secondSnapshot = importedSnapshot('Second state transition reference.');
    const second = await refreshSkillSnapshot(database, secondSnapshot, documentsFromSkillSnapshot(secondSnapshot), requirement, '2026-08-25T03:00:00.000Z');
    transitionRefreshFailure(database, second.skillId, 'blocked', '2026-08-25T04:00:00.000Z');
    assert.throws(() => setExternalSkillState(database, second.skillId, 'disabled', '2026-08-25T05:00:00.000Z'), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    assert.equal(listExternalSkills(database)[0]?.state, 'blocked');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(second.skillId)?.count, 0);
  } finally {
    database.close();
  }
});

test('applies local-catalog scope to a manual import from an official repository', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-manual-official-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const officialCandidate: SkillCandidate = { ...candidate, id: 'fixture:sveltejs/ai-tools:svelte-code-writer', source: 'sveltejs/ai-tools', slug: 'svelte-code-writer', name: 'svelte-code-writer', installUrl: 'https://github.com/sveltejs/ai-tools' };
    const snapshot = validateSkillSnapshot({ candidate: officialCandidate, sourceCommit: COMMIT_A, files: [{ path: 'skills/svelte-code-writer/SKILL.md', content: '---\nname: Svelte Code Writer\ndescription: safe\n---\n# Svelte\n\nReference.', primary: true }] });
    const result = importSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot));
    const mapping = database.prepare('SELECT entry_id FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string }>(result.skillId)!;
    const entry = readEntry(database, { workspace: externalSkillWorkspace(officialCandidate), entryId: mapping.entry_id });
    assert.deepEqual((entry.scope.applicability as Record<string, unknown>).frameworks, [{ name: 'Svelte' }]);
    assert.deepEqual((entry.scope.signals as Record<string, unknown>).packages, ['svelte']);
    assert.equal(externalSkillRequirement(database, result.skillId)?.technology, 'svelte');
  } finally {
    database.close();
  }
});

test('does not reactivate chunks removed by a newer snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-removed-chunk-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const first = validateSkillSnapshot({ candidate, sourceCommit: COMMIT_A, files: [
      { path: 'skills/sveltekit-helper/SKILL.md', content: '---\nname: SvelteKit Helper\n---\n# Main\n\nReference.', primary: true },
      { path: 'skills/sveltekit-helper/references/old.md', content: '# Old\n\nRemoved reference.', primary: false },
    ] });
    const imported = await importAuditedSkillSnapshot(database, first, documentsFromSkillSnapshot(first), requirement, '2026-08-25T00:00:00.000Z');
    const second = validateSkillSnapshot({ candidate, sourceCommit: COMMIT_C, files: [{ path: 'skills/sveltekit-helper/SKILL.md', content: '---\nname: SvelteKit Helper\n---\n# Main\n\nUpdated reference.', primary: true }] });
    await refreshSkillSnapshot(database, second, documentsFromSkillSnapshot(second), requirement, '2026-08-25T01:00:00.000Z');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 1);
    setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-25T02:00:00.000Z');
    setExternalSkillState(database, imported.skillId, 'imported', '2026-08-25T03:00:00.000Z');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ count: number }>(imported.skillId)?.count, 1);
    assert.equal(database.prepare("SELECT active FROM external_skill_entries WHERE source_path LIKE '%old.md'").get<{ active: number }>()?.active, 0);
  } finally {
    database.close();
  }
});

test('rejects forged snapshot derivatives and prepared documents before writing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-revalidation-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Verified boundary reference.');
    const documents = documentsFromSkillSnapshot(snapshot);
    assert.throws(
      () => recordDiscoveredSkill(database, { ...candidate, name: 'safe\u202Emoc' }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
    const mismatchedDocuments = documents.map((document, index) => index === 0
      ? { ...document, contentHash: '0'.repeat(64) }
      : document);
    await assert.rejects(() => importAuditedSkillSnapshot(database, snapshot, mismatchedDocuments, requirement), /do not match|validation/iu);

    const forgedFrontmatter = { ...snapshot, frontmatter: { ...snapshot.frontmatter, name: 'Forged name' } };
    await assert.rejects(() => importAuditedSkillSnapshot(database, forgedFrontmatter, documents, requirement), /skill_validation_failed/u);

    const forgedCandidate = {
      ...snapshot,
      candidate: { ...snapshot.candidate, slug: 'forged-slug', id: `${snapshot.candidate.provider}:${snapshot.candidate.source}:forged-slug` },
    };
    await assert.rejects(() => importAuditedSkillSnapshot(database, forgedCandidate, documents, requirement), /skill_validation_failed/u);

    await assert.rejects(() => persistAuditedSkillImport(database, {
      skill: forgedCandidate.candidate,
      sourceWorkspace: externalSkillWorkspace(forgedCandidate.candidate),
      sourceCommit: snapshot.sourceCommit,
      snapshotHash: snapshot.snapshotHash,
      frontmatter: snapshot.frontmatter,
      documents,
      requirement,
    }), /import identity is invalid/iu);

    for (const sourceCommit of ['d'.repeat(39), 'D'.repeat(40)]) {
      await assert.rejects(() => persistAuditedSkillImport(database, {
        skill: snapshot.candidate,
        sourceWorkspace: externalSkillWorkspace(snapshot.candidate),
        sourceCommit,
        snapshotHash: snapshot.snapshotHash,
        frontmatter: snapshot.frontmatter,
        documents,
        requirement,
      }), /import identity is invalid/iu);
    }

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects the entire import before writes when any prepared document is invalid', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-rollback-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Reference one.');
    const valid = chunkSkillMarkdown({ skillName: snapshot.frontmatter.name, sourcePath: snapshot.files[0]!.path, markdown: snapshot.files[0]!.content, summary: snapshot.frontmatter.description, stripFrontmatter: true })[0]!;
    const invalid: PreparedSkillDocument = { ...valid, chunkIndex: 1, title: 'Invalid', body: 'password = should-not-be-stored', contentHash: '0'.repeat(64) };
    await assert.rejects(() => persistAuditedSkillImport(database, { skill: snapshot.candidate, sourceWorkspace: externalSkillWorkspace(snapshot.candidate), sourceCommit: snapshot.sourceCommit, snapshotHash: snapshot.snapshotHash, frontmatter: snapshot.frontmatter, documents: [valid, invalid] }), /secret|invalid|validation/iu);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects a prepared import that targets a non-external workspace', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-workspace-boundary-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = importedSnapshot('Reference one.');
    const documents = chunkSkillMarkdown({ skillName: snapshot.frontmatter.name, sourcePath: snapshot.files[0]!.path, markdown: snapshot.files[0]!.content, stripFrontmatter: true });
    await assert.rejects(() => persistAuditedSkillImport(database, { skill: snapshot.candidate, sourceWorkspace: 'global', sourceCommit: snapshot.sourceCommit, snapshotHash: snapshot.snapshotHash, frontmatter: snapshot.frontmatter, documents, requirement }), /import identity is invalid/u);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});
