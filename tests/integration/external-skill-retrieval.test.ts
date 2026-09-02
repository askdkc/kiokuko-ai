import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import type { SqliteRow } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { contextRetrievalStateHash } from '../../src/context/selection-state.js';
import { recordEntry, readEntry } from '../../src/memory/entries.js';
import { federatedEntries, retrieveFederatedMemory } from '../../src/memory/federated-retrieval.js';
import { searchEntries } from '../../src/memory/retrieval.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { GLOBAL_WORKSPACE, resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { canonicalContentHash, canonicalEntryRevisionContentHash, canonicalJson, type JsonObject } from '../../src/serialization/validate.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { importSkillSnapshot, listExternalSkills, markExternalSkillRefreshFailure, setExternalSkillState } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRequirement } from '../../src/skills/types.js';

const candidate: SkillCandidate = {
  id: 'fixture:sveltejs/ai-tools:svelte-code-writer',
  provider: 'fixture',
  name: 'svelte-code-writer',
  slug: 'svelte-code-writer',
  source: 'sveltejs/ai-tools',
  sourceType: 'github',
  installUrl: 'https://github.com/sveltejs/ai-tools',
  installs: 3,
  duplicate: false,
  officialStatus: 'catalog-verified',
};

const requirement: SkillRequirement = {
  id: 'svelte',
  technology: 'Svelte',
  aliases: ['svelte'],
  queries: ['svelte'],
  owners: ['sveltejs'],
  repositories: ['sveltejs/ai-tools'],
  applicability: { frameworks: [{ name: 'Svelte', version: '>=5 <6' }] },
  signals: { packages: ['svelte'] },
  reason: 'retrieval fixture',
};

function importManagedSkill(database: ReturnType<typeof openConnection>): ReturnType<typeof importSkillSnapshot> {
  const content = '---\nname: Svelte Code Writer\ndescription: safe\n---\n# Svelte Code Writer\n\nUse current repository evidence. A generic example may reference `src/routes/+page.svelte`.';
  const snapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: 'd'.repeat(40),
    files: [{ path: 'skills/svelte-code-writer/SKILL.md', content, primary: true }],
  });
  const documents = documentsFromSkillSnapshot(snapshot);
  return importSkillSnapshot(database, snapshot, documents, requirement, '2026-08-25T00:00:00.000Z');
}

async function passedMaterializationAuthorization(materializedCandidate: SkillCandidate) {
  const result = await authorizeSkillMaterialization({
    id: materializedCandidate.provider,
    async search() {
      return { provider: materializedCandidate.provider, experimental: false, candidates: [] };
    },
    async audit() {
      return { status: 'passed' };
    },
  }, materializedCandidate);
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') throw new Error('Fixture audit did not issue materialization authority');
  return result;
}

test('managed skills with project-relative examples are retrieved until disabled, stale, or blocked', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-retrieval-root-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0' } }));
  execFileSync('git', ['init', '-q', root]);
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-retrieval-db-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    importManagedSkill(database);
    const visible = async (): Promise<boolean> => (await retrieveFederatedMemory(database, { project, scope: 'ecosystem', query: 'Svelte Code Writer' })).ecosystem?.items.some((item) => item.title.includes('Svelte')) ?? false;
    assert.equal(await visible(), true);
    const skill = listExternalSkills(database)[0]!;
    const directVisible = (): boolean => searchEntries(database, { workspace: skill.sourceWorkspace, query: 'Svelte Code Writer' }).items.some((item) => item.title.includes('Svelte'));
    assert.equal(directVisible(), true);

    setExternalSkillState(database, skill.skillId, 'disabled', '2026-08-25T01:00:00.000Z');
    assert.equal(await visible(), false);
    assert.equal(directVisible(), false);
    setExternalSkillState(database, skill.skillId, 'imported', '2026-08-25T02:00:00.000Z');
    let current = listExternalSkills(database).find((row) => row.skillId === skill.skillId)!;
    markExternalSkillRefreshFailure(database, skill.skillId, 'stale', { generation: current.generation, sourceCommit: current.sourceCommit, snapshotHash: current.snapshotHash, state: current.state, lastCheckedAt: current.lastCheckedAt }, '2026-08-25T03:00:00.000Z');
    assert.equal(await visible(), false);
    assert.equal(directVisible(), false);
    current = listExternalSkills(database).find((row) => row.skillId === skill.skillId)!;
    markExternalSkillRefreshFailure(database, skill.skillId, 'blocked', { generation: current.generation, sourceCommit: current.sourceCommit, snapshotHash: current.snapshotHash, state: current.state, lastCheckedAt: current.lastCheckedAt }, '2026-08-25T04:00:00.000Z');
    assert.equal(await visible(), false);
    assert.equal(directVisible(), false);
  } finally {
    database.close();
  }
});

