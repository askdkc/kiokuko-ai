import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { ContextBroker } from '../../src/context/broker.js';
import { readEntry, recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';

const token = 'a'.repeat(64);
const workspace = 'task5-api';
const SOUL_CAPABILITIES = [{ kind: 'skill', name: 'kiokuko-soul' }] as const;
const capabilities = [...SOUL_CAPABILITIES, { kind: 'skill', name: 'memory-reasoning' }] as const;
const NO_MEMORY_POLICY = { memoryReasoningRequired: false, contextWithheld: false, withheldReason: null } as const;
const AVAILABLE_MEMORY_POLICY = { memoryReasoningRequired: true, contextWithheld: false, withheldReason: null } as const;
function missingMemoryPolicy(storedEntryCount: number) {
  return {
    memoryReasoningRequired: true,
    contextWithheld: true,
    withheldReason: 'memory_reasoning_missing',
    deliveryEmpty: true,
    storedEntryCount,
  } as const;
}

function openRequest(capabilityCatalog: unknown = capabilities) {
  return {
    apiVersion: '1',
    workspace,
    client: { kind: 'opencode', version: '1.0.0', sessionId: 'opencode-task5-http-session' },
    task: {
      title: 'Implement route context',
      query: 'Implement this route',
      profileHints: {
        taskType: 'build',
        target: 'src/server/routes',
        expected: 'focused tests pass',
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
    capabilities: capabilityCatalog,
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-task5-api-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    for (let index = 0; index < 20; index += 1) {
      recordEntry(database, {
        workspace,
        kind: 'reference',
        title: `Implement route context ${index}`,
        body: 'Implement this route and keep focused tests passing.',
        summary: 'Route implementation context',
        tags: ['src/server/routes/task5.ts'],
      });
    }
  } finally {
    database.close();
  }
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    capabilityToken: token,
  });
  return { runtime, databasePath };
}

async function request(baseUrl: string, pathname: string, options: { method?: string; body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { response, value: await response.json() as any };
}

function dataOf(value: any): any {
  assert.equal(value.ok, true);
  return value.data;
}

test('Task 5 checkpoint and feedback enforce the run-bound capability catalog while ungated context routes stay removed', async () => {
  const { runtime } = await fixture();
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-open',
      body: openRequest(),
    });
    assert.equal(opened.response.status, 200);
    assert.equal(opened.value.operation, 'agent.open');
    const openedData = dataOf(opened.value);
    assert.equal(openedData.intakeStatus, 'ready');
    assert.equal(openedData.context.untrusted, true);
    assert.equal(openedData.context.items.length, 20);
    const runId = openedData.runId as string;
    const deliveryId = openedData.context.deliveryId as string;
    const entryId = openedData.context.items[0].entryId as string;

    const removedDeliveries = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/context-deliveries?limit=1`);
    assert.equal(removedDeliveries.response.status, 404);
    assert.equal(removedDeliveries.value.operation, 'api.v1');
    const removedQuery = await request(runtime.url, '/api/v1/context/query', {
      method: 'POST',
      body: {
        apiVersion: '1',
        workspace,
        task: 'Implement route',
        taskProfile: { taskType: 'build', target: 'src/server/routes', expected: 'focused tests pass', constraints: null },
        limit: 1,
      },
    });
    assert.equal(removedQuery.response.status, 404);
    assert.equal(removedQuery.value.operation, 'api.v1');

    const feedbackRequest = {
      apiVersion: '1',
      category: 'context',
      feedbackId: 'task5-feedback-1',
      deliveryId,
      entryId,
      verdict: 'helpful',
      comment: 'Useful route context',
    };
    const feedback = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      key: 'task5-feedback-key',
      body: feedbackRequest,
    });
    assert.equal(feedback.response.status, 200);
    assert.equal(feedback.value.operation, 'agent.feedback');
    assert.equal(dataOf(feedback.value).category, 'context');
    const feedbackReplay = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      key: 'task5-feedback-key',
      body: feedbackRequest,
    });
    assert.deepEqual(feedbackReplay.value, feedback.value);

    const beforeMismatch = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}`);
    const sequenceBeforeMismatch = dataOf(beforeMismatch.value).lastSequence;
    const mismatchedCheckpoint = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`, {
      method: 'POST',
      key: 'task5-checkpoint-mismatched-catalog',
      body: { apiVersion: '1', currentGoal: 'must not commit', characterBudget: 8000, capabilities: [] },
    });
    assert.equal(mismatchedCheckpoint.response.status, 409);
    assert.equal(mismatchedCheckpoint.value.operation, 'agent.checkpoint');
    assert.equal(mismatchedCheckpoint.value.error.code, 'CONFLICT');
    const afterMismatch = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}`);
    assert.equal(dataOf(afterMismatch.value).lastSequence, sequenceBeforeMismatch);

    const checkpoint = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`, {
      method: 'POST',
      key: 'task5-checkpoint-key',
      body: { apiVersion: '1', currentGoal: 'verify route context', characterBudget: 8000, capabilities },
    });
    assert.equal(checkpoint.response.status, 200);
    assert.equal(checkpoint.value.operation, 'agent.checkpoint');
    assert.equal(dataOf(checkpoint.value).taskProfile.source, 'akinator+ledger-revisions');
    assert.equal(dataOf(checkpoint.value).intakeStatus, 'ready');
    assert.equal(typeof dataOf(checkpoint.value).acceptedThrough, 'number');
    assert.equal(dataOf(checkpoint.value).nextAction, 'proceed');
    assert.deepEqual(dataOf(checkpoint.value).memoryPolicy, AVAILABLE_MEMORY_POLICY);
    assert.notEqual(dataOf(checkpoint.value).context, null);
  } finally {
    await runtime.close();
  }
});

test('HTTP checkpoint selects and replays a nudge from the final gated recommendations', async () => {
  const { runtime, databasePath } = await fixture();
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-http-nudge-open',
      body: openRequest(),
    });
    const openedData = dataOf(opened.value);
    const runId = openedData.runId as string;
    const verification = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/events`, {
      method: 'POST',
      key: 'task5-http-nudge-verification',
      body: {
        apiVersion: '1',
        events: [{
          eventId: 'task5-http-nudge-verification',
          eventType: 'verification.recorded',
          actor: 'test',
          occurredAt: '2026-08-27T00:00:00.000Z',
          outcome: 'passed',
          payload: { suite: 'focused' },
        }],
      },
    });
    assert.equal(verification.response.status, 200);
    const checkpointBody = {
      apiVersion: '1',
      changedPaths: ['src/server/routes/task5.ts'],
      capabilities,
    };
    const first = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`, {
      method: 'POST',
      key: 'task5-http-nudge-checkpoint',
      body: checkpointBody,
    });
    assert.equal(first.response.status, 200);
    const firstData = dataOf(first.value);
    assert.ok(firstData.recommendations.some((item: any) => item.code === 'VERIFY_AFTER_MUTATION'));
    assert.equal(firstData.nudge?.code, 'VERIFY_AFTER_MUTATION');
    assert.equal(firstData.nudge?.policyVersion, 'nudges.v1');

    const replay = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`, {
      method: 'POST',
      key: 'task5-http-nudge-checkpoint',
      body: checkpointBody,
    });
    assert.equal(replay.response.status, 200);
    const replayData = dataOf(replay.value);
    assert.deepEqual(replayData.nudge, firstData.nudge);

    const database = openConnection(databasePath);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM nudge_deliveries WHERE run_id = ?')
        .get<{ count: number }>(runId)?.count, 1);
    } finally {
      database.close();
    }
  } finally {
    await runtime.close();
  }
});

