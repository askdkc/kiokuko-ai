import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import {
  listContextFeedback,
  listRunFeedback,
  recordContextFeedback,
  recordContextFeedbackInTransaction,
  recordRunFeedback,
  recordRunFeedbackInTransaction,
} from '../../src/context/feedback.js';
import { recordEntry } from '../../src/memory/entries.js';

const migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-20T00:00:00.000Z';
const workspace = 'workspace-feedback';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrationsDirectory);
  return database;
}

function seedLedgerContext(database: ReturnType<typeof openConnection>): void {
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
      protocol_version, capture_profile, coverage_json, status, title, task_hash,
      metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'generic', '1.0.0', NULL, NULL, '1', 'standard', '{}', 'active', 'Feedback task', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
  `).run('run-feedback-1', workspace, now, now, now);
  recordEntry(database, {
    workspace,
    kind: 'lesson',
    status: 'verified',
    trustLevel: 'source_verified',
    confidence: 0.9,
    title: 'Context lesson',
    body: 'Keep the context bounded.',
    createdBy: 'test',
  }, { idFactory: () => 'entry-feedback-1', now });
  database.prepare(`
    INSERT INTO context_deliveries (
      delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
      policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at
    ) VALUES (?, ?, 0, NULL, 'profile-hash-1', 'query-hash-1', 'policy-v1', '{}', 8000, 24, 0, ?)
  `).run('delivery-feedback-1', 'run-feedback-1', now);
  database.prepare(`
    INSERT INTO context_delivery_entries (
      delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json
    ) VALUES (?, ?, 1, 1, '{}', '{}')
  `).run('delivery-feedback-1', 'entry-feedback-1');
}

test('records context feedback for a delivered entry in its run workspace', async () => {
  const database = await temporaryDatabase('context-feedback-record');
  try {
    seedLedgerContext(database);

    const record = recordContextFeedback(database, {
      workspace,
      feedbackId: 'context-feedback-1',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful',
      comment: 'This context was useful.',
      actor: 'user-1',
      idempotencyKey: 'context-key-1',
      createdAt: now,
    });

    assert.deepEqual(record, {
      feedbackId: 'context-feedback-1',
      workspace,
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful',
      comment: 'This context was useful.',
      actor: 'user-1',
      idempotencyKeyHash: createHash('sha256').update('context-key-1').digest('hex'),
      createdAt: now,
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT idempotency_key FROM context_feedback').get<{ idempotency_key: string }>()?.idempotency_key, createHash('sha256').update('context-key-1').digest('hex'));
  } finally {
    database.close();
  }
});

test('lists context feedback in created-time then feedback-id order without truncation', async () => {
  const database = await temporaryDatabase('context-feedback-list');
  try {
    seedLedgerContext(database);
    const base = {
      workspace,
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful' as const,
      comment: null,
      actor: 'user-1',
    };
    recordContextFeedback(database, { ...base, feedbackId: 'feedback-late', idempotencyKey: 'list-key-late', createdAt: '2026-08-20T00:00:02.000Z' });
    recordContextFeedback(database, { ...base, feedbackId: 'feedback-early', idempotencyKey: 'list-key-early', createdAt: '2026-08-20T00:00:01.000Z' });

    const page = listContextFeedback(database, { workspace, runId: 'run-feedback-1', limit: 100 });

    assert.deepEqual(page.records.map((record) => record.feedbackId), ['feedback-early', 'feedback-late']);
    assert.equal(page.truncated, false);
  } finally {
    database.close();
  }
});

test('records run outcome feedback bound to its workspace', async () => {
  const database = await temporaryDatabase('run-feedback-record');
  try {
    seedLedgerContext(database);

    const record = recordRunFeedback(database, {
      workspace,
      feedbackId: 'run-feedback-1',
      runId: 'run-feedback-1',
      outcome: 'completed successfully',
      rating: 5,
      actor: 'user-1',
      idempotencyKey: 'run-key-1',
      createdAt: now,
    });

    assert.deepEqual(record, {
      feedbackId: 'run-feedback-1',
      workspace,
      runId: 'run-feedback-1',
      outcome: 'completed successfully',
      recommendationCode: null,
      recommendationVerdict: null,
      rating: 5,
      comment: null,
      actor: 'user-1',
      idempotencyKeyHash: createHash('sha256').update('run-key-1').digest('hex'),
      createdAt: now,
    });
  } finally {
    database.close();
  }
});

test('bounds run outcomes and comments by UTF-8 bytes', async () => {
  const database = await temporaryDatabase('run-feedback-utf8-bounds');
  try {
    seedLedgerContext(database);
    const exact = '😀'.repeat(1024);
    const common = {
      workspace,
      runId: 'run-feedback-1',
      actor: 'user-1',
      createdAt: now,
    };
    const record = recordRunFeedback(database, {
      ...common,
      feedbackId: 'run-feedback-utf8-exact',
      outcome: exact,
      comment: exact,
      idempotencyKey: 'run-feedback-utf8-exact-key',
    });
    assert.equal(Buffer.byteLength(record.outcome ?? '', 'utf8'), 4096);
    assert.equal(Buffer.byteLength(record.comment ?? '', 'utf8'), 4096);

    for (const input of [
      { outcome: '😀'.repeat(1025), comment: null },
      { outcome: 'completed', comment: '😀'.repeat(1025) },
    ]) {
      assert.throws(
        () => recordRunFeedback(database, {
          ...common,
          ...input,
          feedbackId: `run-feedback-utf8-over-${input.comment === null ? 'outcome' : 'comment'}`,
          idempotencyKey: `run-feedback-utf8-over-${input.comment === null ? 'outcome' : 'comment'}-key`,
        }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
          && (error as Error).message === 'Feedback input is invalid',
      );
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('lists run feedback deterministically and reports truncation', async () => {
  const database = await temporaryDatabase('run-feedback-list');
  try {
    seedLedgerContext(database);
    const base = {
      workspace,
      runId: 'run-feedback-1',
      outcome: null,
      recommendationCode: 'VERIFY_AFTER_MUTATION',
      recommendationVerdict: 'resolved' as const,
      rating: null,
      comment: null,
      actor: 'user-1',
    };
    recordRunFeedback(database, { ...base, feedbackId: 'run-feedback-late', idempotencyKey: 'run-list-late', createdAt: '2026-08-20T00:00:02.000Z' });
    recordRunFeedback(database, { ...base, feedbackId: 'run-feedback-early', idempotencyKey: 'run-list-early', createdAt: '2026-08-20T00:00:01.000Z' });

    const page = listRunFeedback(database, { workspace, runId: 'run-feedback-1', limit: 1 });

    assert.deepEqual(page.records.map((record) => record.feedbackId), ['run-feedback-early']);
    assert.equal(page.truncated, true);
  } finally {
    database.close();
  }
});

test('replays identical context feedback and conflicts when the canonical body changes', async () => {
  const database = await temporaryDatabase('context-feedback-idempotency');
  try {
    seedLedgerContext(database);
    const input = {
      workspace,
      feedbackId: 'context-idempotent-1',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful' as const,
      comment: 'same body',
      actor: 'user-1',
      idempotencyKey: 'same-key',
      createdAt: now,
    };
    const first = recordContextFeedback(database, input);
    const replay = recordContextFeedback(database, { ...input });

    assert.deepEqual(replay, first);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 1);
    assert.throws(
      () => recordContextFeedback(database, { ...input, verdict: 'irrelevant' }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && !(error instanceof Error && error.message.includes('same body')),
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('sanitizes context comments before enforcing the exact 4 KiB byte boundary', async () => {
  const database = await temporaryDatabase('context-feedback-sanitize');
  try {
    seedLedgerContext(database);
    const common = {
      workspace,
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful' as const,
      actor: 'user-1',
    };
    const url = recordContextFeedback(database, {
      ...common,
      feedbackId: 'sanitized-url',
      comment: `https://user:password@example.test/context?token=${'x'.repeat(5000)}#fragment`,
      idempotencyKey: 'sanitize-url-key',
      createdAt: now,
    });
    const secret = recordContextFeedback(database, {
      ...common,
      feedbackId: 'sanitized-secret',
      comment: `Authorization: Bearer ${'a'.repeat(16)}`,
      idempotencyKey: 'sanitize-secret-key',
      createdAt: '2026-08-20T00:00:01.000Z',
    });
    const exact = recordContextFeedback(database, {
      ...common,
      feedbackId: 'exact-comment-boundary',
      comment: 'a'.repeat(4096),
      idempotencyKey: 'sanitize-exact-key',
      createdAt: '2026-08-20T00:00:02.000Z',
    });
    const homePath = recordContextFeedback(database, {
      ...common,
      feedbackId: 'sanitized-home-path',
      comment: path.join(process.env.HOME ?? '/home/ubuntu', 'private.txt'),
      idempotencyKey: 'sanitize-home-key',
      createdAt: '2026-08-20T00:00:03.000Z',
    });

    assert.equal(url.comment, 'https://example.test/context');
    assert.equal(secret.comment, '[REDACTED:authorization_header]');
    assert.equal(exact.comment?.length, 4096);
    assert.equal(homePath.comment, '<HOME>/private.txt');
    assert.throws(
      () => recordContextFeedback(database, {
        ...common,
        feedbackId: 'over-comment-boundary',
        comment: 'a'.repeat(4097),
        idempotencyKey: 'sanitize-over-key',
        createdAt: '2026-08-20T00:00:03.000Z',
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && !(error instanceof Error && error.message.includes('aaaa')),
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 4);
  } finally {
    database.close();
  }
});