test('version-constrained managed skills reject missing and unparseable project framework versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-retrieval-version-root-'));
  execFileSync('git', ['init', '-q', root]);
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-retrieval-version-db-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    importManagedSkill(database);
    const baseFingerprint = {
      repositoryId: project.repositoryId,
      languages: ['JavaScript'],
      databases: [],
      runtimes: ['Node.js'],
      tools: [],
      packages: [{ name: 'svelte' }],
      manifestDigest: 'a'.repeat(64),
    };
    const visible = async (version?: string): Promise<boolean> => {
      const result = await retrieveFederatedMemory(database, {
        project,
        scope: 'ecosystem',
        query: 'Svelte Code Writer',
        fingerprint: {
          ...baseFingerprint,
          frameworks: [{ name: 'Svelte', ...(version === undefined ? {} : { version }) }],
        },
      });
      return result.ecosystem?.items.some((item) => item.title.includes('Svelte')) ?? false;
    };

    assert.equal(await visible('5.2.0'), true);
    assert.equal(await visible('^5.0.0'), true);
    assert.equal(await visible(), false);
    assert.equal(await visible('workspace:*'), false);
  } finally {
    database.close();
  }
});

test('inactive managed mappings cannot crowd eligible ordinary ecosystem entries out of the bounded candidate lane', async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-crowding-target-'));
  await writeFile(path.join(targetRoot, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5.9.0' } }));
  execFileSync('git', ['init', '-q', targetRoot]);
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-crowding-source-'));
  execFileSync('git', ['init', '-q', sourceRoot]);
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-crowding-db-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const targetProject = await resolveProjectWorkspace(database, targetRoot);
    const sourceProject = await resolveProjectWorkspace(database, sourceRoot);
    assert.ok(targetProject);
    assert.ok(sourceProject);
    const eligible = recordEntry(database, {
      workspace: sourceProject.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'TypeScript inactive-crowding sentinel',
      body: 'Reusable TypeScript guidance must survive inactive external candidates in the bounded ecosystem lane.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: sourceProject.repositoryId,
        applicability: { languages: ['TypeScript'] },
        signals: { packages: ['typescript'] },
      }),
    }, {
      idFactory: () => 'eligible-ordinary-typescript-entry',
      now: '2020-01-01T00:00:00.000Z',
    });
    const selectionWorkspaces = [targetProject.workspace, GLOBAL_WORKSPACE];
    const beforeHash = contextRetrievalStateHash(database, selectionWorkspaces, { includeEcosystem: true });
    const before = await federatedEntries(database, {
      project: targetProject,
      query: 'TypeScript inactive crowding',
      limit: 20,
    });
    assert.equal(before.some((item) => item.entry.id === eligible.id), true);

    for (let skillIndex = 0; skillIndex < 24; skillIndex += 1) {
      const slug = `crowding-skill-${skillIndex}`;
      const source = `owner/crowding-repo-${skillIndex}`;
      const materializedCandidate: SkillCandidate = {
        id: `fixture:${source}:${slug}`,
        provider: 'fixture',
        name: slug,
        slug,
        source,
        sourceType: 'github',
        installUrl: `https://github.com/${source}`,
        installs: 1,
        duplicate: false,
        officialStatus: 'registry-only',
      };
      const audited = await passedMaterializationAuthorization(materializedCandidate);
      const snapshot = validateSkillSnapshot({
        candidate: audited.candidate,
        sourceCommit: 'c'.repeat(40),
        files: [
          {
            path: `skills/${slug}/SKILL.md`,
            content: `---\nname: ${slug}\ndescription: TypeScript inactive crowding fixture\n---\n# ${slug}\n\nTypeScript inactive crowding guidance ${skillIndex}.`,
            primary: true,
          },
          ...Array.from({ length: 19 }, (_, documentIndex) => ({
            path: `skills/${slug}/references/reference-${documentIndex}.md`,
            content: `# TypeScript inactive crowding ${skillIndex}-${documentIndex}\n\nInactive external candidate fixture ${skillIndex}-${documentIndex}.`,
            primary: false,
          })),
        ],
      });
      const documents = documentsFromSkillSnapshot(snapshot);
      assert.equal(documents.length, 20);
      const imported = importSkillSnapshot(database, snapshot, documents, {
        id: `typescript-${skillIndex}`,
        technology: 'TypeScript',
        aliases: ['typescript'],
        queries: ['typescript'],
        owners: ['owner'],
        repositories: [source],
        applicability: { languages: ['TypeScript'] },
        signals: { packages: ['typescript'] },
        reason: 'inactive candidate crowding regression',
      }, '2026-08-26T01:00:00.000Z', audited.authorization);
      setExternalSkillState(database, imported.skillId, 'disabled', '2026-08-26T02:00:00.000Z');
    }

    const mappingCounts = database.prepare(`
      SELECT COUNT(*) AS total, SUM(active) AS active
        FROM external_skill_entries
    `).get<{ total: number; active: number }>();
    assert.equal(mappingCounts?.total, 480);
    assert.equal(mappingCounts?.active, 0);
    assert.equal(
      contextRetrievalStateHash(database, selectionWorkspaces, { includeEcosystem: true }),
      beforeHash,
      'inactive external rows must not change the broker-visible retrieval state',
    );
    const after = await federatedEntries(database, {
      project: targetProject,
      query: 'TypeScript inactive crowding',
      limit: 20,
    });
    assert.equal(after.some((item) => item.entry.id === eligible.id), true);
  } finally {
    database.close();
  }
});

