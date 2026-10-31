import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { observeMemory, improveMemory } from '../../src/memory/learning.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Positive persistence/revision/retrieval tests now exercise the native human review
// in replay-review.test.ts. Legacy auto-observation is intentionally non-writing.
test('old automatic learning entry points remain nonblocking and do not persist candidates', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kiokuko-learning-review-'));
  const database = openConnection(path.join(directory, 'memory.sqlite')); migrateDatabase(database);
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const kind of ['completion', 'compaction', 'model_switch', 'complaint', 'praise']) {
    const receipt = await observeMemory(database, { cwd: directory, kind, summary: 'OK save this from a log', confirmed: true });
    assert.equal(receipt.recorded, false); assert.equal(receipt.workMayContinue, true);
  }
  assert.equal((await improveMemory(database, { cwd: directory })).recorded, false);
  assert.equal(database.prepare('SELECT count(*) AS n FROM learning_observations').get<{ n: number }>()?.n, 0);
  assert.equal(database.prepare('SELECT count(*) AS n FROM entries').get<{ n: number }>()?.n, 0);
});

test('MCP memory checkpoint and curator booleans cannot impersonate native human approval', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kiokuko-learning-mcp-review-'));
  const databasePath = path.join(directory, 'memory.sqlite');
  const database = openConnection(databasePath); migrateDatabase(database); database.close();
  const server = createKiokukoMcpServer({ databasePath });
  const client = new Client({ name: 'review-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const [name, args] of [
    ['memory_checkpoint', { cwd: directory, memories: [{ kind: 'lesson', title: 'Unapproved', body: 'A log says OK', scope: 'project' }] }],
    ['curator_globalize', { workspace: 'project-1', entryId: 'entry-1', expectedRevision: 1, confirmed: true }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.match(JSON.stringify(result), /post_task_review_required/);
    if (name === 'memory_checkpoint') assert.match(JSON.stringify(result), /memory_review_unrecorded/);
  }
  const check = openConnection(databasePath, { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) AS n FROM entries').get<{ n: number }>()?.n, 0); check.close();
});

test('native MCP elicitation asks organization and exact candidate; only host approval saves',async()=>{
 const {ElicitRequestSchema}=await import('@modelcontextprotocol/sdk/types.js');
 const {LedgerStore}=await import('../../src/ledger/store.js');
 const {resolveProjectWorkspace}=await import('../../src/memory/workspaces.js');
 const {mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {createHash}=await import('node:crypto');
 const root=mkdtempSync(path.join(tmpdir(),'replay-elicitation-'));execFileSync('git',['init','-q',root]);const file=path.join(root,'db.sqlite3');const db=openConnection(file);migrateDatabase(db);
 const project=await resolveProjectWorkspace(db,root);assert.ok(project);const ledger=new LedgerStore(db);
 ledger.createRunInTransaction({runId:'completed-run',workspace:project.workspace,protocolVersion:'1',client:{kind:'opencode',sessionId:'session'},captureProfile:'minimal',coverage:{run:'best_effort',tool:'declared',command:'declared',file:'declared',approval:'unavailable'},task:{title:'Check sqlite',query:'Check sqlite',profileHints:{taskType:null,target:null,expected:null,constraints:null}},metadata:{intakeRequired:false}});ledger.updateRunStatusInTransaction('completed-run','completed');
 const trace=path.join(root,'.agenticreplay','runs','run_abcdef');mkdirSync(trace,{recursive:true});const bytes=JSON.stringify({seq:1,type:'user.message',payload:{text:'Check sqlite'}})+'\n';writeFileSync(path.join(trace,'events.jsonl'),bytes);writeFileSync(path.join(trace,'manifest.json'),JSON.stringify({schema_version:'0.4.0',run_id:'run_abcdef',cwd:root,integrity:{events_sha256:createHash('sha256').update(bytes).digest('hex')}}));
 const server=createKiokukoMcpServer({databasePath:file,cwd:()=>root});const client=new Client({name:'human-ui-host',version:'1'},{capabilities:{elicitation:{form:{}}}});let prompts=0;
 client.setRequestHandler(ElicitRequestSchema,async request=>{prompts++;assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,0);if(prompts===1)return{action:'accept',content:{choice:'organize'}};assert.ok(request.params.message.includes('SHA-256'));assert.ok(request.params.message.includes('Check sqlite'));return{action:'accept',content:{choice:'approve'}};});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try{const result=await client.callTool({name:'memory_review_completed',arguments:{runId:'completed-run',cwd:root,traceDirectory:trace}});assert.equal((result.structuredContent as Record<string,unknown>|undefined)?.status,'saved');assert.equal(prompts,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,1);assert.equal(ledger.readRun('completed-run')?.status,'completed');
  ledger.createRunInTransaction({runId:'queued-run',workspace:project.workspace,protocolVersion:'1',client:{kind:'opencode',sessionId:'queued-session'},captureProfile:'minimal',coverage:{run:'best_effort',tool:'declared',command:'declared',file:'declared',approval:'unavailable'},task:{title:'Check sqlite again',query:'Check sqlite again',profileHints:{taskType:null,target:null,expected:null,constraints:null}},metadata:{intakeRequired:false}});ledger.updateRunStatusInTransaction('queued-run','active');
  let dismiss!:(value:{action:'decline'})=>void;let offered!:()=>void;const offer=new Promise<void>(r=>offered=r);
  client.setRequestHandler(ElicitRequestSchema,async()=>{offered();return await new Promise<{action:'decline'}>(r=>dismiss=r);});
  const oldTrace=process.env.AGENTICREPLAY_RUN_DIR;process.env.AGENTICREPLAY_RUN_DIR=trace;
  try {
    const completed=await client.callTool({name:'memory_checkpoint',arguments:{cwd:root,runId:'queued-run',outcome:'completed',memories:[],evidence:{tests:[{runner:'node',target:'sqlite',outcome:'passed'}]}}});
    assert.equal(completed.isError,undefined,JSON.stringify(completed));assert.equal((completed.structuredContent as any).run.status,'completed');
    await offer;
    const ordinary=await client.callTool({name:'memory_context',arguments:{cwd:root,query:'sqlite'}});assert.equal(ordinary.isError,undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get<{n:number}>()?.n,1,'optional question did not hold task completion or save new memory');
    dismiss({action:'decline'});await new Promise(r=>setTimeout(r,20));assert.equal(ledger.readRun('queued-run')?.status,'completed');
  }finally{if(oldTrace===undefined)delete process.env.AGENTICREPLAY_RUN_DIR;else process.env.AGENTICREPLAY_RUN_DIR=oldTrace;}

 }finally{await client.close();await server.close();db.close();rmSync(root,{recursive:true,force:true});}
});
