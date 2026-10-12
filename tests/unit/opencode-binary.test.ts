import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { resolveOpenCodeBinary } = await import(new URL('../../scripts/run-opencode-host-e2e.mjs', import.meta.url).href);

test('host contracts accept an installed executable symlink', { skip: process.platform === 'win32' }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'opencode-binary-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'installed');
  const shortcut = path.join(root, 'opencode');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await symlink(executable, shortcut);
  assert.equal(await resolveOpenCodeBinary(shortcut), executable);
});
