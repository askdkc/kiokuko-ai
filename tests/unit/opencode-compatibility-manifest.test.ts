import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('OpenCode platform catalog resolves latest without an execution version range', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(await readFile(path.join(root, 'scripts/opencode-compatibility.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.releaseTag, 'latest');
  assert.equal(packageJson.engines.opencode, undefined);
  assert.deepEqual(Object.keys(manifest).sort(), ['platforms', 'releaseTag', 'schemaVersion']);
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const definition = entry as { package: string; executable: string };
    assert.match(platform, /^(linux|macos|windows)-(x64|arm64)$/u);
    assert.deepEqual(Object.keys(definition).sort(), ['executable', 'package']);
    assert.match(definition.package, /^@opencode\/cli-(linux|darwin|windows)-(x64|arm64)$/u);
    assert.match(definition.executable, /^package\/bin\/opencode(?:\.exe)?$/u);
  }
});
