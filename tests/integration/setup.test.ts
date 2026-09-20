import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { runSetupFlow, setupOpenCode } from '../../src/commands/setup.js';
import { KIOKUKO_OPENCODE_PLUGIN_PACKAGE } from '../../src/setup/opencode-config.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { loadMigrationSnapshot, migrateDatabase } from '../../src/db/migrate.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { planUnfinishedLedgerRunCleanup, purgeUnfinishedLedgerRuns } from '../../src/ledger/maintenance.js';

async function temporaryEnvironment(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-setup-${prefix}-`));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  await mkdir(home, { recursive: true });
  return {
    config,
    env: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
    databasePath: path.join(data, 'kiokuko', 'kiokuko-ai.sqlite'),
    openCodeConfig: path.join(config, 'opencode', 'opencode.jsonc'),
  };
}

test('setup targets OpenCode only and is idempotent', async () => {
  const temporary = await temporaryEnvironment('opencode');
  const first = await setupOpenCode({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  assert.equal(first.client, 'opencode');
  const config = parse(await readFile(temporary.openCodeConfig, 'utf8')) as {
    plugin: unknown[];
    mcp: { kiokuko: { command: string[] } };
  };
  assert.equal(config.plugin.length, 1);
  const plugin = config.plugin[0] as [string, Record<string, unknown>];
  assert.equal(plugin[0], `${KIOKUKO_OPENCODE_PLUGIN_PACKAGE}@${PACKAGE_VERSION}`);
  assert.deepEqual(Object.keys(plugin[1]).sort(), ['cliScript', 'nodeExecutable', 'orchestration', 'orchestrationManagedAgents', 'packageVersion', 'protocolVersion']);
  assert.equal(config.mcp.kiokuko.command.at(-1), 'mcp');
  assert.equal(config.mcp.kiokuko.command.length, 3);
  assert.ok(config.mcp.kiokuko.command[0]?.startsWith('/'));
  assert.ok(config.mcp.kiokuko.command[1]?.endsWith('/dist/bin/kiokuko.js'));
  const second = await setupOpenCode({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  assert.equal(second.files.some((file) => file.action !== 'unchanged'), false);
});
test('setup dry-run does not write config or database', async () => {
  const temporary = await temporaryEnvironment('dry-run');
  const result = await setupOpenCode({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  await assert.rejects(readFile(temporary.openCodeConfig));
  await assert.rejects(readFile(temporary.databasePath));
});

test('setup preserves unknown OpenCode plugin entries', async () => {
  const temporary = await temporaryEnvironment('unknown-plugin');
  await mkdir(path.dirname(temporary.openCodeConfig), { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(
    temporary.openCodeConfig,
    '{ "plugin": ["unrelated-plugin"] }\n',
    'utf8',
  ));
  await setupOpenCode({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    standardSkills: false,
  });
  const config = parse(await readFile(temporary.openCodeConfig, 'utf8')) as { plugin: unknown[] };
  assert.equal(config.plugin[0], 'unrelated-plugin');
  assert.equal((config.plugin[1] as [string])[0], `${KIOKUKO_OPENCODE_PLUGIN_PACKAGE}@${PACKAGE_VERSION}`);
});


test('setup respects explicit config directory and file overrides and preserves an existing JSON file', async () => {
  const fixture = await temporaryEnvironment('config-overrides');
  const directory = path.join(fixture.config, 'custom');
  await mkdir(directory, { recursive: true });
  const existing = path.join(directory, 'opencode.json');
  await writeFile(existing, '{"model":"user/parent"}');
  const env = { ...fixture.env, OPENCODE_CONFIG_DIR: directory };
  await setupOpenCode({ env, databasePath: fixture.databasePath, standardSkills: false, command: 'kiokuko-ai' });
  assert.equal(parse(await readFile(existing, 'utf8')).model, 'user/parent');
  await assert.rejects(access(path.join(directory, 'opencode.jsonc')));
  const explicit = path.join(fixture.config, 'file-override', 'custom.jsonc');
  const changedEnv = { ...env, OPENCODE_CONFIG: explicit };
  const dry = await setupOpenCode({ env: changedEnv, databasePath: fixture.databasePath, standardSkills: false, command: 'kiokuko-ai', dryRun: true });
  assert.ok(dry.files.some(file => file.path === explicit && file.action === 'created'));
  await assert.rejects(access(explicit));
  await setupOpenCode({ env: changedEnv, databasePath: fixture.databasePath, standardSkills: false, command: 'kiokuko-ai' });
  assert.ok(parse(await readFile(explicit, 'utf8')).agent);
});

test('interactive setup deletes unfinished ledger runs after default confirmation', async () => {
  const temporary = await temporaryEnvironment('unfinished-ledger-cleanup');
  await initializeDatabase({ databasePath: temporary.databasePath });
  const database = openConnection(temporary.databasePath);
  try {
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun({
      runId: 'run-unfinished',
      workspace: 'workspace-a',
      protocolVersion: '1',
      client: { kind: 'opencode', version: '1.0.0' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Task', query: 'Run tests', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      metadata: {},
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    database.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES ('session-unfinished', 'workspace-a', 'Task', '{"taskType":"build","target":null,"expected":null,"constraints":null}', 'active', 0, ?, ?)
    `).run('2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO run_intakes (run_id, session_id, policy_version, profile_schema_version, profile_sources_json, recommended_tags_json, linked_at)
      VALUES ('run-unfinished', 'session-unfinished', 'v1', 1, '{"taskType":"inferred"}', '[]', ?)
    `).run('2026-08-20T00:00:00.000Z');
    store.updateRunStatus('run-unfinished', 'active');
  } finally {
    database.close();
  }
  const skipped = await setupOpenCode({
    databasePath: temporary.databasePath,
    platform: 'linux',
    env: temporary.env,
    command: 'kiokuko-ai',
    standardSkills: false,
  });
  assert.equal(skipped.ledgerCleanup.status, 'skipped');
  assert.equal(skipped.ledgerCleanup.candidateCount, 1);

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  let promptText = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      promptText += text;
      if (text.includes('Delete these unfinished ledger runs?')) {
        setImmediate(() => {
          input.write('\n');
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  const result = await runSetupFlow({
    environment: { platform: 'linux', env: temporary.env },
    command: 'kiokuko-ai',
    standardSkills: false,
    skillDiscoveryMode: 'official',
    optionalPrompts: false,
    input,
    output,
  });

  assert.equal(result.ledgerCleanup.status, 'deleted');
  assert.equal(result.ledgerCleanup.deletedRuns, 1);
  assert.match(promptText, /run-unfinished/u);
  const reopened = openConnection(temporary.databasePath);
  try {
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()?.count, 0);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM ledger_purge_audit').get<{ count: number }>()?.count, 1);
  } finally {
    reopened.close();
  }
});

test('interactive setup reports confirmed cleanup already resolved by another process', async () => {
  const temporary = await temporaryEnvironment('concurrent-ledger-cleanup');
  await initializeDatabase({ databasePath: temporary.databasePath });
  const database = openConnection(temporary.databasePath);
  try {
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun({
      runId: 'run-concurrent',
      workspace: 'workspace-a',
      protocolVersion: '1',
      client: { kind: 'opencode', version: '1.0.0' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Task', query: 'Run tests', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      metadata: {},
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    database.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES ('session-concurrent', 'workspace-a', 'Task', '{"taskType":"build","target":null,"expected":null,"constraints":null}', 'active', 0, ?, ?)
    `).run('2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO run_intakes (run_id, session_id, policy_version, profile_schema_version, profile_sources_json, recommended_tags_json, linked_at)
      VALUES ('run-concurrent', 'session-concurrent', 'v1', 1, '{"taskType":"inferred"}', '[]', ?)
    `).run('2026-08-20T00:00:00.000Z');
    store.updateRunStatus('run-concurrent', 'active');
  } finally {
    database.close();
  }

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  let promptCount = 0;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (chunk.toString().includes('Delete these unfinished ledger runs?') && promptCount === 0) {
        promptCount += 1;
        const concurrent = openConnection(temporary.databasePath);
        try {
          const plan = planUnfinishedLedgerRunCleanup(concurrent);
          purgeUnfinishedLedgerRuns(concurrent, {
            expectedDigest: plan.digest,
            actor: 'concurrent-test',
            createdAt: '2026-08-20T00:00:01.000Z',
            batchId: 'concurrent-batch',
            confirmed: true,
          });
        } finally {
          concurrent.close();
        }
        setImmediate(() => {
          input.write('\n');
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  const result = await runSetupFlow({
    environment: { platform: 'linux', env: temporary.env },
    command: 'kiokuko-ai',
    standardSkills: false,
    skillDiscoveryMode: 'official',
    optionalPrompts: false,
    input,
    output,
  });

  assert.equal(promptCount, 1);
  assert.deepEqual(result.ledgerCleanup, {
    status: 'resolved',
    candidateCount: 1,
    deletedRuns: 0,
    deletedCount: 0,
    scrubbedReceipts: 0,
  });
});

test('interactive cleanup retry preserves migrations applied by the first setup attempt', async () => {
  const temporary = await temporaryEnvironment('cleanup-migration-report');
  const partialMigrations = path.join(path.dirname(temporary.config), 'migrations');
  await mkdir(partialMigrations);
  const snapshot = loadMigrationSnapshot();
  for (const migration of snapshot.migrations.slice(0, 8)) {
    await copyFile(path.resolve(import.meta.dirname, '../../migrations', migration.name), path.join(partialMigrations, migration.name));
  }
  await mkdir(path.dirname(temporary.databasePath), { recursive: true });
  const database = openConnection(temporary.databasePath);
  try {
    migrateDatabase(database, partialMigrations);
    const store = new LedgerStore(database, { now: () => '2026-08-20T00:00:00.000Z' });
    store.createRun({
      runId: 'run-upgrade',
      workspace: 'workspace-a',
      protocolVersion: '1',
      client: { kind: 'opencode', version: '1.0.0' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Task', query: 'Run tests', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      metadata: {},
      startedAt: '2026-08-20T00:00:00.000Z',
    });
    database.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES ('session-upgrade', 'workspace-a', 'Task', '{"taskType":"build","target":null,"expected":null,"constraints":null}', 'active', 0, ?, ?)
    `).run('2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    database.prepare(`
      INSERT INTO run_intakes (run_id, session_id, policy_version, profile_schema_version, profile_sources_json, recommended_tags_json, linked_at)
      VALUES ('run-upgrade', 'session-upgrade', 'v1', 1, '{"taskType":"inferred"}', '[]', ?)
    `).run('2026-08-20T00:00:00.000Z');
    store.updateRunStatus('run-upgrade', 'active');
  } finally {
    database.close();
  }

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (chunk.toString().includes('Delete these unfinished ledger runs?')) {
        setImmediate(() => {
          input.write('n\n');
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  const result = await runSetupFlow({
    environment: { platform: 'linux', env: temporary.env },
    command: 'kiokuko-ai',
    standardSkills: false,
    skillDiscoveryMode: 'official',
    optionalPrompts: false,
    input,
    output,
  });

  assert.deepEqual(result.appliedMigrations, [9]);
  assert.equal(result.ledgerCleanup.status, 'declined');
});
