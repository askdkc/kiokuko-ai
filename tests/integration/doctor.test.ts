import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection, SqliteVecLoadError } from '../../src/db/connection.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { activateLocalEmbeddingProfile } from '../../src/embedding/store.js';
import {
  findMissingRepositoryLocations,
  registerRepositoryAndLocation,
  removeMissingRepositoryLocations,
} from '../../src/repository/binding.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-doctor-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  return { database, databasePath, directory };
}

function register(database: ReturnType<typeof openConnection>, name: string, canonicalRoot: string): void {
  registerRepositoryAndLocation(database, {
    repositoryId: `repo_doctor_${name}`,
    workspace: `project:doctor-${name}`,
    displayName: name,
    canonicalRoot,
    remoteFingerprint: null,
    bindingSchemaVersion: 1,
    agentTemplateVersion: 1,
  });
}

function locationCount(database: ReturnType<typeof openConnection>): number {
  return Number(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count ?? 0);
}

function ttyInput(answer: string): Readable & { isTTY?: boolean } {
  const input = Readable.from([answer]) as Readable & { isTTY?: boolean };
  input.isTTY = true;
  return input;
}

function ttyOutput(): Writable & { isTTY?: boolean; text: string } {
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  }) as Writable & { isTTY?: boolean; text: string };
  output.isTTY = true;
  Object.defineProperty(output, 'text', { get: () => text });
  return output;
}

async function invokeDoctor(
  databasePath: string,
  answer: string,
  json = false,
): Promise<{ stdout: string; prompt: string; response?: { data: Record<string, unknown>; ok: boolean } }> {
  let stdout = '';
  const originalWrite = process.stdout.write;
  const previousExitCode = process.exitCode;
  const output = ttyOutput();
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      doctorDatabasePath: databasePath,
      doctorInput: ttyInput(answer),
      doctorOutput: output,
    }).parseAsync(['node', 'kiokuko-ai', 'doctor', ...(json ? ['--json'] : [])]);
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = previousExitCode;
  }
  return {
    stdout,
    prompt: output.text,
    ...(json ? { response: JSON.parse(stdout) as { data: Record<string, unknown>; ok: boolean } } : {}),
  };
}

test('missing-location cleanup removes only absent location rows and preserves repositories', async () => {
  const value = await temporaryDatabase('rows');
  const liveRoot = path.join(value.directory, 'live');
  const missingRoot = path.join(value.directory, 'missing');
  await mkdir(liveRoot);
  try {
    register(value.database, 'live', liveRoot);
    register(value.database, 'missing', missingRoot);
    const candidates = findMissingRepositoryLocations(value.database);
    assert.deepEqual(candidates.map((location) => location.canonicalRoot), [missingRoot]);

    const removed = removeMissingRepositoryLocations(value.database, candidates);
    assert.equal(removed, 1);
    assert.equal(locationCount(value.database), 1);
    assert.equal(
      Number(value.database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count ?? 0),
      2,
    );
    assert.equal(findMissingRepositoryLocations(value.database).length, 0);
  } finally {
    value.database.close();
  }
});

test('missing-location cleanup rechecks a root before deleting its registry row', async () => {
  const value = await temporaryDatabase('race');
  const root = path.join(value.directory, 'restored');
  try {
    register(value.database, 'restored', root);
    const candidates = findMissingRepositoryLocations(value.database);
    await mkdir(root);
    assert.equal(removeMissingRepositoryLocations(value.database, candidates), 0);
    assert.equal(locationCount(value.database), 1);
  } finally {
    value.database.close();
  }
});

test('interactive doctor removes confirmed missing locations and reports the rerun result', async () => {
  const value = await temporaryDatabase('confirm');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, '\n');
  assert.match(result.prompt, /Remove these stale locations\? \[Y\/n\]/u);
  assert.match(result.stdout, /Kiokuko doctor: OK/u);
  assert.match(result.stdout, /Removed 1 missing repository location/u);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 0);
  } finally {
    database.close();
  }
});

test('declining interactive doctor cleanup preserves missing locations', async () => {
  const value = await temporaryDatabase('decline');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, 'n\n');
  assert.match(result.prompt, /Remove these stale locations\? \[Y\/n\]/u);
  assert.match(result.stdout, /Kiokuko doctor: FAILED/u);
  assert.match(result.stdout, /Failed checks: bindings\./u);
  assert.match(result.stdout, /\nrun kiokuko-ai doctor --json for detailed output/u);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 1);
  } finally {
    database.close();
  }
});

test('JSON doctor never prompts or cleans missing locations', async () => {
  const value = await temporaryDatabase('json');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, 'y\n', true);
  assert.equal(result.prompt, '');
  assert.equal(result.response?.ok, true);
  assert.equal((result.response?.data.checks as { bindings: { ok: boolean } }).bindings.ok, false);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 1);
  } finally {
    database.close();
  }
});

