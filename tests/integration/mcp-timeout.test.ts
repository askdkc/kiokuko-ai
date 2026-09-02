import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import type { McpDatabaseOwner } from '../../src/mcp/runtime-owner.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';

async function createMigratedDatabase(): Promise<{ root: string; databasePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-timeout-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-mcp-timeout-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const database = openConnection(databasePath);
  try {
    migrateDatabase(database);
  } finally {
    database.close();
  }
  return { root, databasePath };
}

test('MCP tool timeout returns a stable public error and the same connection serves the next request', async () => {
  const { root, databasePath } = await createMigratedDatabase();
  let calls = 0;
  const owner: McpDatabaseOwner = {
    async withDatabase(operation) {
      calls += 1;
      if (calls === 1) return await new Promise<never>(() => undefined);
      const database = openConnection(databasePath);
      try {
        return await operation(database, undefined as never);
      } finally {
        database.close();
      }
    },
    async close() {},
  };
  const server = createKiokukoMcpServer({
    cwd: () => root,
    databaseOwner: owner,
    deadlinePolicy: { readMs: 20, externalMs: 20, mutationMs: 20, hardMaxMs: 30 },
  });
  const client = new Client({ name: 'mcp-timeout-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const timedOut = await client.callTool({ name: 'curator_check', arguments: { cwd: root } });
    assert.equal(timedOut.isError, true);
    assert.deepEqual(timedOut.structuredContent, {
      code: 'MCP_REQUEST_TIMEOUT',
      message: 'MCP request timed out',
      operation: 'curator_check',
      retryable: true,
    });
    assert.equal(JSON.stringify(timedOut).includes(databasePath), false);

    const healthy = await client.callTool({ name: 'curator_check', arguments: { cwd: root } });
    assert.equal(healthy.isError, undefined);
    assert.equal((healthy.structuredContent as { candidates?: unknown[] }).candidates?.length, 0);
    assert.equal(calls, 2);
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
});

test('aborted task preparation closes the run and discovery attempt as failed', async () => {
  const { root, databasePath } = await createMigratedDatabase();
  await writeFile(path.join(root, 'package.json'), '{"name":"timeout-fixture","dependencies":{"typescript":"^5.0.0"}}\n');
  const database = openConnection(databasePath);
  const controller = new AbortController();
  let started = false;
  const fetchImpl: typeof fetch = async (_input, init) => {
    started = true;
    const signal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  try {
    const preparation = prepareAgentTask(database, {
      requestId: 'mcp-timeout-run-recovery',
      cwd: root,
      task: 'Build a TypeScript service',
      profileHints: { taskType: 'build', target: 'TypeScript service', expected: 'cancellable discovery' },
      capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }],
      skillDiscoveryMode: 'official',
      fetchImpl,
      signal: controller.signal,
    });
    const deadline = Date.now() + 1_000;
    while (!started) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for discovery');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await assert.rejects(preparation);
    const run = database.prepare('SELECT status FROM ledger_runs WHERE task_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1').get<{ status: string }>();
    assert.equal(run?.status, 'failed');
    const attempt = database.prepare('SELECT state FROM agent_task_skill_discovery_attempts ORDER BY started_at DESC LIMIT 1').get<{ state: string }>();
    assert.equal(attempt?.state, 'failed');
  } finally {
    database.close();
  }
});
