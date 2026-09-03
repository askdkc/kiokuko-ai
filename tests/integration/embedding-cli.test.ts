import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { Command } from 'commander';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { registerEmbeddingsCommands, type EmbeddingsCommandDependencies } from '../../src/commands/embeddings.js';
import type { SetupOptions, SetupResult } from '../../src/commands/setup.js';
import { KiokukoError } from '../../src/errors.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { activateLocalEmbeddingProfile } from '../../src/embedding/store.js';
import { recordEntry } from '../../src/memory/entries.js';
import type { EmbeddingProvider } from '../../src/embedding/types.js';
import { setupMcpIdentityConflict } from '../../src/setup/mcp-conflict.js';

const timestamp = '2026-08-31T00:00:00.000Z';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  return database;
}

function command(database: ReturnType<typeof openConnection>, output: string[], options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly provider?: EmbeddingProvider;
  readonly optionalRuntimeChecker?: () => Promise<void>;
  readonly optionalRuntimeInstaller?: () => Promise<void>;
  readonly modelInstaller?: NonNullable<EmbeddingsCommandDependencies['modelInstaller']>;
  readonly pathEnvironment?: { env?: NodeJS.ProcessEnv };
  readonly setupInput?: NodeJS.ReadableStream;
  readonly setupOutput?: NodeJS.WritableStream;
  readonly setupGlobalClients?: (options: SetupOptions) => Promise<Pick<SetupResult, 'clients' | 'projectAgentFiles'>>;
  readonly acquireSetupLock?: EmbeddingsCommandDependencies['acquireSetupLock'];
} = {}): Command {
  const cli = new Command();
  cli.exitOverride();
  const setup = options.setupGlobalClients ?? (async () => ({ clients: [], projectAgentFiles: [] }));
  registerEmbeddingsCommands(cli, {
    withDatabase: async (operation) => operation(database),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.optionalRuntimeChecker === undefined ? {} : { optionalRuntimeChecker: options.optionalRuntimeChecker }),
    ...(options.optionalRuntimeInstaller === undefined ? {} : { optionalRuntimeInstaller: options.optionalRuntimeInstaller }),
    ...(options.modelInstaller === undefined ? {} : { modelInstaller: options.modelInstaller }),
    ...(options.pathEnvironment === undefined ? {} : { pathEnvironment: options.pathEnvironment }),
    ...(options.setupInput === undefined ? {} : { setupInput: options.setupInput }),
    ...(options.setupOutput === undefined ? {} : { setupOutput: options.setupOutput }),
    ...(options.acquireSetupLock === undefined ? {} : { acquireSetupLock: options.acquireSetupLock }),
    setupGlobalClients: setup,
    output: (json, operation, data, message) => {
      output.push(json ? JSON.stringify({ operation, data }) : message);
    },
  });
  return cli;
}

test('embedding setup checks optional runtime before opening the database', async () => {
  const database = await temporaryDatabase('embedding-cli-runtime');
  try {
    const output: string[] = [];
    let databaseCalls = 0;
    const checker = async () => {
      throw new Error('optional runtime is missing');
    };
    const cli = new Command();
    cli.exitOverride();
    registerEmbeddingsCommands(cli, {
      withDatabase: async () => {
        databaseCalls += 1;
        throw new Error('database must not be opened');
      },
      optionalRuntimeChecker: checker,
      optionalRuntimeInstaller: async () => {
        throw new Error('installer failed');
      },
      acquireSetupLock: async () => ({ path: '/test/setup.lock', release: async () => undefined }),
      output: (json, operation, data, message) => {
        output.push(json ? JSON.stringify({ operation, data }) : message);
      },
    });

    await assert.rejects(
      () => cli.parseAsync(['node', 'kiokuko-ai', 'embeddings', 'setup']),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'SERVICE_UNAVAILABLE'
        && error.message.includes('Automatic installation of the local semantic retrieval dependencies failed'),
    );
    assert.equal(databaseCalls, 0);
    assert.deepEqual(output, []);
  } finally {
    database.close();
  }
});