test('checkpoint withholds actionable memory and continues without persisting a delivery when memory-reasoning is unavailable', async () => {
  const { runtime, databasePath } = await fixture();
  let runId: string | undefined;
  let deliveryCountBefore = -1;
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-blocked-open',
      body: openRequest(SOUL_CAPABILITIES),
    });
    assert.equal(opened.response.status, 200);
    const openedData = dataOf(opened.value);
    runId = openedData.runId as string;
    assert.equal(openedData.nextAction, 'proceed');
    assert.deepEqual(openedData.memoryPolicy, missingMemoryPolicy(20));
    assert.equal(openedData.context, null);
    assert.deepEqual(openedData.recommendations, []);
    const before = openConnection(databasePath);
    try {
      recordEntry(before, {
        workspace,
        kind: 'lesson',
        title: 'Implement route context checkpoint-only guidance',
        body: 'Implement this route after verifying the current checkpoint evidence.',
        summary: 'Checkpoint-only route context',
        tags: ['src/server/routes/task5.ts'],
      });
      deliveryCountBefore = before.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count ?? -1;
      assert.ok(deliveryCountBefore >= 0);
    } finally {
      before.close();
    }

    const checkpoint = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`, {
      method: 'POST',
      key: 'task5-blocked-checkpoint',
      body: {
        apiVersion: '1',
        currentGoal: 'continue implementation',
        changedPaths: ['src/server/routes/task5.ts'],
        characterBudget: 8000,
        capabilities: SOUL_CAPABILITIES,
      },
    });
    assert.equal(checkpoint.response.status, 200);
    const checkpointData = dataOf(checkpoint.value);
    assert.equal(checkpointData.nextAction, 'proceed', JSON.stringify(checkpointData));
    assert.deepEqual(checkpointData.memoryPolicy, missingMemoryPolicy(21));
    assert.equal(checkpointData.context, null);
    assert.deepEqual(checkpointData.recommendations, []);
    assert.ok(checkpointData.capabilities.recommendations.some((item: { name: string; required?: boolean; availability: string }) => item.name === 'memory-reasoning'
      && item.required === true
      && item.availability === 'missing'));
  } finally {
    await runtime.close();
  }

  assert.ok(runId);
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(runId)?.count, deliveryCountBefore);
  } finally {
    database.close();
  }
});

test('checkpoint fails instead of persisting a revision that changes after capability approval', async () => {
  const { runtime, databasePath } = await fixture();
  const prototype = ContextBroker.prototype as any;
  const originalQueryGated = prototype.queryGated;
  let persistenceAttempted = false;
  let persistenceFailure: unknown;
  let runId: string | undefined;
  let deliveryCountBefore = -1;
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-revision-race-open',
      body: openRequest(),
    });
    assert.equal(opened.response.status, 200);
    runId = dataOf(opened.value).runId as string;
    const before = openConnection(databasePath);
    try {
      recordEntry(before, {
        workspace,
        kind: 'lesson',
        title: 'Checkpoint revision race guidance',
        body: 'This entry is first eligible after the run opens.',
        tags: ['src/server/routes/task5.ts'],
      });
      deliveryCountBefore = before.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(runId)?.count ?? -1;
    } finally {
      before.close();
    }

    prototype.queryGated = async function (this: ContextBroker, rawInput: unknown, decide: (candidate: unknown) => unknown, persistence: { enqueueWrite?: (operation: () => unknown) => unknown }) {
      return originalQueryGated.call(this, rawInput, decide, {
        enqueueWrite: async (operation: () => unknown) => {
          persistenceAttempted = true;
          try {
            assert.equal(typeof persistence.enqueueWrite, 'function');
            const brokerDatabase = (this as unknown as { database: ReturnType<typeof openConnection> }).database;
            const selected = brokerDatabase.prepare('SELECT id FROM entries WHERE workspace = ? ORDER BY id LIMIT 1')
              .get<{ id: string }>(workspace);
            assert.ok(selected);
            const entry = readEntry(brokerDatabase, { workspace, entryId: selected.id });
            updateCandidateEntry(brokerDatabase, {
              workspace,
              entryId: entry.id,
              expectedRevision: entry.revision,
              kind: entry.kind,
              title: entry.title,
              body: `${entry.body} Concurrent revision.`,
              summary: entry.summary,
              scope: entry.scope,
              provenance: entry.provenance,
              tags: entry.tags,
            });
            return await persistence.enqueueWrite!(operation);
          } catch (error) {
            persistenceFailure = error;
            throw error;
          }
        },
      });
    };

    const checkpoint = await request(runtime.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/checkpoints`, {
      method: 'POST',
      key: 'task5-revision-race-checkpoint',
      body: {
        apiVersion: '1',
        currentGoal: 'reject a stale selected revision',
        changedPaths: ['src/server/routes/task5.ts'],
        characterBudget: 8000,
        capabilities,
      },
    });
    assert.equal(persistenceAttempted, true, JSON.stringify(checkpoint.value));
    assert.ok(persistenceFailure instanceof Error, JSON.stringify(checkpoint.value));
    assert.equal((persistenceFailure as { code?: unknown }).code, 'CONFLICT', `${persistenceFailure.name}: ${persistenceFailure.message}`);
    assert.equal(checkpoint.response.status, 409);
    assert.equal(checkpoint.value.operation, 'agent.checkpoint');
    assert.equal(checkpoint.value.error.code, 'CONFLICT');
  } finally {
    prototype.queryGated = originalQueryGated;
    await runtime.close();
  }

  assert.ok(runId);
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count, deliveryCountBefore);
  } finally {
    database.close();
  }
});

