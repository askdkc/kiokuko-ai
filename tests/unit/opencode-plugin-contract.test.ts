import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

test('OpenCode plugin entrypoint exposes a loadable named plugin', async () => {
  const hooks = await KiokukoPlugin({
    client: {} as never,
    project: {} as never,
    directory: '/repo',
    worktree: '/repo',
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:4096'),
    $: {} as never,
  });
  assert.deepEqual(Object.keys(hooks).sort(), ['dispose', 'event']);
  assert.equal(typeof hooks.dispose, 'function');
  assert.equal(typeof hooks.event, 'function');
});

test('package boundary points OpenCode loader at the plugin dist entrypoint and keeps the CLI bin', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    main?: string;
    types?: string;
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
    engines?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  assert.equal(packageJson.name, 'kiokuko-ai');
  assert.equal(packageJson.version, PACKAGE_VERSION);
  assert.equal(packageJson.main, './dist/opencode/plugin.js');
  assert.equal(packageJson.types, './dist/opencode/plugin.d.ts');
  assert.equal(packageJson.bin?.['kiokuko-ai'], 'dist/bin/kiokuko.js');
  assert.equal(packageJson.engines?.opencode, '>=1.18.25 <2');
  assert.equal(packageJson.peerDependencies?.['@opencode-ai/plugin'], '^1.18.25');
  assert.deepEqual(packageJson.peerDependenciesMeta?.['@opencode-ai/plugin'], { optional: true });
  assert.deepEqual(packageJson.exports, {
    '.': {
      types: './dist/opencode/plugin.d.ts',
      import: './dist/opencode/plugin.js',
    },
    './cli': './dist/bin/kiokuko.js',
  });
});
