import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireBearerAuthorization } from './auth.js';
import { parseStrictJson } from '../setup/strict-json.js';
import { learningFailure } from '../memory/learning.js';
import { KiokukoError } from '../errors.js';

export interface ReadinessState {
  readonly ready: boolean;
}

export type Readiness = ReadinessState | (() => boolean | Promise<boolean>);

export interface RouterDependencies {
  readonly expectedToken: string;
  readonly readiness: Readiness;
  readonly memory?: Record<'observe' | 'context' | 'improve', (input: unknown) => Promise<unknown>>;
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
    const operation = /^\/api\/memory\/(observe|context|improve)$/u.exec(url.pathname)?.[1] as 'observe' | 'context' | 'improve' | undefined;
    if (request.method === 'POST' && operation && dependencies.memory) {
      requireBearerAuthorization(request.headers.authorization, dependencies.expectedToken);
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > 16384) throw new KiokukoError('VALIDATION_ERROR', 'Learning input exceeds the byte bound');
          chunks.push(bytes);
        }
        const input = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), {}, 'Invalid memory JSON');
        writeJson(response, 200, await dependencies.memory[operation](input));
      } catch (error) { writeJson(response, 200, learningFailure(error)); }
      return;
    }
    writeJson(response, 404, { ok: false });
  };
}
