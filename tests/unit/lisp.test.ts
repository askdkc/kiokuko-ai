import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LispWorker } from '../../src/lisp/worker.js';
import { registerOpenCodeLisp } from '../../src/opencode/lisp.js';
import { pluginContextFixture } from '../fixtures/opencode-v2-plugin.js';
const binary = process.env.KIOKUKO_TEST_SBCL ?? 'sbcl';
let available = false; try { execFileSync(binary, ['--version'], { stdio: 'ignore' }); available = true; } catch { /* optional external runtime */ }

test('SBCL state is session-local, errors recover and output overflow resets the actor', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-lisp-state-')); t.after(() => rm(base, { recursive: true, force: true }));
  const a = new LispWorker(base, binary), b = new LispWorker(base, binary); t.after(async () => { await a.stop(); await b.stop(); });
  const signal = new AbortController().signal;
  assert.match((await a.evaluate('(defparameter *probe* 40) (+ *probe* 2)', 5000, signal)).output, /42/u);
  assert.equal((await a.evaluate('(error "controlled")', 5000, signal)).status, 'error');
  assert.match((await a.evaluate('(incf *probe*)', 5000, signal)).output, /41/u);
  assert.match((await b.evaluate("(boundp '*probe*)", 5000, signal)).output, /NIL/u);
  const large = await a.evaluate('(loop repeat 50000 do (write-char #\\x))', 5000, signal);
  assert.equal(large.status, 'output_limit'); assert.ok(Buffer.byteLength(large.output) <= 32768); assert.equal(a.stopped, true);
});

test('SBCL timeout and interruption remove ordinary descendants, and a fresh actor recovers', { skip: !available || process.platform === 'win32' }, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-lisp-cancel-')); t.after(() => rm(base, { recursive: true, force: true }));
  for (const timeout of [true, false]) {
    const worker = new LispWorker(base, binary); t.after(() => worker.stop());
    const pidfile = path.join(base, timeout ? 'timeout.pid' : 'abort.pid');
    const code = `(let ((p (sb-ext:run-program "/bin/sleep" '("60") :wait nil))) (with-open-file (s ${JSON.stringify(pidfile)} :direction :output :if-exists :supersede) (write (sb-ext:process-pid p) :stream s)) (sleep 60))`;
    const controller = new AbortController();
    const operation = worker.evaluate(code, timeout ? 8000 : 15000, controller.signal);
    const rejected = assert.rejects(operation, timeout ? /lisp_timeout/u : /lisp_cancelled/u);
    let pid = 0;
    for (let i = 0; i < 600; i++) { try { pid = Number(await readFile(pidfile, 'utf8')); if (pid) break; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(pid > 0, 'actual child started');
    if (!timeout) controller.abort();
    await rejected; await worker.stop();
    await assert.rejects(async () => { for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch (error) { throw error; } await new Promise(resolve => setTimeout(resolve, 10)); } }, { code: 'ESRCH' });
  }
  const recovered = new LispWorker(base, binary); t.after(() => recovered.stop());
  assert.match((await recovered.evaluate('(+ 20 22)', 5000, new AbortController().signal)).output, /42/u);
});

