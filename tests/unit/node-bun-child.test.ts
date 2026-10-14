import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { text } from 'node:stream/consumers';
import { spawnNodeBunChild } from '../fixtures/node-bun-child.js';

const options = { cwd: tmpdir(), env: process.env };

test('Node Bun adapter rejects early stdin closure instead of emitting an uncaught EPIPE', { timeout: 5_000 }, async t => {
  const child = spawnNodeBunChild([process.execPath, '-e', `
    require('node:fs').closeSync(0);
    process.stdout.write('stdin-closed');
    setInterval(() => {}, 1000);
  `], options);
  t.after(async () => { child.kill(); await child.exited; });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    assert.equal(Buffer.from(ready.value!).toString(), 'stdin-closed');
  } finally { reader.releaseLock(); }

  await assert.rejects(child.stdin.write('request after peer closure'), { code: 'EPIPE' });
  await assert.rejects(child.stdin.end(), { code: 'ERR_INVALID_STATE' });
  child.kill();
  assert.equal(await child.exited, 1);
});

test('Node Bun adapter preserves ordered input and EOF and settles after child stdio closes', { timeout: 5_000 }, async t => {
  const child = spawnNodeBunChild([process.execPath, '-e', `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      process.stdout.write(input);
      process.stderr.write('EOF received');
    });
  `], options);
  t.after(async () => { child.kill(); await child.exited; });
  const stdout = text(child.stdout);
  const stderr = text(child.stderr);
  await child.stdin.write('first: 通常入力\n');
  await child.stdin.write('second: complete\n');
  await child.stdin.end();

  assert.equal(await child.exited, 0);
  assert.equal(await stdout, 'first: 通常入力\nsecond: complete\n');
  assert.equal(await stderr, 'EOF received');
});
