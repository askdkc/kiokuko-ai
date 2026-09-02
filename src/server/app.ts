import type { IncomingMessage, RequestListener } from 'node:http';
import { KiokukoError } from '../errors.js';
import { createRouter, type HttpHandler, type RouterDependencies, type V1RouteHandler } from './router.js';

export type AppDependencies = RouterDependencies;

function writeJsonError(
  response: Parameters<RequestListener>[1],
  status: number,
  operation: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  retryAfterSeconds?: number,
): void {
  const body = JSON.stringify({
    apiVersion: '1',
    ok: false,
    operation,
    error: { code, message, details },
  });
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
  });
  response.end(body);
}

function boundedRetryAfterSeconds(error: KiokukoError): number {
  const value = error.details.retryAfterSeconds;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(60, Math.max(1, Math.trunc(value)));
}

function operationFor(request: IncomingMessage, v1?: V1RouteHandler): string {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  try {
    const resolved = v1?.operationFor?.({
      method: request.method ?? 'GET',
      url: new URL(request.url ?? '/', 'http://127.0.0.1'),
    });
    if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  } catch {
    // An operation resolver is advisory; error serialization must keep the safe fallback.
  }
  return pathname === '/health/ready' ? 'health.ready' : pathname === '/api/v1' || pathname.startsWith('/api/v1/') ? 'api.v1' : 'server.request';
}

function handleError(request: IncomingMessage, response: Parameters<RequestListener>[1], error: unknown, v1?: V1RouteHandler): void {
  if (error instanceof KiokukoError && error.code === 'AUTHENTICATION_ERROR') {
    writeJsonError(response, 401, operationFor(request, v1), 'AUTHENTICATION_ERROR', 'Authorization is invalid');
    return;
  }
  if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
    writeJsonError(response, 404, operationFor(request, v1), 'NOT_FOUND', 'Endpoint not found');
    return;
  }
  if (error instanceof KiokukoError && (error.code === 'VALIDATION_ERROR' || error.code === 'USAGE_ERROR')) {
    writeJsonError(response, 400, operationFor(request, v1), error.code, 'Request is invalid');
    return;
  }
  if (error instanceof KiokukoError && error.code === 'CONFLICT') {
    writeJsonError(response, 409, operationFor(request, v1), 'CONFLICT', 'Request conflicts with current state');
    return;
  }
  if (error instanceof KiokukoError && error.code === 'BACKPRESSURE') {
    const retryAfterSeconds = boundedRetryAfterSeconds(error);
    writeJsonError(response, 429, operationFor(request, v1), 'BACKPRESSURE', 'Service is busy', { retryAfterSeconds }, retryAfterSeconds);
    return;
  }
  if (error instanceof KiokukoError && (error.code === 'SERVICE_UNAVAILABLE' || error.code === 'DATABASE_ERROR')) {
    const message = error.code === 'DATABASE_ERROR' ? 'Database unavailable' : 'Service unavailable';
    writeJsonError(response, 503, operationFor(request, v1), error.code, message);
    return;
  }
  if (error instanceof KiokukoError && error.code === 'SECURITY_REJECTION') {
    writeJsonError(response, 422, operationFor(request, v1), 'SECURITY_REJECTION', 'Request rejected');
    return;
  }
  if (error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR') {
    writeJsonError(response, 500, operationFor(request, v1), 'INTEGRITY_ERROR', 'Internal integrity error');
    return;
  }
  writeJsonError(response, 500, operationFor(request, v1), 'INTEGRITY_ERROR', 'Unexpected server error');
}

export function createApp(dependencies: AppDependencies): RequestListener {
  const router: HttpHandler = createRouter(dependencies);
  return (request, response) => {
    void Promise.resolve(router(request, response)).catch((error: unknown) => {
      if (!response.headersSent) handleError(request, response, error, dependencies.v1);
      else response.destroy();
    });
  };
}