test('superseded ordinary rows cannot crowd eligible ecosystem entries out of the bounded candidate lane', async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-superseded-crowding-target-'));
  await writeFile(path.join(targetRoot, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5.9.0' } }));
  execFileSync('git', ['init', '-q', targetRoot]);
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-superseded-crowding-source-'));
  execFileSync('git', ['init', '-q', sourceRoot]);
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-superseded-crowding-db-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const targetProject = await resolveProjectWorkspace(database, targetRoot);
    const sourceProject = await resolveProjectWorkspace(database, sourceRoot);
    assert.ok(targetProject);
    assert.ok(sourceProject);
    const eligible = recordEntry(database, {
      workspace: sourceProject.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'TypeScript superseded-crowding sentinel',
      body: 'Reusable TypeScript guidance must survive superseded rows in the bounded ecosystem lane.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: sourceProject.repositoryId,
        applicability: { languages: ['TypeScript'] },
        signals: { packages: ['typescript'] },
      }),
    }, {
      idFactory: () => 'eligible-superseded-typescript-entry',
      now: '2020-01-01T00:00:00.000Z',
    });
    const replacement = recordEntry(database, {
      workspace: sourceProject.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Unrelated superseded-crowding replacement',
      body: 'This project-specific replacement has no ecosystem retrieval signal.',
    }, {
      idFactory: () => 'superseded-crowding-replacement',
      now: '2026-08-26T03:00:00.000Z',
    });
    database.prepare('DELETE FROM entry_search_signals WHERE entry_id = ?').run(replacement.id);
    const selectionWorkspaces = [targetProject.workspace, GLOBAL_WORKSPACE];
    const beforeHash = contextRetrievalStateHash(database, selectionWorkspaces, { includeEcosystem: true });
    const before = await federatedEntries(database, {
      project: targetProject,
      query: 'TypeScript superseded crowding',
      limit: 20,
    });
    assert.equal(before.some((item) => item.entry.id === eligible.id), true);

    const obsoleteScope = buildStructuredScope({
      visibility: 'project',
      retrievalScope: 'ecosystem',
      repositoryId: sourceProject.repositoryId,
      applicability: { languages: ['TypeScript'] },
      signals: { packages: ['typescript'] },
    });
    const obsoleteBody = 'This obsolete ecosystem row must be removed before the bounded candidate limit.';
    const obsoleteAt = '2026-08-26T04:00:00.000Z';
    const insertEntry = database.prepare(`
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      ) VALUES (?, ?, 'superseded', 'user_asserted', 1, 1, ?, 'test', ?, ?, ?)
    `);
    const insertRevision = database.prepare(`
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, summary, scope_json,
        provenance_json, content_hash, created_by, created_at
      ) VALUES (?, ?, 1, 'lesson', ?, ?, NULL, ?, '{}', ?, 'test', ?)
    `);
    const insertSignal = database.prepare(`
      INSERT INTO entry_search_signals (entry_id, signal_type, normalized_value)
      VALUES (?, 'package', 'typescript')
    `);
    database.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < 480; index += 1) {
        const suffix = String(index).padStart(3, '0');
        const entryId = `crowding-obsolete-${suffix}`;
        const title = `TypeScript obsolete crowding ${suffix}`;
        const contentHash = canonicalEntryRevisionContentHash({
          kind: 'lesson',
          title,
          body: obsoleteBody,
          summary: null,
          scope: obsoleteScope,
          provenance: {},
          tags: [],
        });
        insertEntry.run(entryId, sourceProject.workspace, replacement.id, obsoleteAt, obsoleteAt, obsoleteAt);
        insertRevision.run(
          entryId,
          sourceProject.workspace,
          title,
          obsoleteBody,
          canonicalJson(obsoleteScope),
          contentHash,
          obsoleteAt,
        );
        insertSignal.run(entryId);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    assert.equal(
      contextRetrievalStateHash(database, selectionWorkspaces, { includeEcosystem: true }),
      beforeHash,
      'superseded rows must not change the broker-visible retrieval state',
    );
    const after = await federatedEntries(database, {
      project: targetProject,
      query: 'TypeScript superseded crowding',
      limit: 20,
    });
    assert.equal(after.some((item) => item.entry.id === eligible.id), true);
  } finally {
    database.close();
  }
});

