import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { packFixture } from '../fixtures/source-context.js';

// Transport fixture: proves contract handling, not real-host/model quality.
test('evaluation accepts a compatible newer host and rejects missing session API before model dispatch', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-evaluator-contract-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); await mkdir(root); execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, 'code.ts'), 'export function greet() { return 1; }\n');
  const binary = path.join(base, 'ripwire');
  await writeFile(binary, `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--version')?'ripwire 0.4.0':${JSON.stringify(JSON.stringify(packFixture()))});\n`, { mode: 0o700 });
  const permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', external_directory: 'deny' };
  let missing = false, dispatches = 0, sequence = 0;
  const server = createServer((request, response) => {
    const route = new URL(request.url!, 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    const send = (value: unknown) => response.end(JSON.stringify(value));
    if (route === '/global/health') return send({ healthy: true, version: '99.0.0' });
    if (route === '/config') return send({ plugin: [], mcp: {}, agent: Object.fromEntries(['ideal', 'zenki'].map(role => [`source-eval-${role}`, { model: 'fixture/model', steps: 8, permission }])) });
    if (route === '/session' && request.method === 'POST') {
      if (missing) { response.statusCode = 404; return send({ error: 'API unavailable' }); }
      return send({ id: `fixture-${++sequence}` });
    }
    if (/^\/session\/[^/]+\/message$/u.test(route)) {
      if (request.method === 'POST') { dispatches++; return send({}); }
      return send([{ info: { role: 'assistant', providerID: 'fixture', modelID: 'model', cost: 0,
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ type: 'text', text: 'Fixture report; task effects unverified.' }] }]);
    }
    if (request.method === 'DELETE') return send(true);
    response.statusCode = 404; send({ error: 'API unavailable' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const output = path.join(base, 'report.json');
  const env = { ...process.env, HOME: base, XDG_CONFIG_HOME: base, KIOKUKO_EVAL_ROOT: root,
    OPENCODE_EVAL_URL: `http://127.0.0.1:${address.port}`, KIOKUKO_TEST_RIPWIRE: binary,
    KIOKUKO_EVAL_IDEAL_MODEL: 'fixture/model', KIOKUKO_EVAL_ZENKI_MODEL: 'fixture/model',
    KIOKUKO_EVAL_COST_CAP: '1', KIOKUKO_EVAL_FIXTURE: '1' };
  const run = () => promisify(execFile)(process.execPath, [path.resolve('scripts/evaluate-source-llm.mjs'), output], { env, cwd: root, timeout: 20_000 });
  await run();
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.status, 'completed'); assert.equal(report.opencode, '99.0.0'); assert.equal(report.rows.length, 4);
  assert.equal(dispatches, 8);
  missing = true; dispatches = 0;
  await assert.rejects(run(), /HTTP 404/u); assert.equal(dispatches, 0);
});
