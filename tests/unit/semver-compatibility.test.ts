import assert from 'node:assert/strict';
import test from 'node:test';
import { satisfiesFrameworkVersion } from '../../src/repository/framework-version.js';

test('uses standard semver behavior for caret zero-major, OR, comparator, tilde, and partial actual versions', () => {
  const cases: Array<[string, string, ReturnType<typeof satisfiesFrameworkVersion>]> = [
    ['0.9.0', '^0.2.3', 'incompatible'],
    ['0.3.0', '^0.3.0', 'compatible'],
    ['0.0.4', '^0.0.3', 'incompatible'],
    ['13.0.0', '^12 || ^13', 'compatible'],
    ['13.0.0', '^12 || ^14', 'incompatible'],
    ['13.1.0', '>=12 <14', 'compatible'],
    ['5.1.2', '~5.1', 'compatible'],
    ['12', '>=12 <13', 'compatible'],
    ['12.1', '~12.1', 'compatible'],
    ['^13.1.0', '>=13 <14', 'compatible'],
    ['>=12 <14', '^13', 'incompatible'],
    ['13.0.0', 'not a range', 'unknown'],
    ['not a version', '^13', 'unknown'],
    ['13.0.0', '13.0.0', 'exact'],
    ['13.0.1', '13.0.0', 'incompatible'],
  ];
  for (const [actual, requirement, expected] of cases) {
    assert.equal(satisfiesFrameworkVersion(actual, requirement), expected, `${actual} against ${requirement}`);
  }
});

test('follows semver prerelease exclusion and exact prerelease matching', () => {
  assert.equal(satisfiesFrameworkVersion('13.0.0-beta.1', '^13.0.0'), 'incompatible');
  assert.equal(satisfiesFrameworkVersion('13.0.0-beta.1', '>=13.0.0-beta.1 <13.0.0'), 'compatible');
  assert.equal(satisfiesFrameworkVersion('13.0.0-beta.1', '13.0.0-beta.1'), 'exact');
});
