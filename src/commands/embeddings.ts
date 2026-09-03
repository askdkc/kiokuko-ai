import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { parseEmbeddingConfig } from '../embedding/config.js';
import { readEmbeddingStatus } from '../embedding/diagnostics.js';
import { createLocalEmbeddingProfile } from '../embedding/profile.js';
import {
  activateLocalEmbeddingProfile,
  enqueueAllCurrentEntryEmbeddingsInTransaction,
  readActiveEmbeddingProfile,
} from '../embedding/store.js';
import { LOCAL_SMALL_PRESET } from '../embedding/presets/local-small.js';
import { createEmbeddingRuntime } from '../embedding/runtime.js';
import type {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingRuntime,
  VectorSearchBackend,
} from '../embedding/types.js';
import { successEnvelope } from '../serialization/envelope.js';
import { runEmbeddingSetup } from '../embedding/setup-service.js';
import type { ModelDownloader } from '../embedding/model-download.js';
import type { InstalledModel } from '../embedding/model-installation.js';
import type { PathEnvironment } from '../config/paths.js';
import {
  parseEnnoSetupMode,
  parseSetupSkillDiscoveryMode,
  runSetupFlow,
  type SetupOptions,
  type SetupResult,
} from './setup.js';

const MAX_SYNC_JOBS = 64;
const DRAIN_DEADLINE_MS = 120_000;
const OPTIONAL_RUNTIME_PACKAGES = [
  '@huggingface/hub@2.16.1',
  '@huggingface/transformers@4.2.0',
  'sqlite-vec@0.1.9',
] as const;
const OPTIONAL_RUNTIME_IMPORTS = [
  '@huggingface/hub',
  '@huggingface/transformers',
] as const;
const OPTIONAL_RUNTIME_SCRIPT_ARGS = ['--allow-scripts=onnxruntime-node,sharp,protobufjs'] as const;
const OPTIONAL_RUNTIME_INSTALL_ARGS = [
  'install',
  '--global',
  ...OPTIONAL_RUNTIME_PACKAGES,
  ...OPTIONAL_RUNTIME_SCRIPT_ARGS,
] as const;

function runningPackageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export interface OptionalRuntimeInstallInvocation {
  readonly command: 'npm' | 'sudo';
  readonly args: readonly string[];
  readonly cwd?: string;
}

/** Select the npm invocation without assuming that every Unix prefix needs root. */
export function optionalRuntimeInstallInvocation(
  platform: NodeJS.Platform = process.platform,
  packageRoot = runningPackageRoot(),
): OptionalRuntimeInstallInvocation {
  if (platform === 'darwin') {
    return {
      command: 'npm',
      args: [
        'install',
        '--no-save',
        '--package-lock=false',
        '--omit=dev',
        '--prefix',
        packageRoot,
        ...OPTIONAL_RUNTIME_PACKAGES,
      ],
      cwd: packageRoot,
    };
  }
  const args = [...OPTIONAL_RUNTIME_INSTALL_ARGS];
  return platform === 'linux'
    ? { command: 'sudo', args: ['npm', ...args] }
    : { command: 'npm', args };
}

export type EmbeddingsDatabaseRunner = <T>(operation: (
  database: SqliteDatabase,
  backend?: VectorSearchBackend,
) => T | Promise<T>) => Promise<T>;
export type EmbeddingsOutput = (
  json: boolean | undefined,
  operation: string,
  data: unknown,
  message: string,
  meta?: Record<string, unknown>,
) => void;

export type EmbeddingsOptionalRuntimeChecker = () => Promise<void>;

export interface EmbeddingsSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface EmbeddingsCommandDependencies {
  readonly withDatabase: EmbeddingsDatabaseRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly optionalRuntimeChecker?: EmbeddingsOptionalRuntimeChecker;
  readonly optionalRuntimeInstaller?: () => Promise<void>;
  readonly provider?: EmbeddingProvider;
  readonly backend?: VectorSearchBackend;
  readonly output?: EmbeddingsOutput;
  readonly signals?: EmbeddingsSignalSource;
  readonly modelDownloader?: ModelDownloader;
  readonly modelInstaller?: (preset: typeof import('../embedding/presets/local-small.js').LOCAL_SMALL_PRESET, options: Parameters<typeof runEmbeddingSetup>[2]) => Promise<InstalledModel>;
  readonly pathEnvironment?: PathEnvironment;
  readonly setupInput?: NodeJS.ReadableStream;
  readonly setupOutput?: NodeJS.WritableStream;
  readonly setupGlobalClients?: (options: SetupOptions) => Promise<Pick<SetupResult, 'clients' | 'projectAgentFiles'>>;
}

