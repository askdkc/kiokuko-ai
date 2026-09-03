import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireBearerAuthorization } from './auth.js';

export interface ReadinessState {
  readonly ready: boolean;
}

export type Readiness = ReadinessState | (() => boolean | Promise<boolean>);

export interface RouterDependencies {
  readonly expectedToken: string;
  readonly readiness: Readiness;
}

export type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

async function readReadiness(readiness: Readiness): Promise<boolean> {
  return typeof readiness === 'function' ? readiness() : readiness.ready;
}

export function createRouter(dependencies: RouterDependencies): HttpHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health/live') {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health/ready') {
      requireBearerAuthorization(request.headers.authorization, dependencies.expectedToken);
      const ready = await readReadiness(dependencies.readiness);
      writeJson(response, ready ? 200 : 503, { ok: ready });
      return;
    }
    writeJson(response, 404, { ok: false });
  };
}
