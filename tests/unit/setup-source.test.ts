import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerSetupCommand, type EmbeddingsCommandDependencies } from '../../src/commands/embeddings.js';

function fixture(fail = false) {
  const calls: Array<{ directory: string; offline: boolean | undefined }> = [];
  let result: any;
  const cli = new Command().exitOverride();
  const dependencies: EmbeddingsCommandDependencies = {
    withDatabase: async () => { throw new Error('embeddings disabled'); },
    pathEnvironment: { env: { KIOKUKO_DATA_DIR: '/private/test-data' } },
    setupOpenCode: async () => ({ client: 'opencode', projectAgentFiles: [] }),
    sourceInstaller: async (directory, options = {}) => {
      calls.push({ directory, offline: options.offline });
      if (fail) throw new Error('download failed');
      return { status: 'ready', version: '0.4.0', source: 'managed', reused: false };
    },
    output: (_json, _operation, data) => { result = data; },
  };
  registerSetupCommand(cli.command('setup'), dependencies);
  return { cli, calls, result: () => result };
}

test('ordinary setup installs ripwire even with embeddings disabled', async () => {
  const f = fixture();
  await f.cli.parseAsync(['setup', '--no-embeddings', '--json'], { from: 'user' });
  assert.deepEqual(f.calls, [{ directory: '/private/test-data/source-context', offline: false }]);
  assert.equal(f.result().sourceSetup.status, 'ready');
});

test('dry-run and explicit source opt-out never invoke the installer', async () => {
  for (const flag of ['--dry-run', '--no-source']) {
    const f = fixture();
    await f.cli.parseAsync(['setup', '--no-embeddings', flag, '--json'], { from: 'user' });
    assert.equal(f.calls.length, 0);
    assert.equal(f.result().sourceSetup.status, flag === '--dry-run' ? 'planned' : 'skipped');
  }
});

test('offline setup requires reuse rather than downloading ripwire', async () => {
  const f = fixture();
  await f.cli.parseAsync(['setup', '--no-embeddings', '--offline', '--json'], { from: 'user' });
  assert.equal(f.calls[0]!.offline, true);
});

test('failed ripwire installation cannot report setup success', async () => {
  const f = fixture(true);
  await assert.rejects(f.cli.parseAsync(['setup', '--no-embeddings', '--json'], { from: 'user' }), /ripwire/i);
  assert.equal(f.result(), undefined);
});
