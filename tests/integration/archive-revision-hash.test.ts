import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDoctor } from '../../src/commands/doctor.js';
import { exportWorkspace } from '../../src/commands/export.js';
import { importWorkspace } from '../../src/commands/import.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { canonicalContentHash, canonicalJson, canonicalTagOrder, type JsonObject } from '../../src/serialization/validate.js';

const UNSORTED_TAGS = ['漢', '😀', 'z', 'å', 'ä', 'a'];
const REVISION_TRIGGER = `CREATE TRIGGER entry_revisions_immutable_update
BEFORE UPDATE ON entry_revisions
BEGIN
    SELECT RAISE(ABORT, 'entry_revisions are immutable');
END`;

async function database(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  return { db, databasePath, directory };
}

function noncanonicalHash(entry: { kind: string; title: string; body: string; summary: string | null; scope: JsonObject; provenance: JsonObject }, tags: string[]): string {
  return canonicalContentHash({ ...entry, tags });
}

function installNoncanonicalRevisionHash(
  db: ReturnType<typeof openConnection>,
  entry: Parameters<typeof noncanonicalHash>[0],
  entryId: string,
  revision: number,
  persistedTags: string[],
): void {
  const contentHash = noncanonicalHash(entry, persistedTags);
  db.exec('DROP TRIGGER entry_revisions_immutable_update');
  db.prepare('UPDATE entry_revisions SET content_hash = ? WHERE entry_id = ? AND revision = ?')
    .run(contentHash, entryId, revision);
  db.prepare('DELETE FROM entry_revision_tags WHERE entry_id = ? AND revision = ?').run(entryId, revision);
  for (const tag of persistedTags) {
    db.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)').run(entryId, revision, tag);
  }
  db.exec(REVISION_TRIGGER);
}

function archiveWithNoncanonicalHash(content: string, tags: string[]): string {
  const lines = content.trimEnd().split('\n').slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
  const entry = lines.find((line) => line.type === 'entry');
  if (entry === undefined) throw new Error('test archive entry is missing');
  entry.content_hash = canonicalContentHash({
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    summary: entry.summary,
    scope: JSON.parse(String(entry.scope_json)),
    provenance: JSON.parse(String(entry.provenance_json)),
    tags,
  });
  const firstTagIndex = lines.findIndex((line) => line.type === 'tag');
  const withoutTags = lines.filter((line) => line.type !== 'tag');
  withoutTags.splice(firstTagIndex, 0, ...tags.map((tag) => ({ type: 'tag', entry_id: entry.id, tag })));
  const payload = `${withoutTags.map((line) => canonicalJson(line)).join('\n')}\n`;
  const checksum = createHash('sha256').update(payload, 'utf8').digest('hex');
  return `${canonicalJson({ type: 'checksum', sha256: checksum })}\n${payload}`;
}

test('doctor rejects a revision hash built from noncanonical tag order', async () => {
  const fixture = await database('doctor-noncanonical-hash');
  try {
    const entry = recordEntry(fixture.db, {
      workspace: 'project:doctor-noncanonical-hash',
      kind: 'lesson',
      title: 'Locale-independent ordering',
      body: 'Revision hashes use one canonical tag order.',
      scope: { schemaVersion: 1, visibility: 'project' },
      tags: UNSORTED_TAGS,
    });
    installNoncanonicalRevisionHash(fixture.db, entry, entry.id, entry.revision, UNSORTED_TAGS);
    const report = await runDoctor({
      databasePath: fixture.databasePath,
      runtimeDescriptorPath: path.join(fixture.directory, 'runtime.json'),
    });
    assert.deepEqual(report.checks.revisionHashes, { ok: false, count: 1 });
  } finally {
    fixture.db.close();
  }
});

test('doctor rejects a missing canonical revision-hash format marker', async () => {
  const fixture = await database('doctor-missing-revision-hash-format');
  try {
    fixture.db.prepare('DELETE FROM entry_revision_hash_format').run();
    const report = await runDoctor({
      databasePath: fixture.databasePath,
      runtimeDescriptorPath: path.join(fixture.directory, 'runtime.json'),
    });
    assert.deepEqual(report.checks.revisionHashes, { ok: false, count: 1 });
  } finally {
    fixture.db.close();
  }
});

test('memory export uses canonical tag order instead of SQLite binary order', async () => {
  const source = await database('archive-canonical-tag-source');
  const target = await database('archive-canonical-tag-target');
  const archivePath = path.join(source.directory, 'memory.jsonl');
  const tags = ['\uE000', '\u{10000}'];
  try {
    recordEntry(source.db, {
      workspace: 'project:archive-canonical-tags',
      kind: 'fact',
      title: 'Portable canonical tags',
      body: 'UTF-16 order and SQLite UTF-8 binary order differ for this pair.',
      tags,
    });
    const exported = exportWorkspace(source.db, { workspace: 'project:archive-canonical-tags' });
    const tagLines = exported.content.trimEnd().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.type === 'tag')
      .map((line) => line.tag);
    assert.deepEqual(tagLines, canonicalTagOrder(tags));

    await writeFile(archivePath, exported.content, 'utf8');
    await importWorkspace(target.db, { input: archivePath });
    assert.equal(exportWorkspace(target.db, { workspace: 'project:archive-canonical-tags' }).content, exported.content);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('memory archive rejects a noncanonical revision hash at import and export boundaries', async () => {
  const source = await database('archive-noncanonical-source');
  const target = await database('archive-noncanonical-target');
  const archivePath = path.join(source.directory, 'noncanonical.jsonl');
  try {
    const entry = recordEntry(source.db, {
      workspace: 'project:archive-noncanonical-hash',
      kind: 'lesson',
      title: 'Noncanonical archive hash',
      body: 'Revision hashes are checked at every persistence boundary.',
      scope: { schemaVersion: 1, visibility: 'project' },
      tags: UNSORTED_TAGS,
    });
    const canonicalArchive = exportWorkspace(source.db, { workspace: entry.workspace }).content;
    await writeFile(archivePath, archiveWithNoncanonicalHash(canonicalArchive, UNSORTED_TAGS), 'utf8');
    await assert.rejects(importWorkspace(target.db, { input: archivePath, dryRun: true }), { code: 'INTEGRITY_ERROR' });

    installNoncanonicalRevisionHash(source.db, entry, entry.id, entry.revision, UNSORTED_TAGS);
    assert.throws(() => exportWorkspace(source.db, { workspace: entry.workspace }), { code: 'INTEGRITY_ERROR' });
  } finally {
    source.db.close();
    target.db.close();
  }
});
