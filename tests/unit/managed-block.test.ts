import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BEGIN_MARKER,
  END_MARKER,
  readManagedBlockTemplateVersion,
  removeManagedBlock,
  upsertManagedBlock,
} from '../../src/agent-file/managed-block.js';

const block = `${BEGIN_MARKER}\nmanaged\n${END_MARKER}`;

test('adds a managed block without changing existing content', () => {
  const result = upsertManagedBlock('header\n', block);
  assert.equal(result.action, 'created');
  assert.match(result.content, /^header\n\n\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->/);
  assert.match(result.content, /managed/);
});

test('updates only a balanced block and is idempotent', () => {
  const original = `before\n${block}\nafter\n`;
  const updated = upsertManagedBlock(original, `${BEGIN_MARKER}\nnew\n${END_MARKER}`);
  assert.equal(updated.content, `before\n${BEGIN_MARKER}\nnew\n${END_MARKER}\nafter\n`);
  assert.equal(upsertManagedBlock(updated.content, `${BEGIN_MARKER}\nnew\n${END_MARKER}`).action, 'unchanged');
});

test('preserves CRLF outside the managed block', () => {
  const original = `before\r\n${block.replaceAll('\n', '\r\n')}\r\nafter\r\n`;
  const updated = upsertManagedBlock(original, `${BEGIN_MARKER}\nchanged\n${END_MARKER}`);
  assert.match(updated.content, /before\r\n/);
  assert.match(updated.content, /changed\r\n/);
  assert.match(updated.content, /after\r\n$/);
});

test('rejects malformed marker pairs without repairing them', () => {
  assert.throws(() => upsertManagedBlock(`${BEGIN_MARKER}\nonly start`, block), /malformed/i);
  assert.throws(() => upsertManagedBlock(`${block}\n${block}`, block), /malformed/i);
});

test('removes only the exact managed block and preserves every surrounding byte', () => {
  const original = `human before\r\n\r\n${block.replaceAll('\n', '\r\n')}\r\n\r\nhuman after\r\n`;
  assert.deepEqual(removeManagedBlock(original), {
    content: 'human before\r\n\r\n\r\n\r\nhuman after\r\n',
    action: 'updated',
  });
  assert.deepEqual(removeManagedBlock('unmanaged\n'), {
    content: 'unmanaged\n',
    action: 'absent',
  });
});

test('deletes only a file whose entire content is the managed block', () => {
  assert.deepEqual(removeManagedBlock(block), { content: undefined, action: 'deleted' });
  assert.deepEqual(removeManagedBlock(`${block}\n`), { content: '\n', action: 'updated' });
});

test('managed-block removal rejects ambiguous or malformed markers', () => {
  assert.throws(() => removeManagedBlock(`${BEGIN_MARKER}\nonly start`), /malformed/i);
  assert.throws(() => removeManagedBlock(`${block}\n${block}`), /malformed/i);
});

test('reads only one canonical managed template-version declaration', () => {
  assert.equal(
    readManagedBlockTemplateVersion(`${BEGIN_MARKER}\n<!-- kiokuko-template-version: 9 -->\n${END_MARKER}`),
    9,
  );
  assert.equal(readManagedBlockTemplateVersion('human template version 99\n'), undefined);
  assert.throws(() => readManagedBlockTemplateVersion(block), /missing/i);
  assert.throws(
    () => readManagedBlockTemplateVersion(`${BEGIN_MARKER}\n<!-- kiokuko-template-version: 9 -->\n<!-- kiokuko-template-version: 10 -->\n${END_MARKER}`),
    /ambiguous/i,
  );
  assert.throws(
    () => readManagedBlockTemplateVersion(`${BEGIN_MARKER}\n<!-- kiokuko-template-version: 09 -->\n${END_MARKER}`),
    /malformed/i,
  );
});
