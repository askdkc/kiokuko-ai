import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { ensureGlobalWorkspace } from '../../src/memory/workspaces.js';
import { registerRepositoryAndLocation } from '../../src/repository/binding.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { requirementForOfficialSkill } from '../../src/skills/official-catalog.js';
import { importSkillSnapshot } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate } from '../../src/skills/types.js';

export const SAMPLE_DATABASE_SCHEMA_VERSION = 2;
export const SAMPLE_PROJECT_WORKSPACE = 'project:sampledb-ci';
export const SAMPLE_GLOBAL_WORKSPACE = 'global';
export const SAMPLE_EXTERNAL_SKILL_ID = 'github:sveltejs/ai-tools:svelte-code-writer';
export const SAMPLE_EXTERNAL_SKILL_WORKSPACE = 'external-skills:github:sveltejs-ai-tools-d93a72b29bf7a039';

export const SAMPLE_PROJECT_TITLES = [
  'CI project fixture: migration marker',
  'CI project fixture: Unicode decision',
  'CI project fixture: reference',
] as const;
export const SAMPLE_PROJECT_UNICODE_BODY = '改行とUnicodeを保持する。\n記憶テスト 🧠';

export const SAMPLE_GLOBAL_TITLES = [
  'CI global fixture: boundary validation',
  'CI global fixture: idempotent persistence',
  'CI global fixture: portable paths',
] as const;

const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';
const FIXTURE_PROJECT_ROOT = '/tmp/kiokuko-sampledb-ci-project';
const SQLITE_HEADER_SIZE = 100;
const SQLITE_WRITER_VERSION_OFFSET = 96;
// Node 24.16.0, the pinned CI/runtime floor, embeds SQLite 3.53.0. SQLite stores
// the library version of the last writer in the file header even when the
// logical database is identical, so normalize this informational fixture byte.
export const SAMPLE_SQLITE_WRITER_VERSION = 3_053_000;
const FIXTURE_EXTERNAL_ENTRY_IDS = [
  'entry-sampledb-external-overview',
  'entry-sampledb-external-inspect',
  'entry-sampledb-external-verify',
] as const;
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const migrationsRoot = path.join(repositoryRoot, 'migrations');

const sampleSkillCandidate: SkillCandidate = {
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
};

function sampleSkillSnapshot() {
  return validateSkillSnapshot({
    candidate: sampleSkillCandidate,
    sourceCommit: '1'.repeat(40),
    files: [{
      path: 'tools/skills/svelte-code-writer/SKILL.md',
      primary: true,
      content: [
        '---',
        'name: svelte-code-writer',
        'description: Deterministic external-skill fixture for migration and Web API tests.',
        '---',
        '# Sample Svelte skill',
        '',
        'This is synthetic CI fixture content. It is never installed or executed.',
        '',
        '## Inspect',
        '',
        'Read the component and identify the smallest testable change.',
        '',
        '## Verify',
        '',
        'Run the relevant static checks and focused tests.',
        '',
      ].join('\n'),
    }],
  });
}

export const SAMPLE_EXTERNAL_SKILL_DOCUMENT_COUNT = documentsFromSkillSnapshot(sampleSkillSnapshot()).length;

async function copyCurrentMigration(targetDirectory: string): Promise<void> {
  const available = await readdir(migrationsRoot);
  for (let version = 1; version <= SAMPLE_DATABASE_SCHEMA_VERSION; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const matches = available.filter((name) => name.startsWith(`${prefix}_`) && name.endsWith('.sql'));
    assert.equal(matches.length, 1, `Expected exactly one migration for version ${version}`);
    await copyFile(path.join(migrationsRoot, matches[0]!), path.join(targetDirectory, matches[0]!));
  }
}

function recordProjectFixtures(database: ReturnType<typeof openConnection>): void {
  registerRepositoryAndLocation(database, {
    repositoryId: 'repo_sampledb_ci',
    workspace: SAMPLE_PROJECT_WORKSPACE,
    displayName: 'sampledb-ci',
    canonicalRoot: FIXTURE_PROJECT_ROOT,
    remoteFingerprint: null,
    bindingSchemaVersion: 1,
    agentTemplateVersion: 0,
    now: FIXTURE_TIME,
  });

  const records = [{
    id: 'entry-sampledb-project-fact',
    kind: 'fact' as const,
    status: 'verified' as const,
    trustLevel: 'source_verified' as const,
    title: SAMPLE_PROJECT_TITLES[0],
    body: 'This deterministic record must survive setup migration unchanged.',
    tags: ['fixture:ci', 'fixture:project', 'sample:migration'],
  }, {
    id: 'entry-sampledb-project-decision',
    kind: 'decision' as const,
    status: 'candidate' as const,
    trustLevel: 'user_asserted' as const,
    title: SAMPLE_PROJECT_TITLES[1],
    body: SAMPLE_PROJECT_UNICODE_BODY,
    tags: ['fixture:ci', 'fixture:project', 'sample:unicode'],
  }, {
    id: 'entry-sampledb-project-reference',
    kind: 'reference' as const,
    status: 'candidate' as const,
    trustLevel: 'user_asserted' as const,
    title: SAMPLE_PROJECT_TITLES[2],
    body: 'Reference marker: sampledb-reference-v1.',
    tags: ['fixture:ci', 'fixture:project', 'sample:reference'],
  }];

  for (const record of records) {
    recordEntry(database, {
      workspace: SAMPLE_PROJECT_WORKSPACE,
      kind: record.kind,
      status: record.status,
      trustLevel: record.trustLevel,
      title: record.title,
      body: record.body,
      summary: 'Synthetic project-scoped CI fixture.',
      scope: buildStructuredScope({
        visibility: 'project',
        repositoryId: 'repo_sampledb_ci',
        retrievalScope: 'project-only',
        memoryClass: 'reference',
        applicability: { runtimes: ['Node.js'], tools: ['Kiokuko'] },
        signals: { paths: ['tests/sampledb/kiokuko-ai.sqlite'] },
      }),
      provenance: { type: 'ci_fixture', reference: 'tests/sampledb/kiokuko-ai.sqlite' },
      confidence: 1,
      tags: record.tags,
      createdBy: 'sampledb-generator',
      actor: 'sampledb-generator',
    }, { idFactory: () => record.id, now: FIXTURE_TIME });
  }
}

