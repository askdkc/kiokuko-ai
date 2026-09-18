import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { orcaAliasBlock } from '../../src/commands/orca-replay.js';
import { AGENT_TEMPLATE_VERSION } from '../../src/agent-file/render.js';
import { parse } from 'jsonc-parser';
import { buildCli } from '../../src/cli.js';
import { inspectProjectAgentFile } from '../../src/setup/project-agent-health.js';
import { openConnection } from '../../src/db/connection.js';
import { listRegisteredProjectLocations, refreshRegisteredProjectAgentFiles, summarizeProjectAgentRefresh, formatProjectAgentRefresh } from '../../src/setup/project-agent-refresh.js';
import { runSetupFlow, setupOpenCode } from '../../src/commands/setup.js';
import { useRepository } from '../../src/commands/use.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { BEGIN_MARKER, END_MARKER } from '../../src/agent-file/managed-block.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'setup-project-health-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await mkdir(project);
  const databasePath = path.join(root, 'data', 'kiokuko-ai.sqlite');
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), KIOKUKO_DATA_DIR: path.dirname(databasePath) };
  await mkdir(env.HOME);
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await useRepository({ root: project, allowDirectory: true, databasePath });
  return { project, databasePath, options: { databasePath, env, standardSkills: false } };
}

test('doctor identifies each broken project and setup repairs absent files without losing human text', async (t) => {
  const { project, databasePath, options } = await fixture(t);
  const file = path.join(project, 'AGENTS.md');
  const human = '# Human rules\nKeep this exact text.\n';
  await writeFile(file, human);
  const before = await runDoctor({ databasePath });
  assert.equal(before.checks.agentFiles.count, 1);
  const findings = (before.checks.agentFiles as { findings?: { repositoryRoot: string; reason: string; repair: string }[] }).findings;
  assert.equal(findings?.[0]?.repositoryRoot, project);
  assert.equal(findings?.[0]?.reason, 'managed_block_missing');
  assert.equal(findings?.[0]?.repair, 'setup');
  const result = await setupOpenCode(options);
  assert.equal(result.projectAgentFiles[0]?.status, 'created');
  assert.ok((await readFile(file, 'utf8')).startsWith(human));
  assert.equal((await runDoctor({ databasePath })).checks.agentFiles.ok, true);
  await rm(file);
  await setupOpenCode(options);
  assert.equal((await runDoctor({ databasePath })).checks.agentFiles.ok, true);
});

test('doctor and setup agree that reversed markers need manual repair and preserve original bytes', async (t) => {
  const { project, databasePath, options } = await fixture(t);
  const file = path.join(project, 'AGENTS.md');
  const invalid = `${END_MARKER}\nHuman text\n${BEGIN_MARKER}\n`;
  await writeFile(file, invalid);
  const before = await runDoctor({ databasePath });
  assert.equal(before.checks.agentFiles.ok, false);
  const result = await setupOpenCode(options);
  assert.equal(result.projectAgentFiles[0]?.status, 'failed');
  const issue = (result.projectAgentFiles[0] as { finding?: { reason: string; repair: string } }).finding;
  assert.equal(issue?.reason, 'managed_block_invalid');
  assert.equal(issue?.repair, 'manual');
  assert.equal(await readFile(file, 'utf8'), invalid);
});


test('setup reports partial repair and exits nonzero in both human and JSON modes', async (t) => {
  const { project, options } = await fixture(t);
  await writeFile(path.join(project, 'AGENTS.md'), BEGIN_MARKER + '\nHuman content with an incomplete marker.\n');
  const originalWrite = process.stdout.write;
  const previousExitCode = process.exitCode;
  try {
    for (const json of [false, true]) {
      process.exitCode = undefined;
      let output = '';
      process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
      await buildCli({ setupEnvironment: { env: options.env } }).parseAsync(['node', 'kiokuko-ai', 'setup', '--no-embeddings', '--no-standard-skills', ...(json ? ['--json'] : [])]);
      assert.equal(process.exitCode, 9);
      if (json) {
        const response = JSON.parse(output);
        assert.equal(response.ok, true);
        assert.equal(response.data.ok, false);
        assert.equal(response.data.projectAgentHealth.failed, 1);
        assert.equal(response.data.projectAgentFiles[0].finding.reason, 'managed_block_invalid');
      } else {
        assert.match(output, /Kiokuko setup incomplete/u);
        assert.ok(output.includes(project));
        assert.match(output, /managed_block_invalid/u);
        assert.doesNotMatch(output, /ready to use/u);
      }
    }
  } finally { process.stdout.write = originalWrite; process.exitCode = previousExitCode; }
});

test('project health distinguishes missing binding and stale or future instruction templates', async (t) => {
  const { project, databasePath, options } = await fixture(t);
  const database = openConnection(databasePath);
  const [location] = listRegisteredProjectLocations(database);
  database.close();
  const bindingPath = path.join(project, '.kiokuko.json');
  const original = await readFile(bindingPath, 'utf8');
  const binding = JSON.parse(original);
  await writeFile(bindingPath, JSON.stringify({ ...binding, templateVersion: 1 }));
  const stale = await inspectProjectAgentFile(location!);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.finding.reason, 'outdated_template');
  await setupOpenCode(options);
  assert.equal((await inspectProjectAgentFile(location!)).ok, true);
  await writeFile(bindingPath, JSON.stringify({ ...binding, templateVersion: 99999 }));
  const future = await inspectProjectAgentFile(location!);
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.finding.repair, 'manual');
  await rm(bindingPath);
  const missing = await inspectProjectAgentFile(location!);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.finding.reason, 'binding_missing');
  await setupOpenCode(options);
  assert.equal((await inspectProjectAgentFile(location!)).ok, true);
  assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).repositoryId, binding.repositoryId);
});


