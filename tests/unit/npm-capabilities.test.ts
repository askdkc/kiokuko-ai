import assert from 'node:assert/strict';
import test from 'node:test';
import { supportsNpmScriptPolicy } from '../../src/embedding/npm-capabilities.js';

test('script-policy capability requires the consumed config API response shape', () => {
  for (const output of ['', '\n', '""', '[]', '["sharp"]']) assert.equal(supportsNpmScriptPolicy(output), true);
  for (const output of ['undefined', 'null', 'false', '[7]', '{"version":"11.19.0"}', 'x'.repeat(16_385)]) {
    assert.equal(supportsNpmScriptPolicy(output), false);
  }
});
