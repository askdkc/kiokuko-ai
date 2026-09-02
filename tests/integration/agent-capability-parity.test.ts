import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { recordContextFeedback } from '../../src/context/feedback.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const token = 'd'.repeat(64);
const task = 'beacon';
const SOUL_CAPABILITY = { kind: 'skill', name: 'kiokuko-soul' } as const;
const profileHints = {
  taskType: 'build' as const,
  target: 'src/new.ts',
  expected: 'passes',
  constraints: null,
};
const requiredMemoryPolicy = {
  memoryReasoningRequired: true,
  contextWithheld: true,
  withheldReason: 'memory_reasoning_missing',
  deliveryEmpty: true,
  storedEntryCount: 1,
} as const;

test('prior cross-run helpful feedback withholds the same weak memory without stopping MCP or generic Agent tasks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-capability-feedback-parity-'));
  const repositoryRoot = path.join(directory, 'repository');
  const databasePath = path.join(directory, 'data.sqlite3');
  execFileSync('git', ['init', '-q', repositoryRoot]);
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  let workspace = '';
  try {
    const project = await resolveProjectWorkspace(database, repositoryRoot);
    assert.ok(project);
    workspace = project.workspace;
    const entry = recordEntry(database, {
      workspace,
      kind: 'reference',
      title: 'xxbeaconzz historical note',
      body: 'A prior observation with no actionable lexical token.',
      tags: [],
    });
    const prior = await prepareAgentTask(database, {
      requestId: 'feedback-parity-prior',
      cwd: repositoryRoot,
      task,
      profileHints,
      capabilities: [SOUL_CAPABILITY, { kind: 'skill', name: 'memory-reasoning' }],
      client: { kind: 'test', sessionId: 'feedback-prior' },
      skillDiscoveryMode: 'off',
    });
    const delivered = prior.context?.items.find((item) => item.entryId === entry.id);
    assert.ok(delivered);
    assert.equal(delivered.selectionReasons.includes('literal_fallback_match'), true);
    assert.equal(delivered.selectionReasons.some((reason) => [
      'exact_signal_match',
      'word_match',
      'lexical_match',
      'cjk_window_match',
      'applicability_match',
      'tag_match',
      'changed_path_match',
      'error_signature_match',
      'helpful_feedback',
    ].includes(reason)), false);
    assert.ok(prior.context?.deliveryId);
    recordContextFeedback(database, {
      workspace,
      feedbackId: 'feedback-parity-helpful',
      deliveryId: prior.context.deliveryId,
      entryId: entry.id,
      runId: prior.run.runId,
      verdict: 'helpful',
      comment: null,
      actor: 'test',
      idempotencyKey: 'feedback-parity-helpful-key',
      createdAt: '2026-08-25T00:00:00.000Z',
    });

    const mcp = await prepareAgentTask(database, {
      requestId: 'feedback-parity-mcp-missing',
      cwd: repositoryRoot,
      task,
      profileHints,
      capabilities: [SOUL_CAPABILITY],
      client: { kind: 'test', sessionId: 'feedback-mcp-missing' },
      skillDiscoveryMode: 'off',
    });
    assert.equal(mcp.nextAction, 'proceed');
    assert.deepEqual(mcp.memoryPolicy, requiredMemoryPolicy);
    assert.equal(mcp.context, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(mcp.run.runId)?.count, 0);
  } finally {
    database.close();
  }

  const runtimeDirectory = path.join(directory, 'runtime');
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    capabilityToken: token,
  });
  let runId = '';
  try {
    const response = await fetch(`${runtime.url}/api/v1/agent/runs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'feedback-agent-missing',
      },
      body: JSON.stringify({
        apiVersion: '1',
        workspace,
        client: { kind: 'generic' },
        task: { title: task, query: task, profileHints },
        captureProfile: 'minimal',
        coverage: {
          run: 'unavailable',
          tool: 'unavailable',
          command: 'unavailable',
          file: 'unavailable',
          approval: 'unavailable',
        },
        capabilities: [SOUL_CAPABILITY],
      }),
    });
    assert.equal(response.status, 200);
    const envelope = await response.json() as { data: Record<string, any> };
    runId = envelope.data.runId as string;
    assert.equal(envelope.data.nextAction, 'proceed');
    assert.deepEqual(envelope.data.memoryPolicy, requiredMemoryPolicy);
    assert.equal(envelope.data.context, null);
    assert.deepEqual(envelope.data.recommendations, []);
  } finally {
    await runtime.close();
  }

  const verified = openConnection(databasePath);
  try {
    assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, 0);
  } finally {
    verified.close();
  }
});