export async function checkOptionalRuntime(packageRoot = runningPackageRoot()): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const source = `await Promise.all(${JSON.stringify(OPTIONAL_RUNTIME_IMPORTS)}.map((name) => import(name)));`;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
        cwd: packageRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 16_384) stderr += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = stderr.trim();
        reject(new Error(detail || (signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`)));
      });
    });
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : '';
    throw new KiokukoError(
      'SERVICE_UNAVAILABLE',
      `Local semantic retrieval dependencies are unavailable${cause}`,
    );
  }
}

async function installOptionalRuntime(): Promise<void> {
  const { command, args, cwd } = optionalRuntimeInstallInvocation();
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'inherit', ...(cwd === undefined ? {} : { cwd }) });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`));
      });
    });
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : '';
    throw new KiokukoError(
      'SERVICE_UNAVAILABLE',
      `Automatic installation of the local semantic retrieval dependencies failed${cause}. Run this command from an interactive terminal and try again.`,
    );
  }
}

async function ensureOptionalRuntime(dependencies: EmbeddingsCommandDependencies): Promise<void> {
  try {
    await (dependencies.optionalRuntimeChecker ?? checkOptionalRuntime)();
    return;
  } catch {
    // A failed probe means that the optional runtime needs provisioning.
  }
  try {
    await (dependencies.optionalRuntimeInstaller ?? installOptionalRuntime)();
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'SERVICE_UNAVAILABLE') throw error;
    const cause = error instanceof Error ? `: ${error.message}` : '';
    throw new KiokukoError(
      'SERVICE_UNAVAILABLE',
      `Automatic installation of the local semantic retrieval dependencies failed${cause}. Run this command from an interactive terminal and try again.`,
    );
  }
  try {
    await (dependencies.optionalRuntimeChecker ?? checkOptionalRuntime)();
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : '';
    throw new KiokukoError(
      'SERVICE_UNAVAILABLE',
      `Local semantic retrieval dependencies remain unavailable after automatic installation${cause}.`,
    );
  }
}

interface DrainSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly remaining: number;
}

const processSignals: EmbeddingsSignalSource = {
  once: (signal, listener) => process.once(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

function positiveLimit(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'limit must be an integer between 1 and 64');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SYNC_JOBS) {
    throw new KiokukoError('VALIDATION_ERROR', 'limit must be an integer between 1 and 64');
  }
  return parsed;
}

function embeddingConfig(environment: NodeJS.ProcessEnv | undefined): EmbeddingConfig | undefined {
  return environment === undefined ? undefined : parseEmbeddingConfig(environment);
}

function runtimeOptions(dependencies: EmbeddingsCommandDependencies): {
  provider?: EmbeddingProvider;
  backend?: VectorSearchBackend;
} {
  return {
    ...(dependencies.provider === undefined ? {} : { provider: dependencies.provider }),
    ...(dependencies.backend === undefined ? {} : { backend: dependencies.backend }),
  };
}

function runtimeDependencies(
  dependencies: EmbeddingsCommandDependencies,
  backend: VectorSearchBackend | undefined,
): EmbeddingsCommandDependencies {
  if (backend === undefined || dependencies.backend === backend) return dependencies;
  return { ...dependencies, backend };
}

async function withRuntime<T>(
  database: SqliteDatabase,
  config: EmbeddingConfig | undefined,
  dependencies: EmbeddingsCommandDependencies,
  operation: (runtime: EmbeddingRuntime) => Promise<T>,
): Promise<T> {
  const runtime = createEmbeddingRuntime(database, config, runtimeOptions(dependencies));
  const signals = dependencies.signals ?? processSignals;
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    void runtime.close();
  };
  signals.once('SIGINT', interrupt);
  signals.once('SIGTERM', interrupt);
  try {
    const result = await operation(runtime);
    if (interrupted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Embedding operation was interrupted');
    return result;
  } finally {
    try {
      await runtime.close();
    } finally {
      signals.off('SIGINT', interrupt);
      signals.off('SIGTERM', interrupt);
    }
  }
}

