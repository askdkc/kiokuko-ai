import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';
import { createRuntimeDescriptor, writeRuntimeDescriptor } from '../../src/server/runtime-descriptor.js';
import { createServerClient, type FetchImplementation } from '../../src/client/server-client.js';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

async function listen(handler: RequestListener): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not expose an address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function clientForFetch(prefix: string, fetchImplementation: FetchImplementation) {
  const directory = await temp(prefix);
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: process.pid,
    capabilityToken: 'a'.repeat(64),
  }));
  return createServerClient({ descriptorPath, isPidAlive: () => true, fetchImplementation });
}

function jsonResponse(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

test('creates an opaque server client from a live runtime descriptor', async () => {
  const directory = await temp('client-create');
  const descriptorPath = path.join(directory, 'server.json');
  const capabilityToken = 'd'.repeat(64);
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: process.pid,
    capabilityToken,
  }));

  const client = await createServerClient({ descriptorPath, isPidAlive: () => true });
  const publicRepresentation = `${JSON.stringify(client)} ${inspect(client)} ${Object.keys(client).join(',')}`;

  assert.equal(typeof client.request, 'function');
  assert.equal(publicRepresentation.includes(capabilityToken), false);
  assert.equal(publicRepresentation.includes('authorization'), false);
  assert.equal(publicRepresentation.includes('token'), false);
});

test('request returns only the exact v1 success data and sends authenticated JSON headers', async () => {
  const token = 'e'.repeat(64);
  let receivedAuthorization: string | undefined;
  let receivedAccept: string | undefined;
  let receivedPath: string | undefined;
  const local = await listen((request, response) => {
    receivedAuthorization = request.headers.authorization;
    receivedAccept = request.headers.accept;
    receivedPath = request.url;
    const body = JSON.stringify({ apiVersion: '1', ok: true, operation: 'agent.test', data: { accepted: true } });
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  const directory = await temp('client-request-success');
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: local.baseUrl,
    pid: process.pid,
    capabilityToken: token,
  }));

  try {
    const client = await createServerClient({ descriptorPath, isPidAlive: () => true });
    const data = await client.request<{ accepted: boolean }>({
      method: 'GET',
      path: '/api/v1/agent/test',
      operation: 'agent.test',
    });

    assert.deepEqual(data, { accepted: true });
    assert.equal(receivedAuthorization === `Bearer ${token}`, true);
    assert.equal(receivedAccept, 'application/json');
    assert.equal(receivedPath, '/api/v1/agent/test');
  } finally {
    await close(local.server);
  }
});

test('write request snapshots JSON and sends the exact idempotency and content headers', async () => {
  const token = 'f'.repeat(64);
  const idempotencyKey = 'idem-client-write-1';
  let receivedAuthorization: string | undefined;
  let receivedIdempotencyKey: string | undefined;
  let receivedContentType: string | undefined;
  let receivedBody = '';
  const local = await listen((request, response) => {
    receivedAuthorization = request.headers.authorization;
    receivedIdempotencyKey = typeof request.headers['idempotency-key'] === 'string'
      ? request.headers['idempotency-key']
      : undefined;
    receivedContentType = request.headers['content-type'];
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { receivedBody += chunk; });
    request.on('end', () => {
      const body = JSON.stringify({ apiVersion: '1', ok: true, operation: 'agent.write', data: { accepted: true } });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
  });
  const directory = await temp('client-request-write');
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: local.baseUrl,
    pid: process.pid,
    capabilityToken: token,
  }));
  const input = { z: 'snapshot', nested: { b: 2, a: 'before-mutation' } };

  try {
    const client = await createServerClient({ descriptorPath, isPidAlive: () => true });
    const resultPromise = client.request<{ accepted: boolean }>({
      method: 'POST',
      path: '/api/v1/agent/write',
      operation: 'agent.write',
      body: input,
      idempotencyKey,
    });
    input.z = 'after-mutation';
    input.nested.a = 'after-mutation';
    const data = await resultPromise;

    assert.deepEqual(data, { accepted: true });
    assert.equal(receivedAuthorization === `Bearer ${token}`, true);
    assert.equal(receivedIdempotencyKey === idempotencyKey, true);
    assert.equal(receivedContentType, 'application/json');
    assert.equal(receivedBody, '{"nested":{"a":"before-mutation","b":2},"z":"snapshot"}');
  } finally {
    await close(local.server);
  }
});

