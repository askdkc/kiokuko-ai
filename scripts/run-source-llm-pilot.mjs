import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sourceSnapshot } from '../dist/source-context/snapshot.js';
import { startOpenCode } from './run-opencode-host-e2e.mjs';

const opencode = process.env.OPENCODE_BIN;
if (!opencode || !path.isAbsolute(opencode)) throw new Error('Set OPENCODE_BIN to the tested absolute executable');
for (const role of ['IDEAL','ZENKI']) if (!process.env[`KIOKUKO_EVAL_${role}_MODEL`]) throw new Error(`Specify ${role} model`);
if (!process.argv[2]) throw new Error('Supply an output report path');
const output = path.resolve(process.argv[2]);
const manifestPath=process.env.KIOKUKO_EVAL_MANIFEST;
if (!manifestPath || !path.isAbsolute(manifestPath)) throw new Error('Prepare and review a source manifest before live evaluation');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const base = await realpath(await mkdtemp(path.join(tmpdir(),'kiokuko-live-source-pilot-')));
const project = await realpath(manifest.root);
const configDirectory = path.join(base,'config');
await mkdir(configDirectory);
const snapshot = await sourceSnapshot(project,AbortSignal.timeout(10_000));
if (snapshot.digest !== manifest.sourceDigest) throw new Error('Reviewed source snapshot changed; no model request sent');
const permission = {'*':'deny',read:'allow',glob:'allow',grep:'allow',list:'allow',external_directory:'deny'};
const agents = Object.fromEntries(['ideal','zenki'].map(role=>[`source-eval-${role}`,{
  model:process.env[`KIOKUKO_EVAL_${role.toUpperCase()}_MODEL`],mode:'all',steps:8,permission,
  prompt:`You are Kiokuko's ${role} role. Work only on the supplied read-only investigation. No edits, execution, delegation or external access.`,
}]));
const config = {model:agents['source-eval-ideal'].model,small_model:agents['source-eval-ideal'].model,
  plugin:[],mcp:{},lsp:false,formatter:false,share:'disabled',autoupdate:false,
  enabled_providers:[...new Set(Object.values(agents).map(a=>a.model.split('/')[0]))],agent:agents};
const configPath = path.join(configDirectory,'opencode.json');
await writeFile(configPath,JSON.stringify(config),{mode:0o600});
// Keep OpenCode's normal authentication/data location. Never read or copy auth files ourselves.
// Configuration and investigated source are isolated; existing conversations are never queried.
const env = {...process.env,XDG_CONFIG_HOME:configDirectory,OPENCODE_CONFIG:configPath,OPENCODE_CONFIG_DIR:configDirectory,
  OPENCODE_CONFIG_CONTENT:'{}',OPENCODE_DISABLE_AUTOUPDATE:'true',KIOKUKO_EVAL_ROOT:project,
  KIOKUKO_EVAL_COST_CAP:process.env.KIOKUKO_EVAL_COST_CAP ?? '5'};
delete env.OPENCODE_DISABLE_DEFAULT_PLUGINS;
delete env.KIOKUKO_EVAL_FIXTURE;
let server;
try {
  server = await startOpenCode(opencode,env,project);
  const providers = await (await fetch(`${server.url}/provider`)).json();
  for (const model of Object.values(agents).map(a=>a.model)) {
    const slash=model.indexOf('/'),provider=model.slice(0,slash),id=model.slice(slash+1);
    if (!providers.connected?.includes(provider)) throw new Error(`Provider not connected: ${provider}. No model requests sent.`);
    if (!providers.all?.find(p=>p.id===provider)?.models?.[id]) throw new Error(`Selected model unavailable: ${model}. No substitution performed.`);
  }
  const child = spawn(process.execPath,[path.join(import.meta.dirname,'evaluate-source-llm.mjs'),output],{
    cwd:project,env:{...env,OPENCODE_EVAL_URL:server.url},shell:false,stdio:'inherit'});
  const exit = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  process.exitCode = exit ?? 1;
  if (exit === 0) {
    const report=JSON.parse(await readFile(output,'utf8'));
    report.originalRepositorySourceDigest=manifest.originalRepositorySourceDigest;
    report.sourceScope='Private frozen copy of src/, tests/ and package.json; rubric fixtures excluded';
    await writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
  }
} finally {
  await server?.close();await rm(base,{recursive:true,force:true});
}
