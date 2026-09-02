import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

const now = '2026-08-20T00:00:00.000Z';
const migrations = path.resolve(import.meta.dirname, '../../migrations');

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-gateway-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: '1',
    workspace: 'workspace-gateway',
    client: { kind: 'generic', version: '1.0.0', sessionId: 'client-session' },
    task: {
      title: 'Implement the gateway service',
      query: 'Implement a feature',
      profileHints: {
        taskType: 'build',
        target: 'src/gateway/agent-service.ts',
        expected: 'focused tests pass',
        constraints: null,
      },
    },
    captureProfile: 'standard',
    coverage: {
      run: 'complete',
      tool: 'best_effort',
      command: 'best_effort',
      file: 'declared',
      approval: 'unavailable',
    },
    ...overrides,
  };
}

test('opens a run, Akinator session, one-to-one link, and lifecycle events atomically', async () => {
  const database = await setup();
  try {
    const service = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-1',
      sessionIdFactory: () => 'gateway-session-1',
      eventIdFactory: (() => {
        let count = 0;
        return () => `gateway-event-${++count}`;
      })(),
    });

    const response = service.openRun({
      idempotencyKey: 'open-key-1',
      request: request(),
    });

    assert.equal(response.runId, 'gateway-run-1');
    assert.equal(response.runStatus, 'active');
    assert.equal(response.intakeSessionId, 'gateway-session-1');
    assert.equal(response.intakeStatus, 'ready');
    assert.equal(response.context, null);
    assert.equal(response.profileHash?.length, 64);
    assert.deepEqual(response.missingFields, []);
    assert.equal(response.taskProfile.target, 'src/gateway/agent-service.ts');
    assert.equal(response.untrusted, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_intakes').get<{ count: number }>()?.count, 1);
    assert.deepEqual(
      database.prepare('SELECT event_type FROM ledger_events WHERE run_id = ? ORDER BY sequence').all<{ event_type: string }>('gateway-run-1').map((row) => row.event_type),
      ['intake.started', 'intake.ready', 'run.started'],
    );
  } finally {
    database.close();
  }
});

test('keeps an inferred intake in intake status and never returns context before an answer', async () => {
  const database = await setup();
  try {
    const service = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-needs-answer',
      sessionIdFactory: () => 'gateway-session-needs-answer',
      eventIdFactory: (() => {
        let count = 0;
        return () => `gateway-needs-event-${++count}`;
      })(),
    });

    const response = service.openRun({
      idempotencyKey: 'open-needs-answer',
      request: request({
        task: {
          title: 'Ambiguous gateway task',
          query: 'Please help with this request',
        },
      }),
    });

    assert.equal(response.runStatus, 'intake');
    assert.equal(response.intakeStatus, 'needs_answer');
    assert.equal(response.currentQuestion?.id, 'taskType');
    assert.equal(response.context, null);
    assert.equal(response.profileHash, null);
    assert.equal(database.prepare("SELECT status FROM ledger_runs WHERE run_id = ?").get<{ status: string }>('gateway-run-needs-answer')?.status, 'intake');
    assert.deepEqual(
      database.prepare('SELECT event_type FROM ledger_events WHERE run_id = ? ORDER BY sequence').all<{ event_type: string }>('gateway-run-needs-answer').map((row) => row.event_type),
      ['intake.started'],
    );
  } finally {
    database.close();
  }
});

