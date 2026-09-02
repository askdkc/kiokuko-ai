import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const token = 'd'.repeat(64);
const capabilities = [{ kind: 'skill', name: 'memory-reasoning' }];

function readyOpenRequest() {
  return {
    apiVersion: '1',
    workspace: 'request-binding-ready',
    client: { kind: 'generic', version: '1.0.0', sessionId: 'request-binding-ready-session' },
    task: {
      title: 'Verify Agent request binding',
      query: 'Verify every generic Agent mutation binds its complete HTTP request',
      profileHints: {
        taskType: 'review',
        target: 'src/server/routes',
        expected: 'all request binding assertions pass',
        constraints: null,
      },
    },
    captureProfile: 'standard',
    coverage: {
      run: 'declared',
      tool: 'best_effort',
      command: 'best_effort',
      file: 'declared',
      approval: 'unavailable',
    },
    capabilities,
  };
}

function ambiguousOpenRequest() {
  return {
    apiVersion: '1',
    workspace: 'request-binding-intake',
    client: { kind: 'generic' },
    task: { title: 'Ambiguous request binding task', query: 'Please handle this request' },
    captureProfile: 'minimal',
    coverage: {
      run: 'unavailable',
      tool: 'unavailable',
      command: 'unavailable',
      file: 'unavailable',
      approval: 'unavailable',
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-request-binding-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  await initializeDatabase({ databasePath });
  return startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    capabilityToken: token,
  });
}

async function post(baseUrl: string, pathname: string, key: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });
  return { response, value: await response.json() as any };
}

function dataOf(result: { response: Response; value: any }): Record<string, any> {
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.ok, true);
  return result.value.data as Record<string, any>;
}

function expectedHash(
  operation: string,
  pathRunId: string | null,
  idempotencyKey: string,
  requestBody: Record<string, unknown>,
): string {
  return canonicalContentHash({ operation, pathRunId, idempotencyKey, requestBody });
}

test('all six generic Agent mutation responses bind the exact canonical HTTP request', async () => {
  const runtime = await fixture();
  try {
    const observed = new Set<string>();
    const readyBody = readyOpenRequest();
    const readyOpenKey = 'request-binding-open-ready';
    const readyOpen = await post(runtime.url, '/api/v1/agent/runs', readyOpenKey, readyBody);
    const readyData = dataOf(readyOpen);
    const readyRunId = readyData.runId as string;
    assert.equal(readyData.requestBindingHash, expectedHash('agent.open', null, readyOpenKey, readyBody));
    assert.equal(typeof readyData.memoryPolicy?.memoryReasoningRequired, 'boolean');
    assert.equal(typeof readyData.memoryPolicy?.contextWithheld, 'boolean');
    observed.add(readyData.requestBindingHash as string);

    const eventsBody = {
      apiVersion: '1',
      events: [{
        eventId: 'request-binding-event',
        eventType: 'step.started',
        actor: 'generic',
        occurredAt: '2026-08-26T00:00:00.000Z',
        payload: { step: 'verify' },
      }],
    };
    const eventsKey = 'request-binding-events';
    const events = await post(
      runtime.url,
      `/api/v1/agent/runs/${encodeURIComponent(readyRunId)}/events`,
      eventsKey,
      eventsBody,
    );
    const eventsData = dataOf(events);
    assert.equal(eventsData.requestBindingHash, expectedHash('agent.events', readyRunId, eventsKey, eventsBody));
    observed.add(eventsData.requestBindingHash as string);

    const checkpointBody = {
      apiVersion: '1',
      currentGoal: 'verify the raw capability-bearing checkpoint request',
      characterBudget: 8_000,
      capabilities,
    };
    const checkpointKey = 'request-binding-checkpoint';
    const checkpoint = await post(
      runtime.url,
      `/api/v1/agent/runs/${encodeURIComponent(readyRunId)}/checkpoints`,
      checkpointKey,
      checkpointBody,
    );
    const checkpointData = dataOf(checkpoint);
    assert.equal(
      checkpointData.requestBindingHash,
      expectedHash('agent.checkpoint', readyRunId, checkpointKey, checkpointBody),
    );
    assert.equal(typeof checkpointData.memoryPolicy?.memoryReasoningRequired, 'boolean');
    assert.equal(typeof checkpointData.memoryPolicy?.contextWithheld, 'boolean');
    observed.add(checkpointData.requestBindingHash as string);

    const feedbackBody = {
      apiVersion: '1',
      category: 'run',
      feedbackId: 'request-binding-feedback',
      outcome: 'completed',
      rating: 5,
    };
    const feedbackKey = 'request-binding-feedback';
    const feedback = await post(
      runtime.url,
      `/api/v1/agent/runs/${encodeURIComponent(readyRunId)}/feedback`,
      feedbackKey,
      feedbackBody,
    );
    const feedbackData = dataOf(feedback);
    assert.equal(
      feedbackData.requestBindingHash,
      expectedHash('agent.feedback', readyRunId, feedbackKey, feedbackBody),
    );
    observed.add(feedbackData.requestBindingHash as string);

    const closeBody = { apiVersion: '1', status: 'completed' };
    const closeKey = 'request-binding-close';
    const close = await post(
      runtime.url,
      `/api/v1/agent/runs/${encodeURIComponent(readyRunId)}/close`,
      closeKey,
      closeBody,
    );
    const closeData = dataOf(close);
    assert.equal(closeData.requestBindingHash, expectedHash('agent.close', readyRunId, closeKey, closeBody));
    observed.add(closeData.requestBindingHash as string);

    const intakeBody = ambiguousOpenRequest();
    const intakeOpenKey = 'request-binding-open-intake';
    const intakeOpen = await post(runtime.url, '/api/v1/agent/runs', intakeOpenKey, intakeBody);
    const intakeData = dataOf(intakeOpen);
    const intakeRunId = intakeData.runId as string;
    assert.equal(intakeData.requestBindingHash, expectedHash('agent.open', null, intakeOpenKey, intakeBody));
    assert.equal(typeof intakeData.memoryPolicy?.memoryReasoningRequired, 'boolean');
    assert.equal(typeof intakeData.memoryPolicy?.contextWithheld, 'boolean');

    const answerBody = { apiVersion: '1', questionId: 'taskType', value: 'build' };
    const answerKey = 'request-binding-answer';
    const answer = await post(
      runtime.url,
      `/api/v1/agent/runs/${encodeURIComponent(intakeRunId)}/intake/answers`,
      answerKey,
      answerBody,
    );
    const answerData = dataOf(answer);
    assert.equal(answerData.requestBindingHash, expectedHash('agent.answer', intakeRunId, answerKey, answerBody));
    assert.equal(typeof answerData.memoryPolicy?.memoryReasoningRequired, 'boolean');
    assert.equal(typeof answerData.memoryPolicy?.contextWithheld, 'boolean');
    observed.add(answerData.requestBindingHash as string);

    assert.equal(observed.size, 6);
  } finally {
    await runtime.close();
  }
});