test('legacy external skill copies never displace the active managed entry in any recall scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-retrieval-legacy-root-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0' } }));
  execFileSync('git', ['init', '-q', root]);
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-retrieval-legacy-db-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const projectWorkspace = await resolveProjectWorkspace(database, root);
    assert.ok(projectWorkspace);
    importManagedSkill(database);
    const skill = listExternalSkills(database)[0]!;
    const activeMapping = database.prepare('SELECT entry_id AS entryId FROM external_skill_entries WHERE skill_id = ? AND active = 1').get<{ entryId: string }>(skill.skillId)!;
    const ecosystemScope = buildStructuredScope({
      visibility: 'project',
      retrievalScope: 'ecosystem',
      memoryClass: 'reference',
      applicability: { frameworks: [{ name: 'Svelte', version: '>=5 <6' }] },
      signals: { packages: ['svelte'] },
    });
    const globalScope = buildStructuredScope({
      visibility: 'global',
      retrievalScope: 'global',
      memoryClass: 'reference',
      applicability: { frameworks: [{ name: 'Svelte', version: '>=5 <6' }] },
      signals: { packages: ['svelte'] },
    });
    const legacyWorkspaces = [
      { workspace: projectWorkspace.workspace, scope: ecosystemScope },
      { workspace: GLOBAL_WORKSPACE, scope: globalScope },
      { workspace: 'external-skills:legacy-source-sync', scope: ecosystemScope },
    ];
    const legacyIds = legacyWorkspaces.map(({ workspace, scope }) => recordEntry(database, {
      workspace,
      kind: 'reference',
      status: 'candidate',
      title: 'Svelte Code Writer legacy source-sync copy',
      body: 'Svelte Code Writer guidance copied by the removed fixed source-sync path.',
      scope,
      provenance: { type: 'source_sync', reference: 'github:mattpocock/skills' },
      trustLevel: 'untrusted',
      confidence: 0.7,
      tags: ['external:skill', 'skill:svelte-code-writer', 'technology:Svelte'],
      createdBy: 'kiokuko-source-sync',
      actor: 'kiokuko-source-sync',
    }).id);
    const ordinaryIds = legacyWorkspaces.map(({ workspace, scope }, index) => recordEntry(database, {
      workspace,
      kind: 'lesson',
      status: 'verified',
      title: `Ordinary Svelte Code Writer note ${index}`,
      body: `Ordinary non-external Svelte guidance ${index}.`,
      scope,
      tags: ['Svelte'],
    }).id);

    const query = 'Svelte Code Writer';
    const project = await retrieveFederatedMemory(database, { project: projectWorkspace, scope: 'project', query, limit: 20 });
    assert.deepEqual(project.project?.memory.items.filter((item) => legacyIds.includes(item.id)), []);
    assert.equal(project.project?.memory.items.some((item) => item.id === ordinaryIds[0]), true);

    const global = await retrieveFederatedMemory(database, { scope: 'global', query, limit: 20 });
    assert.deepEqual(global.global?.items.filter((item) => legacyIds.includes(item.id)), []);
    assert.equal(global.global?.items.some((item) => item.id === ordinaryIds[1]), true);

    const ecosystem = await retrieveFederatedMemory(database, { project: projectWorkspace, scope: 'ecosystem', query, limit: 20 });
    const ecosystemSkillIds = ecosystem.ecosystem?.items
      .filter((item) => item.tags.includes('external:skill'))
      .map((item) => item.id) ?? [];
    assert.deepEqual(ecosystemSkillIds, [activeMapping.entryId]);
    assert.equal(ecosystem.ecosystem?.items.some((item) => item.id === ordinaryIds[2]), true);

    const combined = await federatedEntries(database, { project: projectWorkspace, query, limit: 20 });
    assert.deepEqual(combined.filter((item) => item.entry.tags.includes('external:skill')).map((item) => item.entry.id), [activeMapping.entryId]);

    assert.throws(
      () => searchEntries(database, { workspace: projectWorkspace.workspace, query: 'x'.repeat((16 * 1024) + 1) }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
    );
  } finally {
    database.close();
  }
});