function recordGlobalFixtures(database: ReturnType<typeof openConnection>): void {
  ensureGlobalWorkspace(database, FIXTURE_TIME);
  const records = [{
    id: 'entry-sampledb-global-boundary',
    kind: 'lesson' as const,
    title: SAMPLE_GLOBAL_TITLES[0],
    body: 'Synthetic fixture: validate external input before persistence.',
    memoryClass: 'implementation-pattern' as const,
    applicability: { languages: ['TypeScript'], runtimes: ['Node.js'], tools: ['Kiokuko'] },
    signals: { errors: ['VALIDATION_ERROR'] },
  }, {
    id: 'entry-sampledb-global-idempotency',
    kind: 'decision' as const,
    title: SAMPLE_GLOBAL_TITLES[1],
    body: 'Synthetic fixture: replaying canonical input must not duplicate durable state.',
    memoryClass: 'workflow' as const,
    applicability: { databases: ['SQLite'], tools: ['Kiokuko'] },
    signals: { commands: ['kiokuko-ai setup'] },
  }, {
    id: 'entry-sampledb-global-paths',
    kind: 'reference' as const,
    title: SAMPLE_GLOBAL_TITLES[2],
    body: 'Synthetic fixture: resolve application-data paths from the current platform.',
    memoryClass: 'gotcha' as const,
    applicability: { platforms: ['Linux', 'macOS'], tools: ['Kiokuko'] },
    signals: { symbols: ['getGlobalDatabasePath'] },
  }];

  for (const record of records) {
    recordEntry(database, {
      workspace: SAMPLE_GLOBAL_WORKSPACE,
      kind: record.kind,
      status: 'candidate',
      trustLevel: 'untrusted',
      title: record.title,
      body: record.body,
      summary: 'Synthetic global CI fixture.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        memoryClass: record.memoryClass,
        applicability: record.applicability,
        signals: record.signals,
        portableReason: 'Deterministic cross-project fixture for setup migration and Web API tests.',
      }),
      provenance: { type: 'ci_fixture', reference: 'tests/sampledb/kiokuko-ai.sqlite' },
      confidence: 0.7,
      tags: ['fixture:ci', 'fixture:global', 'sample:global'],
      createdBy: 'sampledb-generator',
      actor: 'sampledb-generator',
    }, { idFactory: () => record.id, now: FIXTURE_TIME });
  }
}

function recordExternalSkillFixture(database: ReturnType<typeof openConnection>): void {
  const snapshot = sampleSkillSnapshot();
  const requirement = requirementForOfficialSkill(sampleSkillCandidate);
  assert.ok(requirement, 'The sample skill must remain pinned in the reviewed official catalog');
  const imported = importSkillSnapshot(
    database,
    snapshot,
    documentsFromSkillSnapshot(snapshot),
    requirement,
    FIXTURE_TIME,
  );
  assert.equal(imported.skillId, SAMPLE_EXTERNAL_SKILL_ID);
  assert.equal(imported.sourceWorkspace, SAMPLE_EXTERNAL_SKILL_WORKSPACE);
  assert.equal(imported.imported, SAMPLE_EXTERNAL_SKILL_DOCUMENT_COUNT);
}