test('answers the current question and atomically finalizes the linked run', async () => {
  const database = await setup();
  try {
    let eventNumber = 0;
    const service = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-answer',
      sessionIdFactory: () => 'gateway-session-answer',
      eventIdFactory: () => `gateway-answer-event-${++eventNumber}`,
    });
    const opened = service.openRun({
      idempotencyKey: 'open-answer',
      request: request({
        task: { title: 'Ambiguous task', query: 'Please help with this request' },
      }),
    });

    const withType = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'answer-type',
      request: { apiVersion: '1', questionId: 'taskType', value: 'build' },
    });
    assert.equal(withType.runStatus, 'intake');
    assert.equal(withType.currentQuestion?.id, 'target');
    assert.equal(withType.profileHash, null);

    const withTarget = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'answer-target',
      request: { apiVersion: '1', questionId: 'target', value: 'src/feature.ts' },
    });
    assert.equal(withTarget.currentQuestion?.id, 'expected');

    const ready = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'answer-expected',
      request: { apiVersion: '1', questionId: 'expected', value: 'tests pass' },
    });
    assert.equal(ready.runStatus, 'active');
    assert.equal(ready.intakeStatus, 'ready');
    assert.equal(ready.profileHash?.length, 64);
    assert.deepEqual(ready.missingFields, []);
    assert.deepEqual(
      database.prepare('SELECT event_type FROM ledger_events WHERE run_id = ? ORDER BY sequence').all<{ event_type: string }>(opened.runId).map((row) => row.event_type),
      ['intake.started', 'intake.answered', 'intake.answered', 'intake.answered', 'intake.ready', 'run.started'],
    );
    assert.equal(
      database.prepare('SELECT profile_sources_json FROM run_intakes WHERE run_id = ?').get<{ profile_sources_json: string }>(opened.runId)?.profile_sources_json,
      '{"expected":"user_answer","target":"user_answer","taskType":"user_answer"}',
    );
  } finally {
    database.close();
  }
});

test('replays an answer exactly, conflicts on same-key changes, and does not duplicate lifecycle events under another key', async () => {
  const database = await setup();
  try {
    let eventNumber = 0;
    const service = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-answer-idempotency',
      sessionIdFactory: () => 'gateway-session-answer-idempotency',
      eventIdFactory: () => `gateway-idempotency-event-${++eventNumber}`,
    });
    const opened = service.openRun({
      idempotencyKey: 'open-answer-idempotency',
      request: request({ task: { title: 'Ambiguous task', query: 'Please help with this request' } }),
    });
    const first = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'answer-idempotency-key',
      request: { apiVersion: '1', questionId: 'taskType', value: 'build' },
    });
    const replay = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'answer-idempotency-key',
      request: { apiVersion: '1', questionId: 'taskType', value: 'build' },
    });
    assert.deepEqual(replay, first);

    assert.throws(() => service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'answer-idempotency-key',
      request: { apiVersion: '1', questionId: 'taskType', value: 'debug' },
    }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');

    const sameAnswerDifferentKey = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'answer-idempotency-key-2',
      request: { apiVersion: '1', questionId: 'taskType', value: '  build  ' },
    });
    assert.deepEqual(sameAnswerDifferentKey, first);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE event_type = ?').get<{ count: number }>('intake.answered')?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM gateway_idempotency').get<{ count: number }>()?.count, 3);
  } finally {
    database.close();
  }
});

test('recognizes a canonical final answer replay after intake becomes active', async () => {
  const database = await setup();
  try {
    let eventNumber = 0;
    const service = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-final-replay',
      sessionIdFactory: () => 'gateway-session-final-replay',
      eventIdFactory: () => `gateway-final-replay-event-${++eventNumber}`,
    });
    const opened = service.openRun({
      idempotencyKey: 'open-final-replay',
      request: request({ task: { title: 'Ambiguous task', query: 'Please help with this request' } }),
    });
    service.answerIntake({ runId: opened.runId, idempotencyKey: 'final-type', request: { apiVersion: '1', questionId: 'taskType', value: 'build' } });
    service.answerIntake({ runId: opened.runId, idempotencyKey: 'final-target', request: { apiVersion: '1', questionId: 'target', value: 'src/feature.ts' } });
    const final = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'final-expected',
      request: { apiVersion: '1', questionId: 'expected', value: 'tests pass' },
    });

    const replay = service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'final-expected-replay',
      request: { apiVersion: '1', questionId: 'expected', value: ' tests pass ' },
    });
    assert.deepEqual(replay, final);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers').get<{ count: number }>()?.count, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE event_type = ?').get<{ count: number }>('intake.answered')?.count, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE event_type = ?').get<{ count: number }>('run.started')?.count, 1);
  } finally {
    database.close();
  }
});

