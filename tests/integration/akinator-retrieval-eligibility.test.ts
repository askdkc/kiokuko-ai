import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { retrievableWorkspaceEntryCount } from '../../src/memory/hybrid-retrieval.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';

test('Akinator retrieval fails closed for an external marker without a managed import mapping', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-akinator-retrieval-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-akinator-retrieval-db-'));
  const database = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  migrateDatabase(database);

  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    const ordinary = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      title: 'Builder convention',
      body: 'Write the focused regression before changing production code.',
      tags: ['bot:builder'],
    }, { now: '2026-08-20T00:00:00.000Z' });
    for (let index = 0; index < 13; index += 1) {
      recordEntry(database, {
        workspace: project.workspace,
        kind: 'reference',
        status: 'candidate',
        title: `Legacy synchronized skill ${index}`,
        body: `Detached legacy entry ${index} must never be delivered as an active skill.`,
        scope: {
          retrievalScope: 'ecosystem',
          applicability: { frameworks: [{ name: 'Example' }] },
        },
        provenance: {
          type: 'source_sync',
          reference: 'github:legacy/example',
        },
        trustLevel: 'untrusted',
        tags: ['bot:builder', 'external:skill'],
        createdBy: 'kiokuko-source-sync',
        actor: 'kiokuko-source-sync',
      }, { now: `2026-08-20T00:${String(index + 1).padStart(2, '0')}:00.000Z` });
    }

    await assert.rejects(
      prepareOpenCodeTask(database, {
        requestId: 'akinator-retrieval-eligibility',
        cwd: root,
        task: 'Implement a feature',
        profileHints: {
          taskType: 'build',
          target: 'src/feature.ts',
          expected: 'tests pass',
          constraints: null,
        },
        capabilities: [{ kind: 'skill', name: 'memory-reasoning' }],
        client: { kind: 'opencode' as const, sessionId: 'akinator-retrieval-eligibility' },
        skillDiscoveryMode: 'off',
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INTEGRITY_ERROR'
        && error.message === 'Stored context external entry mapping is missing',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries WHERE id = ?').get<{ count: number }>(ordinary.id)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skill_entries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('empty-delivery diagnostics count 1,000 entries with one set-based statement', () => {
  const database = openConnection(':memory:');
  migrateDatabase(database);
  const insertEntry = database.prepare(`
    INSERT INTO entries (
      id, workspace, status, trust_level, confidence, current_revision,
      superseded_by, created_by, created_at, updated_at, verified_at
    ) VALUES (?, 'project:count', 'verified', 'user_asserted', 1, 1,
      NULL, 'test', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', NULL)
  `);
  const insertRevision = database.prepare(`
    INSERT INTO entry_revisions (
      entry_id, workspace, revision, kind, title, body, summary, scope_json,
      provenance_json, content_hash, created_by, created_at
    ) VALUES (?, 'project:count', 1, 'lesson', ?, 'body', NULL, '{}', '{}', ?,
      'test', '2026-08-30T00:00:00.000Z')
  `);
  try {
    database.exec('BEGIN');
    for (let index = 0; index < 1_000; index += 1) {
      const id = `count-entry-${index}`;
      insertEntry.run(id);
      insertRevision.run(id, id, index.toString(16).padStart(64, '0'));
    }
    database.exec('COMMIT');

    let statements = 0;
    const countedDatabase: SqliteDatabase = {
      filePath: database.filePath,
      exec: (sql) => database.exec(sql),
      prepare: (sql) => {
        statements += 1;
        return database.prepare(sql);
      },
      close: () => undefined,
    };
    assert.equal(retrievableWorkspaceEntryCount(countedDatabase, 'project:count'), 1_000);
    assert.equal(statements, 1);
  } finally {
    database.close();
  }
});
