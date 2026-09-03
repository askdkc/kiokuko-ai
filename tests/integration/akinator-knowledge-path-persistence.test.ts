import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { recordKnowledgePathsInTransaction } from '../../src/akinator/knowledge-path.js';
import { initializeDatabase } from '../../src/commands/init.js';
import type { SqliteDatabase, SqliteRow, SqliteStatement, SqliteValue } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { withImmediateTransaction } from '../../src/db/transaction.js';
import { KiokukoError } from '../../src/errors.js';
import { readEntry, recordEntry } from '../../src/memory/entries.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';

function ignoredKnowledgePathInsert(database: SqliteDatabase): SqliteDatabase {
  return {
    filePath: database.filePath,
    exec(sql: string): void {
      database.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const statement = database.prepare(sql);
      if (!sql.includes('INSERT INTO akinator_reasoning_paths')) return statement;
      return {
        run(..._parameters: SqliteValue[]): void {
          // Simulate an adapter/trigger path that reports no exception but does not persist.
        },
        get<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T | undefined {
          return statement.get<T>(...parameters);
        },
        all<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T[] {
          return statement.all<T>(...parameters);
        },
      };
    },
    close(): void {
      database.close();
    },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof KiokukoError && error.code === code;
}

test('reasoning-path persistence rejects duplicate identities, path-id collisions, and silent no-op writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-reasoning-persistence-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-reasoning-persistence-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'knowledge-path-persistence',
      cwd: root,
      task: 'SQLite migration failuresを安全に復旧する',
      profileHints: {
        taskType: 'debug',
        target: 'SQLite migration',
        expected: '復旧テストが成功しschemaが一致する',
        constraints: '適用済みmigrationを破壊しない',
      },
      client: { kind: 'opencode' as const, sessionId: 'knowledge-path-persistence' },
    });
    const checkpoint = await checkpointScopedMemory(database, {
      cwd: root,
      runId: prepared.run.runId,
      outcome: 'completed',
      memories: [{
        kind: 'lesson',
        title: 'Reusable SQLite migration recovery workflow',
        body: '失敗したversionを確認し、backupを復元し、schemaを検証してから再試行する。',
        memoryClass: 'troubleshooting',
        applicability: { databases: ['SQLite'], tools: ['migration'] },
      }],
      evidence: {
        tests: [{ runner: 'node:test', target: 'migration recovery', outcome: 'passed' }],
        verification: { outcome: 'fresh' },
      },
    });
    const workspace = prepared.project.workspace;
    const recordedEntry = readEntry(database, { workspace, entryId: checkpoint.entries[0]!.id });
    const storedPath = database.prepare(`
      SELECT path_id, created_at, verification_json
        FROM akinator_reasoning_paths
       WHERE run_id = ?
    `).get<{ path_id: string; created_at: string; verification_json: string }>(prepared.run.runId);
    assert.ok(storedPath);
    const verification = JSON.parse(storedPath.verification_json) as {
      fresh: boolean;
      passedTests: number;
      passedCommands: number;
      evidenceCount: number;
    };
    const input = {
      runId: prepared.run.runId,
      workspace,
      outcome: 'completed' as const,
      verification,
      createdAt: storedPath.created_at,
    };
    const initialCount = database.prepare(
      'SELECT COUNT(*) AS count FROM akinator_reasoning_paths',
    ).get<{ count: number }>()?.count;

    assert.throws(() => withImmediateTransaction(database, () => recordKnowledgePathsInTransaction(database, {
      ...input,
      entries: [recordedEntry],
      idFactory: () => 'new-id-for-duplicate-logical-path',
    })), hasCode('CONFLICT'));
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM akinator_reasoning_paths',
    ).get<{ count: number }>()?.count, initialCount);

    const collisionEntry = recordEntry(database, {
      workspace,
      kind: 'lesson',
      title: 'Distinct recovery verification workflow',
      body: '復旧後のschemaとデータを別の検証手順で確認する。',
    }, { idFactory: () => 'reasoning-path-collision-entry' });
    assert.throws(() => withImmediateTransaction(database, () => recordKnowledgePathsInTransaction(database, {
      ...input,
      entries: [collisionEntry],
      idFactory: () => storedPath.path_id,
    })), hasCode('CONFLICT'));
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM akinator_reasoning_paths',
    ).get<{ count: number }>()?.count, initialCount);

    const ignoredDatabase = ignoredKnowledgePathInsert(database);
    assert.throws(() => withImmediateTransaction(ignoredDatabase, () => recordKnowledgePathsInTransaction(ignoredDatabase, {
      ...input,
      entries: [collisionEntry],
      idFactory: () => 'reasoning-path-no-op-write',
    })), hasCode('INTEGRITY_ERROR'));
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM akinator_reasoning_paths',
    ).get<{ count: number }>()?.count, initialCount);
  } finally {
    database.close();
  }
});
