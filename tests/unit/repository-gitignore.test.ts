import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_BINDING_IGNORE_ENTRY,
  renderProjectGitignore,
} from '../../src/repository/gitignore.js';

test('project binding ignore renderer creates the canonical entry', () => {
  assert.deepEqual(renderProjectGitignore(undefined), {
    content: `${PROJECT_BINDING_IGNORE_ENTRY}\n`,
    action: 'created',
  });
});

test('project binding ignore renderer appends without changing existing bytes or line endings', () => {
  assert.deepEqual(renderProjectGitignore('node_modules/\n.env'), {
    content: `node_modules/\n.env\n${PROJECT_BINDING_IGNORE_ENTRY}\n`,
    action: 'updated',
  });
  assert.deepEqual(renderProjectGitignore('node_modules/\r\n'), {
    content: `node_modules/\r\n${PROJECT_BINDING_IGNORE_ENTRY}\r\n`,
    action: 'updated',
  });
});

test('project binding ignore renderer accepts canonical root entries and rejects negation as coverage', () => {
  for (const existing of [
    `${PROJECT_BINDING_IGNORE_ENTRY}\n`,
    `/${PROJECT_BINDING_IGNORE_ENTRY}\r\n`,
  ]) {
    assert.deepEqual(renderProjectGitignore(existing), {
      content: existing,
      action: 'unchanged',
    });
  }
  assert.deepEqual(renderProjectGitignore(`!${PROJECT_BINDING_IGNORE_ENTRY}\n`), {
    content: `!${PROJECT_BINDING_IGNORE_ENTRY}\n${PROJECT_BINDING_IGNORE_ENTRY}\n`,
    action: 'updated',
  });
});
