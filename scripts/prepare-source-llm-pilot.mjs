import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sourceSnapshot } from '../dist/source-context/snapshot.js';

// Local preparation only. This script does not start OpenCode or send a model request.
const repo = await realpath(path.resolve(import.meta.dirname,'..'));
const base = await realpath(await mkdtemp(path.join(tmpdir(),'kiokuko-source-review-')));
const root = path.join(base,'project');await mkdir(root,{mode:0o700});
const snapshot = await sourceSnapshot(repo,AbortSignal.timeout(10_000));
const files = [];
for (const [name,bytes] of snapshot.files) {
  if (!(name.startsWith('src/') || name.startsWith('tests/') || name === 'package.json')) continue;
  if (['tests/fixtures/source-context-llm-pilot.json','tests/fixtures/source-context-evaluation.json'].includes(name)) continue;
  const target=path.join(root,name);await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  await writeFile(target,bytes,{mode:0o600});
  files.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
execFileSync('/usr/bin/git',['init','-q'],{cwd:root,stdio:'pipe'});
const manifest={version:1,root,originalRepository:repo,originalRepositorySourceDigest:snapshot.digest,
  sourceDigest:(await sourceSnapshot(root,AbortSignal.timeout(10_000))).digest,
  preparedAt:new Date().toISOString(),files,totalBytes:files.reduce((a,f)=>a+f.bytes,0),
  purpose:'Read-only ideal/Zenki comparison using explicitly selected models. No uploads performed during preparation.'};
const manifestPath=path.join(base,'manifest.json');
await writeFile(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});
console.log(JSON.stringify({manifest:manifestPath,root,fileCount:files.length,totalBytes:manifest.totalBytes,sourceDigest:manifest.sourceDigest}));