test('canonical request snapshots preserve __proto__ as data and never mutate object prototypes', async () => {
  let receivedBody: string | undefined;
  const client = await clientForFetch('client-proto-body', async (_url, init) => {
    receivedBody = typeof init?.body === 'string' ? init.body : undefined;
    return jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.proto', data: { accepted: true } });
  });
  const body = JSON.parse('{"ordinary":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
  const originalPrototype = Object.getPrototypeOf(body);

  const result = await client.request({
    method: 'POST',
    path: '/api/v1/agent/proto',
    operation: 'agent.proto',
    body,
    idempotencyKey: 'proto-key',
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(receivedBody, '{"__proto__":{"polluted":true},"ordinary":1}');
  assert.equal(Object.getPrototypeOf(body), originalPrototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('request snapshots never invoke ambient Array.prototype.toJSON hooks', { concurrency: false }, async () => {
  let callbackCalls = 0;
  let receivedBody: string | undefined;
  const arrayPrototype = Array.prototype as unknown as Record<string, unknown>;
  const prior = Object.getOwnPropertyDescriptor(arrayPrototype, 'toJSON');
  Object.defineProperty(arrayPrototype, 'toJSON', {
    configurable: true,
    value: () => {
      callbackCalls += 1;
      return ['forged'];
    },
  });
  try {
    const client = await clientForFetch('client-array-to-json', async (_url, init) => {
      receivedBody = typeof init?.body === 'string' ? init.body : undefined;
      return jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.array', data: { accepted: true } });
    });
    assert.deepEqual(await client.request({
      method: 'POST', path: '/api/v1/agent/array', operation: 'agent.array',
      body: { items: [1] }, idempotencyKey: 'array-key',
    }), { accepted: true });
    assert.equal(receivedBody, '{"items":[1]}');
    assert.equal(callbackCalls, 0);
  } finally {
    if (prior === undefined) delete arrayPrototype.toJSON;
    else Object.defineProperty(arrayPrototype, 'toJSON', prior);
  }
});

test('request and body boundaries reject proxies, accessors, hidden fields, and non-plain shapes without invoking them', async () => {
  let fetchCalls = 0;
  let getterCalls = 0;
  let proxyTrapCalls = 0;
  const client = await clientForFetch('client-hostile-shapes', async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called');
  });
  const accessorBody: Record<string, unknown> = {};
  Object.defineProperty(accessorBody, 'secret', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return 'must-not-run';
    },
  });
  const hiddenBody = { visible: true };
  Object.defineProperty(hiddenBody, 'hidden', { value: 'must-not-be-ignored', enumerable: false });
  const proxyBody = new Proxy({ value: true }, {
    ownKeys(target) {
      proxyTrapCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  const nonPlainBody = Object.create({ inherited: true }) as Record<string, unknown>;
  nonPlainBody.value = true;
  const requestWithAccessor = {
    path: '/api/v1/agent/body',
    operation: 'agent.body',
    body: { value: true },
    idempotencyKey: 'body-key',
  } as Record<string, unknown>;
  Object.defineProperty(requestWithAccessor, 'method', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return 'POST';
    },
  });
  const requestProxy = new Proxy({
    method: 'POST' as const,
    path: '/api/v1/agent/body',
    operation: 'agent.body',
    body: { value: true },
    idempotencyKey: 'body-key',
  }, {
    ownKeys(target) {
      proxyTrapCalls += 1;
      return Reflect.ownKeys(target);
    },
  });

  const requests = [
    { method: 'POST' as const, path: '/api/v1/agent/body', operation: 'agent.body', body: accessorBody, idempotencyKey: 'body-key' },
    { method: 'POST' as const, path: '/api/v1/agent/body', operation: 'agent.body', body: hiddenBody, idempotencyKey: 'body-key' },
    { method: 'POST' as const, path: '/api/v1/agent/body', operation: 'agent.body', body: proxyBody, idempotencyKey: 'body-key' },
    { method: 'POST' as const, path: '/api/v1/agent/body', operation: 'agent.body', body: nonPlainBody, idempotencyKey: 'body-key' },
    requestWithAccessor as never,
    requestProxy,
  ];
  for (const request of requests) {
    await assert.rejects(
      () => client.request(request),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(fetchCalls, 0);
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});

test('revoked request and body proxies fail as validation errors without proxy introspection', async () => {
  let fetchCalls = 0;
  const client = await clientForFetch('client-revoked-shapes', async () => {
    fetchCalls += 1;
    throw new Error('revoked input must not invoke fetch');
  });
  const revokedBody = Proxy.revocable({ value: true }, {});
  revokedBody.revoke();
  await assert.rejects(
    () => client.request({
      method: 'POST', path: '/api/v1/agent/revoked', operation: 'agent.revoked',
      body: revokedBody.proxy, idempotencyKey: 'revoked-body',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
  );
  const revokedRequest = Proxy.revocable({
    method: 'GET' as const, path: '/api/v1/agent/revoked', operation: 'agent.revoked',
  }, {});
  revokedRequest.revoke();
  await assert.rejects(
    () => client.request(revokedRequest.proxy),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
  );
  assert.equal(fetchCalls, 0);
});

test('rejects unsafe paths and write queries before invoking fetch', async () => {
  let fetchCalls = 0;
  const client = await clientForFetch('client-path-policy', async () => {
    fetchCalls += 1;
    throw new Error('should not be called');
  });
  const cases = [
    { method: 'GET' as const, path: 'https://example.invalid/api/v1/x' },
    { method: 'GET' as const, path: '//example.invalid/api/v1/x' },
    { method: 'GET' as const, path: '/api/v1/../secret' },
    { method: 'GET' as const, path: '/api/v1/%2e%2e/secret' },
    { method: 'GET' as const, path: '/api/v1/x#fragment' },
    { method: 'GET' as const, path: '/api/v1/x\r\nHeader: injected' },
    { method: 'POST' as const, path: '/api/v1/x?read=true' },
    { method: 'GET' as const, path: `/api/v1/${'あ'.repeat(5_000)}` },
  ];

  for (const input of cases) {
    await assert.rejects(
      () => client.request({ ...input, operation: 'agent.path', ...(input.method === 'POST' ? { idempotencyKey: 'path-test' } : {}) }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Request is invalid');
        return true;
      },
    );
  }
  assert.equal(fetchCalls, 0);
});

test('requires bounded idempotency keys only for write methods', async () => {
  let fetchCalls = 0;
  const client = await clientForFetch('client-idempotency-policy', async () => {
    fetchCalls += 1;
    throw new Error('should not be called');
  });
  const cases = [
    { method: 'POST' as const, idempotencyKey: undefined },
    { method: 'PUT' as const, idempotencyKey: '' },
    { method: 'PATCH' as const, idempotencyKey: 'bad\r\nkey' },
    { method: 'POST' as const, idempotencyKey: ' normalized-on-wire ' },
    { method: 'DELETE' as const, idempotencyKey: 'x'.repeat(257) },
    { method: 'POST' as const, idempotencyKey: 'emoji-🔑' },
    { method: 'GET' as const, idempotencyKey: 'read-key' },
    { method: 'HEAD' as const, idempotencyKey: 'head-key' },
  ];

  for (const input of cases) {
    await assert.rejects(
      () => client.request({
        method: input.method as never,
        path: '/api/v1/agent/key',
        operation: 'agent.key',
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(fetchCalls, 0);
});

test('rejects read bodies and non-GET health probes before invoking fetch', async () => {
  let fetchCalls = 0;
  const client = await clientForFetch('client-method-body-contract', async () => {
    fetchCalls += 1;
    throw new Error('invalid method/body combinations must not invoke fetch');
  });
  for (const request of [
    { method: 'GET' as const, path: '/api/v1/agent/read', operation: 'agent.read', body: { hidden: true } },
    { method: 'POST' as const, path: '/health/ready', operation: 'health.ready', body: {}, idempotencyKey: 'health-post' },
    { method: 'GET' as const, path: '/health/ready', operation: 'agent.read' },
    { method: 'GET' as const, path: '/api/v1/agent/read', operation: 'health.ready' },
  ]) {
    await assert.rejects(
      () => client.request(request),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(fetchCalls, 0);
});

test('rejects non-JSON, cyclic, non-finite, and oversized bodies without echoing input', async () => {
  let fetchCalls = 0;
  const client = await clientForFetch('client-body-policy', async () => {
    fetchCalls += 1;
    throw new Error('should not be called');
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const malformedArray = ['value'] as unknown[];
  Object.defineProperty(malformedArray, '01', { value: 'non-canonical-index', enumerable: true });
  let deeplyNested: unknown = null;
  for (let depth = 0; depth < 129; depth += 1) deeplyNested = { value: deeplyNested };
  const cases: unknown[] = [
    { secret: 1n },
    { value: 1n },
    { value: Number.NaN },
    { value: () => 'not-json' },
    { value: new Date('2026-08-20T07:00:00.000Z') },
    cyclic,
    malformedArray,
    deeplyNested,
    { value: 'x'.repeat(2 * 1024 * 1024) },
  ];

  for (const body of cases) {
    await assert.rejects(
      () => client.request({ method: 'POST', path: '/api/v1/agent/body', operation: 'agent.body', body, idempotencyKey: 'body-key' }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Request is invalid');
        assert.equal(error instanceof Error && 'details' in error && JSON.stringify(error.details), '{}');
        return true;
      },
    );
  }
  assert.equal(fetchCalls, 0);
});

test('rejects malformed, empty, HTML, oversized, and wrong-operation responses as integrity errors', async () => {
  const responses = [
    new Response('<html>response-secret</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    jsonResponse({ apiVersion: '2', ok: true, operation: 'agent.response', data: {} }),
    jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.other', data: {} }),
    jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.response' }),
    jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.response', data: {} }, 201),
  ];

  for (const [index, response] of responses.entries()) {
    const client = await clientForFetch(`client-response-integrity-${index}`, async () => response);
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/api/v1/agent/response', operation: 'agent.response' }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Server response is invalid');
        assert.equal(error instanceof Error && 'details' in error && JSON.stringify(error.details), '{}');
        assert.equal(error instanceof Error && error.message.includes('response-secret'), false);
        return true;
      },
    );
  }

  const oversized = new Response('x'.repeat(2 * 1024 * 1024 + 1), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const oversizedClient = await clientForFetch('client-response-oversized', async () => oversized);
  await assert.rejects(
    () => oversizedClient.request({ method: 'GET', path: '/api/v1/agent/response', operation: 'agent.response' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
  );
});

test('rejects non-canonical response JSON before duplicate envelope fields can override each other', async () => {
  const deeplyNested = `${'{"value":'.repeat(129)}null${'}'.repeat(129)}`;
  const bodies = [
    '{"apiVersion":"1","ok":false,"ok":true,"operation":"agent.response","data":{"accepted":true}}',
    '{"apiVersion":"1","ok":true,"operation":"agent.other","operation":"agent.response","data":{"accepted":true}}',
    '{"apiVersion":"1","ok":true,"operation":"agent.response","data":{"accepted":false},"data":{"accepted":true}}',
    '{"apiVersion":"1","ok":true,"operation":"agent.response","data":{"accepted":true}} // comment',
    '{"apiVersion":"1","ok":true,"operation":"agent.response","data":{"accepted":true},}',
    '\ufeff{"apiVersion":"1","ok":true,"operation":"agent.response","data":{"accepted":true}}',
    '{"apiVersion":"1","ok":true,"operation":"agent.response","data":{"accepted":1e400}}',
    `{"apiVersion":"1","ok":true,"operation":"agent.response","data":${deeplyNested}}`,
  ];

  for (const [index, body] of bodies.entries()) {
    const client = await clientForFetch(`client-response-strict-json-${index}`, async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/api/v1/agent/response', operation: 'agent.response' }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Server response is invalid');
        assert.equal(error instanceof Error && 'details' in error && JSON.stringify(error.details), '{}');
        return true;
      },
    );
  }
});

test('response streaming accepts exact byte chunks and rejects decorated or derived chunks', async () => {
  const encoded = new TextEncoder().encode('{"apiVersion":"1","ok":true,"operation":"agent.bytes","data":{"accepted":true}}');
  const exactChunkClient = await clientForFetch('client-exact-byte-chunk', async () => new Response(encoded, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  assert.deepEqual(await exactChunkClient.request({
    method: 'GET', path: '/api/v1/agent/bytes', operation: 'agent.bytes',
  }), { accepted: true });

  let accessorCalls = 0;
  const decorated = encoded.slice();
  Object.defineProperty(decorated, 'byteLength', {
    get: () => {
      accessorCalls += 1;
      throw new Error('byteLength accessor must not run');
    },
  });
  Object.defineProperty(decorated, 'constructor', {
    get: () => {
      accessorCalls += 1;
      throw new Error('constructor species accessor must not run');
    },
  });
  for (const chunk of [decorated, 'x'.repeat(2 * 1024 * 1024 + 1), new (class extends Uint8Array {})(encoded)]) {
    const client = await clientForFetch('client-invalid-byte-chunk', async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/api/v1/agent/bytes', operation: 'agent.bytes' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
    );
  }
  assert.equal(accessorCalls, 0);
});

test('rejects pre-consumed and locked exact responses before parsing a suffix', async () => {
  const encoder = new TextEncoder();
  const disturbed = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('untrusted-prefix'));
      controller.enqueue(encoder.encode('{"apiVersion":"1","ok":true,"operation":"agent.disturbed","data":{"accepted":true}}'));
      controller.close();
    },
  }), { headers: { 'content-type': 'application/json' } });
  const disturbedReader = disturbed.body?.getReader();
  assert.equal((await disturbedReader?.read())?.done, false);
  disturbedReader?.releaseLock();
  const disturbedClient = await clientForFetch('client-disturbed-response', async () => disturbed);
  await assert.rejects(
    () => disturbedClient.request({ method: 'GET', path: '/api/v1/agent/disturbed', operation: 'agent.disturbed' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
  );

  const locked = jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.locked', data: { accepted: true } });
  const lockedReader = locked.body?.getReader();
  try {
    const lockedClient = await clientForFetch('client-locked-response', async () => locked);
    await assert.rejects(
      () => lockedClient.request({ method: 'GET', path: '/api/v1/agent/locked', operation: 'agent.locked' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
    );
  } finally {
    lockedReader?.releaseLock();
  }
});

test('bounds zero-byte response chunk floods', async () => {
  let cancelCalls = 0;
  const flood = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 8_193; index += 1) controller.enqueue(new Uint8Array());
    },
    cancel() {
      cancelCalls += 1;
    },
  }), { headers: { 'content-type': 'application/json' } });
  const floodClient = await clientForFetch('client-zero-chunk-flood', async () => flood);
  await assert.rejects(
    () => floodClient.request({ method: 'GET', path: '/api/v1/agent/flood', operation: 'agent.flood' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
  );
  assert.equal(cancelCalls, 1);
});

test('preserves response read and cleanup failures in causal order', async () => {
  const request = { method: 'GET' as const, path: '/api/v1/agent/cleanup', operation: 'agent.cleanup' };
  const failedBody = (failure: Error) => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  }), { headers: { 'content-type': 'application/json' } });

  const readFailure = new Error('response-read-sentinel');
  const singleCleanupClient = await clientForFetch('client-single-cleanup-failure', async () => failedBody(readFailure));
  await assert.rejects(singleCleanupClient.request(request), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    const failures = error instanceof AggregateError ? error.errors : [];
    assert.equal(failures.length, 2);
    assert.equal(failures[0], readFailure);
    assert.equal(failures[1] instanceof Error && 'code' in failures[1] && failures[1].code === 'INTEGRITY_ERROR', true);
    return true;
  });

  const readerPrototype = ReadableStreamDefaultReader.prototype;
  const releaseDescriptor = Object.getOwnPropertyDescriptor(readerPrototype, 'releaseLock');
  assert.ok(releaseDescriptor);
  const releaseFailure = new Error('response-release-sentinel');
  Object.defineProperty(readerPrototype, 'releaseLock', {
    ...releaseDescriptor,
    value: () => { throw releaseFailure; },
  });
  try {
    const combinedReadFailure = new Error('response-read-and-cleanup-sentinel');
    const combinedClient = await clientForFetch('client-combined-cleanup-failure', async () => failedBody(combinedReadFailure));
    await assert.rejects(combinedClient.request(request), (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      const failures = error instanceof AggregateError ? error.errors : [];
      assert.equal(failures.length, 3);
      assert.equal(failures[0], combinedReadFailure);
      for (const cleanup of failures.slice(1)) {
        assert.equal(cleanup instanceof Error && 'code' in cleanup && cleanup.code === 'INTEGRITY_ERROR', true);
      }
      assert.notEqual(failures[1], failures[2]);
      return true;
    });

    const valid = jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.cleanup', data: { accepted: true } });
    const releaseOnlyClient = await clientForFetch('client-release-only-failure', async () => valid);
    await assert.rejects(releaseOnlyClient.request(request), (error: unknown) => {
      assert.equal(error instanceof AggregateError, false);
      assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
      return true;
    });
  } finally {
    Object.defineProperty(readerPrototype, 'releaseLock', releaseDescriptor);
  }
});

test('maps exact local-protocol error envelopes without retrying', async () => {
  const cases: Array<{ code: string; status: number; message: string; details: Record<string, unknown>; retryAfter?: string }> = [
    { code: 'AUTHENTICATION_ERROR', status: 401, message: 'Authorization is invalid', details: {} },
    { code: 'CONFLICT', status: 409, message: 'Request conflicts with current state', details: {} },
    { code: 'BACKPRESSURE', status: 429, message: 'Service is busy', details: { retryAfterSeconds: 7 }, retryAfter: '7' },
  ];

  for (const [index, input] of cases.entries()) {
    let fetchCalls = 0;
    const client = await clientForFetch(`client-known-error-${index}`, async () => {
      fetchCalls += 1;
      return jsonResponse({
        apiVersion: '1',
        ok: false,
        operation: 'agent.error',
        error: { code: input.code, message: input.message, details: input.details },
      }, input.status, input.retryAfter === undefined ? {} : { 'retry-after': input.retryAfter });
    });
    await assert.rejects(
      () => client.request({
        method: input.code === 'CONFLICT' ? 'POST' : 'GET',
        path: '/api/v1/agent/error',
        operation: 'agent.error',
        ...(input.code === 'CONFLICT' ? { idempotencyKey: 'known-error-key' } : {}),
      }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === input.code, true);
        assert.equal(error instanceof Error && error.message, input.message);
        const details = error instanceof Error && 'details' in error && error.details !== null
          && typeof error.details === 'object' && !Array.isArray(error.details)
          ? error.details as Record<string, unknown>
          : {};
        assert.equal(JSON.stringify(details).includes('known-error-key'), false);
        if (input.code === 'BACKPRESSURE') assert.equal(details.retryAfterSeconds, 7);
        return true;
      },
    );
    assert.equal(fetchCalls, 1);
  }
});

test('rejects HTTP status, error code, and Retry-After contradictions', async () => {
  const responses = [
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'Conflict', details: {} } }, 500),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'BACKPRESSURE', message: 'Busy', details: {} } }, 429),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'BACKPRESSURE', message: 'Busy', details: {} } }, 429, { 'retry-after': '7' }),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'BACKPRESSURE', message: 'Busy', details: { retryAfterSeconds: 8 } } }, 429, { 'retry-after': '7' }),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'BACKPRESSURE', message: 'Busy', details: { retryAfterSeconds: 0 } } }, 429, { 'retry-after': '0' }),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'BACKPRESSURE', message: 'Busy', details: { retryAfterSeconds: 61 } } }, 429, { 'retry-after': '61' }),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'Conflict', details: {} } }, 409, { 'retry-after': '7' }),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'PARTIAL_FAILURE', message: 'Partial', details: {} } }, 500),
  ];

  for (const [index, response] of responses.entries()) {
    const client = await clientForFetch(`client-contradictory-error-${index}`, async () => response);
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/api/v1/agent/error', operation: 'agent.error' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
    );
  }
});

