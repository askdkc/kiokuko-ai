import { createHash } from 'node:crypto';
import { KiokukoError } from '../errors.js';

export const MIN_VECTOR_DIMENSIONS = 2;
export const MAX_VECTOR_DIMENSIONS = 8_192;

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function dimensionsValue(dimensions: number): number {
  if (!Number.isSafeInteger(dimensions) || dimensions < MIN_VECTOR_DIMENSIONS || dimensions > MAX_VECTOR_DIMENSIONS) {
    invalid('Vector dimensions are invalid');
  }
  return dimensions;
}

function validateFiniteVector(vector: Float32Array, expectedDimensions?: number): Float32Array {
  const dimensions = dimensionsValue(expectedDimensions ?? vector.length);
  if (vector.length !== dimensions) invalid('Vector dimensions do not match');
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) invalid('Vector contains a non-finite value');
    normSquared += value * value;
  }
  if (!Number.isFinite(normSquared) || normSquared === 0) invalid('Vector norm must be non-zero');
  return vector;
}

export function normalizeVector(input: Float32Array | readonly number[], expectedDimensions?: number): Float32Array {
  const vector = input instanceof Float32Array ? new Float32Array(input) : new Float32Array(input);
  return validateFiniteVector(vector, expectedDimensions);
}

export function encodeVector(input: Float32Array | readonly number[], expectedDimensions?: number): Uint8Array {
  const vector = normalizeVector(input, expectedDimensions);
  const bytes = new Uint8Array(vector.byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) {
    view.setFloat32(index * 4, vector[index]!, true);
  }
  return bytes;
}

function blobBytes(blob: unknown): Uint8Array {
  if (blob instanceof Uint8Array) return new Uint8Array(blob);
  if (ArrayBuffer.isView(blob)) return new Uint8Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob.slice(0));
  invalid('Vector BLOB is invalid');
}

export function decodeVector(blob: unknown, dimensions: number, expectedHash?: string): Float32Array {
  const validDimensions = dimensionsValue(dimensions);
  const bytes = blobBytes(blob);
  if (bytes.byteLength !== validDimensions * 4) invalid('Vector BLOB length does not match dimensions');
  if (expectedHash !== undefined && hashVectorBytes(bytes) !== expectedHash) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Vector hash does not match its BLOB');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(validDimensions);
  for (let index = 0; index < validDimensions; index += 1) vector[index] = view.getFloat32(index * 4, true);
  return validateFiniteVector(vector, validDimensions);
}

export function hashVectorBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashVector(input: Float32Array | readonly number[]): string {
  return hashVectorBytes(encodeVector(input));
}

export function cosineDistance(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) invalid('Vectors must have matching dimensions');
  const first = validateFiniteVector(left);
  const second = validateFiniteVector(right, first.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < first.length; index += 1) {
    const leftValue = first[index]!;
    const rightValue = second[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const similarity = dot / Math.sqrt(leftNorm * rightNorm);
  if (!Number.isFinite(similarity)) invalid('Vector cosine distance is invalid');
  return Math.min(2, Math.max(0, 1 - similarity));
}
