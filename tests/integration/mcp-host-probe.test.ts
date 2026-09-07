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
