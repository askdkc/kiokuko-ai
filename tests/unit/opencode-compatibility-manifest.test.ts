import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { satisfies, valid } from 'semver';

interface CompatibilityManifest {
  schemaVersion: number;
  minimum: string;
  tested: string[];
  releaseRepository: string;
  platforms: Record<string, { archive: string; versions: Record<string, { sha512: string }> }>;
}

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

async function manifest(): Promise<CompatibilityManifest> {
  return JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/opencode-compatibility.json'), 'utf8')) as CompatibilityManifest;
}

test('OpenCode compatibility manifest is pinned and agrees with package engine', async () => {
  const [compatibility, packageJson] = await Promise.all([
    manifest(),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then((value) => JSON.parse(value) as { engines: { opencode: string } }),
  ]);
  assert.equal(compatibility.schemaVersion, 1);
  assert.equal(compatibility.releaseRepository, 'anomalyco/opencode');
  assert.ok(valid(compatibility.minimum));
  assert.ok(satisfies(compatibility.minimum, packageJson.engines.opencode));
  assert.deepEqual(compatibility.tested, ['1.18.25', '1.18.26']);
  for (const version of [compatibility.minimum, ...compatibility.tested]) {
    assert.ok(valid(version));
    assert.ok(satisfies(version, packageJson.engines.opencode));
    assert.ok(compatibility.platforms['linux-x64']?.versions[version]?.sha512);
  }
  for (const [platform, definition] of Object.entries(compatibility.platforms)) {
    assert.match(platform, /^(linux|macos|windows)-(x64|arm64)$/u);
    assert.match(definition.archive, /^opencode-[a-z0-9-]+\.(zip|tar\.gz)$/u);
    for (const [version, asset] of Object.entries(definition.versions)) {
      assert.ok(compatibility.tested.includes(version));
      assert.match(asset.sha512, /^[0-9a-f]{128}$/u);
    }
  }
});
