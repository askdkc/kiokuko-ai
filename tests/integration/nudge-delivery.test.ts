import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { CheckpointService } from '../../src/gateway/checkpoint-service.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-27T00:00:00.000Z';

async function createDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-nudge-delivery-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

function open(gateway: AgentGatewayService, workspace: string) {
  return gateway.openRun({
    idempotencyKey: `open-${workspace}`,
    request: {
      apiVersion: '1',
      workspace,
      client: { kind: 'nudge-test' },
      task: {
        title: 'Nudge task',
        query: 'Verify deterministic nudge delivery',
        profileHints: { taskType: 'build', target: 'src/app.ts', expected: 'tests pass' },
      },
      captureProfile: 'standard',
      coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
      metadata: {},
    },
  });
}

function append(
  gateway: AgentGatewayService,
  runId: string,
  idempotencyKey: string,
  event: Record<string, unknown>,
): void {
  gateway.appendEvents({
    runId,
    idempotencyKey,
    request: { apiVersion: '1', events: [event] },
  });
}

function checkpoint(service: CheckpointService, runId: string, idempotencyKey: string, request: Record<string, unknown>) {
  return service.checkpoint({ runId, idempotencyKey, request: { apiVersion: '1', ...request } });
}

test('delivers verify-after-mutation once and preserves the original nudge on exact replay', async () => {
  const database = await createDatabase();
  try {
    const gateway = new AgentGatewayService(database, { now: () => now });
    const opened = open(gateway, 'nudge-verify');
    append(gateway, opened.runId, 'verify-seed', {
      eventId: 'verification-pass',
      eventType: 'verification.recorded',
      actor: 'test',
      occurredAt: now,
      outcome: 'passed',
      payload: { suite: 'focused' },
    });
    const service = new CheckpointService(database, () => now);
    const request = { changedPaths: ['src/app.ts'] };
    const first = checkpoint(service, opened.runId, 'verify-checkpoint', request);
    assert.equal(first.recommendations.some((item) => item.code === 'VERIFY_AFTER_MUTATION'), true);
    const firstNudge = service.deliverNudge({
      runId: opened.runId,
      idempotencyKey: 'verify-checkpoint',
      throughSequence: first.acceptedThrough,
      projection: first.projection,
      recommendations: first.recommendations,
    });
    assert.equal(firstNudge?.code, 'VERIFY_AFTER_MUTATION');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM nudge_deliveries WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 1);

    const replay = checkpoint(service, opened.runId, 'verify-checkpoint', request);
    const replayNudge = service.deliverNudge({
      runId: opened.runId,
      idempotencyKey: 'verify-checkpoint',
      throughSequence: replay.acceptedThrough,
      projection: replay.projection,
      recommendations: replay.recommendations,
    });
    assert.deepEqual(replayNudge, firstNudge);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM nudge_deliveries WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 1);

    const unrelated = checkpoint(service, opened.runId, 'verify-unrelated', { currentStep: 'continue' });
    assert.equal(unrelated.recommendations.some((item) => item.code === 'VERIFY_AFTER_MUTATION'), true);
    assert.equal(service.deliverNudge({
      runId: opened.runId,
      idempotencyKey: 'verify-unrelated',
      throughSequence: unrelated.acceptedThrough,
      projection: unrelated.projection,
      recommendations: unrelated.recommendations,
    }), null);
  } finally {
    database.close();
  }
});

