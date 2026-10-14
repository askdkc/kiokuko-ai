import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const helperUrl = pathToFileURL(path.resolve('scripts/lib/mcp-probe.mjs')).href;
const { probeMcpTools, callMcpTool } = await import(helperUrl);

async function fixture(t: test.TestContext, mode = 'delayed') {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-host-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = path.join(root, 'events.txt');
  const cliScript = path.join(root, 'server.mjs');
  await writeFile(cliScript, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mark = value => appendFileSync(process.env.PROBE_EVENTS, value + '\\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result}) + '\\n');
let initialized = false;
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    mark('initialize');
    setTimeout(() => { mark('initialized-response'); reply(request.id, {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}); }, 20);
  } else if (request.method === 'notifications/initialized') {
    initialized = true; mark('initialized-notification');
  } else if (request.method === 'tools/list' || request.method === 'tools/call') {
    if (!initialized) process.exit(13);
    mark('request');
    if (process.env.PROBE_MODE === 'exit') process.exit(12);
    if (process.env.PROBE_MODE === 'stall') return;
    if (process.env.PROBE_MODE === 'protocol-error') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'SECRET_TOKEN /private/user/path',data:{password:'SECRET_TOKEN'}}}) + '\\n');
      return;
    }
    if (process.env.PROBE_MODE === 'coded-error' || process.env.PROBE_MODE === 'unsafe-code') {
      reply(request.id, {isError:true,content:[{type:'text',text:'SECRET_TOKEN /private/user/path'}],structuredContent:{code:process.env.PROBE_MODE === 'coded-error'?'INTEGRITY_ERROR':'SECRET_TOKEN',retryable:false,message:'SECRET_TOKEN',details:{path:'/private/user/path'}}});
      return;
    }
    setTimeout(() => {
      mark('response');
      reply(request.id, request.method === 'tools/list'
        ? {tools:[{name:'task_prepare',inputSchema:{type:'object'}}]}
        : {content:[],structuredContent:{completed:true},...(process.env.PROBE_MODE === 'tool-error' ? {isError:true} : {})});
    }, 30);
  }
});
process.stdin.on('end', () => { mark('eof'); process.exit(0); });
`);
  return { options: { cliScript, cwd: root, environment: { ...process.env, PROBE_EVENTS: events, PROBE_MODE: mode }, timeoutMs: 3000 }, events };
}

for (const kind of ['list', 'call']) {
  test(`host MCP ${kind} probe waits for the handshake and delayed response before EOF`, async (t) => {
    const { options, events } = await fixture(t);
    const result = kind === 'list' ? await probeMcpTools(options) : await callMcpTool(options, 'task_prepare', {});
    if (kind === 'list') assert.equal(result[0].name, 'task_prepare');
    else assert.deepEqual(result, { completed: true });
    assert.deepEqual((await readFile(events, 'utf8')).trim().split('\n'), [
      'initialize', 'initialized-response', 'initialized-notification', 'request', 'response', 'eof',
    ]);
  });
}

test('host MCP probe reports an early process exit as connection closure, not timeout', async (t) => {
  const { options } = await fixture(t, 'exit');
  await assert.rejects(callMcpTool(options, 'task_prepare', {}), /MCP task_prepare failed \(-32000\)/u);
});

test('host MCP probe closes the child when a response never arrives', async (t) => {
  const { options, events } = await fixture(t, 'stall');
  await assert.rejects(callMcpTool({ ...options, timeoutMs: 1000 }, 'task_prepare', {}), /MCP task_prepare failed/u);
  assert.ok((await readFile(events, 'utf8')).endsWith('eof\n'));
});

test('host MCP probe rejects a tool error and still closes the child', async (t) => {
  const { options, events } = await fixture(t, 'tool-error');
  await assert.rejects(callMcpTool(options, 'task_prepare', {}), /MCP task_prepare failed/u);
  assert.ok((await readFile(events, 'utf8')).endsWith('eof\n'));
});

for (const mode of ['coded-error', 'unsafe-code', 'tool-error', 'protocol-error', 'exit', 'stall']) {
  test(`host MCP diagnostics classify ${mode} without revealing response bodies or paths`, async t => {
    const {options, events} = await fixture(t, mode);
    const expectedKind = mode === 'exit' ? 'connection-closed' : mode === 'stall' ? 'timeout' : mode === 'protocol-error' ? 'protocol-error' : 'tool-error';
    await assert.rejects(callMcpTool({...options, timeoutMs: mode === 'stall' ? 1000 : options.timeoutMs}, 'task_prepare', {}), (error: any) => {
      assert.equal(error.diagnostic?.kind, expectedKind);
      assert.equal(error.diagnostic?.phase, 'request');
      if (mode === 'coded-error') { assert.equal(error.diagnostic?.code, 'INTEGRITY_ERROR'); assert.equal(error.diagnostic?.retryable, false); }
      if (mode === 'unsafe-code' || mode === 'tool-error') assert.equal(error.diagnostic?.code, undefined);
      if (mode === 'protocol-error') assert.equal(error.diagnostic?.code, -32602);
      const serialized = JSON.stringify(error) + String(error.stack);
      assert.doesNotMatch(serialized, /SECRET_TOKEN|private\/user|Tool returned an error/);
      assert.ok(error.message.includes(JSON.stringify(error.diagnostic)), 'safe diagnostic must reach the existing CI message sink');
      return true;
    });
    if (mode !== 'exit') assert.ok((await readFile(events, 'utf8')).endsWith('eof\n'));
  });
}
test('host MCP diagnostics distinguish spawn failure from a tool response', async t => {
  const {options} = await fixture(t);
  await assert.rejects(callMcpTool({...options, cwd:path.join(options.cwd, 'missing')}, 'task_prepare', {}), (error:any) => {
    assert.deepEqual(error.diagnostic, {kind:'spawn-error',phase:'connect',code:'ENOENT'});
    assert.doesNotMatch(JSON.stringify(error) + String(error.stack), /server\.mjs|missing/);
    return true;
  });
});
