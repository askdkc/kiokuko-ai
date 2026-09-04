import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';

test('task preparation returns before external Skill discovery and queues enrichment durably', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-task-timeout-repo-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), '{"name":"timeout-fixture","dependencies":{"typescript":"^5.0.0"}}\n');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-task-timeout-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  let started = false;
  const fetchImpl: typeof fetch = async () => {
    started = true;
    throw new Error('external discovery must not run on task_prepare');
  };
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'task-prepare-timeout-fixture',
      cwd: root,
      task: 'Build a TypeScript service',
      profileHints: { taskType: 'build', target: 'TypeScript service', expected: 'external discovery is cancellable' },
      capabilities: [
        { kind: 'skill', name: 'kiokuko-soul' },
        { kind: 'skill', name: 'memory-reasoning' },
      ],
      skillDiscoveryMode: 'official',
      fetchImpl,
    });
    assert.equal(prepared.nextAction, 'proceed');
    assert.equal(prepared.enrichment.skills, 'pending');
    assert.equal(started, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orchestration_jobs WHERE kind = 'skill_discovery' AND state = 'pending'")
      .get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});
