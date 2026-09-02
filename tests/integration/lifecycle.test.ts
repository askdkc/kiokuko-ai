import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry, readEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { promoteEntry, supersedeEntry } from '../../src/memory/lifecycle.js';
import { searchEntries } from '../../src/memory/retrieval.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { importSkillSnapshot } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRequirement } from '../../src/skills/types.js';

const managedRequirement: SkillRequirement = {
  id: 'managed', technology: 'managed', aliases: ['managed'], queries: ['managed'], owners: ['owner'], repositories: ['owner/repo'],
  applicability: { languages: ['TypeScript'] }, signals: {}, reason: 'fixture',
};

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-life-'));
  const db = openConnection(path.join(directory, 'db.sqlite3'));
  migrateDatabase(db);
  return db;
}

async function passedAuditAuthority(candidate: SkillCandidate) {
  const result = await authorizeSkillMaterialization({
    id: candidate.provider,
    async search() { return { provider: candidate.provider, experimental: false, candidates: [] }; },
    async audit(audited) {
      assert.equal(audited.id, candidate.id);
      return { status: 'passed' };
    },
  }, candidate);
  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') throw new Error('fixture audit did not issue materialization authority');
  return result.authorization;
}

test('enforces candidate promotion and stale revision conflicts', async () => {
  const db = await database();
  try {
    const entry = recordEntry(db, { workspace: 'project:life', kind: 'decision', title: 'Candidate', body: 'body' });
    const promoted = promoteEntry(db, { workspace: 'project:life', entryId: entry.id, expectedRevision: 1 });
    assert.equal(promoted.status, 'verified');
    assert.equal(promoted.revision, 1);
    assert.throws(() => promoteEntry(db, { workspace: 'project:life', entryId: entry.id, expectedRevision: 1 }), /stale|candidate/i);
  } finally {
    db.close();
  }
});