interface ManagedMappingRow extends SqliteRow {
  entryId: string;
  entryRevision: number;
  contentHash: string;
}

type RetrievalDatabase = ReturnType<typeof openConnection>;
type ExternalSkill = ReturnType<typeof listExternalSkills>[number];

function directResultIds(database: RetrievalDatabase, workspace: string): string[] {
  return searchEntries(database, { workspace, query: 'Svelte Code Writer', limit: 100 }).items.map((item) => item.id);
}

function replaceManagedScope(
  database: RetrievalDatabase,
  skill: ExternalSkill,
  mapping: ManagedMappingRow,
  scope: JsonObject,
): void {
  const entry = readEntry(database, { workspace: skill.sourceWorkspace, entryId: mapping.entryId });
  const contentHash = canonicalContentHash({
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    summary: entry.summary,
    scope,
    provenance: entry.provenance,
    tags: entry.tags,
  });
  database.exec('DROP TRIGGER entry_revisions_immutable_update');
  database.prepare(`
    UPDATE entry_revisions
       SET scope_json = ?, content_hash = ?
     WHERE entry_id = ? AND revision = ?
  `).run(canonicalJson(scope), contentHash, mapping.entryId, mapping.entryRevision);
  database.prepare(`
    UPDATE external_skill_entries
       SET content_hash = ?
     WHERE skill_id = ? AND entry_id = ? AND entry_revision = ?
  `).run(contentHash, skill.skillId, mapping.entryId, mapping.entryRevision);
}

