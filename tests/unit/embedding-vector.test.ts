import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeVector, encodeVector, hashVector, cosineDistance } from '../../src/embedding/vector.js';

test('round-trips Float32 values through canonical little-endian bytes', () => {
  const vector = new Float32Array([1, -2.5, 0.25]);
  const bytes = encodeVector(vector);

  assert.deepEqual([...bytes], [0, 0, 128, 63, 0, 0, 32, 192, 0, 0, 128, 62]);
  assert.deepEqual([...decodeVector(bytes, 3)], [...vector]);
  assert.match(hashVector(vector), /^[0-9a-f]{64}$/u);
});

test('rejects non-finite, zero-norm, dimension-mismatched, and malformed vectors', () => {
  assert.throws(() => encodeVector([Number.NaN, 1, 2]), { code: 'VALIDATION_ERROR' });
  assert.throws(() => encodeVector([Number.POSITIVE_INFINITY, 1, 2]), { code: 'VALIDATION_ERROR' });
  assert.throws(() => encodeVector([0, 0, 0]), { code: 'VALIDATION_ERROR' });
  assert.throws(() => encodeVector([1, 2, 3], 4), { code: 'VALIDATION_ERROR' });
  assert.throws(() => decodeVector(new Uint8Array(8), 3), { code: 'VALIDATION_ERROR' });
});

test('rejects a vector hash mismatch and computes bounded cosine distance', () => {
  const bytes = encodeVector([1, 0, 0]);
  assert.throws(() => decodeVector(bytes, 3, '0'.repeat(64)), { code: 'INTEGRITY_ERROR' });
  assert.equal(cosineDistance(new Float32Array([1, 0, 0]), new Float32Array([1, 0, 0])), 0);
  assert.equal(cosineDistance(new Float32Array([1, 0, 0]), new Float32Array([-1, 0, 0])), 2);
  assert.throws(() => cosineDistance(new Float32Array([1, 0]), new Float32Array([1, 0, 0])), { code: 'VALIDATION_ERROR' });
});
