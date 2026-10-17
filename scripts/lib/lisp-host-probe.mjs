import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Scenario extension of the existing packaged host harness, with fixture model responses. */
export function lispHostProbe() {
  let active, sequence = 0, schemaSeen = false, correlatedResults = 0;
  return {
    respond(body) {
      if (!active) return undefined;
      if (active.callId === undefined) {
        if (!(body.tools ?? []).length) return undefined;
        const tool = (body.tools ?? []).find(item => (item.function?.name ?? item.name) === 'kiokuko_lisp');
        if (!active.allowed) { active.deniedByCatalog = tool === undefined; if (tool) active.failure = 'native_deny_exposed_lisp'; return { text: 'Native policy fixture completed.' }; }
        if (!tool) { active.failure = 'lisp_schema_missing'; return { text: 'Lisp fixture schema unavailable.' }; }
        if (tool) { const input = tool.function?.parameters ?? tool.input_schema; assert.ok(input?.properties?.code); schemaSeen = true; }
        active.callId = `lisp-host-${++sequence}`;
        return { toolCalls: [{ id: active.callId, type: 'function', function: { name: 'kiokuko_lisp', arguments: JSON.stringify(active.input) } }] };
      }
      const result = (body.messages ?? []).findLast(message => message.role === 'tool' && message.tool_call_id === active.callId);
      if (result && active.delivered === undefined) { active.delivered = result; correlatedResults++; }
      return { text: 'Lisp fixture turn continued after tool dispatch.' };
    },
    async run(client, location) {
      const create = effect => client.session.create({ location, model: { providerID: 'fixture', id: 'fixture-model' },
        permissions: [{ action: 'kiokuko_lisp', resource: '*', effect }] });
      const allowed = await create('allow'), other = await create('allow'), denied = await create('deny');
      const invoke = async (session, code, expectation, { timeoutMs = 10000, allowed = true, status = 'ok' } = {}) => {
        active = { allowed, input: { code, timeoutMs } };
        try {
          await client.session.prompt({ sessionID: session.id, text: `Run the controlled Common Lisp scenario ${sequence + 1}.` });
          await client.session.wait({ sessionID: session.id });
          const messages = await client.session.context({ sessionID: session.id });
          assert.equal(active.failure, undefined, active.failure);
          const tools = messages.flatMap(message => message.type === 'assistant' ? message.content ?? [] : []).filter(part => part.type === 'tool');
          if (!allowed) { assert.equal(active.deniedByCatalog, true); return { denied: true }; }
          assert.ok(active.delivered, `tool result must reach the next model request: ${code.slice(0,64)}`);
          const content = active.delivered.content;
          assert.ok(typeof content === 'string' || Array.isArray(content), 'tool result content is missing');
          const text = typeof content === 'string' ? content : content.filter(part => part?.type === 'text').map(part => part.text).join('\n');
          if (status === null) assert.match(text, expectation);
          else {
            const result = JSON.parse(text);
            assert.equal(result.status, status);
            assert.equal(result.verification, 'untrusted_execution_output');
            assert.equal(typeof result.output, 'string');
            assert.ok(Buffer.byteLength(result.output) <= 32768);
            if (expectation) assert.match(result.output, expectation);
            if (status === 'output_limit') assert.equal(result.stateReset, true);
          }
          assert.ok(messages.some(message => message.type === 'assistant' && message.time.completed !== undefined));
          return { delivered: active.delivered, tools };
        } finally { active = undefined; }
      };
      await invoke(allowed, '(defparameter *host-value* 40) (+ *host-value* 2)', /42/u);
      await invoke(allowed, '(incf *host-value*)', /41/u);
      await invoke(other, "(boundp '*host-value*)", /NIL/u);
      await invoke(allowed, '(error "controlled-host-error")', /controlled-host-error/u, { status: 'error' });
      await invoke(allowed, '*host-value*', /41/u);
      const http = createServer((_request, response) => response.end('kiokuko-lisp-localhost-proof'));
      await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${http.address().port}/`;
        await invoke(allowed, `(sb-ext:run-program "/usr/bin/curl" '("--silent" "--show-error" "--max-time" "3" "${url}") :output *standard-output*)`, /kiokuko-lisp-localhost-proof/u, { timeoutMs: 20000 });
      } finally { await new Promise(resolve => http.close(resolve)); }
      const pidfile = path.join(location.directory, 'lisp-owned-child.pid');
      active = { allowed: true, input: { code: `(let ((p (sb-ext:run-program "/bin/sleep" '("60") :wait nil))) (with-open-file (s ${JSON.stringify(pidfile)} :direction :output :if-exists :supersede) (write (sb-ext:process-pid p) :stream s)) (sleep 60))`, timeoutMs: 20000 } };
      try {
        await client.session.prompt({ sessionID: allowed.id, text: 'Run the controlled interrupt scenario.' });
        let pid = 0;
        for (let attempt = 0; attempt < 200; attempt++) {
          try { pid = Number(await readFile(pidfile, 'utf8')); if (pid > 0) break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(pid > 0, 'real descendant must start before native interruption');
        process.kill(pid, 0);
        await client.session.interrupt({ sessionID: allowed.id });
        await client.session.wait({ sessionID: allowed.id });
        let gone = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } throw error; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(gone, true, 'native interruption must remove the actual descendant');
      } finally { active = undefined; }
      await invoke(allowed, '(+ 20 22)', /42/u);
      await invoke(allowed, '(sleep 60)', /lisp_timeout_state_reset/u, { timeoutMs: 100, status: null });
      await invoke(allowed, "(boundp '*host-value*)", /NIL/u);
      await invoke(allowed, '(loop repeat 50000 do (write-char #\\x))', null, { status: 'output_limit' });
      await client.session.command({ sessionID: allowed.id, name: 'kiokuko-lisp-disable', text: '' });
      await client.session.wait({ sessionID: allowed.id });
      await invoke(allowed, '(+ 20 22)', /lisp_disabled/u, { status: null });
      await client.session.command({ sessionID: allowed.id, name: 'kiokuko-lisp-enable', text: '' });
      await client.session.wait({ sessionID: allowed.id });
      await invoke(allowed, '(+ 20 22)', /42/u);
      const deniedFile = path.join(location.directory, 'lisp-denied-effect');
      await invoke(denied, `(with-open-file (s ${JSON.stringify(deniedFile)} :direction :output) (write-line "must-not-run" s))`, /denied|rejected|permission|not allowed|not available/iu, { allowed: false });
      await assert.rejects(access(deniedFile), { code: 'ENOENT' });
      await client.session.prompt({ sessionID: denied.id, text: 'Finish this ordinary conversation without tools.' });
      await client.session.wait({ sessionID: denied.id });
      assert.ok((await client.session.context({ sessionID: denied.id })).some(message => message.type === 'assistant' && message.time.completed !== undefined));
      return { schemaSeen, evaluation: true, continuation: true, correlatedToolResults: correlatedResults, processAndLocalhost: true, stateAndIsolation: true,
        outputBound: true, nativeInterruptionAndDescendantCleanup: true, timeoutRecovery: true, disableReenable: true, nativeDenial: 'catalog_filtered_effect_zero',
        realModelQuality: false, nativeHumanApproval: false };
    },
  };
}
