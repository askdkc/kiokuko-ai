import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import {
  getDatabaseLockPath,
  getGlobalDatabasePath,
  getOpenCodeConfigDirectory,
  getOpenCodeInstructionsPath,
  getOpenCodeSkillsDirectory,
  getRuntimeDescriptorPath,
  getRuntimeDirectory,
} from '../../src/config/paths.js';

test('derives a per-database lock path from the resolved database path', () => {
  const databasePath = '/tmp/kiokuko-relative/../kiokuko-ai.sqlite';
  const fingerprint = createHash('sha256').update('/tmp/kiokuko-ai.sqlite').digest('hex');
  assert.equal(
    getDatabaseLockPath(databasePath, {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/tmp/xdg-runtime' },
    }),
    `/tmp/xdg-runtime/kiokuko/${fingerprint}.lock`,
  );
});

test('derives the runtime descriptor path from the runtime directory', () => {
  assert.equal(
    getRuntimeDescriptorPath({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/tmp/xdg-runtime' },
    }),
    '/tmp/xdg-runtime/kiokuko/server.json',
  );
});

test('uses XDG runtime home on Linux', () => {
  assert.equal(
    getRuntimeDirectory({
      platform: 'linux',
      env: {
        XDG_RUNTIME_DIR: '/tmp/xdg-runtime',
        XDG_DATA_HOME: '/tmp/xdg-data',
        HOME: '/tmp/home',
      },
    }),
    '/tmp/xdg-runtime/kiokuko',
  );
});

