import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import test from 'node:test';
import { setupGlobalClients } from '../../src/commands/setup.js';
import { KIOKUKO_OPENCODE_PLUGIN } from '../../src/setup/opencode-config.js';

async function temporaryEnvironment(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-setup-${prefix}-`));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  await mkdir(home, { recursive: true });
  return {
    config,
    env: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
    databasePath: path.join(data, 'kiokuko', 'kiokuko-ai.sqlite'),
    openCodeConfig: path.join(config, 'opencode', 'opencode.json'),
  };
}

test('setup targets OpenCode only and is idempotent', async () => {
  const temporary = await temporaryEnvironment('opencode');
  const first = await setupGlobalClients({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  assert.deepEqual(first.clients, ['opencode']);
  const config = parse(await readFile(temporary.openCodeConfig, 'utf8')) as {
    plugin: string[];
    mcp: { kiokuko: { command: string[] } };
  };
  assert.deepEqual(config.plugin, [KIOKUKO_OPENCODE_PLUGIN]);
  assert.deepEqual(config.mcp.kiokuko.command, ['kiokuko-ai', 'mcp']);
  const second = await setupGlobalClients({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  assert.equal(second.files.some((file) => file.action !== 'unchanged'), false);
});
test('setup dry-run does not write config or database', async () => {
  const temporary = await temporaryEnvironment('dry-run');
  const result = await setupGlobalClients({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  await assert.rejects(readFile(temporary.openCodeConfig));
  await assert.rejects(readFile(temporary.databasePath));
});

test('setup preserves unknown OpenCode plugin entries', async () => {
  const temporary = await temporaryEnvironment('unknown-plugin');
  await mkdir(path.dirname(temporary.openCodeConfig), { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(
    temporary.openCodeConfig,
    '{ "plugin": ["unrelated-plugin"] }\n',
    'utf8',
  ));
  await setupGlobalClients({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  const config = parse(await readFile(temporary.openCodeConfig, 'utf8')) as { plugin: string[] };
  assert.deepEqual(config.plugin, ['unrelated-plugin', KIOKUKO_OPENCODE_PLUGIN]);
});