test('embedding setup lock serializes optional runtime installation before client or database mutation', async () => {
  const database = await temporaryDatabase('embedding-cli-concurrent-runtime');
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-embedding-cli-concurrent-data-'));
  let installerCalls = 0;
  let releaseInstaller!: () => void;
  let installerStarted!: () => void;
  const started = new Promise<void>((resolve) => { installerStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseInstaller = resolve; });
  const options = {
    pathEnvironment: { env: { KIOKUKO_DATA_DIR: dataDirectory } },
    optionalRuntimeChecker: async () => { throw new Error('runtime missing'); },
    optionalRuntimeInstaller: async () => {
      installerCalls += 1;
      installerStarted();
      await gate;
      throw new Error('fixture install failed');
    },
  };
  try {
    const first = command(database, [], options).parseAsync(['node', 'kiokuko-ai', 'embeddings', 'setup']);
    await started;
    await assert.rejects(
      () => command(database, [], options).parseAsync(['node', 'kiokuko-ai', 'embeddings', 'setup']),
      (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
    );
    releaseInstaller();
    await assert.rejects(first, (error: unknown) => error instanceof KiokukoError && error.code === 'SERVICE_UNAVAILABLE');
    assert.equal(installerCalls, 1);
  } finally {
    releaseInstaller?.();
    database.close();
  }
});

test('embedding setup skips optional runtime checks during dry-run', async () => {
  const database = await temporaryDatabase('embedding-cli-dry-run');
  try {
    const output: string[] = [];
    let checks = 0;
    await command(database, output, {
      optionalRuntimeChecker: async () => {
        checks += 1;
      },
    }).parseAsync(['node', 'kiokuko-ai', 'embeddings', 'setup', '--dry-run', '--json']);
    const response = JSON.parse(output[0]!) as { operation: string; data: { semanticEnabled: boolean } };
    assert.equal(response.operation, 'embeddings.setup');
    assert.equal(response.data.semanticEnabled, false);
    assert.equal(checks, 0);
  } finally {
    database.close();
  }
});

test('embedding setup configures clients and refreshes project instructions', async () => {
  const database = await temporaryDatabase('embedding-cli-project-setup');
  try {
    const output: string[] = [];
    const setupCalls: SetupOptions[] = [];
    await command(database, output, {
      setupGlobalClients: async (options) => {
        setupCalls.push(options);
        return { clients: ['opencode'], projectAgentFiles: [] };
      },
  }).parseAsync(['node', 'kiokuko-ai', 'embeddings', 'setup', '--dry-run', '--json']);
    const response = JSON.parse(output[0]!) as {
      data: {
        semanticEnabled: boolean;
        projectSetup: { clients: string[]; projectAgentFiles: unknown[] };
      };
    };
    assert.equal(setupCalls.length, 1);
    const setupCall = setupCalls[0]!;
    assert.equal(setupCall.command, 'kiokuko-ai');
    assert.equal(setupCall.dryRun, true);
    assert.equal(setupCall.standardSkills, true);
    assert.deepEqual(setupCall.replaceConflictingMcpServers, []);
    assert.deepEqual(response.data.projectSetup, { clients: ['opencode'], projectAgentFiles: [] });
  } finally {
    database.close();
  }
});

test('embedding setup confirms and replaces a conflicting client MCP identity', async () => {
  const database = await temporaryDatabase('embedding-cli-mcp-replacement');
  try {
    const output: string[] = [];
    const setupCalls: SetupOptions[] = [];
    let attempts = 0;
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    let answeredCommunity = false;
    let answeredReplacement = false;
    const setupOutput = new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
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
    setupOutput.isTTY = true;
    await command(database, output, {
      setupInput: input,
      setupOutput,
      setupGlobalClients: async (options) => {
        setupCalls.push(options);
        if (attempts++ === 0) setupMcpIdentityConflict('opencode', 'conflict');
        return { clients: ['opencode'], projectAgentFiles: [] };
      },
    }).parseAsync(['node', 'kiokuko-ai', 'embeddings', 'setup', '--dry-run']);
    assert.deepEqual(setupCalls, [
      {
        command: 'kiokuko-ai',
        dryRun: true,
        standardSkills: true,
        skillDiscoveryMode: 'official',
        replaceConflictingMcpServers: [],
      },
      {
        command: 'kiokuko-ai',
        dryRun: true,
        standardSkills: true,
        skillDiscoveryMode: 'official',
        replaceConflictingMcpServers: ['opencode'],
      },
    ]);
  } finally {
    database.close();
  }
});

test('embedding setup does not require a confirmation flag', async () => {
  const database = await temporaryDatabase('embedding-cli-no-confirmation-flag');
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-embedding-cli-data-'));
  try {
    const output: string[] = [];
    await command(database, output, {
      optionalRuntimeChecker: async () => undefined,
      modelInstaller: async () => ({
        installation: 'installed',
        directory: '/tmp/kiokuko-test-model',
        relativePath: 'models/embeddings/local-small/test',
        totalBytes: 0,
        manifestHash: 'a'.repeat(64),
      }),
      provider: {
        profile: { providerKind: 'local-transformers' } as never,
        async embed(inputs) {
          return inputs.map(() => new Float32Array(384));
        },
      },
      pathEnvironment: { env: { KIOKUKO_DATA_DIR: dataDirectory } },
    }).parseAsync(['node', 'kiokuko-ai', 'embeddings', 'setup', '--json']);
    const response = JSON.parse(output[0]!) as { data: { semanticEnabled: boolean } };
    assert.equal(response.data.semanticEnabled, true);
  } finally {
    database.close();
  }
});

function environment(model: string): NodeJS.ProcessEnv {
  return {
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_VECTOR_BACKEND: 'javascript',
  };
}

test('embedding status is bounded and provider-free when embeddings are off', async () => {
  const database = await temporaryDatabase('embedding-cli-status');
  try {
    const output: string[] = [];
    await command(database, output, { environment: { KIOKUKO_EMBEDDINGS: 'off' } }).parseAsync(['node', 'kiokuko-ai', 'embeddings', 'status', '--json']);
    const response = JSON.parse(output[0]!) as { operation: string; data: Record<string, unknown> };
    assert.equal(response.operation, 'embeddings.status');
    assert.equal(response.data.mode, 'off');
    assert.equal(response.data.activeProfileId, null);
    assert.equal(response.data.queryCacheRows, 0);
    assert.equal('apiKey' in response.data, false);
    assert.equal('baseUrl' in response.data, false);
  } finally {
    database.close();
  }
});

test('activate enqueues without contacting the provider and sync consumes a bounded batch', async () => {
  const database = await temporaryDatabase('embedding-cli-sync');
  try {
    const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
    recordEntry(database, {
      workspace: 'project:embedding-cli',
      kind: 'lesson',
      title: 'CLI entry',
      body: 'The CLI should queue and process this entry.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-cli', now: timestamp });
    let calls = 0;
    const provider: EmbeddingProvider = {
      profile: profile.identity,
      async embed(inputs) {
        calls += 1;
        return inputs.map(() => new Float32Array([1, ...new Array<number>(383).fill(0)]));
      },
    };
    const output: string[] = [];
    await command(database, output, { environment: environment('cli-model'), provider })
      .parseAsync(['node', 'kiokuko-ai', 'embeddings', 'activate', '--json']);
    const activation = JSON.parse(output.pop()!) as { data: { activated: boolean; enqueued: number } };
    assert.equal(activation.data.activated, true);
    assert.equal(activation.data.enqueued, 1);
    assert.equal(calls, 0);

    await command(database, output, { environment: environment('cli-model'), provider })
      .parseAsync(['node', 'kiokuko-ai', 'embeddings', 'sync', '--limit', '1', '--json']);
    const sync = JSON.parse(output.pop()!) as { data: { completed: number; failed: number; remaining: number } };
    assert.equal(sync.data.completed, 1);
    assert.equal(sync.data.failed, 0);
    assert.equal(sync.data.remaining, 0);
    assert.equal(calls, 1);
  } finally {
    database.close();
  }
});

test('rebuild requires an active profile and can explicitly wait for the queued work', async () => {
  const database = await temporaryDatabase('embedding-cli-rebuild');
  try {
    const output: string[] = [];
    await assert.rejects(
      () => command(database, output, { environment: { KIOKUKO_EMBEDDINGS: 'off' } }).parseAsync(['node', 'kiokuko-ai', 'embeddings', 'rebuild']),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
    );

    const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
    activateLocalEmbeddingProfile(database, profile, { replace: false, now: timestamp });
    recordEntry(database, {
      workspace: 'project:rebuild',
      kind: 'lesson',
      title: 'Rebuild entry',
      body: 'Rebuild waits only when explicitly requested.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-rebuild', now: timestamp });
    const provider: EmbeddingProvider = {
      profile: profile.identity,
      async embed(inputs) {
        return inputs.map(() => new Float32Array([1, ...new Array<number>(383).fill(0)]));
      },
    };
    await command(database, output, { environment: environment('rebuild-model'), provider })
      .parseAsync(['node', 'kiokuko-ai', 'embeddings', 'rebuild', '--workspace', 'project:rebuild', '--wait', '--json']);
    const rebuild = JSON.parse(output.pop()!) as { data: { enqueued: number; drain: { completed: number; remaining: number } } };
    assert.equal(rebuild.data.enqueued, 1);
    assert.equal(rebuild.data.drain.completed, 1);
    assert.equal(rebuild.data.drain.remaining, 0);
  } finally {
    database.close();
  }
});
