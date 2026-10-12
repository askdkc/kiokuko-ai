import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDoctor } from '../../src/commands/doctor.js';
import { initializeDatabase } from '../../src/commands/init.js';

for (const scenario of ['active', 'retry', 'location-mismatch', 'disconnected', 'http-error', 'malformed'] as const) {
  test(`doctor host preserves the OpenCode HTTP contract: ${scenario}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-doctor-host-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, 'memory.sqlite');
    await initializeDatabase({ databasePath });
    const previousPassword = process.env.OPENCODE_PASSWORD;
    process.env.OPENCODE_PASSWORD = 'fixture-password';
    t.after(() => {
      if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD;
      else process.env.OPENCODE_PASSWORD = previousPassword;
    });
    let pluginCalls = 0;
    let mcpCalls = 0;
    t.mock.method(globalThis, 'fetch', async (input: URL | string, init: RequestInit) => {
      const url = new URL(input);
      assert.equal(init.method, 'GET');
      assert.equal(url.searchParams.get('location[directory]'), process.cwd());
      assert.equal(new Headers(init.headers).get('Authorization'), `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`);
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      if (scenario === 'http-error') return new Response('{}', { status: 500 });
      if (scenario === 'malformed') return new Response('not json', { headers: { 'Content-Type': 'application/json' } });
      const location = { directory: scenario === 'location-mismatch' ? '/other-project' : process.cwd() };
      if (url.pathname === '/base/api/plugin') {
        pluginCalls++;
        return Response.json({ location, data: scenario === 'retry' && pluginCalls === 1 ? [] : [
          { id: 'kiokuko-ai', state: { status: 'active' }, source: { type: 'package', target: 'kiokuko-ai@0.2.5' } },
        ] });
      }
      assert.equal(url.pathname, '/base/api/mcp');
      mcpCalls++;
      return Response.json({ location, data: [{ name: 'kiokuko', status: { status: scenario === 'disconnected' ? 'disconnected' : 'connected' } }] });
    });
    const result = await runDoctor({ databasePath, opencodeUrl: 'http://localhost:4096/base',
      runtimeDescriptorPath: path.join(directory, 'runtime.json') });
    const host = result.checks.openCodeHost;
    assert.equal(host.ok, scenario === 'active' || scenario === 'retry');
    if (host.ok) {
      assert.equal(host.count, 0);
      assert.equal(pluginCalls, scenario === 'retry' ? 2 : 1);
      assert.equal(mcpCalls, 1);
    } else if (scenario === 'http-error' || scenario === 'malformed') {
      assert.equal(host.detail, 'runtime=unavailable');
    } else {
      assert.equal(host.count, 1);
    }
  });
}
