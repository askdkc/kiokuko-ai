import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';
import { pluginContextFixture } from '../fixtures/opencode-v2-plugin.js';

test('v2 plugin registers domain hooks and cleanup closes the subscription', async () => {
  const fixture = pluginContextFixture();
  assert.equal(KiokukoPlugin.id, 'kiokuko-ai');
  const cleanup = await KiokukoPlugin.setup(fixture.ctx);
  assert.equal(typeof cleanup, 'function');
  assert.ok(fixture.tools.some(value => (value as { name?: string }).name === 'kiokuko_lisp'));
  assert.ok(fixture.commands.some(value => (value as { name?: string }).name === 'kiokuko-lisp-disable'));
  assert.deepEqual([...fixture.hooks.keys()].sort(), [
    'session:compaction', 'session:context', 'session:prompt', 'tool:execute.after', 'tool:execute.before',
  ]);
  await cleanup?.();
  assert.equal(fixture.subscriptionClosed, true);
});

test('package entrypoint retains CLI identity and declares development types consistently with its lock', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
    name: string; version: string; main: string; types: string; bin: Record<string, string>;
    engines: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string>; exports: Record<string, unknown>;
  };
  assert.equal(packageJson.name, 'kiokuko-ai');
  assert.equal(packageJson.version, PACKAGE_VERSION);
  assert.equal(packageJson.main, './dist/opencode/plugin.js');
  assert.equal(packageJson.types, './dist/opencode/plugin.d.ts');
  assert.equal(packageJson.bin['kiokuko-ai'], 'dist/bin/kiokuko.js');
  assert.equal(packageJson.engines.opencode, undefined);
  assert.equal(packageJson.dependencies['@opencode/plugin'], undefined);
  assert.equal(packageJson.dependencies['@opencode/client'], undefined);
  const lock = JSON.parse(await readFile(path.resolve('package-lock.json'), 'utf8'));
  for (const name of ['@opencode/plugin', '@opencode/client']) assert.equal(packageJson.devDependencies[name], lock.packages[''].devDependencies[name]);
  assert.equal(packageJson.dependencies['@opencode-ai/plugin'], undefined);
  assert.equal(packageJson.dependencies['@opencode-ai/sdk'], undefined);
});
