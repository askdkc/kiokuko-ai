import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBackup } from '../../src/commands/backup.js';
import { exportWorkspace } from '../../src/commands/export.js';
import { importWorkspace } from '../../src/commands/import.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { buildEmbeddingDocumentForProfile } from '../../src/embedding/document.js';
import { inspectEmbeddingHealth } from '../../src/embedding/diagnostics.js';
import { JavaScriptVectorSearchBackend } from '../../src/embedding/javascript-backend.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { activateLocalEmbeddingProfile, readEntryEmbedding, upsertEntryEmbedding } from '../../src/embedding/store.js';
import { listEmbeddingJobs } from '../../src/embedding/jobs.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';

const vectorIntegrityEnvironment = {
  KIOKUKO_EMBEDDINGS: 'off',
  KIOKUKO_VECTOR_BACKEND: 'javascript',
} satisfies NodeJS.ProcessEnv;
const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
const timestamp = '2026-08-31T00:00:00.000Z';

async function database(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-embedding-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const db = openConnection(databasePath);
  migrateDatabase(db);
  activateLocalEmbeddingProfile(db, profile, { replace: false, now: timestamp });
  return { db, databasePath, directory };
}

function recordEmbeddedEntry(db: ReturnType<typeof openConnection>, workspace: string, id: string) {
  const entry = recordEntry(db, {
    workspace,
    kind: 'lesson',
    title: 'Portable canonical memory',
    body: 'Derived vectors are rebuilt from canonical memory after import.',
    createdBy: 'test',
  }, { idFactory: () => id, now: timestamp });
  upsertEntryEmbedding(db, {
    entryId: entry.id,
    profileId: profile.profileId,
    revision: entry.revision,
    contentHash: entry.contentHash,
    documentHash: buildEmbeddingDocumentForProfile({
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      body: entry.body,
      tags: entry.tags,
      scope: entry.scope,
    }, profile.identity).documentHash,
    vector: [1, ...new Array<number>(383).fill(0)],
    createdAt: timestamp,
  });
  return entry;
}

test('workspace export omits derived embedding rows and import enqueues regeneration', async () => {
  const source = await database('archive-source');
  const target = await database('archive-target');
  const workspace = 'project:embedding-archive';
  const archivePath = path.join(source.directory, 'workspace.jsonl');
  try {
    const entry = recordEmbeddedEntry(source.db, workspace, 'entry-embedding-archive');
    const archive = exportWorkspace(source.db, { workspace }).content;
    const records = archive.trimEnd().split('\n').map((line) => JSON.parse(line) as { type?: string });
    assert.deepEqual([...new Set(records.map((record) => record.type))].sort(), ['audit', 'checksum', 'entry', 'manifest']);
    assert.doesNotMatch(archive, /embedding_profiles|entry_embeddings|embedding_jobs|query_embeddings/u);

    await writeFile(archivePath, archive, 'utf8');
    const result = await importWorkspace(target.db, { input: archivePath });
    assert.equal(result.imported, 1);
    assert.deepEqual(listEmbeddingJobs(target.db).map((job) => ({ entryId: job.entryId, state: job.state })), [
      { entryId: entry.id, state: 'pending' },
    ]);
    assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM entry_embeddings').get<{ count: number }>()?.count, 0);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('full SQLite backup preserves vectors and restored doctor detects later corruption', async () => {
  const source = await database('backup-source');
  const backupPath = path.join(source.directory, 'full-backup.sqlite3');
  const entry = recordEmbeddedEntry(source.db, 'project:embedding-backup', 'entry-embedding-backup');
  try {
    await createBackup(backupPath, source.databasePath);
  } finally {
    source.db.close();
  }

  const restored = openConnection(backupPath);
  try {
    assert.deepEqual([...readEntryEmbedding(restored, { entryId: entry.id, profileId: profile.profileId })!.vector], [1, ...new Array<number>(383).fill(0)]);
    const backend = new JavaScriptVectorSearchBackend();
    // A database backup carries vectors, not the separately installed model
    // artifacts. Check vector integrity with semantic setup disabled here.
    const healthy = inspectEmbeddingHealth(restored, vectorIntegrityEnvironment, backend);
    assert.equal(healthy.check.ok, true);
    assert.equal(healthy.status.readyVectors, 1);

    updateCandidateEntry(restored, {
      workspace: entry.workspace,
      entryId: entry.id,
      expectedRevision: entry.revision,
      kind: entry.kind,
      title: 'Updated canonical memory',
      body: entry.body,
      createdBy: 'test',
      now: '2026-08-31T00:00:01.000Z',
    });
    const stale = inspectEmbeddingHealth(restored, vectorIntegrityEnvironment, backend);
    assert.equal(stale.status.staleVectors, 1);
    assert.equal(stale.status.missingVectors, 1);

    restored.prepare('UPDATE entry_embeddings SET vector_hash = ? WHERE entry_id = ?').run('c'.repeat(64), entry.id);
    const corrupt = inspectEmbeddingHealth(restored, vectorIntegrityEnvironment, backend);
    assert.equal(corrupt.check.ok, false);
    assert.ok(corrupt.check.count > 0);
  } finally {
    restored.close();
  }
});
