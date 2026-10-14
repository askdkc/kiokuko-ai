import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { checkOptionalRuntime, installOptionalRuntime } from '../../src/embedding/optional-runtime.js';

test('optional runtime checks reject borrowing the development dependency tree', async (context) => {
  const packageRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-runtime-check-'));
  context.after(async () => rm(packageRoot, { recursive: true, force: true }));

  await assert.rejects(() => checkOptionalRuntime(packageRoot), /dependencies are unavailable/u);
  await symlink(path.resolve('node_modules'), path.join(packageRoot, 'node_modules'), 'dir');
  await assert.rejects(() => checkOptionalRuntime(packageRoot), /dependencies are unavailable/u);
});

import { installEmbeddingModel } from '../../src/embedding/model-installation.js';
import { createLocalTransformersModelLoader } from '../../src/embedding/local-model-loader.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { openEmbeddingDatabase } from '../../src/embedding/backend.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';

async function managedConsumerFixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-runtime-consumers-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const options = { env: { KIOKUKO_DATA_DIR: root } };
  await installOptionalRuntime(options, { runner: async (invocation) => {
    if (invocation.args[0] === '--version') return { stdout: '11.19.0' };
    if (invocation.args[0] !== 'install') return { stdout: '' };
    const manifest = JSON.parse(await readFile(path.join(invocation.cwd, 'package.json'), 'utf8'));
    const packages: Record<string, unknown> = { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } };
    const sources: Record<string, string> = {
      '@huggingface/hub': 'export const downloadFile = async () => new Blob(["abc"]);',
      '@huggingface/transformers': 'export const env = {}; export const pipeline = async () => async inputs => ({ dims: [inputs.length, 384], data: new Float32Array(inputs.length * 384).fill(1) });',
      'sqlite-vec': 'export const getLoadablePath = () => "/managed/sqlite-vec"; export const load = db => db.loadExtension(getLoadablePath());',
    };
    for (const [name, source] of Object.entries(sources)) {
      const directory = path.join(invocation.cwd, 'node_modules', name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: manifest.dependencies[name], type: 'module', exports: './index.mjs' }));
      await writeFile(path.join(directory, 'index.mjs'), source);
      packages[`node_modules/${name}`] = { version: manifest.dependencies[name] };
    }
    await writeFile(path.join(invocation.cwd, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages }));
    return { stdout: '' };
  } });
  return { root, options };
}

test('model installation loads its downloader from the injected runtime environment', async (context) => {
  const { root, options } = await managedConsumerFixture(context);
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('The ambient runtime must not download'); });
  const preset = { ...LOCAL_SMALL_PRESET, files: [{ path: 'config.json', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] };
  const first = await installEmbeddingModel(preset, options);
  assert.ok(first.directory.startsWith(root));
  assert.equal(await readFile(path.join(first.directory, 'config.json'), 'utf8'), 'abc');
  assert.equal((await installEmbeddingModel(preset, options)).installation, 'reused');
});

test('local model loader resolves Transformers from the injected runtime environment', async (context) => {
  const { root, options } = await managedConsumerFixture(context);
  const loader = createLocalTransformersModelLoader({ pathEnvironment: options, verifyInstallation: false });
  const runtime = await loader.load(createLocalEmbeddingProfile(LOCAL_SMALL_PRESET).identity, path.join(root, 'model'));
  const vectors = await runtime.embed(['query: managed runtime']);
  assert.equal(vectors[0]?.length, 384);
  assert.equal(vectors[0]?.[0], 1);
  await runtime.dispose?.();
});

test('database composition resolves sqlite-vec from the injected runtime environment', async (context) => {
  const { options } = await managedConsumerFixture(context);
  let extensionPath = '';
  const database = { close() {} } as SqliteDatabase;
  const opened = await openEmbeddingDatabase(':memory:', {
    pathEnvironment: options,
    config: { mode: 'required', provider: 'local-transformers', presetId: 'local-small', vectorBackend: 'sqlite-vec', timeoutMs: 30000, batchSize: 16 },
    openDatabase: (_path, connectionOptions) => {
      connectionOptions?.sqliteVecLoader?.load({ loadExtension: value => { extensionPath = value; } });
      return database;
    },
  });
  assert.equal(opened.backend?.id, 'sqlite-vec');
  assert.equal(extensionPath, '/managed/sqlite-vec');
});
