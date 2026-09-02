import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import { getServerStatus } from '../../src/commands/server-status.js';
import {
  createRuntimeDescriptor,
  writeRuntimeDescriptor,
} from '../../src/server/runtime-descriptor.js';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

test('returns an exact non-running status for a missing descriptor without probing liveness', async () => {
  const directory = await temp('server-status-missing');
  let livenessCalls = 0;

  const status = await getServerStatus({
    descriptorPath: path.join(directory, 'server.json'),
    isPidAlive: () => {
      livenessCalls += 1;
      return true;
    },
  });

  assert.deepEqual(status, { running: false, stale: false });
  assert.equal(livenessCalls, 0);
});

test('returns a live public descriptor view without exposing its capability token', async () => {
  const directory = await temp('server-status-live');
  const descriptorPath = path.join(directory, 'server.json');
  const capabilityToken = 'c'.repeat(64);
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 3210,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken,
  });
  await writeRuntimeDescriptor(descriptorPath, descriptor);

  const status = await getServerStatus({
    descriptorPath,
    isPidAlive: () => true,
  });

  assert.deepEqual(status, {
    running: true,
    stale: false,
    descriptor: {
      protocolVersion: descriptor.protocolVersion,
      instanceId: descriptor.instanceId,
      pid: descriptor.pid,
      baseUrl: descriptor.baseUrl,
      databaseFingerprint: descriptor.databaseFingerprint,
      startedAt: descriptor.startedAt,
    },
  });

  const containsValue = (value: unknown): boolean => {
    if (value === capabilityToken) return true;
    if (typeof value !== 'object' || value === null) return false;
    return Reflect.ownKeys(value).some((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property !== undefined
        && 'value' in property
        && containsValue(property.value);
    });
  };
  assert.equal(containsValue(status), false);
});

test('reports a dead PID as stale without changing the descriptor file', async () => {
  const directory = await temp('server-status-stale');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 3211,
    instanceId: '123e4567-e89b-12d3-a456-426614174001',
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'd'.repeat(64),
  });
  await writeRuntimeDescriptor(descriptorPath, descriptor);
  const beforeBytes = await readFile(descriptorPath);
  const beforeStat = await stat(descriptorPath);

  const status = await getServerStatus({
    descriptorPath,
    isPidAlive: () => false,
  });

  assert.deepEqual(status, {
    running: false,
    stale: true,
    descriptor: {
      protocolVersion: descriptor.protocolVersion,
      instanceId: descriptor.instanceId,
      pid: descriptor.pid,
      baseUrl: descriptor.baseUrl,
      databaseFingerprint: descriptor.databaseFingerprint,
      startedAt: descriptor.startedAt,
    },
  });

  const afterBytes = await readFile(descriptorPath);
  const afterStat = await stat(descriptorPath);
  assert.deepEqual(afterBytes, beforeBytes);
  assert.equal(afterStat.isFile(), beforeStat.isFile());
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mode, beforeStat.mode);
  assert.equal(afterStat.size, beforeStat.size);
});

test('probes the descriptor PID exactly once and accepts async liveness', async () => {
  const directory = await temp('server-status-liveness');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 4321,
    instanceId: '123e4567-e89b-12d3-a456-426614174002',
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'e'.repeat(64),
  });
  await writeRuntimeDescriptor(descriptorPath, descriptor);
  const probedPids: number[] = [];

  const status = await getServerStatus({
    descriptorPath,
    isPidAlive: async (pid) => {
      probedPids.push(pid);
      return false;
    },
  });

  assert.equal(status.running, false);
  assert.equal(status.stale, true);
  assert.deepEqual(probedPids, [descriptor.pid]);
});

test('wraps unexpected liveness failures as a fixed service-unavailable error', async () => {
  const directory = await temp('server-status-liveness-error');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 5432,
    instanceId: '123e4567-e89b-12d3-a456-426614174003',
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'f'.repeat(64),
  });
  await writeRuntimeDescriptor(descriptorPath, descriptor);

  await assert.rejects(
    () => getServerStatus({
      descriptorPath,
      isPidAlive: () => {
        throw new Error('raw liveness failure detail');
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof KiokukoError, true);
      if (!(error instanceof KiokukoError)) return false;
      assert.equal(error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(error.message, 'Unable to determine server process liveness');
      assert.deepEqual(error.details, {});
      assert.equal(error.message.includes('raw liveness failure detail'), false);
      assert.equal(error.message.includes(String(descriptor.pid)), false);
      return true;
    },
  );
});

test('propagates the typed validation error for malformed descriptor JSON', async () => {
  const directory = await temp('server-status-malformed-json');
  const descriptorPath = path.join(directory, 'server.json');
  await writeFile(descriptorPath, '{"malformed":', { mode: 0o600 });

  await assert.rejects(
    () => getServerStatus({ descriptorPath }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'VALIDATION_ERROR'
      && !error.message.includes('malformed'),
  );
});

test('propagates the typed validation error for unknown descriptor fields', async () => {
  const directory = await temp('server-status-unknown-field');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 6543,
    instanceId: '123e4567-e89b-12d3-a456-426614174004',
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'a'.repeat(64),
  });
  await writeFile(
    descriptorPath,
    JSON.stringify({ ...descriptor, unexpected: 'descriptor-content' }),
    { mode: 0o600 },
  );

  await assert.rejects(
    () => getServerStatus({ descriptorPath }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'VALIDATION_ERROR'
      && !error.message.includes('descriptor-content'),
  );
});

test('propagates the typed security error for a symlinked descriptor', async () => {
  const directory = await temp('server-status-symlink');
  const realPath = path.join(directory, 'real.json');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 7654,
    instanceId: '123e4567-e89b-12d3-a456-426614174005',
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'b'.repeat(64),
  });
  await writeRuntimeDescriptor(realPath, descriptor);
  await symlink(realPath, descriptorPath);

  await assert.rejects(
    () => getServerStatus({ descriptorPath }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'SECURITY_REJECTION',
  );
});

test('propagates the typed security error for a descriptor with broad POSIX mode', async () => {
  if (process.platform === 'win32') return;

  const directory = await temp('server-status-broad-mode');
  const descriptorPath = path.join(directory, 'server.json');
  const descriptor = createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: 8765,
    instanceId: '123e4567-e89b-12d3-a456-426614174006',
    startedAt: '2026-08-20T07:00:00.000Z',
    capabilityToken: 'c'.repeat(64),
  });
  await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o644 });
  await chmod(descriptorPath, 0o644);

  await assert.rejects(
    () => getServerStatus({ descriptorPath }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'SECURITY_REJECTION',
  );
});