test('rejects promotion of a managed external entry without changing its trust state', async () => {
  const db = await database();
  try {
    const candidate: SkillCandidate = { id: 'fixture:owner/repo:managed', provider: 'fixture', name: 'managed', slug: 'managed', source: 'owner/repo', sourceType: 'github', installUrl: 'https://github.com/owner/repo', installs: 1, duplicate: false, officialStatus: 'unknown', auditStatus: 'passed' };
    const snapshot = validateSkillSnapshot({ candidate, sourceCommit: 'dddddddddddddddddddddddddddddddddddddddd', files: [{ path: 'skills/managed/SKILL.md', content: '---\nname: Managed\n---\n# Managed\n\nReference.', primary: true }] });
    const authorization = await passedAuditAuthority(candidate);
    const imported = importSkillSnapshot(db, snapshot, documentsFromSkillSnapshot(snapshot), managedRequirement, undefined, authorization);
    const mapping = db.prepare('SELECT entry_id, entry_revision, active FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number; active: number }>(imported.skillId)!;
    assert.throws(() => promoteEntry(db, { workspace: imported.sourceWorkspace, entryId: mapping.entry_id, expectedRevision: mapping.entry_revision }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && /managed external/i.test((error as Error).message));
    const entry = db.prepare('SELECT status, trust_level FROM entries WHERE id = ?').get<{ status: string; trust_level: string }>(mapping.entry_id)!;
    assert.equal(entry.status, 'candidate');
    assert.equal(entry.trust_level, 'untrusted');
    assert.equal(db.prepare('SELECT active FROM external_skill_entries WHERE skill_id = ?').get<{ active: number }>(imported.skillId)?.active, 1);
    const managedRecord = readEntry(db, { workspace: imported.sourceWorkspace, entryId: mapping.entry_id });
    assert.throws(() => updateCandidateEntry(db, {
      workspace: imported.sourceWorkspace,
      entryId: managedRecord.id,
      expectedRevision: managedRecord.revision,
      kind: managedRecord.kind,
      title: managedRecord.title,
      body: `${managedRecord.body} edited`,
      summary: managedRecord.summary,
      scope: managedRecord.scope,
      provenance: managedRecord.provenance,
      tags: managedRecord.tags,
    }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    assert.equal(readEntry(db, { workspace: imported.sourceWorkspace, entryId: managedRecord.id }).revision, managedRecord.revision);
  } finally {
    db.close();
  }
});

test('rejects superseding a managed external entry in either lifecycle position', async () => {
  const db = await database();
  try {
    const candidate: SkillCandidate = { id: 'fixture:owner/repo:managed-supersede', provider: 'fixture', name: 'managed-supersede', slug: 'managed-supersede', source: 'owner/repo', sourceType: 'github', installUrl: 'https://github.com/owner/repo', installs: 1, duplicate: false, officialStatus: 'unknown', auditStatus: 'passed' };
    const snapshot = validateSkillSnapshot({ candidate, sourceCommit: 'dddddddddddddddddddddddddddddddddddddddd', files: [{ path: 'skills/managed-supersede/SKILL.md', content: '---\nname: Managed Supersede\n---\n# Managed\n\nReference.', primary: true }] });
    const authorization = await passedAuditAuthority(candidate);
    const imported = importSkillSnapshot(db, snapshot, documentsFromSkillSnapshot(snapshot), managedRequirement, undefined, authorization);
    const mapping = db.prepare('SELECT entry_id, entry_revision FROM external_skill_entries WHERE skill_id = ?').get<{ entry_id: string; entry_revision: number }>(imported.skillId)!;
    const ordinary = recordEntry(db, { workspace: imported.sourceWorkspace, kind: 'lesson', title: 'Replacement', body: 'replacement' });
    assert.throws(() => supersedeEntry(db, { workspace: imported.sourceWorkspace, oldEntryId: mapping.entry_id, replacementEntryId: ordinary.id, expectedRevision: mapping.entry_revision }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    assert.equal(readEntry(db, { workspace: imported.sourceWorkspace, entryId: mapping.entry_id }).status, 'candidate');
    assert.throws(() => supersedeEntry(db, { workspace: imported.sourceWorkspace, oldEntryId: ordinary.id, replacementEntryId: mapping.entry_id, expectedRevision: ordinary.revision }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    assert.equal(readEntry(db, { workspace: imported.sourceWorkspace, entryId: ordinary.id }).status, 'candidate');
  } finally {
    db.close();
  }
});

test('supersedes an entry and excludes it from normal search', async () => {
  const db = await database();
  try {
    const oldEntry = recordEntry(db, { workspace: 'project:life2', kind: 'lesson', title: 'Old', body: 'memory text' });
    const replacement = recordEntry(db, { workspace: 'project:life2', kind: 'lesson', title: 'New', body: 'current memory text' });
    const result = supersedeEntry(db, { workspace: 'project:life2', oldEntryId: oldEntry.id, replacementEntryId: replacement.id, expectedRevision: 1 });
    assert.equal(result.status, 'superseded');
    const found = searchEntries(db, { workspace: 'project:life2', query: 'memory' });
    assert.deepEqual(found.items.map((item) => item.id), [replacement.id]);
  } finally {
    db.close();
  }
});

test('supersede decodes both entries and rejects superseded replacements and cycles', async () => {
  const db = await database();
  try {
    const workspace = 'project:life-cycle-integrity';
    const first = recordEntry(db, { workspace, kind: 'lesson', title: 'First', body: 'first' });
    const second = recordEntry(db, { workspace, kind: 'lesson', title: 'Second', body: 'second' });
    supersedeEntry(db, { workspace, oldEntryId: first.id, replacementEntryId: second.id, expectedRevision: first.revision });
    assert.throws(
      () => supersedeEntry(db, { workspace, oldEntryId: second.id, replacementEntryId: first.id, expectedRevision: second.revision }),
      (error: unknown) => (error as { code?: unknown }).code === 'CONFLICT',
    );
    assert.equal(readEntry(db, { workspace, entryId: second.id }).status, 'candidate');

    const old = recordEntry(db, { workspace, kind: 'lesson', title: 'Old', body: 'old' });
    const corruptReplacement = recordEntry(db, { workspace, kind: 'lesson', title: 'Replacement v1', body: 'v1' });
    updateCandidateEntry(db, {
      workspace,
      entryId: corruptReplacement.id,
      expectedRevision: 1,
      kind: 'lesson',
      title: 'Replacement v2',
      body: 'v2',
    });
    db.prepare('UPDATE entries SET current_revision = 1 WHERE id = ?').run(corruptReplacement.id);
    assert.throws(
      () => supersedeEntry(db, { workspace, oldEntryId: old.id, replacementEntryId: corruptReplacement.id, expectedRevision: old.revision }),
      (error: unknown) => (error as { code?: unknown }).code === 'INTEGRITY_ERROR',
    );
    assert.equal(readEntry(db, { workspace, entryId: old.id }).status, 'candidate');
  } finally {
    db.close();
  }
});
