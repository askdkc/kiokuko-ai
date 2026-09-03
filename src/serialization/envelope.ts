import { KiokukoError } from '../errors.js';

export interface SuccessEnvelope<T = unknown> {
  version: 1;
  ok: true;
  operation: string;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  version: 1;
  ok: false;
  operation: string;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export function successEnvelope<T>(operation: string, data: T, meta?: Record<string, unknown>): SuccessEnvelope<T> {
  return { version: 1, ok: true, operation, data, ...(meta === undefined ? {} : { meta }) };
}

export function errorEnvelope(operation: string, error: unknown): ErrorEnvelope {
  if (error instanceof KiokukoError) {
    return { version: 1, ok: false, operation, error: { code: error.code, message: error.message, details: error.details } };
  }
  return { version: 1, ok: false, operation, error: { code: 'INTEGRITY_ERROR', message: 'Unexpected internal error', details: {} } };
}