test('project refresh verifies the file after a reported successful write and skips verification for dry-run', async (t) => {
  const { project, databasePath } = await fixture(t);
  const receipt = await useRepository({ root: project, allowDirectory: true, databasePath });
  const database = openConnection(databasePath);
  const locations = listRegisteredProjectLocations(database);
  database.close();
  await rm(receipt.agentFile!);
  const dependencies = { useRepository: async () => ({ ...receipt, agentFileAction: 'created' as const }) };
  const [actual] = await refreshRegisteredProjectAgentFiles(locations, { databasePath }, dependencies);
  assert.equal(actual?.status, 'failed');
  if (actual?.status === 'failed') {
    assert.equal(actual.reason, 'verification_failed');
    assert.equal(actual.finding?.reason, 'agent_file_missing');
  }
  const [planned] = await refreshRegisteredProjectAgentFiles(locations, { databasePath, dryRun: true }, dependencies);
  assert.equal(planned?.status, 'created');
  await assert.rejects(readFile(receipt.agentFile!), { code: 'ENOENT' });
});

for (const kind of ['newer_template', 'other_product'] as const) {
  test(`setup preserves ${kind} instructions and reports a notice without downgrading or rewriting`, async t => {
    const { project, databasePath, options } = await fixture(t);
    const bindingPath = path.join(project, '.kiokuko.json');
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    if (kind === 'newer_template') binding.templateVersion = AGENT_TEMPLATE_VERSION + 1;
    const bindingText = JSON.stringify(binding);
    await writeFile(bindingPath, bindingText);
    const declaration = kind === 'other_product'
      ? '<!-- kiokuko-dsh-template-version: 1 -->'
      : `<!-- kiokuko-template-version: ${AGENT_TEMPLATE_VERSION + 1} -->`;
    const agent = `Human prefix\n${BEGIN_MARKER}\n${declaration}\nOwned instructions.\n${END_MARKER}\nHuman suffix\n`;
    await writeFile(path.join(project, 'AGENTS.md'), agent);
    for (const dryRun of [true, false]) {
      const result = await setupOpenCode({ ...options, dryRun });
      const health = summarizeProjectAgentRefresh(result.projectAgentFiles);
      assert.equal(health.ok, true);
      assert.equal(health.failed, 0);
      assert.equal(health.preserved, 1);
      assert.equal(result.projectAgentFiles[0]?.status, 'preserved');
      assert.match(formatProjectAgentRefresh(result.projectAgentFiles), new RegExp(kind));
      assert.equal(await readFile(bindingPath, 'utf8'), bindingText);
      assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), agent);
    }
    const doctor = await runDoctor({ databasePath });
    assert.equal(doctor.checks.agentFiles.ok, true);
    assert.equal(doctor.checks.agentFiles.notices?.[0]?.reason, kind);
  });
}

test('future versions and DSH declarations cannot bypass malformed marker or identity checks', async t => {
  const { project, options } = await fixture(t);
  const bindingPath = path.join(project, '.kiokuko.json');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
  await writeFile(bindingPath, JSON.stringify({ ...binding, templateVersion: AGENT_TEMPLATE_VERSION + 1 }));
  const cases = [
    `${BEGIN_MARKER}\n<!-- kiokuko-template-version: 99999 -->\n`,
    `${BEGIN_MARKER}\n<!-- kiokuko-template-version: ${AGENT_TEMPLATE_VERSION} -->\n<!-- kiokuko-dsh-template-version: 1 -->\n${END_MARKER}`,
  ];
  for (const content of cases) {
    await writeFile(path.join(project, 'AGENTS.md'), content);
    const result = await setupOpenCode(options);
    assert.equal(result.projectAgentFiles[0]?.status, 'failed');
    assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), content);
  }
  await writeFile(path.join(project, 'AGENTS.md'), `${BEGIN_MARKER}\n<!-- kiokuko-dsh-template-version: 1 -->\n${END_MARKER}`);
  await writeFile(bindingPath, JSON.stringify({ ...binding, workspace: 'project:another' }));
  assert.equal((await setupOpenCode(options)).projectAgentFiles[0]?.status, 'failed');
});

test('repeated and embedding dependency setup preserve completed choices without optional prompts or installs', async t => {
  const { options } = await fixture(t);
  const initial = await setupOpenCode({ ...options, skillDiscoveryMode: 'community' });
  const configPath = initial.files.find(file => file.purpose === 'mcp-config')!.path;
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true; output.isTTY = true;
  t.after(() => { input.destroy(); output.destroy(); });
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  await writeFile(path.join(options.env.HOME, '.zshrc'), orcaAliasBlock());
  for (const optionalPrompts of [true, false]) {
    let checks = 0;
    await runSetupFlow({ environment: { env: { ...options.env, SHELL: '/bin/zsh' } }, standardSkills: false, optionalPrompts, input, output }, {
      orcaReplayCheckInstalled: async () => { checks++; },
      orcaReplaySpawnInstall: async () => { assert.fail('must not reinstall optional Orca'); },
    });
    assert.equal(checks, optionalPrompts ? 1 : 0);
  }
  assert.equal(text, '');
  assert.equal(parse(await readFile(configPath, 'utf8')).mcp.kiokuko.environment.KIOKUKO_SKILL_DISCOVERY, 'community');
});
