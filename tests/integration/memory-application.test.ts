import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { openConnection } from '../../src/db/connection.js';
import { loadMigrationSnapshot, migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';
import { reviewTaskMemory, recordMemoryEvidence, memoryApplicationStatus, verifyTaskMemory } from '../../src/context/memory-application.js';
import { refreshTaskContext } from '../../src/context/refresh.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
async function fixture(taskType: 'build' | 'review' = 'build') {
  const directory = mkdtempSync(path.join(tmpdir(), 'memory-application-'));
  const root = path.join(directory, 'repo');
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(path.join(root, 'migration-test.ts'), 'export const expected = [1, 2];\n');
  const databasePath = path.join(directory, 'memory.sqlite');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  const project = (await resolveProjectWorkspace(database, root))!;
  const entry = recordEntry(database, { workspace: project.workspace, kind: 'lesson', title: 'migration expectation',
    body: 'Derive current migration expectations from bundled migration files. Adding a future migration must pass. Historical fixtures may pin versions.',
    confidence: 0.9, createdBy: 'test', scope: {} });
  const prepared = await prepareOpenCodeTask(database, { cwd: root, requestId: 'memory-regression',
    task: 'Implement migration expectation code', profileHints: { taskType, target: 'migration-test.ts code', expected: 'migration expectation follows future migrations', constraints: null },
    capabilities, skillDiscoveryMode: 'off' });
  assert.ok(prepared.context?.deliveryId);
  assert.ok(prepared.context.items.some(item => item.entryId === entry.id));
  const identity = { cwd: root, runId: prepared.run.runId, deliveryId: prepared.context.deliveryId };
  const review = { ...identity, entryId: entry.id, entryRevision: entry.revision, expectedRevision: 0,
    requestId: 'review-1', decision: 'adopt', basis: 'migration-test.ts contains a fixed current-version array',
    invariant: 'Current expectations track every bundled migration', counterexample: 'Add one future migration',
    verificationMethod: 'Run the current and future migration fixture', evidenceIds: [] };
  const checkpoint = { ...identity, memories: [], outcome: 'completed' as const, evidence: { verification: { outcome: 'fresh' } } };
  return { directory, root, databasePath, database, project, prepared, entry, identity, review, checkpoint,
    cleanup: () => { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('missing, failed and stale regression evidence cannot support fresh completion; restart preserves reports', async () => {
  const f = await fixture();
  try {
    assert.equal(memoryApplicationStatus(f.database, f.identity.runId, f.root).complete, false);
    await assert.rejects(checkpointScopedMemory(f.database, f.checkpoint), { code: 'CONFLICT' });
    const first = await reviewTaskMemory(f.database, f.review);
    assert.deepEqual(await reviewTaskMemory(f.database, f.review), first);
    await assert.rejects(reviewTaskMemory(f.database, { ...f.review, basis: 'changed' }), { code: 'CONFLICT' });
    const failed = await recordMemoryEvidence(f.database, { ...f.identity, requestId: 'failed', command: 'node migration-test.ts',
      paths: ['migration-test.ts'], exitCode: 1, outcome: 'failed' });
    await reviewTaskMemory(f.database, { ...f.review, expectedRevision: 1, requestId: 'review-failed', evidenceIds: [failed.evidenceId] });
    await assert.rejects(checkpointScopedMemory(f.database, f.checkpoint), { code: 'CONFLICT' });
    writeFileSync(path.join(f.root, 'migration-test.ts'), 'export const expected = discoverBundledMigrations();\n');
    const passed = await recordMemoryEvidence(f.database, { ...f.identity, requestId: 'passed', command: 'node migration-test.ts',
      paths: ['migration-test.ts'], exitCode: 0, outcome: 'passed' });
    await reviewTaskMemory(f.database, { ...f.review, expectedRevision: 2, requestId: 'review-passed', evidenceIds: [passed.evidenceId] });
    const reopened = openConnection(f.databasePath);
    try {
      const status = memoryApplicationStatus(reopened, f.identity.runId, f.root);
      assert.equal(status.complete, true);
      assert.equal(status.evidenceOrigin, 'model_reported');
      assert.equal(status.clientObserved, false);
      writeFileSync(path.join(f.root, 'migration-test.ts'), 'changed after verification\n');
      assert.equal(memoryApplicationStatus(reopened, f.identity.runId, f.root).invalid[0]?.reason, 'verification_stale');
      await assert.rejects(checkpointScopedMemory(reopened, f.checkpoint), { code: 'CONFLICT' });
      const cancelled = await checkpointScopedMemory(reopened, { ...f.checkpoint, outcome: 'cancelled' });
      assert.equal(cancelled.run?.status, 'cancelled');
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('non-applicable historical fixtures and plan reviews do not require implementation execution', async () => {
  for (const taskType of ['build', 'review'] as const) {
    const f = await fixture(taskType);
    try {
      await reviewTaskMemory(f.database, { ...f.review, decision: taskType === 'build' ? 'not_applicable' : 'adopt',
        basis: 'This fixture intentionally reconstructs historical schema version 2' });
      assert.equal(memoryApplicationStatus(f.database, f.identity.runId, f.root).complete, true);
      assert.equal((await checkpointScopedMemory(f.database, f.checkpoint)).run?.status, 'completed');
    } finally { f.cleanup(); }
  }
});

test('refresh stays in the same run and rejects changed catalog, stale revision and conflicting replay', async () => {
  const f = await fixture();
  try {
    await reviewTaskMemory(f.database, { ...f.review, decision: 'contradicted', basis: 'Current source disproves this memory' });
    const input = { cwd: f.root, runId: f.identity.runId, requestId: 'refresh', expectedContextRevision: f.prepared.contextRevision,
      capabilities, changedPaths: ['migration-test.ts'], errorSignatures: ['fixed migration array'] };
    const [result, concurrent] = await Promise.all([refreshTaskContext(f.database, input), refreshTaskContext(f.database, input)]);
    assert.deepEqual(concurrent, result);
    assert.equal(result.runId, f.identity.runId);
    assert.ok(result.contextRevision > f.prepared.contextRevision);
    assert.notEqual(result.context.deliveryId, f.identity.deliveryId);
    assert.deepEqual(await refreshTaskContext(f.database, input), result);
    await assert.rejects(refreshTaskContext(f.database, { ...input, errorSignatures: ['different'] }), { code: 'CONFLICT' });
    await assert.rejects(refreshTaskContext(f.database, { ...input, requestId: 'stale' }), { code: 'CONFLICT' });
    await assert.rejects(refreshTaskContext(f.database, { ...input, capabilities: [] }), { code: 'CONFLICT' });
    assert.ok(memoryApplicationStatus(f.database, f.identity.runId, f.root).pending.includes(f.entry.id));
    await assert.rejects(reviewTaskMemory(f.database, { ...f.review, requestId: 'old-delivery', expectedRevision: 1 }), { code: 'CONFLICT' });
    const repeated = await refreshTaskContext(f.database, { ...input, requestId: 'refresh-again', expectedContextRevision: result.contextRevision });
    assert.notEqual(repeated.context.deliveryId, result.context.deliveryId);
    assert.equal(memoryApplicationStatus(f.database, f.identity.runId, f.root).deliveryId, repeated.context.deliveryId);
  } finally { f.cleanup(); }
});

test('evidence rejects wrong repository, false success, traversal and untrusted observation fields', async () => {
  const f = await fixture();
  try {
    const input = { ...f.identity, requestId: 'evidence', command: 'test', outcome: 'passed', exitCode: 0, paths: ['migration-test.ts'] };
    await assert.rejects(recordMemoryEvidence(f.database, { ...input, cwd: f.directory }), { code: 'NOT_FOUND' });
    await assert.rejects(recordMemoryEvidence(f.database, { ...input, exitCode: 1 }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(recordMemoryEvidence(f.database, { ...input, paths: ['../outside'] }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(recordMemoryEvidence(f.database, { ...input, origin: 'client_observed' }), { code: 'VALIDATION_ERROR' });
  } finally { f.cleanup(); }
});

test('host verification detects the fixed-array recurrence and accepts derived expectations', async () => {
  const f = await fixture();
  try {
    const check = path.join(f.root, 'regression.mjs');
    const bundled = loadMigrationSnapshot();
    cpSync(path.resolve(import.meta.dirname, '../../migrations'), path.join(f.root, 'migrations'), { recursive: true });
    cpSync(path.join(f.root, 'migrations'), path.join(f.root, 'future-migrations'), { recursive: true });
    const versions = bundled.migrations.map(migration => migration.version);
    const future = versions.at(-1)! + 1;
    writeFileSync(path.join(f.root, 'future-migrations', `${String(future).padStart(3, '0')}_future.sql`), `PRAGMA user_version = ${future};\n`);
    writeFileSync(check, `import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
const bundled = directory => readdirSync(directory).filter(name => name.endsWith('.sql')).sort().map(name => Number(name.slice(0,3)));
const expectation = ${JSON.stringify(versions)};
assert.deepEqual(expectation, bundled('migrations'));
assert.deepEqual(expectation, bundled('future-migrations'));\n`);
    const verifier = { id: 'migration-regression', kind: 'test', executable: process.execPath,
      args: ['regression.mjs'], cwd: '.', timeoutMs: 5000 };
    const failed = await verifyTaskMemory(f.database, { ...f.identity, requestId: 'host-failed', paths: ['regression.mjs'], verifier });
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.origin, 'host_executed');
    await reviewTaskMemory(f.database, { ...f.review, evidenceIds: [failed.evidenceId] });
    await assert.rejects(checkpointScopedMemory(f.database, f.checkpoint), { code: 'CONFLICT' });
    writeFileSync(check, `import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
const versions = directory => readdirSync(directory).filter(name => name.endsWith('.sql')).sort().map(name => Number(name.slice(0,3)));
for (const directory of ['migrations', 'future-migrations']) {
  const expected = versions(directory);
  assert.deepEqual(expected, Array.from({length: readdirSync(directory).length}, (_, i) => i + 1));
}\n`);
    const futureDatabase = openConnection(':memory:');
    try {
      const snapshot = loadMigrationSnapshot(path.join(f.root, 'future-migrations'));
      assert.deepEqual(migrateDatabase(futureDatabase, path.join(f.root, 'future-migrations')).applied, snapshot.migrations.map(m => m.version));
    } finally { futureDatabase.close(); }
    const input = { ...f.identity, requestId: 'host-passed', paths: ['regression.mjs'], verifier };
    const passed = await verifyTaskMemory(f.database, input);
    assert.equal(passed.outcome, 'passed');
    assert.deepEqual(await verifyTaskMemory(f.database, input, { spawn: () => { throw new Error('must not execute replay'); } }), passed);
    await reviewTaskMemory(f.database, { ...f.review, requestId: 'adopt-host', expectedRevision: 1, evidenceIds: [passed.evidenceId] });
    assert.equal(memoryApplicationStatus(f.database, f.identity.runId, f.root).evidenceOrigin, 'host_executed');
    // Configuration outside the explicitly listed test is also bound by host execution.
    writeFileSync(path.join(f.root, 'settings.json'), '{"changed":true}\n');
    await assert.rejects(checkpointScopedMemory(f.database, f.checkpoint), { code: 'CONFLICT' });
  } finally { f.cleanup(); }
});

test('MCP application tools share domain validation and completed checkpoint decisions', async () => {
  const f = await fixture();
  const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.root });
  const client = new Client({ name: 'opencode', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const pending = await client.callTool({ name: 'task_memory_status', arguments: { cwd: f.root, runId: f.identity.runId } });
    assert.equal((pending.structuredContent as Record<string, unknown>)?.complete, false);
    const refused = await client.callTool({ name: 'memory_checkpoint', arguments: f.checkpoint });
    assert.equal(refused.isError, true);
    const reviewed = await client.callTool({ name: 'task_memory_review', arguments: { ...f.review, decision: 'not_applicable', basis: 'Historical schema fixture must remain pinned' } });
    assert.equal(reviewed.isError, undefined);
    assert.equal((reviewed.structuredContent as Record<string, unknown>)?.revision, 1);
    const completed = await client.callTool({ name: 'memory_checkpoint', arguments: f.checkpoint });
    assert.equal(completed.isError, undefined);
  } finally { await client.close(); await server.close(); f.cleanup(); }
});

test('review CAS, entry updates and foreign evidence cannot silently reuse an old decision', async () => {
  const f = await fixture();
  const other = await fixture();
  const connection = openConnection(f.databasePath);
  try {
    const decisions = await Promise.allSettled([
      reviewTaskMemory(f.database, { ...f.review, decision: 'not_applicable' }),
      reviewTaskMemory(connection, { ...f.review, requestId: 'concurrent', decision: 'contradicted' }),
    ]);
    assert.equal(decisions.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(decisions.filter(result => result.status === 'rejected' && result.reason.code === 'CONFLICT').length, 1);
    const foreign = await recordMemoryEvidence(other.database, { ...other.identity, requestId: 'other', command: 'test',
      paths: ['migration-test.ts'], outcome: 'passed', exitCode: 0 });
    await assert.rejects(reviewTaskMemory(f.database, { ...f.review, requestId: 'foreign', expectedRevision: 1,
      evidenceIds: [foreign.evidenceId] }), { code: 'CONFLICT' });
    updateCandidateEntry(f.database, { workspace: f.project.workspace, entryId: f.entry.id,
      expectedRevision: f.entry.revision, kind: 'lesson', title: f.entry.title, body: 'Updated migration evidence', createdBy: 'test' });
    assert.equal(memoryApplicationStatus(connection, f.identity.runId, f.root).invalid[0]?.reason, 'entry_revision_changed');
    await assert.rejects(reviewTaskMemory(connection, { ...f.review, requestId: 'stale-entry', expectedRevision: 1 }), { code: 'CONFLICT' });
  } finally { connection.close(); other.cleanup(); f.cleanup(); }
});

test('skip, unknown and unreadable verification state prevent fresh completion but allow cancellation', async () => {
  const f = await fixture();
  try {
    for (const [index, outcome] of (['skipped', 'unknown', 'passed'] as const).entries()) {
      const evidence = await recordMemoryEvidence(f.database, { ...f.identity, requestId: outcome, command: 'test',
        paths: ['migration-test.ts'], outcome, ...(outcome === 'passed' ? { exitCode: 0 } : {}) });
      await reviewTaskMemory(f.database, { ...f.review, requestId: `review-${outcome}`, expectedRevision: index, evidenceIds: [evidence.evidenceId] });
      if (outcome !== 'passed') await assert.rejects(checkpointScopedMemory(f.database, f.checkpoint), { code: 'CONFLICT' });
    }
    rmSync(path.join(f.root, 'migration-test.ts'));
    symlinkSync('missing-file.ts', path.join(f.root, 'migration-test.ts'));
    assert.equal(memoryApplicationStatus(f.database, f.identity.runId, f.root).invalid[0]?.reason, 'verification_state_unavailable');
    assert.equal((await checkpointScopedMemory(f.database, { ...f.checkpoint, outcome: 'cancelled' })).run?.status, 'cancelled');
  } finally { f.cleanup(); }
});

test('cancelled host execution and a failed result write never become success or execute twice', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const verifier = { id: 'cancel', kind: 'test', executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], cwd: '.', timeoutMs: 5000 };
    const input = { ...f.identity, requestId: 'cancel', paths: ['migration-test.ts'], verifier };
    const cancelled = await verifyTaskMemory(f.database, input, { signal: controller.signal, descendantSettleMs: 0,
      spawn: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        child.once('spawn', () => controller.abort());
        return child;
      }) as typeof spawn });
    assert.equal(cancelled.outcome, 'unknown');
    assert.deepEqual(await verifyTaskMemory(f.database, input, { spawn: () => { throw new Error('duplicate process'); } }), cancelled);

    f.database.exec(`CREATE TRIGGER reject_evidence_result BEFORE UPDATE ON task_memory_evidence BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
    const uncertain = { ...input, requestId: 'write-failure', verifier: { ...verifier, args: ['-e', 'process.exit(0)'] } };
    await assert.rejects(verifyTaskMemory(f.database, uncertain, { descendantSettleMs: 0 }), /test write failure/u);
    f.database.exec('DROP TRIGGER reject_evidence_result');
    const replay = await verifyTaskMemory(f.database, uncertain, { spawn: () => { throw new Error('duplicate process'); } });
    assert.equal(replay.outcome, 'unknown');
    assert.equal(replay.executionState, 'running');
  } finally { f.cleanup(); }
});