test('rejects unknown or unsafe error envelopes without returning their content', async () => {
  const responses = [
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'UNKNOWN_CODE', message: 'unknown', details: {} } }, 500),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'unsafe-error-key', details: {} } }, 409),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'Request conflicts with current state', details: { revision: 3 } } }, 409),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'unsafe', details: { authorization: 'header-secret' } } }, 409),
    jsonResponse({ apiVersion: '1', ok: false, operation: 'agent.error', error: { code: 'CONFLICT', message: 'unsafe', details: { body: 'request-body-secret' } } }, 409),
  ];

  for (const [index, response] of responses.entries()) {
    const client = await clientForFetch(`client-unsafe-error-${index}`, async () => response);
    await assert.rejects(
      () => client.request({ method: index === 1 ? 'POST' : 'GET', path: '/api/v1/agent/error', operation: 'agent.error', ...(index === 1 ? { idempotencyKey: 'unsafe-error-key' } : {}) }),
      (error: unknown) => {
        assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
        assert.equal(error instanceof Error && error.message, 'Server response is invalid');
        const details = error instanceof Error && 'details' in error && error.details !== null
          && typeof error.details === 'object'
          ? JSON.stringify(error.details)
          : '';
        assert.equal(details.includes('header-secret'), false);
        assert.equal(details.includes('request-body-secret'), false);
        return true;
      },
    );
  }
});

