import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { prepareOpenCodeTask, selectOpenCodeTaskExecution } from '../../src/akinator/opencode-task.js';
import { readExecutionRouting, executionView, recordExecutionDispatch } from '../../src/execution/store.js';
import { fixtureExecutionCatalog } from '../fixtures/execution-selection.js';

test('execution choice is request-bound, durable, idempotent and never starts ordinary work as Enno', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-selection-'));
  execFileSync('git', ['init', '-q', root]);
  const databasePath = path.join(root, 'test.sqlite');
  await initializeDatabase({ databasePath });
  let db = openConnection(databasePath);
  try {
    const input = { cwd: root, requestId: 'readme', task: 'Fix a README typo', profileHints: { taskType: 'build' as const, target: 'README.md', expected: 'typo fixed' },
      client: { kind: 'opencode' as const, sessionId: 'root-session' }, skillDiscoveryMode: 'off' as const, executionCatalog: fixtureExecutionCatalog() };
    const prepared = await prepareOpenCodeTask(db, input);
    assert.equal(prepared.execution?.choice, 'pending');
    assert.equal(prepared.ennoOduno.applicable, false);
    assert.equal(db.prepare('SELECT run_id FROM enno_contracts WHERE run_id = ?').get(prepared.run.runId), undefined);
    const ordinary = { runId: prepared.run.runId, cwd: root, expectedRevision: 0, idempotencyKey: 'ordinary', choice: 'ordinary' as const };
    const selected = selectOpenCodeTaskExecution(db, ordinary);
    assert.equal(selected.ennoOduno.applicable, false);
    assert.deepEqual(selectOpenCodeTaskExecution(db, ordinary), selected);
    assert.throws(() => selectOpenCodeTaskExecution(db, { ...ordinary, choice: 'enno', preset: 'openai' }), /changed/u);
    assert.equal((await prepareOpenCodeTask(db, input)).execution?.choice, 'ordinary');
    assert.equal(db.prepare('SELECT run_id FROM enno_contracts WHERE run_id = ?').get(prepared.run.runId), undefined);
    const second = await prepareOpenCodeTask(db, { ...input, requestId: 'code', task: 'Repair a function' });
    const selectedEnno = selectOpenCodeTaskExecution(db, { ...ordinary, runId: second.run.runId, idempotencyKey: 'enno', choice: 'enno', preset: 'openai' });
    assert.equal(selectedEnno.ennoOduno.applicable, true);
    assert.equal(selectedEnno.execution?.selected?.gokiHead.model, 'openai/gpt-5.6-sol');
    assert.equal(selectedEnno.execution?.selected?.gokiWorker.model, 'openai/gpt-5.6-luna');
    db.close(); db = openConnection(databasePath);
    assert.deepEqual(executionView(db, second.run.runId), selectedEnno.execution);
    const routing = readExecutionRouting(db, { runId: second.run.runId, cwd: root, rootSessionId: 'root-session' });
    assert.equal(routing.role, 'ideal');
    const dispatch = { runId: second.run.runId, cwd: root, rootSessionId: 'root-session', revision: 1, role: 'ideal' as const,
      agent: routing.selected!.ideal.agent, promptDigest: 'a'.repeat(64), callId: 'first-call', stage: 'begin' as const };
    recordExecutionDispatch(db, dispatch);
    db.close(); db = openConnection(databasePath);
    assert.throws(() => recordExecutionDispatch(db, { ...dispatch, callId: 'retry' }), /already dispatched/u);
    recordExecutionDispatch(db, { ...dispatch, stage: 'complete' });
    assert.deepEqual(recordExecutionDispatch(db, { ...dispatch, stage: 'complete' }), { accepted: true });
    assert.throws(() => recordExecutionDispatch(db, { ...dispatch, stage: 'failed' }), /terminal/u);
    assert.equal(executionView(db, second.run.runId)?.modelFailure, false);
    assert.throws(() => recordExecutionDispatch(db, { ...dispatch, callId: 'duplicate' }), /already dispatched/u);
    const third = await prepareOpenCodeTask(db, { ...input, requestId: 'parallel', client: { kind: 'opencode', sessionId: 'parallel-session' } });
    const parallel = selectOpenCodeTaskExecution(db, { ...ordinary, runId: third.run.runId, idempotencyKey: 'parallel', choice: 'enno', preset: 'openrouter-glm' });
    assert.equal(parallel.execution!.selected!.ideal.model, 'openrouter/z-ai/glm-5.3');
    const failing = { ...dispatch, runId: third.run.runId, rootSessionId: 'parallel-session',
      agent: parallel.execution!.selected!.ideal.agent, callId: 'failed-call' };
    recordExecutionDispatch(db, failing);
    recordExecutionDispatch(db, { ...failing, stage: 'failed' });
    db.close(); db = openConnection(databasePath);
    assert.deepEqual(recordExecutionDispatch(db, { ...failing, stage: 'failed' }), { accepted: true });
    assert.throws(() => recordExecutionDispatch(db, { ...failing, stage: 'complete' }), /terminal/u);
    assert.equal(executionView(db, third.run.runId)?.modelFailure, true);

    assert.equal(executionView(db, second.run.runId)!.selected!.ideal.model, 'openai/gpt-6-astra');
    assert.throws(() => readExecutionRouting(db, { runId: second.run.runId, cwd: root, rootSessionId: 'other-session' }), /does not match/u);
    assert.throws(() => selectOpenCodeTaskExecution(db, { ...ordinary, runId: second.run.runId, idempotencyKey: 'stale' }), /revision/u);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('setup off and unavailable models never create Enno drafts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-selection-off-'));
  execFileSync('git', ['init', '-q', root]);
  const databasePath = path.join(root, 'test.sqlite');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  try {
    const input = { cwd: root, requestId: 'disabled', task: 'Fix README', executionCatalog: { mode: 'off' as const, candidates: [] } };
    const prepared = await prepareOpenCodeTask(db, input);
    assert.equal(prepared.execution?.choice, 'ordinary');
    assert.equal(prepared.ennoOduno.applicable, false);
    assert.throws(() => selectOpenCodeTaskExecution(db, { cwd: root, runId: prepared.run.runId, expectedRevision: 0, idempotencyKey: 'select', choice: 'enno', preset: 'openai' }), /disabled/u);
    const other = await prepareOpenCodeTask(db, { ...input, requestId: 'unavailable', executionCatalog: { mode: 'ask', candidates: [] } });
    assert.throws(() => selectOpenCodeTaskExecution(db, { cwd: root, runId: other.run.runId, expectedRevision: 0, idempotencyKey: 'missing', choice: 'enno', preset: 'openai' }), /unavailable/u);
    assert.equal(executionView(db, other.run.runId)?.revision, 0);
    const cancelled = { cwd: root, runId: other.run.runId, expectedRevision: 0, idempotencyKey: 'cancel', choice: 'cancelled' as const };
    assert.equal(selectOpenCodeTaskExecution(db, cancelled).execution?.choice, 'cancelled');
    assert.equal(selectOpenCodeTaskExecution(db, cancelled).run.status, 'cancelled');
    assert.throws(() => selectOpenCodeTaskExecution(db, { ...cancelled, expectedRevision: 1, idempotencyKey: 'after-cancel', choice: 'ordinary' }), /terminal/u);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
