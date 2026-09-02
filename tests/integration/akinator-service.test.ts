import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { answerAkinatorService, getAkinatorContextService, startAkinatorService } from '../../src/akinator/service.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  migrateDatabase(database);
  return database;
}

test('starts a trimmed task through the shared domain and store service', async () => {
  const database = await temporaryDatabase('akinator-service-start');
  try {
    const result = await startAkinatorService(database, {
      workspace: 'project:service-start',
      task: '  Implement a feature  ',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-start-fixed',
    });

    assert.equal(result.status, 'needs_answer');
    assert.equal(result.session.task, 'Implement a feature');
    assert.equal(result.session.profile.taskType, 'build');
    assert.equal(result.session.questionCount, 0);
    assert.equal(result.question?.id, 'target');
    assert.deepEqual(Object.keys(result).sort(), [
      'missingFields', 'question', 'recommendedTags', 'session', 'status',
    ]);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions').get<{ count: number }>()?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test('rejects secret-like task text before opening a write transaction', async () => {
  const database = await temporaryDatabase('akinator-service-secret');
  const secret = 'password = super-secret-value-12345';
  try {
    await assert.rejects(
      () => startAkinatorService(database, {
        workspace: 'project:service-secret',
        task: secret,
        idFactory: () => 'service-secret-fixed',
      }),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string; details?: unknown };
        assert.equal(typed.code, 'SECURITY_REJECTION');
        assert.equal(typed.message?.includes(secret), false);
        assert.equal(JSON.stringify(typed.details ?? {}).includes(secret), false);
        return true;
      },
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions').get<{ count: number }>()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test('rejects secret-like profile hints before opening a write transaction', async () => {
  const database = await temporaryDatabase('akinator-service-profile-secret');
  const secret = 'api_key = hidden-profile-secret-value-12345';
  try {
    await assert.rejects(
      () => startAkinatorService(database, {
        workspace: 'project:service-profile-secret',
        task: 'Implement a feature',
        profileHints: { target: secret },
        idFactory: () => 'service-profile-secret-fixed',
      }),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string; details?: unknown };
        assert.equal(typed.code, 'SECURITY_REJECTION');
        assert.equal(typed.message?.includes(secret), false);
        assert.equal(JSON.stringify(typed.details ?? {}).includes(secret), false);
        return true;
      },
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions').get<{ count: number }>()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test('rejects an oversized sanitized task snapshot before opening a write transaction', async () => {
  const database = await temporaryDatabase('akinator-service-task-size');
  try {
    await assert.rejects(
      () => startAkinatorService(database, {
        workspace: 'project:service-task-size',
        task: 'x'.repeat(64 * 1024 + 1),
        idFactory: () => 'service-task-size-fixed',
      }),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string };
        assert.equal(typed.code, 'VALIDATION_ERROR');
        assert.equal(typed.message, 'Akinator task snapshot exceeds 65536 bytes');
        return true;
      },
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_sessions').get<{ count: number }>()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test('answers the current question through one service transaction', async () => {
  const database = await temporaryDatabase('akinator-service-answer');
  try {
    const started = await startAkinatorService(database, {
      workspace: 'project:service-answer',
      task: 'Implement a feature',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-answer-fixed',
    });
    const answered = await answerAkinatorService(database, {
      workspace: 'project:service-answer',
      sessionId: started.session.id,
      questionId: 'target',
      value: '  src/feature.ts  ',
      now: '2026-08-20T00:01:00.000Z',
    });

    assert.equal(answered.status, 'needs_answer');
    assert.equal(answered.question?.id, 'expected');
    assert.equal(answered.session.questionCount, 1);
    assert.equal(answered.session.profile.target, 'src/feature.ts');
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?').get<{ count: number }>(started.session.id)?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test('rejects secret-like answer text before writing the answer', async () => {
  const database = await temporaryDatabase('akinator-service-answer-secret');
  const secret = 'api_key = hidden-secret-value-12345';
  try {
    const started = await startAkinatorService(database, {
      workspace: 'project:service-answer-secret',
      task: 'Implement a feature',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-answer-secret-fixed',
    });

    await assert.rejects(
      () => answerAkinatorService(database, {
        workspace: 'project:service-answer-secret',
        sessionId: started.session.id,
        questionId: 'target',
        value: secret,
        now: '2026-08-20T00:01:00.000Z',
      }),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string; details?: unknown };
        assert.equal(typed.code, 'SECURITY_REJECTION');
        assert.equal(typed.message?.includes(secret), false);
        assert.equal(JSON.stringify(typed.details ?? {}).includes(secret), false);
        return true;
      },
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?').get<{ count: number }>(started.session.id)?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test('rejects an oversized sanitized answer snapshot before writing the answer', async () => {
  const database = await temporaryDatabase('akinator-service-answer-size');
  try {
    const started = await startAkinatorService(database, {
      workspace: 'project:service-answer-size',
      task: 'Implement a feature',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-answer-size-fixed',
    });

    await assert.rejects(
      () => answerAkinatorService(database, {
        workspace: 'project:service-answer-size',
        sessionId: started.session.id,
        questionId: 'target',
        value: 'x'.repeat(64 * 1024 + 1),
        now: '2026-08-20T00:01:00.000Z',
      }),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string };
        assert.equal(typed.code, 'VALIDATION_ERROR');
        assert.equal(typed.message, 'sanitized answer snapshot exceeds 65536 bytes');
        return true;
      },
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?').get<{ count: number }>(started.session.id)?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test('replays the already-derived result for the same canonical answer without incrementing twice', async () => {
  const database = await temporaryDatabase('akinator-service-replay');
  try {
    const started = await startAkinatorService(database, {
      workspace: 'project:service-replay',
      task: 'Implement a feature',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-replay-fixed',
    });
    const first = await answerAkinatorService(database, {
      workspace: 'project:service-replay',
      sessionId: started.session.id,
      questionId: 'target',
      value: 'src/feature.ts',
      now: '2026-08-20T00:01:00.000Z',
    });
    const replay = await answerAkinatorService(database, {
      workspace: 'project:service-replay',
      sessionId: started.session.id,
      questionId: 'target',
      value: '  src/feature.ts  ',
      now: '2026-08-20T00:02:00.000Z',
    });

    assert.deepEqual(replay, first);
    assert.equal(replay.session.questionCount, 1);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?').get<{ count: number }>(started.session.id)?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test('conflicts on a different answer for an already-answered question without mutating it', async () => {
  const database = await temporaryDatabase('akinator-service-answer-conflict');
  try {
    const started = await startAkinatorService(database, {
      workspace: 'project:service-answer-conflict',
      task: 'Implement a feature',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-answer-conflict-fixed',
    });
    await answerAkinatorService(database, {
      workspace: 'project:service-answer-conflict',
      sessionId: started.session.id,
      questionId: 'target',
      value: 'src/feature.ts',
      now: '2026-08-20T00:01:00.000Z',
    });

    await assert.rejects(
      () => answerAkinatorService(database, {
        workspace: 'project:service-answer-conflict',
        sessionId: started.session.id,
        questionId: 'target',
        value: 'src/other.ts',
        now: '2026-08-20T00:02:00.000Z',
      }),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'CONFLICT'
        && (error as { message?: string }).message === 'Akinator answer conflicts with the existing answer',
    );
    const session = database.prepare('SELECT question_count AS questionCount FROM akinator_sessions WHERE id = ?').get<{ questionCount: number }>(started.session.id);
    assert.equal(session?.questionCount, 1);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?').get<{ count: number }>(started.session.id)?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test('returns the exact empty context shape while intake still needs an answer', async () => {
  const database = await temporaryDatabase('akinator-service-context-needs-answer');
  try {
    const started = await startAkinatorService(database, {
      workspace: 'project:service-context-needs-answer',
      task: 'Implement a feature',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-context-needs-answer-fixed',
    });
    const context = await getAkinatorContextService(database, {
      workspace: 'project:service-context-needs-answer',
      sessionId: started.session.id,
    });

    assert.equal(context.status, 'needs_answer');
    assert.equal(context.question?.id, 'target');
    assert.deepEqual(context.entries, []);
    assert.deepEqual(Object.keys(context).sort(), [
      'entries', 'instructions', 'missingFields', 'question', 'recommendedTags', 'session', 'status',
    ]);
  } finally {
    database.close();
  }
});

test('uses local finalized entries for stored context', async () => {
  const database = await temporaryDatabase('akinator-service-context-local');
  try {
    const local = recordEntry(database, {
      workspace: 'project:service-context-local',
      kind: 'lesson',
      title: 'Builder convention',
      body: 'Use a failing test first.',
      tags: ['bot:builder'],
    });
    const started = await startAkinatorService(database, {
      workspace: 'project:service-context-local',
      task: 'Implement a feature',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-context-local-fixed',
    });
    await answerAkinatorService(database, {
      workspace: 'project:service-context-local',
      sessionId: started.session.id,
      questionId: 'target',
      value: 'src/feature.ts',
      now: '2026-08-20T00:01:00.000Z',
    });
    await answerAkinatorService(database, {
      workspace: 'project:service-context-local',
      sessionId: started.session.id,
      questionId: 'expected',
      value: 'tests pass',
      now: '2026-08-20T00:02:00.000Z',
    });

    const context = await getAkinatorContextService(database, {
      workspace: 'project:service-context-local',
      sessionId: started.session.id,
    });

    assert.equal(context.status, 'ready');
    assert.ok(context.entries.some((entry) => entry.id === local.id));
  } finally {
    database.close();
  }
});

test('returns empty stored context when no local entry is available', async () => {
  const database = await temporaryDatabase('akinator-service-no-skill-fallback');
  try {
    const started = await startAkinatorService(database, {
      workspace: 'project:service-no-skill-fallback',
      task: 'Implement a feature',
      profileHints: { target: 'src/feature.ts', expected: 'tests pass' },
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'service-no-skill-fallback-fixed',
    });
    assert.equal(started.status, 'ready');

    const context = await getAkinatorContextService(database, {
      workspace: 'project:service-no-skill-fallback',
      sessionId: started.session.id,
    });

    assert.equal(context.status, 'ready');
    assert.deepEqual(context.entries, []);
    assert.equal('externalSync' in context, false);
  } finally {
    database.close();
  }
});

test('keeps the orchestrator limited to intake mutation without a task-memory compatibility facade', () => {
  const source = readFileSync(new URL('../../src/akinator/orchestrator.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /database\.prepare|TASK_TYPES|inferTaskType|nextQuestion|recommendedTags|searchEntries|getAkinatorContextService|withImmediateTransaction|Akinator is waiting/u);
  assert.match(source, /startAkinatorService/);
  assert.match(source, /answerAkinatorService/);
});

test('removes the fixed-source compatibility adapter', () => {
  assert.equal(existsSync(new URL('../../src/knowledge/sources.ts', import.meta.url)), false);
});