test('rejects server errors that echo a request-body value', async () => {
  const client = await clientForFetch('client-error-body-echo', async () => jsonResponse({
    apiVersion: '1',
    ok: false,
    operation: 'agent.echo',
    error: {
      code: 'CONFLICT',
      message: 'request-body-secret',
      details: { echo: 'request-body-secret' },
    },
  }, 409));

  await assert.rejects(
    () => client.request({
      method: 'POST',
      path: '/api/v1/agent/echo',
      operation: 'agent.echo',
      body: { secret: 'request-body-secret' },
      idempotencyKey: 'body-echo-key',
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR', true);
      assert.equal(error instanceof Error && error.message, 'Server response is invalid');
      return true;
    },
  );
});

test('maps only exact network failures and propagates programming errors and caller aborts without retrying', async () => {
  const writeKey = 'network-write-key';
  let networkCalls = 0;
  const networkCause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:49152'), {
    errno: -61,
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port: 49152,
  });
  const networkClient = await clientForFetch('client-network-failure', async () => {
    networkCalls += 1;
    throw new TypeError('fetch failed', { cause: networkCause });
  });
  await assert.rejects(
    () => networkClient.request({ method: 'POST', path: '/api/v1/agent/network', operation: 'agent.network', body: { value: 'request-secret' }, idempotencyKey: writeKey }),
    (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE', true);
      assert.equal(error instanceof Error && error.message, 'Kiokuko server is unavailable');
      const details = error instanceof Error && 'details' in error ? JSON.stringify(error.details) : '';
      assert.equal(details, '{}');
      assert.equal(error instanceof Error && error.message.includes('network-write-key'), false);
      assert.equal(error instanceof Error && error.message.includes('127.0.0.1'), false);
      return true;
    },
  );
  assert.equal(networkCalls, 1);

  const codedProgrammingSentinel = Object.assign(new Error('not a native fetch failure'), { code: 'ECONNREFUSED' });
  const codedProgrammingClient = await clientForFetch('client-coded-programming-failure', async () => {
    throw codedProgrammingSentinel;
  });
  await assert.rejects(
    () => codedProgrammingClient.request({
      method: 'GET', path: '/api/v1/agent/coded-programming', operation: 'agent.coded-programming',
    }),
    (error: unknown) => error === codedProgrammingSentinel,
  );

  const plainCauseSentinel = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  const plainCauseClient = await clientForFetch('client-plain-network-cause', async () => {
    throw plainCauseSentinel;
  });
  await assert.rejects(
    () => plainCauseClient.request({ method: 'GET', path: '/api/v1/agent/plain-cause', operation: 'agent.plain-cause' }),
    (error: unknown) => error === plainCauseSentinel,
  );

  const extendedNetworkFailure = Object.assign(new TypeError('fetch failed', { cause: networkCause }), { extra: true });
  const extendedNetworkClient = await clientForFetch('client-extended-network-failure', async () => {
    throw extendedNetworkFailure;
  });
  await assert.rejects(
    () => extendedNetworkClient.request({ method: 'GET', path: '/api/v1/agent/extended-network', operation: 'agent.extended-network' }),
    (error: unknown) => error === extendedNetworkFailure,
  );

  const programmingSentinel = new Error('programming sentinel');
  let programmingCalls = 0;
  const programmingClient = await clientForFetch('client-programming-failure', async () => {
    programmingCalls += 1;
    throw programmingSentinel;
  });
  await assert.rejects(
    () => programmingClient.request({ method: 'GET', path: '/api/v1/agent/programming', operation: 'agent.programming' }),
    (error: unknown) => error === programmingSentinel,
  );
  assert.equal(programmingCalls, 1);

  let abortCalls = 0;
  const abortSentinel = Object.assign(new Error('caller aborted'), { code: 'ECONNRESET' });
  const controller = new AbortController();
  const abortClient = await clientForFetch('client-abort', async () => {
    abortCalls += 1;
    controller.abort(abortSentinel);
    throw abortSentinel;
  });
  await assert.rejects(
    () => abortClient.request({ method: 'GET', path: '/api/v1/agent/abort', operation: 'agent.abort', signal: controller.signal }),
    (error: unknown) => error === abortSentinel,
  );
  assert.equal(abortCalls, 1);

  const preAbortSentinel = new Error('pre-aborted caller');
  const preAborted = new AbortController();
  preAborted.abort(preAbortSentinel);
  let preAbortCalls = 0;
  const preAbortClient = await clientForFetch('client-pre-abort', async () => {
    preAbortCalls += 1;
    throw new Error('pre-aborted request must not invoke fetch');
  });
  await assert.rejects(
    () => preAbortClient.request({ method: 'GET', path: '/api/v1/agent/pre-abort', operation: 'agent.pre-abort', signal: preAborted.signal }),
    (error: unknown) => error === preAbortSentinel,
  );
  assert.equal(preAbortCalls, 0);

  const resolvedAbort = new AbortController();
  const resolvedAbortSentinel = new Error('abort before fetch resolution');
  const resolvedAbortClient = await clientForFetch('client-resolved-abort', async () => {
    resolvedAbort.abort(resolvedAbortSentinel);
    return jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.abort-resolved', data: { accepted: true } });
  });
  await assert.rejects(
    () => resolvedAbortClient.request({
      method: 'GET', path: '/api/v1/agent/abort-resolved', operation: 'agent.abort-resolved', signal: resolvedAbort.signal,
    }),
    (error: unknown) => error === resolvedAbortSentinel,
  );

  const invalidReturn = { status: 200 };
  const invalidReturnClient = await clientForFetch('client-non-response', async () => invalidReturn as never);
  await assert.rejects(
    () => invalidReturnClient.request({ method: 'GET', path: '/api/v1/agent/non-response', operation: 'agent.non-response' }),
    (error: unknown) => error instanceof TypeError && error.message === 'Fetch implementation returned a non-Response value',
  );

  let proxyTrapCalls = 0;
  const proxiedError = new Proxy(new Error('proxied programming sentinel'), {
    getPrototypeOf() {
      proxyTrapCalls += 1;
      throw new Error('error proxy prototype trap must not run');
    },
  });
  const proxiedErrorClient = await clientForFetch('client-proxied-error', async () => { throw proxiedError; });
  await assert.rejects(
    () => proxiedErrorClient.request({ method: 'GET', path: '/api/v1/agent/proxied-error', operation: 'agent.proxied-error' }),
    (error: unknown) => error === proxiedError,
  );
  const proxiedResponse = new Proxy(jsonResponse({
    apiVersion: '1', ok: true, operation: 'agent.proxied-response', data: { accepted: true },
  }), {
    getPrototypeOf() {
      proxyTrapCalls += 1;
      throw new Error('response proxy prototype trap must not run');
    },
  });
  const proxiedResponseClient = await clientForFetch('client-proxied-response', async () => proxiedResponse);
  await assert.rejects(
    () => proxiedResponseClient.request({ method: 'GET', path: '/api/v1/agent/proxied-response', operation: 'agent.proxied-response' }),
    (error: unknown) => error instanceof TypeError,
  );
  assert.equal(proxyTrapCalls, 0);
});

