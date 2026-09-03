import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { KiokukoError } from '../../src/errors.js';
import {
  parseSetupSkillDiscoveryMode,
  promptCommunitySkillDiscovery,
  promptReplaceConflictingMcp,
  promptSetupConfiguration,
} from '../../src/commands/setup.js';

function interactiveAnswers(...answers: string[]): PassThrough & { isTTY?: boolean } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  let index = 0;
  const writeNext = () => {
    const answer = answers[index];
    if (answer === undefined) {
      input.end();
      return;
    }
    index += 1;
    input.write(answer);
    setImmediate(writeNext);
  };
  setImmediate(writeNext);
  return input;
}

test('reports the package version instead of a stale hard-coded CLI version', () => {
  const packageMetadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(buildCli().version(), packageMetadata.version);
});

test('prints the package version from the version subcommand', async () => {
  const packageMetadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli().parseAsync(['node', 'kiokuko-ai', 'version']);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(stdout, `${packageMetadata.version}\n`);
});

test('registers exactly the supported OpenCode and operator commands', () => {
  const names = buildCli().commands.map((command) => command.name());
  assert.deepEqual(names, [
    'version',
    'init',
    'setup',
    'mcp',
    'use',
    'recall',
    'memory',
    'guide',
    'search',
    'read',
    'record',
    'promote',
    'curator',
    'supersede',
    'link',
    'purge',
    'backup',
    'doctor',
    'ledger',
    'skills',
    'enno',
    'embeddings',
    'web',
    'export',
    'import',
  ]);
});

test('does not synthesize an agent-file override when the use flag is omitted', () => {
  const use = buildCli().commands.find((command) => command.name() === 'use');
  assert.ok(use);
  const agentFile = use.options.find((option) => option.long === '--agent-file');
  assert.ok(agentFile);
  assert.equal(agentFile.defaultValue, undefined);
});

test('exposes the small external-skill management surface', () => {
  const skills = buildCli().commands.find((command) => command.name() === 'skills');
  assert.ok(skills);
  assert.deepEqual(skills.commands.map((command) => command.name()), ['find', 'import', 'list', 'show', 'disable', 'enable', 'refresh', 'prune-cache']);
  assert.match(skills.commands.find((command) => command.name() === 'find')?.helpInformation() ?? '', /--official-only/);
  assert.match(skills.commands.find((command) => command.name() === 'import')?.helpInformation() ?? '', /<skill>/);
  assert.deepEqual(skills.commands.find((command) => command.name() === 'list')?.options.find((option) => option.long === '--state')?.argChoices, ['discovered', 'imported', 'blocked', 'stale', 'disabled']);
});

test('exposes scoped recall through the documented memory recall command', () => {
  const memory = buildCli().commands.find((command) => command.name() === 'memory');
  assert.ok(memory);
  assert.deepEqual(memory.commands.map((command) => command.name()), ['recall']);
  const recall = memory.commands[0];
  assert.ok(recall);
  assert.match(recall.helpInformation(), /<query>/);
  assert.match(recall.helpInformation(), /--scope <scope>/);
  assert.match(recall.helpInformation(), /--cwd <path>/);
  assert.match(recall.helpInformation(), /--limit <number>/);
  assert.match(recall.helpInformation(), /--max-chars <number>/);
  assert.match(recall.helpInformation(), /--workspace <name>/);
  assert.match(recall.helpInformation(), /--json/);
  assert.match(recall.description(), /Human\/operator management/u);
});

test('exposes the curator review and confirmation options', () => {
  const curator = buildCli().commands.find((command) => command.name() === 'curator');
  assert.ok(curator);
  const help = curator.helpInformation();
  assert.match(help, /--workspace <name>/);
  assert.match(help, /--entry-id <id>/);
  assert.match(help, /--skill-ready-only/);
  assert.match(help, /--yes/);
  assert.match(help, /--json/);
});

test('exposes the Akinator guide subcommands', () => {
  const guide = buildCli().commands.find((command) => command.name() === 'guide');
  assert.ok(guide);
  assert.deepEqual(guide.commands.map((command) => command.name()), ['start', 'answer']);
});

test('exposes help for the use command', () => {
  const use = buildCli().commands.find((command) => command.name() === 'use');
  assert.ok(use);
  assert.match(use.helpInformation(), /--root/);
  assert.match(use.helpInformation(), /--workspace/);
  assert.match(use.helpInformation(), /--dry-run/);
});

test('exposes OpenCode-only global setup', () => {
  const setup = buildCli().commands.find((command) => command.name() === 'setup');
  assert.ok(setup);
  assert.match(setup.helpInformation(), /--no-standard-skills/);
  assert.match(setup.helpInformation(), /--skill-discovery <mode>/);
  assert.match(setup.description(), /OpenCode/);
  assert.doesNotMatch(setup.helpInformation(), /--clients\b/u);
});