test('checkpoint replay keeps its mutation acknowledgement but gates with the current broker profile', async () => {
  const { runtime, databasePath } = await fixture();
  const body = {
    ...openRequest(SOUL_CAPABILITIES),
    task: {
      title: 'Implement route context',
      query: 'Implement this route',
      profileHints: {
        taskType: 'research' as const,
        target: 'src/server/routes',
        expected: 'document the current behavior',
        constraints: null,
      },
    },
  };
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-current-profile-open',
      body,
    });
    assert.equal(opened.response.status, 200);
    const openedData = dataOf(opened.value);
    assert.equal(openedData.taskProfile.taskType, 'research');
    assert.equal(openedData.nextAction, 'proceed');

    const beforeFirstCheckpoint = openConnection(databasePath);
    try {
      recordEntry(beforeFirstCheckpoint, {
        workspace,
        kind: 'lesson',
        title: 'Implement route context first checkpoint guidance',
        body: 'Research the checkpoint response using current repository evidence.',
        tags: ['src/server/routes/task5.ts'],
      });
    } finally {
      beforeFirstCheckpoint.close();
    }
    const firstBody = {
      apiVersion: '1',
      currentGoal: 'research current checkpoint state',
      capabilities: SOUL_CAPABILITIES,
    };
    const first = await request(runtime.url, `/api/v1/agent/runs/${openedData.runId}/checkpoints`, {
      method: 'POST',
      key: 'task5-current-profile-first',
      body: firstBody,
    });
    assert.equal(first.response.status, 200);
    const firstData = dataOf(first.value);
    assert.equal(firstData.taskProfile.taskType, 'research');
    assert.equal(firstData.nextAction, 'proceed');

    const beforeRevision = openConnection(databasePath);
    try {
      recordEntry(beforeRevision, {
        workspace,
        kind: 'lesson',
        title: 'Implement route context revised build guidance',
        body: 'Implement the revised route only after verifying its focused test.',
        tags: ['src/server/routes/task5.ts', 'build'],
      });
    } finally {
      beforeRevision.close();
    }
    const revised = await request(runtime.url, `/api/v1/agent/runs/${openedData.runId}/checkpoints`, {
      method: 'POST',
      key: 'task5-current-profile-revision',
      body: {
        apiVersion: '1',
        currentGoal: 'implement the revised route',
        taskProfileRevision: { taskType: 'build' },
        capabilities: SOUL_CAPABILITIES,
      },
    });
    assert.equal(revised.response.status, 200);
    assert.equal(dataOf(revised.value).taskProfile.taskType, 'build');
    assert.equal(dataOf(revised.value).nextAction, 'proceed');

    const beforeReplay = openConnection(databasePath);
    const deliveriesBeforeReplay = beforeReplay.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(openedData.runId)?.count;
    beforeReplay.close();
    const replay = await request(runtime.url, `/api/v1/agent/runs/${openedData.runId}/checkpoints`, {
      method: 'POST',
      key: 'task5-current-profile-first',
      body: firstBody,
    });
    assert.equal(replay.response.status, 200);
    const replayData = dataOf(replay.value);
    assert.equal(replayData.acceptedThrough, firstData.acceptedThrough);
    assert.equal(replayData.taskProfile.taskType, 'build');
    assert.equal(replayData.nextAction, 'proceed');
    assert.equal(replayData.context, null);

    const verified = openConnection(databasePath);
    try {
      assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(openedData.runId)?.count, deliveriesBeforeReplay);
    } finally {
      verified.close();
    }
  } finally {
    await runtime.close();
  }
});

