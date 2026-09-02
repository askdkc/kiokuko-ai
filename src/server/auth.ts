import { createHash, timingSafeEqual } from 'node:crypto';
import { KiokukoError } from '../errors.js';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function authenticationFailure(): never {
  throw new KiokukoError('AUTHENTICATION_ERROR', 'Authorization is invalid');
}

export function requireBearerAuthorization(header: unknown, expectedToken: unknown): void {
  if (typeof expectedToken !== 'string' || !TOKEN_PATTERN.test(expectedToken)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Server authentication token is invalid');
  }

  if (typeof header !== 'string') authenticationFailure();

  const match = /^Bearer ([0-9a-f]{64})$/.exec(header);
  const suppliedToken = match?.[1];
  if (suppliedToken === undefined) authenticationFailure();

  const expectedDigest = createHash('sha256').update(expectedToken, 'utf8').digest();
  const suppliedDigest = createHash('sha256').update(suppliedToken, 'utf8').digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) authenticationFailure();
}
