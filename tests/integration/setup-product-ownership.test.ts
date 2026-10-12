import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { renderAgentFile } from '../../src/agent-file/render.js';
import { setupOpenCode, runSetupFlow } from '../../src/commands/setup.js';
import { useRepository } from '../../src/commands/use.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { openConnection } from '../../src/db/connection.js';

const foreignBlock = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n<!-- kiokuko-template-version: 36 -->\nForeign instructions.\n<!-- END KIOKUKO MANAGED BLOCK -->';

test('renderer owns only the kiokuko-ai comment block and preserves foreign instructions', () => {
  const original = '# Human instructions\n' + foreignBlock + '\n';
  const first = renderAgentFile(original, { repositoryId: 'repo-fixture', workspace: 'project:fixture', cliCommand: 'kiokuko-ai' });
  assert.ok(first.content.startsWith(original));
  assert.match(first.content, /<!-- BEGIN KIOKUKO-AI MANAGED BLOCK -->/u);
  assert.match(first.content, /Only.*kiokuko-ai.*read.*update/iu);
  assert.equal(renderAgentFile(first.content, { repositoryId: 'repo-fixture', workspace: 'project:fixture', cliCommand: 'kiokuko-ai' }).action, 'unchanged');
});

for (const answer of ['y', 'n']) {
  test(`registered legacy binding version36 stays intact when missing AGENTS.md recovery answers ${answer}`, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'setup-product-ownership-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    await mkdir(project);
    const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), KIOKUKO_DATA_DIR: path.join(root, 'data') };
    await mkdir(env.HOME);
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const databasePath = path.join(env.KIOKUKO_DATA_DIR, 'kiokuko-ai.sqlite');
    const registered = await useRepository({ root: project, allowDirectory: true, databasePath });
    const legacy = JSON.stringify({ schemaVersion: 1, repositoryId: registered.repositoryId,
      workspace: registered.workspace, agentFile: 'AGENTS.md', templateVersion: 36 });
    await writeFile(path.join(project, '.kiokuko.json'), legacy);
    await rm(path.join(project, '.kiokuko-ai.json'), { force: true });
    await rm(path.join(project, 'AGENTS.md'));
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true; output.isTTY = true;
    t.after(() => { input.destroy(); output.destroy(); });
    let prompts = 0;
    output.on('data', chunk => { if (chunk.toString().includes('[y/N]')) { prompts++; setImmediate(() => input.write(answer + '\n')); } });
    const result = await runSetupFlow({ environment: { env }, standardSkills: false, skillDiscoveryMode: 'official', optionalPrompts: false, input, output });
    assert.equal(prompts, 1);
    assert.equal(await readFile(path.join(project, '.kiokuko.json'), 'utf8'), legacy);
    if (answer === 'y') {
      assert.equal(result.projectAgentFiles[0]?.status, 'created');
      const binding = JSON.parse(await readFile(path.join(project, '.kiokuko-ai.json'), 'utf8'));
      assert.equal(binding.repositoryId, registered.repositoryId);
      const agent = await readFile(path.join(project, 'AGENTS.md'), 'utf8');
      assert.match(agent, /BEGIN KIOKUKO-AI MANAGED BLOCK/u);
      assert.doesNotMatch(agent, /BEGIN KIOKUKO MANAGED BLOCK/u);
      assert.equal((await setupOpenCode({ env, databasePath, standardSkills: false })).projectAgentFiles[0]?.status, 'unchanged');
      const db = openConnection(databasePath);
      try { assert.equal((await resolveProjectWorkspace(db, project))?.repositoryId, registered.repositoryId); }
      finally { db.close(); }
    } else {
      assert.equal(result.projectAgentFiles[0]?.status, 'failed');
      await assert.rejects(readFile(path.join(project, 'AGENTS.md')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(project, '.kiokuko-ai.json')), { code: 'ENOENT' });
    }
  });
}
