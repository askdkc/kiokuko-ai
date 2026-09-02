import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { discoverSkills } from '../../src/skills/discovery-service.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { importSkillSnapshot, listExternalSkills } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRequirement } from '../../src/skills/types.js';

const candidate: SkillCandidate = {
  id: 'fixture:owner/repo:atomic-skill',
  provider: 'fixture',
  name: 'atomic-skill',
  slug: 'atomic-skill',
  source: 'owner/repo',
  sourceType: 'github',
  installUrl: 'https://github.com/owner/repo',
  installs: 1,
  duplicate: false,
  officialStatus: 'catalog-verified',
  auditStatus: 'passed',
};

const requirement: SkillRequirement = {
  id: 'svelte',
  technology: 'svelte',
  aliases: ['svelte'],
  queries: ['svelte'],
  owners: ['owner'],
  repositories: ['owner/repo'],
  applicability: { frameworks: [{ name: 'Svelte' }] },
  signals: { packages: ['svelte'] },
  reason: 'atomicity fixture',
};

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

test('rolls back every import row when SQLite fails after the first mapping write', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-late-write-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const snapshot = validateSkillSnapshot({
      candidate,
      sourceCommit: 'a'.repeat(40),
      files: [
        {
          path: 'skills/atomic-skill/SKILL.md',
          content: '---\nname: Atomic Skill\ndescription: safe\n---\n# Atomic Skill\n\nPrimary reference.',
          primary: true,
        },
        {
          path: 'skills/atomic-skill/references/details.md',
          content: '# Details\n\nSecond reference.',
          primary: false,
        },
      ],
    });
    const documents = documentsFromSkillSnapshot(snapshot);
    assert.ok(documents.length >= 2, 'fixture must reach a later mapping write');
    database.exec(`
      CREATE TRIGGER fail_second_external_mapping
      BEFORE INSERT ON external_skill_entries
      WHEN (SELECT COUNT(*) FROM external_skill_entries) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'late external mapping failure');
      END;
    `);

    const authorization = await passedAuditAuthority(candidate);

    assert.throws(
      () => importSkillSnapshot(database, snapshot, documents, requirement, undefined, authorization),
      /late external mapping failure/u,
    );
    for (const table of ['external_skills', 'external_skill_entries', 'entries', 'entry_revisions']) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()?.count,
        0,
        `${table} must roll back`,
      );
    }
  } finally {
    database.close();
  }
});

test('prepares every selected skill before atomically persisting the discovery batch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-discovery-batch-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  const svelte = { ...candidate, id: 'fixture:sveltejs/ai-tools:svelte', source: 'sveltejs/ai-tools', slug: 'svelte', name: 'svelte', installUrl: 'https://github.com/sveltejs/ai-tools', officialStatus: 'registry-only' as const };
  const sveltekit = { ...candidate, id: 'fixture:sveltejs/ai-tools:sveltekit', source: 'sveltejs/ai-tools', slug: 'sveltekit', name: 'sveltekit', installUrl: 'https://github.com/sveltejs/ai-tools', officialStatus: 'registry-only' as const };
  const durableRowsSeenDuringFetch: number[] = [];
  try {
    database.exec(`
      CREATE TRIGGER fail_second_discovered_skill
      BEFORE INSERT ON external_skills
      WHEN (SELECT COUNT(*) FROM external_skills) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'late discovery batch failure');
      END;
    `);

    await assert.rejects(discoverSkills(database, {
      project: { workspace: 'workspace:svelte', repositoryRoot: directory, repositoryId: 'repo-svelte' },
      fingerprint: {
        repositoryId: 'repo-svelte',
        languages: ['JavaScript'],
        frameworks: [{ name: 'Svelte', version: '5' }, { name: 'SvelteKit', version: '2' }],
        databases: [],
        runtimes: ['Node.js'],
        tools: [],
        packages: [{ name: 'svelte', version: '5' }, { name: '@sveltejs/kit', version: '2' }],
        manifestDigest: 'svelte-and-sveltekit',
      },
      task: 'Implement Svelte and SvelteKit components',
      profile: { taskType: 'build', target: 'Svelte and SvelteKit components', expected: 'tests pass', constraints: null },
      recommendedTags: ['svelte', 'sveltekit'],
      capabilities: [],
      mode: 'official',
      maxSelectedSkills: 2,
    }, {
      provider: {
        id: 'fixture',
        async search() { return { provider: 'fixture', experimental: false, candidates: [svelte, sveltekit] }; },
        async audit() { return { status: 'passed' }; },
      },
      sourceFetcher: {
        async fetch(skill) {
          durableRowsSeenDuringFetch.push(listExternalSkills(database).length);
          return validateSkillSnapshot({
            candidate: skill,
            sourceCommit: skill.slug === 'svelte' ? 'b'.repeat(40) : 'c'.repeat(40),
            files: [{
              path: `skills/${skill.slug}/SKILL.md`,
              content: `---\nname: ${skill.name}\ndescription: safe\n---\n# ${skill.name}\n\nReference.`,
              primary: true,
            }],
          });
        },
      },
      now: () => '2026-08-25T00:00:00.000Z',
    }), /late discovery batch failure/u);

    assert.deepEqual(durableRowsSeenDuringFetch, [0, 0]);
    for (const table of ['external_skills', 'external_skill_entries', 'entries', 'entry_revisions']) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()?.count,
        0,
        `${table} must roll back with the batch`,
      );
    }
    assert.ok(database.prepare('SELECT COUNT(*) AS count FROM skill_discovery_cache').get<{ count: number }>()!.count > 0, 'search cache is an operational event outside the import transaction');
  } finally {
    database.close();
  }
});
