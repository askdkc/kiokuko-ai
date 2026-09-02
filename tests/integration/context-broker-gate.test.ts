import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CONTEXT_BROKER_POLICY_VERSION, ContextBroker, type ContextBrokerPersistence } from '../../src/context/broker.js';
import { recordContextDelivery, type ContextDeliveryInput } from '../../src/context/delivery.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-25T00:00:00.000Z';

test('a rejected gated query and a durable query for the same hash do not share persistence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gated-flight-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const service = new AgentGatewayService(database, { now: () => now });
    const opened = service.openRun({
      idempotencyKey: 'gated-flight-open',
      request: {
        apiVersion: '1',
        workspace: 'gated-flight',
        client: { kind: 'test' },
        task: {
          title: 'Implement gated flight isolation',
          query: 'Implement gated flight isolation',
          profileHints: { taskType: 'build', target: 'src/gated-flight.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    recordEntry(database, {
      workspace: 'gated-flight',
      kind: 'lesson',
      title: 'Implement gated flight isolation',
      body: 'Keep gated decisions independent from durable context query flights.',
      tags: ['src/gated-flight.ts'],
    }, { now });

    const broker = new ContextBroker(database);
    const input = { workspace: 'run-bound', runId: opened.runId, changedPaths: ['src/gated-flight.ts'] };
    let releaseDurable!: () => void;
    const durableRelease = new Promise<void>((resolve) => { releaseDurable = resolve; });
    let reportDurableStarted!: () => void;
    const durableStarted = new Promise<void>((resolve) => { reportDurableStarted = resolve; });
    const durable = broker.query(input, {
      enqueueWrite: async (operation) => {
        reportDurableStarted();
        await durableRelease;
        return operation();
      },
    });
    await durableStarted;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const gated = await Promise.race([
      broker.queryGated(input, (candidate) => ({ persist: false, value: candidate.context?.items.length ?? 0 })),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('gated query shared the durable in-flight operation')), 1_000);
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    assert.equal(gated.value, 1);
    assert.equal(gated.broker.context?.items.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);

    releaseDurable();
    const persisted = await durable;
    assert.equal(persisted.context?.items.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('broker snapshots a plain gate decision and rejects an accessor that can flip persistence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gate-accessor-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const opened = new AgentGatewayService(database, { now: () => now }).openRun({
      idempotencyKey: 'gate-accessor-open',
      request: {
        apiVersion: '1',
        workspace: 'gate-accessor',
        client: { kind: 'test' },
        task: {
          title: 'Reject a stateful gate decision',
          query: 'Reject a stateful gate decision',
          profileHints: { taskType: 'build', target: 'src/gate-accessor.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    recordEntry(database, {
      workspace: 'gate-accessor',
      kind: 'lesson',
      title: 'Reject a stateful gate decision',
      body: 'A gate decision must be immutable data, not executable property access.',
      tags: ['src/gate-accessor.ts'],
    }, { now });
    let reads = 0;
    await assert.rejects(
      new ContextBroker(database).queryGated(
        { workspace: 'run-bound', runId: opened.runId },
        () => Object.defineProperties({}, {
          persist: {
            enumerable: true,
            get: () => {
              reads += 1;
              return reads > 1;
            },
          },
          value: { enumerable: true, value: 'nominally-rejected' },
        }) as { persist: boolean; value: string },
      ),
      (error: unknown) => error instanceof TypeError
        && error.message === 'Context broker gate returned an invalid decision',
    );
    assert.equal(reads, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('gated rejection writes no delivery when memory changes during the decision', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gate-reject-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const service = new AgentGatewayService(database, { now: () => now });
    const opened = service.openRun({
      idempotencyKey: 'gate-reject-open',
      request: {
        apiVersion: '1',
        workspace: 'gate-reject',
        client: { kind: 'test' },
        task: {
          title: 'Implement gated persistence',
          query: 'Implement gated persistence',
          profileHints: { taskType: 'build', target: 'src/gated.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    recordEntry(database, {
      workspace: 'gate-reject',
      kind: 'lesson',
      title: 'Implement gated persistence',
      body: 'Reject actionable memory before persistence.',
      tags: ['src/gated.ts'],
    }, { now });

    const broker = new ContextBroker(database);
    await assert.rejects(
      broker.queryGated(
        { workspace: 'run-bound', runId: opened.runId, changedPaths: ['src/gated.ts'] },
        (candidate) => {
          assert.equal(candidate.context?.items.length, 1);
          recordEntry(database, {
            workspace: 'gate-reject',
            kind: 'lesson',
            title: 'Concurrent gated persistence guidance',
            body: 'This entry appeared after the ranked candidate was fixed.',
            tags: ['src/gated.ts'],
          }, { now });
          return { persist: false, value: 'required_capability_unavailable' as const };
        },
        { enqueueWrite: () => { throw new Error('rejected candidate must not persist'); } },
      ),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === 'CONFLICT'
        && error.message === 'Context selection state changed after ranking',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('gated approval rejects a catalog mutation after ranking', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gate-approve-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const service = new AgentGatewayService(database, { now: () => now });
    const opened = service.openRun({
      idempotencyKey: 'gate-approve-open',
      request: {
        apiVersion: '1',
        workspace: 'gate-approve',
        client: { kind: 'test' },
        task: {
          title: 'Implement immutable gated persistence',
          query: 'Implement immutable gated persistence',
          profileHints: { taskType: 'build', target: 'src/immutable.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    const approved = recordEntry(database, {
      workspace: 'gate-approve',
      kind: 'lesson',
      title: 'Implement immutable gated persistence',
      body: 'Persist only the memory snapshot seen by the gate.',
      tags: ['src/immutable.ts'],
    }, { now });

    const broker = new ContextBroker(database);
    await assert.rejects(
      broker.queryGated(
        { workspace: 'run-bound', runId: opened.runId, changedPaths: ['src/immutable.ts'] },
        (candidate) => {
          assert.deepEqual(candidate.context?.items.map((item) => item.entryId), [approved.id]);
          recordEntry(database, {
            workspace: 'gate-approve',
            kind: 'lesson',
            title: 'Concurrent immutable persistence guidance',
            body: 'This entry must wait for a later broker query.',
            tags: ['src/immutable.ts'],
          }, { now });
          return { persist: true, value: 'proceed' as const };
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context selection state changed after ranking',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('delivery commit rejects a selected revision that advances after the gate approves it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gate-revision-race-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const service = new AgentGatewayService(database, { now: () => now });
    const opened = service.openRun({
      idempotencyKey: 'gate-revision-race-open',
      request: {
        apiVersion: '1',
        workspace: 'gate-revision-race',
        client: { kind: 'test' },
        task: {
          title: 'Implement revision race rejection',
          query: 'Implement revision race rejection',
          profileHints: { taskType: 'build', target: 'src/revision-race.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    const selected = recordEntry(database, {
      workspace: 'gate-revision-race',
      kind: 'lesson',
      title: 'Implement revision race rejection',
      body: 'Persist only the exact current revision approved by the gate.',
      tags: ['src/revision-race.ts'],
    }, { now });

    const broker = new ContextBroker(database);
    await assert.rejects(
      broker.queryGated(
        { workspace: 'run-bound', runId: opened.runId, changedPaths: ['src/revision-race.ts'] },
        (candidate) => {
          assert.deepEqual(candidate.context?.items.map((item) => [item.entryId, item.entryRevision]), [[selected.id, 1]]);
          return { persist: true, value: 'proceed' as const };
        },
        {
          enqueueWrite: (operation) => {
            updateCandidateEntry(database, {
              workspace: selected.workspace,
              entryId: selected.id,
              expectedRevision: 1,
              kind: selected.kind,
              title: selected.title,
              body: `${selected.body} Revised concurrently.`,
              summary: selected.summary,
              scope: selected.scope,
              provenance: selected.provenance,
              tags: selected.tags,
              now: '2026-08-25T00:00:01.000Z',
            });
            return operation();
          },
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context delivery selection changed before return',
    );

    assert.equal(database.prepare('SELECT current_revision AS revision FROM entries WHERE id = ?').get<{ revision: number }>(selected.id)?.revision, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('delivery return rejects a selected revision changed by the queue after the broker transaction', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gate-post-write-race-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const workspace = 'gate-post-write-race';
    const opened = new AgentGatewayService(database, { now: () => now }).openRun({
      idempotencyKey: 'gate-post-write-race-open',
      request: {
        apiVersion: '1',
        workspace,
        client: { kind: 'test' },
        task: {
          title: 'Reject post-write stale delivery',
          query: 'Reject post-write stale delivery',
          profileHints: { taskType: 'build', target: 'src/post-write.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    const selected = recordEntry(database, {
      workspace,
      kind: 'lesson',
      title: 'Reject post-write stale delivery',
      body: 'Revalidate the exact selected revision after the queue operation returns.',
      tags: ['src/post-write.ts'],
    }, { now });

    await assert.rejects(
      new ContextBroker(database).query(
        { workspace, runId: opened.runId, limit: 1 },
        {
          enqueueWrite: (operation) => {
            const delivery = operation();
            updateCandidateEntry(database, {
              workspace,
              entryId: selected.id,
              expectedRevision: selected.revision,
              kind: selected.kind,
              title: selected.title,
              summary: selected.summary,
              body: `${selected.body} Changed after the broker transaction.`,
              scope: selected.scope,
              provenance: selected.provenance,
              tags: selected.tags,
              now: '2026-08-25T00:00:01.000Z',
            });
            return delivery;
          },
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context delivery selection changed before return',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 1);
    assert.equal(database.prepare('SELECT current_revision AS revision FROM entries WHERE id = ?')
      .get<{ revision: number }>(selected.id)?.revision, 2);
  } finally {
    database.close();
  }
});

test('delivery commit rejects a same-revision search-signal mutation after ranking', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gate-signal-race-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const opened = new AgentGatewayService(database, { now: () => now }).openRun({
      idempotencyKey: 'gate-signal-race-open',
      request: {
        apiVersion: '1',
        workspace: 'gate-signal-race',
        client: { kind: 'test' },
        task: {
          title: 'Implement search signal race rejection',
          query: 'Implement search signal race rejection',
          profileHints: { taskType: 'build', target: 'src/signal-race.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    const selected = recordEntry(database, {
      workspace: 'gate-signal-race',
      kind: 'lesson',
      title: 'Implement search signal race rejection',
      body: 'Bind the exact search signals used by context retrieval.',
      tags: ['src/signal-race.ts'],
    }, { now });

    await assert.rejects(
      new ContextBroker(database).queryGated(
        { workspace: 'gate-signal-race', runId: opened.runId, changedPaths: ['src/signal-race.ts'] },
        (candidate) => {
          assert.equal(candidate.context?.items.some((item) => item.entryId === selected.id), true);
          return { persist: true, value: 'stale-signal-state' as const };
        },
        {
          enqueueWrite: (operation) => {
            database.prepare('DELETE FROM entry_search_signals WHERE entry_id = ?').run(selected.id);
            return operation();
          },
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context selection state changed after ranking',
    );
    assert.equal(database.prepare('SELECT current_revision AS revision FROM entries WHERE id = ?')
      .get<{ revision: number }>(selected.id)?.revision, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries')
      .get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('broker rechecks after a gate assertion and rolls back its in-transaction catalog mutation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gate-assertion-race-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const workspace = 'gate-assertion-race';
    const opened = new AgentGatewayService(database, { now: () => now }).openRun({
      idempotencyKey: 'gate-assertion-race-open',
      request: {
        apiVersion: '1',
        workspace,
        client: { kind: 'test' },
        task: {
          title: 'Reject gate assertion mutation',
          query: 'Reject gate assertion mutation',
          profileHints: { taskType: 'build', target: 'src/assertion-race.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    const selected = recordEntry(database, {
      workspace,
      kind: 'lesson',
      title: 'Reject gate assertion mutation',
      body: 'The broker must recheck state after the gate assertion returns.',
      tags: ['src/assertion-race.ts'],
    }, { now });
    const signalsBefore = database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals WHERE entry_id = ?')
      .get<{ count: number }>(selected.id)?.count ?? 0;
    assert.ok(signalsBefore > 0);

    await assert.rejects(
      new ContextBroker(database).queryGated(
        { workspace, runId: opened.runId },
        () => ({
          persist: true,
          value: 'hostile-assertion' as const,
          assertBeforePersist: () => {
            database.prepare('DELETE FROM entry_search_signals WHERE entry_id = ?').run(selected.id);
          },
        }),
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context selection state changed after ranking',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals WHERE entry_id = ?')
      .get<{ count: number }>(selected.id)?.count, signalsBefore);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 0);
  } finally {
    database.close();
  }
});

test('delivery commit rejects a concurrent delivery-history insertion that changes ranking', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-gate-history-race-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const workspace = 'gate-history-race';
    const opened = new AgentGatewayService(database, { now: () => now }).openRun({
      idempotencyKey: 'gate-history-race-open',
      request: {
        apiVersion: '1',
        workspace,
        client: { kind: 'test' },
        task: {
          title: 'Reject stale delivery history ranking',
          query: 'Reject stale delivery history ranking',
          profileHints: { taskType: 'build', target: 'src/history-race.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    const selected = recordEntry(database, {
      workspace,
      kind: 'lesson',
      title: 'Reject stale delivery history ranking',
      body: 'A concurrent prior delivery must suppress this exact revision.',
      tags: ['src/history-race.ts'],
    }, { now });

    await assert.rejects(
      new ContextBroker(database).queryGated(
        { workspace, runId: opened.runId, limit: 1 },
        (candidate) => {
          const item = candidate.context?.items[0];
          assert.equal(item?.entryId, selected.id);
          assert.ok(item);
          recordContextDelivery(database, {
            workspace,
            deliveryId: 'concurrent-history-delivery',
            runId: opened.runId,
            throughSequence: candidate.acceptedThrough,
            intakeSessionId: candidate.intakeSessionId,
            taskProfileHash: candidate.profileHash,
            queryHash: 'f'.repeat(64),
            policyVersion: CONTEXT_BROKER_POLICY_VERSION,
            charBudget: 8_000,
            charCount: item.content.characterCount,
            truncated: item.content.truncated,
            createdAt: now,
            items: [{
              entryId: item.entryId,
              entryRevision: item.entryRevision,
              rank: 1,
              scoreComponents: item.scoreComponents,
              selectionReasons: item.selectionReasons,
              ...(item.origin === undefined ? {} : { origin: item.origin }),
            }],
          });
          return { persist: true, value: 'stale-history-selection' as const };
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context delivery history changed after ranking',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ? AND delivery_id LIKE ?')
      .get<{ count: number }>(opened.runId, 'context-%')?.count, 0);
  } finally {
    database.close();
  }
});

test('a delivery rejected after a queued history write is never replayed as an attested selection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-post-queue-history-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const workspace = 'post-queue-history';
    const opened = new AgentGatewayService(database, { now: () => now }).openRun({
      idempotencyKey: 'post-queue-history-open',
      request: {
        apiVersion: '1',
        workspace,
        client: { kind: 'test' },
        task: {
          title: 'Reject post-queue history replay',
          query: 'Reject post-queue history replay',
          profileHints: { taskType: 'build', target: 'src/post-queue-history.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    const selected = recordEntry(database, {
      workspace,
      kind: 'lesson',
      title: 'Reject post-queue history replay',
      body: 'A delivery rejected after its queue operation must not replay as if it reached the caller.',
      tags: ['src/post-queue-history.ts'],
    }, { now });
    let approved: Awaited<ReturnType<ContextBroker['query']>> | null = null;

    await assert.rejects(
      new ContextBroker(database).queryGated(
        { workspace, runId: opened.runId, limit: 1 },
        (candidate) => {
          assert.equal(candidate.context?.items[0]?.entryId, selected.id);
          approved = candidate;
          return { persist: true, value: 'stale-after-queue' as const };
        },
        {
          enqueueWrite: (operation) => {
            const committed = operation();
            const snapshot = approved;
            const item = snapshot?.context?.items[0];
            assert.ok(snapshot);
            assert.ok(item);
            recordContextDelivery(database, {
              workspace,
              deliveryId: 'post-queue-concurrent-history',
              runId: opened.runId,
              throughSequence: snapshot.acceptedThrough,
              intakeSessionId: snapshot.intakeSessionId,
              taskProfileHash: snapshot.profileHash,
              queryHash: 'e'.repeat(64),
              policyVersion: CONTEXT_BROKER_POLICY_VERSION,
              charBudget: 8_000,
              charCount: item.content.characterCount,
              truncated: item.content.truncated,
              createdAt: now,
              items: [{
                entryId: item.entryId,
                entryRevision: item.entryRevision,
                rank: 1,
                scoreComponents: item.scoreComponents,
                selectionReasons: item.selectionReasons,
                ...(item.origin === undefined ? {} : { origin: item.origin }),
              }],
            });
            return committed;
          },
        },
      ),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'CONFLICT'
        && error.message === 'Context delivery history changed after ranking',
    );
    const rejectedDelivery = database.prepare(`
      SELECT delivery_id AS deliveryId
        FROM context_deliveries
       WHERE run_id = ? AND delivery_id LIKE 'context-%'
    `).get<{ deliveryId: string }>(opened.runId);
    assert.ok(rejectedDelivery);

    const refreshed = await new ContextBroker(database).query({ workspace, runId: opened.runId, limit: 1 });
    assert.notEqual(refreshed.context?.deliveryId, rejectedDelivery.deliveryId);
    assert.equal(refreshed.context?.items.some((item) => item.entryId === selected.id), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?')
      .get<{ count: number }>(opened.runId)?.count, 3);
  } finally {
    database.close();
  }
});

test('rejects the retired custom delivery writer before it can bypass broker-owned persistence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-retired-writer-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  try {
    const opened = new AgentGatewayService(database, { now: () => now }).openRun({
      idempotencyKey: 'retired-writer-open',
      request: {
        apiVersion: '1',
        workspace: 'retired-writer',
        client: { kind: 'test' },
        task: {
          title: 'Reject retired delivery writer',
          query: 'Reject retired delivery writer',
          profileHints: { taskType: 'build', target: 'src/retired.ts', expected: 'tests pass', constraints: null },
        },
        captureProfile: 'standard',
        coverage: { run: 'declared', tool: 'best_effort', command: 'best_effort', file: 'declared', approval: 'unavailable' },
        metadata: {},
      },
    });
    recordEntry(database, {
      workspace: 'retired-writer',
      kind: 'lesson',
      title: 'Reject retired delivery writer',
      body: 'The broker must own the assertion and delivery write transaction.',
      tags: ['src/retired.ts'],
    }, { now });
    let invoked = false;
    const hostileWrite = (delivery: ContextDeliveryInput) => {
      invoked = true;
      recordEntry(database, {
        workspace: 'retired-writer',
        kind: 'lesson',
        title: 'Concurrent better retired delivery writer result',
        body: 'This mutation would make the selected delivery stale.',
        tags: ['src/retired.ts'],
      }, { now: '2026-08-25T00:00:01.000Z' });
      return recordContextDelivery(database, delivery);
    };
    class RetiredPersistence {
      persistDelivery(delivery: ContextDeliveryInput) {
        return hostileWrite(delivery);
      }
    }
    const hiddenRetired = Object.defineProperty({}, 'persistDelivery', {
      value: hostileWrite,
      enumerable: false,
    });
    const retiredAdapters = [
      { persistDelivery: hostileWrite },
      new RetiredPersistence(),
      hiddenRetired,
    ] as unknown as ContextBrokerPersistence[];
    for (const retired of retiredAdapters) {
      await assert.rejects(
        new ContextBroker(database).query({ workspace: 'retired-writer', runId: opened.runId }, retired),
        (error: unknown) => error instanceof TypeError
          && error.message === 'Context broker persistence adapter is invalid',
      );
    }
    assert.equal(invoked, false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});
