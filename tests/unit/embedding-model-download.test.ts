import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHuggingFaceModelDownloader } from '../../src/embedding/model-download.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';

const testPreset = {
  ...LOCAL_SMALL_PRESET,
  files: [{ path: 'config.json', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }],
};

test('downloads only preset coordinates and reports bounded progress', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-model-download-'));
  const requests: unknown[] = [];
  const progress: unknown[] = [];
  const downloader = createHuggingFaceModelDownloader({
    downloadFile: async (request) => {
      requests.push(request);
      return new Blob(['abc']);
    },
  });
  const result = await downloader.download(testPreset, directory, { onProgress: (value) => progress.push(value) });
  assert.equal(await readFile(path.join(directory, 'config.json'), 'utf8'), 'abc');
  assert.deepEqual(requests, [{ repo: { type: 'model', name: 'Xenova/multilingual-e5-small' }, path: 'config.json', revision: testPreset.revision, xet: true }]);
  assert.deepEqual(progress, [{ file: 'config.json', completedBytes: 3, totalBytes: 3 }]);
  assert.equal(result.manifest.totalBytes, 3);
});

test('rejects an interrupted or size-mismatched download before installation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-model-download-failure-'));
  const downloader = createHuggingFaceModelDownloader({ downloadFile: async () => new Blob(['wrong']) });
  await assert.rejects(downloader.download(testPreset, directory), { code: 'INTEGRITY_ERROR' });
  const signal = new AbortController();
  signal.abort();
  await assert.rejects(downloader.download(testPreset, directory, { signal: signal.signal }), { code: 'SERVICE_UNAVAILABLE' });
});