test('native Lisp dispatch binds actual arguments, session, call and current turn; controls revoke pending calls', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-lisp-binding-')); t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = pluginContextFixture(base), lifetime = new AbortController();
  const surface = await registerOpenCodeLisp(fixture.ctx, lifetime.signal, { protocolVersion: 1, packageVersion: 'fixture', nodeExecutable: process.execPath, cliScript: path.resolve('dist/bin/kiokuko.js') }); t.after(() => surface.dispose());
  const tool = fixture.tools[0] as { name: string; options: { permission: string }; execute(input: unknown, call: unknown): Promise<unknown> };
  assert.equal(tool.name, 'kiokuko_lisp'); assert.equal(tool.options.permission, 'kiokuko_lisp');
  const call = { sessionID: 'ses_1', messageID: 'assistant-1', id: 'call-1', signal: new AbortController().signal };
  const input = { code: '(+ 1 2)' };
  const hook = async (name: string, value: unknown) => fixture.hooks.get(name)!(value as never);
  const prepare = () => hook('tool:execute.before', { ...call, tool: tool.name, input });
  await assert.rejects(tool.execute(input, call), /binding_changed/u);
  await hook('session:prompt', { sessionID: 'ses_1', messageID: 'user-1' });
  await prepare(); await assert.rejects(tool.execute({ code: '(+ 40 2)' }, call), /binding_changed/u);
  await prepare(); await assert.rejects(tool.execute(input, { ...call, sessionID: 'ses_2' }), /binding_changed/u);
  await prepare(); await assert.rejects(tool.execute(input, { ...call, id: 'call-2' }), /binding_changed/u);
  await prepare(); await hook('session:prompt', { sessionID: 'ses_1', messageID: 'user-2' });
  await assert.rejects(tool.execute(input, call), /binding_changed/u);
  await prepare();
  const commands = fixture.commands as Array<{ name: string; execute(call: unknown): Promise<void> }>;
  await commands.find(item => item.name.endsWith('disable'))!.execute(call);
  await assert.rejects(tool.execute(input, call), /disabled/u); await assert.rejects(prepare(), /disabled/u);
  await commands.find(item => item.name.endsWith('enable'))!.execute(call);
  await assert.rejects(tool.execute(input, call), /binding_changed/u);
  if (available) { await prepare(); assert.match(JSON.stringify(await tool.execute(input, call)), /3/u); await assert.rejects(tool.execute(input, call), /binding_changed/u); }
});

test('native controls revoke admission during async session checks, and configuration disable cannot be enabled by a call', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-lisp-revoke-')); t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = pluginContextFixture(base), lifetime = new AbortController();
  const surface = await registerOpenCodeLisp(fixture.ctx, lifetime.signal); t.after(() => surface.dispose());
  const tools = fixture.tools as Array<{ execute(input: unknown, call: unknown): Promise<unknown> }>;
  const commands = fixture.commands as Array<{ name: string; execute(call: unknown): Promise<void> }>;
  const call = { sessionID: 'ses_1', messageID: 'a', id: 'c', signal: new AbortController().signal }, input = { code: '(+ 20 22)' };
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  t.mock.method(fixture.ctx.session, 'get', () => pending as never);
  await fixture.hooks.get('tool:execute.before')!({ ...call, input, tool: 'kiokuko_lisp' } as never);
  const running = tools[0]!.execute(input, call);
  const rejected = assert.rejects(running, /binding_changed/u);
  await commands.find(command => command.name.endsWith('disable'))!.execute(call);
  await commands.find(command => command.name.endsWith('enable'))!.execute(call);
  release({ id: 'ses_1', projectID: 'prj', location: { directory: base } }); await rejected;
  const off = pluginContextFixture(base); (off.ctx.options as Record<string, unknown>).lisp = { enabled: false };
  const offSurface = await registerOpenCodeLisp(off.ctx, lifetime.signal); t.after(() => offSurface.dispose());
  await (off.commands as typeof commands).find(command => command.name.endsWith('enable'))!.execute(call);
  await assert.rejects(async () => off.hooks.get('tool:execute.before')!({ ...call, input, tool: 'kiokuko_lisp' } as never), /disabled/u);
});

test('host output bound remains effective when evaluated Lisp changes its own printing state', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-lisp-host-bound-')); t.after(() => rm(base, { recursive: true, force: true }));
  const worker = new LispWorker(base, binary); t.after(() => worker.stop());
  await assert.rejects(worker.evaluate('(setf kiokuko-wire::*remaining* 100000) (loop repeat 40000 do (write-char #\\x))', 5000, new AbortController().signal), /lisp_output_limit_state_reset/u);
  assert.equal(worker.stopped, true);
});