test('appends active events, closes atomically, and rejects new terminal operations', async () => {
  const database = await setup();
  try {
    let eventNumber = 0;
    const service = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-close',
      sessionIdFactory: () => 'gateway-session-close',
      eventIdFactory: () => `gateway-close-event-${++eventNumber}`,
    });
    const opened = service.openRun({ idempotencyKey: 'open-close', request: request() });
    const eventRequest = {
      apiVersion: '1',
      events: [{
        eventId: 'work-event-1',
        eventType: 'step.started',
        actor: 'client',
        occurredAt: now,
        payload: { step: 'build' },
      }],
    };
    const appended = service.appendEvents({ runId: opened.runId, idempotencyKey: 'events-1', request: eventRequest });
    assert.equal(appended.runStatus, 'active');
    assert.deepEqual(appended.eventIds, ['work-event-1']);
    assert.deepEqual(service.appendEvents({ runId: opened.runId, idempotencyKey: 'events-1', request: eventRequest }), appended);

    const closeRequest = {
      apiVersion: '1',
      status: 'completed',
      events: [{
        eventId: 'final-event-1',
        eventType: 'verification.recorded',
        actor: 'client',
        occurredAt: now,
        payload: { outcome: 'pass' },
      }],
    };
    const closed = service.closeRun({ runId: opened.runId, idempotencyKey: 'close-1', request: closeRequest });
    assert.equal(closed.status, 'completed');
    assert.equal(closed.runStatus, 'completed');
    assert.equal(closed.eventIds.length, 2);
    assert.equal(closed.eventIds[0], 'final-event-1');
    assert.deepEqual(service.closeRun({ runId: opened.runId, idempotencyKey: 'close-1', request: closeRequest }), closed);
    assert.equal(service.readRun({ runId: opened.runId }).untrusted, true);
    assert.equal(service.listEvents({ runId: opened.runId }).untrusted, true);
    assert.deepEqual(
      database.prepare('SELECT event_type FROM ledger_events WHERE run_id = ? ORDER BY sequence').all<{ event_type: string }>(opened.runId).map((row) => row.event_type),
      ['intake.started', 'intake.ready', 'run.started', 'step.started', 'verification.recorded', 'run.closed'],
    );

    assert.throws(() => service.appendEvents({ runId: opened.runId, idempotencyKey: 'events-after-close', request: eventRequest }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    assert.throws(() => service.closeRun({ runId: opened.runId, idempotencyKey: 'close-after-close', request: { apiVersion: '1', status: 'completed' } }), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
  } finally {
    database.close();
  }
});

test('rejects non-canonical numeric-looking array properties before event and idempotency mutation', async () => {
  const database = await setup();
  try {
    let eventNumber = 0;
    const service = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-noncanonical-array',
      sessionIdFactory: () => 'gateway-session-noncanonical-array',
      eventIdFactory: () => `gateway-event-noncanonical-array-${++eventNumber}`,
    });
    const opened = service.openRun({
      idempotencyKey: 'open-noncanonical-array',
      request: request(),
    });
    assert.equal(opened.runStatus, 'active');

    const events = [{
      eventId: 'work-event-noncanonical-array',
      eventType: 'step.started',
      actor: 'client',
      occurredAt: now,
      payload: { step: 'build' },
    }];
    Object.defineProperty(events, '01', { value: 'non-json-array-property', enumerable: true });
    const eventCountBefore = database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count;
    const idempotencyCountBefore = database.prepare('SELECT COUNT(*) AS count FROM gateway_idempotency').get<{ count: number }>()?.count;

    assert.throws(() => service.appendEvents({
      runId: opened.runId,
      idempotencyKey: 'events-noncanonical-array',
      request: { apiVersion: '1', events },
    }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, eventCountBefore);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM gateway_idempotency').get<{ count: number }>()?.count, idempotencyCountBefore);
  } finally {
    database.close();
  }
});

