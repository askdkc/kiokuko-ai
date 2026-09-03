import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { createRouter } from '../../src/server/router.js';
import { KiokukoError } from '../../src/errors.js';

const token = 'a'.repeat(64);

async function invoke(
  url: string,
  options: { readonly authorization?: string; readonly ready?: boolean } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  let status = 0;
  let body = '';
  const request = {
    method: 'GET',
    url,
    headers: options.authorization === undefined ? {} : { authorization: options.authorization },
  } as IncomingMessage;
  const response = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  await createRouter({ expectedToken: token, readiness: { ready: options.ready ?? true } })(request, response);
  return { status, body: JSON.parse(body) as unknown };
}

test('health surface exposes public liveness and authenticated readiness only', async () => {
  assert.deepEqual(await invoke('/health/live'), { status: 200, body: { ok: true } });
  assert.deepEqual(
    await invoke('/health/ready', { authorization: `Bearer ${token}` }),
    { status: 200, body: { ok: true } },
  );
  assert.deepEqual(
    await invoke(`/${['api', 'v1', 'agent', 'runs'].join('/')}`, { authorization: `Bearer ${token}` }),
    { status: 404, body: { ok: false } },
  );
});

test('readiness is authenticated and reports unavailable', async () => {
  await assert.rejects(
    () => invoke('/health/ready'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'AUTHENTICATION_ERROR',
  );
  assert.deepEqual(
    await invoke('/health/ready', { authorization: `Bearer ${token}`, ready: false }),
    { status: 503, body: { ok: false } },
  );
});
