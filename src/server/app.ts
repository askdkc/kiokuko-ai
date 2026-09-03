import type { IncomingMessage, RequestListener } from 'node:http';
import { KiokukoError } from '../errors.js';
import { createRouter, type HttpHandler, type RouterDependencies } from './router.js';

export type AppDependencies = RouterDependencies;

function writeJsonError(
  response: Parameters<RequestListener>[1],
  status: number,
  operation: string,
  code: string,
  message: string,
): void {
  const body = JSON.stringify({ ok: false, operation, error: { code, message, details: {} } });
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function operationFor(request: IncomingMessage): string {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/health/live') return 'health.live';
  if (pathname === '/health/ready') return 'health.ready';
  return 'server.request';
}

function handleError(request: IncomingMessage, response: Parameters<RequestListener>[1], error: unknown): void {
  if (error instanceof KiokukoError && error.code === 'AUTHENTICATION_ERROR') {
    writeJsonError(response, 401, operationFor(request), 'AUTHENTICATION_ERROR', 'Authorization is invalid');
    return;
  }
  writeJsonError(response, 500, operationFor(request), 'INTEGRITY_ERROR', 'Unexpected server error');
}

export function createApp(dependencies: AppDependencies): RequestListener {
  const router: HttpHandler = createRouter(dependencies);
  return (request, response) => {
    void Promise.resolve(router(request, response)).catch((error: unknown) => {
      if (!response.headersSent) handleError(request, response, error);
      else response.destroy();
    });
  };
}
