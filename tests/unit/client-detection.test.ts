import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectInstalledClients } from '../../src/setup/client-detection.js';

test('detects OpenCode when its executable is on PATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-client-detection-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'opencode');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o755);

  assert.deepEqual(await detectInstalledClients({ platform: 'linux', env: { PATH: bin } }), ['opencode']);
});

test('does not report OpenCode when no supported executable is on PATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-client-detection-none-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'unsupported');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o755);

  assert.deepEqual(await detectInstalledClients({ platform: 'linux', env: { PATH: bin } }), []);
});

test('client detection propagates unexpected filesystem failures', async () => {
  const sentinel = Object.assign(new Error('programmer-bug-sentinel'), { code: 'EIO' });
  await assert.rejects(
    detectInstalledClients({ platform: 'linux', env: { PATH: '/bounded/bin' } }, {
      stat: async () => { throw sentinel; },
    }),
    (error: unknown) => error === sentinel,
  );
});
