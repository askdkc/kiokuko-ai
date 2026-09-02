import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { assertNoUnexpectedModelFiles, createModelManifest, serializeModelManifest, validatePresetManifest, verifyInstalledModelDirectory, verifyModelDirectory } from '../../src/embedding/model-manifest.js';

const testPreset = {
  ...LOCAL_SMALL_PRESET,
  files: [{ path: 'config.json', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }],
};

test('validates the pinned model manifest and rejects unsafe coordinates', () => {
  assert.doesNotThrow(() => validatePresetManifest(LOCAL_SMALL_PRESET));
  assert.doesNotThrow(() => validatePresetManifest(testPreset));
  assert.throws(() => validatePresetManifest({ ...testPreset, files: [{ ...testPreset.files[0]!, path: '../config.json' }] }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePresetManifest({ ...testPreset, files: [{ ...testPreset.files[0]!, sha256: 'bad' }] }), { code: 'VALIDATION_ERROR' });
});

test('verifies exact file bytes and rejects symlinks and unexpected files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-model-manifest-'));
  await writeFile(path.join(directory, 'config.json'), 'abc', { mode: 0o600 });
  assert.equal((await verifyModelDirectory(directory, testPreset)).totalBytes, 3);
  await assertNoUnexpectedModelFiles(directory, testPreset);
  await writeFile(path.join(directory, 'unexpected.bin'), 'x', { mode: 0o600 });
  await assert.rejects(assertNoUnexpectedModelFiles(directory, testPreset), { code: 'SECURITY_REJECTION' });
  await symlink(path.join(directory, 'config.json'), path.join(directory, 'link.json'));
  await assert.rejects(verifyModelDirectory(directory, { ...testPreset, files: [...testPreset.files, { path: 'link.json', size: 3, sha256: testPreset.files[0]!.sha256 }] }), { code: 'SECURITY_REJECTION' });
  await mkdir(path.join(directory, 'empty'), { mode: 0o700 });
  assert.equal(createModelManifest(testPreset).schemaVersion, 1);
});

test('verifies the persisted manifest and rejects a manifest-only tamper', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-model-manifest-persisted-'));
  await writeFile(path.join(directory, 'config.json'), 'abc', { mode: 0o600 });
  const manifestPath = path.join(directory, 'kiokuko-model-manifest.json');
  await writeFile(manifestPath, serializeModelManifest(createModelManifest(testPreset)), { mode: 0o600 });
  await assert.doesNotReject(verifyInstalledModelDirectory(directory, testPreset));
  await writeFile(manifestPath, `${serializeModelManifest({ ...createModelManifest(testPreset), totalBytes: 4 })}`, { mode: 0o600 });
  await assert.rejects(verifyInstalledModelDirectory(directory, testPreset), { code: 'INTEGRITY_ERROR' });
});
