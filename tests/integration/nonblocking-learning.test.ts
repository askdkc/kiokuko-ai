import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { recordEntry } from '../../src/memory/entries.js';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';

test('unreviewed memory does not block a completion checkpoint or imply verified success', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kiokuko-learning-checkpoint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  execFileSync('git', ['init', '-q', root]);
  const database = openConnection(path.join(directory, 'memory.sqlite'));
  try {
    migrateDatabase(database);
    const project = (await resolveProjectWorkspace(database, root))!;
    recordEntry(database, { workspace: project.workspace, kind: 'lesson', title: 'migration expectation',
      body: 'Migration expectations follow the bundled migrations.', confidence: 0.9, createdBy: 'test', scope: {} });
    const task = await prepareOpenCodeTask(database, { cwd: root, requestId: 'nonblocking',
      task: 'Implement migration expectation code',
      profileHints: { taskType: 'build', target: 'migration code', expected: 'migration expectations follow bundled migrations', constraints: null },
      capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }], skillDiscoveryMode: 'off' });
    const result = await checkpointScopedMemory(database, { cwd: root, runId: task.run.runId,
      deliveryId: task.context!.deliveryId!, memories: [], outcome: 'completed',
      evidence: { verification: { outcome: 'fresh' } } });
    assert.equal(result.run?.status, 'completed');
    assert.equal(result.run?.memoryApplication?.complete, false);
    assert.equal((result.run as unknown as { verification: string }).verification, 'unverified');
    assert.equal(result.run?.qualifiedReasoningPaths, 0);
  } finally { database.close(); }
});
