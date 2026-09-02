import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const token = 'c'.repeat(64);

function requestBody(workspace = 'workspace-concurrency') {
  return {
    apiVersion: '1',
    workspace,
    client: { kind: 'opencode' },
    task: {
      title: 'Concurrent task',
      query: 'Implement a feature',
      profileHints: { taskType: 'build', target: 'src/feature.ts', expected: 'tests pass', constraints: null },
    },
    captureProfile: 'standard',
    coverage: { run: 'declared', tool: 'declared', command: 'declared', file: 'declared', approval: 'unavailable' },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-concurrency-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  await initializeDatabase({ databasePath });
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    capabilityToken: token,
  });
  return runtime;
}

async function post(baseUrl: string, pathname: string, key: string, body: unknown): Promise<{ status: number; value: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
}

test('concurrent same-key opens produce one exact stored response and one durable run', async () => {
  const runtime = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => post(
      runtime.url,
      '/api/v1/agent/runs',
      'concurrent-open-key',
      requestBody(),
    )));
    assert.equal(results.every((result) => result.status === 200), true);
    for (const result of results) assert.deepEqual(result.value, results[0]?.value);

    const listed = await fetch(`${runtime.url}/api/v1/agent/runs?workspace=workspace-concurrency`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await listed.json() as { data: { items: unknown[] } };
    assert.equal(body.data.items.length, 1);
  } finally {
    await runtime.close();
  }
});

test('concurrent same-key events produce one durable mutation and different bodies conflict', async () => {
  const runtime = await fixture();
  try {
    const opened = await post(runtime.url, '/api/v1/agent/runs', 'events-open', requestBody());
    const runId = opened.value.data.runId as string;
    const eventRequest = {
      apiVersion: '1',
      events: [{
        eventId: 'concurrent-event-1',
        eventType: 'step.completed',
        actor: 'client',
        occurredAt: '2026-08-20T00:00:00.000Z',
        payload: { result: 'pass' },
      }],
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => post(
      runtime.url,
      `/api/v1/agent/runs/${runId}/events`,
      'concurrent-events-key',
      eventRequest,
    )));
    assert.equal(results.every((result) => result.status === 200), true);
    for (const result of results) assert.deepEqual(result.value, results[0]?.value);

    const conflict = await post(runtime.url, `/api/v1/agent/runs/${runId}/events`, 'concurrent-events-key', {
      apiVersion: '1',
      events: [{ ...eventRequest.events[0], payload: { result: 'fail' } }],
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.value.operation, 'agent.events');
    assert.equal(conflict.value.error.code, 'CONFLICT');

    const listed = await fetch(`${runtime.url}/api/v1/agent/runs/${runId}/events?after=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const events = await listed.json() as { data: { items: Array<{ eventId: string }> } };
    assert.equal(events.data.items.filter((item) => item.eventId === 'concurrent-event-1').length, 1);
  } finally {
    await runtime.close();
  }
});

test('production runtime handle and responses never serialize the capability token', async () => {
  const runtime = await fixture();
  try {
    assert.equal(JSON.stringify(runtime).includes(token), false);
    const response = await post(runtime.url, '/api/v1/agent/runs', 'privacy-open', requestBody());
    assert.equal(JSON.stringify(response.value).includes(token), false);
  } finally {
    await runtime.close();
  }
});
