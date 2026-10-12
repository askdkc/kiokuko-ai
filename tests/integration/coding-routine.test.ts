import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setupOpenCode } from '../../src/commands/setup.js';
import { loadBundledStandardSkillFiles } from '../../src/setup/standard-skills.js';
import { renderGlobalInstructions } from '../../src/setup/render.js';
import { renderManagedBlock } from '../../src/agent-file/render.js';
import { completeRequiredSkillList } from '../../src/enno-oduno/skills.js';
import { resolveCapabilities } from '../../src/akinator/capabilities.js';

const routine = 'coding-ideal-routine-skill';
const expectedFiles = ['SKILL.md', 'references/repo-contracts.md', 'references/verification-scenarios.md'];

test('bundles the coding routine and both attached references', async () => {
  const files = (await loadBundledStandardSkillFiles()).filter(file => file.skillName === routine);
  assert.deepEqual(files.map(file => file.relativePath), expectedFiles);
  for (const file of files) assert.equal(file.content.split(file.managedMarker).length - 1, 1);
});

test('global and project instructions require the routine before coding', () => {
  for (const content of [renderGlobalInstructions().content, renderManagedBlock({
    repositoryId: 'repo-fixture', workspace: 'project:fixture', cliCommand: 'kiokuko-ai',
  })]) {
    assert.match(content, /before writing or changing code, read and apply `coding-ideal-routine-skill`/u);
  }
});

test('code units include the routine even when omitted or declared optional', () => {
  const requirements = completeRequiredSkillList({
    requested: [{ name: routine, purposes: ['review'], required: false }],
    includesCodeChanges: true, includesUiWork: true,
  });
  assert.equal(requirements.filter(item => item.name === routine).length, 1);
  assert.equal(requirements.find(item => item.name === routine)?.required, true);
  assert.equal(completeRequiredSkillList({ requested: [], includesCodeChanges: true, includesUiWork: false })
    .some(item => item.name === routine && item.required), true);
  assert.equal(completeRequiredSkillList({ requested: [], includesCodeChanges: false, includesUiWork: false })
    .some(item => item.name === routine), false);
});

test('coding recommendations use deterministic policy instead of similarity', () => {
  for (const task of ['Fix a TypeScript function', '設定画面を実装する', 'Add integration tests']) {
    const result = resolveCapabilities({ task,
      profile: { taskType: 'build', target: 'src/app.ts', expected: 'Tests pass', constraints: null },
      recommendedTags: [], capabilities: [{ kind: 'skill', name: routine }], memoryUse: 'none',
    });
    assert.equal(result.recommendations.some(item => item.name === routine && item.source === 'akinator_policy'), true);
  }
  const writing = resolveCapabilities({ task: 'Revise documentation only',
    profile: { taskType: 'writing', target: 'README.md', expected: 'Clear prose', constraints: 'no code changes' },
    recommendedTags: [], capabilities: [{ kind: 'skill', name: routine }], memoryUse: 'none',
  });
  assert.equal(writing.recommendations.some(item => item.name === routine && item.source === 'akinator_policy'), false);
});

test('normal setup installs and refreshes the coding routine without overwriting user files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-coding-routine-'));
  const config = path.join(root, 'config');
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(root, 'data') };
  const options = { env, databasePath: path.join(root, 'memory.sqlite'), command: 'kiokuko-ai' };
  try {
    const first = await setupOpenCode(options);
    const skillFiles = first.files.filter(file => file.path.includes(`/${routine}/`));
    assert.equal(skillFiles.length, 3);
    const main = skillFiles.find(file => file.path.endsWith('/SKILL.md'))!;
    assert.match(await readFile(main.path, 'utf8'), /^---\nname: coding-ideal-routine-skill\n/u);
    const instruction = first.files.find(file => file.purpose === 'instructions')!;
    assert.match(await readFile(instruction.path, 'utf8'), /read and apply `coding-ideal-routine-skill`/u);
    const original = await readFile(main.path, 'utf8');
    await writeFile(main.path, original.replace('# Coding Ideal Routine', '# Old managed routine'));
    const updated = await setupOpenCode(options);
    assert.equal(updated.files.find(file => file.path === main.path)?.action, 'updated');
    assert.equal(await readFile(main.path, 'utf8'), original);
    assert.equal((await setupOpenCode(options)).files.every(file => file.action === 'unchanged'), true);
    await writeFile(main.path, 'User owned skill\n');
    await assert.rejects(setupOpenCode(options), /unmanaged standard skill/u);
    assert.equal(await readFile(main.path, 'utf8'), 'User owned skill\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
