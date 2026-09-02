import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import { createApp } from '../../src/server/app.js';
import { successEnvelope } from '../../src/serialization/envelope.js';
import type { V1RouteRequest } from '../../src/server/router.js';
import { MAX_STRICT_JSON_DEPTH } from '../../src/setup/strict-json.js';

const token = 'a'.repeat(64);

async function startApp(options: Parameters<typeof createApp>[0] = { expectedToken: token, readiness: () => true }): Promise<{ server: Server; url: string }> {
  const server = createServer(createApp(options));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not expose an address');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('GET /health/live returns only the minimal liveness JSON', async () => {
  const app = await startApp();
  try {
    const response = await fetch(`${app.url}/health/live`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await closeServer(app.server);
  }
});

test('GET /health/ready returns minimal readiness JSON after exact bearer authentication', async () => {
  const app = await startApp({ expectedToken: token, readiness: () => true });
  try {
    const response = await fetch(`${app.url}/health/ready`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await closeServer(app.server);
  }
});

test('GET /health/ready returns a fixed safe 401 envelope when bearer authorization is missing', async () => {
  const app = await startApp({ expectedToken: token, readiness: () => true });
  try {
    const response = await fetch(`${app.url}/health/ready`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'health.ready',
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Authorization is invalid',
        details: {},
      },
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await closeServer(app.server);
  }
});

test('unauthenticated /api/v1 requests return 401 before the injected route handler runs', async () => {
  let dispatched = false;
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      dispatched = true;
      return { accepted: true };
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/runs`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Authorization is invalid',
        details: {},
      },
    });
    assert.equal(dispatched, false);
  } finally {
    await closeServer(app.server);
  }
});

test('correctly authenticated unknown /api/v1 routes return a typed 404 envelope', async () => {
  const app = await startApp({ expectedToken: token, readiness: () => true });
  try {
    const response = await fetch(`${app.url}/api/v1/unknown`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
        details: {},
      },
    });
  } finally {
    await closeServer(app.server);
  }
});

test('authenticated /api/v1 requests dispatch to the injected handler', async () => {
  let receivedPath = '';
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: ({ url }: V1RouteRequest) => {
      receivedPath = url.pathname;
      return successEnvelope('agent.test', { accepted: true });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/test`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), successEnvelope('agent.test', { accepted: true }));
    assert.equal(receivedPath, '/api/v1/agent/test');
  } finally {
    await closeServer(app.server);
  }
});

test('authenticated v1 handlers receive a strict JSON object body', async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: ({ body }: V1RouteRequest) => {
      receivedBody = body;
      return successEnvelope('agent.body', { accepted: true });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/body`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiVersion: '1', value: 'safe' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(receivedBody, { apiVersion: '1', value: 'safe' });
  } finally {
    await closeServer(app.server);
  }
});

test('malformed v1 JSON returns a fixed 400 envelope without echoing the request body', async () => {
  const requestContent = '{"secret":"request-content-that-must-not-echo"';
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => successEnvelope('agent.body', { accepted: true }),
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/body`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: requestContent,
    });
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(text), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request is invalid',
        details: {},
      },
    });
    assert.equal(text.includes(requestContent), false);
  } finally {
    await closeServer(app.server);
  }
});

test('v1 JSON rejects invalid bytes and ambiguous or unsafe syntax before handler dispatch', async () => {
  let dispatches = 0;
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      dispatches += 1;
      return successEnvelope('agent.body', { accepted: true });
    },
  });
  const tooDeep = `${'{"value":'.repeat(MAX_STRICT_JSON_DEPTH + 1)}null${'}'.repeat(MAX_STRICT_JSON_DEPTH + 1)}`;
  const bodies: BodyInit[] = [
    '{"identity":"first","identity":"second"}',
    '{"nested":{"identity":"first","identity":"second"}}',
    '\uFEFF{"value":"safe"}',
    '{"value":1e999}',
    '{"value":"safe",}',
    '{/* comment */"value":"safe"}',
    tooDeep,
    new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x3a, 0xff, 0x7d]),
  ];
  try {
    for (const body of bodies) {
      const response = await fetch(`${app.url}/api/v1/agent/body`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
        },
        body,
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        apiVersion: '1',
        ok: false,
        operation: 'api.v1',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request is invalid',
          details: {},
        },
      });
    }
    assert.equal(dispatches, 0);
  } finally {
    await closeServer(app.server);
  }
});

test('oversized v1 bodies are bounded before handler dispatch and never echoed', async () => {
  let dispatched = false;
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      dispatched = true;
      return successEnvelope('agent.body', { accepted: true });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/body`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) }),
    });
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.equal(text.length < 1000, true);
    assert.equal(text.includes('x'.repeat(128)), false);
    assert.equal(dispatched, false);
  } finally {
    await closeServer(app.server);
  }
});

test('handler conflicts map to a fixed 409 envelope', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      throw new KiokukoError('CONFLICT', 'internal conflict containing secret', { request: 'do-not-return' });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/conflict`, {
      headers: { authorization: 'Bearer ' + token },
    });
    const text = await response.text();

    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(text), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'CONFLICT',
        message: 'Request conflicts with current state',
        details: {},
      },
    });
    assert.equal(text.includes('internal conflict containing secret'), false);
    assert.equal(text.includes('do-not-return'), false);
  } finally {
    await closeServer(app.server);
  }
});

