import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireInstanceLock,
  isPidAlive,
  releaseInstanceLock,
  type InstanceLockOptions,
} from '../../src/server/instance-lock.js';
import { initializeDatabase } from '../../src/commands/init.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import {
  createRuntimeDescriptor,
  readRuntimeDescriptor,
  removeRuntimeDescriptor,
  toPublicRuntimeDescriptor,
  writeRuntimeDescriptor,
} from '../../src/server/runtime-descriptor.js';
import { startHttpServer, type HttpApplicationContext } from '../../src/server/http.js';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('treats EPERM as live and ESRCH as stale for PID liveness', async () => {
  const originalKill = process.kill;
  try {
    process.kill = ((pid: number) => {
      const error = new Error('synthetic process state') as NodeJS.ErrnoException;
      error.code = pid === 111 ? 'EPERM' : 'ESRCH';
      throw error;
    }) as typeof process.kill;
    assert.equal(await isPidAlive(111), true);
    assert.equal(await isPidAlive(222), false);
  } finally {
    process.kill = originalKill;
  }
});

test('allows only one live instance lock per database', async () => {
  const directory = await temp('instance-lock-live');
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const first = await acquireInstanceLock(databasePath, {
    runtimeDirectory: directory,
    pid: process.pid,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
  });

  try {
    await assert.rejects(
      () => acquireInstanceLock(databasePath, {
        runtimeDirectory: directory,
        pid: process.pid,
        instanceId: '123e4567-e89b-12d3-a456-426614174001',
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
    );
  } finally {
    await first.release();
  }
});

test('writes instance locks with exact POSIX mode 0600', async () => {
  const directory = await temp('instance-lock-mode');
  const previousUmask = process.umask(0o777);
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>> | undefined;
  try {
    lock = await acquireInstanceLock(path.join(directory, 'kiokuko-ai.sqlite'), {
      runtimeDirectory: directory,
      pid: process.pid,
      instanceId: '123e4567-e89b-12d3-a456-426614174000',
    });
  } finally {
    process.umask(previousUmask);
  }
  try {
    assert.equal((await stat(lock.path)).mode & 0o777, 0o600);
  } finally {
    await lock.release();
  }
});

test('does not release a lock owned by another instance', async () => {
  const directory = await temp('instance-lock-owner-mismatch');
  const lock = await acquireInstanceLock(path.join(directory, 'kiokuko-ai.sqlite'), {
    runtimeDirectory: directory,
    pid: process.pid,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
  });
  assert.equal(
    await releaseInstanceLock(lock.path, '123e4567-e89b-12d3-a456-426614174001'),
    false,
  );
  assert.equal(await lock.release(), true);
});

test('concurrent acquisition has exactly one winner', async () => {
  const directory = await temp('instance-lock-concurrent');
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) => acquireInstanceLock(databasePath, {
      runtimeDirectory: directory,
      pid: process.pid,
      instanceId: `123e4567-e89b-12d3-a456-42661417400${index}`,
    })),
  );
  const winners = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : []);
  assert.equal(winners.length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 7);
  await winners[0]?.release();
});

test('replaces a lock whose PID is stale', async () => {
  const directory = await temp('instance-lock-stale');
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const stale = await acquireInstanceLock(databasePath, {
    runtimeDirectory: directory,
    pid: 999999,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
  });

  const replacement = await acquireInstanceLock(databasePath, {
    runtimeDirectory: directory,
    pid: process.pid,
    instanceId: '123e4567-e89b-12d3-a456-426614174001',
    isPidAlive: () => false,
  });
  assert.equal(replacement.instanceId, '123e4567-e89b-12d3-a456-426614174001');
  await replacement.release();
  assert.equal(await stale.release(), false);
});

test('rejects unknown runtime descriptor fields without exposing content', async () => {
  const directory = await temp('runtime-descriptor-unknown');
  const descriptorPath = path.join(directory, 'server.json');
  await writeFile(descriptorPath, JSON.stringify({
    protocolVersion: '1',
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    pid: 1234,
    baseUrl: 'http://127.0.0.1:49152',
    databaseFingerprint: `sha256:${'a'.repeat(64)}`,
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'b'.repeat(64),
    unexpected: 'descriptor-content',
  }), { mode: 0o600 });

  await assert.rejects(
    () => readRuntimeDescriptor(descriptorPath),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
      assert.equal(error instanceof Error && error.message.includes('descriptor-content'), false);
      return true;
    },
  );
});

