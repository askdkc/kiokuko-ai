import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { insertAkinatorAnswer, insertAkinatorSession, insertRunIntakeLink } from '../../src/akinator/store.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import {
  INTAKE_FEEDBACK_VERDICTS,
  listIntakeFeedback,
  recordIntakeFeedback,
  recordIntakeFeedbackInTransaction,
} from '../../src/context/feedback.js';
import { recordEntry } from '../../src/memory/entries.js';

const migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-20T00:00:00.000Z';
const workspace = 'workspace-intake-feedback';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrationsDirectory);
  return database;
}

function seedIntake(database: ReturnType<typeof openConnection>): void {
  insertAkinatorSession(database, {
    id: 'session-intake-feedback-1',
    workspace,
    task: 'Implement the intake feedback API',
    profile: { taskType: null, target: null, expected: null, constraints: null },
    status: 'active',
    questionCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, protocol_version, capture_profile, coverage_json,
      status, metadata_json, last_sequence, started_at, created_at, updated_at
    ) VALUES (?, ?, 'opencode', '1', 'standard', '{}', 'intake', '{}', 0, ?, ?, ?)
  `).run('run-intake-feedback-1', workspace, now, now, now);
  insertAkinatorAnswer(database, {
    workspace,
    sessionId: 'session-intake-feedback-1',
    questionId: 'taskType',
    answer: 'build',
    createdAt: now,
  });
  insertRunIntakeLink(database, {
    runId: 'run-intake-feedback-1',
    sessionId: 'session-intake-feedback-1',
    workspace,
    policyVersion: 'v1',
    profileSchemaVersion: 1,
    profileSources: { taskType: 'user_answer' },
    initialProfileHash: null,
    recommendedTags: [],
    linkedAt: now,
    finalizedAt: null,
  });
}

test('exports intake feedback verdicts and records feedback for an answered question', async () => {
  const database = await temporaryDatabase('intake-feedback-record');
  try {
    seedIntake(database);
    const record = recordIntakeFeedback(database, {
      workspace,
      feedbackId: 'intake-feedback-1',
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: 'taskType',
      profileField: null,
      verdict: 'helpful',
      comment: 'This question clarified the task.',
      actor: 'user-1',
      idempotencyKey: 'intake-key-1',
      createdAt: now,
    });

    assert.deepEqual(INTAKE_FEEDBACK_VERDICTS, ['helpful', 'unnecessary', 'corrected']);
    assert.deepEqual(record, {
      feedbackId: 'intake-feedback-1',
      workspace,
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: 'taskType',
      profileField: null,
      verdict: 'helpful',
      comment: 'This question clarified the task.',
      actor: 'user-1',
      idempotencyKeyHash: createHash('sha256').update('intake-key-1').digest('hex'),
      createdAt: now,
    });
    assert.equal(database.prepare('SELECT idempotency_key FROM intake_feedback').get<{ idempotency_key: string }>()?.idempotency_key, record.idempotencyKeyHash);
  } finally {
    database.close();
  }
});

test('records profile-field feedback without requiring an answer in a caller-owned transaction', async () => {
  const database = await temporaryDatabase('intake-feedback-profile-field');
  try {
    seedIntake(database);
    database.exec('CREATE TEMP TABLE tx_marker (value TEXT NOT NULL)');
    const input = {
      workspace,
      feedbackId: 'intake-profile-feedback-1',
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: null,
      profileField: 'constraints',
      verdict: 'corrected' as const,
      comment: null,
      actor: 'user-1',
      idempotencyKey: 'intake-profile-key-1',
      createdAt: now,
    };

    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('before');
    const record = recordIntakeFeedbackInTransaction(database, input);
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('after');

    assert.equal(record.questionId, null);
    assert.equal(record.profileField, 'constraints');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 2);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback WHERE feedback_id = ?').get<{ count: number }>('intake-profile-feedback-1')?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('replays exact intake feedback, conflicts on changed body or feedback-id reuse, and scopes keys by actor', async () => {
  const database = await temporaryDatabase('intake-feedback-idempotency');
  try {
    seedIntake(database);
    const input = {
      workspace,
      feedbackId: 'intake-idempotent-1',
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: 'taskType',
      profileField: null,
      verdict: 'helpful' as const,
      comment: 'same canonical body',
      actor: 'user-1',
      idempotencyKey: 'same-intake-key',
      createdAt: now,
    };
    const first = recordIntakeFeedback(database, input);
    assert.deepEqual(recordIntakeFeedback(database, { ...input }), first);
    const otherActor = recordIntakeFeedback(database, { ...input, feedbackId: 'intake-idempotent-2', actor: 'user-2' });
    assert.equal(otherActor.actor, 'user-2');
    assert.equal('idempotencyKey' in first, false);

    assert.throws(
      () => recordIntakeFeedback(database, { ...input, feedbackId: 'intake-idempotent-3', verdict: 'corrected' }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && (error as Error).message === 'Feedback conflicts with existing record',
    );
    assert.throws(
      () => recordIntakeFeedback(database, { ...input, actor: 'user-3', idempotencyKey: 'different-intake-key' }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && (error as Error).message === 'Feedback conflicts with existing record',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback').get<{ count: number }>()?.count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback WHERE idempotency_key = ?').get<{ count: number }>(first.idempotencyKeyHash)?.count, 2);
  } finally {
    database.close();
  }
});

test('lists intake feedback with deterministic bounds and mutually exclusive target filters', async () => {
  const database = await temporaryDatabase('intake-feedback-list');
  try {
    seedIntake(database);
    const common = {
      workspace,
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      verdict: 'unnecessary' as const,
      comment: null,
      actor: 'list-user',
    };
    recordIntakeFeedback(database, { ...common, feedbackId: 'list-z', questionId: 'taskType', profileField: null, idempotencyKey: 'list-z-key', createdAt: '2026-08-20T00:00:02.000Z' });
    recordIntakeFeedback(database, { ...common, feedbackId: 'list-a', questionId: null, profileField: 'constraints', idempotencyKey: 'list-a-key', createdAt: '2026-08-20T00:00:01.000Z' });
    recordIntakeFeedback(database, { ...common, feedbackId: 'list-b', questionId: null, profileField: 'expected', idempotencyKey: 'list-b-key', createdAt: '2026-08-20T00:00:01.000Z' });

    const page = listIntakeFeedback(database, { workspace, runId: 'run-intake-feedback-1', limit: 2 });
    assert.deepEqual(page.records.map((record) => record.feedbackId), ['list-a', 'list-b']);
    assert.equal(page.truncated, true);
    assert.deepEqual(listIntakeFeedback(database, { workspace, runId: 'run-intake-feedback-1', questionId: 'taskType' }).records.map((record) => record.feedbackId), ['list-z']);
    assert.deepEqual(listIntakeFeedback(database, { workspace, runId: 'run-intake-feedback-1', profileField: 'constraints' }).records.map((record) => record.feedbackId), ['list-a']);
    assert.deepEqual(listIntakeFeedback(database, { workspace: 'other-workspace' }).records, []);
    assert.throws(
      () => listIntakeFeedback(database, { workspace, questionId: 'taskType', profileField: 'constraints' }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Feedback input is invalid',
    );
  } finally {
    database.close();
  }
});

test('rejects symbols, accessors, proxies, control identifiers, byte overflow, loose timestamps, and raw invalid comments uniformly', async () => {
  const database = await temporaryDatabase('intake-feedback-validation');
  try {
    seedIntake(database);
    const base = {
      workspace,
      feedbackId: 'validation-feedback',
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: 'taskType',
      profileField: null,
      verdict: 'helpful' as const,
      comment: null,
      actor: 'validation-actor',
      idempotencyKey: 'validation-key',
      createdAt: now,
    };
    const symbolInput = { ...base } as Record<string | symbol, unknown>;
    symbolInput[Symbol('secret-sentinel')] = 'raw-secret-sentinel';
    const accessorInput = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'comment', { enumerable: true, get: () => { throw new Error('raw-secret-sentinel'); } });
    const proxyInput = new Proxy({ ...base }, { get: () => { throw new Error('raw-secret-sentinel'); } });
    const invalidInputs: unknown[] = [
      symbolInput,
      accessorInput,
      proxyInput,
      { ...base, actor: 'bad\u0000actor' },
      { ...base, actor: '😀'.repeat(65) },
      { ...base, createdAt: '2026-08-20T00:00:00Z' },
      { ...base, comment: '' },
    ];
    for (const invalid of invalidInputs) {
      assert.throws(
        () => recordIntakeFeedback(database, invalid),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
          assert.equal((error as Error).message, 'Feedback input is invalid');
          assert.doesNotMatch((error as Error).message, /raw-secret-sentinel/);
          assert.doesNotMatch(JSON.stringify((error as { details?: unknown }).details ?? {}), /raw-secret-sentinel/);
          return true;
        },
      );
    }
    const cyclic: Record<string, unknown> = { ...base };
    cyclic.comment = cyclic;
    assert.throws(
      () => recordIntakeFeedback(database, cyclic),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Feedback input is invalid',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('uses one fixed NOT_FOUND for missing, cross-workspace, mismatched links, and unanswered questions', async () => {
  const database = await temporaryDatabase('intake-feedback-not-found');
  try {
    seedIntake(database);
    insertAkinatorSession(database, {
      id: 'session-intake-feedback-other',
      workspace,
      task: 'Other intake session',
      profile: { taskType: null, target: null, expected: null, constraints: null },
      status: 'active',
      questionCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const base = {
      workspace,
      feedbackId: 'not-found-feedback',
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: 'taskType',
      profileField: null,
      verdict: 'helpful' as const,
      comment: null,
      actor: 'not-found-actor',
      idempotencyKey: 'not-found-key',
      createdAt: now,
    };
    const invalidInputs = [
      { ...base, feedbackId: 'missing-run', runId: 'missing-run' },
      { ...base, feedbackId: 'missing-session', sessionId: 'missing-session' },
      { ...base, feedbackId: 'mismatched-link', sessionId: 'session-intake-feedback-other' },
      { ...base, feedbackId: 'cross-workspace', workspace: 'other-workspace' },
      { ...base, feedbackId: 'unanswered-question', questionId: 'expected' },
    ];
    for (const invalid of invalidInputs) {
      assert.throws(
        () => recordIntakeFeedback(database, invalid),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'NOT_FOUND');
          assert.equal((error as Error).message, 'Feedback target was not found');
          assert.doesNotMatch((error as Error).message, /missing-run|missing-session|other-workspace|expected/);
          assert.doesNotMatch(JSON.stringify((error as { details?: unknown }).details ?? {}), /missing-run|missing-session|other-workspace|expected/);
          return true;
        },
      );
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('strictly validates list input fields and hard limit without exposing dynamic values', async () => {
  const database = await temporaryDatabase('intake-feedback-list-validation');
  try {
    seedIntake(database);
    const base = { workspace, limit: 1 };
    const symbolInput = { ...base } as Record<string | symbol, unknown>;
    symbolInput[Symbol('list-secret')] = 'list-secret-sentinel';
    const accessorInput = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'limit', { enumerable: true, get: () => { throw new Error('list-secret-sentinel'); } });
    const proxyInput = new Proxy({ ...base }, { get: () => { throw new Error('list-secret-sentinel'); } });
    for (const invalid of [
      symbolInput,
      accessorInput,
      proxyInput,
      { ...base, sessionId: null },
      { ...base, workspace: 'bad\u0000workspace' },
      { ...base, workspace: '😀'.repeat(65) },
      { ...base, limit: 0 },
      { ...base, limit: 101 },
      { ...base, limit: 1.5 },
    ]) {
      assert.throws(
        () => listIntakeFeedback(database, invalid),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
          assert.equal((error as Error).message, 'Feedback input is invalid');
          assert.doesNotMatch((error as Error).message, /list-secret-sentinel/);
          return true;
        },
      );
    }
  } finally {
    database.close();
  }
});

test('sanitizes comments before enforcing the exact UTF-8 4 KiB boundary and stores only the key hash', async () => {
  const database = await temporaryDatabase('intake-feedback-sanitize');
  try {
    seedIntake(database);
    const common = {
      workspace,
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: null,
      profileField: 'constraints',
      verdict: 'corrected' as const,
      actor: 'sanitize-user',
      createdAt: now,
    };
    const url = recordIntakeFeedback(database, {
      ...common,
      feedbackId: 'sanitize-url',
      comment: `https://user:password@example.test/feedback?token=${'x'.repeat(5000)}#fragment`,
      idempotencyKey: 'raw-intake-key-sentinel',
    });
    const exact = recordIntakeFeedback(database, {
      ...common,
      feedbackId: 'sanitize-exact',
      comment: '😀'.repeat(1024),
      idempotencyKey: 'sanitize-exact-key',
      createdAt: '2026-08-20T00:00:01.000Z',
    });

    assert.equal(url.comment, 'https://example.test/feedback');
    assert.equal(exact.comment, '😀'.repeat(1024));
    assert.equal(Buffer.byteLength(exact.comment ?? '', 'utf8'), 4096);
    assert.equal('idempotencyKey' in url, false);
    assert.equal(database.prepare('SELECT idempotency_key FROM intake_feedback WHERE feedback_id = ?').get<{ idempotency_key: string }>('sanitize-url')?.idempotency_key, createHash('sha256').update('raw-intake-key-sentinel').digest('hex'));
    assert.throws(
      () => recordIntakeFeedback(database, {
        ...common,
        feedbackId: 'sanitize-over',
        comment: '😀'.repeat(1025),
        idempotencyKey: 'sanitize-over-key',
        createdAt: '2026-08-20T00:00:02.000Z',
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Feedback input is invalid',
    );
  } finally {
    database.close();
  }
});

