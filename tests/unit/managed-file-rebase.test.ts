import assert from 'node:assert/strict';
import test from 'node:test';
import { rebaseManagedRegion } from '../../src/managed-files/rebase.js';

function readBlock(value: string) {
  const start = value.indexOf('[');
  const end = value.indexOf(']') + 1;
  return { value: value.slice(start, end), digest: value.slice(start, end) };
}

function writeBlock(content: string, value: string): string {
  const start = content.indexOf('[');
  const end = content.indexOf(']') + 1;
  return `${content.slice(0, start)}${value}${content.slice(end)}`;
}

test('C03 preserves latest unmanaged bytes while rebasing the managed region', () => {
  const result = rebaseManagedRegion('user one\n[a]\n', 'user two\n[a]\n', '[b]', readBlock, writeBlock);
  assert.equal(result.status, 'rebased');
  assert.equal(result.content, 'user two\n[b]\n');
});

test('C05 converges when the latest managed region already equals desired', () => {
  const result = rebaseManagedRegion('user one\n[a]\n', 'user two\n[b]\n', '[b]', readBlock, writeBlock);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.content, 'user two\n[b]\n');
});

test('C04 rejects a different latest managed region', () => {
  assert.throws(
    () => rebaseManagedRegion('user one\n[a]\n', 'user two\n[c]\n', '[b]', readBlock, writeBlock),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
});