test('exact checkpoint replay rejects a terminal run before broker delivery', async () => {
  const { runtime, databasePath } = await fixture();
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-terminal-replay-open',
      body: openRequest(),
    });
    assert.equal(opened.response.status, 200);
    const runId = dataOf(opened.value).runId as string;
    const checkpointBody = { apiVersion: '1', currentGoal: 'record the final checkpoint', capabilities };
    const checkpoint = await request(runtime.url, `/api/v1/agent/runs/${runId}/checkpoints`, {
      method: 'POST',
      key: 'task5-terminal-replay-checkpoint',
      body: checkpointBody,
    });
    assert.equal(checkpoint.response.status, 200);
    const before = openConnection(databasePath);
    const deliveriesBefore = before.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(runId)?.count;
    before.close();

    const closed = await request(runtime.url, `/api/v1/agent/runs/${runId}/close`, {
      method: 'POST',
      key: 'task5-terminal-replay-close',
      body: { apiVersion: '1', status: 'completed' },
    });
    assert.equal(closed.response.status, 200);
    const replay = await request(runtime.url, `/api/v1/agent/runs/${runId}/checkpoints`, {
      method: 'POST',
      key: 'task5-terminal-replay-checkpoint',
      body: checkpointBody,
    });
    assert.equal(replay.response.status, 409);
    assert.equal(replay.value.error.code, 'CONFLICT');

    const verified = openConnection(databasePath);
    try {
      assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(runId)?.count, deliveriesBefore);
    } finally {
      verified.close();
    }
  } finally {
    await runtime.close();
  }
});

