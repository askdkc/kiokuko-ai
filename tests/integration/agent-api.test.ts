import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const token = 'a'.repeat(64);

function openRequest(workspace = 'workspace-http') {
  return {
    apiVersion: '1',
    workspace,
    client: { kind: 'opencode', version: '1.0.0', sessionId: 'http-session' },
    task: {
      title: 'HTTP route task',
      query: 'Implement this route',
      profileHints: {
        taskType: 'build',
        target: 'src/server/routes',
        expected: 'focused tests pass',
        constraints: null,
      },
    },
    captureProfile: 'standard',
    capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }],
    coverage: {
      run: 'declared',
      tool: 'best_effort',
      command: 'best_effort',
      file: 'declared',
      approval: 'unavailable',
    },
  };
}

async function fixture(queueCapacity?: number) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-api-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  await initializeDatabase({ databasePath });
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    capabilityToken: token,
    ...(queueCapacity === undefined ? {} : { queueCapacity }),
  });
  return { runtime, close: () => runtime.close() };
}

async function request(
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown; key?: string; authorization?: string } = {},
): Promise<{ response: Response; value: unknown }> {
  const headers: Record<string, string> = {
    authorization: options.authorization ?? `Bearer ${token}`,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const value = await response.json() as unknown;
  return { response, value };
}

function dataOf(value: unknown): Record<string, any> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return (value as { data: Record<string, any> }).data;
}

test('production Agent v1 exposes all eight exact route operations over one server lifetime', async () => {
  const fixtureValue = await fixture();
  try {
    const opened = await request(fixtureValue.runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'open-http-1',
      body: openRequest(),
    });
    assert.equal(opened.response.status, 200);
    assert.deepEqual(Object.keys(opened.value as Record<string, unknown>).sort(), ['apiVersion', 'data', 'ok', 'operation']);
    assert.equal((opened.value as { operation: string }).operation, 'agent.open');
    const openedData = dataOf(opened.value);
    assert.equal(openedData.runStatus, 'active');
    assert.notEqual(openedData.context, null);
    assert.equal(openedData.context.untrusted, true);
    assert.equal(openedData.untrusted, true);
    const runId = openedData.runId as string;

    const list = await request(fixtureValue.runtime.url, '/api/v1/agent/runs?workspace=workspace-http&limit=1');
    assert.equal(list.response.status, 200);
    assert.equal((list.value as { operation: string }).operation, 'agent.runs.list');
    assert.equal(dataOf(list.value).untrusted, true);
    assert.equal(dataOf(list.value).items.length, 1);

    const read = await request(fixtureValue.runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}`);
    assert.equal(read.response.status, 200);
    assert.equal((read.value as { operation: string }).operation, 'agent.run.read');
    assert.equal(dataOf(read.value).runId, runId);
    assert.equal(dataOf(read.value).untrusted, true);

    const intake = await request(fixtureValue.runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/intake`);
    assert.equal(intake.response.status, 200);
    assert.equal((intake.value as { operation: string }).operation, 'agent.intake.read');
    assert.equal(dataOf(intake.value).context, null);

    const eventRequest = {
      apiVersion: '1',
      events: [{
        eventId: 'http-event-1',
        eventType: 'step.started',
        actor: 'client',
        occurredAt: '2026-08-20T00:00:00.000Z',
        payload: { step: 'build' },
      }],
    };
    const events = await request(fixtureValue.runtime.url, `/api/v1/agent/runs/${runId}/events`, {
      method: 'POST',
      key: 'events-http-1',
      body: eventRequest,
    });
    assert.equal(events.response.status, 200);
    assert.equal((events.value as { operation: string }).operation, 'agent.events');
    assert.equal(dataOf(events.value).untrusted, true);

    const eventList = await request(fixtureValue.runtime.url, `/api/v1/agent/runs/${runId}/events?after=0&limit=100&type=step.started`);
    assert.equal(eventList.response.status, 200);
    assert.equal((eventList.value as { operation: string }).operation, 'agent.events.list');
    assert.equal(dataOf(eventList.value).items.some((item: { eventId: string }) => item.eventId === 'http-event-1'), true);

    const closed = await request(fixtureValue.runtime.url, `/api/v1/agent/runs/${runId}/close`, {
      method: 'POST',
      key: 'close-http-1',
      body: { apiVersion: '1', status: 'completed' },
    });
    assert.equal(closed.response.status, 200);
    assert.equal((closed.value as { operation: string }).operation, 'agent.close');
    assert.equal(dataOf(closed.value).status, 'completed');
    assert.equal(dataOf(closed.value).untrusted, true);
  } finally {
    await fixtureValue.close();
  }
});

test('unknown routes and wrong methods preserve the safe api.v1 404 behavior', async () => {
  const fixtureValue = await fixture();
  try {
    const unknown = await request(fixtureValue.runtime.url, '/api/v1/agent/runs/unknown/suffix');
    assert.equal(unknown.response.status, 404);
    assert.equal((unknown.value as { operation: string }).operation, 'api.v1');

    const wrongMethod = await request(fixtureValue.runtime.url, '/api/v1/agent/runs', {
      method: 'PUT',
      body: {},
    });
    assert.equal(wrongMethod.response.status, 404);
    assert.equal((wrongMethod.value as { operation: string }).operation, 'api.v1');
  } finally {
    await fixtureValue.close();
  }
});

test('operation resolver labels auth, malformed JSON, and validation failures with the exact Agent operation', async () => {
  const fixtureValue = await fixture();
  try {
    const auth = await request(fixtureValue.runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'auth-failure',
      body: openRequest(),
      authorization: 'Bearer wrong',
    });
    assert.equal(auth.response.status, 401);
    assert.equal((auth.value as { operation: string }).operation, 'agent.open');

    const malformedResponse = await fetch(`${fixtureValue.runtime.url}/api/v1/agent/runs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'malformed-json',
      },
      body: '{"not":',
    });
    const malformed = await malformedResponse.json() as { operation: string; error: { code: string } };
    assert.equal(malformedResponse.status, 400);
    assert.equal(malformed.operation, 'agent.open');
    assert.equal(malformed.error.code, 'VALIDATION_ERROR');

    const invalid = await request(fixtureValue.runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'invalid-open',
      body: { ...openRequest(), apiVersion: '2' },
    });
    assert.equal(invalid.response.status, 400);
    assert.equal((invalid.value as { operation: string }).operation, 'agent.open');
  } finally {
    await fixtureValue.close();
  }
});

test('run and event query/path validation happens before any successful service response', async () => {
  const fixtureValue = await fixture();
  try {
    for (const pathname of [
      '/api/v1/agent/runs?workspace=workspace-http&workspace=other',
      '/api/v1/agent/runs?workspace=workspace-http&unexpected=x',
      '/api/v1/agent/runs?workspace=workspace-http&limit=01',
      '/api/v1/agent/runs/%ZZ',
    ]) {
      const result = await request(fixtureValue.runtime.url, pathname);
      assert.equal(result.response.status, 400);
      assert.equal((result.value as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    }
  } finally {
    await fixtureValue.close();
  }
});
