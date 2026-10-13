// Repository-owned verification rules. CI and local execution use the same plan.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function sourceDigest(root) {
  const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))].sort();
  return digest(JSON.stringify(files.map(file => {
    try { const p=path.join(root,file),s=lstatSync(p);return [file,s.mode,s.isSymbolicLink()?readlinkSync(p):s.isFile()?digest(readFileSync(p)):'directory']; }
    catch(e) {if(e.code==='ENOENT')return [file,'missing'];throw e;}
  })));
}
export function treeDigest(root) {
  const files=[];
  function visit(dir) {for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {const p=path.join(dir,item.name);if(item.isDirectory())visit(p);else files.push([path.relative(root,p),item.isSymbolicLink()?readlinkSync(p):digest(readFileSync(p))]);}}
  visit(root);return digest(JSON.stringify(files));
}
export function verificationPlan(contract, profile='full', platform=process.platform) {
  if(!contract.profiles.includes(profile))throw new Error(`Unknown verification profile: ${profile}`);
  const selected=contract.checks.filter(c=>profile==='full'||c.profiles.includes(profile));
  if(!selected.length)throw new Error('Verification profile is empty');
  const ids=new Set(selected.map(c=>c.id));
  if(ids.size!==selected.length)throw new Error('Duplicate verification check');
  for(const check of selected) {
    if(!Array.isArray(check.argv)||!check.argv.length||!check.expected)throw new Error(`No execution contract: ${check.id}`);
    for(const dep of check.dependsOn??[])if(!ids.has(dep))throw new Error(`Missing dependency ${dep}: ${check.id}`);
    if((check.platforms||check.optIn) && !check.exclusionReason)throw new Error(`Missing platform exclusion declaration: ${check.id}`);
  }
  return {schema:'verification-plan-v1',package:contract.package,profile,platform,completeScope:profile==='full',checks:selected.map(c=>({...c,status:profile==='full'&&c.optIn?'scope-excluded':c.profileExclusions?.[profile]?.platforms.includes(platform)?'scope-excluded':c.platforms&&!c.platforms.includes(platform)?'platform-excluded':'required',exclusionReason:c.profileExclusions?.[profile]?.platforms.includes(platform)?c.profileExclusions[profile].reason:c.exclusionReason}))};
}
export function validateNodeResult(report, exclusions=[], platform=process.platform) {
  if(report?.schema!=='verification-node-v1'||report.complete!==true||report.summaryCount!==1||!Array.isArray(report.tests)||!report.tests.length||!Array.isArray(report.suites))return false;
  const seen=new Set();let passed=0,skipped=0,failed=0,todo=0;
  for(const event of report.tests) {
    if(!event||event.fileOnly||typeof event.skipped!=='boolean'||typeof event.todo!=='boolean'||typeof event.id!=='string'||seen.has(event.id))return false;seen.add(event.id);
    if(event.todo)todo++;else if(event.skipped){skipped++;if(!exclusions.some(rule=>rule.platforms.includes(platform)&&event.file===rule.file&&new RegExp(rule.name).test(event.name)&&rule.reason))return false;}
    else if(event.type==='test:pass')passed++;else failed++;
  }
  const counts=report.counts;
  return passed>0&&failed===0&&todo===0&&counts?.tests===report.tests.length&&counts.passed===passed&&counts.skipped===skipped&&counts.failed===0&&counts.cancelled===0&&counts.todo===0
    && report.suites.every(s=>s.type==='test:pass'&&!s.skipped&&!s.todo);
}
export function evidenceCurrent(report, state) {
  return report.status==='passed'&&report.sourceDigest===state.sourceDigest&&report.runtime===state.runtime
    && report.contractDigest===state.contractDigest&&(!report.artifact||report.artifact.hash===state.artifactHash&&report.artifact.distDigest===state.distDigest);
}
