import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createModelManifest } from '../../src/embedding/model-manifest.js';
import { installEmbeddingModel } from '../../src/embedding/model-installation.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';

const testPreset = {
  ...LOCAL_SMALL_PRESET,
  files: [{ path: 'config.json', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }],
};

function downloader() {
  return {
    download: async (_preset: typeof testPreset, directory: string) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, 'config.json'), 'abc', { mode: 0o600 });
      return { directory, manifest: createModelManifest(testPreset) };
    },
  };
}

test('installs atomically and reuses an identical verified installation', async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-model-installation-'));
  const options = { env: { KIOKUKO_DATA_DIR: dataDirectory }, downloader: downloader() };
  const first = await installEmbeddingModel(testPreset, options);
  assert.equal(first.installation, 'installed');
  assert.equal(await readFile(path.join(first.directory, 'config.json'), 'utf8'), 'abc');
  assert.equal((await readFile(path.join(first.directory, 'kiokuko-model-manifest.json'), 'utf8')).endsWith('\n'), true);
  const second = await installEmbeddingModel(testPreset, options);
  assert.equal(second.installation, 'reused');
  assert.equal(second.directory, first.directory);
});

test('concurrent setup attempts converge on one verified final directory', async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-model-installation-race-'));
  const results = await Promise.all([
    installEmbeddingModel(testPreset, { env: { KIOKUKO_DATA_DIR: dataDirectory }, downloader: downloader() }),
    installEmbeddingModel(testPreset, { env: { KIOKUKO_DATA_DIR: dataDirectory }, downloader: downloader() }),
  ]);
  assert.deepEqual(results.map((result) => result.installation).sort(), ['installed', 'reused']);
});