test('Task5 delivery persistence forwards the transaction-time capability assertion', async () => {
  const { runtime, databasePath } = await fixture();
  const prototype = ContextBroker.prototype as any;
  const originalQueryGated = prototype.queryGated;
  let assertionForwarded = false;
  let assertionInvoked = false;
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-assertion-forward-open',
      body: openRequest(),
    });
    assert.equal(opened.response.status, 200);
    const runId = dataOf(opened.value).runId as string;
    const database = openConnection(databasePath);
    try {
      recordEntry(database, {
        workspace,
        kind: 'lesson',
        title: 'Task5 transaction assertion forwarding guidance',
        body: 'Verify capability state inside the delivery transaction.',
        tags: ['src/server/routes/task5.ts'],
      });
    } finally {
      database.close();
    }

    prototype.queryGated = async function (
      this: ContextBroker,
      rawInput: unknown,
      decide: (candidate: unknown) => unknown,
      persistence: { enqueueWrite?: (operation: () => unknown) => unknown },
    ) {
      return originalQueryGated.call(this, rawInput, decide, {
        enqueueWrite: async (operation: () => unknown) => {
          assert.equal(typeof persistence.enqueueWrite, 'function');
          assertionForwarded = true;
          return persistence.enqueueWrite!(() => {
              assertionInvoked = true;
              return operation();
          });
        },
      });
    };
    const checkpoint = await request(runtime.url, `/api/v1/agent/runs/${runId}/checkpoints`, {
      method: 'POST',
      key: 'task5-assertion-forward-checkpoint',
      body: {
        apiVersion: '1',
        currentGoal: 'verify assertion forwarding',
        changedPaths: ['src/server/routes/task5.ts'],
        capabilities,
      },
    });
    assert.equal(checkpoint.response.status, 200, JSON.stringify(checkpoint.value));
    assert.equal(assertionForwarded, true);
    assert.equal(assertionInvoked, true);
  } finally {
    prototype.queryGated = originalQueryGated;
    await runtime.close();
  }
});

