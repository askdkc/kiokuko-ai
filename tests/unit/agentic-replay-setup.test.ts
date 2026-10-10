import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  appendAgenticReplayAlias,
  enableAgenticReplayIntegration,
  agenticreplayAliasBlock,
  agenticReplayInstallInvocation,
  shellRcPath,
} from '../../src/commands/agentic-replay.js';

function scriptedIO(answers: string[]): { input: PassThrough; output: PassThrough; writes: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  let questionsSeen = 0;
  let next = 0;
  output.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
    const questions = (transcript.match(/\[y\/N\]/g) ?? []).length;
    while (questionsSeen < questions && next < answers.length) {
      questionsSeen += 1;
      input.write(`${answers[next]!}\n`);
      next += 1;
    }
  });
  return { input, output, writes: () => transcript };
}

test('agenticreplay replay install invocation avoids sudo outside linux', () => {
  assert.deepEqual(agenticReplayInstallInvocation('darwin'), { command: 'npm', args: ['install', '--global', 'agenticreplay'] });
  assert.deepEqual(agenticReplayInstallInvocation('linux'), { command: 'npm', args: ['install', '--global', 'agenticreplay'] });
  assert.deepEqual(agenticReplayInstallInvocation('win32'), { command: 'npm', args: ['install', '--global', 'agenticreplay'] });
});

test('shell rc path resolves zsh and bash and refuses unknown shells', () => {
  assert.equal(shellRcPath('darwin', { SHELL: '/bin/zsh', HOME:'/tmp/test-home' }), '/tmp/test-home/.zshrc');
  assert.equal(shellRcPath('linux', { SHELL: '/usr/bin/bash', HOME:'/tmp/test-home' }), '/tmp/test-home/.bashrc');
  assert.equal(shellRcPath('linux', { SHELL: '/usr/bin/fish' }), undefined);
  assert.equal(shellRcPath('linux', {}), undefined);
  assert.equal(shellRcPath('win32', { SHELL: '/bin/zsh', HOME:'/tmp/test-home' }), undefined);
});

