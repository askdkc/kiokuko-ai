import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verificationPlan, validateNodeResult, evidenceCurrent } from './verification-contract.mjs';
const check={id:'suite',argv:['node','test.mjs'],profiles:['main'],expected:'required assertions',dependsOn:[]};
const contract={package:'fixture',profiles:['full','main'],checks:[check]};
const result=(names=['required'])=>({schema:'verification-node-v1',complete:true,summaryCount:1,counts:{tests:names.length,passed:names.length,failed:0,cancelled:0,skipped:0,todo:0},tests:names.map(name=>({id:name,name,file:'test.mjs',type:'test:pass',skipped:false,todo:false})),suites:[]});
test('the same profile has an identical plan locally and in CI',()=>{
 const local=verificationPlan(contract,'main','darwin');process.env.CI='true';try{assert.deepEqual(verificationPlan(contract,'main','darwin'),local);}finally{delete process.env.CI;}
 assert.equal(local.completeScope,false);assert.equal(verificationPlan(contract,'full','darwin').completeScope,true);
});
test('empty or unknown scopes and missing dependencies are rejected before execution',()=>{
 assert.throws(()=>verificationPlan({...contract,checks:[]},'main'),/empty/);
 assert.throws(()=>verificationPlan(contract,'fast'),/Unknown/);
 assert.throws(()=>verificationPlan({...contract,checks:[{...check,dependsOn:['missing']}]},'main'),/Missing dependency/);
});
test('zero execution, unfinished output, todo and unexpected skips are non-success',()=>{
 assert.equal(validateNodeResult(result([])),false);
 const r=result();r.tests[0].skipped=true;r.counts.passed=0;r.counts.skipped=1;assert.equal(validateNodeResult(r),false);
 r.tests[0].skipped=false;r.tests[0].todo=true;r.counts.skipped=0;r.counts.todo=1;assert.equal(validateNodeResult(r),false);
 assert.equal(validateNodeResult({...result(),complete:false}),false);
});
test('only predeclared platform-specific exclusions permit a skip',()=>{
 const r=result(['posix','required']);r.tests[0].skipped=true;r.counts.passed=1;r.counts.skipped=1;
 const rules=[{file:'test.mjs',name:'^posix$',platforms:['win32'],reason:'POSIX-only contract'}];
 assert.equal(validateNodeResult(r,rules,'win32'),true);assert.equal(validateNodeResult(r,rules,'darwin'),false);
 const p=verificationPlan({...contract,checks:[{...check,platforms:['linux'],exclusionReason:'Linux isolation contract'}]},'full','darwin');assert.equal(p.checks[0].status,'platform-excluded');
});
test('a new failure is rejected even when the aggregate failure count is unchanged',()=>{
 const a=result(['old-failure','new-failure']);a.tests[0].type='test:fail';a.counts.failed=1;a.counts.passed=1;
 const b=structuredClone(a);b.tests[0].type='test:pass';b.tests[1].type='test:fail';
 assert.equal(validateNodeResult(a),false);assert.equal(validateNodeResult(b),false);
});
test('source, runtime, verification contract, archive or built artifact changes invalidate saved success',()=>{
 const report={status:'passed',sourceDigest:'source',runtime:'node',contractDigest:'contract',artifact:{hash:'archive',distDigest:'build'}};
 const state={sourceDigest:'source',runtime:'node',contractDigest:'contract',artifactHash:'archive',distDigest:'build'};
 assert.equal(evidenceCurrent(report,state),true);
 for(const key of Object.keys(state))assert.equal(evidenceCurrent(report,{...state,[key]:'changed'}),false,key);
});
function fixture(checks){
 const root=mkdtempSync(path.join(tmpdir(),'verify-contract-fixture-'));mkdirSync(path.join(root,'scripts'));
 for(const f of ['verify.mjs','verification-contract.mjs','verification-reporter.mjs','verification-test-environment.mjs','verification-completion.mjs'])cpSync(new URL(f,import.meta.url),path.join(root,'scripts',f));
 writeFileSync(path.join(root,'package.json'),'{"private":true,"type":"module"}');
 writeFileSync(path.join(root,'scripts/verification.json'),JSON.stringify({package:'fixture',profiles:['full'],checks,testExclusions:[]}));
 execFileSync('git',['init','-q'],{cwd:root});return root;
}
function execute(root){const output=mkdtempSync(path.join(tmpdir(),'verify-contract-results-'));const child=spawnSync(process.execPath,['scripts/verify.mjs','--output',output],{cwd:root,encoding:'utf8'});return {child,report:JSON.parse(readFileSync(path.join(output,'result.json')))};}
test('the real entry reports missing required native capability as prerequisite-missing',()=>{
 const root=fixture([{...check,requires:['required-native-that-is-absent'],result:'command'}]);const {child,report}=execute(root);
 assert.equal(child.status,1);assert.equal(report.checks[0].status,'prerequisite-missing');assert.equal(report.completionReady,false);
});
test('the real entry rejects an exit-zero Node suite with no tests',()=>{
 const root=fixture([{...check,argv:['node','--test','empty.test.mjs'],result:'node'}]);writeFileSync(path.join(root,'empty.test.mjs'),'// no tests\n');
 const {child,report}=execute(root);assert.equal(child.status,1);assert.equal(report.checks[0].status,'failed');
});
test('fresh final archive installs and imports without optional peers; later archive or source changes revoke success',()=>{
 const root=fixture([{...check,id:'consumer',argv:['node','consumer.mjs'],result:'script',packed:true}]);
 const manifest={name:'verification-fixture',version:'1.0.0',private:true,type:'module',exports:'./dist/index.js',files:['dist'],scripts:{build:'node build.mjs'},peerDependencies:{'verification-absent-optional-peer':'1.0.0'},peerDependenciesMeta:{'verification-absent-optional-peer':{optional:true}}};
 writeFileSync(path.join(root,'package.json'),JSON.stringify(manifest));
 const definition=JSON.parse(readFileSync(path.join(root,'scripts/verification.json')));definition.package=manifest.name;writeFileSync(path.join(root,'scripts/verification.json'),JSON.stringify(definition));
 mkdirSync(path.join(root,'dist'));writeFileSync(path.join(root,'dist/index.js'),"export const result='stale';\n");
 writeFileSync(path.join(root,'build.mjs'),"import{rmSync,mkdirSync,writeFileSync}from'node:fs';rmSync('dist',{recursive:true,force:true});mkdirSync('dist');writeFileSync('dist/index.js',\"export const result='fresh';\\n\");\n");
 // Generated build output is deliberately excluded from the source fingerprint, as in the real repos.
 writeFileSync(path.join(root,'.gitignore'),'dist/\n');
 writeFileSync(path.join(root,'consumer.mjs'),`import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,existsSync}from'node:fs';import{tmpdir}from'node:os';import path from'node:path';import{execFileSync}from'node:child_process';const dir=mkdtempSync(path.join(tmpdir(),'verification-empty-consumer-'));writeFileSync(path.join(dir,'package.json'),'{}');execFileSync(process.platform==='win32'?process.execPath:'npm',[...(process.platform==='win32'?[process.env.npm_execpath??path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')]:[]),'install','--ignore-scripts','--omit=optional','--no-audit','--no-fund',process.env.KIOKUKO_VERIFY_TARBALL],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir,npm_config_cache:path.join(dir,'cache'),npm_config_offline:'true'},stdio:'pipe'});assert.equal(existsSync(path.join(dir,'node_modules/verification-absent-optional-peer')),false);writeFileSync(path.join(dir,'check.mjs'),\"import assert from 'node:assert/strict';import{result}from'verification-fixture';assert.equal(result,'fresh');\");execFileSync(process.execPath,['check.mjs'],{cwd:dir,stdio:'pipe'});console.log('fresh installed assertion passed');const {completeVerification}=await import('./scripts/verification-completion.mjs');completeVerification({installed:true});`);
 const {child,report}=execute(root);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(report.completionReady,true);
 const output=path.dirname(report.artifact.path),saved=path.join(output,'result.json');
 const status=()=>spawnSync(process.execPath,['scripts/verify.mjs','--status',saved],{cwd:root,encoding:'utf8'});
 assert.equal(status().status,0);
 const buildSource=readFileSync(path.join(root,'build.mjs'));writeFileSync(path.join(root,'build.mjs'),"console.log('no-op build');");assert.equal(status().status,1);
 const noBuild=execute(root);assert.equal(noBuild.child.status,1,'old dist must not rescue a no-op build');assert.equal(noBuild.report.completionReady,false);
 writeFileSync(path.join(root,'build.mjs'),buildSource);
 writeFileSync(report.artifact.path,'changed archive');assert.equal(status().status,1);
});

