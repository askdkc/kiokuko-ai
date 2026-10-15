import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { realpath } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { LedgerStore } from '../ledger/store.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { recordEntryInTransaction } from '../memory/entries.js';
import { createApprovedReplayMemoryStore } from '../memory/replay-store.js';
import { extractReplayProposal } from '../memory/replay-extract.js';
import { reviewCompletedReplay, type ReviewReceipt, type ReplayMemoryProposal } from '../memory/replay-review.js';

/** MCP elicitation responses come from the client UI, never a model tool argument. */
export function createMcpReplayReview(server: McpServer, withDatabase: <T>(fn:(db:SqliteDatabase)=>Promise<T>|T)=>Promise<T>) {
 const approved=new Map<string,{proposal:ReplayMemoryProposal;key:string}>();
 const active=new Set<string>();const finished=new Map<string,ReviewReceipt>();const abort=new AbortController();
 const unavailable=():ReviewReceipt=>({status:'unavailable',workMayContinue:true});
 return {
  close(){abort.abort();},
  async review(input:{runId:string;cwd:string;traceDirectory:string},signal?:AbortSignal):Promise<ReviewReceipt>{
   const prior=finished.get(input.runId);if(prior)return prior;
   const pending=approved.get(input.runId);
   if(pending){
    try{const state=await withDatabase(db=>createApprovedReplayMemoryStore(db,pending.proposal.source.workspace).reconcile(pending.proposal,pending.key));
      const result:ReviewReceipt={status:state,workMayContinue:true,approvalKey:pending.key};
      if(state==='saved'){finished.set(input.runId,result);approved.delete(input.runId);}return result;
    }catch{return {...unavailable(),approvalKey:pending.key};}
   }
   if(!server.server.getClientCapabilities()?.elicitation || active.has(input.runId) || finished.size+approved.size>=256)return unavailable();
   active.add(input.runId);
   try{
    const root=await realpath(input.cwd);
    const binding=await withDatabase(async db=>{
      const run=new LedgerStore(db).readRun(input.runId);const project=await resolveProjectWorkspaceReadOnly(db,root);
      if(!run||!['completed','failed'].includes(run.status)||!project||run.workspace!==project.workspace||project.repositoryRoot!==root)return undefined;
      return {workspace:run.workspace,sessionId:run.client.sessionId??run.runId,taskOutcome:run.status as 'completed'|'failed'};
    });
    if(!binding)return {status:'not_completed',workMayContinue:true};
    const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const receipt=await reviewCompletedReplay({completed:true,taskOutcome:binding.taskOutcome,workspace:binding.workspace,taskId:input.runId,sessionId:binding.sessionId,signal:combined,
      extract:()=>extractReplayProposal({cwd:root,traceDirectory:input.traceDirectory,workspace:binding.workspace,taskId:input.runId,sessionId:binding.sessionId}),
      ask:async question=>{
        const choices=question.phase==='organize'?['organize','decline']:['approve','revise','decline'];
        const result=await server.server.elicitInput({mode:'form',message:question.text,requestedSchema:{type:'object',properties:{choice:{type:'string',enum:choices},comment:{type:'string',maxLength:2048}},required:['choice']}},{signal:combined,timeout:300_000});
        const choice=result.action==='accept'?result.content?.choice:'decline';
        return {questionId:question.id,choice:choice==='organize'||choice==='approve'||choice==='revise'?choice:'decline',...(typeof result.content?.comment==='string'?{comment:result.content.comment}:{})};
      },
      onApproved:(proposal,key)=>{approved.set(input.runId,{proposal,key});},
      save:async(proposal,key)=>withDatabase(async db=>{
        const run=new LedgerStore(db).readRun(input.runId);
        if(combined.aborted||run?.status!==binding.taskOutcome||run.workspace!==binding.workspace)throw new Error('review_binding_changed');
        createApprovedReplayMemoryStore(db,binding.workspace,p=>recordEntryInTransaction(db,{workspace:binding.workspace,kind:'reference',title:`Approved experience: ${p.request.text.slice(0,100)||p.source.taskId}`,body:['Approved recorded-experience excerpt; full revision retained in replay store.',p.request.text,...p.findings.map(f=>f.text)].join('\n').slice(0,19000),summary:p.findings.map(f=>f.text).join('\n').slice(0,2048)||p.request.text.slice(0,2048),tags:[...new Set([...p.tags,...p.keywords])].slice(0,20),scope:{visibility:'project'},provenance:{type:'user_approved_replay',reference:key,evidenceIds:p.attempts.flatMap(a=>[a.callRef,...(a.resultRef?[a.resultRef]:[])])},trustLevel:'untrusted',confidence:.4,createdBy:'kiokuko-ai-replay-review',actor:'user'})).save(proposal,key);
      }),
    });
    if(receipt.status==='saved'||receipt.status==='declined'){finished.set(input.runId,receipt);approved.delete(input.runId);}
    return receipt;
   }catch{return unavailable();}finally{active.delete(input.runId);}
  },
 };
}
