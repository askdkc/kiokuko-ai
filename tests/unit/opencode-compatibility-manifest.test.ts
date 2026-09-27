import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { satisfies, valid } from 'semver';

interface CompatibilityManifest {
  schemaVersion: number;
  minimum: string;
  maximumExclusive: string;
  tested: string[];
  platforms: Record<string, { package: string; version: string; tarball: string; integrity: string; executable: string }>;
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
  assert.equal(compatibility.schemaVersion, 2);
  assert.equal(compatibility.maximumExclusive, '2.1.0');
  assert.ok(valid(compatibility.minimum));
  assert.ok(satisfies(compatibility.minimum, packageJson.engines.opencode));
  assert.deepEqual(compatibility.tested, ['2.0.18']);
  for (const version of [compatibility.minimum, ...compatibility.tested]) {
    assert.ok(valid(version));
    assert.ok(satisfies(version, packageJson.engines.opencode));
    assert.equal(compatibility.platforms['linux-x64']?.version, version);
  }
  for (const [platform, definition] of Object.entries(compatibility.platforms)) {
    assert.match(platform, /^(linux|macos|windows)-(x64|arm64)$/u);
    assert.equal(definition.version, '2.0.18');
    assert.match(definition.package, /^@opencode\/cli-(linux|darwin|windows)-(x64|arm64)$/u);
    assert.match(definition.tarball, /^https:\/\/registry\.npmjs\.org\/@opencode\/cli-.+-2\.0\.18\.tgz$/u);
    assert.match(definition.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    assert.match(definition.executable, /^package\/bin\/opencode(?:\.exe)?$/u);
  }
});