test('rejects unknown, non-JSON, and oversized open input before durable mutation, while sanitizing secrets', async () => {
  const cases: Array<{ name: string; value: unknown }> = [
    { name: 'unknown field', value: { ...request(), unexpected: true } },
    { name: 'non-finite value', value: request({ metadata: { score: Number.NaN } }) },
    { name: 'oversized task', value: request({ task: { ...(request().task as Record<string, unknown>), title: 'x'.repeat(64 * 1024 + 1) } }) },
  ];
  for (const testCase of cases) {
    const database = await setup();
    try {
      const service = new AgentGatewayService(database, { now: () => now, runIdFactory: () => `gateway-invalid-${testCase.name}` });
      assert.throws(() => service.openRun({ idempotencyKey: `invalid-${testCase.name}`, request: testCase.value }), (error: unknown) => {
        assert.notEqual((error as { code?: string }).code, undefined);
        return true;
      });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_intakes').get<{ count: number }>()?.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM gateway_idempotency').get<{ count: number }>()?.count, 0);
    } finally {
      database.close();
    }
  }

  const database = await setup();
  try {
    const secret = 'hidden-secret-value-12345';
    const service = new AgentGatewayService(database, { now: () => now, runIdFactory: () => 'gateway-sanitized-secret' });
    const response = service.openRun({
      idempotencyKey: 'sanitized-secret',
      request: request({ task: { ...(request().task as Record<string, unknown>), query: `api_key = ${secret}` } }),
    });
    const storedTask = database.prepare('SELECT task_text FROM akinator_sessions WHERE id = ?').get<{ task_text: string }>(response.intakeSessionId)?.task_text ?? '';
    const storedResponses = database.prepare('SELECT response_json FROM gateway_idempotency').all<{ response_json: string }>().map((row) => row.response_json).join('\n');
    assert.equal(JSON.stringify(response).includes(secret), false);
    assert.equal(storedTask.includes(secret), false);
    assert.equal(storedResponses.includes(secret), false);
  } finally {
    database.close();
  }
});

test('rolls back open and answer lifecycles when a later event write fails', async () => {
  const database = await setup();
  try {
    const openFailure = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-open-rollback',
      sessionIdFactory: () => 'gateway-session-open-rollback',
      eventIdFactory: () => 'duplicate-open-event',
    });
    assert.throws(() => openFailure.openRun({ idempotencyKey: 'open-rollback', request: request() }));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_intakes').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM gateway_idempotency').get<{ count: number }>()?.count, 0);

    let eventNumber = 0;
    const service = new AgentGatewayService(database, {
      now: () => now,
      runIdFactory: () => 'gateway-run-answer-rollback',
      sessionIdFactory: () => 'gateway-session-answer-rollback',
      eventIdFactory: () => {
        eventNumber += 1;
        return eventNumber <= 3 ? `answer-event-${eventNumber}` : 'duplicate-answer-event';
      },
    });
    const opened = service.openRun({
      idempotencyKey: 'open-answer-rollback',
      request: request({ task: { title: 'Ambiguous task', query: 'Please help with this request' } }),
    });
    service.answerIntake({ runId: opened.runId, idempotencyKey: 'rollback-type', request: { apiVersion: '1', questionId: 'taskType', value: 'build' } });
    service.answerIntake({ runId: opened.runId, idempotencyKey: 'rollback-target', request: { apiVersion: '1', questionId: 'target', value: 'src/feature.ts' } });
    assert.throws(() => service.answerIntake({
      runId: opened.runId,
      idempotencyKey: 'rollback-expected',
      request: { apiVersion: '1', questionId: 'expected', value: 'tests pass' },
    }));
    assert.equal(database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(opened.runId)?.status, 'intake');
    assert.equal(database.prepare('SELECT question_count FROM akinator_sessions WHERE id = ?').get<{ question_count: number }>(opened.intakeSessionId)?.question_count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?').get<{ count: number }>(opened.intakeSessionId)?.count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM gateway_idempotency').get<{ count: number }>()?.count, 3);
  } finally {
    database.close();
  }
});
