import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { executeTaskRequest, executeTaskRequestInTransaction } from '../../src/task-run/idempotency.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const migrationsDirectory = path.join(repositoryRoot, 'migrations');
const execFileAsync = promisify(execFile);
const createdAt = '2026-08-20T00:00:00.000Z';

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-server-idempotency-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrationsDirectory);
  return database;
}

test('first execution runs once and stores only hashed request identity plus canonical response', async () => {
  const database = await setup();
  try {
    let calls = 0;
    const key = 'raw-idempotency-key';
    const request = { z: 2, a: 'request-body-should-not-be-stored' };
    const response = executeTaskRequest(
      database,
      { scope: 'agent.run.open', key, request, createdAt },
      () => {
        calls += 1;
        return { ok: true, accepted: 1 };
      },
    );

    assert.deepEqual(response, { accepted: 1, ok: true });
    assert.equal(calls, 1);
    const row = database.prepare(`
      SELECT scope, key_hash, request_hash, response_json, created_at
      FROM task_request_receipts
    `).get<{
      scope: string;
      key_hash: string;
      request_hash: string;
      response_json: string;
      created_at: string;
    }>();
    assert.deepEqual({ ...row }, {
      scope: 'agent.run.open',
      key_hash: '45fa41dcc6e364084ebaf36ade15fed2be08cfc3ec065e34978527de61215019',
      request_hash: '582bc0618f1bb339b5e849a95d50df40a48ad1308d9bfb2488c765ac6a28f27a',
      response_json: '{"accepted":1,"ok":true}',
      created_at: createdAt,
    });
    assert.equal(JSON.stringify(row).includes(key), false);
    assert.equal(JSON.stringify(row).includes('request-body-should-not-be-stored'), false);
  } finally {
    database.close();
  }
});

test('exact canonical-equivalent replay returns the stored response without re-running the operation', async () => {
  const database = await setup();
  try {
    let calls = 0;
    const first = executeTaskRequest(
      database,
      { scope: 'agent.run.open', key: 'replay-key', request: { z: 2, a: 1 }, createdAt },
      () => {
        calls += 1;
        return { result: 'persisted', nested: { b: 2, a: 1 } };
      },
    );
    const replay = executeTaskRequest(
      database,
      { scope: 'agent.run.open', key: 'replay-key', request: { a: 1, z: 2 }, createdAt },
      () => {
        calls += 1;
        return { result: 'should-not-run' };
      },
    );

    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
  } finally {
    database.close();
  }
});

test('same scope and key with a different canonical request conflicts without changing the row', async () => {
  const database = await setup();
  try {
    let calls = 0;
    executeTaskRequest(
      database,
      { scope: 'agent.run.open', key: 'conflict-key', request: { value: 'first' }, createdAt },
      () => {
        calls += 1;
        return { result: 'original' };
      },
    );
    const before = database.prepare(`
      SELECT scope, key_hash, request_hash, response_json, created_at
      FROM task_request_receipts
    `).get();

    assert.throws(
      () => executeTaskRequest(
        database,
        { scope: 'agent.run.open', key: 'conflict-key', request: { value: 'raw-conflicting-request-value' }, createdAt },
        () => {
          calls += 1;
          return { result: 'must-not-run' };
        },
      ),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'CONFLICT', true);
        assert.equal(error instanceof Error && error.message, 'Idempotency key was reused with a different request');
        assert.deepEqual(error instanceof Error && 'details' in error ? error.details : undefined, { reason: 'request_mismatch' });
        assert.equal(String(error).includes('conflict-key'), false);
        assert.equal(String(error).includes('raw-conflicting-request-value'), false);
        return true;
      },
    );

    assert.equal(calls, 1);
    assert.deepEqual({ ...database.prepare(`
      SELECT scope, key_hash, request_hash, response_json, created_at
      FROM task_request_receipts
    `).get() }, { ...before });
  } finally {
    database.close();
  }
});

test('the same key is independent across internal scopes', async () => {
  const database = await setup();
  try {
    let calls = 0;
    const operation = () => {
      calls += 1;
      return { calls };
    };

    const first = executeTaskRequest(database, { scope: 'scope-a', key: 'shared-key', request: { value: 1 }, createdAt }, operation);
    const second = executeTaskRequest(database, { scope: 'scope-b', key: 'shared-key', request: { value: 1 }, createdAt }, operation);
    const replay = executeTaskRequest(database, { scope: 'scope-a', key: 'shared-key', request: { value: 1 }, createdAt }, () => ({ calls: 99 }));

    assert.deepEqual(first, { calls: 1 });
    assert.deepEqual(second, { calls: 2 });
    assert.deepEqual(replay, first);
    assert.equal(calls, 2);
  } finally {
    database.close();
  }
});

