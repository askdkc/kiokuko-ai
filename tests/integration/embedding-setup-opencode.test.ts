import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Command } from 'commander';
import { parse } from 'jsonc-parser';
import { registerEmbeddingsCommands } from '../../src/commands/embeddings.js';
import type { DoctorResult } from '../../src/commands/doctor.js';
import { setupOpenCode } from '../../src/commands/setup.js';
import { getGlobalDatabasePath } from '../../src/config/paths.js';
import { openConnection } from '../../src/db/connection.js';
import { renderOpenCodeConfig } from '../../src/setup/opencode-config.js';

const execFileAsync = promisify(execFile);

for (const initial of ['fresh', 'legacy', 'current'] as const) {
  test(`embedding setup leaves ${initial} OpenCode registration healthy and repeatable`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-embedding-opencode-'));
    const env = {
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      KIOKUKO_DATA_DIR: path.join(root, 'data'),
    };
    const configPath = path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc');
    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      const unrelated = '{ // Preserve user configuration\n "plugin": ["unrelated-plugin"], "theme": "custom"\n}\n';
      await writeFile(configPath, initial === 'legacy'
        ? renderOpenCodeConfig(unrelated, 'kiokuko-ai', 'community').content
        : unrelated);
      if (initial === 'current') await setupOpenCode({ env, skillDiscoveryMode: 'community' });

      let output = '';
      const setup = async () => {
        const cli = new Command();
        cli.exitOverride();
        registerEmbeddingsCommands(cli, {
          pathEnvironment: { env },
          withDatabase: async (operation) => {
            const database = openConnection(getGlobalDatabasePath({ env }));
            try {
              return await operation(database);
            } finally {
              database.close();
            }
          },
          // Model provisioning is independent of OpenCode registration.
          optionalRuntimeChecker: async () => undefined,
          modelInstaller: async () => ({
            installation: 'installed',
            directory: path.join(root, 'model'),
            relativePath: 'models/embeddings/local-small/test',
            totalBytes: 0,
            manifestHash: 'a'.repeat(64),
          }),
          provider: {
            profile: { providerKind: 'local-transformers' } as never,
            embed: async () => { throw new Error('Empty database must not request embeddings'); },
          },
          output: (_json, _operation, data) => { output = JSON.stringify(data); },
        });
        await cli.parseAsync(['node', 'kiokuko-ai', 'embeddings', 'setup', '--json']);
        assert.equal(JSON.parse(output).semanticEnabled, true);
      };

      await setup();
      // Run the actual doctor in a separate process, using only this fixture's
      // configuration and data. The fake model is excluded from these assertions.
      const { stdout } = await execFileAsync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval',
        'import { runDoctor } from "./src/commands/doctor.ts"; console.log(JSON.stringify(await runDoctor()));',
      ], { env: { ...process.env, ...env } });
      const doctor = JSON.parse(stdout) as DoctorResult;
      for (const check of ['openCodePlugin', 'openCodeMcp', 'openCodeRuntime', 'openCodeSkills'] as const) {
        assert.equal(doctor.checks[check].ok, true, `${check}: ${doctor.checks[check].detail}`);
      }

      const firstConfig = await readFile(configPath, 'utf8');
      const config = parse(firstConfig);
      assert.match(firstConfig, /Preserve user configuration/u);
      assert.equal(config.theme, 'custom');
      assert.equal(config.plugin[0], 'unrelated-plugin');
      assert.equal(config.mcp.kiokuko.environment.KIOKUKO_SKILL_DISCOVERY, initial === 'fresh' ? 'official' : 'community');
      await setup();
      assert.equal(await readFile(configPath, 'utf8'), firstConfig);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
