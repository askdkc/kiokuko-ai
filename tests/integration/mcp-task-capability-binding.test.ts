import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { TaskRunService } from '../../src/task-run/service.js';

test('OpenCode task runs bind an ephemeral catalog and reject answer-time replacement before mutation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-capability-binding-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const service = new TaskRunService(database, {
      now: () => '2026-08-25T00:00:00.000Z',
      runIdFactory: () => 'capability-bound-run',
      sessionIdFactory: () => 'capability-bound-session',
      eventIdFactory: (() => { let index = 0; return () => `capability-event-${++index}`; })(),
    });
    const sentinel = 'ephemeral-capability-description-sentinel';
    const capabilities = [{
      kind: 'skill',
      name: 'memory-reasoning',
      description: `Verify memory without storing ${sentinel}`,
    }];
    const opened = service.createRun({
      requestId: 'capability-open',
      workspace: 'project:capability-binding',
      task: {
        title: 'Implement an ambiguous feature',
        query: 'Please help with this request',
        profileHints: { taskType: null, target: null, expected: null, constraints: null },
      },
      metadata: { source: 'test' },
      capabilities,
    });
    assert.equal(opened.question?.id, 'taskType');

    assert.throws(() => service.answerIntake({
      runId: opened.runId,
      requestId: 'capability-swapped-answer',
      questionId: 'taskType',
      value: 'build',
      capabilities: [],
    }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT');
    assert.equal(database.prepare('SELECT question_count AS count FROM akinator_sessions WHERE id = ?')
      .get<{ count: number }>(opened.intakeSessionId)?.count, 0);

    const answered = service.answerIntake({
      runId: opened.runId,
      requestId: 'capability-bound-answer',
      questionId: 'taskType',
      value: 'build',
      capabilities,
    });
    assert.equal(answered.question?.id, 'target');
    assert.equal(database.prepare('SELECT question_count AS count FROM akinator_sessions WHERE id = ?')
      .get<{ count: number }>(opened.intakeSessionId)?.count, 1);

    const persisted = JSON.stringify({
      runs: database.prepare('SELECT metadata_json FROM ledger_runs').all(),
      idempotency: database.prepare('SELECT request_hash, response_json FROM task_request_receipts').all(),
    });
    assert.equal(persisted.includes(sentinel), false);
  } finally {
    database.close();
  }
});
