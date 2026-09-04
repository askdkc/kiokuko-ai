import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { readTaskContextRevisions } from '../../src/context/revisions.js';
import { openConnection } from '../../src/db/connection.js';
import { createOrchestrationWorker } from '../../src/orchestration/worker.js';

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul' },
  { kind: 'skill', name: 'kiokuko-enno-oduno' },
  { kind: 'skill', name: 'memory-reasoning' },
] as const;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-context-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'svelte-fixture',
    dependencies: { svelte: '^5.0.0' },
  }));
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-data-'));
  const databasePath = path.join(dataDirectory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  return { root, dataDirectory, database: openConnection(databasePath) };
}

function input(root: string, requestId: string, mode: 'off' | 'official' = 'official') {
  return {
    requestId,
    cwd: root,
    task: 'Repair a Svelte component and verify it',
    profileHints: {
      taskType: 'debug' as const,
      target: 'src/Component.svelte',
      expected: 'the focused component test passes',
      constraints: null,
    },
    capabilities: [...capabilities],
    client: { kind: 'opencode' as const, sessionId: `session-${requestId}` },
    skillDiscoveryMode: mode,
  };
}

async function waitForJob(database: ReturnType<typeof openConnection>, runId: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const state = database.prepare(`
      SELECT state FROM orchestration_jobs
      WHERE run_id = ? AND kind = 'skill_discovery'
      ORDER BY created_at DESC LIMIT 1
    `).get<{ state: string }>(runId)?.state;
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('background Skill discovery did not settle');
}

test('task_prepare never performs external Skill I/O on its hot path', async () => {
  const { root, database } = await fixture();
  try {
    let fetchCalls = 0;
    const prepared = await prepareOpenCodeTask(database, {
      ...input(root, 'hot-path'),
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('hot path fetch is forbidden');
      },
    });
    assert.equal(fetchCalls, 0);
    assert.equal(prepared.nextAction, 'proceed');
    assert.equal(prepared.skillDiscovery.attempted, false);
    assert.equal(prepared.enrichment.skills, 'pending');
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM orchestration_jobs
      WHERE run_id = ? AND kind = 'skill_discovery' AND state = 'pending'
    `).get<{ count: number }>(prepared.run.runId)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills')
      .get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('background Skill discovery adds reference-only late context without installation', async () => {
  const { root, dataDirectory, database } = await fixture();
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (request) => {
    const url = new URL(String(request));
    urls.push(url.href);
    if (url.hostname !== 'skills.sh') throw new Error(`unexpected source access: ${url.href}`);
    return new Response(JSON.stringify({
      skills: [{
        id: 'sveltejs/ai-tools/svelte-code-writer',
        name: 'svelte-code-writer',
        installs: 3,
        source: 'sveltejs/ai-tools',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const worker = createOrchestrationWorker({ database, dataDirectory, fetchImpl, intervalMs: 10 });
  try {
    const prepared = await prepareOpenCodeTask(database, input(root, 'background'));
    worker.start();
    assert.equal(await waitForJob(database, prepared.run.runId), 'completed');
    const late = readTaskContextRevisions(database, {
      runId: prepared.run.runId,
      afterContextRevision: prepared.contextRevision,
    });
    const recommendation = late.find((revision) => revision.context.kind === 'skill_recommendation');
    assert.ok(recommendation);
    assert.equal(recommendation.context.source, 'external_reference_only');
    assert.equal(recommendation.context.autoInstall, false);
    assert.equal(recommendation.context.autoExecute, false);
    assert.ok(urls.length > 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_skills')
      .get<{ count: number }>()?.count, 0);
  } finally {
    await worker.close();
    database.close();
  }
});

test('Skill discovery mode off is immediately ready and queues no discovery job', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, input(root, 'disabled', 'off'));
    assert.equal(prepared.skillDiscovery.mode, 'off');
    assert.equal(prepared.enrichment.skills, 'ready');
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM orchestration_jobs
      WHERE run_id = ? AND kind = 'skill_discovery'
    `).get<{ count: number }>(prepared.run.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('requestId replay is idempotent and changed input is rejected', async () => {
  const { root, database } = await fixture();
  try {
    const first = await prepareOpenCodeTask(database, input(root, 'idempotent'));
    const replay = await prepareOpenCodeTask(database, input(root, 'idempotent'));
    assert.equal(replay.run.runId, first.run.runId);
    assert.ok(replay.contextRevision >= first.contextRevision);
    await assert.rejects(prepareOpenCodeTask(database, {
      ...input(root, 'idempotent'),
      task: 'A different task must not reuse the same request identity',
    }), /idempotency|different input|request/iu);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs')
      .get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('unresolved Akinator questions remain advisory while the run is active', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'advisory-question', cwd: root, task: 'Improve this project',
      capabilities: [...capabilities], client: { kind: 'opencode', sessionId: 'session-advisory-question' },
      skillDiscoveryMode: 'off',
    });
    assert.equal(prepared.intake.status, 'needs_answer');
    assert.equal(prepared.run.status, 'active');
    assert.deepEqual(prepared.continuationPolicy, { codingAllowed: true, blockingReason: null });
    assert.equal(prepared.nextAction, 'proceed');
  } finally {
    database.close();
  }
});
