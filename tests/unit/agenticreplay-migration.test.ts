import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendAgenticReplayAlias, agenticreplayAliasBlock, agenticReplayInstallInvocation } from '../../src/commands/agentic-replay.js';
import { agenticreplayRunsDirectory } from '../../src/trace/scan.js';

test('AgenticReplay is the installer, shortcut and trace-store target', () => {
  assert.deepEqual(agenticReplayInstallInvocation(), { command: 'npm', args: ['install', '--global', 'agenticreplay'] });
  assert.equal(agenticreplayAliasBlock(), "# managed by kiokuko-ai setup: agenticreplay-opencode\nalias agenticreplay-opencode='kiokuko-ai trace record --'\n");
  assert.equal(agenticreplayRunsDirectory('/tmp/project'), '/tmp/project/.agenticreplay/runs');
});

for (const command of ['orca record opencode', 'kiokuko-ai trace record --']) {
  test(`upgrades the exact managed Orca shortcut (${command}) without retaining old support`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'agenticreplay-alias-upgrade-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const rc = path.join(root, '.zshrc');
    await writeFile(rc, `# human\r\n# managed by kiokuko-ai setup: orca-opencode\r\nalias orca-opencode='${command}'\r\n# tail\r\n`, { mode: 0o640 });
    const environment = { env: { KIOKUKO_DATA_DIR: path.join(root, 'data') } };
    assert.deepEqual(await appendAgenticReplayAlias(rc, environment), { appended: true });
    assert.equal(await readFile(rc, 'utf8'), "# human\r\n# managed by kiokuko-ai setup: agenticreplay-opencode\r\nalias agenticreplay-opencode='kiokuko-ai trace record --'\r\n# tail\r\n");
    assert.deepEqual(await appendAgenticReplayAlias(rc, environment), { appended: false, reason: 'already_present' });
  });
}

test('a conflicting new shortcut prevents old managed shortcut mutation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agenticreplay-alias-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rc = path.join(root, '.bashrc');
  const content = "# managed by kiokuko-ai setup: orca-opencode\nalias orca-opencode='kiokuko-ai trace record --'\nalias agenticreplay-opencode='custom'\n";
  await writeFile(rc, content);
  assert.deepEqual(await appendAgenticReplayAlias(rc, { env: { KIOKUKO_DATA_DIR: path.join(root, 'data') } }), { appended: false, reason: 'alias_conflict' });
  assert.equal(await readFile(rc, 'utf8'), content);
});