test('no-argument setup configures OpenCode automatically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-opencode-'));
  const configRoot = path.join(root, 'config');
  const dataRoot = path.join(root, 'data');
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({ setupEnvironment: { platform: 'linux', env: { HOME: root, PATH: '', XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: dataRoot } } })
      .parseAsync(['node', 'kiokuko-ai', 'setup', '--dry-run', '--json']);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as { data: { client: string; files: Array<{ client: string }> }; ok: boolean };
  assert.equal(response.ok, true);
  assert.equal(response.data.client, 'opencode');
  assert.ok(response.data.files.every((file) => file.client === 'opencode'));
});

test('setup prompt keeps official discovery by default and explicitly enables community discovery', async () => {
  let outputText = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString();
      callback();
    },
  });
  assert.equal(await promptCommunitySkillDiscovery({ input: Readable.from(['\n']), output }), 'official');
  assert.match(outputText, /Official external Skill discovery is enabled by default/u);
  assert.match(outputText, /Enable community Skill discovery\? \[y\/N\]/u);

  const enabledOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  assert.equal(await promptCommunitySkillDiscovery({ input: Readable.from(['yes\n']), output: enabledOutput }), 'community');
  assert.equal(parseSetupSkillDiscoveryMode('off'), 'off');
  assert.equal(parseSetupSkillDiscoveryMode('community'), 'community');
  assert.throws(() => parseSetupSkillDiscoveryMode('on'), /off, official, or community/u);
});

test('combined setup prompt keeps both answers in one readline session', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const selected = await promptSetupConfiguration({
    input: interactiveAnswers('y\n'),
    output,
  });
  assert.equal(selected, 'community');
});

test('client conflict prompt defaults to yes and accepts explicit negative answers', async () => {
  let outputText = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString();
      callback();
    },
  });
  assert.equal(await promptReplaceConflictingMcp({ input: Readable.from(['\n']), output }), true);
  assert.match(outputText, /remove that identity, install the managed configuration, and continue setup/u);
  assert.match(outputText, /Replace the existing OpenCode Kiokuko MCP identity and continue\? \[Y\/n\]/u);

  for (const answer of ['n\n', 'no\n', 'いいえ\n']) {
    const declineOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    assert.equal(
      await promptReplaceConflictingMcp({ input: Readable.from([answer]), output: declineOutput }),
      false,
    );
  }
});

test('interactive setup replaces a conflicting OpenCode MCP identity after accepting the default confirmation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-opencode-replace-'));
  const configRoot = path.join(root, 'config');
  const configPath = path.join(configRoot, 'opencode', 'opencode.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    theme: 'keep',
    mcp: { other: { command: ['keep'] }, kiokuko: { type: 'remote', url: 'https://example.test' } },
  }, null, 2));

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  let promptOutput = '';
  let answeredCommunity = false;
  let answeredReplacement = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      promptOutput += text;
      if (!answeredCommunity && text.includes('Enable community Skill discovery?')) {
        answeredCommunity = true;
        setImmediate(() => input.write('\n'));
      }
      if (!answeredReplacement && text.includes('Replace the existing OpenCode Kiokuko MCP identity')) {
        answeredReplacement = true;
        setImmediate(() => {
          input.write('\n');
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: {
        platform: 'linux',
        env: { HOME: root, PATH: '', XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: path.join(root, 'data') },
      },
      setupInput: input,
      setupOutput: output,
    }).parseAsync([
      'node',
      'kiokuko-ai',
      'setup',
      '--no-standard-skills',
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(promptOutput, /Enable community Skill discovery\? \[y\/N\]/u);
  assert.doesNotMatch(promptOutput, /Select clients to configure|Clients \[/u);
  assert.match(promptOutput, /non-canonical or unmanaged Kiokuko MCP identity/u);
  assert.match(stdout, /Kiokuko configured for opencode/u);
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    theme: string;
    mcp: { kiokuko: { type: string }; other: unknown };
  };
  assert.equal(config.theme, 'keep');
  assert.equal(config.mcp.kiokuko.type, 'local');
  assert.deepEqual(config.mcp.other, { command: ['keep'] });
});

test('interactive setup preserves a conflicting OpenCode MCP identity when replacement is declined', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-opencode-decline-'));
  const configRoot = path.join(root, 'config');
  const configPath = path.join(configRoot, 'opencode', 'opencode.json');
  const original = JSON.stringify({ theme: 'keep', mcp: { kiokuko: { type: 'remote', url: 'https://example.test' } } }, null, 2);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, original);

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const answered: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      if (!answered.includes('replacement') && text.includes('Replace the existing OpenCode Kiokuko MCP identity')) {
        answered.push('replacement');
        setImmediate(() => {
          input.write('n\n');
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  await assert.rejects(buildCli({
    setupEnvironment: {
      platform: 'linux',
      env: { HOME: root, PATH: '', XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: path.join(root, 'data') },
    },
    setupInput: input,
    setupOutput: output,
  }).parseAsync([
    'node',
    'kiokuko-ai',
    'setup',
    '--skill-discovery',
    'official',
    '--no-standard-skills',
  ]), (error: unknown) => error instanceof KiokukoError
    && error.code === 'CONFLICT'
    && /conflicting kiokuko MCP server/u.test(error.message));

  assert.equal(await readFile(configPath, 'utf8'), original);
});
