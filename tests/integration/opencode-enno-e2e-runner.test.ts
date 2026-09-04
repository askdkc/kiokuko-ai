import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { getGlobalDatabasePath } from '../../src/config/paths.js';
import { setupOpenCode } from '../../src/commands/setup.js';
import { openConnection } from '../../src/db/connection.js';

const execute = promisify(execFile);
const runner = path.resolve(import.meta.dirname, '../../scripts/run-opencode-enno-e2e.mjs');

test('OpenCode Enno E2E runner rejects obsolete client selector arguments', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-e2e-supported-'));
  for (const unsupported of ['opencode', 'all', 'unsupported']) {
    await assert.rejects(
      execute(process.execPath, [runner, unsupported], { cwd: directory }),
      (error: unknown) => {
        const failure = error as { code?: unknown; stdout?: unknown };
        if (failure.code !== 1 || typeof failure.stdout !== 'string') return false;
        const result = JSON.parse(failure.stdout) as { results?: Array<{ status?: string; reason?: string }> };
        return result.results?.[0]?.status === 'failed' && result.results[0].reason === 'unexpected_argument';
      },
    );
  }
});

test('OpenCode E2E is not-run until the opt-in flag is set', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-e2e-gate-'));
  const output = await execute(process.execPath, [runner], { cwd: directory });
  const result = JSON.parse(output.stdout) as { results?: Array<{ status?: string; reason?: string }> };
  assert.deepEqual(result.results, [{
    client: 'opencode',
    status: 'not-run',
    reason: 'RUN_OPENCODE_E2E=1 is not set',
  }]);
});

test('live E2E setup and ledger verification share an isolated database on every platform', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-e2e-data-'));
  try {
    const { createOpenCodeE2eEnvironment } = await import(pathToFileURL(runner).href);
    const paths = { home: path.join(directory, 'home'), config: path.join(directory, 'config'), data: path.join(directory, 'data') };
    const environment = createOpenCodeE2eEnvironment(paths, { KIOKUKO_DATA_DIR: '/unrelated-user-data' });
    const expected = path.join(paths.data, 'kiokuko-ai.sqlite');
    for (const platform of ['darwin', 'linux'] as const) {
      assert.equal(getGlobalDatabasePath({ platform, env: environment }), expected);
    }
    const windowsEnvironment = createOpenCodeE2eEnvironment({ home: 'C:\\fixture\\home', config: 'C:\\fixture\\config', data: 'C:\\fixture\\data' }, {});
    assert.equal(getGlobalDatabasePath({ platform: 'win32', env: windowsEnvironment }), 'C:\\fixture\\data\\kiokuko-ai.sqlite');
    await mkdir(paths.home);
    const setup = await setupOpenCode({ env: environment, command: 'kiokuko-ai', standardSkills: false, skillDiscoveryMode: 'off' });
    assert.equal(setup.databasePath, expected);
    const database = openConnection(expected, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get()?.count, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
