import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { curateMemoryCandidates, curatorFacets, globalizeCuratorCandidate } from '../../src/memory/curator.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { registerRepositoryAndLocation } from '../../src/repository/binding.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { externalSkillWorkspace, importSkillSnapshot } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRequirement } from '../../src/skills/types.js';

async function passedAuditAuthority(skill: SkillCandidate) {
  const result = await authorizeSkillMaterialization({
    id: skill.provider,
    async search() { return { provider: skill.provider, experimental: false, candidates: [] }; },
    async audit(audited) {
      assert.equal(audited.id, skill.id);
      return { status: 'passed' };
    },
  }, skill);
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') throw new Error('fixture audit did not issue materialization authority');
  return result.authorization;
}

test('curator filters, facets, cursor pagination, and globalization visibility are server-side', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-curator-filters-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const projects = [
      { workspace: 'project:laravel', name: 'laravel-api', framework: 'Laravel', language: 'PHP', tag: 'Laravel', title: 'Laravel migration rollback pattern', body: 'When a Laravel migration fails, inspect the transaction and verify the schema before retrying.' },
      { workspace: 'project:svelte', name: 'svelte-web', framework: 'Svelte', language: 'TypeScript', tag: 'Svelte', title: 'Svelte state update pattern', body: 'When a Svelte state update is stale, verify the reactive assignment and rerender the component.' },
      { workspace: 'project:typescript', name: 'typescript-tool', framework: 'Vite', language: 'TypeScript', tag: 'TypeScript', title: 'TypeScript command validation workflow', body: 'When a TypeScript command changes, run the compiler and verify the generated output before release.' },
    ] as const;
    const entries = projects.map((project) => {
      registerRepositoryAndLocation(database, {
        repositoryId: `repo_${project.workspace.slice('project:'.length)}`,
        workspace: project.workspace,
        displayName: project.name,
        canonicalRoot: path.join(directory, project.name),
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      });
      return recordEntry(database, {
        workspace: project.workspace,
        kind: 'lesson',
        status: 'candidate',
        title: project.title,
        body: project.body,
        summary: `Reusable ${project.framework} workflow.`,
        scope: buildStructuredScope({
          visibility: 'project',
          memoryClass: 'troubleshooting',
          applicability: { frameworks: [{ name: project.framework }], languages: [project.language] },
        }),
        tags: [project.tag, 'workflow'],
      });
    });
    const laravel = entries[0];
    assert.ok(laravel);

    const filtered = await curateMemoryCandidates(database, { allWorkspaces: true, tags: ['Laravel'], frameworks: ['Laravel'], languages: ['PHP'], memoryClasses: ['troubleshooting'] });
    assert.deepEqual(filtered.candidates.map((candidate) => candidate.entryId), [laravel.id]);

    const facets = curatorFacets(database);
    assert.ok(facets.projects.some((facet) => facet.workspace === 'project:laravel'));
    assert.ok(facets.tags.some((facet) => facet.value === 'Laravel'));
    assert.ok(facets.frameworks.some((facet) => facet.value === 'laravel'));
    assert.ok(facets.languages.some((facet) => facet.value === 'php'));
    assert.ok(facets.memoryClasses.some((facet) => facet.value === 'troubleshooting'));

    const firstPage = await curateMemoryCandidates(database, { allWorkspaces: true, limit: 1 });
    assert.equal(firstPage.candidates.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await curateMemoryCandidates(database, { allWorkspaces: true, limit: 1, cursor: firstPage.nextCursor ?? undefined });
    assert.equal(secondPage.candidates.length, 1);
    assert.notEqual(secondPage.candidates[0]?.entryId, firstPage.candidates[0]?.entryId);

    globalizeCuratorCandidate(database, { workspace: laravel.workspace, entryId: laravel.id, expectedRevision: laravel.revision });
    const hidden = await curateMemoryCandidates(database, { allWorkspaces: true });
    assert.equal(hidden.candidates.some((candidate) => candidate.entryId === laravel.id), false);
    const shown = await curateMemoryCandidates(database, { allWorkspaces: true, includeGlobalized: true });
    assert.equal(shown.candidates.some((candidate) => candidate.entryId === laravel.id), true);
  } finally {
    database.close();
  }
});

