import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveVerificationExecutable } from './verification-capabilities.mjs';

function recorderFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'verification-recorder-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'node_modules/agenticreplay'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { agenticreplay: '>=0.1.6' } }));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
    '': { devDependencies: { agenticreplay: '>=0.1.6' } }, 'node_modules/agenticreplay': { version: '0.1.7' },
  } }));
  writeFileSync(path.join(root, 'node_modules/agenticreplay/package.json'), JSON.stringify({ name: 'agenticreplay', version: '0.1.7' }));
  const binary = path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'agenticreplay.cmd' : 'agenticreplay');
  writeFileSync(binary, 'fixture executable; never launched by these read-only preflight tests');
  chmodSync(binary, 0o755);
  return { root, binary };
}

for (const reported of ['0.1.5', 'vendor-build', '0.1.7']) {
  test(`recorder executable discovery does not infer API compatibility from ${reported}`, async t => {
    const { root, binary } = recorderFixture(t);
    const selected = await resolveVerificationExecutable('agenticreplay-managed', {
      root, environment: { AGENTICREPLAY_BIN: binary }, declaration: { environment: 'AGENTICREPLAY_BIN' },
      command: async () => ({ exitCode: 0, stdout: reported }),
    });
    assert.equal(selected, realpathSync(binary));
  });
}

test('recorder preflight retains installed-lock identity and executable checks', async t => {
  const { root, binary } = recorderFixture(t);
  const options = { root, environment: { AGENTICREPLAY_BIN: binary }, declaration: { environment: 'AGENTICREPLAY_BIN' }, command: async () => ({ exitCode: 0, stdout: '0.1.7' }) };
  writeFileSync(path.join(root, 'node_modules/agenticreplay/package.json'), JSON.stringify({ name: 'agenticreplay', version: '9.0.0' }));
  await assert.rejects(resolveVerificationExecutable('agenticreplay-managed', options), /does not match the lockfile/);
  writeFileSync(path.join(root, 'node_modules/agenticreplay/package.json'), JSON.stringify({ name: 'agenticreplay', version: '0.1.7' }));
  rmSync(binary);
  await assert.rejects(resolveVerificationExecutable('agenticreplay-managed', options), /executable is missing/);
});
