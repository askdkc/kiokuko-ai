import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MINIMUM_NODE_MAJOR,
  MINIMUM_NODE_VERSION,
  nodeMajor,
  supportsNodeVersion,
  unsupportedNodeMessage,
} from '../../src/runtime-version.js';

test('requires Node 24.16.0 or newer', () => {
  assert.equal(MINIMUM_NODE_MAJOR, 24);
  assert.equal(MINIMUM_NODE_VERSION, '24.16.0');
  assert.equal(supportsNodeVersion('22.22.3'), false);
  assert.equal(supportsNodeVersion('23.11.1'), false);
  assert.equal(supportsNodeVersion('24.0.0'), false);
  assert.equal(supportsNodeVersion('24.15.9'), false);
  assert.equal(supportsNodeVersion('24.16.0'), true);
  assert.equal(supportsNodeVersion('24.16.1'), true);
  assert.equal(supportsNodeVersion('26.5.0'), true);
});

test('parses only a complete leading Node major and reports a direct diagnostic', () => {
  assert.equal(nodeMajor('24.0.0'), 24);
  assert.equal(nodeMajor('24'), undefined);
  assert.equal(nodeMajor('v24.0.0'), undefined);
  assert.equal(nodeMajor('not-a-version'), undefined);
  assert.equal(
    unsupportedNodeMessage('22.22.3'),
    'Kiokuko requires Node.js 24.16.0 or newer; current runtime is Node.js 22.22.3.',
  );
});