test('curator facets exclude every managed external skill dimension', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-curator-external-facets-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const skill: SkillCandidate = {
    id: 'fixture:external/repo:external-only',
    provider: 'fixture',
    name: 'external-only',
    slug: 'external-only',
    source: 'external/repo',
    sourceType: 'github',
    installUrl: 'https://github.com/external/repo',
    installs: 1,
    duplicate: false,
    officialStatus: 'catalog-verified',
    auditStatus: 'passed',
  };
  const requirement: SkillRequirement = {
    id: 'external-only',
    technology: 'external-only',
    aliases: ['external-only'],
    queries: ['external-only'],
    owners: ['external'],
    repositories: ['external/repo'],
    applicability: { frameworks: [{ name: 'ExternalOnly' }], languages: ['ExternalLang'] },
    signals: { packages: ['external-only'] },
    reason: 'Facet exclusion fixture.',
  };
  try {
    const snapshot = validateSkillSnapshot({
      candidate: skill,
      sourceCommit: 'dddddddddddddddddddddddddddddddddddddddd',
      files: [{ path: 'skills/external-only/SKILL.md', content: '---\nname: External Only\ndescription: external reference\n---\n# External\n\nReusable external workflow reference.', primary: true }],
    });
    const authorization = await passedAuditAuthority(skill);
    importSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement, undefined, authorization);

    const candidates = await curateMemoryCandidates(database, { allWorkspaces: true });
    const facets = curatorFacets(database);
    assert.equal(candidates.count, 0);
    assert.equal(facets.projects.some((facet) => facet.workspace === externalSkillWorkspace(skill)), false);
    assert.equal(facets.tags.some((facet) => facet.value === 'external:skill'), false);
    assert.equal(facets.frameworks.some((facet) => facet.value === 'externalonly'), false);
    assert.equal(facets.languages.some((facet) => facet.value === 'externallang'), false);
  } finally {
    database.close();
  }
});

test('curator cursor pagination reaches candidates beyond the first SQL scan batch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-curator-pagination-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    for (let index = 0; index < 501; index += 1) {
      recordEntry(database, {
        workspace: 'project:bulk-curator',
        kind: 'lesson',
        status: 'candidate',
        title: `Reusable migration workflow ${String(index).padStart(3, '0')}`,
        body: `Reusable workflow ${index}: when a migration fails, verify the transaction boundary and run the documented recovery procedure before retrying safely.`,
        scope: { visibility: 'project' },
      }, {
        idFactory: () => `bulk-${String(index).padStart(3, '0')}`,
        now: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    let cursor: string | undefined;
    let seen = 0;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await curateMemoryCandidates(database, { allWorkspaces: true, limit: 50, ...(cursor === undefined ? {} : { cursor }) });
      assert.equal(page.totalApproximate, 501);
      assert.equal(page.candidates.length, 50);
      assert.ok(page.nextCursor);
      seen += page.candidates.length;
      cursor = page.nextCursor ?? undefined;
    }
    assert.equal(seen, 500);
    if (cursor === undefined) throw new Error('Expected a cursor after 500 candidates');
    const finalPage = await curateMemoryCandidates(database, { allWorkspaces: true, limit: 1, cursor });
    assert.equal(finalPage.candidates.length, 1);
    assert.equal(finalPage.nextCursor, null);
    assert.equal(finalPage.totalApproximate, 501);
  } finally {
    database.close();
  }
});

test('curator decodes corrupt rows before external-marker filtering or facet aggregation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-curator-decode-before-filter-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const entry = recordEntry(database, {
      workspace: 'project:curator-corrupt',
      kind: 'lesson',
      status: 'candidate',
      title: 'Reusable fail-closed workflow',
      body: 'When a stored candidate is inspected, verify its canonical revision and fail explicitly before applying semantic filters.',
      tags: ['workflow'],
    });
    // This forged marker used to make the corrupt revision disappear in the
    // raw SQL exclusion clause before the canonical hash was checked.
    database.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)')
      .run(entry.id, entry.revision, 'external:skill');

    const integrity = (error: unknown) => (error as { code?: unknown }).code === 'INTEGRITY_ERROR';
    await assert.rejects(() => curateMemoryCandidates(database, { allWorkspaces: true }), integrity);
    assert.throws(() => curatorFacets(database), integrity);
  } finally {
    database.close();
  }
});

test('curator globalized detection uses exact decoded provenance identity, not substring matching', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-curator-globalized-identity-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const source = recordEntry(database, {
      workspace: 'project:curator-source-identity',
      kind: 'lesson',
      status: 'candidate',
      title: 'Reusable transaction recovery workflow',
      body: 'When a transaction fails, verify the boundary, inspect the persisted state, and run the documented recovery procedure before retrying.',
      tags: ['workflow', 'reusable'],
    }, { idFactory: () => 'source-with-substring-collision' });
    const reference = `${source.id}@${source.revision}#deterministic-v1`;
    recordEntry(database, {
      workspace: 'global',
      kind: 'reference',
      status: 'verified',
      title: 'Unrelated global reference',
      body: 'This global entry is unrelated to the curator source.',
      scope: buildStructuredScope({ visibility: 'global', portableReason: 'Explicit unrelated portable fixture' }),
      provenance: { type: 'test', reference: `prefix:${reference}:suffix`, sourceWorkspace: source.workspace },
    });
    recordEntry(database, {
      workspace: 'global',
      kind: 'reference',
      status: 'verified',
      title: 'Wrong source identity',
      body: 'Even an exact reference is insufficient when the source workspace is different.',
      scope: buildStructuredScope({ visibility: 'global', portableReason: 'Explicit wrong-identity portable fixture' }),
      provenance: { type: 'curator_globalize', reference, sourceWorkspace: 'project:different-source' },
    });

    const result = await curateMemoryCandidates(database, { allWorkspaces: true });
    assert.equal(result.candidates.some((candidate) => candidate.entryId === source.id), true);
    assert.equal(curatorFacets(database).projects.some((facet) => facet.workspace === source.workspace), true);
  } finally {
    database.close();
  }
});