test('doctor uses persisted local embedding settings and reports the selected backend', async () => {
  const value = await temporaryDatabase('local-embeddings');
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  try {
    activateLocalEmbeddingProfile(value.database, profile, {
      replace: false,
      now: '2026-08-31T00:00:00.000Z',
    });
    value.database.prepare(`
      UPDATE embedding_settings
         SET mode = 'optional', provider_kind = 'local-transformers',
             preset_id = 'local-small', vector_backend = 'auto',
             setup_state = 'ready', updated_at = ?
       WHERE singleton = 1
    `).run('2026-08-31T00:00:00.000Z');
  } finally {
    value.database.close();
  }

  const result = await runDoctor({
    databasePath: value.databasePath,
    runtimeDescriptorPath: path.join(value.directory, 'runtime', 'server.json'),
  });

  const embeddingCheck = result.checks.embeddings as { ok: boolean; detail?: string };
  assert.equal(embeddingCheck.ok, false);
  assert.match(embeddingCheck.detail ?? '', /^findings=\d+, mode=optional, backend=sqlite-vec/u);
});

test('doctor reports a forced sqlite-vec backend that cannot be loaded', async () => {
  const value = await temporaryDatabase('forced-sqlite-vec');
  const embeddingEnvironment = {
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_VECTOR_BACKEND: 'sqlite-vec',
  } satisfies NodeJS.ProcessEnv;
  try {
    activateLocalEmbeddingProfile(value.database, createLocalEmbeddingProfile(LOCAL_SMALL_PRESET), {
      replace: false,
      now: '2026-08-31T00:00:00.000Z',
    });
  } finally {
    value.database.close();
  }

  let extensionOpenAttempts = 0;
  const result = await runDoctor({
    databasePath: value.databasePath,
    runtimeDescriptorPath: path.join(value.directory, 'runtime', 'server.json'),
    embeddingEnvironment,
  }, {
    openConnection: (databasePath, options) => {
      if (options?.sqliteVecLoader !== undefined) {
        extensionOpenAttempts += 1;
        throw new SqliteVecLoadError('sqlite-vec unavailable in doctor test');
      }
      return openConnection(databasePath, options);
    },
  });

  assert.equal(extensionOpenAttempts, 1);
  assert.deepEqual(result.checks.embeddings, {
    ok: false,
    count: 2,
    detail: 'findings=2, mode=optional, backend=sqlite-vec',
  });
});

async function withDoctorEnvironment<T>(
  dataDirectory: string,
  configHome: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousDataDirectory = process.env.KIOKUKO_DATA_DIR;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.KIOKUKO_DATA_DIR = dataDirectory;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    return await operation();
  } finally {
    if (previousDataDirectory === undefined) delete process.env.KIOKUKO_DATA_DIR;
    else process.env.KIOKUKO_DATA_DIR = previousDataDirectory;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
}

test('doctor reports an unmanaged OpenCode Kiokuko MCP identity', async () => {
  const value = await temporaryDatabase('opencode-mcp-conflict');
  value.database.close();
  const configHome = path.join(value.directory, 'config-home');
  await mkdir(path.join(configHome, 'opencode'), { recursive: true });
  await writeFile(
    path.join(configHome, 'opencode', 'opencode.json'),
    JSON.stringify({ mcp: { kiokuko: { type: 'remote', command: 'custom' } } }, null, 2) + '\n',
  );

  const result = await withDoctorEnvironment(value.directory, configHome, () => runDoctor());
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.openCodeMcp, {
    ok: false,
    count: 1,
    detail: 'config=conflict',
  });
});

test('doctor accepts the canonical OpenCode Kiokuko MCP identity', async () => {
  const value = await temporaryDatabase('opencode-mcp-canonical');
  value.database.close();
  const configHome = path.join(value.directory, 'config-home');
  await mkdir(path.join(configHome, 'opencode'), { recursive: true });
  await writeFile(
    path.join(configHome, 'opencode', 'opencode.json'),
    JSON.stringify({
      mcp: { kiokuko: { type: 'local', command: ['kiokuko-ai', 'mcp'], enabled: true, environment: { KIOKUKO_SKILL_DISCOVERY: 'official' } } },
      plugin: ['kiokuko-ai'],
    }, null, 2) + '\n',
  );

  const result = await withDoctorEnvironment(value.directory, configHome, () => runDoctor());
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.openCodeMcp, {
    ok: true,
    count: 0,
    detail: 'config=canonical-or-not-configured',
  });
});

test('doctor reports an absent OpenCode MCP config as not configured', async () => {
  const value = await temporaryDatabase('opencode-mcp-absent');
  value.database.close();
  const configHome = path.join(value.directory, 'config-home');

  const result = await withDoctorEnvironment(value.directory, configHome, () => runDoctor());
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.openCodeMcp, {
    ok: true,
    count: 0,
    detail: 'config=absent',
  });
});

test('doctor prefers opencode.jsonc over opencode.json', async () => {
  const value = await temporaryDatabase('opencode-mcp-jsonc-precedence');
  value.database.close();
  const configHome = path.join(value.directory, 'config-home');
  await mkdir(path.join(configHome, 'opencode'), { recursive: true });
  await writeFile(
    path.join(configHome, 'opencode', 'opencode.jsonc'),
    JSON.stringify({ mcp: { kiokuko: { type: 'local', command: ['kiokuko-ai', 'mcp'], enabled: true, environment: { KIOKUKO_SKILL_DISCOVERY: 'official' } } } }),
  );
  await writeFile(
    path.join(configHome, 'opencode', 'opencode.json'),
    JSON.stringify({ mcp: { kiokuko: { type: 'remote', command: 'custom' } } }),
  );

  const result = await withDoctorEnvironment(value.directory, configHome, () => runDoctor());
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.openCodeMcp, {
    ok: true,
    count: 0,
    detail: 'config=canonical-or-not-configured',
  });
});