function insertMappedEntry(database: RetrievalDatabase, input: {
  skill: ExternalSkill;
  title: string;
  sourcePath: string;
  chunkIndex: number;
  externalShape: boolean;
  sourceCommit?: string;
}): string {
  const sourceCommit = input.sourceCommit ?? input.skill.sourceCommit ?? 'd'.repeat(40);
  const scope = buildStructuredScope({
    visibility: 'project',
    retrievalScope: 'ecosystem',
    memoryClass: 'reference',
    applicability: { frameworks: [{ name: 'Svelte', version: '>=5 <6' }] },
    signals: { packages: ['svelte'] },
  });
  const entry = recordEntry(database, input.externalShape ? {
    workspace: input.skill.sourceWorkspace,
    kind: 'reference',
    status: 'candidate',
    title: input.title,
    body: `${input.title} body`,
    scope,
    provenance: {
      type: 'external_skill',
      reference: `https://github.com/${input.skill.sourceLocator}/blob/${sourceCommit}/${input.sourcePath}`,
      sourceRepositoryId: `github:${input.skill.sourceLocator}`,
      sourceWorkspace: input.skill.sourceWorkspace,
      sourceCommit,
      sourcePath: input.sourcePath,
      sourceChunkIndex: input.chunkIndex,
    },
    trustLevel: 'untrusted',
    tags: ['external:skill', `provider:${input.skill.provider}`, `source:${input.skill.sourceLocator}`, 'technology:Svelte'],
    createdBy: 'kiokuko-skill-discovery',
    actor: 'kiokuko-skill-discovery',
  } : {
    workspace: input.skill.sourceWorkspace,
    kind: 'lesson',
    status: 'verified',
    title: input.title,
    body: `${input.title} body`,
    scope,
  });
  database.prepare(`
    INSERT INTO external_skill_entries (
      skill_id, source_path, chunk_index, entry_id, entry_revision,
      content_hash, primary_document, active, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)
  `).run(input.skill.skillId, input.sourcePath, input.chunkIndex, entry.id, entry.revision, entry.contentHash, '2026-08-25T01:00:00.000Z');
  return entry.id;
}

