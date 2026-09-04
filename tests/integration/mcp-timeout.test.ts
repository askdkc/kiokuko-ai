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
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';

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
  const client = new Client({ name: 'opencode', version: '1.0.0' });
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

test('task preparation never waits for external discovery or turns its run into a timeout failure', async () => {
  const { root, databasePath } = await createMigratedDatabase();
  await writeFile(path.join(root, 'package.json'), '{"name":"timeout-fixture","dependencies":{"typescript":"^5.0.0"}}\n');
  const database = openConnection(databasePath);
  let started = false;
  const fetchImpl: typeof fetch = async () => {
    started = true;
    throw new Error('external discovery must not run on task_prepare');
  };
  try {
    const prepared = await prepareOpenCodeTask(database, {
      requestId: 'mcp-timeout-run-recovery',
      cwd: root,
      task: 'Build a TypeScript service',
      profileHints: { taskType: 'build', target: 'TypeScript service', expected: 'cancellable discovery' },
      capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }],
      skillDiscoveryMode: 'official',
      fetchImpl,
    });
    assert.equal(prepared.nextAction, 'proceed');
    assert.equal(started, false);
    const run = database.prepare('SELECT status FROM ledger_runs WHERE task_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1').get<{ status: string }>();
    assert.equal(run?.status, 'active');
    const job = database.prepare("SELECT state FROM orchestration_jobs WHERE kind = 'skill_discovery' ORDER BY created_at DESC LIMIT 1")
      .get<{ state: string }>();
    assert.equal(job?.state, 'pending');
  } finally {
    database.close();
  }
});