test('rejects malformed required runtime descriptor fields', async () => {
  const cases: Array<[string, unknown]> = [
    ['protocolVersion', '2'],
    ['instanceId', 'not-an-instance-id'],
    ['pid', 0],
    ['baseUrl', 'https://127.0.0.1:49152'],
    ['databaseFingerprint', 'sha256:invalid'],
    ['startedAt', '2026-08-20T07:00:00Z'],
    ['capabilityToken', 'b'.repeat(63)],
  ];
  for (const [field, value] of cases) {
    const directory = await temp(`runtime-descriptor-${field}`);
    const descriptorPath = path.join(directory, 'server.json');
    const descriptor: Record<string, unknown> = {
      protocolVersion: '1',
      instanceId: '123e4567-e89b-12d3-a456-426614174000',
      pid: 1234,
      baseUrl: 'http://127.0.0.1:49152',
      databaseFingerprint: `sha256:${'a'.repeat(64)}`,
      startedAt: '2026-08-20T07:00:00.000Z',
      capabilityToken: 'b'.repeat(64),
    };
    descriptor[field] = value;
    await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
    await assert.rejects(
      () => readRuntimeDescriptor(descriptorPath),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('rejects a runtime descriptor with insecure POSIX permissions', async () => {
  const directory = await temp('runtime-descriptor-insecure-mode');
  const descriptorPath = path.join(directory, 'server.json');
  await writeFile(descriptorPath, JSON.stringify({
    protocolVersion: '1',
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    pid: 1234,
    baseUrl: 'http://127.0.0.1:49152',
    databaseFingerprint: `sha256:${'a'.repeat(64)}`,
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'b'.repeat(64),
  }), { mode: 0o644 });

  await assert.rejects(
    () => readRuntimeDescriptor(descriptorPath),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SECURITY_REJECTION',
  );
});

test('returns undefined when the runtime descriptor is missing', async () => {
  const directory = await temp('runtime-descriptor-missing');
  assert.equal(await readRuntimeDescriptor(path.join(directory, 'server.json')), undefined);
});

test('rejects invalid descriptor input at creation', () => {
  assert.throws(
    () => createRuntimeDescriptor({
      databasePath: '/tmp/kiokuko-ai.sqlite',
      baseUrl: 'http://example.com:49152',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
  );
});

test('writes runtime descriptors with exact POSIX mode 0600', async () => {
  const directory = await temp('runtime-descriptor-mode');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
  });
  const previousUmask = process.umask(0o777);
  try {
    await writeRuntimeDescriptor(descriptorPath, descriptor);
  } finally {
    process.umask(previousUmask);
  }
  assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
});

test('rejects malformed runtime descriptor JSON without exposing content', async () => {
  const directory = await temp('runtime-descriptor-json');
  const descriptorPath = path.join(directory, 'server.json');
  await writeFile(descriptorPath, '{"secret-content":', { mode: 0o600 });

  await assert.rejects(
    () => readRuntimeDescriptor(descriptorPath),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
      assert.equal(error instanceof Error && error.message.includes('secret-content'), false);
      return true;
    },
  );
});

test('rejects a symlinked runtime descriptor', async () => {
  const directory = await temp('runtime-descriptor-symlink');
  const realPath = path.join(directory, 'real.json');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
  });
  await writeRuntimeDescriptor(realPath, descriptor);
  await symlink(realPath, descriptorPath);

  await assert.rejects(
    () => readRuntimeDescriptor(descriptorPath),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SECURITY_REJECTION',
  );
});

test('does not remove a runtime descriptor owned by another instance', async () => {
  const directory = await temp('runtime-descriptor-owner-mismatch');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
  });
  await writeRuntimeDescriptor(descriptorPath, descriptor);

  assert.equal(
    await removeRuntimeDescriptor(descriptorPath, '123e4567-e89b-12d3-a456-426614174001'),
    false,
  );
  assert.ok(await readRuntimeDescriptor(descriptorPath));
});

test('removes a runtime descriptor only for its owner', async () => {
  const directory = await temp('runtime-descriptor-owner');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
  });
  await writeRuntimeDescriptor(descriptorPath, descriptor);

  assert.equal(await removeRuntimeDescriptor(descriptorPath, descriptor.instanceId), true);
  assert.equal(await readRuntimeDescriptor(descriptorPath), undefined);
});

