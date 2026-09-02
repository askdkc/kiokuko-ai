import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('package test scripts use the isolated test runner', async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs tests');
  assert.equal(packageJson.scripts['test:unit'], 'node scripts/run-tests.mjs tests/unit');
  assert.equal(packageJson.scripts['test:integration'], 'node scripts/run-tests.mjs tests/integration');
});

test('test runner removes its isolated temporary root after the child exits', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-test-runner-fixture-'));
  const fixturePath = path.join(process.cwd(), 'test-fixtures', 'temp-root-report.test.ts');
  const reportPath = path.join(fixtureRoot, 'temp-root.txt');

  try {
    await execFileAsync(process.execPath, ['scripts/run-tests.mjs', fixturePath], {
      cwd: process.cwd(),
      env: { ...process.env, KIOKUKO_TEST_TEMP_REPORT: reportPath },
    });

    const isolatedTempRoot = await readFile(reportPath, 'utf8');
    await assert.rejects(access(isolatedTempRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
