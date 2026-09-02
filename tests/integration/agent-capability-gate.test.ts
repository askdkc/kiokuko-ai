import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { ContextBroker } from '../../src/context/broker.js';
import { recordContextFeedback } from '../../src/context/feedback.js';
import { openConnection } from '../../src/db/connection.js';
import { readEntry, recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';
import { documentsFromSkillSnapshot } from '../../src/skills/import-preparation.js';
import { importSkillSnapshot } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';

const token = 'c'.repeat(64);
const SOUL_CAPABILITY = { kind: 'skill', name: 'kiokuko-soul' } as const;

function memoryPolicy(availability: 'available' | 'missing' | 'unknown' | null) {
  return availability === null
    ? { memoryReasoningRequired: false, contextWithheld: false, withheldReason: null }
    : availability === 'available'
      ? { memoryReasoningRequired: true, contextWithheld: false, withheldReason: null }
      : {
        memoryReasoningRequired: true,
        contextWithheld: true,
        withheldReason: availability === 'missing'
          ? 'memory_reasoning_missing'
          : 'memory_reasoning_unknown',
        deliveryEmpty: true,
        storedEntryCount: 1,
      };
}

function soulCapabilities(...additional: unknown[]): unknown[] {
  return [SOUL_CAPABILITY, ...additional];
}

async function request(
  baseUrl: string,
  pathname: string,
  options: { body?: unknown; key?: string } = {},
): Promise<{ response: Response; data: any; value: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const value = await response.json() as any;
  return { response, data: value.data, value };
}

async function fixture(suffix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-agent-capability-gate-${suffix}-`));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const workspace = `project:agent-capability-${suffix}`;
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const entry = recordEntry(database, {
      workspace,
      kind: 'reference',
      title: 'Beacon implementation regression workflow',
      body: 'Implement the beacon with its focused regression test.',
      tags: ['build', 'beacon'],
    });
    const runtimeDirectory = path.join(directory, 'runtime');
    const runtime = await startAgentHttpServer({
      databasePath,
      runtimeDirectory,
      descriptorPath: path.join(runtimeDirectory, 'server.json'),
      capabilityToken: token,
    });
    return { databasePath, runtime, workspace, entryId: entry.id, entryRevision: entry.revision };
  } finally {
    database.close();
  }
}

function openBody(workspace: string, capabilities: unknown[] | undefined) {
  return {
    apiVersion: '1',
    workspace,
    client: { kind: 'generic' },
    task: {
      title: 'Implement the beacon regression workflow',
      query: 'Implement the beacon regression workflow',
      profileHints: {
        taskType: 'build',
        target: 'src/beacon.ts',
        expected: 'focused tests pass',
        constraints: null,
      },
    },
    captureProfile: 'minimal',
    coverage: {
      run: 'unavailable',
      tool: 'unavailable',
      command: 'unavailable',
      file: 'unavailable',
      approval: 'unavailable',
    },
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function intakeOpenBody(workspace: string, capabilities: unknown[] | undefined) {
  const value = openBody(workspace, capabilities);
  return {
    ...value,
    task: {
      ...value.task,
      profileHints: { ...value.task.profileHints, target: null },
    },
  };
}

async function makePriorContextActionable(
  baseUrl: string,
  openKey: string,
  body: ReturnType<typeof openBody>,
  opened: any,
  entry: { databasePath: string; workspace: string; entryId: string; entryRevision: number },
): Promise<any> {
  if (opened.nextAction === 'required_capability_unavailable'
    || opened.capabilities.recommendations.some((item: any) => item.required === true)) return opened;
  const runId = opened.runId as string;
  const deliveryId = opened.context.deliveryId as string;
  const entryId = opened.context.items[0].entryId as string;
  const feedback = await request(baseUrl, `/api/v1/agent/runs/${runId}/feedback`, {
    key: `${openKey}-feedback`,
    body: {
      apiVersion: '1',
      category: 'context',
      feedbackId: `${openKey}-feedback-id`,
      deliveryId,
      entryId,
      verdict: 'helpful',
    },
  });
  assert.equal(feedback.response.status, 200);
  const database = openConnection(entry.databasePath);
  try {
    updateCandidateEntry(database, {
      workspace: entry.workspace,
      entryId: entry.entryId,
      expectedRevision: entry.entryRevision,
      kind: 'reference',
      title: 'Beacon implementation regression workflow',
      body: 'Implement the beacon with its focused regression test and verify the revised result.',
      tags: ['build', 'beacon'],
    });
  } finally {
    database.close();
  }
  const event = await request(baseUrl, `/api/v1/agent/runs/${runId}/events`, {
    key: `${openKey}-event`,
    body: {
      apiVersion: '1',
      events: [{
        eventId: `${openKey}-event-id`,
        eventType: 'step.started',
        actor: 'test',
        occurredAt: '2026-08-25T00:00:00.000Z',
        payload: { step: 'verify' },
      }],
    },
  });
  assert.equal(event.response.status, 200);
  return (await request(baseUrl, '/api/v1/agent/runs', { key: openKey, body })).data;
}

test('generic Agent API withholds actionable repair memory but continues when memory-reasoning is missing', async () => {
  const value = await fixture('missing');
  try {
    const body = openBody(value.workspace, soulCapabilities());
    const first = await request(value.runtime.url, '/api/v1/agent/runs', { key: 'missing-open', body });
    assert.equal(first.response.status, 200);
    const before = openConnection(value.databasePath);
    const deliveriesBefore = before.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count ?? 0;
    before.close();

    const stopped = await makePriorContextActionable(value.runtime.url, 'missing-open', body, first.data, value);
    assert.equal(stopped.nextAction, 'proceed');
    assert.deepEqual(stopped.memoryPolicy, memoryPolicy('missing'));
    assert.equal(stopped.context, null);
    assert.deepEqual(stopped.recommendations, []);
    assert.ok(stopped.capabilities.recommendations.some((item: any) => item.name === 'memory-reasoning'
      && item.required === true
      && item.availability === 'missing'));

    const after = openConnection(value.databasePath);
    const deliveriesAfter = after.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count ?? 0;
    after.close();
    assert.equal(deliveriesAfter, deliveriesBefore);
  } finally {
    await value.runtime.close();
  }
});

test('generic Agent API proceeds with actionable repair memory only for the exact available local skill', async () => {
  const value = await fixture('available');
  try {
    const body = openBody(value.workspace, soulCapabilities({ kind: 'skill', name: 'memory-reasoning' }));
    const first = await request(value.runtime.url, '/api/v1/agent/runs', { key: 'available-open', body });
    assert.equal(first.response.status, 200);
    const proceeded = await makePriorContextActionable(value.runtime.url, 'available-open', body, first.data, value);
    assert.equal(proceeded.nextAction, 'proceed');
    assert.deepEqual(proceeded.memoryPolicy, memoryPolicy('available'));
    assert.notEqual(proceeded.context, null);
    assert.ok(proceeded.capabilities.recommendations.some((item: any) => item.name === 'memory-reasoning'
      && item.required === true
      && item.availability === 'available'), JSON.stringify(proceeded));
  } finally {
    await value.runtime.close();
  }
});

test('exact open replay keeps one mutation acknowledgement but re-evaluates current capability-gated context', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-capability-replay-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const workspace = 'project:agent-capability-replay';
  await initializeDatabase({ databasePath });
  const seeded = openConnection(databasePath);
  try {
    recordEntry(seeded, {
      workspace,
      kind: 'reference',
      title: 'xxbeaconzz historical note',
      body: 'A prior observation with no actionable lexical token.',
      tags: [],
    });
  } finally {
    seeded.close();
  }
  const runtimeDirectory = path.join(directory, 'runtime');
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    capabilityToken: token,
  });
  const body = {
    ...openBody(workspace, soulCapabilities()),
    task: {
      title: 'beacon',
      query: 'beacon',
      profileHints: {
        taskType: 'build',
        target: 'src/new.ts',
        expected: 'passes',
        constraints: null,
      },
    },
  };
  try {
    const first = await request(runtime.url, '/api/v1/agent/runs', { key: 'capability-replay-open', body });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.nextAction, 'proceed');
    assert.ok(first.data.context?.deliveryId);
    assert.equal(first.data.context.items[0]?.selectionReasons.includes('literal_fallback_match'), true);

    const before = openConnection(databasePath);
    let acknowledgementBefore: string;
    try {
      const response = before.prepare(`
        SELECT response_json AS response
        FROM gateway_idempotency
        WHERE scope = 'agent.run.open'
      `).get<{ response: string }>()?.response;
      assert.ok(response);
      acknowledgementBefore = response;
      const storedAcknowledgement = JSON.parse(response) as Record<string, unknown>;
      assert.equal('nextAction' in storedAcknowledgement, false);
      assert.equal('capabilities' in storedAcknowledgement, false);
      recordContextFeedback(before, {
        workspace,
        feedbackId: 'capability-replay-helpful',
        deliveryId: first.data.context.deliveryId,
        entryId: first.data.context.items[0].entryId,
        runId: first.data.runId,
        verdict: 'helpful',
        comment: null,
        actor: 'test',
        idempotencyKey: 'capability-replay-helpful-key',
        createdAt: '2026-08-25T00:00:00.000Z',
      });
    } finally {
      before.close();
    }

    const replay = await request(runtime.url, '/api/v1/agent/runs', { key: 'capability-replay-open', body });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.data.runId, first.data.runId);
    assert.equal(replay.data.intakeSessionId, first.data.intakeSessionId);
    assert.equal(replay.data.nextAction, 'proceed');
    assert.equal(replay.data.context, null);

    const after = openConnection(databasePath);
    try {
      assert.equal(after.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 1);
      assert.equal(after.prepare(`SELECT COUNT(*) AS count FROM gateway_idempotency WHERE scope = 'agent.run.open'`).get<{ count: number }>()?.count, 1);
      assert.equal(after.prepare(`SELECT response_json AS response FROM gateway_idempotency WHERE scope = 'agent.run.open'`).get<{ response: string }>()?.response, acknowledgementBefore);
      assert.equal(after.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(first.data.runId)?.count, 1);
    } finally {
      after.close();
    }
  } finally {
    await runtime.close();
  }
});

test('exact open replay gates against the current broker profile after a checkpoint revision', async () => {
  const value = await fixture('current-profile-replay');
  const body = {
    ...openBody(value.workspace, soulCapabilities()),
    task: {
      title: 'Beacon implementation regression workflow',
      query: 'Beacon implementation regression workflow',
      profileHints: {
        taskType: 'research' as const,
        target: 'src/beacon.ts',
        expected: 'document the current behavior',
        constraints: null,
      },
    },
  };
  try {
    const first = await request(value.runtime.url, '/api/v1/agent/runs', {
      key: 'current-profile-replay-open',
      body,
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.taskProfile.taskType, 'research');
    assert.equal(first.data.nextAction, 'proceed');
    assert.ok(first.data.context?.deliveryId);
    const newlyRelevant = openConnection(value.databasePath);
    try {
      recordEntry(newlyRelevant, {
        workspace: value.workspace,
        kind: 'lesson',
        title: 'Beacon implementation regression workflow current profile guidance',
        body: 'Implement the beacon workflow only after verifying the current profile.',
        tags: ['beacon', 'build'],
      });
    } finally {
      newlyRelevant.close();
    }

    const revised = await request(value.runtime.url, `/api/v1/agent/runs/${first.data.runId}/checkpoints`, {
      key: 'current-profile-replay-checkpoint',
      body: {
        apiVersion: '1',
        currentGoal: 'implement the verified change',
        taskProfileRevision: { taskType: 'build' },
        capabilities: soulCapabilities(),
      },
    });
    assert.equal(revised.response.status, 200);
    assert.equal(revised.data.taskProfile.taskType, 'build');
    assert.equal(revised.data.nextAction, 'proceed');
    assert.match(revised.data.profileHash, /^[0-9a-f]{64}$/);
    assert.notEqual(revised.data.profileHash, first.data.profileHash);
    const database = openConnection(value.databasePath);
    const deliveriesBeforeReplay = database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(first.data.runId)?.count;
    database.close();

    const replay = await request(value.runtime.url, '/api/v1/agent/runs', {
      key: 'current-profile-replay-open',
      body,
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.data.runId, first.data.runId);
    assert.equal(replay.data.taskProfile.taskType, 'build');
    assert.equal(replay.data.profileHash, revised.data.profileHash);
    assert.equal(replay.data.nextAction, 'proceed');
    assert.equal(replay.data.context, null);
    assert.ok(replay.data.capabilities.recommendations.some((item: any) => item.name === 'memory-reasoning'
      && item.required === true
      && item.availability === 'missing'));

    const verified = openConnection(value.databasePath);
    try {
      assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(first.data.runId)?.count, deliveriesBeforeReplay);
    } finally {
      verified.close();
    }
  } finally {
    await value.runtime.close();
  }
});

test('exact open replay rejects a terminal authoritative run without another delivery', async () => {
  const value = await fixture('terminal-open-replay');
  const body = {
    ...openBody(value.workspace, []),
    task: {
      title: 'Research terminal open replay',
      query: 'Research terminal open replay',
      profileHints: {
        taskType: 'research' as const,
        target: 'terminal replay',
        expected: 'one active run',
        constraints: null,
      },
    },
  };
  try {
    const first = await request(value.runtime.url, '/api/v1/agent/runs', {
      key: 'terminal-open-replay-key',
      body,
    });
    assert.equal(first.response.status, 200);
    const database = openConnection(value.databasePath);
    const deliveriesBefore = database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(first.data.runId)?.count;
    database.close();

    const closed = await request(value.runtime.url, `/api/v1/agent/runs/${first.data.runId}/close`, {
      key: 'terminal-open-replay-close',
      body: { apiVersion: '1', status: 'completed' },
    });
    assert.equal(closed.response.status, 200);

    const replay = await request(value.runtime.url, '/api/v1/agent/runs', {
      key: 'terminal-open-replay-key',
      body,
    });
    assert.equal(replay.response.status, 409);
    assert.equal(replay.value.error.code, 'CONFLICT');

    const verified = openConnection(value.databasePath);
    try {
      assert.equal(verified.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
        .get<{ status: string }>(first.data.runId)?.status, 'completed');
      assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
        .get<{ count: number }>(first.data.runId)?.count, deliveriesBefore);
    } finally {
      verified.close();
    }
  } finally {
    await value.runtime.close();
  }
});

test('generic Agent build does not treat managed external skill references as ordinary memory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-agent-external-reference-'));
  const repositoryRoot = path.join(directory, 'repository');
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  execFileSync('git', ['init', '-q', repositoryRoot]);
  await writeFile(path.join(repositoryRoot, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  let workspace = '';
  try {
    const project = await resolveProjectWorkspace(database, repositoryRoot);
    assert.ok(project);
    workspace = project.workspace;
    const candidate = {
      id: 'fixture:sveltejs/ai-tools:svelte-code-writer',
      provider: 'fixture',
      name: 'svelte-code-writer',
      slug: 'svelte-code-writer',
      source: 'sveltejs/ai-tools',
      sourceType: 'github' as const,
      installUrl: 'https://github.com/sveltejs/ai-tools',
      installs: 1,
      duplicate: false,
      officialStatus: 'registry-only' as const,
      auditStatus: 'passed' as const,
    };
    const snapshot = validateSkillSnapshot({
      candidate,
      sourceCommit: 'd'.repeat(40),
      files: [{
        path: 'skills/svelte-code-writer/SKILL.md',
        content: '---\nname: Svelte Code Writer\ndescription: Safe Svelte reference\n---\n# Svelte\n\nVerify current repository evidence.',
        primary: true,
      }],
    });
    importSkillSnapshot(database, snapshot, documentsFromSkillSnapshot(snapshot), {
      id: 'svelte',
      technology: 'svelte',
      aliases: ['svelte'],
      queries: ['svelte'],
      owners: ['sveltejs'],
      repositories: ['sveltejs/ai-tools'],
      applicability: { frameworks: [{ name: 'Svelte' }] },
      signals: { packages: ['svelte'] },
      reason: 'Svelte fixture.',
    }, '2026-08-25T00:00:00.000Z');
  } finally {
    database.close();
  }
  const runtimeDirectory = path.join(directory, 'runtime');
  const runtime = await startAgentHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    capabilityToken: token,
  });
  try {
    const opened = await request(runtime.url, '/api/v1/agent/runs', {
      key: 'generic-external-reference-open',
      body: {
        ...openBody(workspace, soulCapabilities()),
        task: {
          title: 'Implement a Svelte component',
          query: 'Implement a Svelte component',
          profileHints: {
            taskType: 'build',
            target: 'Svelte component',
            expected: 'tests pass',
            constraints: null,
          },
        },
      },
    });
    assert.equal(opened.response.status, 200);
    assert.equal(opened.data.nextAction, 'proceed', JSON.stringify(opened.data));
    assert.deepEqual(opened.data.memoryPolicy, memoryPolicy(null));
    assert.notEqual(opened.data.context, null);
    assert.ok(opened.data.context.items.length > 0);
    assert.ok(opened.data.context.items.every((item: any) => item.origin === 'ecosystem'));
    assert.equal(opened.data.capabilities.recommendations.some((item: any) => item.name === 'memory-reasoning'), false);
  } finally {
    await runtime.close();
  }
});

test('generic Agent open and answer apply identical missing, unknown, and available capability gates', async () => {
  const value = await fixture('open-answer-parity');
  const scenarios = [
    { label: 'missing', catalog: soulCapabilities(), availability: 'missing', nextAction: 'proceed', withheld: true },
    { label: 'unknown', catalog: soulCapabilities({ kind: 'invalid', name: 'invalid' }), availability: 'unknown', nextAction: 'proceed', withheld: true },
    {
      label: 'available',
      catalog: soulCapabilities({ kind: 'skill', name: 'memory-reasoning' }),
      availability: 'available',
      nextAction: 'proceed',
      withheld: false,
    },
  ] as const;
  try {
    for (const scenario of scenarios) {
      const ready = await request(value.runtime.url, '/api/v1/agent/runs', {
        key: `parity-${scenario.label}-ready`,
        body: openBody(value.workspace, scenario.catalog),
      });
      assert.equal(ready.response.status, 200);
      assert.equal(ready.data.nextAction, scenario.nextAction);
      assert.deepEqual(ready.data.memoryPolicy, memoryPolicy(scenario.availability));

      const opened = await request(value.runtime.url, '/api/v1/agent/runs', {
        key: `parity-${scenario.label}-intake`,
        body: intakeOpenBody(value.workspace, scenario.catalog),
      });
      assert.equal(opened.response.status, 200);
      assert.equal(opened.data.nextAction, 'answer_from_evidence_or_ask_user');
      assert.deepEqual(opened.data.memoryPolicy, memoryPolicy(null));
      assert.equal(opened.data.currentQuestion.id, 'target');
      const answerBody = {
        apiVersion: '1',
        questionId: 'target',
        value: 'src/beacon.ts',
        ...(scenario.catalog === undefined ? {} : { capabilities: scenario.catalog }),
      };
      const answered = await request(value.runtime.url, `/api/v1/agent/runs/${opened.data.runId}/intake/answers`, {
        key: `parity-${scenario.label}-answer`,
        body: answerBody,
      });
      assert.equal(answered.response.status, 200);
      assert.equal(answered.data.nextAction, scenario.nextAction);
      assert.deepEqual(answered.data.memoryPolicy, memoryPolicy(scenario.availability));

      for (const response of [ready.data, answered.data]) {
        assert.ok(response.capabilities.recommendations.some((item: any) => item.name === 'memory-reasoning'
          && item.required === true
          && item.availability === scenario.availability));
        if (scenario.withheld) {
          assert.equal(response.context, null);
          assert.deepEqual(response.recommendations, []);
        } else {
          assert.notEqual(response.context, null);
        }
      }
    }
  } finally {
    await value.runtime.close();
  }
});

test('exact open replay of the initial intake acknowledgement uses the current answered candidate', async () => {
  const value = await fixture('answered-open-replay');
  const body = intakeOpenBody(value.workspace, soulCapabilities());
  try {
    const opened = await request(value.runtime.url, '/api/v1/agent/runs', {
      key: 'answered-open-replay-key',
      body,
    });
    assert.equal(opened.response.status, 200);
    assert.equal(opened.data.intakeStatus, 'needs_answer');
    assert.equal(opened.data.nextAction, 'answer_from_evidence_or_ask_user');

    const answered = await request(value.runtime.url, `/api/v1/agent/runs/${opened.data.runId}/intake/answers`, {
      key: 'answered-open-replay-answer',
      body: {
        apiVersion: '1',
        questionId: 'target',
        value: 'src/beacon.ts',
        capabilities: soulCapabilities(),
      },
    });
    assert.equal(answered.response.status, 200);
    assert.equal(answered.data.intakeStatus, 'ready');
    assert.equal(answered.data.nextAction, 'proceed');

    const replay = await request(value.runtime.url, '/api/v1/agent/runs', {
      key: 'answered-open-replay-key',
      body,
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.data.runId, opened.data.runId);
    assert.equal(replay.data.intakeStatus, 'ready');
    assert.equal(replay.data.intake.status, 'ready');
    assert.equal(replay.data.taskProfile.target, 'src/beacon.ts');
    assert.equal(replay.data.nextAction, 'proceed');
    assert.equal(replay.data.context, null);
  } finally {
    await value.runtime.close();
  }
});

test('generic Agent open fails instead of persisting a revision that changes after capability approval', async () => {
  const value = await fixture('revision-race');
  const prototype = ContextBroker.prototype as any;
  const originalQueryGated = prototype.queryGated;
  let persistenceAttempted = false;
  let persistenceFailure: unknown;
  try {
    prototype.queryGated = async function (
      this: ContextBroker,
      rawInput: unknown,
      decide: (candidate: unknown) => unknown,
      persistence: { enqueueWrite?: (operation: () => unknown) => unknown },
    ) {
      return originalQueryGated.call(this, rawInput, decide, {
        enqueueWrite: async (operation: () => unknown) => {
          persistenceAttempted = true;
          try {
            assert.equal(typeof persistence.enqueueWrite, 'function');
            const brokerDatabase = (this as unknown as { database: ReturnType<typeof openConnection> }).database;
            const selected = brokerDatabase.prepare('SELECT id FROM entries WHERE workspace = ? ORDER BY id LIMIT 1')
              .get<{ id: string }>(value.workspace);
            assert.ok(selected);
            const entry = readEntry(brokerDatabase, { workspace: value.workspace, entryId: selected.id });
            updateCandidateEntry(brokerDatabase, {
              workspace: value.workspace,
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

    const opened = await request(value.runtime.url, '/api/v1/agent/runs', {
      key: 'generic-revision-race-open',
      body: openBody(value.workspace, soulCapabilities({ kind: 'skill', name: 'memory-reasoning' })),
    });
    assert.equal(persistenceAttempted, true, JSON.stringify(opened.data));
    assert.ok(persistenceFailure instanceof Error, JSON.stringify(opened.data));
    assert.equal((persistenceFailure as { code?: unknown }).code, 'CONFLICT');
    assert.equal(opened.response.status, 409);
  } finally {
    prototype.queryGated = originalQueryGated;
    await value.runtime.close();
  }

  const database = openConnection(value.databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries')
      .get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});
