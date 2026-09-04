import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

test('OpenCode plugin entrypoint exposes a loadable named plugin', async () => {
  const hooks = await KiokukoPlugin({
    client: {
      session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) },
      app: { log: async () => ({ data: true }) },
    } as never,
    project: {} as never,
    directory: '/repo',
    worktree: '/repo',
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:4096'),
    $: {} as never,
  });
  assert.deepEqual(Object.keys(hooks).sort(), [
    'dispose',
    'event',
    'experimental.compaction.autocontinue',
    'experimental.session.compacting',
    'tool.execute.after',
  ]);
  assert.equal(typeof hooks.dispose, 'function');
  assert.equal(typeof hooks.event, 'function');
  assert.equal(typeof hooks['tool.execute.after'], 'function');
  assert.equal(typeof hooks['experimental.session.compacting'], 'function');
  assert.equal(typeof hooks['experimental.compaction.autocontinue'], 'function');
  await hooks.dispose?.();
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

for (const mode of ['dispose', 'timeout'] as const) {
  test(`compaction read-back is cancelled by ${mode}`, async (t) => {
    let requestSignal: AbortSignal | undefined;
    let release!: () => void;
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    if (mode === 'timeout') {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      t.mock.method(AbortSignal, 'timeout', () => timeout(20));
    }
    const hooks = await KiokukoPlugin({
      directory: '/repo',
      client: {
        app: { log: async () => undefined },
        session: {
          list: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          messages: ({ signal }: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
            requestSignal = signal;
            release = () => resolve({ data: [] });
            signal?.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true });
          }),
        },
      },
    } as never);
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await hooks.event!({ event: { type: 'session.compacted', properties: { sessionID: 'compacting' } } as never });
      assert.ok(requestSignal, 'read-back must receive an abort signal');
      const completion = mode === 'dispose' ? hooks.dispose!() : cancellation;
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error('compaction read did not cancel')), 1_000); }),
      ]);
      assert.equal(requestSignal.aborted, true);
      assert.equal(requestSignal.reason.name, mode === 'timeout' ? 'TimeoutError' : 'AbortError');
    } finally {
      clearTimeout(guard);
      release?.();
      await hooks.dispose?.();
    }
  });
}
