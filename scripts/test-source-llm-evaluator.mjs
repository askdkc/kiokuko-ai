import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { requireSuccess, startOpenCode } from './run-opencode-host-e2e.mjs';
import { startFakeOpenAiServer } from '../tests/e2e/fake-openai-server.mjs';

const opencode = process.env.OPENCODE_BIN;
assert.ok(opencode && path.isAbsolute(opencode));
assert.ok(process.env.KIOKUKO_TEST_RIPWIRE && path.isAbsolute(process.env.KIOKUKO_TEST_RIPWIRE));
const base = await realpath(await mkdtemp(path.join(tmpdir(),'kiokuko-llm-metrics-smoke-')));
const root = path.join(base,'project');
const environment = {...process.env,HOME:path.join(base,'home'),XDG_CONFIG_HOME:path.join(base,'config'),
  XDG_DATA_HOME:path.join(base,'data'),XDG_CACHE_HOME:path.join(base,'cache'),
  OPENCODE_CONFIG:path.join(base,'config.json'),OPENCODE_CONFIG_DIR:path.join(base,'config'),OPENCODE_CONFIG_CONTENT:'{}',
  OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',
  KIOKUKO_EVAL_IDEAL_MODEL:'fixture/model',KIOKUKO_EVAL_ZENKI_MODEL:'fixture/model',
  KIOKUKO_EVAL_ROOT:root,KIOKUKO_EVAL_COST_CAP:'1',KIOKUKO_EVAL_FIXTURE:'1'};
for (const directory of [root,environment.HOME,environment.XDG_CONFIG_HOME,environment.XDG_DATA_HOME]) await mkdir(directory,{recursive:true});
await requireSuccess('git',['init','-q'],{cwd:root,env:environment});
await writeFile(path.join(root,'code.ts'),'export function source_context() { return true; }\n');
const fixture = await startFakeOpenAiServer({emitTaskPrepare:false,emitUsage:true,respond:async (body,sequence)=> {
  const done = (body.messages ?? []).some(m=>m.role === 'tool');
  const usage = {prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_tokens_details:{cached_tokens:3}};
  return done ? {text:'Fixture final report: code.ts source_context inspected; no tests executed.',usage}
    : {usage,toolCalls:[{id:`read-${sequence}`,type:'function',function:{name:'read',arguments:JSON.stringify({filePath:path.join(root,'code.ts')})}}]};
}});
const permission = {'*':'deny',read:'allow',glob:'allow',grep:'allow',list:'allow',external_directory:'deny'};
const config = {model:'fixture/model',small_model:'fixture/model',plugin:[],mcp:{},
  provider:{fixture:{npm:'@ai-sdk/openai-compatible',options:{baseURL:fixture.baseURL,apiKey:'fixture-key'},models:{model:{name:'Fixture',tool_call:true}}}},
  agent:Object.fromEntries(['ideal','zenki'].map(role=>[`source-eval-${role}`,{model:'fixture/model',mode:'all',steps:8,permission}]))};
await writeFile(environment.OPENCODE_CONFIG,JSON.stringify(config));
let server;
try {
  server = await startOpenCode(opencode,environment,root);
  const output = path.join(base,'report.json');
  const child = spawn(process.execPath,[path.join(import.meta.dirname,'evaluate-source-llm.mjs'),output],{
    cwd:root,env:{...environment,OPENCODE_EVAL_URL:server.url},stdio:'inherit',shell:false});
  const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0);
  const report = JSON.parse(await readFile(output,'utf8'));
  assert.equal(report.kind,'fixture');assert.equal(report.status,'completed');assert.equal(report.qualityReview,'pending');
  assert.equal(report.rows.length,4);
  for (const row of report.rows) {
    for (const role of ['ideal','zenki']) {
      assert.equal(row[role].usage.completedReads,1);
      assert.equal(row[role].usage.assistantMessages,2);
      assert.ok(row[role].usage.input > 0);
    }
    if(row.condition === 'ripwire') assert.equal(row.source.reused,true);
  }
  console.log('Source LLM evaluation transport verified with fixture responses; no real model quality measured.');
} finally {
  await server?.close();await fixture.close();await rm(base,{recursive:true,force:true});
}
