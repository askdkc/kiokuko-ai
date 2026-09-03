import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { readKnowledgeEvidence } from '../../src/akinator/knowledge-path.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { KiokukoError } from '../../src/errors.js';
import { curateMemoryCandidates } from '../../src/memory/curator.js';
import { readEntry } from '../../src/memory/entries.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';
import { canonicalJson } from '../../src/serialization/validate.js';

function isIntegrityError(error: unknown): boolean {
  return error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR';
}

test('rejects forged, contradictory, and non-canonical Akinator knowledge paths before skill readiness', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-reasoning-failclose-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-reasoning-failclose-data-'));
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const runs: string[] = [];
    let workspace = '';
    let entryId = '';
    for (const [index, verified] of [true, false].entries()) {
      const prepared = await prepareOpenCodeTask(database, {
        requestId: `knowledge-path-failclose-${index}`,
        cwd: root,
        task: 'SQLite migration failuresを安全に復旧する',
        profileHints: {
          taskType: 'debug',
          target: 'SQLite migration',
          expected: '復旧テストが成功しschemaが一致する',
          constraints: '適用済みmigrationを破壊しない',
        },
        client: { kind: 'opencode' as const, sessionId: `knowledge-path-failclose-${index}` },
      });
      workspace = prepared.project.workspace;
      runs.push(prepared.run.runId);
      const checkpoint = await checkpointScopedMemory(database, {
        cwd: root,
        runId: prepared.run.runId,
        outcome: 'completed',
        memories: [{
          kind: 'lesson',
          title: 'Reusable SQLite migration recovery workflow',
          body: '失敗したversionを確認し、backupを復元し、schemaを検証してから再試行する。',
          memoryClass: 'troubleshooting',
          applicability: { databases: ['SQLite'], tools: ['migration'] },
          tags: ['workflow', 'skill:database'],
        }],
        evidence: verified
          ? {
            tests: [{ runner: 'node:test', target: 'migration recovery', outcome: 'passed' }],
            verification: { outcome: 'fresh' },
          }
          : {
            tests: [{ runner: 'node:test', target: 'migration recovery', outcome: 'failed' }],
          },
      });
      entryId ||= checkpoint.entries[0]!.id;
    }

    const entry = readEntry(database, { workspace, entryId });
    assert.deepEqual(
      readKnowledgeEvidence(database, entry),
      {
        conceptKey: readKnowledgeEvidence(database, entry).conceptKey,
        totalPaths: 2,
        qualifiedHits: 1,
        independentRuns: 1,
        independentWorkspaces: 1,
        averageCompleteness: 1,
        tier: 'observed',
      },
    );

    const unqualified = database.prepare(`
      SELECT concept_key, qualified, disqualification_reasons_json,
             verification_json, silo_completeness
        FROM akinator_reasoning_paths
       WHERE run_id = ?
    `).get<{
      concept_key: string;
      qualified: number;
      disqualification_reasons_json: string;
      verification_json: string;
      silo_completeness: number;
    }>(runs[1]!);
    assert.ok(unqualified);

    const forgedConceptKey = unqualified.concept_key === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    database.prepare('UPDATE akinator_reasoning_paths SET concept_key = ? WHERE run_id = ?').run(forgedConceptKey, runs[1]!);
    assert.throws(
      () => readKnowledgeEvidence(database, entry),
      isIntegrityError,
      'a tampered concept index must not hide a path before decoding',
    );
    database.prepare('UPDATE akinator_reasoning_paths SET concept_key = ? WHERE run_id = ?').run(unqualified.concept_key, runs[1]!);

    database.prepare(`
      UPDATE akinator_reasoning_paths
         SET qualified = 1,
             disqualification_reasons_json = '[]'
       WHERE run_id = ?
    `).run(runs[1]!);
    assert.throws(() => readKnowledgeEvidence(database, entry), isIntegrityError);
    await assert.rejects(
      curateMemoryCandidates(database, { workspace, skillReadyOnly: true }),
      isIntegrityError,
      'forged qualification must fail instead of making the concept skill-ready',
    );
    database.prepare(`
      UPDATE akinator_reasoning_paths
         SET qualified = ?,
             disqualification_reasons_json = ?
       WHERE run_id = ?
    `).run(unqualified.qualified, unqualified.disqualification_reasons_json, runs[1]!);

    database.prepare('UPDATE akinator_reasoning_paths SET silo_completeness = 0.5 WHERE run_id = ?').run(runs[0]!);
    assert.throws(() => readKnowledgeEvidence(database, entry), isIntegrityError);
    database.prepare('UPDATE akinator_reasoning_paths SET silo_completeness = 1 WHERE run_id = ?').run(runs[0]!);

    database.prepare(`
      UPDATE akinator_reasoning_paths
         SET disqualification_reasons_json = '[ "no-fresh-verification-or-passing-test" ]'
       WHERE run_id = ?
    `).run(runs[1]!);
    assert.throws(() => readKnowledgeEvidence(database, entry), isIntegrityError);
    database.prepare(`
      UPDATE akinator_reasoning_paths
         SET disqualification_reasons_json = ?
       WHERE run_id = ?
    `).run(unqualified.disqualification_reasons_json, runs[1]!);

    const linkedEvent = database.prepare(`
      SELECT event_id, sequence, outcome, payload_json, previous_hash, event_hash
        FROM ledger_events
       WHERE run_id = ?
         AND event_type = 'test.completed'
    `).get<{
      event_id: string;
      sequence: number;
      outcome: string;
      payload_json: string;
      previous_hash: string;
      event_hash: string;
    }>(runs[0]!);
    assert.ok(linkedEvent);

    database.prepare('UPDATE ledger_events SET sequence = 999 WHERE event_id = ?').run(linkedEvent.event_id);
    assert.throws(() => readKnowledgeEvidence(database, entry), isIntegrityError);
    database.prepare('UPDATE ledger_events SET sequence = ? WHERE event_id = ?').run(linkedEvent.sequence, linkedEvent.event_id);

    const forgedPreviousHash = linkedEvent.previous_hash === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    database.prepare('UPDATE ledger_events SET previous_hash = ? WHERE event_id = ?').run(forgedPreviousHash, linkedEvent.event_id);
    assert.throws(() => readKnowledgeEvidence(database, entry), isIntegrityError);
    database.prepare('UPDATE ledger_events SET previous_hash = ? WHERE event_id = ?').run(linkedEvent.previous_hash, linkedEvent.event_id);

    const forgedEventHash = linkedEvent.event_hash === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    database.prepare('UPDATE ledger_events SET event_hash = ? WHERE event_id = ?').run(forgedEventHash, linkedEvent.event_id);
    assert.throws(() => readKnowledgeEvidence(database, entry), isIntegrityError);
    database.prepare('UPDATE ledger_events SET event_hash = ? WHERE event_id = ?').run(linkedEvent.event_hash, linkedEvent.event_id);

    database.prepare("UPDATE ledger_events SET payload_json = '{}' WHERE event_id = ?").run(linkedEvent.event_id);
    assert.throws(
      () => readKnowledgeEvidence(database, entry),
      isIntegrityError,
      'a changed event payload must invalidate its stored hash',
    );
    database.prepare('UPDATE ledger_events SET payload_json = ? WHERE event_id = ?').run(linkedEvent.payload_json, linkedEvent.event_id);

    const cursor = database.prepare(`
      SELECT last_sequence, last_source_sequence
        FROM ledger_runs
       WHERE run_id = ?
    `).get<{ last_sequence: number; last_source_sequence: number | null }>(runs[0]!);
    assert.ok(cursor);
    database.prepare('UPDATE ledger_runs SET last_sequence = ? WHERE run_id = ?').run(cursor.last_sequence + 1, runs[0]!);
    assert.throws(() => readKnowledgeEvidence(database, entry), isIntegrityError);
    database.prepare('UPDATE ledger_runs SET last_sequence = ? WHERE run_id = ?').run(cursor.last_sequence, runs[0]!);
    database.prepare('UPDATE ledger_runs SET last_source_sequence = 0 WHERE run_id = ?').run(runs[0]!);
    assert.throws(() => readKnowledgeEvidence(database, entry), isIntegrityError);
    database.prepare('UPDATE ledger_runs SET last_source_sequence = ? WHERE run_id = ?').run(cursor.last_source_sequence, runs[0]!);

    const failedEvent = database.prepare(`
      SELECT event_id, outcome
        FROM ledger_events
       WHERE run_id = ?
         AND event_type = 'test.completed'
    `).get<{ event_id: string; outcome: string }>(runs[1]!);
    assert.equal(failedEvent?.outcome, 'failed');
    const forgedVerification = JSON.parse(unqualified.verification_json) as Record<string, unknown>;
    forgedVerification.passedTests = 1;
    database.prepare("UPDATE ledger_events SET outcome = 'passed' WHERE event_id = ?").run(failedEvent!.event_id);
    database.prepare(`
      UPDATE akinator_reasoning_paths
         SET verification_json = ?,
             qualified = 1,
             disqualification_reasons_json = '[]'
       WHERE run_id = ?
    `).run(canonicalJson(forgedVerification), runs[1]!);
    assert.throws(
      () => readKnowledgeEvidence(database, entry),
      isIntegrityError,
      'a failed event rewritten as passed must not manufacture qualified evidence',
    );
  } finally {
    database.close();
  }
});