test('refuses to replace a symlinked runtime descriptor', async () => {
  const directory = await temp('runtime-descriptor-write-symlink');
  const realPath = path.join(directory, 'real.json');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
  });
  await writeRuntimeDescriptor(realPath, descriptor);
  await symlink(realPath, descriptorPath);

  await assert.rejects(
    () => writeRuntimeDescriptor(descriptorPath, descriptor),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SECURITY_REJECTION',
  );
});

test('public runtime status excludes the capability token', () => {
  const descriptor = createRuntimeDescriptor({
    databasePath: '/tmp/kiokuko-ai.sqlite',
    baseUrl: 'http://127.0.0.1:49152',
    pid: 1234,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    startedAt: '2026-08-20T07:00:00.000Z',
  });
  const view = toPublicRuntimeDescriptor(descriptor);

  assert.equal('capabilityToken' in view, false);
  assert.equal(view.instanceId, descriptor.instanceId);
  assert.equal(view.pid, descriptor.pid);
});

test('writes and reads a strict runtime descriptor', async () => {
  const directory = await temp('runtime-descriptor');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 1234,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    startedAt: '2026-08-20T07:00:00.000Z',
  });

  await writeRuntimeDescriptor(descriptorPath, descriptor);
  const read = await readRuntimeDescriptor(descriptorPath);

  assert.ok(read);
  assert.equal(read.protocolVersion, '1');
  assert.equal(read.instanceId, descriptor.instanceId);
  assert.equal(read.pid, 1234);
  assert.equal(read.baseUrl, descriptor.baseUrl);
  assert.equal(read.databaseFingerprint, descriptor.databaseFingerprint);
  assert.equal(read.startedAt, descriptor.startedAt);
  assert.equal(read.capabilityToken === descriptor.capabilityToken, true);
});