test('unknown idempotency input fields are rejected with a fixed validation error', async () => {
  const database = await setup();
  try {
    assert.throws(
      () => executeTaskRequest(
        database,
        { scope: 'scope', key: 'key', request: {}, createdAt, extra: 'untrusted-input' } as never,
        () => ({ ok: true }),
      ),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Invalid idempotency input');
        assert.deepEqual(error instanceof Error && 'details' in error ? error.details : undefined, {});
        assert.equal(String(error).includes('untrusted-input'), false);
        return true;
      },
    );
  } finally {
    database.close();
  }
});

test('non-canonical enumerable array keys are rejected by both idempotency entry points', async () => {
  const database = await setup();
  try {
    database.exec('CREATE TABLE operation_marker (value TEXT NOT NULL)');
    const malformedEvents = ['ordinary-event'];
    Object.defineProperty(malformedEvents, '01', {
      configurable: true,
      enumerable: true,
      value: 'non-canonical-event',
      writable: true,
    });
    const input = { scope: 'array-scope', key: 'array-key', request: { events: malformedEvents }, createdAt };
    let calls = 0;
    const operation = () => {
      calls += 1;
      database.prepare('INSERT INTO operation_marker (value) VALUES (?)').run('must-not-run');
      return { accepted: true };
    };
    const assertInvalidInput = (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
      assert.equal(error instanceof Error && error.message, 'Invalid idempotency input');
      assert.deepEqual(error instanceof Error && 'details' in error ? error.details : undefined, {});
      return true;
    };

    assert.throws(() => executeTaskRequest(database, input, operation), assertInvalidInput);
    assert.equal(calls, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM operation_marker').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_request_receipts').get<{ count: number }>()?.count, 0);

    database.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => executeTaskRequestInTransaction(database, input, operation), assertInvalidInput);
      database.prepare('INSERT INTO operation_marker (value) VALUES (?)').run('outer-write');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM operation_marker').get<{ count: number }>()?.count, 1);
      database.exec('ROLLBACK');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The assertion path may already have rolled the outer transaction back.
      }
      throw error;
    }

    assert.equal(calls, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM operation_marker').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_request_receipts').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('invalid bounds, control characters, timestamps, and non-JSON requests fail without persistence', async () => {
  const database = await setup();
  try {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwingRequest: Record<string, unknown> = {};
    Object.defineProperty(throwingRequest, 'value', {
      enumerable: true,
      get: () => {
        throw new Error('untrusted getter content');
      },
    });
    const invalidInputs: unknown[] = [
      { scope: '', key: 'key', request: {}, createdAt },
      { scope: 'scope', key: '\nkey', request: {}, createdAt },
      { scope: 'scope', key: '\u0085key', request: {}, createdAt },
      { scope: 'scope', key: 'a'.repeat(257), request: {}, createdAt },
      { scope: 'scope', key: 'key', request: undefined, createdAt },
      { scope: 'scope', key: 'key', request: () => 'not-json', createdAt },
      { scope: 'scope', key: 'key', request: 1n, createdAt },
      { scope: 'scope', key: 'key', request: Number.POSITIVE_INFINITY, createdAt },
      { scope: 'scope', key: 'key', request: cyclic, createdAt },
      { scope: 'scope', key: 'key', request: throwingRequest, createdAt },
      { scope: 'scope', key: 'key', request: {}, createdAt: '2026-08-20T00:00:00Z' },
    ];
    let calls = 0;
    for (const input of invalidInputs) {
      assert.throws(
        () => executeTaskRequest(database, input, () => {
          calls += 1;
          return { mustNotRun: true };
        }),
        (error: unknown) => {
          assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
          assert.equal(error instanceof Error && error.message, 'Invalid idempotency input');
          assert.deepEqual(error instanceof Error && 'details' in error ? error.details : undefined, {});
          return true;
        },
      );
    }
    assert.equal(calls, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_request_receipts').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('caller mutation cannot change stored request identity or returned response snapshot', async () => {
  const database = await setup();
  try {
    const request = { nested: { value: 'original' } };
    const response = { nested: { value: 'response-original' } };
    let calls = 0;
    const first = executeTaskRequest(
      database,
      { scope: 'mutation-scope', key: 'mutation-key', request, createdAt },
      () => {
        calls += 1;
        return response;
      },
    );

    request.nested.value = 'request-mutated';
    response.nested.value = 'response-mutated';
    const replay = executeTaskRequest(
      database,
      { scope: 'mutation-scope', key: 'mutation-key', request: { nested: { value: 'original' } }, createdAt },
      () => {
        calls += 1;
        return { shouldNotRun: true };
      },
    );

    assert.deepEqual(first, { nested: { value: 'response-original' } });
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
  } finally {
    database.close();
  }
});

test('operation errors roll back operation writes and the idempotency row while preserving the original error', async () => {
  const database = await setup();
  try {
    const expected = new KiokukoError('DATABASE_ERROR', 'typed operation failure', { marker: 'safe' });
    assert.throws(
      () => executeTaskRequest(
        database,
        { scope: 'failure-scope', key: 'failure-key', request: { value: 1 }, createdAt },
        () => {
          database.exec('CREATE TABLE operation_marker (value TEXT NOT NULL)');
          database.prepare('INSERT INTO operation_marker (value) VALUES (?)').run('side-effect');
          throw expected;
        },
      ),
      (error: unknown) => error === expected,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_request_receipts').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operation_marker'").get(), undefined);
  } finally {
    database.close();
  }
});

test('non-JSON operation responses are rejected and leave no idempotency row', async () => {
  const database = await setup();
  try {
    let calls = 0;
    assert.throws(
      () => executeTaskRequest(
        database,
        { scope: 'response-scope', key: 'response-key', request: {}, createdAt },
        () => {
          calls += 1;
          return undefined as never;
        },
      ),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Invalid idempotency response');
        assert.deepEqual(error instanceof Error && 'details' in error ? error.details : undefined, {});
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_request_receipts').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('operation responses with non-canonical enumerable array keys are rejected and rolled back', async () => {
  const database = await setup();
  try {
    database.exec('CREATE TABLE operation_response_marker (value TEXT NOT NULL)');
    const malformedResponse = { events: ['ordinary-event'] };
    Object.defineProperty(malformedResponse.events, '01', {
      configurable: true,
      enumerable: true,
      value: 'response-array-sentinel',
      writable: true,
    });
    let calls = 0;
    assert.throws(
      () => executeTaskRequest(
        database,
        { scope: 'response-array-scope', key: 'response-array-key', request: {}, createdAt },
        () => {
          calls += 1;
          database.prepare('INSERT INTO operation_response_marker (value) VALUES (?)').run('callback-side-effect');
          return malformedResponse as never;
        },
      ),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Invalid idempotency response');
        assert.deepEqual(error instanceof Error && 'details' in error ? error.details : undefined, {});
        assert.equal(String(error).includes('response-array-sentinel'), false);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM operation_response_marker').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_request_receipts').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('caller-owned execution preserves the outer transaction and rolls back with it', async () => {
  const database = await setup();
  const originalExec = database.exec.bind(database);
  const statements: string[] = [];
  database.exec = (sql: string) => {
    statements.push(sql);
    originalExec(sql);
  };
  try {
    originalExec('BEGIN IMMEDIATE');
    const beforePrimitive = statements.length;
    const result = executeTaskRequestInTransaction(
      database,
      { scope: 'outer-scope', key: 'outer-key', request: { value: 1 }, createdAt },
      () => {
        database.exec('CREATE TABLE outer_marker (value TEXT NOT NULL)');
        database.prepare('INSERT INTO outer_marker (value) VALUES (?)').run('outer-write');
        return { accepted: true };
      },
    );

    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(statements.slice(beforePrimitive), ['CREATE TABLE outer_marker (value TEXT NOT NULL)']);
    originalExec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_request_receipts').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outer_marker'").get(), undefined);
  } finally {
    try {
      originalExec('ROLLBACK');
    } catch {
      // The assertion path may already have rolled the outer transaction back.
    }
    database.close();
  }
});

test('caller-owned replay and conflict leave existing outer writes untouched', async () => {
  const database = await setup();
  try {
    database.exec('BEGIN IMMEDIATE');
    database.exec('CREATE TABLE outer_existing (value TEXT NOT NULL)');
    database.prepare('INSERT INTO outer_existing (value) VALUES (?)').run('keep-me');
    executeTaskRequestInTransaction(
      database,
      { scope: 'outer-preserve', key: 'outer-preserve-key', request: { value: 'first' }, createdAt },
      () => ({ accepted: true }),
    );

    assert.deepEqual(
      executeTaskRequestInTransaction(
        database,
        { scope: 'outer-preserve', key: 'outer-preserve-key', request: { value: 'first' }, createdAt },
        () => {
          throw new Error('replay must not run');
        },
      ),
      { accepted: true },
    );
    assert.throws(
      () => executeTaskRequestInTransaction(
        database,
        { scope: 'outer-preserve', key: 'outer-preserve-key', request: { value: 'second' }, createdAt },
        () => ({ mustNotRun: true }),
      ),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
    );
    assert.equal(database.prepare('SELECT value FROM outer_existing').get<{ value: string }>()?.value, 'keep-me');
    database.exec('ROLLBACK');
  } finally {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The assertion path may already have rolled the outer transaction back.
    }
    database.close();
  }
});

test('corrupt persisted response or hashes fail closed without leaking stored content', async () => {
  const corruptions: Array<{ column: 'response_json' | 'request_hash' | 'key_hash'; value: string }> = [
    { column: 'response_json', value: 'raw-corrupt-response' },
    { column: 'request_hash', value: 'not-a-sha256-hash' },
    { column: 'key_hash', value: 'not-a-sha256-hash' },
  ];
  for (const corruption of corruptions) {
    const database = await setup();
    try {
      executeTaskRequest(
        database,
        { scope: 'integrity-scope', key: 'integrity-key', request: { value: 1 }, createdAt },
        () => ({ accepted: true }),
      );
      database.exec('PRAGMA ignore_check_constraints = ON');
      database.prepare(`UPDATE task_request_receipts SET ${corruption.column} = ?`).run(corruption.value);
      database.exec('PRAGMA ignore_check_constraints = OFF');
      let calls = 0;
      assert.throws(
        () => executeTaskRequest(
          database,
          { scope: 'integrity-scope', key: 'integrity-key', request: { value: 1 }, createdAt },
          () => {
            calls += 1;
            return { shouldNotRun: true };
          },
        ),
        (error: unknown) => {
          assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
          assert.equal(error instanceof Error && error.message, 'Stored idempotency record is invalid');
          assert.deepEqual(error instanceof Error && 'details' in error ? error.details : undefined, {});
          assert.equal(String(error).includes(corruption.value), false);
          return true;
        },
      );
      assert.equal(calls, 0);
    } finally {
      database.close();
    }
  }
});

test('concurrent same-key executions produce one side effect and equivalent responses', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-server-idempotency-concurrency-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database, migrationsDirectory);
  database.exec('CREATE TABLE side_effects (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
  database.close();

  const script = `
    import { openConnection } from './src/db/connection.ts';
    import { executeTaskRequest } from './src/task-run/idempotency.ts';
    const database = openConnection(process.env.KIOKUKO_DATABASE);
    try {
      const result = executeTaskRequest(
        database,
        { scope: 'concurrent-scope', key: 'concurrent-key', request: { value: 1 }, createdAt: '2026-08-20T00:00:00.000Z' },
        () => {
          database.prepare('INSERT INTO side_effects (value) VALUES (?)').run('winner');
          return { accepted: true };
        },
      );
      process.stdout.write(JSON.stringify(result));
    } finally {
      database.close();
    }
  `;
  const environment = { ...process.env, KIOKUKO_DATABASE: databasePath };
  const results = await Promise.all([
    execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: repositoryRoot, env: environment }),
    execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: repositoryRoot, env: environment }),
  ]);

  const reopened = openConnection(databasePath);
  try {
    assert.deepEqual(results.map(({ stdout }) => JSON.parse(stdout)), [{ accepted: true }, { accepted: true }]);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM side_effects').get<{ count: number }>()?.count, 1);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM task_request_receipts').get<{ count: number }>()?.count, 1);
    let calls = 0;
    assert.throws(
      () => executeTaskRequest(
        reopened,
        { scope: 'concurrent-scope', key: 'concurrent-key', request: { value: 2 }, createdAt },
        () => {
          calls += 1;
          return { shouldNotRun: true };
        },
      ),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
    );
    assert.equal(calls, 0);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM side_effects').get<{ count: number }>()?.count, 1);
  } finally {
    reopened.close();
  }
});
