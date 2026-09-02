import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { purgeEntry } from '../../src/commands/purge.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { activateLocalEmbeddingProfile, upsertEntryEmbedding } from '../../src/embedding/store.js';
import { recordEntry, readEntry } from '../../src/memory/entries.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { requirementForOfficialSkill } from '../../src/skills/official-catalog.js';
import { importSkillSnapshot, readExternalSkill } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate } from '../../src/skills/types.js';

test('rejects individual purge of managed external entries with a typed conflict', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-purge-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const candidate: SkillCandidate = { id: 'fixture:sveltejs/ai-tools:svelte-code-writer', provider: 'fixture', name: 'svelte-code-writer', slug: 'svelte-code-writer', source: 'sveltejs/ai-tools', sourceType: 'github', installUrl: 'https://github.com/sveltejs/ai-tools', installs: 1, duplicate: false, officialStatus: 'unknown' };
    const requirement = requirementForOfficialSkill(candidate);
    assert.ok(requirement);
    const snapshot = validateSkillSnapshot({ candidate, sourceCommit: 'dddddddddddddddddddddddddddddddddddddddd', files: [{ path: 'skills/svelte-code-writer/SKILL.md', content: '---\nname: svelte-code-writer\n---\n# Svelte Code Writer\n\nReference.', primary: true }] });
    const imported = importSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), requirement);
    const before = readExternalSkill(database, imported.skillId)!;
    const mapping = before.entries[0]!;
    assert.throws(() => purgeEntry(database, { workspace: imported.sourceWorkspace, entryId: mapping.entryId, confirm: true }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && /disable the external Skill/i.test((error as Error).message));
    const after = readExternalSkill(database, imported.skillId)!;
    assert.deepEqual(after, before);
    assert.equal(readEntry(database, { workspace: imported.sourceWorkspace, entryId: mapping.entryId }).status, 'candidate');
  } finally {
    database.close();
  }
});

test('continues to purge ordinary memory entries', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-purge-ordinary-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  try {
    const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
    activateLocalEmbeddingProfile(database, profile, { replace: false, now: '2026-08-31T00:00:00.000Z' });
    const entry = recordEntry(database, { workspace: 'project:purge', kind: 'lesson', title: 'Ordinary', body: 'ordinary content' });
    upsertEntryEmbedding(database, {
      entryId: entry.id,
      profileId: profile.profileId,
      revision: entry.revision,
      contentHash: entry.contentHash,
      documentHash: 'a'.repeat(64),
      vector: [1, ...new Array<number>(383).fill(0)],
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM embedding_jobs WHERE entry_id = ?').get<{ count: number }>(entry.id)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_embeddings WHERE entry_id = ?').get<{ count: number }>(entry.id)?.count, 1);
    purgeEntry(database, { workspace: 'project:purge', entryId: entry.id, confirm: true });
    assert.throws(() => readEntry(database, { workspace: 'project:purge', entryId: entry.id }), /not found/i);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM embedding_jobs WHERE entry_id = ?').get<{ count: number }>(entry.id)?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_embeddings WHERE entry_id = ?').get<{ count: number }>(entry.id)?.count, 0);
  } finally {
    database.close();
  }
});