test('falls back to the platform home data directory for runtime state', () => {
  assert.equal(
    getRuntimeDirectory({ platform: 'linux', env: { HOME: '/tmp/home' } }),
    '/tmp/home/.local/share/kiokuko',
  );
  assert.equal(
    getRuntimeDirectory({ platform: 'darwin', env: { HOME: '/tmp/home' } }),
    '/tmp/home/Library/Application Support/kiokuko',
  );
  assert.equal(
    getRuntimeDirectory({
      platform: 'win32',
      env: { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
    }),
    String.raw`C:\Users\test\AppData\Local\kiokuko`,
  );
});

test('uses XDG data home on Linux', () => {
  assert.equal(
    getGlobalDatabasePath({
      platform: 'linux',
      env: {
        XDG_DATA_HOME: '/tmp/xdg-data',
        HOME: '/tmp/home',
      },
    }),
    '/tmp/xdg-data/kiokuko/kiokuko-ai.sqlite',
  );
});

test('uses an explicit isolated Kiokuko data directory for database and runtime state', () => {
  const options = {
    platform: 'darwin' as const,
    env: {
      HOME: '/Users/test',
      KIOKUKO_DATA_DIR: '/work/kiokuko/.kiokuko-dev/../.kiokuko-dev',
    },
  };
  assert.equal(getGlobalDatabasePath(options), '/work/kiokuko/.kiokuko-dev/kiokuko-ai.sqlite');
  assert.equal(getRuntimeDirectory(options), '/work/kiokuko/.kiokuko-dev');
  assert.equal(getRuntimeDescriptorPath(options), '/work/kiokuko/.kiokuko-dev/server.json');
});

test('an explicit Kiokuko data directory overrides Linux XDG data and runtime directories', () => {
  const options = {
    platform: 'linux' as const,
    env: {
      HOME: '/home/test',
      XDG_DATA_HOME: '/xdg/data',
      XDG_RUNTIME_DIR: '/xdg/runtime',
      KIOKUKO_DATA_DIR: '/work/kiokuko-data',
    },
  };
  assert.equal(getGlobalDatabasePath(options), '/work/kiokuko-data/kiokuko-ai.sqlite');
  assert.equal(getRuntimeDirectory(options), '/work/kiokuko-data');
});

test('rejects unsafe Kiokuko data-directory overrides without echoing them', () => {
  for (const configured of ['', 'relative/data', ' /tmp/data', '/tmp/data ', '/', `/${'x'.repeat(4096)}`, '/tmp/bad\0path']) {
    assert.throws(
      () => getGlobalDatabasePath({ platform: 'darwin', env: { HOME: '/Users/test', KIOKUKO_DATA_DIR: configured } }),
      (error: unknown) => {
        assert.ok(error instanceof KiokukoError);
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(
          error.message,
          configured === '/'
            ? 'KIOKUKO_DATA_DIR must not be a filesystem root'
            : 'KIOKUKO_DATA_DIR must be a bounded absolute path',
        );
        return true;
      },
    );
  }
});

test('falls back to the platform home data directory', () => {
  assert.equal(
    getGlobalDatabasePath({
      platform: 'linux',
      env: { HOME: '/tmp/home' },
    }),
    '/tmp/home/.local/share/kiokuko/kiokuko-ai.sqlite',
  );
  assert.equal(
    getGlobalDatabasePath({
      platform: 'darwin',
      env: { HOME: '/tmp/home' },
    }),
    '/tmp/home/Library/Application Support/kiokuko/kiokuko-ai.sqlite',
  );
  assert.equal(
    getGlobalDatabasePath({
      platform: 'win32',
      env: { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
    }),
    String.raw`C:\Users\test\AppData\Local\kiokuko\kiokuko-ai.sqlite`,
  );
});

test('derives documented global OpenCode paths without touching the real home directory', () => {
  const options = {
    platform: 'linux' as const,
    env: { HOME: '/tmp/fake-home', XDG_CONFIG_HOME: '/tmp/fake-config' },
  };
  assert.equal(getOpenCodeConfigDirectory(options), '/tmp/fake-config/opencode');
  assert.equal(getOpenCodeInstructionsPath(options), '/tmp/fake-config/opencode/AGENTS.md');
  assert.equal(getOpenCodeSkillsDirectory(options), '/tmp/fake-config/opencode/skills');
});

test('derives native standard-skill directories on macOS, Linux, and Windows', () => {
  assert.equal(getOpenCodeSkillsDirectory({ platform: 'darwin', env: { HOME: '/Users/test' } }), '/Users/test/.config/opencode/skills');
  assert.equal(getOpenCodeSkillsDirectory({ platform: 'linux', env: { HOME: '/home/test', XDG_CONFIG_HOME: '/config' } }), '/config/opencode/skills');

  const windowsEnvironment = {
    USERPROFILE: String.raw`C:\Users\test`,
    APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
  };
  assert.equal(getOpenCodeConfigDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.config\opencode`);
  assert.equal(getOpenCodeInstructionsPath({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.config\opencode\AGENTS.md`);
  assert.equal(getOpenCodeSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.config\opencode\skills`);
});

test('uses the XDG-style OpenCode directory on Windows', () => {
  const options = {
    platform: 'win32' as const,
    env: {
      USERPROFILE: String.raw`C:\Users\test`,
      APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local`,
    },
  };

  assert.equal(
    getOpenCodeConfigDirectory(options),
    String.raw`C:\Users\test\.config\opencode`,
  );
});

test('honors XDG_CONFIG_HOME before Windows application-data directories', () => {
  const options = {
    platform: 'win32' as const,
    env: {
      USERPROFILE: String.raw`C:\Users\test`,
      APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local`,
      XDG_CONFIG_HOME: String.raw`D:\xdg-config`,
    },
  };

  assert.equal(
    getOpenCodeConfigDirectory(options),
    String.raw`D:\xdg-config\opencode`,
  );
});

test('treats an empty Windows XDG_CONFIG_HOME as unset', () => {
  assert.equal(
    getOpenCodeConfigDirectory({
      platform: 'win32',
      env: {
        USERPROFILE: String.raw`C:\Users\test`,
        APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
        XDG_CONFIG_HOME: '',
      },
    }),
    String.raw`C:\Users\test\.config\opencode`,
  );
});

test('uses HOME for OpenCode on Windows when USERPROFILE is unavailable', () => {
  assert.equal(
    getOpenCodeConfigDirectory({
      platform: 'win32',
      env: { HOME: String.raw`D:\home\test` },
    }),
    String.raw`D:\home\test\.config\opencode`,
  );
});

test('rejects APPDATA-only OpenCode path resolution on Windows', () => {
  assert.throws(
    () => getOpenCodeConfigDirectory({
      platform: 'win32',
      env: {
        APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
        LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local`,
      },
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('keeps OpenCode XDG fallback paths unchanged on Linux and macOS', () => {
  assert.equal(
    getOpenCodeConfigDirectory({ platform: 'linux', env: { HOME: '/home/test' } }),
    '/home/test/.config/opencode',
  );
  assert.equal(
    getOpenCodeConfigDirectory({ platform: 'darwin', env: { HOME: '/Users/test' } }),
    '/Users/test/.config/opencode',
  );
});
