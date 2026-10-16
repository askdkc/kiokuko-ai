import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('tgrep evaluator checks a newer CLI/RPC through actual comparisons and rejects missing APIs', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-tgrep-contract-')); t.after(() => rm(base, { recursive: true, force: true }));
  const binary = path.join(base, 'tgrep');
  await writeFile(binary, `#!${process.execPath}\nimport ${JSON.stringify(new URL('../fixtures/tgrep-contract.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  // .mjs avoids interpreting a temporary executable according to an unrelated package.
  await writeFile(path.join(base, 'package.json'), '{"type":"module"}');
  const output = path.join(base, 'report.json');
  const run = (missing: boolean) => promisify(execFile)(process.execPath, ['scripts/evaluate-tgrep.mjs', binary, output], {
    env: { ...process.env, KIOKUKO_TGREP_MISSING_API: missing ? '1' : '0' }, timeout: 60000, maxBuffer: 256 * 1024,
  });
  await run(false);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.tgrep, 'tgrep 99.0.0');
  assert.equal(report.results.length, 12); assert.ok(report.results.every((row: { allEqual: boolean }) => row.allEqual));
  assert.ok(report.filesOnly.every((row: { allEqual: boolean }) => row.allEqual));
  assert.ok(report.freshness.every((row: { eventualEqual: boolean; fullScanEqual: boolean }) => row.eventualEqual && row.fullScanEqual));
  await assert.rejects(run(true), /fixture missing index\/search API/u);
});
