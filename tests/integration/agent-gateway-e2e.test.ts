import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServerClient } from '../../src/client/server-client.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { useRepository } from '../../src/commands/use.js';
import { runCli } from '../../src/cli.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const workspace = 'smoke';

async function captureCli(args: string[], descriptorPath: string): Promise<Record<string, any>> {
  let stdout = '';
  let stderr = '';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stderr.write;
  try {
    const code = await runCli(['node', 'kiokuko-ai', ...args], {
      agent: { createClient: () => createServerClient({ descriptorPath, isPidAlive: () => true }) },
    });
    assert.equal(code, 0, stderr || stdout);
    assert.equal(stderr, '');
    return JSON.parse(stdout) as Record<string, any>;
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

async function writeJson(directory: string, name: string, value: unknown): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

async function answerUntilActive(
  opened: Record<string, any>,
  descriptorPath: string,
  capabilitiesPath: string,
): Promise<Record<string, any>> {
  let response = opened;
  const answers: Record<string, string> = { taskType: 'build', target: 'src/gateway', expected: 'tests pass', constraints: 'none' };
  for (let count = 0; response.data.runStatus === 'intake' && count < 3; count += 1) {
    const question = response.data.currentQuestion;
    assert.equal(typeof question?.id, 'string');
    response = await captureCli([
      'agent', 'answer', response.data.runId,
      '--question-id', question.id,
      '--value', answers[question.id] ?? 'explicit answer',
      '--capabilities-json', capabilitiesPath,
      '--json',
    ], descriptorPath);
  }
  assert.equal(response.data.runStatus, 'active');
  assert.ok(['ready', 'exhausted'].includes(response.data.intakeStatus));
  assert.equal(response.data.untrusted, true);
  return response;
}

test('generic CLI completes the gateway lifecycle over real TCP and persists one idempotent graph', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-gateway-e2e-'));
  const repository = path.join(root, 'repository');
  const databasePath = path.join(root, 'data.sqlite3');
  const runtimeDirectory = path.join(root, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const inputs = path.join(root, 'inputs');
  await mkdir(repository);
  await mkdir(inputs);
  await initializeDatabase({ databasePath });
  await useRepository({ cwd: repository, root: repository, workspace, allowDirectory: true, noAgentFile: true, databasePath });
  const database = openConnection(databasePath);
  try {
    recordEntry(database, {
      workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Relevant gateway lesson',
      body: 'Use the generic HTTP contract and verify after mutation.',
      summary: 'Generic gateway verification lesson',
      tags: ['role:builder', 'task:build'],
      trustLevel: 'source_verified',
      confidence: 0.9,
      createdBy: 'e2e',
      actor: 'e2e',
    }, { now: '2026-08-20T00:00:00.000Z' });
  } finally {
    database.close();
  }

  const capabilitiesPath = await writeJson(inputs, 'capabilities.json', [
    { kind: 'skill', name: 'kiokuko-soul' },
    { kind: 'skill', name: 'memory-reasoning' },
  ]);
  const runtime = await startAgentHttpServer({ databasePath, runtimeDirectory, descriptorPath });
  try {
    const opened = await captureCli([
      'agent', 'open',
      '--workspace', workspace,
      '--client', 'generic',
      '--task', 'Implement and verify the gateway',
      '--capabilities-json', capabilitiesPath,
      '--json',
    ], descriptorPath);
    assert.equal(opened.operation, 'agent.open');
    const active = await answerUntilActive(opened, descriptorPath, capabilitiesPath);
    const runId = active.data.runId as string;
    assert.equal(active.data.context?.untrusted, true);

    const eventBody = {
      idempotencyKey: 'e2e-events-key',
      apiVersion: '1',
      events: [
        { eventId: 'e2e-tool', sourceEventId: 'source-tool', eventType: 'tool.completed', actor: 'generic', occurredAt: '2026-08-20T00:00:01.000Z', outcome: 'success', payload: { tool: 'terminal', mutated: true } },
        { eventId: 'e2e-file', sourceEventId: 'source-file', eventType: 'file.changed', actor: 'generic', occurredAt: '2026-08-20T00:00:02.000Z', payload: { path: 'src/gateway/index.ts' } },
        { eventId: 'e2e-error', sourceEventId: 'source-error', eventType: 'error.recorded', actor: 'generic', occurredAt: '2026-08-20T00:00:03.000Z', payload: { signature: 'bounded failure' } },
        { eventId: 'e2e-test', sourceEventId: 'source-test', eventType: 'test.completed', actor: 'generic', occurredAt: '2026-08-20T00:00:04.000Z', outcome: 'passed', payload: { suite: 'focused' } },
      ],
    };
    const eventPath = await writeJson(inputs, 'events.json', eventBody);
    const firstEvents = await captureCli(['agent', 'events', runId, '--input-json', eventPath, '--json'], descriptorPath);
    const replayEvents = await captureCli(['agent', 'events', runId, '--input-json', eventPath, '--json'], descriptorPath);
    assert.deepEqual(replayEvents, firstEvents);

    const checkpointPath = await writeJson(inputs, 'checkpoint.json', {
      idempotencyKey: 'e2e-checkpoint-key',
      apiVersion: '1',
      taskProfileRevision: { target: 'src/gateway/index.ts' },
    });
    const revised = await captureCli([
      'agent', 'checkpoint', runId,
      '--input-json', checkpointPath,
      '--capabilities-json', capabilitiesPath,
      '--json',
    ], descriptorPath);
    assert.equal(revised.data.taskProfile.target, 'src/gateway/index.ts');

    const verificationPath = await writeJson(inputs, 'verification.json', {
      idempotencyKey: 'e2e-verification-key',
      apiVersion: '1',
      events: [{ eventId: 'e2e-verify', sourceEventId: 'source-verify', eventType: 'verification.recorded', actor: 'generic', occurredAt: '2026-08-20T00:00:05.000Z', outcome: 'passed', payload: { suite: 'full' } }],
    });
    await captureCli(['agent', 'events', runId, '--input-json', verificationPath, '--json'], descriptorPath);
    const finalCheckpointPath = await writeJson(inputs, 'final-checkpoint.json', {
      idempotencyKey: 'e2e-final-checkpoint-key', apiVersion: '1', currentStep: 'final verification',
    });
    const checkpoint = await captureCli([
      'agent', 'checkpoint', runId,
      '--input-json', finalCheckpointPath,
      '--capabilities-json', capabilitiesPath,
      '--json',
    ], descriptorPath);
    assert.equal(checkpoint.data.taskProfile.target, 'src/gateway/index.ts');
    assert.equal(checkpoint.data.projection.evidenceState, 'fresh');
    assert.equal(checkpoint.data.context?.untrusted, true);

    const feedbackPath = await writeJson(inputs, 'feedback.json', {
      idempotencyKey: 'e2e-feedback-key', apiVersion: '1', category: 'run', feedbackId: 'e2e-feedback', outcome: 'completed', rating: 5,
    });
    const feedback = await captureCli(['agent', 'feedback', runId, '--input-json', feedbackPath, '--json'], descriptorPath);
    assert.equal(feedback.data.untrusted, true);

    const closePath = await writeJson(inputs, 'close.json', { idempotencyKey: 'e2e-close-key', apiVersion: '1', status: 'completed' });
    const closed = await captureCli(['agent', 'close', runId, '--input-json', closePath, '--json'], descriptorPath);
    assert.equal(closed.data.runStatus, 'completed');

    const persisted = openConnection(databasePath);
    try {
      assert.equal(persisted.prepare('SELECT client_kind FROM ledger_runs WHERE run_id = ?').get<{ client_kind: string }>(runId)?.client_kind, 'generic');
      assert.equal(persisted.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(runId)?.status, 'completed');
      assert.equal(persisted.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ? AND event_id = ?').get<{ count: number }>(runId, 'e2e-tool')?.count, 1);
      assert.equal(persisted.prepare('SELECT COUNT(*) AS count FROM run_feedback WHERE run_id = ?').get<{ count: number }>(runId)?.count, 1);
      assert.ok((persisted.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? 0) >= 1);
    } finally {
      persisted.close();
    }
  } finally {
    await runtime.close();
  }
  await assert.rejects(access(descriptorPath));
});


test('OpenCode uses the authenticated gateway contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-client-kinds-e2e-'));
  const databasePath = path.join(root, 'data.sqlite3');
  const runtimeDirectory = path.join(root, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  await initializeDatabase({ databasePath });
  const runtime = await startAgentHttpServer({ databasePath, runtimeDirectory, descriptorPath });
  try {
    for (const client of ['opencode']) {
      const opened = await captureCli(['agent', 'open', '--workspace', workspace, '--client', client, '--task', `Smoke ${client}`, '--json'], descriptorPath);
      assert.equal(opened.operation, 'agent.open');
      assert.equal(opened.data.runStatus, 'intake');
    }
    const database = openConnection(databasePath);
    try {
      assert.deepEqual(database.prepare('SELECT client_kind FROM ledger_runs ORDER BY client_kind').all<{ client_kind: string }>().map((row) => row.client_kind), ['opencode']);
    } finally {
      database.close();
    }
  } finally {
    await runtime.close();
  }
});
