import { randomUUID } from 'node:crypto';
import { validCompletion } from './verification-completion.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, constants, realpathSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { digest, sourceDigest, treeDigest, verificationPlan, validateNodeResult, evidenceCurrent } from './verification-contract.mjs';
const root=path.resolve(import.meta.dirname,'..');
const {values}=parseArgs({options:{profile:{type:'string'},plan:{type:'boolean'},output:{type:'string'},status:{type:'string'}}});
const contractBytes=readFileSync(path.join(root,'scripts/verification.json'));
const contract=JSON.parse(contractBytes),contractDigest=digest(contractBytes);
const plan=verificationPlan(contract,values.profile??'full');
if(values.plan){console.log(JSON.stringify(plan,null,2));process.exit(0);}
const hashFile=file=>digest(readFileSync(file));
const gitHead=()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}};
if(values.status){let report;try{report=JSON.parse(readFileSync(values.status));}catch{}let current=false;
if(report?.schema==='verification-result-v1'&&Array.isArray(report.checks))try{const requiredPlan=verificationPlan(contract,report.profile,report.platform);current=report.checks.length===requiredPlan.checks.length&&new Set(report.checks.map(c=>c.id)).size===requiredPlan.checks.length&&requiredPlan.checks.every(c=>report.checks.some(r=>r.id===c.id&&(['passed'].includes(r.status)||c.status===r.status&&['scope-excluded','platform-excluded'].includes(c.status))))&&report.commit===gitHead()&&evidenceCurrent(report,{sourceDigest:sourceDigest(root),runtime:process.version,contractDigest,artifactHash:report.artifact?hashFile(report.artifact.path):undefined,distDigest:report.artifact?treeDigest(path.join(root,'dist')):undefined});}catch{}
console.log(JSON.stringify({...report,schema:'verification-result-v1',status:current?'passed':report?.schema==='verification-result-v1'?'stale':'incomplete',completionReady:current&&report.completeScope}));process.exit(current?0:1);}
const output=values.output?path.resolve(values.output):mkdtempSync(path.join(tmpdir(),`${contract.package}-verify-`));
if(existsSync(output)&&readdirSync(output).length)throw new Error('Verification output must be empty');
// Evidence must not mutate the source fingerprint it is intended to verify.
if(output===root||output.startsWith(root+path.sep))throw new Error('Verification output must be outside the repository');
mkdirSync(output,{recursive:true});
writeFileSync(path.join(output,'plan.json'),JSON.stringify(plan,null,2));
const initial=sourceDigest(root),commit=gitHead(),results=[];let artifact, interrupted=false;
const interruption=()=>{interrupted=true;};process.on('SIGTERM',interruption);process.on('SIGINT',interruption);
const require=createRequire(path.join(root,'package.json'));
const npmrc=path.join(output,'empty.npmrc');writeFileSync(npmrc,'');
const baseEnv={...process.env,...contract.environment,npm_config_cache:path.join(output,'npm-cache'),npm_config_userconfig:npmrc,NPM_CONFIG_USERCONFIG:npmrc};
delete baseEnv.npm_config_allow_scripts;delete baseEnv.NPM_CONFIG_ALLOW_SCRIPTS;
if(contract.native){const {nativeCiPlan}=await import('./run-ci-native.mjs');Object.assign(baseEnv,nativeCiPlan('unit',baseEnv).env);baseEnv.KIOKUKO_REQUIRE_LISP_RUNTIME='1';baseEnv.KIOKUKO_REQUIRE_CARGO_RUNTIME='1';baseEnv.KIOKUKO_REQUIRE_DSH_CLI='1';const bin=path.join(baseEnv.KIOKUKO_DSH_PACKAGE_ROOT,'.bin');baseEnv.PATH=bin+path.delimiter+baseEnv.PATH;if(existsSync(path.join(bin,'dsh')))baseEnv.DSH_BIN=path.join(bin,'dsh');}
baseEnv.KIOKUKO_REQUIRE_SQLITE_VEC_SMOKE='1';
delete baseEnv.NODE_PATH;delete baseEnv.NODE_TEST_CONTEXT;
async function command(argv,env=baseEnv,log='command') {
  const resolved=process.platform==='win32'&&argv[0]==='npm'?[process.execPath,process.env.npm_execpath??path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),...argv.slice(1)]:argv[0]==='node'?[process.execPath,...argv.slice(1).map(a=>a.replaceAll('{root}',root))]:argv.map(a=>a.replaceAll('{root}',root));
  if (resolved[0]===process.execPath && resolved.includes('--test') && env.KIOKUKO_VERIFY_REPORT_DIR) resolved.splice(1,0,'--import='+path.join(root,'scripts/verification-test-environment.mjs'),'--test-reporter=tap','--test-reporter-destination=stdout','--test-reporter='+path.join(root,'scripts/verification-reporter.mjs'),'--test-reporter-destination='+path.join(env.KIOKUKO_VERIFY_REPORT_DIR,'reporter.txt')); 
  if(resolved[0]==='docker'&&env.KIOKUKO_VERIFY_COMPLETION_FILE){resolved.splice(2,0,'-v',path.dirname(env.KIOKUKO_VERIFY_COMPLETION_FILE)+':/verification-receipt','-e','KIOKUKO_VERIFY_COMPLETION_FILE=/verification-receipt/complete.json','-e','KIOKUKO_VERIFY_CHECK_ID='+env.KIOKUKO_VERIFY_CHECK_ID,'-e','KIOKUKO_VERIFY_NONCE='+env.KIOKUKO_VERIFY_NONCE);}
  const started=new Date().toISOString();
  const child=spawn(resolved[0],resolved.slice(1),{cwd:root,env,shell:false,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',chunk=>{stdout+=chunk;process.stdout.write(chunk);});child.stderr.on('data',chunk=>{stderr+=chunk;process.stderr.write(chunk);});
  const stop=()=>{try {if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}};
  const interrupt=()=>{interrupted=true;stop();};process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  const timer=setTimeout(()=>{timedOut=true;stop();},30*60*1000);
  const result=await new Promise(resolve=>{child.once('error',error=>resolve({exitCode:null,error:error.message}));child.once('exit',(exitCode,signal)=>resolve({exitCode,signal}));});
  clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);stop();
  writeFileSync(path.join(output,`${log}.log`),stdout+'\n'+stderr);
  return {...result,argv:resolved,cwd:root,started,ended:new Date().toISOString(),timedOut,stdout,stderr};
}
async function missingCapabilities(check) {
  const missing=[];
  for(const capability of check.requires??[]) {
    if(capability==='sqlite-vec'){try{require.resolve('sqlite-vec');}catch{missing.push(capability);}continue;}
    if(capability==='dsh-native'){if(!existsSync(path.join(baseEnv.KIOKUKO_DSH_PACKAGE_ROOT??'','@deepseek-ai/dsh-agent-loop/lib/index.js')))missing.push(capability);continue;}
    const declaration=contract.capabilities?.[capability];
    const binary=declaration?(baseEnv[declaration.environment]??declaration.binary):capability;
    const candidates=path.isAbsolute(binary)?[binary]:(baseEnv.PATH??'').split(path.delimiter).map(dir=>path.join(dir,process.platform==='win32'?binary+'.cmd':binary));
    let location=candidates.find(file=>{try{accessSync(file,constants.X_OK);return true;}catch{return false;}});
    if(!location){missing.push(capability);continue;}
    if(capability==='opencode'){try{const {resolveOpenCodeBinary}=await import('./run-opencode-host-e2e.mjs');location=await resolveOpenCodeBinary(location);}catch{missing.push(capability);continue;}}
    const result=await command([location,'--version'],baseEnv,`capability-${check.id}-${capability}`);
    if(result.exitCode!==0||declaration?.version&&result.stdout.trim()!==declaration.version){missing.push(capability);continue;}
    if(declaration){baseEnv[declaration.environment]=realpathSync(location);if(capability==='agenticreplay-pinned')baseEnv.AGENTICREPLAY_BIN=realpathSync(location);}
  }
  return missing;
}
async function prepareArtifact() {
  rmSync(path.join(root,'dist'),{recursive:true,force:true});
  const built=await command(['npm','run','build'],baseEnv,'final-build');
  if(built.exitCode!==0||sourceDigest(root)!==initial)throw new Error('Final build failed or source changed');
  const packed=await command(['npm','pack','--json','--ignore-scripts','--pack-destination',output],baseEnv,'final-pack');
  if(interrupted||packed.exitCode!==0)throw new Error('Final pack failed');
  const metadata=JSON.parse(packed.stdout);if(metadata.length!==1||metadata[0].name!==contract.package)throw new Error('Unexpected package identity');
  const archive=path.join(output,metadata[0].filename),metadataPath=path.join(output,'pack.json');
  writeFileSync(metadataPath,JSON.stringify(metadata));
  artifact={path:archive,hash:hashFile(archive),distDigest:treeDigest(path.join(root,'dist')),metadataPath};
  const artifactReport=path.join(output,'artifact.json');
  const receipt=({stdout,stderr,...command})=>command;
  writeFileSync(artifactReport,JSON.stringify({...artifact,sourceDigest:initial,buildExecution:receipt(built),packExecution:receipt(packed)},null,2));
  Object.assign(baseEnv,{KIOKUKO_VERIFY_TARBALL:archive,KIOKUKO_VERIFY_PACK_METADATA:metadataPath,KIOKUKO_VERIFY_ARTIFACT_REPORT:artifactReport});
}
// Package consumers execute last against a single final source build/tarball.
const checks=[...plan.checks.filter(c=>!c.packed),...plan.checks.filter(c=>c.packed)];
for(const check of checks) {
  const record={id:check.id,status:'not-run',expected:check.expected};results.push(record);
  if(interrupted){record.reason='verification interrupted';continue;}
  if(['platform-excluded','scope-excluded'].includes(check.status)){record.status=check.status;record.reason=check.exclusionReason;continue;}
  if(sourceDigest(root)!==initial){record.status='stale';record.reason='source changed during verification';continue;}
  if((check.dependsOn??[]).some(id=>!['passed','platform-excluded'].includes(results.find(r=>r.id===id)?.status))){record.reason='dependency did not pass';continue;}
  const missing=await missingCapabilities(check);if(missing.length){record.status='prerequisite-missing';record.missing=missing;continue;}
  if(check.packed&&!artifact){try{await prepareArtifact();}catch(e){record.status='failed';record.reason=e.message;continue;}}
  if(artifact&&(artifact.hash!==hashFile(artifact.path)||artifact.distDigest!==treeDigest(path.join(root,'dist')))){record.status='stale';record.reason='artifact changed';continue;}
  const missingTests=await missingCapabilities({id:check.id,requires:check.testCapabilities??[]});
  const reportDir=path.join(output,check.id);mkdirSync(reportDir);
  const nonce=randomUUID(),completionFile=path.join(output,'receipts',check.id,'complete.json');mkdirSync(path.dirname(completionFile),{recursive:true});
  const env={...baseEnv,KIOKUKO_VERIFY_CHECK_ID:check.id,KIOKUKO_VERIFY_NONCE:nonce,KIOKUKO_VERIFY_COMPLETION_FILE:completionFile,...check.env,KIOKUKO_VERIFY_REPORT_DIR:reportDir,KIOKUKO_HARNESS_REPORT:path.join(output,'harness.json'),KIOKUKO_DSH_EVIDENCE_PATH:path.join(output,'dsh-lifecycle.json')};
  console.log(`VERIFY ${check.id}`);
  const observed=await command(check.argv,env,check.id);
  const reports=readdirSync(reportDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(path.join(reportDir,f))));
  let passed=observed.exitCode===0&&!observed.timedOut;
  if(check.result==='node')passed&&=reports.length>0&&reports.every(r=>validateNodeResult(r,contract.testExclusions??[]));
  if(check.result==='script'){let completion;try{completion=JSON.parse(readFileSync(completionFile));}catch{}passed&&=validCompletion(completion,check.id,nonce,check.completionEvidence??{});if(!validCompletion(completion,check.id,nonce,check.completionEvidence??{}))record.reason='missing or invalid check-bound completion receipt';}
  if(check.result==='python')passed&&=/Ran [1-9][0-9]* tests? in/.test(observed.stderr)&&/\nOK\s*$/.test(observed.stderr);
  if(reports.length)passed&&=reports.every(r=>validateNodeResult(r,contract.testExclusions??[]));
  record.status=passed?'passed':missingTests.length&&reports.every(r=>(r.counts?.failed??0)===0)?'prerequisite-missing':'failed';
  if(missingTests.length)record.missingTestCapabilities=missingTests;record.exitCode=observed.exitCode;record.signal=observed.signal;record.error=observed.error;record.reportFiles=readdirSync(reportDir);
  if(sourceDigest(root)!==initial||artifact&&(artifact.hash!==hashFile(artifact.path)||artifact.distDigest!==treeDigest(path.join(root,'dist')))){record.status='stale';record.reason='source or artifact changed during check';}
  writeFileSync(path.join(output,'progress.json'),JSON.stringify(results,null,2));
}
const stable=sourceDigest(root)===initial&&(!artifact||hashFile(artifact.path)===artifact.hash&&treeDigest(path.join(root,'dist'))===artifact.distDigest);
const passed=stable&&results.every(r=>['passed','platform-excluded','scope-excluded'].includes(r.status));
const report={schema:'verification-result-v1',package:contract.package,commit,profile:plan.profile,completeScope:plan.completeScope,runtime:process.version,platform:process.platform,sourceDigest:initial,contractDigest,artifact,status:interrupted?'interrupted':stable?(passed?'passed':'failed'):'stale',completionReady:passed&&plan.completeScope,checks:results};
writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,status:report.status,profile:plan.profile,completionReady:report.completionReady}));process.exitCode=passed?0:1;