test('rejects unknown, non-JSON, non-finite, and cyclic public input with fixed safe validation errors', async () => {
  const database = await temporaryDatabase('feedback-validation');
  try {
    seedLedgerContext(database);
    const contextBase = {
      workspace,
      feedbackId: 'validation-context',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful' as const,
      actor: 'actor-sentinel',
      idempotencyKey: 'key-sentinel',
      createdAt: now,
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolInput = { ...contextBase } as Record<string | symbol, unknown>;
    symbolInput[Symbol('raw-comment-sentinel')] = 'raw-comment-sentinel';
    const accessorInput = { ...contextBase } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'comment', {
      enumerable: true,
      get: () => { throw new Error('raw-comment-sentinel'); },
    });
    const proxyInput = new Proxy({ ...contextBase }, {
      get: () => { throw new Error('raw-comment-sentinel'); },
    });
    for (const invalid of [
      { ...contextBase, unknownSentinel: 'raw-comment-sentinel' },
      { ...contextBase, comment: Number.NaN },
      { ...contextBase, comment: cyclic },
      new Date(),
      { ...contextBase, comment: Infinity },
      symbolInput,
      accessorInput,
      proxyInput,
    ]) {
      assert.throws(
        () => recordContextFeedback(database, invalid),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
          assert.equal((error as Error).message, 'Feedback input is invalid');
          assert.doesNotMatch((error as Error).message, /raw-comment-sentinel|actor-sentinel|key-sentinel/);
          return true;
        },
      );
    }
    assert.throws(
      () => recordRunFeedback(database, {
        workspace,
        feedbackId: 'validation-run',
        runId: 'run-feedback-1',
        actor: 'actor-sentinel',
        idempotencyKey: 'key-sentinel',
        createdAt: now,
        rating: Number.POSITIVE_INFINITY,
        unknownSentinel: 'raw-comment-sentinel',
      }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Feedback input is invalid',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('accepts only the canonical millisecond UTC feedback timestamp', async () => {
  const database = await temporaryDatabase('feedback-timestamp-validation');
  try {
    seedLedgerContext(database);
    const base = {
      workspace,
      feedbackId: 'timestamp-context',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful' as const,
      actor: 'timestamp-user',
      idempotencyKey: 'timestamp-key',
    };
    for (const createdAt of [
      null,
      0,
      '2026-08-20T00:00:00Z',
      '2026-08-20T09:00:00.000+09:00',
      '+010000-01-01T00:00:00.000Z',
      '2026-02-29T00:00:00.000Z',
    ]) {
      assert.throws(
        () => recordContextFeedback(database, { ...base, createdAt }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
          && (error as Error).message === 'Feedback input is invalid',
      );
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('requires a run feedback target and paired recommendation fields', async () => {
  const database = await temporaryDatabase('run-feedback-validation');
  try {
    seedLedgerContext(database);
    const base = {
      workspace,
      feedbackId: 'run-validation',
      runId: 'run-feedback-1',
      actor: 'user-1',
      idempotencyKey: 'run-validation-key',
      createdAt: now,
    };
    for (const invalid of [
      { ...base, comment: 'comment only' },
      { ...base, recommendationCode: 'VERIFY_AFTER_MUTATION' },
      { ...base, recommendationVerdict: 'accepted' },
      { ...base, recommendationCode: 'VERIFY_AFTER_MUTATION', recommendationVerdict: 'accepted', rating: 6 },
      { ...base, recommendationCode: 'VERIFY_AFTER_MUTATION', recommendationVerdict: 'unknown' },
    ]) {
      assert.throws(
        () => recordRunFeedback(database, invalid),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Feedback input is invalid',
      );
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('returns the same NOT_FOUND error for missing or inconsistent context tuples and runs', async () => {
  const database = await temporaryDatabase('context-feedback-not-found');
  try {
    seedLedgerContext(database);
    const base = {
      workspace,
      feedbackId: 'not-found-context',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'stale' as const,
      actor: 'user-1',
      idempotencyKey: 'not-found-key',
      createdAt: now,
    };
    for (const invalid of [
      { ...base, deliveryId: 'missing-delivery' },
      { ...base, entryId: 'missing-entry' },
      { ...base, runId: 'missing-run' },
      { ...base, workspace: 'other-workspace' },
      { ...base, runId: 'missing-run', deliveryId: 'missing-delivery', entryId: 'missing-entry', workspace: 'other-workspace' },
    ]) {
      assert.throws(
        () => recordContextFeedback(database, invalid),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'NOT_FOUND');
          assert.equal((error as Error).message, 'Feedback target was not found');
          assert.doesNotMatch((error as Error).message, /missing-delivery|missing-entry|missing-run|other-workspace/);
          return true;
        },
      );
    }
    assert.throws(
      () => recordRunFeedback(database, {
        workspace,
        feedbackId: 'not-found-run',
        runId: 'missing-run',
        outcome: 'failed',
        actor: 'user-1',
        idempotencyKey: 'not-found-run-key',
        createdAt: now,
      }),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND' && (error as Error).message === 'Feedback target was not found',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('scopes hashed idempotency keys by actor and run and rejects feedback-id collisions', async () => {
  const database = await temporaryDatabase('feedback-key-scope');
  try {
    seedLedgerContext(database);
    database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, protocol_version, capture_profile, coverage_json,
        status, metadata_json, last_sequence, started_at, created_at, updated_at
      ) VALUES (?, ?, 'generic', '1', 'standard', '{}', 'active', '{}', 0, ?, ?, ?)
    `).run('run-feedback-2', workspace, now, now, now);

    const base = {
      workspace,
      runId: 'run-feedback-1',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      verdict: 'irrelevant' as const,
      comment: null,
      idempotencyKey: 'same-raw-key',
      createdAt: now,
    };
    const first = recordContextFeedback(database, { ...base, feedbackId: 'scope-user-1', actor: 'user-1' });
    const otherActor = recordContextFeedback(database, { ...base, feedbackId: 'scope-user-2', actor: 'user-2' });
    assert.notDeepEqual(otherActor, first);
    assert.equal('idempotencyKey' in first, false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback WHERE idempotency_key = ?').get<{ count: number }>(first.idempotencyKeyHash)?.count, 2);
    assert.throws(
      () => recordContextFeedback(database, { ...base, feedbackId: 'scope-conflict', actor: 'user-1' }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    assert.throws(
      () => recordContextFeedback(database, { ...base, feedbackId: 'scope-user-1', actor: 'user-3', idempotencyKey: 'different-key' }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );

    const runFirst = recordRunFeedback(database, {
      workspace,
      feedbackId: 'run-scope-1',
      runId: 'run-feedback-1',
      outcome: 'done',
      actor: 'user-1',
      idempotencyKey: 'same-run-key',
      createdAt: now,
    });
    const runOther = recordRunFeedback(database, {
      workspace,
      feedbackId: 'run-scope-2',
      runId: 'run-feedback-2',
      outcome: 'done',
      actor: 'user-1',
      idempotencyKey: 'same-run-key',
      createdAt: now,
    });
    assert.notEqual(runOther.feedbackId, runFirst.feedbackId);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 2);
  } finally {
    database.close();
  }
});

test('caller-owned context transactions do not commit and preserve the outer marker on replay or conflict', async () => {
  const database = await temporaryDatabase('feedback-transactions');
  try {
    seedLedgerContext(database);
    database.exec('CREATE TEMP TABLE tx_marker (value TEXT NOT NULL)');
    const input = {
      workspace,
      feedbackId: 'transaction-feedback-1',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'conflicting' as const,
      comment: null,
      actor: 'user-1',
      idempotencyKey: 'transaction-key',
      createdAt: now,
    };

    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('before-write');
    recordContextFeedbackInTransaction(database, input);
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('after-write');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 1);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 0);

    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('before-run-write');
    recordRunFeedbackInTransaction(database, {
      workspace,
      feedbackId: 'transaction-run-feedback',
      runId: 'run-feedback-1',
      outcome: 'done',
      actor: 'user-1',
      idempotencyKey: 'transaction-run-key',
      createdAt: now,
    });
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('after-run-write');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 2);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 0);

    const first = recordContextFeedback(database, input);
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('before-replay');
    assert.deepEqual(recordContextFeedbackInTransaction(database, { ...input }), first);
    assert.throws(
      () => recordContextFeedbackInTransaction(database, { ...input, verdict: 'helpful' }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    database.prepare('INSERT INTO tx_marker (value) VALUES (?)').run('after-conflict');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tx_marker').get<{ count: number }>()?.count, 2);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('standalone failures roll back feedback and trigger side effects while propagating an unexpected trigger failure', async () => {
  const database = await temporaryDatabase('feedback-rollback');
  try {
    seedLedgerContext(database);
    database.exec('CREATE TABLE feedback_side_effects (value TEXT NOT NULL)');
    database.exec(`
      CREATE TRIGGER fail_feedback_after_insert
      AFTER INSERT ON context_feedback
      BEGIN
        INSERT INTO feedback_side_effects (value) VALUES ('should-rollback');
        SELECT RAISE(ABORT, 'intentional feedback failure');
      END
    `);
    assert.throws(
      () => recordContextFeedback(database, {
        workspace,
        feedbackId: 'rollback-feedback',
        deliveryId: 'delivery-feedback-1',
        entryId: 'entry-feedback-1',
        runId: 'run-feedback-1',
        verdict: 'helpful',
        actor: 'user-1',
        idempotencyKey: 'rollback-key',
        createdAt: now,
      }),
      (error: unknown) => {
        const failure = error as { code?: unknown; errcode?: unknown; message?: unknown };
        assert.equal(failure.code, 'ERR_SQLITE_ERROR');
        assert.equal(failure.errcode, 1_811);
        assert.equal(failure.message, 'intentional feedback failure');
        return true;
      },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM feedback_side_effects').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('feedback propagates unrelated constraints and programmer errors that merely mention constraints', async () => {
  const database = await temporaryDatabase('feedback-error-classification');
  try {
    seedLedgerContext(database);
    database.exec(`
      CREATE TABLE unrelated_feedback_unique (value TEXT NOT NULL UNIQUE);
      INSERT INTO unrelated_feedback_unique (value) VALUES ('occupied');
      CREATE TRIGGER unrelated_feedback_unique_failure
      BEFORE INSERT ON context_feedback
      BEGIN
        INSERT INTO unrelated_feedback_unique (value) VALUES ('occupied');
      END;
    `);
    assert.throws(
      () => recordContextFeedback(database, {
        workspace,
        feedbackId: 'unrelated-constraint-feedback',
        deliveryId: 'delivery-feedback-1',
        entryId: 'entry-feedback-1',
        runId: 'run-feedback-1',
        verdict: 'helpful',
        actor: 'user-1',
        idempotencyKey: 'unrelated-constraint-key',
        createdAt: now,
      }),
      (error: unknown) => {
        const failure = error as { code?: unknown; errcode?: unknown; message?: unknown };
        assert.equal(failure.code, 'ERR_SQLITE_ERROR');
        assert.equal(failure.errcode, 2_067);
        assert.equal(failure.message, 'UNIQUE constraint failed: unrelated_feedback_unique.value');
        return true;
      },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback').get<{ count: number }>()?.count, 0);

    const programmerFailure = new Error('programmer failure mentioning unique and constraint');
    const failingDatabase = {
      filePath: database.filePath,
      exec: database.exec.bind(database),
      prepare: () => { throw programmerFailure; },
      close: () => {},
    };
    assert.throws(
      () => listContextFeedback(failingDatabase, { workspace }),
      (error: unknown) => error === programmerFailure,
    );
  } finally {
    database.close();
  }
});

test('feedback leaves memory, delivery, run, and Akinator-linked rows byte-for-byte unchanged', async () => {
  const database = await temporaryDatabase('feedback-invariants');
  try {
    seedLedgerContext(database);
    const snapshot = {
      entries: database.prepare('SELECT e.id, e.status, e.trust_level, e.current_revision, r.body, r.summary FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision ORDER BY e.id').all(),
      deliveries: database.prepare('SELECT * FROM context_deliveries ORDER BY delivery_id').all(),
      deliveryEntries: database.prepare('SELECT * FROM context_delivery_entries ORDER BY delivery_id, entry_id').all(),
      runs: database.prepare('SELECT run_id, workspace, status, last_sequence, metadata_json FROM ledger_runs ORDER BY run_id').all(),
      sessions: database.prepare('SELECT * FROM akinator_sessions ORDER BY id').all(),
      intakes: database.prepare('SELECT * FROM run_intakes ORDER BY run_id').all(),
    };
    const contextBase = {
      workspace,
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      actor: 'user-1',
      createdAt: now,
    };
    for (const [index, verdict] of (['helpful', 'irrelevant', 'conflicting'] as const).entries()) {
      recordContextFeedback(database, {
        ...contextBase,
        feedbackId: `invariant-context-${verdict}`,
        verdict,
        idempotencyKey: `invariant-context-key-${index}`,
      });
    }
    recordRunFeedback(database, {
      workspace,
      feedbackId: 'invariant-run-feedback',
      runId: 'run-feedback-1',
      recommendationCode: 'VERIFY_AFTER_MUTATION',
      recommendationVerdict: 'dismissed',
      rating: 1,
      comment: 'No mutation expected.',
      actor: 'user-1',
      idempotencyKey: 'invariant-run-key',
      createdAt: now,
    });
    assert.deepEqual({
      entries: database.prepare('SELECT e.id, e.status, e.trust_level, e.current_revision, r.body, r.summary FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision ORDER BY e.id').all(),
      deliveries: database.prepare('SELECT * FROM context_deliveries ORDER BY delivery_id').all(),
      deliveryEntries: database.prepare('SELECT * FROM context_delivery_entries ORDER BY delivery_id, entry_id').all(),
      runs: database.prepare('SELECT run_id, workspace, status, last_sequence, metadata_json FROM ledger_runs ORDER BY run_id').all(),
      sessions: database.prepare('SELECT * FROM akinator_sessions ORDER BY id').all(),
      intakes: database.prepare('SELECT * FROM run_intakes ORDER BY run_id').all(),
    }, snapshot);
  } finally {
    database.close();
  }
});

test('maps invalid persisted verdict, timestamp, hash, comment, and cross-reference to INTEGRITY_ERROR', async () => {
  const database = await temporaryDatabase('feedback-integrity');
  try {
    seedLedgerContext(database);
    const context = recordContextFeedback(database, {
      workspace,
      feedbackId: 'integrity-context',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful',
      comment: 'safe stored comment',
      actor: 'user-1',
      idempotencyKey: 'integrity-context-key',
      createdAt: now,
    });
    const run = recordRunFeedback(database, {
      workspace,
      feedbackId: 'integrity-run',
      runId: 'run-feedback-1',
      outcome: 'done',
      actor: 'user-1',
      idempotencyKey: 'integrity-run-key',
      createdAt: now,
    });
    database.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
    database.prepare('UPDATE context_feedback SET verdict = ? WHERE feedback_id = ?').run('invalid-verdict', context.feedbackId);
    database.prepare('UPDATE run_feedback SET recommendation_verdict = ? WHERE feedback_id = ?').run('invalid-verdict', run.feedbackId);
    database.exec('PRAGMA ignore_check_constraints = OFF;');
    assert.throws(
      () => listContextFeedback(database, { workspace }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && (error as Error).message === 'Stored feedback is invalid',
    );
    assert.throws(
      () => listRunFeedback(database, { workspace }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && (error as Error).message === 'Stored feedback is invalid',
    );
    database.prepare('UPDATE context_feedback SET verdict = ?, created_at = ? WHERE feedback_id = ?').run('helpful', 'not-a-timestamp', context.feedbackId);
    assert.throws(
      () => listContextFeedback(database, { workspace }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && (error as Error).message === 'Stored feedback is invalid',
    );
    database.prepare('UPDATE context_feedback SET created_at = ? WHERE feedback_id = ?').run(now, context.feedbackId);

    database.prepare('UPDATE context_feedback SET verdict = ?, run_id = ? WHERE feedback_id = ?').run('helpful', 'missing-run', context.feedbackId);
    database.prepare('UPDATE run_feedback SET recommendation_verdict = NULL WHERE feedback_id = ?').run(run.feedbackId);
    assert.throws(
      () => listContextFeedback(database, { workspace }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && (error as Error).message === 'Stored feedback is invalid',
    );
    database.prepare('UPDATE context_feedback SET run_id = ? WHERE feedback_id = ?').run('run-feedback-1', context.feedbackId);

    database.prepare('UPDATE context_feedback SET verdict = ?, created_at = ?, idempotency_key = ?, comment = ?, delivery_id = ? WHERE feedback_id = ?')
      .run('helpful', 'not-a-timestamp', 'BAD-HASH', 'Authorization: Bearer ' + 'a'.repeat(16), 'missing-delivery', context.feedbackId);
    assert.throws(
      () => listContextFeedback(database, { workspace }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INTEGRITY_ERROR');
        assert.equal((error as Error).message, 'Stored feedback is invalid');
        assert.doesNotMatch((error as Error).message, /abcdefghijklmnop|not-a-timestamp|BAD-HASH|missing-delivery/);
        return true;
      },
    );
  } finally {
    database.close();
  }
});

test('replays and conflicts run feedback using the same canonical idempotency rules', async () => {
  const database = await temporaryDatabase('run-feedback-idempotency');
  try {
    seedLedgerContext(database);
    const input = {
      workspace,
      feedbackId: 'run-idempotent-1',
      runId: 'run-feedback-1',
      outcome: 'completed',
      recommendationCode: 'VERIFY_AFTER_MUTATION',
      recommendationVerdict: 'accepted' as const,
      rating: 4,
      comment: '  ',
      actor: 'user-1',
      idempotencyKey: 'run-same-key',
      createdAt: now,
    };
    const first = recordRunFeedback(database, input);
    assert.equal(first.comment, null);
    assert.deepEqual(recordRunFeedback(database, { ...input }), first);
    assert.throws(
      () => recordRunFeedback(database, { ...input, rating: 3 }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT' && (error as Error).message === 'Feedback conflicts with existing record',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_feedback').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('owns input and output snapshots so later caller mutations cannot change feedback', async () => {
  const database = await temporaryDatabase('feedback-owned-snapshots');
  try {
    seedLedgerContext(database);
    const input: Record<string, unknown> = {
      workspace,
      feedbackId: 'owned-context',
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'helpful',
      comment: 'original comment',
      actor: 'user-1',
      idempotencyKey: 'owned-key',
      createdAt: now,
    };
    const record = recordContextFeedback(database, input);
    input.comment = 'caller mutation';
    record.comment = 'returned record mutation';
    const listed = listContextFeedback(database, { workspace, runId: 'run-feedback-1' });
    assert.equal(listed.records[0]?.comment, 'original comment');
    assert.equal(database.prepare('SELECT comment FROM context_feedback WHERE feedback_id = ?').get<{ comment: string }>('owned-context')?.comment, 'original comment');
  } finally {
    database.close();
  }
});

test('bounds list limits, hides other workspaces, and orders equal timestamps by feedback id', async () => {
  const database = await temporaryDatabase('feedback-list-bounds');
  try {
    seedLedgerContext(database);
    const contextBase = {
      workspace,
      deliveryId: 'delivery-feedback-1',
      entryId: 'entry-feedback-1',
      runId: 'run-feedback-1',
      verdict: 'stale' as const,
      comment: null,
      actor: 'user-1',
      createdAt: now,
    };
    recordContextFeedback(database, { ...contextBase, feedbackId: 'tie-z', idempotencyKey: 'tie-z-key' });
    recordContextFeedback(database, { ...contextBase, feedbackId: 'tie-a', idempotencyKey: 'tie-a-key' });
    recordRunFeedback(database, {
      workspace,
      feedbackId: 'tie-run-z',
      runId: 'run-feedback-1',
      outcome: 'done',
      actor: 'user-1',
      idempotencyKey: 'tie-run-z-key',
      createdAt: now,
    });
    recordRunFeedback(database, {
      workspace,
      feedbackId: 'tie-run-a',
      runId: 'run-feedback-1',
      outcome: 'done',
      actor: 'user-1',
      idempotencyKey: 'tie-run-a-key',
      createdAt: now,
    });
    assert.deepEqual(listContextFeedback(database, { workspace, runId: 'run-feedback-1' }).records.map((record) => record.feedbackId).slice(-2), ['tie-a', 'tie-z']);
    assert.deepEqual(listRunFeedback(database, { workspace, runId: 'run-feedback-1' }).records.map((record) => record.feedbackId).slice(-2), ['tie-run-a', 'tie-run-z']);
    assert.deepEqual(listContextFeedback(database, { workspace: 'other-workspace' }).records, []);
    assert.deepEqual(listRunFeedback(database, { workspace: 'other-workspace' }).records, []);
    for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => listContextFeedback(database, { workspace, limit }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Feedback input is invalid',
      );
      assert.throws(
        () => listRunFeedback(database, { workspace, limit }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && (error as Error).message === 'Feedback input is invalid',
      );
    }
    assert.throws(
      () => listContextFeedback(database, { workspace, unknownSentinel: 'not-exposed' } as never),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR' && !(error instanceof Error && error.message.includes('not-exposed')),
    );
  } finally {
    database.close();
  }
});
