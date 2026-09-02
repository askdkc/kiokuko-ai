import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const token = 'b'.repeat(64);
const SOUL_CAPABILITIES = [{ kind: 'skill', name: 'kiokuko-soul' }] as const;

async function rawDuplicateHeader(baseUrl: string, body: string): Promise<string> {
  const port = Number(new URL(baseUrl).port);
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.on('data', (chunk: Buffer | string) => {
      response += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
    socket.once('connect', () => socket.end([
      'POST /api/v1/agent/runs HTTP/1.1',
      'Host: 127.0.0.1',
      `Authorization: Bearer ${token}`,
      'Content-Type: application/json',
      'Idempotency-Key: duplicate-one',
      'Idempotency-Key: duplicate-two',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n')));
  });
}

function ambiguousRequest() {
  return {
    apiVersion: '1',
    workspace: 'workspace-intake',
    client: { kind: 'generic' },
    task: { title: 'Ambiguous task', query: 'Please help with this request' },
    captureProfile: 'minimal',
    capabilities: SOUL_CAPABILITIES,
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
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-intake-'));
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

async function jsonRequest(
  baseUrl: string,
  pathName: string,
  options: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<{ response: Response; body: any }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { response, body: await response.json() };
}

test('HTTP intake preserves needs_answer without context, then atomically reaches ready', async () => {
  const runtime = await fixture();
  try {
    const opened = await jsonRequest(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'intake-open-1',
      body: ambiguousRequest(),
    });
    assert.equal(opened.response.status, 200);
    assert.equal(opened.body.operation, 'agent.open');
    assert.equal(opened.body.data.runStatus, 'intake');
    assert.equal(opened.body.data.intakeStatus, 'needs_answer');
    assert.equal(opened.body.data.currentQuestion.id, 'taskType');
    assert.equal(opened.body.data.context, null);
    assert.equal(opened.body.data.profileHash, null);
    assert.equal(opened.body.data.untrusted, true);
    const runId = opened.body.data.runId as string;

    const first = await jsonRequest(runtime.url, `/api/v1/agent/runs/${runId}/intake/answers`, {
      method: 'POST',
      key: 'intake-answer-type',
      body: { apiVersion: '1', questionId: 'taskType', value: 'build', capabilities: SOUL_CAPABILITIES },
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.operation, 'agent.answer');
    assert.equal(first.body.data.runStatus, 'intake');
    assert.equal(first.body.data.currentQuestion.id, 'target');
    assert.equal(first.body.data.context, null);
    assert.equal(first.body.data.profileHash, null);

    const replay = await jsonRequest(runtime.url, `/api/v1/agent/runs/${runId}/intake/answers`, {
      method: 'POST',
      key: 'intake-answer-type',
      body: { apiVersion: '1', questionId: 'taskType', value: 'build', capabilities: SOUL_CAPABILITIES },
    });
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, first.body);

    const conflict = await jsonRequest(runtime.url, `/api/v1/agent/runs/${runId}/intake/answers`, {
      method: 'POST',
      key: 'intake-answer-type',
      body: { apiVersion: '1', questionId: 'taskType', value: 'debug', capabilities: SOUL_CAPABILITIES },
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.operation, 'agent.answer');
    assert.equal(conflict.body.error.code, 'CONFLICT');

    const second = await jsonRequest(runtime.url, `/api/v1/agent/runs/${runId}/intake/answers`, {
      method: 'POST',
      key: 'intake-answer-target',
      body: { apiVersion: '1', questionId: 'target', value: 'src/feature.ts', capabilities: SOUL_CAPABILITIES },
    });
    assert.equal(second.body.data.runStatus, 'intake');
    assert.equal(second.body.data.currentQuestion.id, 'expected');
    assert.equal(second.body.data.context, null);
    assert.equal(second.body.data.profileHash, null);

    const ready = await jsonRequest(runtime.url, `/api/v1/agent/runs/${runId}/intake/answers`, {
      method: 'POST',
      key: 'intake-answer-expected',
      body: { apiVersion: '1', questionId: 'expected', value: 'tests pass', capabilities: SOUL_CAPABILITIES },
    });
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.data.runStatus, 'active');
    assert.equal(ready.body.data.intakeStatus, 'ready');
    assert.deepEqual(ready.body.data.missingFields, []);
    assert.equal(typeof ready.body.data.profileHash, 'string');
    assert.notEqual(ready.body.data.context, null);
    assert.equal(ready.body.data.context.untrusted, true);
    assert.equal(ready.body.data.untrusted, true);

    const read = await jsonRequest(runtime.url, `/api/v1/agent/runs/${runId}/intake`);
    assert.equal(read.response.status, 200);
    assert.equal(read.body.operation, 'agent.intake.read');
    assert.equal(read.body.data.runStatus, 'active');
    assert.equal(read.body.data.profileHash, ready.body.data.profileHash);
    assert.equal(read.body.data.context, null);
  } finally {
    await runtime.close();
  }
});

test('all write idempotency-key failures return before a durable open', async () => {
  const runtime = await fixture();
  try {
    for (const headers of [
      {},
      { 'idempotency-key': '' },
      { 'idempotency-key': 'x'.repeat(257) },
    ]) {
      const result = await jsonRequest(runtime.url, '/api/v1/agent/runs', {
        method: 'POST',
        body: ambiguousRequest(),
        headers,
      });
      assert.equal(result.response.status, 400);
      assert.equal(result.body.operation, 'agent.open');
      assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    }

    const list = await jsonRequest(runtime.url, '/api/v1/agent/runs?workspace=workspace-intake');
    assert.equal(list.response.status, 200);
    assert.deepEqual(list.body.data.items, []);
  } finally {
    await runtime.close();
  }
});

test('duplicate Idempotency-Key headers are rejected before mutation over raw HTTP', async () => {
  const runtime = await fixture();
  try {
    const responseText = await rawDuplicateHeader(runtime.url, JSON.stringify(ambiguousRequest()));
    const separator = responseText.indexOf('\r\n\r\n');
    const bodyText = responseText.slice(separator + 4);
    assert.notEqual(separator, -1, JSON.stringify(responseText));
    assert.notEqual(bodyText.length, 0, JSON.stringify(responseText));
    const body = JSON.parse(bodyText) as { operation: string; error: { code: string } };
    assert.equal(responseText.startsWith('HTTP/1.1 400 '), true);
    assert.equal(body.operation, 'agent.open');
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  } finally {
    await runtime.close();
  }
});

test('query parameters are rejected on run reads and intake writes cannot smuggle a workspace', async () => {
  const runtime = await fixture();
  try {
    const opened = await jsonRequest(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'query-open',
      body: ambiguousRequest(),
    });
    const runId = opened.body.data.runId as string;
    const read = await jsonRequest(runtime.url, `/api/v1/agent/runs/${runId}?workspace=other`);
    assert.equal(read.response.status, 400);
    assert.equal(read.body.operation, 'agent.run.read');

    const answer = await jsonRequest(runtime.url, `/api/v1/agent/runs/${runId}/intake/answers?workspace=other`, {
      method: 'POST',
      key: 'query-answer',
      body: { apiVersion: '1', questionId: 'taskType', value: 'build' },
    });
    assert.equal(answer.response.status, 400);
    assert.equal(answer.body.operation, 'agent.answer');
  } finally {
    await runtime.close();
  }
});