function canonicalizeGeneratedIdentifiers(database: ReturnType<typeof openConnection>): void {
  const triggers = database.prepare(`
    SELECT name, sql
      FROM sqlite_schema
     WHERE type = 'trigger'
       AND name IN ('entry_revisions_immutable_update', 'entry_revision_tags_immutable_update')
     ORDER BY name
  `).all<{ name: string; sql: string | null }>();
  assert.equal(triggers.length, 2, 'Expected both immutable memory triggers');
  assert.ok(triggers.every(({ sql }) => typeof sql === 'string' && sql.length > 0));

  const externalEntries = database.prepare(`
    SELECT entry_id, chunk_index
      FROM external_skill_entries
     WHERE skill_id = ?
     ORDER BY source_path, chunk_index
  `).all<{ entry_id: string; chunk_index: number }>(SAMPLE_EXTERNAL_SKILL_ID);
  assert.equal(externalEntries.length, FIXTURE_EXTERNAL_ENTRY_IDS.length);

  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`);
    database.prepare('UPDATE schema_migrations SET applied_at = ?').run(FIXTURE_TIME);

    for (const [index, externalEntry] of externalEntries.entries()) {
      const canonicalId = FIXTURE_EXTERNAL_ENTRY_IDS[index]!;
      database.prepare('UPDATE entries SET id = ? WHERE id = ?').run(canonicalId, externalEntry.entry_id);
      for (const table of ['entry_revisions', 'entry_revision_tags', 'audit_events', 'entry_search_documents', 'entry_search_signals', 'external_skill_entries']) {
        database.prepare(`UPDATE ${table} SET entry_id = ? WHERE entry_id = ?`).run(canonicalId, externalEntry.entry_id);
      }
    }

    const auditEvents = database.prepare('SELECT event_id FROM audit_events ORDER BY entry_id, event_id')
      .all<{ event_id: string }>();
    for (const [index, auditEvent] of auditEvents.entries()) {
      const canonicalId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      database.prepare('UPDATE audit_events SET event_id = ? WHERE event_id = ?').run(canonicalId, auditEvent.event_id);
    }

    for (const trigger of triggers) database.exec(trigger.sql!);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [], 'Canonical fixture IDs must preserve every foreign key');
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve the canonicalization failure */ }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
  assert.equal(database.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys, 1);
  database.exec('VACUUM');
}

function assertCurrentState(database: ReturnType<typeof openConnection>): void {
  const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all<{ version: number }>();
  assert.deepEqual(versions.map(({ version }) => version), [1, SAMPLE_DATABASE_SCHEMA_VERSION]);
  const counts = database.prepare('SELECT workspace, COUNT(*) AS count FROM entries GROUP BY workspace ORDER BY workspace')
    .all<{ workspace: string; count: number }>()
    .map(({ workspace, count }) => ({ workspace, count }));
  assert.deepEqual(counts, [
    { workspace: SAMPLE_EXTERNAL_SKILL_WORKSPACE, count: SAMPLE_EXTERNAL_SKILL_DOCUMENT_COUNT },
    { workspace: SAMPLE_GLOBAL_WORKSPACE, count: SAMPLE_GLOBAL_TITLES.length },
    { workspace: SAMPLE_PROJECT_WORKSPACE, count: SAMPLE_PROJECT_TITLES.length },
  ]);
}

async function normalizeSqliteWriterVersion(databasePath: string): Promise<void> {
  const handle = await open(databasePath, 'r+');
  try {
    const header = Buffer.alloc(SQLITE_HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    assert.equal(bytesRead, SQLITE_HEADER_SIZE, 'Generated SQLite header is truncated');
    assert.equal(
      header.subarray(0, 16).toString('binary'),
      'SQLite format 3\0',
      'Generated fixture must have a SQLite 3 header',
    );
    const normalized = Buffer.alloc(4);
    normalized.writeUInt32BE(SAMPLE_SQLITE_WRITER_VERSION);
    const { bytesWritten } = await handle.write(normalized, 0, normalized.byteLength, SQLITE_WRITER_VERSION_OFFSET);
    assert.equal(bytesWritten, normalized.byteLength, 'Could not normalize the SQLite writer version');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createSampleDatabase(targetPath: string): Promise<void> {
  const absoluteTarget = path.resolve(targetPath);
  if (!absoluteTarget.endsWith('.sqlite')) throw new Error('Sample database target must end with .sqlite');
  await mkdir(path.dirname(absoluteTarget), { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-sampledb-build-'));
  const temporaryMigrations = path.join(temporaryRoot, 'migrations');
  const temporaryDatabase = path.join(temporaryRoot, 'kiokuko-ai.sqlite');
  await mkdir(temporaryMigrations);
  await copyCurrentMigration(temporaryMigrations);

  const database = openConnection(temporaryDatabase);
  let completed = false;
  try {
    const migration = migrateDatabase(database, temporaryMigrations);
    assert.equal(migration.currentVersion, SAMPLE_DATABASE_SCHEMA_VERSION);
    assert.deepEqual(migration.applied, [1, SAMPLE_DATABASE_SCHEMA_VERSION]);
    recordProjectFixtures(database);
    recordGlobalFixtures(database);
    recordExternalSkillFixture(database);
    canonicalizeGeneratedIdentifiers(database);
    assertCurrentState(database);
    database.close();
    await normalizeSqliteWriterVersion(temporaryDatabase);
    await chmod(temporaryDatabase, 0o600);
    await rename(temporaryDatabase, absoluteTarget);
    completed = true;
  } finally {
    if (!completed) {
      try { database.close(); } catch { /* preserve the generation failure */ }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target === undefined || process.argv.length !== 3) {
    throw new Error('Usage: node --import tsx tests/fixtures/sample-database.ts <target.sqlite>');
  }
  await createSampleDatabase(target);
  process.stdout.write(`${path.resolve(target)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