test('validates loopback host and integer port before filesystem, database, or listen side effects', async () => {
  let opened = 0;
  let created = 0;
  const options = {
    databasePath: '/tmp/kiokuko-runtime-validation.sqlite3',
    descriptorPath: '/tmp/kiokuko-runtime-validation-server.json',
    openDatabase: () => {
      opened += 1;
      throw new Error('database must not open');
    },
    createServer: () => {
      created += 1;
      throw new Error('server must not be created');
    },
  };

  for (const invalid of [
    { host: '0.0.0.0' },
    { host: '192.168.1.10' },
    { port: -1 },
    { port: 65536 },
    { port: 1.5 },
  ]) {
    await assert.rejects(
      () => startHttpServer({ ...options, ...invalid }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(opened, 0);
  assert.equal(created, 0);
});

test('starts one process-lifetime database, queue, lock, server, and actual-port descriptor', async () => {
  const directory = await temp('http-runtime-start');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const instanceId = '123e4567-e89b-12d3-a456-426614174100';
  const capabilityToken = 'c'.repeat(64);
  let opened = 0;
  let initializedBeforeOpen = false;
  let closed = 0;
  let acquired = 0;
  let released = 0;

  const handle = await startHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath,
    instanceId,
    capabilityToken,
    openDatabase: () => {
      opened += 1;
      const primary = openConnection(databasePath);
      initializedBeforeOpen = Boolean(primary.prepare(`
        SELECT 1 AS present
          FROM sqlite_master
         WHERE type = 'table' AND name = 'schema_migrations'
      `).get()) && primary.prepare('PRAGMA journal_mode').get()?.journal_mode === 'wal';
      return {
        filePath: primary.filePath,
        exec: primary.exec.bind(primary),
        prepare: primary.prepare.bind(primary),
        close: () => {
          closed += 1;
          primary.close();
        },
      } satisfies SqliteDatabase;
    },
    acquireInstanceLock: async (databaseFile: string, lockOptions: InstanceLockOptions) => {
      acquired += 1;
      const lock = await acquireInstanceLock(databaseFile, lockOptions);
      return {
        ...lock,
        release: async () => {
          released += 1;
          return lock.release();
        },
      };
    },
  });

  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(new URL(handle.url).port, '0');
    assert.deepEqual(handle.queueState, { accepting: true, running: false, waiting: 0 });
    assert.equal('capabilityToken' in handle.descriptor, false);
    assert.equal('capabilityToken' in handle.runtimeDescriptor, false);
    assert.equal(opened, 1);
    assert.equal(initializedBeforeOpen, true);
    assert.equal(acquired, 1);
    assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
    assert.equal((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')).length, 1);
  } finally {
    await handle.close();
  }

  assert.equal(closed, 1);
  assert.equal(released, 1);
  await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
  assert.deepEqual((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')), []);
});

test('composes a factory listener with the runtime-owned database and write queue', async () => {
  const directory = await temp('http-runtime-application-factory');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const capabilityToken = '6'.repeat(64);
  const events: string[] = [];
  const writeOrder: string[] = [];
  const firstWrite = deferred<void>();
  const secondWrite = deferred<void>();
  const firstFactoryWriteStarted = deferred<void>();
  const secondFactoryWriteStarted = deferred<void>();
  let opened = 0;
  let initialized = 0;
  let closed = 0;
  let factoryCalls = 0;
  let openedAdapter: SqliteDatabase | undefined;
  let factoryContext: HttpApplicationContext | undefined;
  let factoryWriteNumber = 0;
  const writeGates = [firstWrite, secondWrite];

  const handle = await startHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath,
    instanceId: '123e4567-e89b-12d3-a456-426614174111',
    capabilityToken,
    queueCapacity: 1,
    initializeDatabase: async (options) => {
      initialized += 1;
      events.push('initialize');
      await initializeDatabase(options);
    },
    openDatabase: () => {
      opened += 1;
      const primary = openConnection(databasePath);
      const adapter: SqliteDatabase = {
        filePath: primary.filePath,
        exec: primary.exec.bind(primary),
        prepare: primary.prepare.bind(primary),
        close: () => {
          closed += 1;
          primary.close();
        },
      };
      openedAdapter = adapter;
      events.push('open');
      return adapter;
    },
    createServer: (listener: RequestListener) => {
      events.push('create-server');
      const server = createServer(listener);
      server.once('listening', () => events.push('listen'));
      return server;
    },
    applicationFactory: (context) => {
      factoryCalls += 1;
      factoryContext = context;
      assert.strictEqual(context.database, openedAdapter);
      events.push('factory');
      const authenticatedApp = context.createAuthenticatedApp();
      return (request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (pathname === '/factory/read') {
          const row = context.database.prepare('SELECT 1 AS value').get<{ value: number }>();
          const body = JSON.stringify(row);
          response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
          response.end(body);
          return;
        }
        if (pathname === '/factory/write') {
          const writeNumber = factoryWriteNumber;
          factoryWriteNumber += 1;
          void context.enqueueWrite(async () => {
            writeOrder.push(`factory-${writeNumber}`);
            if (writeNumber === 0) firstFactoryWriteStarted.resolve();
            if (writeNumber === 1) secondFactoryWriteStarted.resolve();
            await writeGates[writeNumber]?.promise;
            return `factory-${writeNumber}`;
          }).then(
            (value) => {
              const body = JSON.stringify({ value });
              response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
              response.end(body);
            },
            () => {
              response.writeHead(503);
              response.end();
            },
          );
          return;
        }
        authenticatedApp(request, response);
      };
    },
  });

  let secondClose: Promise<void> | undefined;
  try {
    assert.equal(factoryCalls, 1);
    assert.equal(opened, 1);
    assert.equal(initialized, 1);
    assert.equal(events.indexOf('initialize') < events.indexOf('open'), true);
    assert.equal(events.indexOf('open') < events.indexOf('factory'), true);
    assert.equal(events.indexOf('factory') < events.indexOf('listen'), true);
    assert.equal('applicationFactory' in handle, false);
    assert.equal('database' in handle, false);
    assert.equal('createAuthenticatedApp' in handle, false);
    const serializedHandle = JSON.stringify(handle);
    assert.equal(serializedHandle.includes(capabilityToken), false);
    assert.equal(JSON.stringify(handle.descriptor).includes(capabilityToken), false);
    assert.equal(JSON.stringify(handle.runtimeDescriptor).includes(capabilityToken), false);

    const readResponse = await fetch(`${handle.url}/factory/read`);
    assert.equal(readResponse.status, 200);
    assert.deepEqual(await readResponse.json(), { value: 1 });
    const readyResponse = await fetch(`${handle.url}/health/ready`, {
      headers: { authorization: `Bearer ${capabilityToken}` },
    });
    assert.equal(readyResponse.status, 200);
    assert.equal(opened, 1);

    const factoryWriteResponse = fetch(`${handle.url}/factory/write`);
    await firstFactoryWriteStarted.promise;
    const publicWrite = handle.enqueueWrite(async () => {
      writeOrder.push('public');
      return 'public';
    });
    assert.deepEqual(handle.queueState, { accepting: true, running: true, waiting: 1 });
    assert.ok(factoryContext);
    await assert.rejects(
      factoryContext.enqueueWrite(async () => 'over-capacity'),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BACKPRESSURE',
    );
    firstWrite.resolve();
    assert.equal((await (await factoryWriteResponse).json()).value, 'factory-0');
    assert.equal(await publicWrite, 'public');
    assert.deepEqual(writeOrder, ['factory-0', 'public']);

    const secondFactoryWriteResponse = fetch(`${handle.url}/factory/write`);
    await secondFactoryWriteStarted.promise;
    secondClose = handle.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, 0);
    assert.equal((await stat(descriptorPath)).isFile(), true);
    secondWrite.resolve();
    assert.equal((await (await secondFactoryWriteResponse).json()).value, 'factory-1');
    await secondClose;
    assert.equal(closed, 1);
    await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
    assert.deepEqual((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')), []);
  } finally {
    firstWrite.resolve();
    secondWrite.resolve();
    await secondClose?.catch(() => undefined);
    if (closed === 0) await handle.close().catch(() => undefined);
  }
});

test('rolls back the database and lock when the application factory throws a safe startup error', async () => {
  const directory = await temp('http-runtime-application-factory-failure');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const capabilityToken = '7'.repeat(64);
  const rawFactoryError = `factory secret ${capabilityToken}`;
  let databaseClosed = 0;
  let factoryCalls = 0;
  let serverCreated = 0;

  await assert.rejects(
    () => startHttpServer({
      databasePath,
      runtimeDirectory,
      descriptorPath,
      instanceId: '123e4567-e89b-12d3-a456-426614174112',
      capabilityToken,
      openDatabase: () => ({
        filePath: databasePath,
        exec: () => undefined,
        prepare: () => { throw new Error('not used by this test'); },
        close: () => {
          databaseClosed += 1;
        },
      }),
      initializeDatabase: () => undefined,
      createServer: () => {
        serverCreated += 1;
        throw new Error('listener must not be created');
      },
      applicationFactory: () => {
        factoryCalls += 1;
        throw new Error(rawFactoryError);
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'DATABASE_ERROR', true);
      assert.equal(error instanceof Error && error.message, 'Unable to start the HTTP server');
      assert.equal(String(error).includes(rawFactoryError), false);
      assert.equal(String(error).includes(capabilityToken), false);
      return true;
    },
  );

  assert.equal(factoryCalls, 1);
  assert.equal(databaseClosed, 1);
  assert.equal(serverCreated, 0);
  assert.deepEqual((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')), []);
  await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
});

test('rejects conflicting application factory combinations before side effects', async () => {
  const directory = await temp('http-runtime-application-factory-validation');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  let acquired = 0;
  let opened = 0;
  let serverCreated = 0;
  const baseOptions = {
    databasePath,
    runtimeDirectory,
    descriptorPath,
    applicationFactory: () => () => undefined,
    acquireInstanceLock: async () => {
      acquired += 1;
      throw new Error('lock must not be acquired');
    },
    openDatabase: () => {
      opened += 1;
      throw new Error('database must not open');
    },
    createServer: () => {
      serverCreated += 1;
      throw new Error('server must not be created');
    },
  };

  for (const incompatible of [{ app: () => undefined }]) {
    await assert.rejects(
      () => startHttpServer({ ...baseOptions, ...incompatible }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'applicationFactory cannot be combined with app');
        return true;
      },
    );
  }

  assert.equal(acquired, 0);
  assert.equal(opened, 0);
  assert.equal(serverCreated, 0);
  await assert.rejects(() => readdir(runtimeDirectory), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
});

test('rejects a live descriptor without opening the database or overwriting the owner file', async () => {
  const directory = await temp('http-runtime-live-descriptor');
  const descriptorPath = path.join(directory, 'runtime', 'server.json');
  const databasePath = path.join(directory, 'data.sqlite3');
  const existing = createRuntimeDescriptor({
    databasePath,
    baseUrl: 'http://127.0.0.1:49152',
    pid: 4242,
    instanceId: '123e4567-e89b-12d3-a456-426614174103',
    capabilityToken: 'f'.repeat(64),
    startedAt: '2026-08-20T07:00:00.000Z',
  });
  await writeRuntimeDescriptor(descriptorPath, existing);
  let opened = 0;

  await assert.rejects(
    () => startHttpServer({
      databasePath,
      runtimeDirectory: path.dirname(descriptorPath),
      descriptorPath,
      openDatabase: () => {
        opened += 1;
        throw new Error('database must not open');
      },
      isPidAlive: () => true,
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
  assert.equal(opened, 0);
  const after = await readRuntimeDescriptor(descriptorPath);
  assert.equal(after?.instanceId, existing.instanceId);
});

test('replaces a stale descriptor using injected PID liveness and removes only the replacement on close', async () => {
  const directory = await temp('http-runtime-stale-descriptor');
  const descriptorPath = path.join(directory, 'runtime', 'server.json');
  const databasePath = path.join(directory, 'data.sqlite3');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath,
    baseUrl: 'http://127.0.0.1:49152',
    pid: 4242,
    instanceId: '123e4567-e89b-12d3-a456-426614174104',
    capabilityToken: 'a'.repeat(64),
    startedAt: '2026-08-20T07:00:00.000Z',
  }));
  const instanceId = '123e4567-e89b-12d3-a456-426614174105';
  const handle = await startHttpServer({
    databasePath,
    runtimeDirectory: path.dirname(descriptorPath),
    descriptorPath,
    instanceId,
    capabilityToken: 'b'.repeat(64),
    isPidAlive: () => false,
    openDatabase: () => ({
      filePath: databasePath,
      exec: () => undefined,
      prepare: () => { throw new Error('not used by this runtime test'); },
      close: () => undefined,
    }),
    initializeDatabase: () => undefined,
  });
  try {
    const replacement = await readRuntimeDescriptor(descriptorPath);
    assert.equal(replacement?.instanceId, instanceId);
    assert.equal('capabilityToken' in handle.descriptor, false);
  } finally {
    await handle.close();
  }
  assert.equal(await readRuntimeDescriptor(descriptorPath), undefined);
});

test('rejects a second server for the same database before opening its primary adapter', async () => {
  const directory = await temp('http-runtime-conflict');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  let secondOpened = 0;
  const database = (close: () => void): SqliteDatabase => ({
    filePath: databasePath,
    exec: () => undefined,
    prepare: () => { throw new Error('not used by this runtime test'); },
    close,
  });
  const first = await startHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server-first.json'),
    instanceId: '123e4567-e89b-12d3-a456-426614174106',
    capabilityToken: '1'.repeat(64),
    openDatabase: () => database(() => undefined),
    initializeDatabase: () => undefined,
  });
  try {
    await assert.rejects(
      () => startHttpServer({
        databasePath,
        runtimeDirectory,
        descriptorPath: path.join(runtimeDirectory, 'server-second.json'),
        instanceId: '123e4567-e89b-12d3-a456-426614174107',
        capabilityToken: '2'.repeat(64),
        openDatabase: () => {
          secondOpened += 1;
          return database(() => undefined);
        },
        initializeDatabase: () => undefined,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
    );
    assert.equal(secondOpened, 0);
  } finally {
    await first.close();
  }
});

test('rolls back an acquired lock when opening the primary database fails', async () => {
  const directory = await temp('http-runtime-db-failure');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const databasePath = path.join(directory, 'data.sqlite3');
  let opened = 0;

  await assert.rejects(
    () => startHttpServer({
      databasePath,
      runtimeDirectory,
      descriptorPath,
      instanceId: '123e4567-e89b-12d3-a456-426614174108',
      capabilityToken: '3'.repeat(64),
      openDatabase: () => {
        opened += 1;
        throw new Error('synthetic database failure');
      },
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'DATABASE_ERROR',
  );
  assert.equal(opened, 1);
  assert.deepEqual((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')), []);
  await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
});

test('rolls back the server, database, lock, and descriptor ownership when descriptor writing fails', async () => {
  const directory = await temp('http-runtime-descriptor-failure');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const databasePath = path.join(directory, 'data.sqlite3');
  let databaseClosed = 0;
  let serverClosed = 0;
  const database: SqliteDatabase = {
    filePath: databasePath,
    exec: () => undefined,
    prepare: () => { throw new Error('not used by this runtime test'); },
    close: () => {
      databaseClosed += 1;
    },
  };

  await assert.rejects(
    () => startHttpServer({
      databasePath,
      runtimeDirectory,
      descriptorPath,
      instanceId: '123e4567-e89b-12d3-a456-426614174109',
      capabilityToken: '4'.repeat(64),
      openDatabase: () => database,
      initializeDatabase: () => undefined,
      createServer: (listener: RequestListener) => {
        const server = createServer(listener);
        server.once('close', () => {
          serverClosed += 1;
        });
        return server;
      },
      writeRuntimeDescriptor: () => {
        throw new Error('synthetic descriptor failure');
      },
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'DATABASE_ERROR',
  );
  assert.equal(databaseClosed, 1);
  assert.equal(serverClosed, 1);
  assert.deepEqual((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')), []);
  await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
});

test('startup reports every cleanup failure without exposing raw causes', async () => {
  const directory = await temp('http-runtime-startup-cleanup-failures');
  const databasePath = path.join(directory, 'data.sqlite3');
  const descriptorPath = path.join(directory, 'runtime', 'server.json');
  const instanceId = '123e4567-e89b-12d3-a456-426614174199';
  const rawSentinels = [
    'descriptor-write-private-sentinel',
    'database-close-private-sentinel',
    'descriptor-remove-private-sentinel',
    'lock-release-private-sentinel',
  ];
  let serverClosed = 0;
  let databaseCloseAttempts = 0;
  let descriptorRemoveAttempts = 0;
  let lockReleaseAttempts = 0;

  await assert.rejects(
    () => startHttpServer({
      databasePath,
      descriptorPath,
      instanceId,
      capabilityToken: '8'.repeat(64),
      initializeDatabase: () => undefined,
      openDatabase: () => ({
        filePath: databasePath,
        exec: () => undefined,
        prepare: () => { throw new Error('not used by this runtime test'); },
        close: () => {
          databaseCloseAttempts += 1;
          throw new Error(rawSentinels[1]);
        },
      }),
      acquireInstanceLock: () => ({
        path: path.join(directory, 'synthetic.lock'),
        instanceId,
        release: async () => {
          lockReleaseAttempts += 1;
          throw new Error(rawSentinels[3]);
        },
      }),
      createServer: (listener: RequestListener) => {
        const server = createServer(listener);
        server.once('close', () => {
          serverClosed += 1;
        });
        return server;
      },
      writeRuntimeDescriptor: () => {
        throw new Error(rawSentinels[0]);
      },
      removeRuntimeDescriptor: () => {
        descriptorRemoveAttempts += 1;
        throw new Error(rawSentinels[2]);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'HTTP server startup failed and resource cleanup also failed');
      assert.equal(error.errors.length, 4);
      for (const failure of error.errors) {
        assert.equal(failure instanceof Error && 'code' in failure && failure.code === 'DATABASE_ERROR', true);
        assert.equal(failure instanceof Error && failure.message, 'Unable to start the HTTP server');
      }
      const exposed = `${error.message}\n${error.errors.map(String).join('\n')}`;
      for (const sentinel of rawSentinels) assert.equal(exposed.includes(sentinel), false);
      return true;
    },
  );

  assert.equal(serverClosed, 1);
  assert.equal(databaseCloseAttempts, 1);
  assert.equal(descriptorRemoveAttempts, 1);
  assert.equal(lockReleaseAttempts, 1);
});

test('rolls back all opened resources when the ephemeral listen fails', async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const port = (blocker.address() as AddressInfo).port;
  const directory = await temp('http-runtime-listen-failure');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const databasePath = path.join(directory, 'data.sqlite3');
  let databaseClosed = 0;
  let serverClosed = 0;
  try {
    await assert.rejects(
      () => startHttpServer({
        databasePath,
        runtimeDirectory,
        descriptorPath,
        port,
        instanceId: '123e4567-e89b-12d3-a456-426614174110',
        capabilityToken: '5'.repeat(64),
        openDatabase: () => ({
          filePath: databasePath,
          exec: () => undefined,
          prepare: () => { throw new Error('not used by this runtime test'); },
          close: () => {
            databaseClosed += 1;
          },
        }),
        initializeDatabase: () => undefined,
        createServer: (listener: RequestListener) => {
          const server = createServer(listener);
          server.once('close', () => {
            serverClosed += 1;
          });
          return server;
        },
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'DATABASE_ERROR',
    );
    assert.equal(databaseClosed, 1);
    assert.equal(serverClosed, 1);
    assert.deepEqual((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')), []);
    await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
  } finally {
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  }
});
