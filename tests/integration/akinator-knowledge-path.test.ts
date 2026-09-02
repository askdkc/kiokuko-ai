import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { curateMemoryCandidates } from '../../src/memory/curator.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';

test('counts only verified independent Akinator runs and makes repeated portable knowledge skill-ready', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-reasoning-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-reasoning-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    let workspace = '';
    for (const sessionId of ['client-run-a', 'client-run-b']) {
      const prepared = await prepareAgentTask(database, {
        requestId: `knowledge-path-${sessionId}`,
        cwd: root,
        task: 'SQLite migration failuresを安全に復旧する',
        profileHints: {
          taskType: 'debug',
          target: 'SQLite migration',
          expected: '復旧テストが成功しschemaが一致する',
          constraints: '適用済みmigrationを破壊しない',
        },
        client: { kind: 'test', sessionId },
      });
      workspace = prepared.project.workspace;
      const checkpoint = await checkpointScopedMemory(database, {
        cwd: root,
        runId: prepared.run.runId,
        outcome: 'completed',
        memories: [{
          kind: 'lesson',
          title: 'Reusable SQLite migration recovery workflow',
          summary: 'SQLite migration failuresを安全に復旧する手順。',
          body: '失敗したversionを確認し、backupを復元し、schemaを検証してから再試行する。',
          memoryClass: 'troubleshooting',
          applicability: { databases: ['SQLite'], tools: ['migration'] },
          tags: ['workflow', 'skill:database'],
        }],
        evidence: {
          tests: [{ runner: 'node:test', target: 'migration recovery', outcome: 'passed' }],
          verification: { outcome: 'fresh' },
        },
      });
      assert.equal(checkpoint.run?.qualifiedReasoningPaths, 1);
    }

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_reasoning_paths WHERE qualified = 1').get<{ count: number }>()?.count, 2);
    const curated = await curateMemoryCandidates(database, { workspace, skillReadyOnly: true });
    assert.equal(curated.candidates.length, 1, 'same generalized concept is shown once');
    const candidate = curated.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.knowledge.qualifiedHits, 2);
    assert.equal(candidate.knowledge.independentRuns, 2);
    assert.equal(candidate.knowledge.independentWorkspaces, 1);
    assert.equal(candidate.knowledge.skillReady, true);
    assert.equal(candidate.knowledge.averageCompleteness, 1);
  } finally {
    database.close();
  }
});

test('does not qualify retrieval-free runs without fresh verification or a passing test', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-unqualified-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-unqualified-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const prepared = await prepareAgentTask(database, {
      requestId: 'knowledge-path-unverified',
      cwd: root,
      task: '設定手順を実装する',
      profileHints: { taskType: 'build', target: '設定', expected: '設定が反映される' },
      client: { kind: 'test', sessionId: 'unverified' },
    });
    const checkpoint = await checkpointScopedMemory(database, {
      cwd: root,
      runId: prepared.run.runId,
      outcome: 'completed',
      memories: [{
        kind: 'lesson',
        title: 'Reusable configuration workflow',
        body: '設定を確認して適用する再利用可能な手順。',
        memoryClass: 'workflow',
        applicability: { tools: ['configuration'] },
      }],
    });
    assert.equal(checkpoint.run?.reasoningPaths, 1);
    assert.equal(checkpoint.run?.qualifiedReasoningPaths, 0);
    const row = database.prepare('SELECT qualified, disqualification_reasons_json FROM akinator_reasoning_paths').get<{ qualified: number; disqualification_reasons_json: string }>();
    assert.equal(row?.qualified, 0);
    assert.match(row?.disqualification_reasons_json ?? '', /no-fresh-verification-or-passing-test/u);
  } finally {
    database.close();
  }
});
