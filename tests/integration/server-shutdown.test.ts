import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import type { EmbeddingRuntime } from '../../src/embedding/types.js';
import type { EmbeddingWorker } from '../../src/embedding/worker.js';
import { startHttpServer } from '../../src/server/http.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

function fakeDatabase(filePath: string, onClose: () => void): SqliteDatabase {
  return {
    filePath,
    exec: () => undefined,
    prepare: () => {
      throw new Error('not used by this test');
    },
    close: onClose,
  };
}

async function connectRawSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function readRawResponse(socket: Socket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

test('close stops new writes, keeps the descriptor during drain, then closes and removes owned runtime files', async () => {
  const directory = await temp('http-shutdown-drain');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const instanceId = '123e4567-e89b-12d3-a456-426614174101';
  const capabilityToken = 'd'.repeat(64);
  let databaseCloses = 0;
  const handle = await startHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath,
    instanceId,
    capabilityToken,
    openDatabase: () => fakeDatabase(databasePath, () => {
      databaseCloses += 1;
    }),
    initializeDatabase: () => undefined,
  });
  const started = deferred<void>();
  const release = deferred<void>();
  const write = handle.enqueueWrite(async () => {
    started.resolve();
    await release.promise;
    return 'accepted';
  });
  await started.promise;

  const firstClose = handle.close();
  const secondClose = handle.close();
  assert.strictEqual(firstClose, secondClose);
  assert.deepEqual(handle.queueState, { accepting: false, running: true, waiting: 0 });
  assert.equal((await stat(descriptorPath)).isFile(), true);
  await assert.rejects(
    handle.enqueueWrite(async () => 'rejected'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE',
  );
  assert.equal(databaseCloses, 0);
  assert.equal((await stat(descriptorPath)).isFile(), true);

  release.resolve();
  assert.equal(await write, 'accepted');
  await firstClose;
  await secondClose;

  assert.equal(databaseCloses, 1);
  assert.deepEqual(handle.queueState, { accepting: false, running: false, waiting: 0 });
  await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
  assert.deepEqual((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')), []);
});

test('close drains an HTTP request admitted before shutdown even when its body finishes afterward', async () => {
  const directory = await temp('http-shutdown-request-admission');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  const instanceId = '123e4567-e89b-12d3-a456-426614174104';
  const capabilityToken = 'f'.repeat(64);
  const body = JSON.stringify({ probe: true });
  const partialBody = body.slice(0, body.length - 1);
  let databaseCloses = 0;
  let writes = 0;
  let enqueueWrite: ((operation: () => unknown | PromiseLike<unknown>) => Promise<unknown>) | undefined;
  const requestAdmitted = deferred<void>();
  const handlerStarted = deferred<void>();
  const writeStarted = deferred<void>();
  const writeSettled = deferred<void>();
  const releaseWrite = deferred<void>();
  const handle = await startHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath,
    instanceId,
    capabilityToken,
    openDatabase: () => fakeDatabase(databasePath, () => {
      databaseCloses += 1;
    }),
    initializeDatabase: () => undefined,
    v1: async () => {
      handlerStarted.resolve();
      if (enqueueWrite === undefined) throw new Error('enqueueWrite was not initialized');
      await enqueueWrite(async () => {
        writeStarted.resolve();
        await releaseWrite.promise;
        writes += 1;
        writeSettled.resolve();
      });
      return { ok: true };
    },
  });

  let socket: Socket | undefined;
  let closePromise: Promise<void> | undefined;
  let closeSettled = false;
  try {
    enqueueWrite = handle.enqueueWrite.bind(handle);
    handle.server.once('request', () => requestAdmitted.resolve());
    const port = Number(new URL(handle.url).port);
    socket = await connectRawSocket(port);
    const responsePromise = readRawResponse(socket);
    socket.write([
      'POST /api/v1/probe HTTP/1.1',
      'Host: 127.0.0.1',
      `Authorization: Bearer ${capabilityToken}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      partialBody,
    ].join('\r\n'));

    await requestAdmitted.promise;
    closePromise = handle.close();
    closePromise.then(() => {
      closeSettled = true;
    }, () => {
      closeSettled = true;
    });
    assert.deepEqual(handle.queueState, { accepting: true, running: false, waiting: 0 });
    await assert.rejects(
      handle.enqueueWrite(async () => 'public-write-after-close'),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE',
    );
    assert.equal(databaseCloses, 0);
    assert.equal((await stat(descriptorPath)).isFile(), true);

    socket.write(body.slice(partialBody.length));
    await handlerStarted.promise;
    const milestone = await Promise.race([
      writeStarted.promise.then(() => ({ kind: 'write' as const })),
      responsePromise.then((text) => ({ kind: 'response' as const, text })),
    ]);
    if (milestone.kind === 'response') {
      const status = Number.parseInt(/^HTTP\/\d\.\d (\d+)/.exec(milestone.text)?.[1] ?? '', 10);
      assert.equal(status, 200);
      assert.fail('the response completed before the admitted request write drained');
    }
    assert.equal(closeSettled, false);
    assert.equal(writes, 0);
    assert.equal(databaseCloses, 0);
    assert.equal((await stat(descriptorPath)).isFile(), true);

    releaseWrite.resolve();
    await writeSettled.promise;
    assert.equal(writes, 1);
    const responseText = await responsePromise;
    const responseStatus = Number.parseInt(/^HTTP\/\d\.\d (\d+)/.exec(responseText)?.[1] ?? '', 10);
    assert.equal(responseStatus, 200);
    assert.match(responseText, /\"ok\":true/);
    await closePromise;
    assert.equal(closeSettled, true);
    assert.equal(databaseCloses, 1);
    await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
  } finally {
    releaseWrite.resolve();
    socket?.destroy();
    await closePromise?.catch(() => undefined);
  }
});

test('close stops accepting new HTTP connections after accepted work has drained', async () => {
  const directory = await temp('http-shutdown-http');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const handle = await startHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    instanceId: '123e4567-e89b-12d3-a456-426614174102',
    capabilityToken: 'e'.repeat(64),
    openDatabase: () => fakeDatabase(databasePath, () => undefined),
    initializeDatabase: () => undefined,
  });

  const response = await fetch(`${handle.url}/health/live`);
  assert.equal(response.status, 200);
  await handle.close();
  await assert.rejects(() => fetch(`${handle.url}/health/live`));
});

test('close keeps the write queue open while the embedding worker finalizes an aborted job', async () => {
  const directory = await temp('http-shutdown-embedding-worker');
  const databasePath = path.join(directory, 'data.sqlite3');
  const runtimeDirectory = path.join(directory, 'runtime');
  const events: string[] = [];
  let enqueueWrite: ((operation: () => unknown | PromiseLike<unknown>) => Promise<unknown>) | undefined;
  const runtime: EmbeddingRuntime = {
    mode: 'optional',
    profileId: 'a'.repeat(64),
    backendId: null,
    backend: null,
    prepareQuery: async () => null,
    drain: async () => ({ claimed: 1, completed: 0, failed: 0, blocked: 0, remaining: 1 }),
    close: async () => { events.push('runtime-close'); },
  };
  const worker: EmbeddingWorker = {
    get running() {
      return true;
    },
    start: () => { events.push('worker-start'); },
    stop: () => { events.push('worker-stop'); },
    close: async () => {
      events.push('worker-close');
      await runtime.close();
      if (enqueueWrite === undefined) throw new Error('enqueueWrite was not initialized');
      await enqueueWrite(() => { events.push('job-finalize'); });
    },
  };
  const handle = await startHttpServer({
    databasePath,
    runtimeDirectory,
    descriptorPath: path.join(runtimeDirectory, 'server.json'),
    instanceId: '123e4567-e89b-12d3-a456-426614174103',
    capabilityToken: 'b'.repeat(64),
    initializeDatabase: () => undefined,
    openDatabase: () => fakeDatabase(databasePath, () => undefined),
    dependencies: {
      createEmbeddingRuntime: (_database, _config, options) => {
        enqueueWrite = options.enqueueWrite;
        return runtime;
      },
      createEmbeddingWorker: () => worker,
    },
  });

  await handle.close();
  assert.deepEqual(events, ['worker-start', 'worker-stop', 'worker-close', 'runtime-close', 'job-finalize']);
});

test('close aggregates independent cleanup failures and retries only resources that did not close', async () => {
  const directory = await temp('http-shutdown-cleanup-retry');
  const databasePath = path.join(directory, 'data.sqlite3');
  const descriptorPath = path.join(directory, 'runtime', 'server.json');
  const instanceId = '123e4567-e89b-12d3-a456-426614174198';
  const rawSentinels = [
    'database-close-private-sentinel',
    'descriptor-remove-private-sentinel',
    'lock-release-private-sentinel',
  ];
  let databaseCloseAttempts = 0;
  let descriptorRemoveAttempts = 0;
  let lockReleaseAttempts = 0;
  const handle = await startHttpServer({
    databasePath,
    descriptorPath,
    instanceId,
    capabilityToken: '9'.repeat(64),
    initializeDatabase: () => undefined,
    openDatabase: () => fakeDatabase(databasePath, () => {
      databaseCloseAttempts += 1;
      if (databaseCloseAttempts === 1) throw new Error(rawSentinels[0]);
    }),
    acquireInstanceLock: () => ({
      path: path.join(directory, 'synthetic.lock'),
      instanceId,
      release: async () => {
        lockReleaseAttempts += 1;
        if (lockReleaseAttempts === 1) throw new Error(rawSentinels[2]);
        return true;
      },
    }),
    readRuntimeDescriptor: () => undefined,
    writeRuntimeDescriptor: () => undefined,
    removeRuntimeDescriptor: () => {
      descriptorRemoveAttempts += 1;
      if (descriptorRemoveAttempts === 1) throw new Error(rawSentinels[1]);
      return true;
    },
  });

  await assert.rejects(
    handle.close(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'HTTP server resource cleanup failed');
      assert.equal(error.errors.length, 3);
      for (const failure of error.errors) {
        assert.equal(failure instanceof Error && 'code' in failure && failure.code === 'DATABASE_ERROR', true);
        assert.equal(failure instanceof Error && failure.message, 'Unable to close the HTTP server');
      }
      const exposed = `${error.message}\n${error.errors.map(String).join('\n')}`;
      for (const sentinel of rawSentinels) assert.equal(exposed.includes(sentinel), false);
      return true;
    },
  );
  assert.equal(databaseCloseAttempts, 1);
  assert.equal(descriptorRemoveAttempts, 1);
  assert.equal(lockReleaseAttempts, 1);

  await handle.close();
  assert.equal(databaseCloseAttempts, 2);
  assert.equal(descriptorRemoveAttempts, 2);
  assert.equal(lockReleaseAttempts, 2);
});
