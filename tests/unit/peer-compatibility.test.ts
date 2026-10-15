import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import semver from 'semver';
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));

test('published peers remain bounded compatible ranges and lock metadata agrees', () => {
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  for (const [name, range] of Object.entries(manifest.peerDependencies) as [string, string][]) {
    assert.equal(semver.valid(range), null, `${name} must not pin consumers to one version`);
    const minimum = semver.minVersion(range);
    assert.ok(minimum, `${name} must have a supported minimum`);
    assert.equal(semver.satisfies(minimum, range, {includePrerelease:true}), true);
    const breaking = minimum.major ? `${minimum.major + 1}.0.0-0` : `0.${minimum.minor + 1}.0-0`;
    assert.equal(semver.satisfies(breaking, range, {includePrerelease:true}), false, `${name} rejects a breaking prerelease`);
    assert.equal(semver.satisfies('99.0.0', range), false);
  }
});