test('exact checkpoint replay re-evaluates current helpful feedback for its weak delivery', async () => {
  const { runtime, databasePath } = await fixture();
  const body = {
    ...openRequest(SOUL_CAPABILITIES),
    task: {
      title: 'beacon',
      query: 'beacon',
      profileHints: {
        taskType: 'research' as const,
        target: 'beacon',
        expected: 'document behavior',
        constraints: null,
      },
    },
  };
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      method: 'POST',
      key: 'task5-helpful-replay-open',
      body,
    });
    assert.equal(opened.response.status, 200);
    const runId = dataOf(opened.value).runId as string;
    const database = openConnection(databasePath);
    let entryId = '';
    try {
      entryId = recordEntry(database, {
        workspace,
        kind: 'reference',
        title: 'xxbeaconzz historical note',
        body: 'A prior observation with no actionable lexical token.',
        tags: [],
      }).id;
    } finally {
      database.close();
    }
    const checkpointBody = {
      apiVersion: '1',
      currentGoal: 'switch to implementation',
      taskProfileRevision: { taskType: 'build' },
      capabilities: SOUL_CAPABILITIES,
    };
    const checkpoint = await request(runtime.url, `/api/v1/agent/runs/${runId}/checkpoints`, {
      method: 'POST',
      key: 'task5-helpful-replay-checkpoint',
      body: checkpointBody,
    });
    assert.equal(checkpoint.response.status, 200);
    const checkpointData = dataOf(checkpoint.value);
    assert.equal(checkpointData.taskProfile.taskType, 'build');
    assert.equal(checkpointData.nextAction, 'proceed', JSON.stringify(checkpointData));
    assert.deepEqual(checkpointData.memoryPolicy, NO_MEMORY_POLICY);
    const delivered = checkpointData.context?.items.find((item: any) => item.entryId === entryId);
    assert.ok(delivered);
    assert.equal(delivered.selectionReasons.includes('literal_fallback_match'), true);

    const feedback = await request(runtime.url, `/api/v1/agent/runs/${runId}/feedback`, {
      method: 'POST',
      key: 'task5-helpful-replay-feedback',
      body: {
        apiVersion: '1',
        category: 'context',
        feedbackId: 'task5-helpful-replay-feedback-id',
        deliveryId: checkpointData.context.deliveryId,
        entryId,
        verdict: 'helpful',
      },
    });
    assert.equal(feedback.response.status, 200);

    const replay = await request(runtime.url, `/api/v1/agent/runs/${runId}/checkpoints`, {
      method: 'POST',
      key: 'task5-helpful-replay-checkpoint',
      body: checkpointBody,
    });
    assert.equal(replay.response.status, 200);
    const replayData = dataOf(replay.value);
    assert.equal(replayData.nextAction, 'proceed');
    assert.deepEqual(replayData.memoryPolicy, missingMemoryPolicy(21));
    assert.equal(replayData.context, null);
    assert.ok(replayData.capabilities.recommendations.some((item: any) => item.name === 'memory-reasoning'
      && item.required === true
      && item.availability === 'missing'));
  } finally {
    await runtime.close();
  }
});
