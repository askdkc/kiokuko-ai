import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import test from 'node:test';
import { setupOpenCode } from '../../src/commands/setup.js';
import { KIOKUKO_OPENCODE_PLUGIN_PACKAGE } from '../../src/setup/opencode-config.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

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
    openCodeConfig: path.join(config, 'opencode', 'opencode.jsonc'),
  };
}

test('setup targets OpenCode only and is idempotent', async () => {
  const temporary = await temporaryEnvironment('opencode');
  const first = await setupOpenCode({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  assert.equal(first.client, 'opencode');
  const config = parse(await readFile(temporary.openCodeConfig, 'utf8')) as {
    plugin: unknown[];
    mcp: { kiokuko: { command: string[] } };
  };
  assert.equal(config.plugin.length, 1);
  const plugin = config.plugin[0] as [string, Record<string, unknown>];
  assert.equal(plugin[0], `${KIOKUKO_OPENCODE_PLUGIN_PACKAGE}@${PACKAGE_VERSION}`);
  assert.deepEqual(Object.keys(plugin[1]).sort(), ['cliScript', 'nodeExecutable', 'orchestration', 'orchestrationManagedAgents', 'packageVersion', 'protocolVersion']);
  assert.equal(config.mcp.kiokuko.command.at(-1), 'mcp');
  assert.equal(config.mcp.kiokuko.command.length, 3);
  assert.ok(config.mcp.kiokuko.command[0]?.startsWith('/'));
  assert.ok(config.mcp.kiokuko.command[1]?.endsWith('/dist/bin/kiokuko.js'));
  const second = await setupOpenCode({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  assert.equal(second.files.some((file) => file.action !== 'unchanged'), false);
});
test('setup dry-run does not write config or database', async () => {
  const temporary = await temporaryEnvironment('dry-run');
  const result = await setupOpenCode({
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
  await setupOpenCode({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  const config = parse(await readFile(temporary.openCodeConfig, 'utf8')) as { plugin: unknown[] };
  assert.equal(config.plugin[0], 'unrelated-plugin');
  assert.equal((config.plugin[1] as [string])[0], `${KIOKUKO_OPENCODE_PLUGIN_PACKAGE}@${PACKAGE_VERSION}`);
});


test('setup respects explicit config directory and file overrides and preserves an existing JSON file', async () => {
  const fixture = await temporaryEnvironment('config-overrides');
  const directory = path.join(fixture.config, 'custom');
  await mkdir(directory, { recursive: true });
  const existing = path.join(directory, 'opencode.json');
  await writeFile(existing, '{"model":"user/parent"}');
  const env = { ...fixture.env, OPENCODE_CONFIG_DIR: directory };
  await setupOpenCode({ env, databasePath: fixture.databasePath, standardSkills: false, command: 'kiokuko-ai' });
  assert.equal(parse(await readFile(existing, 'utf8')).model, 'user/parent');
  await assert.rejects(access(path.join(directory, 'opencode.jsonc')));
  const explicit = path.join(fixture.config, 'file-override', 'custom.jsonc');
  const changedEnv = { ...env, OPENCODE_CONFIG: explicit };
  const dry = await setupOpenCode({ env: changedEnv, databasePath: fixture.databasePath, standardSkills: false, command: 'kiokuko-ai', dryRun: true });
  assert.ok(dry.files.some(file => file.path === explicit && file.action === 'created'));
  await assert.rejects(access(explicit));
  await setupOpenCode({ env: changedEnv, databasePath: fixture.databasePath, standardSkills: false, command: 'kiokuko-ai' });
  assert.ok(parse(await readFile(explicit, 'utf8')).agent);
});
