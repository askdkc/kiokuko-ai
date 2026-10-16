import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import path from 'node:path';

/** Scenario extension of the existing packaged host harness, with fixture model responses. */
export function lispHostProbe() {
  let active, sequence = 0, schemaSeen = false;
  return {
    respond(body) {
      if (!active) return undefined;
      if (!active.sent) {
        if (!(body.tools ?? []).length) return undefined;
        const tool = (body.tools ?? []).find(item => (item.function?.name ?? item.name) === 'kiokuko_lisp');
        if (!active.allowed) { assert.equal(tool, undefined, 'native deny must remove Lisp from the model tool catalog'); active.deniedByCatalog = true; return { text: 'Native policy makes Lisp unavailable; ordinary conversation continues.' }; }
        assert.ok(tool, 'model must receive the native Lisp tool schema');
        if (tool) { const input = tool.function?.parameters ?? tool.input_schema; assert.ok(input?.properties?.code); schemaSeen = true; }
        active.sent = true;
        return { toolCalls: [{ id: `lisp-host-${++sequence}`, type: 'function', function: { name: 'kiokuko_lisp', arguments: JSON.stringify(active.input) } }] };
      }
      const results = (body.messages ?? []).filter(message => message.role === 'tool');
      if (results.length) active.delivered = JSON.stringify(results.at(-1));
      return { text: 'Lisp fixture turn continued after tool dispatch.' };
    },
    async run(client, location) {
      const create = effect => client.session.create({ location, model: { providerID: 'fixture', id: 'fixture-model' },
        permissions: [{ action: 'kiokuko_lisp', resource: '*', effect }] });
      const allowed = await create('allow'), other = await create('allow'), denied = await create('deny');
      const invoke = async (session, code, expectation, timeoutMs = 10000, isAllowed = true) => {
        active = { sent: false, allowed: isAllowed, input: { code, timeoutMs } };
        try {
          await client.session.prompt({ sessionID: session.id, text: `Run the controlled Common Lisp scenario ${sequence + 1}.` });
          await client.session.wait({ sessionID: session.id });
          const messages = await client.session.context({ sessionID: session.id });
          const tools = messages.flatMap(message => message.type === 'assistant' ? message.parts ?? [] : []);
          if (!isAllowed) { assert.equal(active.deniedByCatalog, true); return { denied: true }; }
          assert.ok(active.delivered, `tool result must reach the next model request: ${code.slice(0,64)}`);
          assert.match(active.delivered, expectation);
          assert.ok(messages.some(message => message.type === 'assistant' && message.time.completed !== undefined));
          return { delivered: active.delivered, tools };
        } finally { active = undefined; }
      };
      await invoke(allowed, '(defparameter *host-value* 40) (+ *host-value* 2)', /42/u);
      await invoke(allowed, '(incf *host-value*)', /41/u);
      await invoke(other, "(boundp '*host-value*)", /NIL/u);
      await invoke(allowed, '(error "controlled-host-error")', /controlled-host-error/u);
      await invoke(allowed, '*host-value*', /41/u);
      const http = createServer((_request, response) => response.end('kiokuko-lisp-localhost-proof'));
      await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${http.address().port}/`;
        await invoke(allowed, `(sb-ext:run-program "/usr/bin/curl" '("--silent" "--show-error" "--max-time" "3" "${url}") :output *standard-output*)`, /kiokuko-lisp-localhost-proof/u, 20000);
      } finally { await new Promise(resolve => http.close(resolve)); }
      await invoke(allowed, '(sleep 60)', /lisp_timeout_state_reset/u, 100);
      await invoke(allowed, "(boundp '*host-value*)", /NIL/u);
      await invoke(allowed, '(loop repeat 50000 do (write-char #\\x))', /output_limit/u);
      await client.session.command({ sessionID: allowed.id, name: 'kiokuko-lisp-disable', text: '' });
      await client.session.wait({ sessionID: allowed.id });
      await invoke(allowed, '(+ 20 22)', /lisp_disabled/u);
      await client.session.command({ sessionID: allowed.id, name: 'kiokuko-lisp-enable', text: '' });
      await client.session.wait({ sessionID: allowed.id });
      await invoke(allowed, '(+ 20 22)', /42/u);
      const deniedFile = path.join(location.directory, 'lisp-denied-effect');
      await invoke(denied, `(with-open-file (s ${JSON.stringify(deniedFile)} :direction :output) (write-line "must-not-run" s))`, /denied|rejected|permission|not allowed|not available/iu, 10000, false);
      await assert.rejects(access(deniedFile), { code: 'ENOENT' });
      await client.session.prompt({ sessionID: denied.id, text: 'Finish this ordinary conversation without tools.' });
      await client.session.wait({ sessionID: denied.id });
      assert.ok((await client.session.context({ sessionID: denied.id })).some(message => message.type === 'assistant' && message.time.completed !== undefined));
      return { schemaSeen, evaluation: true, continuation: true, processAndLocalhost: true, stateAndIsolation: true,
        outputBound: true, timeoutRecovery: true, disableReenable: true, nativeDenial: 'catalog_filtered_effect_zero',
        realModelQuality: false, nativeHumanApproval: false };
    },
  };
}