test('external mapping and persisted-entry integrity fail closed', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (database: RetrievalDatabase, skill: ExternalSkill, mapping: ManagedMappingRow) => string[];
    expectIntegrityError?: boolean;
  }> = [
    {
      name: 'an ordinary-shaped entry cannot bypass retrieval after a mapping row is attached',
      mutate: (database, skill) => [insertMappedEntry(database, {
        skill,
        title: 'Mapped ordinary Svelte Code Writer impostor',
        sourcePath: 'skills/svelte-code-writer/references/mapped-ordinary.md',
        chunkIndex: 90,
        externalShape: false,
      })],
    },
    {
      name: 'a matching but abbreviated source commit is rejected',
      mutate: (database, skill, mapping) => {
        const shortCommit = 'deadbeef';
        const shortCommitEntryId = insertMappedEntry(database, {
          skill,
          title: 'Short commit Svelte Code Writer impostor',
          sourcePath: 'skills/svelte-code-writer/references/short-commit.md',
          chunkIndex: 91,
          externalShape: true,
          sourceCommit: shortCommit,
        });
        database.prepare('UPDATE external_skills SET source_commit = ? WHERE skill_id = ?').run(shortCommit, skill.skillId);
        return [mapping.entryId, shortCommitEntryId];
      },
    },
    {
      name: 'a malformed snapshot hash is rejected',
      mutate: (database, skill, mapping) => {
        database.prepare('UPDATE external_skills SET snapshot_hash = ? WHERE skill_id = ?').run('g'.repeat(64), skill.skillId);
        return [mapping.entryId];
      },
    },
    {
      name: 'a null snapshot hash is rejected',
      mutate: (database, skill, mapping) => {
        database.prepare('UPDATE external_skills SET snapshot_hash = NULL WHERE skill_id = ?').run(skill.skillId);
        return [mapping.entryId];
      },
    },
    {
      name: 'canonical parent metadata must name every current active mapping',
      mutate: (database, skill, mapping) => {
        const stored = database.prepare('SELECT metadata_json FROM external_skills WHERE skill_id = ?')
          .get<{ metadata_json: string }>(skill.skillId)!;
        const metadata = JSON.parse(stored.metadata_json) as JsonObject;
        metadata.currentMappings = [];
        database.prepare('UPDATE external_skills SET metadata_json = ? WHERE skill_id = ?')
          .run(canonicalJson(metadata), skill.skillId);
        return [mapping.entryId];
      },
    },
    {
      name: 'mapping content must equal the current revision content hash',
      mutate: (database, skill, mapping) => {
        database.prepare('UPDATE external_skill_entries SET content_hash = ? WHERE skill_id = ? AND entry_id = ?')
          .run('0'.repeat(64), skill.skillId, mapping.entryId);
        return [mapping.entryId];
      },
    },
    {
      name: 'mapping revision must be the current entry revision',
      mutate: (database, skill, mapping) => {
        database.prepare(`
          INSERT INTO entry_revisions (
            entry_id, workspace, revision, kind, title, body, summary,
            scope_json, provenance_json, content_hash, created_by, created_at
          )
          SELECT entry_id, workspace, revision + 1, kind, title, body || ' historical', summary,
                 scope_json, provenance_json, ?, created_by, created_at
            FROM entry_revisions
           WHERE entry_id = ? AND revision = ?
        `).run('e'.repeat(64), mapping.entryId, mapping.entryRevision);
        database.prepare('UPDATE external_skill_entries SET entry_revision = ? WHERE skill_id = ? AND entry_id = ?')
          .run(mapping.entryRevision + 1, skill.skillId, mapping.entryId);
        return [mapping.entryId];
      },
    },
    {
      name: 'mapping path must equal canonical provenance',
      mutate: (database, _skill, mapping) => {
        database.exec('DROP TRIGGER entry_revisions_immutable_update');
        database.prepare("UPDATE entry_revisions SET provenance_json = json_set(provenance_json, '$.sourcePath', 'skills/svelte-code-writer/references/forged.md') WHERE entry_id = ? AND revision = ?")
          .run(mapping.entryId, mapping.entryRevision);
        return [mapping.entryId];
      },
    },
    {
      name: 'mapping chunk index must equal canonical provenance',
      mutate: (database, _skill, mapping) => {
        database.exec('DROP TRIGGER entry_revisions_immutable_update');
        database.prepare("UPDATE entry_revisions SET provenance_json = json_set(provenance_json, '$.sourceChunkIndex', 999) WHERE entry_id = ? AND revision = ?")
          .run(mapping.entryId, mapping.entryRevision);
        return [mapping.entryId];
      },
    },
    {
      name: 'source reference and repository identity must match the managed source',
      mutate: (database, _skill, mapping) => {
        database.exec('DROP TRIGGER entry_revisions_immutable_update');
        database.prepare("UPDATE entry_revisions SET provenance_json = json_set(provenance_json, '$.reference', 'https://attacker.invalid/forged', '$.sourceRepositoryId', 'github:attacker/forged') WHERE entry_id = ? AND revision = ?")
          .run(mapping.entryId, mapping.entryRevision);
        return [mapping.entryId];
      },
    },
    {
      name: 'a tampered body with its original content hash raises an integrity error',
      mutate: (database, _skill, mapping) => {
        database.exec('DROP TRIGGER entry_revisions_immutable_update');
        database.prepare("UPDATE entry_revisions SET body = body || ' tampered' WHERE entry_id = ? AND revision = ?")
          .run(mapping.entryId, mapping.entryRevision);
        return [mapping.entryId];
      },
      expectIntegrityError: true,
    },
    {
      name: 'a non-string applicability language raises an integrity error even with a matching hash',
      mutate: (database, skill, mapping) => {
        const entry = readEntry(database, { workspace: skill.sourceWorkspace, entryId: mapping.entryId });
        replaceManagedScope(database, skill, mapping, {
          ...entry.scope,
          applicability: { languages: [123] },
        });
        return [mapping.entryId];
      },
      expectIntegrityError: true,
    },
    {
      name: 'a malformed framework applicability member raises an integrity error even with a matching hash',
      mutate: (database, skill, mapping) => {
        const entry = readEntry(database, { workspace: skill.sourceWorkspace, entryId: mapping.entryId });
        replaceManagedScope(database, skill, mapping, {
          ...entry.scope,
          applicability: { frameworks: [{ name: 123 }] },
        });
        return [mapping.entryId];
      },
      expectIntegrityError: true,
    },
    {
      name: 'unknown applicability dimensions raise an integrity error even with a matching hash',
      mutate: (database, skill, mapping) => {
        const entry = readEntry(database, { workspace: skill.sourceWorkspace, entryId: mapping.entryId });
        replaceManagedScope(database, skill, mapping, {
          ...entry.scope,
          applicability: { bogus: ['Svelte'] },
        });
        return [mapping.entryId];
      },
      expectIntegrityError: true,
    },
  ];

  for (const integrityCase of cases) {
    await t.test(integrityCase.name, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-retrieval-integrity-'));
      const databasePath = path.join(directory, 'data.sqlite3');
      await initializeDatabase({ databasePath });
      const database = openConnection(databasePath);
      try {
        importManagedSkill(database);
        const skill = listExternalSkills(database)[0]!;
        const mapping = database.prepare(`
          SELECT entry_id AS entryId, entry_revision AS entryRevision, content_hash AS contentHash
            FROM external_skill_entries
           WHERE skill_id = ? AND active = 1
           ORDER BY primary_document DESC, source_path, chunk_index
           LIMIT 1
        `).get<ManagedMappingRow>(skill.skillId)!;
        const revision = database.prepare(`
          SELECT content_hash AS contentHash
            FROM entry_revisions
           WHERE entry_id = ? AND revision = ?
        `).get<SqliteRow & { contentHash: string }>(mapping.entryId, mapping.entryRevision)!;
        assert.equal(mapping.contentHash, revision.contentHash);
        const ordinary = recordEntry(database, {
          workspace: skill.sourceWorkspace,
          kind: 'lesson',
          status: 'verified',
          title: 'Unmapped ordinary Svelte Code Writer note',
          body: 'Unmapped ordinary Svelte Code Writer guidance.',
        });
        const before = directResultIds(database, skill.sourceWorkspace);
        assert.equal(before.includes(mapping.entryId), true);
        assert.equal(before.includes(ordinary.id), true);

        const hiddenIds = integrityCase.mutate(database, skill, mapping);
        if (integrityCase.expectIntegrityError !== false) {
          assert.throws(
            () => directResultIds(database, skill.sourceWorkspace),
            (error: unknown) => (error as { code?: unknown }).code === 'INTEGRITY_ERROR',
          );
          return;
        }
        const after = directResultIds(database, skill.sourceWorkspace);
        for (const entryId of hiddenIds) assert.equal(after.includes(entryId), false, `${entryId} remained retrievable`);
        assert.equal(after.includes(ordinary.id), true);
        if (!hiddenIds.includes(mapping.entryId)) assert.equal(after.includes(mapping.entryId), true);
      } finally {
        database.close();
      }
    });
  }
});
