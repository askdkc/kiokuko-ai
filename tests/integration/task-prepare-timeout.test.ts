import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for external discovery request');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test('task preparation propagates cancellation into external skill discovery without converting it to success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-task-timeout-repo-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), '{"name":"timeout-fixture","dependencies":{"typescript":"^5.0.0"}}\n');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-task-timeout-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  const controller = new AbortController();
  let started = false;
  let observedSignal: AbortSignal | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    started = true;
    observedSignal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => {
      if (observedSignal?.aborted) {
        reject(observedSignal.reason);
        return;
      }
      observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true });
    });
  };
  try {
    const preparation = prepareOpenCodeTask(database, {
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
      signal: controller.signal,
    });
    await waitFor(() => started);
    controller.abort();
    await assert.rejects(preparation, (error: unknown) => error === controller.signal.reason);
    assert.equal(observedSignal?.aborted, true);
  } finally {
    database.close();
  }
});