test('handler usage errors map to a fixed 400 envelope', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      throw new KiokukoError('USAGE_ERROR', 'internal usage message', { input: 'do-not-return' });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/usage`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'USAGE_ERROR',
        message: 'Request is invalid',
        details: {},
      },
    });
  } finally {
    await closeServer(app.server);
  }
});

test('handler backpressure maps to 429 with a bounded Retry-After value', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      throw new KiokukoError('BACKPRESSURE', 'internal queue detail', { retryAfterSeconds: 7, secret: 'do-not-return' });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/queue`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '7');
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'BACKPRESSURE',
        message: 'Service is busy',
        details: { retryAfterSeconds: 7 },
      },
    });
  } finally {
    await closeServer(app.server);
  }
});

test('handler service-unavailable errors map to a fixed 503 envelope', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      throw new KiokukoError('SERVICE_UNAVAILABLE', 'internal unavailable detail', { path: 'do-not-return' });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/unavailable`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service unavailable',
        details: {},
      },
    });
  } finally {
    await closeServer(app.server);
  }
});

test('handler database errors map to a fixed 503 envelope', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      throw new KiokukoError('DATABASE_ERROR', 'raw database path and detail', { query: 'do-not-return' });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/database`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'DATABASE_ERROR',
        message: 'Database unavailable',
        details: {},
      },
    });
  } finally {
    await closeServer(app.server);
  }
});

test('handler security rejections map to a fixed 422 envelope', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      throw new KiokukoError('SECURITY_REJECTION', 'internal security detail', { matched: 'do-not-return' });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/security`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'SECURITY_REJECTION',
        message: 'Request rejected',
        details: {},
      },
    });
  } finally {
    await closeServer(app.server);
  }
});

test('handler integrity errors map to a fixed 500 envelope', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      throw new KiokukoError('INTEGRITY_ERROR', 'raw integrity detail', { token: 'do-not-return' });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/integrity`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'INTEGRITY_ERROR',
        message: 'Internal integrity error',
        details: {},
      },
    });
  } finally {
    await closeServer(app.server);
  }
});

test('unknown handler errors map to a fixed generic 500 envelope without raw details', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      throw new Error('raw internal message and stack detail');
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/unknown-error`, {
      headers: { authorization: 'Bearer ' + token },
    });
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(text), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'INTEGRITY_ERROR',
        message: 'Unexpected server error',
        details: {},
      },
    });
    assert.equal(text.includes('raw internal message and stack detail'), false);
  } finally {
    await closeServer(app.server);
  }
});

test('wrong bearer authorization returns 401 before the v1 handler runs', async () => {
  let dispatched = false;
  const wrongToken = 'b'.repeat(64);
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      dispatched = true;
      return successEnvelope('agent.test', { accepted: true });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/test`, {
      headers: { authorization: 'Bearer ' + wrongToken },
    });
    const text = await response.text();

    assert.equal(response.status, 401);
    assert.equal(text.includes(wrongToken), false);
    assert.equal(dispatched, false);
  } finally {
    await closeServer(app.server);
  }
});

test('readiness state false returns minimal unauthenticated-safe 503 JSON after auth', async () => {
  const app = await startApp({ expectedToken: token, readiness: { ready: false } });
  try {
    const response = await fetch(`${app.url}/health/ready`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
  } finally {
    await closeServer(app.server);
  }
});

test('OPTIONS on /api/v1 does not grant permissive CORS and still authenticates first', async () => {
  const app = await startApp({ expectedToken: token, readiness: () => true });
  try {
    const response = await fetch(`${app.url}/api/v1/unknown`, { method: 'OPTIONS' });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-origin') === '*', false);
  } finally {
    await closeServer(app.server);
  }
});

test('v1 body requests require application/json content type', async () => {
  let dispatches = 0;
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => {
      dispatches += 1;
      return successEnvelope('agent.body', { accepted: true });
    },
  });
  try {
    for (const contentType of [
      'text/plain',
      'application/jsonp',
      'application/json; charset=iso-8859-1',
      'application/json; charset=utf-8; charset=utf-8',
      'application/json; profile=unsafe',
    ]) {
      const response = await fetch(`${app.url}/api/v1/agent/body`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': contentType,
        },
        body: JSON.stringify({ value: 'safe' }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        apiVersion: '1',
        ok: false,
        operation: 'api.v1',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request is invalid',
          details: {},
        },
      });
    }
    assert.equal(dispatches, 0);
  } finally {
    await closeServer(app.server);
  }
});

test('oversized handler responses become bounded fixed 500 JSON', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => successEnvelope('agent.large', { value: 'x'.repeat(2 * 1024 * 1024) }),
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/large`, {
      headers: { authorization: 'Bearer ' + token },
    });
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.equal(text.length < 1000, true);
    assert.deepEqual(JSON.parse(text), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'INTEGRITY_ERROR',
        message: 'Internal integrity error',
        details: {},
      },
    });
  } finally {
    await closeServer(app.server);
  }
});

test('an injected handler that does not match a v1 route yields a safe typed 404', async () => {
  const app = await startApp({
    expectedToken: token,
    readiness: () => true,
    v1: () => undefined,
  });
  try {
    const response = await fetch(`${app.url}/api/v1/agent/unmatched`, {
      headers: { authorization: 'Bearer ' + token },
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      apiVersion: '1',
      ok: false,
      operation: 'api.v1',
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
        details: {},
      },
    });
  } finally {
    await closeServer(app.server);
  }
});