test('rejects checkpoint replay when a stored nudge code no longer matches its occurrence', async () => {
  const database = await createDatabase();
  try {
    const gateway = new AgentGatewayService(database, { now: () => now });
    const opened = open(gateway, 'nudge-binding');
    append(gateway, opened.runId, 'binding-seed', {
      eventId: 'binding-verification-pass',
      eventType: 'verification.recorded',
      actor: 'test',
      occurredAt: now,
      outcome: 'passed',
      payload: { suite: 'focused' },
    });
    const service = new CheckpointService(database, () => now);
    const first = checkpoint(service, opened.runId, 'binding-checkpoint', { changedPaths: ['src/app.ts'] });
    const firstNudge = service.deliverNudge({
      runId: opened.runId,
      idempotencyKey: 'binding-checkpoint',
      throughSequence: first.acceptedThrough,
      projection: first.projection,
      recommendations: first.recommendations,
    });
    assert.equal(firstNudge?.code, 'VERIFY_AFTER_MUTATION');

    database.prepare('UPDATE nudge_deliveries SET code = ?, priority = ? WHERE run_id = ?')
      .run('UNRESOLVED_FAILURE', 3, opened.runId);

    const replay = checkpoint(service, opened.runId, 'binding-checkpoint', { changedPaths: ['src/app.ts'] });
    assert.throws(
      () => service.deliverNudge({
        runId: opened.runId,
        idempotencyKey: 'binding-checkpoint',
        throughSequence: replay.acceptedThrough,
        projection: replay.projection,
        recommendations: replay.recommendations,
      }),
      (error: unknown) => {
        assert.ok(error instanceof KiokukoError);
        assert.equal(error.code, 'INTEGRITY_ERROR');
        assert.equal(error.message, 'Stored nudge occurrence binding is invalid');
        assert.equal(error.message.includes('UNRESOLVED_FAILURE'), false);
        assert.equal(error.message.includes(firstNudge!.occurrenceId), false);
        return true;
      },
    );
  } finally {
    database.close();
  }
});

test('creates a new unresolved-failure occurrence after the previous episode is resolved', async () => {
  const database = await createDatabase();
  try {
    const gateway = new AgentGatewayService(database, { now: () => now });
    const opened = open(gateway, 'nudge-failures');
    append(gateway, opened.runId, 'failure-a-seed', {
      eventId: 'failure-a',
      eventType: 'step.failed',
      actor: 'test',
      occurredAt: now,
      outcome: 'failed',
      payload: { step: 'build' },
    });
    const service = new CheckpointService(database, () => now);
    const first = checkpoint(service, opened.runId, 'failure-a-checkpoint', { currentStep: 'diagnose' });
    const firstNudge = service.deliverNudge({
      runId: opened.runId,
      idempotencyKey: 'failure-a-checkpoint',
      throughSequence: first.acceptedThrough,
      projection: first.projection,
      recommendations: first.recommendations,
    });
    assert.equal(firstNudge?.code, 'UNRESOLVED_FAILURE');

    append(gateway, opened.runId, 'failure-a-resolve', {
      eventId: 'failure-a-resolved',
      eventType: 'correction.recorded',
      actor: 'test',
      occurredAt: now,
      payload: { resolvesEventIds: ['failure-a'] },
    });
    append(gateway, opened.runId, 'failure-gap', {
      eventId: 'failure-gap',
      eventType: 'step.completed',
      actor: 'test',
      occurredAt: now,
      outcome: 'passed',
      payload: { step: 'diagnose' },
    });
    append(gateway, opened.runId, 'failure-b-seed', {
      eventId: 'failure-b',
      eventType: 'step.failed',
      actor: 'test',
      occurredAt: now,
      outcome: 'failed',
      payload: { step: 'test' },
    });
    const second = checkpoint(service, opened.runId, 'failure-b-checkpoint', { currentStep: 'report' });
    const secondNudge = service.deliverNudge({
      runId: opened.runId,
      idempotencyKey: 'failure-b-checkpoint',
      throughSequence: second.acceptedThrough,
      projection: second.projection,
      recommendations: second.recommendations,
    });
    assert.equal(secondNudge?.code, 'UNRESOLVED_FAILURE');
    assert.notEqual(secondNudge?.occurrenceId, firstNudge?.occurrenceId);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM nudge_deliveries WHERE run_id = ?').get<{ count: number }>(opened.runId)?.count, 2);
  } finally {
    database.close();
  }
});