async function drainOnce(
  runtime: EmbeddingRuntime,
  workspace: string | undefined,
  maxJobs: number,
): Promise<DrainSummary> {
  return runtime.drain({
    maxJobs,
    deadlineMs: DRAIN_DEADLINE_MS,
    ...(workspace === undefined ? {} : { workspace }),
  });
}

async function drainAll(
  runtime: EmbeddingRuntime,
  workspace: string | undefined,
): Promise<DrainSummary> {
  let total: DrainSummary = { claimed: 0, completed: 0, failed: 0, blocked: 0, remaining: 0 };
  for (;;) {
    const result = await drainOnce(runtime, workspace, MAX_SYNC_JOBS);
    total = {
      claimed: total.claimed + result.claimed,
      completed: total.completed + result.completed,
      failed: total.failed + result.failed,
      blocked: total.blocked + result.blocked,
      remaining: result.remaining,
    };
    if (result.claimed === 0 || result.remaining === 0) return total;
  }
}

async function activate(
  dependencies: EmbeddingsCommandDependencies,
  replace: boolean,
): Promise<ReturnType<typeof activateLocalEmbeddingProfile>> {
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  return dependencies.withDatabase((database) => activateLocalEmbeddingProfile(database, profile, { replace }));
}

async function sync(
  dependencies: EmbeddingsCommandDependencies,
  workspace: string | undefined,
  limit: number,
): Promise<DrainSummary> {
  const config = embeddingConfig(dependencies.environment);
  return dependencies.withDatabase((database, backend) => withRuntime(
    database,
    config,
    runtimeDependencies(dependencies, backend),
    (runtime) => drainOnce(runtime, workspace, limit),
  ));
}

async function rebuild(
  dependencies: EmbeddingsCommandDependencies,
  workspace: string | undefined,
  wait: boolean,
): Promise<{ enqueued: number; drain?: DrainSummary }> {
  const enqueued = await dependencies.withDatabase((database) => {
    if (readActiveEmbeddingProfile(database) === null) {
      throw new KiokukoError('CONFLICT', 'No active embedding profile is configured');
    }
    return withImmediateTransaction(database, () => enqueueAllCurrentEntryEmbeddingsInTransaction(database, undefined, workspace));
  });
  if (!wait) return { enqueued };
  const config = embeddingConfig(dependencies.environment);
  const drain = await dependencies.withDatabase((database, backend) => withRuntime(
    database,
    config,
    runtimeDependencies(dependencies, backend),
    (runtime) => drainAll(runtime, workspace),
  ));
  return { enqueued, drain };
}