test('caller abort interrupts non-settling fetches and cancels pending response readers', async () => {
  const fetchAbort = new AbortController();
  const fetchReason = new Error('abort non-settling fetch');
  const pendingFetchClient = await clientForFetch('client-pending-fetch-abort', async () => new Promise<Response>(() => {}));
  const pendingFetch = pendingFetchClient.request({
    method: 'GET', path: '/api/v1/agent/pending-fetch', operation: 'agent.pending-fetch', signal: fetchAbort.signal,
  });
  queueMicrotask(() => fetchAbort.abort(fetchReason));
  await assert.rejects(pendingFetch, (error: unknown) => error === fetchReason);

  let cancelCalls = 0;
  let markReaderPending: (() => void) | undefined;
  const readerPending = new Promise<void>((resolve) => { markReaderPending = resolve; });
  const readerAbort = new AbortController();
  const readerReason = new Error('abort pending reader');
  const pendingBody = new Response(new ReadableStream<Uint8Array>({
    pull() {
      markReaderPending?.();
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelCalls += 1;
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  const pendingReaderClient = await clientForFetch('client-pending-reader-abort', async () => pendingBody);
  const pendingReader = pendingReaderClient.request({
    method: 'GET', path: '/api/v1/agent/pending-reader', operation: 'agent.pending-reader', signal: readerAbort.signal,
  });
  await readerPending;
  readerAbort.abort(readerReason);
  await assert.rejects(pendingReader, (error: unknown) => error === readerReason);
  assert.equal(cancelCalls, 1);

  const failedCancelReason = new Error('abort with failed cancellation');
  const cancelFailure = new Error('source cancellation failed');
  const failedCancelController = new AbortController();
  let markFailedCancelPending: (() => void) | undefined;
  const failedCancelPending = new Promise<void>((resolve) => { markFailedCancelPending = resolve; });
  const failedCancelBody = new Response(new ReadableStream<Uint8Array>({
    pull() {
      markFailedCancelPending?.();
      return new Promise<void>(() => {});
    },
    cancel() {
      throw cancelFailure;
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  const failedCancelClient = await clientForFetch('client-failed-reader-cancel', async () => failedCancelBody);
  const failedCancelRequest = failedCancelClient.request({
    method: 'GET', path: '/api/v1/agent/failed-cancel', operation: 'agent.failed-cancel',
    signal: failedCancelController.signal,
  });
  await failedCancelPending;
  failedCancelController.abort(failedCancelReason);
  await assert.rejects(failedCancelRequest, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    const failures = error instanceof AggregateError ? error.errors : [];
    assert.equal(failures[0], failedCancelReason);
    assert.equal(failures[1] instanceof Error && 'code' in failures[1] && failures[1].code === 'INTEGRITY_ERROR', true);
    return true;
  });

  const hungCancelReason = new Error('abort with hung cancellation');
  const hungCancelController = new AbortController();
  let markHungCancelPending: (() => void) | undefined;
  const hungCancelPending = new Promise<void>((resolve) => { markHungCancelPending = resolve; });
  const hungCancelBody = new Response(new ReadableStream<Uint8Array>({
    pull() {
      markHungCancelPending?.();
      return new Promise<void>(() => {});
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  const hungCancelClient = await clientForFetch('client-hung-reader-cancel', async () => hungCancelBody);
  const hungCancelRequest = hungCancelClient.request({
    method: 'GET', path: '/api/v1/agent/hung-cancel', operation: 'agent.hung-cancel',
    signal: hungCancelController.signal,
  });
  await hungCancelPending;
  hungCancelController.abort(hungCancelReason);
  await assert.rejects(hungCancelRequest, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    const failures = error instanceof AggregateError ? error.errors : [];
    assert.equal(failures[0], hungCancelReason);
    assert.equal(failures[1] instanceof Error && 'code' in failures[1] && failures[1].code === 'INTEGRITY_ERROR', true);
    return true;
  });
});

test('maps only the exact native mid-body transport signature', async () => {
  const local = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
    response.flushHeaders();
    response.write('{"apiVersion":"1","ok":true,"operation":"agent.partial","data":');
    setImmediate(() => response.destroy());
  });
  const directory = await temp('client-mid-body-transport');
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: local.baseUrl,
    pid: process.pid,
    capabilityToken: 'a'.repeat(64),
  }));
  try {
    const client = await createServerClient({ descriptorPath, isPidAlive: () => true });
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/api/v1/agent/partial', operation: 'agent.partial' }),
      (error: unknown) => {
        assert.equal(error instanceof AggregateError, true);
        const failures = error instanceof AggregateError ? error.errors : [];
        assert.equal(failures.length, 2);
        assert.equal(failures[0] instanceof Error && 'code' in failures[0] && failures[0].code === 'SERVICE_UNAVAILABLE', true);
        assert.equal(failures[1] instanceof Error && 'code' in failures[1] && failures[1].code === 'INTEGRITY_ERROR', true);
        return true;
      },
    );
  } finally {
    await close(local.server);
  }

  const sentinel = new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } });
  const sentinelClient = await clientForFetch('client-fake-terminated', async () => { throw sentinel; });
  await assert.rejects(
    () => sentinelClient.request({ method: 'GET', path: '/api/v1/agent/fake-terminated', operation: 'agent.fake-terminated' }),
    (error: unknown) => error === sentinel,
  );
});

test('runtime liveness programming failures propagate instead of being mislabeled as server absence', async () => {
  const directory = await temp('client-liveness-sentinel');
  const descriptorPath = path.join(directory, 'server.json');
  await writeRuntimeDescriptor(descriptorPath, createRuntimeDescriptor({
    databasePath: path.join(directory, 'kiokuko-ai.sqlite'),
    baseUrl: 'http://127.0.0.1:49152',
    pid: process.pid,
  }));
  const sentinel = new Error('liveness programming sentinel');
  await assert.rejects(
    () => createServerClient({ descriptorPath, isPidAlive: () => { throw sentinel; } }),
    (error: unknown) => error === sentinel,
  );
});

test('allows bounded read queries and enforces the exact health response contract', async () => {
  const requestedUrls: string[] = [];
  const client = await clientForFetch('client-query-health', async (input) => {
    requestedUrls.push(input);
    if (requestedUrls.length === 1) return jsonResponse({ apiVersion: '1', ok: true, operation: 'agent.list', data: { items: [] } });
    if (requestedUrls.length === 2) return jsonResponse({ ok: true });
    if (requestedUrls.length === 3) return jsonResponse({ ok: false }, 503);
    return new Response(null, { status: 204 });
  });

  const list = await client.request<{ items: unknown[] }>({
    method: 'GET',
    path: '/api/v1/agent/list?cursor=opaque-cursor&limit=10',
    operation: 'agent.list',
  });
  assert.deepEqual(list, { items: [] });
  assert.equal(requestedUrls[0], 'http://127.0.0.1:49152/api/v1/agent/list?cursor=opaque-cursor&limit=10');

  const health = await client.request<{ ok: true }>({ method: 'GET', path: '/health/ready', operation: 'health.ready' });
  assert.deepEqual(health, { ok: true });
  await assert.rejects(
    () => client.request({ method: 'GET', path: '/health/ready', operation: 'health.ready' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE',
  );
  await assert.rejects(
    () => client.request({ method: 'GET', path: '/health/ready', operation: 'health.ready' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
  );
});

test('client foundation has no SQLite import or direct-service fallback', async () => {
  const source = await readFile(new URL('../../src/client/server-client.ts', import.meta.url), 'utf8');
  assert.equal(/runtime-discovery|node:sqlite|better-sqlite|sqlite3|openConnection|directService|direct-service/i.test(source), false);
});
