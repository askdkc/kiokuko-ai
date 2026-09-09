import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startOpenCode, requireSuccess } from './run-opencode-host-e2e.mjs';
import { startFakeOpenAiServer } from '../tests/e2e/fake-openai-server.mjs';

// This uses a real OpenCode process. Only the model response and optional
// whitespace-only presentation experiment are fixtures; MCP and Kiokuko hooks are real.
const repo = path.resolve(import.meta.dirname, '..');
const binary = process.env.OPENCODE_BIN;
assert.ok(binary && path.isAbsolute(binary), 'OPENCODE_BIN must name an absolute executable');
const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-presentation-host-'));
const project = path.join(root, 'project');
for (const name of ['project', 'home', 'config', 'data', 'cache', 'state']) await mkdir(path.join(root, name));
const env = { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), KIOKUKO_DATA_DIR: path.join(root, 'data'), KIOKUKO_SKILL_DISCOVERY: 'off', OPENCODE_CONFIG: path.join(root, 'config/opencode/opencode.jsonc'), OPENCODE_CONFIG_DIR: path.join(root, 'config/opencode'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_MODELS_FETCH: 'true', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
Object.assign(env, { OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_EXPERIMENTAL_CODE_MODE: 'false' });
const cli = path.join(repo, 'dist/bin/kiokuko.js');
await requireSuccess('git', ['init', '-q'], { cwd: project, env });
await requireSuccess(process.execPath, [cli, 'setup', '--skill-discovery', 'off', '--enno-oduno', 'ask', '--json'], { cwd: project, env, label: 'setup' });
const config = JSON.parse(await readFile(env.OPENCODE_CONFIG, 'utf8'));
const plugin = config.plugin.find(entry => Array.isArray(entry) && entry[0].startsWith('kiokuko-ai@'));
assert.ok(plugin);
const experiment = process.env.KIOKUKO_PRESENTATION_EXPERIMENT === 'compact';
const observations = path.join(root, 'observations.jsonl');
const wrapper = path.join(root, 'observer.mjs');
await writeFile(wrapper, `import plugin from ${JSON.stringify(pathToFileURL(path.join(repo, 'dist/opencode/plugin.js')).href)};
import { appendFileSync } from 'node:fs';
const log = value => appendFileSync(${JSON.stringify(observations)}, JSON.stringify(value)+'\\n');
export default async (input, options) => {
 const hooks = await plugin(input, options); let cfg;
 return { ...hooks,
 config: async value => { cfg=value; await hooks.config(value); },
 'tool.execute.after': async (input, output) => {
   await hooks['tool.execute.after'](input, output);
   if (!input.tool.startsWith('kiokuko_') || !Array.isArray(output.content)) return;
   const part=output.content[0]; if (output.content.length!==1 || part?.type!=='text' || output.isError) return;
   const before=part.text; const value=JSON.parse(before); const compact=JSON.stringify(value);
   const limits={maxBytes:cfg.tool_output?.max_bytes??51200,maxLines:cfg.tool_output?.max_lines??2000};
   if (${experiment} && Buffer.byteLength(compact)<=limits.maxBytes && limits.maxLines>=1) part.text=compact;
   log({kind:'tool',tool:input.tool,callID:input.callID,originalBytes:Buffer.byteLength(before),visible:part.text,structured:output.structuredContent,limits});
 },
 'experimental.session.compacting': async (input, output) => {
   output.prompt='AUDIT_CUSTOM_SUMMARY';
   await hooks['experimental.session.compacting'](input,output);
   log({kind:'compaction',...output});
 },
 dispose: async () => {await hooks.dispose();log({kind:'disposed'});}
 };
};
`);
plugin[0] = pathToFileURL(wrapper).href;
let stage = 'prepare';
let next = 'task_prepare';
let prepared;
let selected;
let lastTool;
let oversizeMode;
let sequence = 0;
const requests = [];
let providerFailure;
const seen = new Set();
const expectedTools = [];
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? '').join('\n') : '';
const fixture = await startFakeOpenAiServer({ emitTaskPrepare: false, respond(body) {
 try {
  requests.push(body);
  const prompt = text(body.messages.find(m => m.role === 'user')?.content);
  if (stage === 'compact' && prompt.includes('AUDIT_CUSTOM_SUMMARY')) {
    return { text: 'Fixture summary.\n' + prompt.split('The following is the conversation history:')[0] };
  }
  if (!body.tools?.length) return { text: 'Fixture title' };
  if (stage === 'oversize') {
    const result=body.messages.find(m=>m.role==='tool');
    if (result) {
      const output=text(result.content);
      assert.throws(()=>JSON.parse(output));
      assert.equal(output.includes('AUDIT_PREFIX'),oversizeMode==='pretty');
      assert.ok(!output.includes('AUDIT_REQUIRED_TAIL'));
      return {text:'AUDIT_FINAL_oversize'};
    }
    assert.ok(body.tools.some(t=>t.function?.name==='audit_output'));
    return {toolCalls:[{id:`oversize-${oversizeMode}`,type:'function',function:{name:'audit_output',arguments:JSON.stringify({format:oversizeMode})}}]};
  }
  for (const message of body.messages.filter(m => m.role === 'tool')) {
    if (seen.has(message.tool_call_id)) continue;
    seen.add(message.tool_call_id);
    const value = JSON.parse(text(message.content));
    lastTool = value;
    if (next === 'task_prepare') { prepared=value; next='task_execution_select'; }
    else if (next === 'task_execution_select') { selected=value; next=null; }
    else next=null;
  }
  if (!next) return { text: `AUDIT_FINAL_${stage}` };
  const tool = body.tools.find(t => t.function?.name === `kiokuko_${next}`)?.function.name;
  assert.ok(tool, `missing tool ${next}`);
  let args;
  if (next === 'task_prepare') args={soulRead:true,requestId:'presentation-host-audit',task:'Review the fixture documentation',cwd:project,profileHints:{taskType:'review',target:'README.md',expected:'Report findings'},capabilities:[{kind:'skill',name:'kiokuko-soul'}],maxContextChars:12000};
  else if (next === 'task_execution_select') args={runId:prepared.run.runId,expectedRevision:prepared.execution.revision,idempotencyKey:'ordinary-selection',choice:'ordinary',cwd:project};
  else if (next === 'task_context_read') args={runId:prepared.run.runId,afterContextRevision:prepared.contextRevision};
  else args={runId:prepared.run.runId,outcome:'completed',cwd:project,evidence:{commands:[{executable:'node',outcome:'passed'}]}};
  expectedTools.push(tool);
  return {toolCalls:[{id:`audit-${++sequence}`,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]};
 } catch (error) { providerFailure=error; return {text:'Fixture assertion failed'}; }
} });
config.model='fixture/fixture-model';
config.provider={fixture:{npm:'@ai-sdk/openai-compatible',name:'Audit fixture',options:{baseURL:fixture.baseURL,apiKey:'fixture-key'},models:{'fixture-model':{name:'Audit fixture',limit:{context:1000000,output:4096}}}}};
config.permission='allow';
config.compaction={auto:false,prune:false};
config.tool_output={max_bytes:51200,max_lines:2000};
config.mcp.audit={type:'local',command:[process.execPath,path.join(repo,'tests/e2e/presentation-mcp-server.mjs')],enabled:true};
await writeFile(env.OPENCODE_CONFIG, JSON.stringify(config,null,2));
let server;
try {
  server=await startOpenCode(binary,env,project);
  const request=async (route,body) => {
    const response=await fetch(server.url+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(90000)});
    const raw=await response.text();
    assert.match(response.headers.get('content-type') ?? '', /json/u, `Expected JSON from ${route}: ${response.status}: ${raw.slice(0,80)}`);
    const value=JSON.parse(raw); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const health=await request('/global/health');
  assert.equal((await request('/mcp')).kiokuko.status,'connected');
  const session=await request('/session',{});
  const prompt=async label => {
    const result=await request(`/session/${session.id}/message`,{model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:label}]});
    if (providerFailure) throw providerFailure;
    assert.ok(result.parts.some(p=>p.type==='text'&&p.text.includes(`AUDIT_FINAL_${stage}`)), JSON.stringify(result));
  };
  const compact=async expectChoice => {
    stage='compact';
    const requestOffset=requests.length;
    assert.equal(await request(`/session/${session.id}/summarize`,{providerID:'fixture',modelID:'fixture-model',auto:false}),true);
    const records=(await readFile(observations,'utf8')).trim().split('\n').map(JSON.parse);
    const record=records.filter(r=>r.kind==='compaction').at(-1);
    assert.equal(record.context.some(c=>c.includes('"choice":"ordinary"')),expectChoice);
    const providerRequest=requests.slice(requestOffset).find(r=>text(r.messages.find(m=>m.role==='user')?.content).startsWith('AUDIT_CUSTOM_SUMMARY'));
    assert.ok(providerRequest, 'The compaction request must reach the provider');
    const providerPrompt=text(providerRequest.messages.find(m=>m.role==='user').content).split('The following is the conversation history:')[0];
    assert.equal(providerPrompt.includes('"choice":"ordinary"'),expectChoice);
  };
  await prompt('Start the deterministic ordinary request.');
  assert.equal(selected.execution.choice,'ordinary');
  await compact(true);
  await server.close();
  server=await startOpenCode(binary,env,project);
  assert.equal((await request('/mcp')).kiokuko.status,'connected');
  stage='restore';next='task_context_read';
  await prompt('Restore the same request after restarting the host.');
  assert.equal(lastTool.execution.choice,'ordinary');
  assert.deepEqual(lastTool.revisions,[]);
  await compact(true);
  stage='terminal';next='memory_checkpoint';
  await prompt('Complete the verified fixture request.');
  assert.equal(lastTool.run.status,'completed');
  await compact(false);
  const records=(await readFile(observations,'utf8')).trim().split('\n').map(JSON.parse);
  const tools=records.filter(r=>r.kind==='tool');
  assert.deepEqual(tools.map(r=>r.tool),expectedTools);
  const messages=await request(`/session/${session.id}/message`);
  for (const tool of tools) {
    assert.deepEqual(JSON.parse(tool.visible),tool.structured);
    const stored=messages.flatMap(m=>m.parts).find(p=>p.type==='tool'&&p.callID===tool.callID);
    assert.equal(stored.state.output,tool.visible);
    const visible=requests.flatMap(r=>r.messages).find(m=>m.role==='tool'&&m.tool_call_id===tool.callID);
    assert.equal(text(visible.content),tool.visible);
  }
  assert.ok(requests.some(r=>r.messages.some(m=>m.role==='system'&&text(m.content).includes('<server name="kiokuko">'))), 'MCP server instructions must reach the provider');
  stage='oversize';
  for (oversizeMode of ['pretty','compact']) {
    const largeSession=await request('/session',{});
    const result=await request(`/session/${largeSession.id}/message`,{model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:'Read the oversized synthetic result.'}]});
    if (providerFailure) throw providerFailure;
    assert.ok(result.parts.some(p=>p.type==='text'&&p.text==='AUDIT_FINAL_oversize'));
    const saved=await request(`/session/${largeSession.id}/message`);
    const tool=saved.flatMap(m=>m.parts).find(p=>p.type==='tool');
    assert.equal(tool.state.metadata.truncated,true);
    assert.ok(tool.state.metadata.outputPath.startsWith(root+path.sep));
    const full=JSON.parse(await readFile(tool.state.metadata.outputPath,'utf8'));
    assert.equal(full.directive,'AUDIT_REQUIRED_TAIL');
  }
  const report={status:'passed',opencodeVersion:health.version,experiment:experiment?'prototype-compact':'off',scope:'real host, real MCP, real Kiokuko hooks, deterministic local provider',root,steps:tools.map(r=>({tool:r.tool,originalBytes:r.originalBytes,visibleBytes:Buffer.byteLength(r.visible)})),compactions:3,restarts:1,finalResponse:true,mcpInstructionsVisible:true,oversize:{pretty:'partial prefix; tail missing',compact:'empty body preview; tail missing',fullResultFile:'intact in both cases'},providerRequests:requests.length};
  await writeFile(path.join(root,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await server?.close(); await fixture.close(); }
