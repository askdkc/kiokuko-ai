import type { IncomingMessage, ServerResponse } from 'node:http';
import { KiokukoError } from '../errors.js';
import { parseStrictJson } from '../setup/strict-json.js';
import { requireBearerAuthorization } from './auth.js';

export interface ReadinessState {
  readonly ready: boolean;
}

export type Readiness = ReadinessState | (() => boolean | Promise<boolean>);

export interface RouterDependencies {
  readonly expectedToken: string;
  readonly readiness: Readiness;
  readonly v1?: V1RouteHandler;
}

export type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

export type JsonObject = Record<string, unknown>;

export interface V1RouteRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: IncomingMessage['headers'];
  readonly rawHeaders?: readonly string[];
  readonly body?: JsonObject;
}

export interface V1RouteOperationRequest {
  readonly method: string;
  readonly url: URL;
}

export type V1RouteOperationResolver = (request: V1RouteOperationRequest) => string | undefined;
export type V1RouteHandler = ((request: V1RouteRequest) => unknown | Promise<unknown>) & {
  operationFor?: V1RouteOperationResolver;
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type ParsedJsonObject = Record<string, unknown>;

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parts = value.split(';');
  if (parts.length > 2 || parts[0]?.trim().toLowerCase() !== 'application/json') return false;
  return parts.length === 1 || /^charset\s*=\s*utf-8$/iu.test(parts[1]?.trim() ?? '');
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  if (body === undefined || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Response exceeds the safe size bound');
  }
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

async function readJsonObject(request: IncomingMessage): Promise<ParsedJsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  return new Promise<ParsedJsonObject>((resolve, reject) => {
    let settled = false;
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        request.resume();
        reject(new KiokukoError('VALIDATION_ERROR', 'Request body is too large'));
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      if (settled) return;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
      } catch {
        settled = true;
        reject(new KiokukoError('VALIDATION_ERROR', 'Request body is not valid UTF-8'));
        return;
      }
      if (text.trim().length === 0) {
        settled = true;
        reject(new KiokukoError('VALIDATION_ERROR', 'Request body must contain JSON'));
        return;
      }
      try {
        const value = parseStrictJson(
          text,
          { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
          'Request body is not valid JSON with unique keys',
        );
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new KiokukoError('VALIDATION_ERROR', 'Request body must be a JSON object');
        }
        settled = true;
        resolve(value as JsonObject);
      } catch (error) {
        if (settled) return;
        settled = true;
        reject(error);
      }
    });
    request.on('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
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
    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
      requireBearerAuthorization(request.headers.authorization, dependencies.expectedToken);
      if (dependencies.v1 === undefined) throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
      const routeRequest: V1RouteRequest = {
        headers: request.headers,
        method: request.method ?? 'GET',
        rawHeaders: request.rawHeaders,
        url,
      };
      const hasRequestBody = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH';
      if (hasRequestBody) {
        const contentType = request.headers['content-type'];
        if (typeof contentType !== 'string' || !isJsonContentType(contentType)) {
          throw new KiokukoError('VALIDATION_ERROR', 'Request content type is invalid');
        }
      }
      const requestWithBody = hasRequestBody
        ? { ...routeRequest, body: await readJsonObject(request) }
        : routeRequest;
      const result = await dependencies.v1(requestWithBody);
      if (result === undefined) throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
      writeJson(response, 200, result);
      return;
    }
    writeJson(response, 404, { ok: false });
  };
}
