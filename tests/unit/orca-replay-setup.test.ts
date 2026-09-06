import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  appendOrcaAlias,
  enableOrcaReplayIntegration,
  orcaAliasBlock,
  orcaReplayInstallInvocation,
  shellRcPath,
} from '../../src/commands/orca-replay.js';

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

test('orca replay install invocation avoids sudo outside linux', () => {
  assert.deepEqual(orcaReplayInstallInvocation('darwin'), { command: 'npm', args: ['install', '--global', 'orcareplay'] });
  assert.deepEqual(orcaReplayInstallInvocation('linux'), { command: 'sudo', args: ['npm', 'install', '--global', 'orcareplay'] });
  assert.deepEqual(orcaReplayInstallInvocation('win32'), { command: 'npm', args: ['install', '--global', 'orcareplay'] });
});

test('shell rc path resolves zsh and bash and refuses unknown shells', () => {
  assert.equal(shellRcPath('darwin', { SHELL: '/bin/zsh' }), '.zshrc');
  assert.equal(shellRcPath('linux', { SHELL: '/usr/bin/bash' }), '.bashrc');
  assert.equal(shellRcPath('linux', { SHELL: '/usr/bin/fish' }), undefined);
  assert.equal(shellRcPath('linux', {}), undefined);
  assert.equal(shellRcPath('win32', { SHELL: '/bin/zsh' }), undefined);
});

test('appendOrcaAlias appends once and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-orca-alias-'));
  try {
    const rcPath = join(root, '.zshrc');
    assert.deepEqual(await appendOrcaAlias(rcPath), { appended: true });
    const once = await readFile(rcPath, 'utf8');
    assert.match(once, /# managed by kiokuko-ai setup: orca-opencode/);
    assert.match(once, /alias orca-opencode='orca record opencode'/);
    assert.deepEqual(await appendOrcaAlias(rcPath), { appended: false, reason: 'already_present' });
    assert.equal(await readFile(rcPath, 'utf8'), once);
    await writeFile(rcPath, 'export EDITOR=vi');
    assert.deepEqual(await appendOrcaAlias(rcPath), { appended: true });
    const joined = await readFile(rcPath, 'utf8');
    assert.match(joined, /^export EDITOR=vi\n# managed by kiokuko-ai setup: orca-opencode/);
    assert.deepEqual(await appendOrcaAlias(undefined), { appended: false, reason: 'rc_unresolved' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('declining the opt-in performs no installation and no alias mutation', async () => {
  const { input, output, writes } = scriptedIO(['n']);
  let spawnCalls = 0;
  const summary = await enableOrcaReplayIntegration({
    input,
    output,
    platform: 'darwin',
    environment: { SHELL: '/bin/zsh' },
    spawnInstall: async () => { spawnCalls += 1; },
    checkInstalled: async () => { throw new Error('not installed'); },
  });
  assert.deepEqual(summary, { accepted: false, installed: 'skipped', alias: 'skipped' });
  assert.equal(spawnCalls, 0);
  assert.match(writes(), /Enable OrcaReplay recording support\? \[y\/N\]/);
});

test('accepting installs, then appends the alias only after a second confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-orca-enable-'));
  const previous = process.cwd();
  const { input, output, writes } = scriptedIO(['y', 'y']);
  const spawned: Array<{ command: string; args: readonly string[] }> = [];
  try {
    process.chdir(root);
    const summary = await enableOrcaReplayIntegration({
      input,
      output,
      platform: 'linux',
      environment: { SHELL: '/bin/zsh' },
      spawnInstall: async (command, args) => { spawned.push({ command, args }); },
      checkInstalled: async () => { throw new Error('absent'); },
    });
    assert.deepEqual(summary, { accepted: true, installed: 'installed', alias: 'appended' });
    assert.deepEqual(spawned, [{ command: 'sudo', args: ['npm', 'install', '--global', 'orcareplay'] }]);
    assert.match(await readFile(join(root, '.zshrc'), 'utf8'), /alias orca-opencode='orca record opencode'/);
    assert.match(writes(), /Add the orca-opencode alias to \.zshrc\? \[y\/N\]/);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing orca CLI skips installation and reports already_installed', async () => {
  const { input, output } = scriptedIO(['y', 'n']);
  let installCalls = 0;
  const summary = await enableOrcaReplayIntegration({
    input,
    output,
    platform: 'darwin',
    environment: { SHELL: '/bin/zsh' },
    spawnInstall: async () => { installCalls += 1; },
    checkInstalled: async () => undefined,
  });
  assert.equal(installCalls, 0);
  assert.equal(summary.installed, 'already_installed');
  assert.equal(summary.alias, 'skipped');
});

test('a failed install falls back to manual instructions without touching the rc', async () => {
  const { input, output, writes } = scriptedIO(['y']);
  const summary = await enableOrcaReplayIntegration({
    input,
    output,
    platform: 'linux',
    environment: { SHELL: '/bin/zsh' },
    spawnInstall: async () => { throw new Error('no tty for sudo'); },
    checkInstalled: async () => { throw new Error('absent'); },
  });
  assert.deepEqual(summary, { accepted: true, installed: 'failed', alias: 'skipped' });
  assert.match(writes(), /OrcaReplay installation failed: no tty for sudo/);
  assert.match(writes(), /sudo npm install --global orcareplay/);
  assert.match(writes(), /alias orca-opencode='orca record opencode'/);
});

test('alias block carries the sentinel and the exact shorthand', () => {
  assert.equal(orcaAliasBlock(), "# managed by kiokuko-ai setup: orca-opencode\nalias orca-opencode='orca record opencode'\n");
});