test('appendAgenticReplayAlias appends once and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-agenticreplay-alias-'));
  try {
    const rcPath = join(root, '.zshrc');
    assert.deepEqual(await appendAgenticReplayAlias(rcPath,{env:{KIOKUKO_DATA_DIR:join(root,'data')}}), { appended: true });
    const once = await readFile(rcPath, 'utf8');
    assert.match(once, /# managed by kiokuko-ai setup: agenticreplay-opencode/);
    assert.match(once, /alias agenticreplay-opencode='kiokuko-ai trace record --'/);
    assert.deepEqual(await appendAgenticReplayAlias(rcPath,{env:{KIOKUKO_DATA_DIR:join(root,'data')}}), { appended: false, reason: 'already_present' });
    assert.equal(await readFile(rcPath, 'utf8'), once);
    await writeFile(rcPath, 'export EDITOR=vi');
    assert.deepEqual(await appendAgenticReplayAlias(rcPath,{env:{KIOKUKO_DATA_DIR:join(root,'data')}}), { appended: true });
    const joined = await readFile(rcPath, 'utf8');
    assert.match(joined, /^export EDITOR=vi\n# managed by kiokuko-ai setup: agenticreplay-opencode/);
    assert.deepEqual(await appendAgenticReplayAlias(undefined), { appended: false, reason: 'rc_unresolved' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('declining the opt-in performs no installation and no alias mutation', async () => {
  const { input, output, writes } = scriptedIO(['n']);
  let spawnCalls = 0;
  const summary = await enableAgenticReplayIntegration({
    input,
    output,
    interactive:true,
    platform: 'darwin',
    environment: { SHELL: '/bin/zsh', HOME:'/tmp/test-home' },
    spawnInstall: async () => { spawnCalls += 1; },
    checkInstalled: async () => { throw new Error('not installed'); },
  });
  assert.deepEqual(summary, { accepted: false, installed: 'skipped', alias: 'skipped' });
  assert.equal(spawnCalls, 0);
  assert.match(writes(), /Enable AgenticReplay recording support\? \[y\/N\]/);
});

test('accepting installs, then appends the alias only after a second confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-agenticreplay-enable-'));
  const previous = process.cwd();
  const { input, output, writes } = scriptedIO(['y', 'y']);
  const spawned: Array<{ command: string; args: readonly string[] }> = [];
  try {
    process.chdir(root);
    let checks=0;
    const summary = await enableAgenticReplayIntegration({
      input,
      output,
      interactive:true,
      platform: 'linux',
      environment: { SHELL: '/bin/zsh', HOME:root, KIOKUKO_DATA_DIR:join(root,'data') },
      spawnInstall: async (command, args) => { spawned.push({ command, args }); },
      checkInstalled: async () => { if(++checks===1)throw new Error('absent'); },
    });
    assert.deepEqual(summary, { accepted: true, installed: 'installed', alias: 'appended' });
    assert.deepEqual(spawned, [{ command: 'npm', args: ['install', '--global', 'agenticreplay'] }]);
    assert.match(await readFile(join(root, '.zshrc'), 'utf8'), /alias agenticreplay-opencode='kiokuko-ai trace record --'/);
    assert.match(writes(), /Add the agenticreplay-opencode alias to .*\.zshrc\? \[y\/N\]/);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing agenticreplay CLI skips installation and reports already_installed', async () => {
  const { input, output } = scriptedIO(['y', 'n']);
  let installCalls = 0;
  const summary = await enableAgenticReplayIntegration({
    input,
    output,
    interactive:true,
    platform: 'darwin',
    environment: { SHELL: '/bin/zsh', HOME:'/tmp/test-home' },
    spawnInstall: async () => { installCalls += 1; },
    checkInstalled: async () => undefined,
  });
  assert.equal(installCalls, 0);
  assert.equal(summary.installed, 'already_installed');
  assert.equal(summary.alias, 'skipped');
});

test('a failed install falls back to manual instructions without touching the rc', async () => {
  const { input, output, writes } = scriptedIO(['y']);
  const summary = await enableAgenticReplayIntegration({
    input,
    output,
    interactive:true,
    platform: 'linux',
    environment: { SHELL: '/bin/zsh', HOME:'/tmp/test-home' },
    spawnInstall: async () => { throw new Error('no tty for sudo'); },
    checkInstalled: async () => { throw new Error('absent'); },
  });
  assert.deepEqual(summary, { accepted: true, installed: 'failed', alias: 'skipped' });
  assert.match(writes(), /AgenticReplay installation failed: no tty for sudo/);
  assert.match(writes(), /npm install --global agenticreplay/);
  assert.match(writes(), /alias agenticreplay-opencode='kiokuko-ai trace record --'/);
});

test('alias block carries the sentinel and the exact shorthand', () => {
  assert.equal(agenticreplayAliasBlock(), "# managed by kiokuko-ai setup: agenticreplay-opencode\nalias agenticreplay-opencode='kiokuko-ai trace record --'\n");
});

test('HOME and ZDOTDIR resolve independently from CWD and ambiguous values are refused',()=>{
 assert.equal(shellRcPath('darwin',{SHELL:'/bin/zsh',HOME:'/home/example',ZDOTDIR:'/config/zsh'}),'/config/zsh/.zshrc');
 for(const ZDOTDIR of ['', 'relative', '/config/\nzsh'])assert.equal(shellRcPath('darwin',{SHELL:'/bin/zsh',HOME:'/home/example',ZDOTDIR}),undefined);
 assert.equal(shellRcPath('linux',{SHELL:'/usr/bin/fakebash',HOME:'/home/example'}),undefined);
 assert.equal(shellRcPath('linux',{SHELL:'/bin/bash',HOME:'relative'}),undefined);
});

test('concurrent managed alias upgrade preserves human bytes mode and CRLF',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agenticreplay-rc-race-'));const rc=join(root,'.zshrc');
 try{
  const {stat}=await import('node:fs/promises');
  await writeFile(rc,"export EDITOR=vi\r\n# managed by kiokuko-ai setup: agenticreplay-opencode\r\nalias agenticreplay-opencode='agenticreplay record opencode'\r\n# human\r\n",{mode:0o640});
  const env={env:{KIOKUKO_DATA_DIR:join(root,'data')}};
  const results=await Promise.all([appendAgenticReplayAlias(rc,env),appendAgenticReplayAlias(rc,env)]);
  assert.equal(results.filter(x=>x.appended).length,1);const text=await readFile(rc,'utf8');
  assert.equal(text,"export EDITOR=vi\r\n# managed by kiokuko-ai setup: agenticreplay-opencode\r\nalias agenticreplay-opencode='kiokuko-ai trace record --'\r\n# human\r\n");
  assert.equal((await stat(rc)).mode&0o777,0o640);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('user alias and rc symlink are left intact and dry-run never prompts or installs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agenticreplay-rc-safe-'));const rc=join(root,'.zshrc');
 try{
  const {symlink,lstat}=await import('node:fs/promises');const env={env:{KIOKUKO_DATA_DIR:join(root,'data')}};
  await writeFile(rc,"alias agenticreplay-opencode='custom'\n");
  assert.deepEqual(await appendAgenticReplayAlias(rc,env),{appended:false,reason:'alias_conflict'});
  const link=join(root,'.bashrc');await symlink(rc,link);
  assert.equal((await appendAgenticReplayAlias(link,env)).appended,false);assert.ok((await lstat(link)).isSymbolicLink());
  for(const options of [{dryRun:true,interactive:true},{interactive:false}]){
   const io=scriptedIO([]);const summary=await enableAgenticReplayIntegration({input:io.input,output:io.output,...options,
    spawnInstall:async()=>{throw Error('must not install');},checkInstalled:async()=>{throw Error('must not probe');}});
   assert.equal(summary.accepted,false);assert.equal(io.writes(),'');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});


test('repeated setup recognizes a working AgenticReplay CLI and existing managed alias without asking or writing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-agenticreplay-repeat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rc = join(root, '.zshrc');
  const original = `# User settings\n${agenticreplayAliasBlock()}# More user settings\n`;
  await writeFile(rc, original);
  const { input, output, writes } = scriptedIO([]);
  t.after(() => { input.destroy(); output.destroy(); });
  const result = await enableAgenticReplayIntegration({
    input, output, interactive: true, platform: 'darwin', environment: { HOME: root, SHELL: '/bin/zsh' },
    checkInstalled: async () => {}, spawnInstall: async () => { assert.fail('must not reinstall'); },
  });
  assert.deepEqual(result, { accepted: true, installed: 'already_installed', alias: 'already_present' });
  assert.equal(writes(), '');
  assert.equal(await readFile(rc, 'utf8'), original);
});