test('preserves caller transaction state on handled conflict and rolls back standalone failures', async () => {
  const database = await temporaryDatabase('intake-feedback-transactions');
  try {
    seedIntake(database);
    const input = {
      workspace,
      feedbackId: 'transaction-feedback-1',
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: 'taskType',
      profileField: null,
      verdict: 'helpful' as const,
      comment: null,
      actor: 'transaction-user',
      idempotencyKey: 'transaction-key',
      createdAt: now,
    };
    const first = recordIntakeFeedback(database, input);
    database.exec('CREATE TEMP TABLE tx_marker (value TEXT NOT NULL)');
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('before-replay');
    assert.deepEqual(recordIntakeFeedbackInTransaction(database, input), first);
    assert.throws(
      () => recordIntakeFeedbackInTransaction(database, { ...input, verdict: 'corrected' }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && (error as Error).message === 'Feedback conflicts with existing record',
    );
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('after-conflict');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 2);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback').get<{ count: number }>()?.count, 1);

    database.exec('CREATE TABLE intake_feedback_side_effects (value TEXT NOT NULL)');
    database.exec(`
      CREATE TRIGGER fail_intake_feedback_after_insert
      AFTER INSERT ON intake_feedback
      BEGIN
        INSERT INTO intake_feedback_side_effects (value) VALUES ('must-rollback');
        SELECT RAISE(ABORT, 'intentional intake feedback failure');
      END
    `);
    assert.throws(
      () => recordIntakeFeedback(database, { ...input, feedbackId: 'transaction-failure', idempotencyKey: 'transaction-failure-key' }),
      (error: unknown) => {
        const failure = error as { code?: unknown; errcode?: unknown; message?: unknown };
        assert.equal(failure.code, 'ERR_SQLITE_ERROR');
        assert.equal(failure.errcode, 1_811);
        assert.equal(failure.message, 'intentional intake feedback failure');
        return true;
      },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback WHERE feedback_id = ?').get<{ count: number }>('transaction-failure')?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback_side_effects').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('maps corrupted persisted intake feedback and broken joins to one fixed INTEGRITY_ERROR', async () => {
  const database = await temporaryDatabase('intake-feedback-integrity');
  try {
    seedIntake(database);
    const record = recordIntakeFeedback(database, {
      workspace,
      feedbackId: 'integrity-feedback',
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: 'taskType',
      profileField: null,
      verdict: 'helpful',
      comment: 'stored comment',
      actor: 'integrity-user',
      idempotencyKey: 'integrity-key',
      createdAt: now,
    });
    database.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
    const assertIntegrity = (): void => {
      assert.throws(
        () => listIntakeFeedback(database, { workspace }),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && (error as Error).message === 'Stored feedback is invalid',
      );
    };

    database.prepare('UPDATE intake_feedback SET verdict = ? WHERE feedback_id = ?').run('invalid-verdict', record.feedbackId);
    assertIntegrity();
    database.prepare('UPDATE intake_feedback SET verdict = ? WHERE feedback_id = ?').run('helpful', record.feedbackId);
    database.prepare('UPDATE intake_feedback SET created_at = ? WHERE feedback_id = ?').run('2026-08-20T00:00:00Z', record.feedbackId);
    assertIntegrity();
    database.prepare('UPDATE intake_feedback SET created_at = ? WHERE feedback_id = ?').run(now, record.feedbackId);
    database.prepare('UPDATE intake_feedback SET idempotency_key = ? WHERE feedback_id = ?').run('BAD-HASH', record.feedbackId);
    assertIntegrity();
    database.prepare('UPDATE intake_feedback SET idempotency_key = ? WHERE feedback_id = ?').run(record.idempotencyKeyHash, record.feedbackId);
    database.prepare('UPDATE intake_feedback SET question_id = NULL, profile_field = NULL WHERE feedback_id = ?').run(record.feedbackId);
    assertIntegrity();
    database.prepare('UPDATE intake_feedback SET question_id = ?, profile_field = NULL WHERE feedback_id = ?').run('expected', record.feedbackId);
    assertIntegrity();
    database.prepare('UPDATE intake_feedback SET question_id = ?, profile_field = NULL, comment = ? WHERE feedback_id = ?').run('taskType', 'a'.repeat(4097), record.feedbackId);
    assertIntegrity();
    database.prepare('UPDATE intake_feedback SET comment = ?, session_id = ? WHERE feedback_id = ?').run('stored comment', 'missing-session', record.feedbackId);
    assertIntegrity();
    database.exec('PRAGMA ignore_check_constraints = OFF;');
  } finally {
    database.close();
  }
});

test('does not mutate Akinator, ledger, memory, delivery, or existing feedback state', async () => {
  const database = await temporaryDatabase('intake-feedback-nonmutation');
  try {
    seedIntake(database);
    recordEntry(database, {
      workspace,
      kind: 'lesson',
      status: 'verified',
      trustLevel: 'source_verified',
      confidence: 0.9,
      title: 'Unchanged entry',
      body: 'Keep this unchanged.',
      createdBy: 'test',
      tags: ['ranking-sentinel'],
    }, { idFactory: () => 'entry-intake-1', now });
    database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
        policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at
      ) VALUES (?, ?, 0, ?, ?, ?, ?, '{}', 8000, 20, 0, ?)
    `).run('delivery-intake-1', 'run-intake-feedback-1', 'session-intake-feedback-1', 'profile-hash', 'query-hash', 'policy-v1', now);
    database.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json
      ) VALUES (?, ?, 1, 1, '{}', '{}')
    `).run('delivery-intake-1', 'entry-intake-1');
    database.prepare(`
      INSERT INTO context_feedback (
        feedback_id, delivery_id, entry_id, run_id, verdict, comment, actor, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, 'helpful', NULL, ?, ?, ?)
    `).run('context-existing-1', 'delivery-intake-1', 'entry-intake-1', 'run-intake-feedback-1', 'existing-user', 'b'.repeat(64), now);
    database.prepare(`
      INSERT INTO run_feedback (
        feedback_id, run_id, outcome, recommendation_code, recommendation_verdict, rating, comment, actor, idempotency_key, created_at
      ) VALUES (?, ?, 'done', 'VERIFY_AFTER_MUTATION', 'dismissed', 2, NULL, ?, ?, ?)
    `).run('run-existing-1', 'run-intake-feedback-1', 'existing-user', 'c'.repeat(64), now);

    const snapshot = (): Record<string, unknown[]> => ({
      sessions: database.prepare('SELECT * FROM akinator_sessions ORDER BY id').all(),
      answers: database.prepare('SELECT * FROM akinator_answers ORDER BY session_id, question_id').all(),
      runIntakes: database.prepare('SELECT * FROM run_intakes ORDER BY run_id').all(),
      runs: database.prepare('SELECT * FROM ledger_runs ORDER BY run_id').all(),
      events: database.prepare('SELECT * FROM ledger_events ORDER BY run_id, sequence').all(),
      entries: database.prepare('SELECT * FROM entries ORDER BY id').all(),
      tags: database.prepare('SELECT * FROM entry_revision_tags ORDER BY entry_id, revision, tag').all(),
      deliveries: database.prepare('SELECT * FROM context_deliveries ORDER BY delivery_id').all(),
      deliveryEntries: database.prepare('SELECT * FROM context_delivery_entries ORDER BY delivery_id, entry_id').all(),
      contextFeedback: database.prepare('SELECT * FROM context_feedback ORDER BY feedback_id').all(),
      runFeedback: database.prepare('SELECT * FROM run_feedback ORDER BY feedback_id').all(),
    });
    const before = snapshot();
    const record = recordIntakeFeedback(database, {
      workspace,
      feedbackId: 'nonmutation-intake-feedback',
      runId: 'run-intake-feedback-1',
      sessionId: 'session-intake-feedback-1',
      questionId: null,
      profileField: 'target',
      verdict: 'corrected',
      comment: 'Only the new intake row may change.',
      actor: 'nonmutation-user',
      idempotencyKey: 'nonmutation-key',
      createdAt: now,
    });

    assert.equal(record.profileField, 'target');
    assert.deepEqual(snapshot(), before);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM intake_feedback').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});
