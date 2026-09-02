import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('uses the runner temporary root', async () => {
  const reportPath = process.env.KIOKUKO_TEST_TEMP_REPORT;
  assert.ok(reportPath);
  await mkdir(path.join(tmpdir(), 'fixture-artifact'));
  await writeFile(reportPath, tmpdir(), 'utf8');
});