function defaultOutput(
  json: boolean | undefined,
  operation: string,
  data: unknown,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(successEnvelope(operation, data, meta))}\n`);
    return;
  }
  process.stdout.write(`${message}\n`);
}

export function registerEmbeddingsCommands(cli: Command, dependencies: EmbeddingsCommandDependencies): Command {
  const output = dependencies.output ?? defaultOutput;
  const embeddings = cli.command('embeddings').description('Manage semantic memory embeddings');

  embeddings.command('setup')
    .description('Install semantic search and configure OpenCode')
    .option('--preset <name>', 'Embedding preset', 'local-small')
    .option('--command <path>', 'Kiokuko executable name or absolute path', 'kiokuko-ai')
    .option('--dry-run', 'Plan setup without downloading or mutating anything')
    .option('--no-standard-skills', 'Skip installing bundled Kiokuko standard skills')
    .option('--skill-discovery <mode>', 'External Skill discovery: off,official,community')
    .option('--enno-oduno <mode>', 'Enno-Oduno agent loop: on,off')
    .option('--offline', 'Use only an already verified local installation')
    .option('--replace', 'Replace a different active embedding profile')
    .option('--json', 'Emit one JSON response')
    .action(async (options: {
      preset: string;
      command: string;
      dryRun?: boolean;
      standardSkills: boolean;
      skillDiscovery?: string;
      ennoOduno?: string;
      offline?: boolean;
      replace?: boolean;
      json?: boolean;
    }) => {
      const dryRun = options.dryRun === true;
      const confirmed = true;
      if (!dryRun) await ensureOptionalRuntime(dependencies);
      const skillDiscoveryMode = options.skillDiscovery === undefined
        ? undefined
        : parseSetupSkillDiscoveryMode(options.skillDiscovery);
      const setup = await runSetupFlow<Pick<SetupResult, 'clients' | 'projectAgentFiles'>>({
        ...(dependencies.pathEnvironment === undefined ? {} : { environment: dependencies.pathEnvironment }),
        command: options.command,
        dryRun,
        standardSkills: options.standardSkills,
        ...(skillDiscoveryMode === undefined ? {} : { skillDiscoveryMode }),
        ...(options.ennoOduno === undefined ? {} : { ennoOduno: parseEnnoSetupMode(options.ennoOduno) }),
        json: options.json === true,
        ...(dependencies.setupInput === undefined ? {} : { input: dependencies.setupInput }),
        ...(dependencies.setupOutput === undefined ? {} : { output: dependencies.setupOutput }),
      }, {
        ...(dependencies.setupGlobalClients === undefined ? {} : { setupGlobalClients: dependencies.setupGlobalClients }),
      });
      const embeddingData = await dependencies.withDatabase((database, backend) => runEmbeddingSetup(database, {
        presetId: options.preset,
        confirmed,
        dryRun,
        offline: options.offline === true,
        replace: options.replace === true,
      }, {
        ...(dependencies.pathEnvironment === undefined ? {} : dependencies.pathEnvironment),
        ...(dependencies.modelDownloader === undefined ? {} : { downloader: dependencies.modelDownloader }),
        ...(dependencies.modelInstaller === undefined ? {} : { installer: dependencies.modelInstaller }),
        ...(dependencies.provider === undefined ? {} : { provider: dependencies.provider }),
        ...(backend === undefined ? {} : { backendId: backend.id }),
      }));
      const data = {
        ...embeddingData,
        projectSetup: {
          clients: setup.clients,
          projectAgentFiles: setup.projectAgentFiles,
        },
      };
      output(options.json, 'embeddings.setup', data, data.semanticEnabled ? 'Semantic retrieval enabled.' : 'Embedding setup plan created.');
    });

  embeddings.command('status')
    .description('Show embedding configuration and coverage without contacting the provider')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { json?: boolean }) => {
      const config = embeddingConfig(dependencies.environment);
      const data = await dependencies.withDatabase((database, backend) => readEmbeddingStatus(database, config, backend ?? dependencies.backend));
      output(options.json, 'embeddings.status', data, `Embedding coverage: ${data.readyVectors}/${data.eligibleEntries} (${(data.coverageRatio * 100).toFixed(1)}%)`);
    });

  embeddings.command('activate')
    .description('Activate the embedding profile from the current environment')
    .option('--replace', 'Replace a different active profile')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { replace?: boolean; json?: boolean }) => {
      const data = await activate(dependencies, options.replace === true);
      output(options.json, 'embeddings.activate', data, `${data.activated ? 'Activated' : 'Already active'} embedding profile ${data.profileId}; ${data.enqueued} jobs enqueued`);
    });

  embeddings.command('sync')
    .description('Process a bounded batch of pending embedding jobs')
    .option('--workspace <name>', 'Limit jobs to one workspace')
    .option('--limit <number>', 'Maximum jobs to process', String(MAX_SYNC_JOBS))
    .option('--json', 'Emit a JSON response')
    .action(async (options: { workspace?: string; limit?: string; json?: boolean }) => {
      const data = await sync(dependencies, options.workspace, positiveLimit(options.limit));
      output(options.json, 'embeddings.sync', data, `Embedding sync: ${data.completed} completed, ${data.failed} failed, ${data.blocked} blocked, ${data.remaining} remaining`);
    });

  embeddings.command('rebuild')
    .description('Re-enqueue current entries for the active embedding profile')
    .option('--workspace <name>', 'Limit rebuild to one workspace')
    .option('--wait', 'Process the queued jobs before returning')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { workspace?: string; wait?: boolean; json?: boolean }) => {
      const data = await rebuild(dependencies, options.workspace, options.wait === true);
      const drain = data.drain;
      const message = drain === undefined
        ? `Embedding rebuild queued ${data.enqueued} jobs`
        : `Embedding rebuild queued ${data.enqueued} jobs; ${drain.completed} completed, ${drain.failed} failed, ${drain.blocked} blocked, ${drain.remaining} remaining`;
      output(options.json, 'embeddings.rebuild', data, message);
    });

  return embeddings;
}
