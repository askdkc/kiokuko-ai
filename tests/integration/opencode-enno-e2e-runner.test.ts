import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

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