test('arbitrary stdout, missing or wrong completion identities never satisfy a script check',()=>{
 for(const code of ["console.log('starting assertions')","import{writeFileSync}from'node:fs';writeFileSync(process.env.KIOKUKO_VERIFY_COMPLETION_FILE,JSON.stringify({schema:'verification-completion-v1',id:'other-check',nonce:process.env.KIOKUKO_VERIFY_NONCE,status:'passed',evidence:{}}));"]){
 const root=fixture([{...check,argv:['node','script.mjs'],result:'script'}]);writeFileSync(path.join(root,'script.mjs'),code);const {child,report}=execute(root);assert.equal(child.status,1);assert.equal(report.completionReady,false);}
});
test('a missing terminal result or progress array is incomplete, never successful',()=>{
 const root=fixture([check]);const file=path.join(tmpdir(),'verification-progress-'+Date.now()+'.json');writeFileSync(file,JSON.stringify([{id:'suite',status:'passed'}]));
 const r=spawnSync(process.execPath,['scripts/verify.mjs','--status',file],{cwd:root,encoding:'utf8'});assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).status,'incomplete');
});

test('completion schema, identity, nonce and evidence are independently required',async()=>{
 const {validCompletion}=await import('./verification-completion.mjs');const good={schema:'verification-completion-v1',id:'suite',nonce:'fresh',status:'passed',evidence:{installed:true}};
 assert.equal(validCompletion(good,'suite','fresh',{installed:true}),true);
 for(const change of [{schema:'other'},{id:'other'},{nonce:'old'},{status:'running'},{evidence:[]},{evidence:{installed:false}}])assert.equal(validCompletion({...good,...change},'suite','fresh',{installed:true}),false);
});
test('SIGTERM preserves an interrupted terminal result with no completion success',async()=>{
 const root=fixture([{...check,argv:['node','waiting.mjs'],result:'script'}]);writeFileSync(path.join(root,'waiting.mjs'),"console.log('waiting');setInterval(()=>{},1000)");
 const output=mkdtempSync(path.join(tmpdir(),'verify-interrupt-'));const child=(await import('node:child_process')).spawn(process.execPath,['scripts/verify.mjs','--output',output],{cwd:root,stdio:['ignore','pipe','pipe']});
 let stdout='';const completed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('waiting'))child.kill('SIGTERM');});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 await completed;clearTimeout(timer);const report=JSON.parse(readFileSync(path.join(output,'result.json')));assert.equal(report.status,'interrupted');assert.equal(report.completionReady,false);
});

 test('missing required test capability stops the suite before any test process runs',()=>{
  const root=fixture([{...check,argv:['node','must-not-run.mjs'],testCapabilities:['verification-fixture-absent-tool'],result:'script'}]);
  writeFileSync(path.join(root,'must-not-run.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('executed','unexpected');");
  const {child,report}=execute(root);assert.equal(child.status,1);assert.equal(report.checks[0].status,'prerequisite-missing');assert.equal(existsSync(path.join(root,'executed')),false);
 });
 test('evidence from another platform or architecture cannot certify this consumer',()=>{
  const root=fixture([{...check,argv:['node','script.mjs'],result:'script'}]);writeFileSync(path.join(root,'script.mjs'),"import{completeVerification}from'./scripts/verification-completion.mjs';completeVerification({assertions:true});");
  const {child,report}=execute(root);assert.equal(child.status,0);
  const file=path.join(mkdtempSync(path.join(tmpdir(),'verification-platform-')),'result.json');
  writeFileSync(file,JSON.stringify(report));assert.equal(spawnSync(process.execPath,['scripts/verify.mjs','--status',file],{cwd:root,encoding:'utf8'}).status,0);
  for(const change of [{platform:'foreign-platform'},{architecture:'foreign-architecture'}]){
   writeFileSync(file,JSON.stringify({...report,...change}));const observed=spawnSync(process.execPath,['scripts/verify.mjs','--status',file],{cwd:root,encoding:'utf8'});assert.equal(observed.status,1);assert.equal(JSON.parse(observed.stdout).completionReady,false);
  }
 });
