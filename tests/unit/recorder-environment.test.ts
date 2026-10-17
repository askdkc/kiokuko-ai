import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { recorderEnvironment } from '../fixtures/recorder-environment.js';

for (const root of ['/tmp/recorder-owned', '/tmp/recorder owned with spaces']) {
  test(`recorder environment keeps temporary and user roots inside ${root}`, () => {
    const searchPath = '/owned/bin:/usr/bin:/bin';
    const { environment, directories } = recorderEnvironment(root, searchPath);
    for (const key of ['TMPDIR', 'TMP', 'TEMP', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      const value = environment[key];
      assert.equal(typeof value, 'string', `missing private ${key}`);
      const relative = path.relative(root, value!);
      assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), `${key} escaped the owned root`);
      assert.ok(directories.includes(value!), `${key} was not planned for creation`);
    }
    assert.equal(environment.PATH, searchPath, 'the explicit fixture executable path is retained');
    assert.equal(environment.TMP, environment.TMPDIR);
    assert.equal(environment.TEMP, environment.TMPDIR);
  });
}
