import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setupGlobalClients } from '../../src/commands/setup.js';

test('setup rejects a non-empty database without current migration history before writing config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-setup-unknown-db-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const databasePath = path.join(data, 'kiokuko', 'kiokuko-ai.sqlite');
  await mkdir(home, { recursive: true });
  await mkdir(path.dirname(databasePath), { recursive: true });
  await writeFile(databasePath, Buffer.from('not a sqlite database', 'utf8'));
  const before = await readFile(databasePath);

  await assert.rejects(setupGlobalClients({
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
    databasePath,
  }), (error: unknown) => (error as { code?: string }).code === 'DATABASE_ERROR');

  assert.deepEqual(await readFile(databasePath), before);
  await assert.rejects(readFile(path.join(config, 'opencode', 'opencode.json')));
});
