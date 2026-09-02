import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { isProxy } from 'node:util/types';
import { Command, CommanderError } from 'commander';
import { initializeDatabase } from './commands/init.js';
import { useRepository, type UseOptions } from './commands/use.js';
import { searchEntries, recallEntries } from './memory/retrieval.js';
import { readEntry, recordEntry, type RecordEntryInput } from './memory/entries.js';
import { recallScopedMemory } from './memory/scoped-memory.js';
import type { ScopedRecallResult } from './memory/scoped-memory.js';
import type { RecallResult } from './memory/retrieval.js';
import { promoteEntry, supersedeEntry, linkEntries } from './memory/lifecycle.js';
import { purgeEntry } from './commands/purge.js';
import { createBackup } from './commands/backup.js';
import { findMissingRepositoryLocations, removeMissingRepositoryLocations } from './repository/binding.js';
import { promptRemoveMissingRepositoryLocations, runDoctor } from './commands/doctor.js';
import { writeExport } from './commands/export.js';
import { importWorkspace } from './commands/import.js';
import { openConnection } from './db/connection.js';
import { errorEnvelope, successEnvelope } from './serialization/envelope.js';
import { KiokukoError, exitCodeFor } from './errors.js';
import { startWebServer } from './web/server.js';
import { registerServerCommands, type ServerCommandDependencies } from './commands/server.js';
import { registerAgentCommand, type AgentCommandDependencies } from './commands/agent.js';
import { registerLedgerCommands } from './commands/ledger.js';
import type { SqliteDatabase } from './db/adapter.js';
import { answerAkinator, startAkinator } from './akinator/orchestrator.js';
import {
  parseEnnoSetupMode,
  parseSetupSkillDiscoveryMode,
  runSetupFlow,
} from './commands/setup.js';
import { runMcpServer } from './mcp/server.js';
import { runCuratorCommand } from './commands/curator.js';
import { globalizeCuratorCandidate } from './memory/curator.js';
import type { PathEnvironment } from './config/paths.js';
import { registerSkillsCommands, type SkillsCommandDependencies } from './commands/skills.js';
import { registerEnnoCommand } from './commands/enno.js';
import { PACKAGE_VERSION } from './package-version.js';
import { parseStrictJson } from './setup/strict-json.js';
import { validateRecordInput } from './serialization/validate.js';
import { registerEmbeddingsCommands } from './commands/embeddings.js';
import type { EmbeddingProvider, VectorSearchBackend } from './embedding/types.js';
import { openEmbeddingDatabase } from './embedding/backend.js';
import { parseEmbeddingConfig } from './embedding/config.js';
import { createEmbeddingRuntime, prepareEmbeddingSearchRuntime } from './embedding/runtime.js';
import type { HybridSearchRuntime } from './memory/hybrid-retrieval.js';

const MAX_CLI_JSON_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_CALL_PATH_BYTES = 4 * 1024;
const CONTROL_CHARACTERS = /\p{Cc}/u;

function invalidJsonInput(): KiokukoError {
  return new KiokukoError('VALIDATION_ERROR', 'Input is not valid JSON with unique keys');
}

async function readBoundedStdin(): Promise<Buffer> {
  if (process.stdin.readableEncoding !== null || process.stdin.readableDidRead) {
    throw invalidJsonInput();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw invalidJsonInput();
    const bytes = chunk;
    size += bytes.byteLength;
    if (size > MAX_CLI_JSON_INPUT_BYTES) throw invalidJsonInput();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function filesystemErrorCode(error: unknown): string | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null || isProxy(error)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

async function readBoundedJsonFile(filePath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT' || filesystemErrorCode(error) === 'ENOTDIR') {
      throw new KiokukoError('NOT_FOUND', 'JSON input file does not exist');
    }
    throw error;
  }
  let result: Buffer | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) {
      throw invalidJsonInput();
    }
    if (initial.size < 0n || initial.size > BigInt(MAX_CLI_JSON_INPUT_BYTES)) {
      throw invalidJsonInput();
    }
    const expectedSize = Number(initial.size);
    const bytes = Buffer.allocUnsafe(expectedSize + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    if (offset !== expectedSize
      || final.size !== initial.size
      || final.dev !== initial.dev
      || final.ino !== initial.ino
      || final.mtimeNs !== initial.mtimeNs
      || final.ctimeNs !== initial.ctimeNs) {
      throw new KiokukoError('CONFLICT', 'JSON input file changed while it was being read');
    }
    result = bytes.subarray(0, offset);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        'JSON input read failed and its file descriptor could not be closed',
      );
    }
    throw new AggregateError(
      [closeError],
      'JSON input was read, but its file descriptor could not be closed',
    );
  }
  if (operationFailed) {
    if (operationError instanceof KiokukoError && operationError.code === 'VALIDATION_ERROR') {
      throw operationError;
    }
    throw operationError;
  }
  if (result === undefined) throw invalidJsonInput();
  return result;
}

async function readJsonInput(filePath: string): Promise<unknown> {
  const bytes = filePath === '-' ? await readBoundedStdin() : await readBoundedJsonFile(filePath);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalidJsonInput();
  }
  return parseStrictJson(
    text,
    { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
    'Input is not valid JSON with unique keys',
  );
}

async function withDatabase<T>(
  operation: (database: SqliteDatabase) => T | Promise<T>,
  options: Parameters<typeof initializeDatabase>[0] = {},
): Promise<T> {
  const result = await initializeDatabase(options);
  const database = openConnection(result.databasePath);
  let operationResult: { value: T } | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    operationResult = { value: await operation(database) };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    database.close();
  } catch (closeError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        'Database operation failed and closing its connection also failed',
      );
    }
    throw new AggregateError(
      [closeError],
      'Database operation completed, but closing its connection failed',
    );
  }
  if (operationFailed) throw operationError;
  if (operationResult === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Database operation produced no result');
  }
  return operationResult.value;
}

async function withEmbeddingDatabase<T>(
  dependencies: Pick<CliDependencies, 'embeddingEnvironment' | 'embeddingBackend'>,
  operation: (database: SqliteDatabase, backend?: VectorSearchBackend) => T | Promise<T>,
  options: Parameters<typeof initializeDatabase>[0] = {},
): Promise<T> {
  const initialized = await initializeDatabase(options);
  const config = dependencies.embeddingEnvironment === undefined
    ? undefined
    : parseEmbeddingConfig(dependencies.embeddingEnvironment);
  const opened = await openEmbeddingDatabase(initialized.databasePath, {
    ...(config === undefined ? {} : { config }),
    ...(dependencies.embeddingBackend === undefined ? {} : { backend: dependencies.embeddingBackend }),
  });
  let operationResult: { value: T } | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    operationResult = { value: await operation(opened.database, opened.backend) };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    opened.database.close();
  } catch (closeError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        'Embedding database operation failed and closing its connection also failed',
      );
    }
    throw new AggregateError(
      [closeError],
      'Embedding database operation completed, but closing its connection failed',
    );
  }
  if (operationFailed) throw operationError;
  if (operationResult === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Embedding database operation produced no result');
  }
  return operationResult.value;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function humanOrJson(json: boolean | undefined, operation: string, data: unknown, message: string, meta?: Record<string, unknown>): void {
  if (json) emit(successEnvelope(operation, data, meta));
  else process.stdout.write(`${message}\n`);
}

function parseExpectedRevision(value: string | undefined): number {
  if (value === undefined) throw new KiokukoError('USAGE_ERROR', '--expected-revision is required');
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new KiokukoError('VALIDATION_ERROR', 'expected revision must be a positive integer');
  return revision;
}

function addWorkspaceOptions(command: Command): Command {
  return command.option('--workspace <name>', 'Workspace name').option('--json', 'Emit a JSON response');
}

async function withPreparedSemanticRuntime<T>(
  dependencies: Pick<CliDependencies, 'embeddingEnvironment' | 'embeddingProvider' | 'embeddingBackend'>,
  database: SqliteDatabase,
  selectedBackend: VectorSearchBackend | undefined,
  query: string,
  operation: (runtime: HybridSearchRuntime) => T | Promise<T>,
): Promise<T> {
  const config = dependencies.embeddingEnvironment === undefined
    ? undefined
    : parseEmbeddingConfig(dependencies.embeddingEnvironment);
  const runtime = createEmbeddingRuntime(database, config, {
    ...(dependencies.embeddingProvider === undefined ? {} : { provider: dependencies.embeddingProvider }),
    ...((selectedBackend ?? dependencies.embeddingBackend) === undefined
      ? {}
      : { backend: selectedBackend ?? dependencies.embeddingBackend }),
  });
  let operationResult: { value: T } | undefined;
  let operationError: unknown;
  try {
    if (runtime.profileId !== null) {
      await runtime.drain({ maxJobs: 8, deadlineMs: 1_500 });
    }
    const searchRuntime = await prepareEmbeddingSearchRuntime(runtime, database, query);
    operationResult = { value: await operation(searchRuntime) };
  } catch (error) {
    operationError = error;
  }
  try {
    await runtime.close();
  } catch (closeError) {
    if (operationError !== undefined) {
      throw new AggregateError([operationError, closeError], 'Semantic search failed and its runtime could not be closed');
    }
    throw closeError;
  }
  if (operationError !== undefined) throw operationError;
  if (operationResult === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Semantic search produced no result');
  return operationResult.value;
}

function configureRecallCommand(command: Command, dependencies: CliDependencies): Command {
  const recall = addWorkspaceOptions(command.description('Human/operator management: recall relevant memory entries').argument('<query>'))
    .option('--limit <number>', 'Maximum entries', '5').option('--max-chars <number>', 'Context character budget', '8000')
    .option('--scope <scope>', 'auto, project, ecosystem, or global', 'auto').option('--cwd <path>', 'Repository path used for scoped recall');
  recall.action(async (query: string, options: Record<string, unknown>) => {
    let data: RecallResult | ScopedRecallResult;
    if (options.workspace !== undefined) {
      data = await withEmbeddingDatabase(dependencies, (database, backend) => withPreparedSemanticRuntime(
        dependencies,
        database,
        backend,
        query,
        (runtime) => recallEntries(database, { workspace: String(options.workspace), query, limit: Number(options.limit), maxChars: Number(options.maxChars) }, runtime),
      ));
    } else {
      data = await withEmbeddingDatabase(dependencies, (database, backend) => withPreparedSemanticRuntime(
        dependencies,
        database,
        backend,
        query,
        (runtime) => recallScopedMemory(database, {
          query,
          scope: String(options.scope ?? 'auto') as never,
          limit: Number(options.limit),
          maxChars: Number(options.maxChars),
          ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
        }, runtime),
      ));
    }
    const items = 'items' in data ? data.items : data.combined?.items ?? data.ecosystem?.items ?? data.global?.items ?? data.project?.memory.items ?? [];
    const count = 'count' in data ? data.count : items.length;
    const truncated = 'truncated' in data ? data.truncated : data.combined?.truncated ?? data.ecosystem?.truncated ?? false;
    humanOrJson(options.json === true, 'recall', data, `${items.length} memory entries recalled`, { count, truncated });
  });
  return recall;
}

export interface CliDependencies {
  readonly server?: ServerCommandDependencies;
  readonly agent?: AgentCommandDependencies;
  readonly skills?: SkillsCommandDependencies;
  readonly setupEnvironment?: PathEnvironment;
  readonly setupInput?: NodeJS.ReadableStream;
  readonly setupOutput?: NodeJS.WritableStream;
  readonly doctorInput?: NodeJS.ReadableStream;
  readonly doctorOutput?: NodeJS.WritableStream;
  readonly doctorDatabasePath?: string;
  readonly doctorRuntimeDescriptorPath?: string;
  readonly embeddingEnvironment?: NodeJS.ProcessEnv;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly embeddingBackend?: VectorSearchBackend;
}

const CALL_OPERATIONS = [
  'init',
  'use',
  'record',
  'curator',
  'curator_globalize',
  'guide_start',
  'guide_answer',
  'promote',
  'supersede',
  'link',
  'purge',
  'export',
  'import',
  'backup',
  'doctor',
] as const;

type CallOperation = (typeof CALL_OPERATIONS)[number];

interface CallRequest {
  apiVersion: '1';
  operation: CallOperation;
  arguments: Record<string, unknown>;
}

const SUPPORTED_CALL_OPERATIONS = new Set<string>(CALL_OPERATIONS);

function snapshotPlainJsonObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('VALIDATION_ERROR', message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new KiokukoError('VALIDATION_ERROR', message);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new KiokukoError('VALIDATION_ERROR', message);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new KiokukoError('VALIDATION_ERROR', message);
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function assertExactCallArguments(
  args: Record<string, unknown>,
  operation: CallOperation,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  const allowedFields = new Set(allowed);
  for (const field of Object.keys(args)) {
    if (!allowedFields.has(field)) {
      throw new KiokukoError('VALIDATION_ERROR', `Unknown ${operation} argument: ${field}`);
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(args, field)) {
      throw new KiokukoError('VALIDATION_ERROR', `${operation}.${field} is required`);
    }
  }
}

function requiredStringArgument(
  args: Record<string, unknown>,
  operation: CallOperation,
  field: string,
): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', `${operation}.${field} must be a non-empty string`);
  }
  return value;
}

function optionalStringArgument(
  args: Record<string, unknown>,
  operation: CallOperation,
  field: string,
): string | undefined {
  return Object.hasOwn(args, field) ? requiredStringArgument(args, operation, field) : undefined;
}

function requiredPathArgument(
  args: Record<string, unknown>,
  operation: CallOperation,
  field: string,
): string {
  const value = requiredStringArgument(args, operation, field);
  if (CONTROL_CHARACTERS.test(value) || Buffer.byteLength(value, 'utf8') > MAX_CALL_PATH_BYTES) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      `${operation}.${field} must be a bounded path without control characters`,
    );
  }
  return value;
}

function optionalPathArgument(
  args: Record<string, unknown>,
  operation: CallOperation,
  field: string,
): string | undefined {
  return Object.hasOwn(args, field) ? requiredPathArgument(args, operation, field) : undefined;
}

function requiredBooleanArgument(
  args: Record<string, unknown>,
  operation: CallOperation,
  field: string,
): boolean {
  const value = args[field];
  if (typeof value !== 'boolean') {
    throw new KiokukoError('VALIDATION_ERROR', `${operation}.${field} must be a boolean`);
  }
  return value;
}

function optionalBooleanArgument(
  args: Record<string, unknown>,
  operation: CallOperation,
  field: string,
): boolean | undefined {
  return Object.hasOwn(args, field) ? requiredBooleanArgument(args, operation, field) : undefined;
}

function requiredPositiveIntegerArgument(
  args: Record<string, unknown>,
  operation: CallOperation,
  field: string,
): number {
  const value = args[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new KiokukoError('VALIDATION_ERROR', `${operation}.${field} must be a positive integer`);
  }
  return value;
}

function validateUseCallArguments(args: Record<string, unknown>): UseOptions {
  const operation = 'use';
  assertExactCallArguments(args, operation, [
    'cwd',
    'root',
    'workspace',
    'agentFile',
    'dryRun',
    'noAgentFile',
    'forceRebind',
    'allowDirectory',
    'databasePath',
    'migrationsDirectory',
    'repositoryId',
  ]);
  const result: UseOptions = {};
  const cwd = optionalPathArgument(args, operation, 'cwd');
  const root = optionalPathArgument(args, operation, 'root');
  const workspace = optionalStringArgument(args, operation, 'workspace');
  const agentFile = optionalPathArgument(args, operation, 'agentFile');
  const databasePath = optionalPathArgument(args, operation, 'databasePath');
  const migrationsDirectory = optionalPathArgument(args, operation, 'migrationsDirectory');
  const repositoryId = optionalStringArgument(args, operation, 'repositoryId');
  const dryRun = optionalBooleanArgument(args, operation, 'dryRun');
  const noAgentFile = optionalBooleanArgument(args, operation, 'noAgentFile');
  const forceRebind = optionalBooleanArgument(args, operation, 'forceRebind');
  const allowDirectory = optionalBooleanArgument(args, operation, 'allowDirectory');
  if (cwd !== undefined) result.cwd = cwd;
  if (root !== undefined) result.root = root;
  if (workspace !== undefined) result.workspace = workspace;
  if (agentFile !== undefined) result.agentFile = agentFile;
  if (databasePath !== undefined) result.databasePath = databasePath;
  if (migrationsDirectory !== undefined) result.migrationsDirectory = migrationsDirectory;
  if (repositoryId !== undefined) result.repositoryId = repositoryId;
  if (dryRun !== undefined) result.dryRun = dryRun;
  if (noAgentFile !== undefined) result.noAgentFile = noAgentFile;
  if (forceRebind !== undefined) result.forceRebind = forceRebind;
  if (allowDirectory !== undefined) result.allowDirectory = allowDirectory;
  return result;
}

function validateRecordCallArguments(args: Record<string, unknown>): RecordEntryInput {
  return validateRecordInput(args);
}

function validateCuratorCallArguments(args: Record<string, unknown>): {
  workspace?: string;
  cwd?: string;
  limit?: number;
  entryId?: string;
  yes?: boolean;
} {
  const operation = 'curator';
  assertExactCallArguments(args, operation, ['workspace', 'cwd', 'limit', 'entryId', 'yes']);
  const workspace = optionalStringArgument(args, operation, 'workspace');
  const cwd = optionalPathArgument(args, operation, 'cwd');
  const entryId = optionalStringArgument(args, operation, 'entryId');
  const yes = optionalBooleanArgument(args, operation, 'yes');
  const limit = Object.hasOwn(args, 'limit')
    ? requiredPositiveIntegerArgument(args, operation, 'limit')
    : undefined;
  if (limit !== undefined && limit > 50) {
    throw new KiokukoError('VALIDATION_ERROR', 'curator.limit must be an integer between 1 and 50');
  }
  return {
    ...(workspace === undefined ? {} : { workspace }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(limit === undefined ? {} : { limit }),
    ...(entryId === undefined ? {} : { entryId }),
    ...(yes === undefined ? {} : { yes }),
  };
}

function validateCuratorGlobalizeCallArguments(args: Record<string, unknown>): {
  workspace: string;
  entryId: string;
  expectedRevision: number;
  actor?: string;
} {
  const operation = 'curator_globalize';
  assertExactCallArguments(
    args,
    operation,
    ['workspace', 'entryId', 'expectedRevision', 'actor'],
    ['workspace', 'entryId', 'expectedRevision'],
  );
  const actor = optionalStringArgument(args, operation, 'actor');
  return {
    workspace: requiredStringArgument(args, operation, 'workspace'),
    entryId: requiredStringArgument(args, operation, 'entryId'),
    expectedRevision: requiredPositiveIntegerArgument(args, operation, 'expectedRevision'),
    ...(actor === undefined ? {} : { actor }),
  };
}

function validateGuideStartCallArguments(args: Record<string, unknown>): {
  workspace: string;
  task: string;
} {
  const operation = 'guide_start';
  assertExactCallArguments(args, operation, ['workspace', 'task'], ['workspace', 'task']);
  return {
    workspace: requiredStringArgument(args, operation, 'workspace'),
    task: requiredStringArgument(args, operation, 'task'),
  };
}

function validateGuideAnswerCallArguments(args: Record<string, unknown>): {
  workspace: string;
  sessionId: string;
  questionId: 'taskType' | 'target' | 'expected' | 'constraints';
  value: string;
} {
  const operation = 'guide_answer';
  assertExactCallArguments(
    args,
    operation,
    ['workspace', 'sessionId', 'questionId', 'value'],
    ['workspace', 'sessionId', 'questionId', 'value'],
  );
  const questionId = requiredStringArgument(args, operation, 'questionId');
  if (!['taskType', 'target', 'expected', 'constraints'].includes(questionId)) {
    throw new KiokukoError('VALIDATION_ERROR', 'guide_answer.questionId is unsupported');
  }
  return {
    workspace: requiredStringArgument(args, operation, 'workspace'),
    sessionId: requiredStringArgument(args, operation, 'sessionId'),
    questionId: questionId as 'taskType' | 'target' | 'expected' | 'constraints',
    value: requiredStringArgument(args, operation, 'value'),
  };
}

function validatePromoteCallArguments(args: Record<string, unknown>): {
  workspace: string;
  entryId: string;
  expectedRevision: number;
} {
  const operation = 'promote';
  assertExactCallArguments(
    args,
    operation,
    ['workspace', 'entryId', 'expectedRevision'],
    ['workspace', 'entryId', 'expectedRevision'],
  );
  return {
    workspace: requiredStringArgument(args, operation, 'workspace'),
    entryId: requiredStringArgument(args, operation, 'entryId'),
    expectedRevision: requiredPositiveIntegerArgument(args, operation, 'expectedRevision'),
  };
}

function validateSupersedeCallArguments(args: Record<string, unknown>): {
  workspace: string;
  oldEntryId: string;
  replacementEntryId: string;
  expectedRevision: number;
} {
  const operation = 'supersede';
  assertExactCallArguments(
    args,
    operation,
    ['workspace', 'oldEntryId', 'replacementEntryId', 'expectedRevision'],
    ['workspace', 'oldEntryId', 'replacementEntryId', 'expectedRevision'],
  );
  return {
    workspace: requiredStringArgument(args, operation, 'workspace'),
    oldEntryId: requiredStringArgument(args, operation, 'oldEntryId'),
    replacementEntryId: requiredStringArgument(args, operation, 'replacementEntryId'),
    expectedRevision: requiredPositiveIntegerArgument(args, operation, 'expectedRevision'),
  };
}

function validateLinkCallArguments(args: Record<string, unknown>): {
  workspace: string;
  fromEntryId: string;
  toEntryId: string;
  relation: 'supports' | 'contradicts' | 'derived_from' | 'related_to';
  actor?: string;
  now?: string;
} {
  const operation = 'link';
  assertExactCallArguments(
    args,
    operation,
    ['workspace', 'fromEntryId', 'toEntryId', 'relation', 'actor', 'now'],
    ['workspace', 'fromEntryId', 'toEntryId', 'relation'],
  );
  const relation = requiredStringArgument(args, operation, 'relation');
  if (!['supports', 'contradicts', 'derived_from', 'related_to'].includes(relation)) {
    throw new KiokukoError('VALIDATION_ERROR', 'link.relation is unsupported');
  }
  const actor = optionalStringArgument(args, operation, 'actor');
  const now = optionalStringArgument(args, operation, 'now');
  return {
    workspace: requiredStringArgument(args, operation, 'workspace'),
    fromEntryId: requiredStringArgument(args, operation, 'fromEntryId'),
    toEntryId: requiredStringArgument(args, operation, 'toEntryId'),
    relation: relation as 'supports' | 'contradicts' | 'derived_from' | 'related_to',
    ...(actor === undefined ? {} : { actor }),
    ...(now === undefined ? {} : { now }),
  };
}

function validatePurgeCallArguments(args: Record<string, unknown>): {
  workspace: string;
  entryId: string;
  confirm: boolean;
} {
  const operation = 'purge';
  assertExactCallArguments(
    args,
    operation,
    ['workspace', 'entryId', 'confirm'],
    ['workspace', 'entryId', 'confirm'],
  );
  return {
    workspace: requiredStringArgument(args, operation, 'workspace'),
    entryId: requiredStringArgument(args, operation, 'entryId'),
    confirm: requiredBooleanArgument(args, operation, 'confirm'),
  };
}

function parseCallRequest(request: unknown): CallRequest {
  const value = snapshotPlainJsonObject(request, 'Request must be a JSON object');
  const fields = Object.keys(value).sort();
  if (fields.length !== 3
    || fields[0] !== 'apiVersion'
    || fields[1] !== 'arguments'
    || fields[2] !== 'operation') {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'Request must contain exactly apiVersion, operation, and arguments',
    );
  }
  if (value.apiVersion !== '1') {
    throw new KiokukoError('VALIDATION_ERROR', 'apiVersion must be "1"');
  }
  if (typeof value.operation !== 'string' || value.operation.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'operation must be a non-empty string');
  }
  const args = snapshotPlainJsonObject(value.arguments, 'arguments must be a JSON object');
  if (!SUPPORTED_CALL_OPERATIONS.has(value.operation)) {
    throw new KiokukoError('VALIDATION_ERROR', `Unknown operation: ${value.operation}`);
  }
  return {
    apiVersion: '1',
    operation: value.operation as CallOperation,
    arguments: args,
  };
}

async function dispatchRequest(request: CallRequest): Promise<unknown> {
  const args = request.arguments;
  const operation = request.operation;
  if (operation === 'init') {
    assertExactCallArguments(args, operation, []);
    return initializeDatabase();
  }
  if (operation === 'use') return useRepository(validateUseCallArguments(args));
  if (operation === 'record') {
    const input = validateRecordCallArguments(args);
    return withDatabase((database) => recordEntry(database, input));
  }
  if (operation === 'curator') {
    const input = validateCuratorCallArguments(args);
    return withDatabase((database) => runCuratorCommand(database, { ...input, json: true }));
  }
  if (operation === 'curator_globalize') {
    const input = validateCuratorGlobalizeCallArguments(args);
    return withDatabase((database) => globalizeCuratorCandidate(database, input));
  }
  if (operation === 'guide_start') {
    const input = validateGuideStartCallArguments(args);
    return withDatabase((database) => startAkinator(database, input));
  }
  if (operation === 'guide_answer') {
    const input = validateGuideAnswerCallArguments(args);
    return withDatabase((database) => answerAkinator(database, input));
  }
  if (operation === 'promote') {
    const input = validatePromoteCallArguments(args);
    return withDatabase((database) => promoteEntry(database, input));
  }
  if (operation === 'supersede') {
    const input = validateSupersedeCallArguments(args);
    return withDatabase((database) => supersedeEntry(database, input));
  }
  if (operation === 'link') {
    const input = validateLinkCallArguments(args);
    return withDatabase((database) => {
      linkEntries(database, input);
      return { linked: true };
    });
  }
  if (operation === 'purge') {
    const input = validatePurgeCallArguments(args);
    return withDatabase((database) => {
      purgeEntry(database, input);
      return { purged: true };
    });
  }
  if (operation === 'export') {
    assertExactCallArguments(args, operation, ['workspace', 'output']);
    if (!Object.hasOwn(args, 'output')) {
      throw new KiokukoError('VALIDATION_ERROR', 'export output is required');
    }
    const workspace = requiredStringArgument(args, operation, 'workspace');
    const output = requiredPathArgument(args, operation, 'output');
    return withDatabase((database) => writeExport(database, { workspace, output }));
  }
  if (operation === 'import') {
    assertExactCallArguments(args, operation, ['input', 'workspace', 'dryRun']);
    if (!Object.hasOwn(args, 'input')) {
      throw new KiokukoError('VALIDATION_ERROR', 'import input is required');
    }
    const input = requiredPathArgument(args, operation, 'input');
    const workspace = optionalStringArgument(args, operation, 'workspace');
    const dryRun = optionalBooleanArgument(args, operation, 'dryRun');
    const importOptions: Parameters<typeof importWorkspace>[1] = {
      input,
      ...(workspace === undefined ? {} : { workspace }),
      ...(dryRun === undefined ? {} : { dryRun }),
    };
    return dryRun === true
      ? importWorkspace(undefined, importOptions)
      : withDatabase((database) => importWorkspace(database, importOptions));
  }
  if (operation === 'backup') {
    assertExactCallArguments(args, operation, ['output']);
    if (!Object.hasOwn(args, 'output')) {
      throw new KiokukoError('VALIDATION_ERROR', 'backup output is required');
    }
    const output = requiredPathArgument(args, operation, 'output');
    return createBackup(output);
  }
  if (operation === 'doctor') {
    assertExactCallArguments(args, operation, []);
    return runDoctor();
  }
  throw new KiokukoError('INTEGRITY_ERROR', 'Supported call operation has no dispatcher');
}

export function buildCli(dependencies: CliDependencies = {}): Command {
  const cli = new Command();
  cli.name('kiokuko-ai').description('Model-agnostic external memory for AI coding agents').version(PACKAGE_VERSION);
  cli.exitOverride();
  cli.configureOutput({ outputError: () => undefined });

  cli.command('version').description('Show the Kiokuko package version').action(() => {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
  });

  cli.command('init').description('Initialize the global Kiokuko database').option('--json').action(async (options: { json?: boolean }) => {
    const result = await initializeDatabase();
    const backupNotice = result.backupPath === null ? '' : ` Pre-migration backup: ${result.backupPath}`;
    humanOrJson(options.json, 'init', result, `Kiokuko database initialized (version ${result.currentVersion}).${backupNotice}`);
  });

  cli.command('setup').description('Configure global Kiokuko memory and the OpenCode npm plugin, then refresh managed instructions in registered projects')
    .option('--command <path>', 'Kiokuko executable name or absolute path')
    .option('--dry-run', 'Validate and show planned changes without writing')
    .option('--no-standard-skills', 'Skip installing bundled Kiokuko standard skills')
    .option('--skill-discovery <mode>', 'External Skill discovery: off,official,community')
    .option('--enno-oduno <mode>', 'Enno-Oduno agent loop: on,off')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { command?: string; dryRun?: boolean; json?: boolean; standardSkills: boolean; skillDiscovery?: string; ennoOduno?: string }) => {
      const optionSkillDiscoveryMode = options.skillDiscovery === undefined
        ? undefined
        : parseSetupSkillDiscoveryMode(options.skillDiscovery);
      const setupEnvironment = dependencies.setupEnvironment ?? {};
      const setupInput = dependencies.setupInput ?? process.stdin;
      const setupOutput = dependencies.setupOutput ?? process.stdout;
      const data = await runSetupFlow({
        environment: setupEnvironment,
        dryRun: options.dryRun === true,
        standardSkills: options.standardSkills,
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(optionSkillDiscoveryMode === undefined ? {} : { skillDiscoveryMode: optionSkillDiscoveryMode }),
        ...(options.ennoOduno === undefined ? {} : { ennoOduno: parseEnnoSetupMode(options.ennoOduno) }),
        json: options.json === true,
        input: setupInput,
        output: setupOutput,
      });
      const changed = data.files.filter((file) => file.action !== 'unchanged').length;
      const projectChanged = data.projectAgentFiles.filter((file) => file.status === 'created' || file.status === 'updated').length;
      const projectUnchanged = data.projectAgentFiles.filter((file) => file.status === 'unchanged').length;
      const projectSkipped = data.projectAgentFiles.filter((file) => file.status === 'skipped').length;
      const projectFailed = data.projectAgentFiles.filter((file) => file.status === 'failed').length;
      const projectSummary = data.projectAgentFiles.length === 0
        ? ''
        : ` Registered project instructions: ${projectChanged} changed, ${projectUnchanged} unchanged, ${projectSkipped} skipped, ${projectFailed} failed.`;
      const clientLabel = data.clients.join(', ');
      const message = options.dryRun
        ? `Kiokuko setup plan for ${clientLabel}: ${changed} file${changed === 1 ? '' : 's'} would change.${projectSummary}`
        : `Now you are ready to use Kiokuko! Kiokuko configured for ${clientLabel} (${changed} file${changed === 1 ? '' : 's'} changed).${projectSummary} ${data.nextStep}`;
      humanOrJson(options.json, 'setup', data, message);
    });

  cli.command('mcp').description('Run the Kiokuko MCP server over stdio').action(async () => {
    await runMcpServer();
  });

  cli.command('use').description('Bind this repository to Kiokuko external memory')
    .option('--root <path>').option('--workspace <name>').option('--agent-file <path>', 'Agent instruction file')
    .option('--dry-run').option('--no-agent-file').option('--force-rebind').option('--allow-directory').option('--json')
    .action(async (options: Record<string, unknown>) => {
      const useOptions: Parameters<typeof useRepository>[0] = {};
      if (typeof options.root === 'string') useOptions.root = options.root;
      if (typeof options.workspace === 'string') useOptions.workspace = options.workspace;
      if (typeof options.agentFile === 'string') useOptions.agentFile = options.agentFile;
      if (options.dryRun === true) useOptions.dryRun = true;
      if (options.noAgentFile === true) useOptions.noAgentFile = true;
      if (options.forceRebind === true) useOptions.forceRebind = true;
      if (options.allowDirectory === true) useOptions.allowDirectory = true;
      const result = await useRepository(useOptions);
      humanOrJson(options.json === true, 'use', result, `Kiokuko enabled for ${result.repositoryRoot}`);
    });

  configureRecallCommand(cli.command('recall'), dependencies);
  const memory = cli.command('memory').description('Human/operator memory management');
  configureRecallCommand(memory.command('recall'), dependencies);

  const guide = cli.command('guide').description('Run the Akinator-style knowledge and skill intake');
  guide.command('start').description('Start an intake session').argument('<task>').requiredOption('--workspace <name>').option('--json').action(async (task: string, options: { workspace: string; json?: boolean }) => {
    const data = await withDatabase((database) => startAkinator(database, { workspace: options.workspace, task }));
    humanOrJson(options.json, 'guide.start', data, data.question?.prompt ?? 'Akinator context is ready');
  });
  guide.command('answer').description('Answer the current intake question').argument('<session-id>').requiredOption('--workspace <name>').requiredOption('--question-id <id>').requiredOption('--value <value>').option('--json').action(async (sessionId: string, options: { workspace: string; questionId: string; value: string; json?: boolean }) => {
    const data = await withDatabase((database) => answerAkinator(database, {
      workspace: options.workspace,
      sessionId,
      questionId: options.questionId as never,
      value: options.value,
    }));
    humanOrJson(options.json, 'guide.answer', data, data.question?.prompt ?? 'Akinator context is ready');
  });
  const search = addWorkspaceOptions(cli.command('search').description('Human/operator management: search memory entries').argument('<query>'))
    .option('--limit <number>', 'Maximum entries', '20').option('--kind <kind>').option('--status <status>').option('--tag <tag>');
  search.action(async (query: string, options: Record<string, unknown>) => {
    const searchOptions: Parameters<typeof searchEntries>[1] = { workspace: String(options.workspace ?? ''), query, limit: Number(options.limit) };
    if (typeof options.kind === 'string') searchOptions.kind = options.kind as never;
    if (typeof options.status === 'string') searchOptions.status = options.status as never;
    if (typeof options.tag === 'string') searchOptions.tag = options.tag;
    const data = await withEmbeddingDatabase(dependencies, (database, backend) => withPreparedSemanticRuntime(
      dependencies,
      database,
      backend,
      query,
      (runtime) => searchEntries(database, searchOptions, runtime),
    ));
    humanOrJson(options.json === true, 'search', data, `${data.items.length} memory entries found`, { count: data.count });
  });

  const read = addWorkspaceOptions(cli.command('read').description('Human/operator management: read one memory entry').argument('<entry-id>'));
  read.action(async (entryId: string, options: Record<string, unknown>) => {
    const data = await withDatabase((database) => readEntry(database, { workspace: String(options.workspace ?? ''), entryId }));
    humanOrJson(options.json === true, 'read', data, `${data.title}\n${data.body}`);
  });

  const record = cli.command('record').description('Record a memory entry').requiredOption('--workspace <name>').requiredOption('--input-json <file>').option('--json');
  record.action(async (options: { workspace: string; inputJson: string; json?: boolean }) => {
    const parsed = snapshotPlainJsonObject(
      await readJsonInput(options.inputJson),
      'record input must be a JSON object',
    );
    const input = validateRecordInput({ ...parsed, workspace: options.workspace });
    const data = await withDatabase((database) => recordEntry(database, input));
    humanOrJson(options.json, 'record', data, `Recorded ${data.id}`);
  });

  const promote = cli.command('promote').description('Promote a candidate entry').argument('<entry-id>').requiredOption('--workspace <name>').requiredOption('--expected-revision <number>').option('--json');
  promote.action(async (entryId: string, options: { workspace: string; expectedRevision: string; json?: boolean }) => {
    const data = await withDatabase((database) => promoteEntry(database, { workspace: options.workspace, entryId, expectedRevision: parseExpectedRevision(options.expectedRevision) }));
    humanOrJson(options.json, 'promote', data, `Promoted ${data.id}`);
  });

  const curator = cli.command('curator').description('Review reusable knowledge and add confirmed candidates to global memory')
    .option('--workspace <name>', 'Project workspace (defaults to the current repository)')
    .option('--cwd <path>', 'Repository path used when resolving the current workspace')
    .option('--entry-id <id>', 'Review one candidate entry')
    .option('--limit <number>', 'Maximum candidates to review', '10')
    .option('--skill-ready-only', 'Show only candidates backed by qualified independent Akinator runs')
    .option('--yes', 'Add every displayed candidate without interactive prompts')
    .option('--json', 'Emit candidates as JSON without changing memory');
  curator.action(async (options: { workspace?: string; cwd?: string; entryId?: string; limit: string; skillReadyOnly?: boolean; yes?: boolean; json?: boolean }) => {
    const data = await withDatabase((database) => runCuratorCommand(database, {
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      limit: Number(options.limit),
      ...(options.entryId === undefined ? {} : { entryId: options.entryId }),
      skillReadyOnly: options.skillReadyOnly === true,
      yes: options.yes === true,
      json: options.json === true,
    }));
    humanOrJson(options.json, 'curator', data, `${data.candidates.length} curator candidate${data.candidates.length === 1 ? '' : 's'} reviewed; ${data.globalized.length} added to global memory`);
  });

  const supersede = cli.command('supersede').description('Supersede an existing entry').argument('<old-entry-id>').requiredOption('--with <entry-id>').requiredOption('--workspace <name>').requiredOption('--expected-revision <number>').option('--json');
  supersede.action(async (oldEntryId: string, options: { with: string; workspace: string; expectedRevision: string; json?: boolean }) => {
    const data = await withDatabase((database) => supersedeEntry(database, { workspace: options.workspace, oldEntryId, replacementEntryId: options.with, expectedRevision: parseExpectedRevision(options.expectedRevision) }));
    humanOrJson(options.json, 'supersede', data, `Superseded ${data.id}`);
  });

  const link = cli.command('link').description('Link two memory entries').argument('<from-entry-id>').argument('<to-entry-id>').requiredOption('--workspace <name>').requiredOption('--relation <relation>').option('--json');
  link.action(async (fromEntryId: string, toEntryId: string, options: { workspace: string; relation: never; json?: boolean }) => {
    const data = await withDatabase((database) => { linkEntries(database, { workspace: options.workspace, fromEntryId, toEntryId, relation: options.relation }); return { linked: true }; });
    humanOrJson(options.json, 'link', data, `Linked ${fromEntryId} -> ${toEntryId}`);
  });

  const purge = cli.command('purge').description('Purge a memory entry').argument('<entry-id>').requiredOption('--workspace <name>').option('--confirm').option('--json');
  purge.action(async (entryId: string, options: { workspace: string; confirm?: boolean; json?: boolean }) => {
    const data = await withDatabase((database) => { purgeEntry(database, { workspace: options.workspace, entryId, confirm: options.confirm === true }); return { purged: true }; });
    humanOrJson(options.json, 'purge', data, `Purged ${entryId}`);
  });

  cli.command('backup').description('Create a database backup').requiredOption('--output <path>').option('--json').action(async (options: { output: string; json?: boolean }) => {
    const result = await createBackup(options.output);
    humanOrJson(options.json, 'backup', result, `Backup written to ${options.output}`);
  });

  cli.command('doctor').description('Check runtime, database, and OpenCode MCP configuration health; interactively clean missing repository locations').option('--json').action(async (options: { json?: boolean }) => {
    const doctorOptions: Parameters<typeof runDoctor>[0] = {
      ...(dependencies.doctorDatabasePath === undefined ? {} : { databasePath: dependencies.doctorDatabasePath }),
      ...(dependencies.doctorRuntimeDescriptorPath === undefined ? {} : { runtimeDescriptorPath: dependencies.doctorRuntimeDescriptorPath }),
      ...(dependencies.embeddingEnvironment === undefined ? {} : { embeddingEnvironment: dependencies.embeddingEnvironment }),
      ...(dependencies.embeddingBackend === undefined ? {} : { embeddingBackend: dependencies.embeddingBackend }),
    };
    const databaseOptions: Parameters<typeof initializeDatabase>[0] = dependencies.doctorDatabasePath === undefined
      ? {}
      : { databasePath: dependencies.doctorDatabasePath };
    let data = await runDoctor(doctorOptions);
    let removed = 0;
    const input = dependencies.doctorInput ?? process.stdin;
    const output = dependencies.doctorOutput ?? process.stdout;
    const interactive = options.json !== true
      && (input as { isTTY?: boolean }).isTTY === true
      && (output as { isTTY?: boolean }).isTTY === true;
    if (interactive && data.checks.bindings.ok === false && (data.checks.bindings.count ?? 0) > 0) {
      const missing = await withDatabase(
        (database) => findMissingRepositoryLocations(database),
        databaseOptions,
      );
      if (missing.length > 0 && await promptRemoveMissingRepositoryLocations(missing, { input, output })) {
        removed = await withDatabase(
          (database) => removeMissingRepositoryLocations(database, missing),
          databaseOptions,
        );
        data = await runDoctor(doctorOptions);
      }
    }
    const cleanupNotice = removed === 0
      ? ''
      : ` Removed ${removed} missing repository location${removed === 1 ? '' : 's'}.`;
    const failureNotice = data.ok
      ? ''
      : ` Failed checks: ${Object.entries(data.checks).filter(([, check]) => !check.ok).map(([name]) => name).join(', ')}.\nrun kiokuko-ai doctor --json for detailed output`;
    humanOrJson(options.json, 'doctor', data, `${data.ok ? 'Kiokuko doctor: OK' : 'Kiokuko doctor: FAILED'}${cleanupNotice}${failureNotice}`);
    if (!data.ok) process.exitCode = 8;
  });

  registerServerCommands(cli, dependencies.server);
  registerAgentCommand(cli, dependencies.agent);
  registerLedgerCommands(cli, { withDatabase });
  registerSkillsCommands(cli, dependencies.skills ?? { withDatabase });
  registerEnnoCommand(cli, { withDatabase });
  registerEmbeddingsCommands(cli, {
    withDatabase: (operation) => withEmbeddingDatabase(dependencies, operation),
    ...(dependencies.embeddingEnvironment === undefined ? {} : { environment: dependencies.embeddingEnvironment }),
    ...(dependencies.embeddingProvider === undefined ? {} : { provider: dependencies.embeddingProvider }),
    ...(dependencies.embeddingBackend === undefined ? {} : { backend: dependencies.embeddingBackend }),
    ...(dependencies.setupEnvironment === undefined ? {} : { pathEnvironment: dependencies.setupEnvironment }),
    ...(dependencies.setupInput === undefined ? {} : { setupInput: dependencies.setupInput }),
    ...(dependencies.setupOutput === undefined ? {} : { setupOutput: dependencies.setupOutput }),
    output: humanOrJson,
  });

  cli.command('web').description('Start the local Kiokuko web UI')
    .option('--host <host>', 'Loopback host', '127.0.0.1')
    .option('--port <number>', 'HTTP port', '4173')
    .option('--json')
    .action(async (options: { host: string; port: string; json?: boolean }) => {
      const web = await startWebServer({ host: options.host, port: Number(options.port) });
      humanOrJson(options.json, 'web', { url: web.url }, `Kiokuko Web: ${web.url}`);
      await new Promise<void>((resolve, reject) => {
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          void web.close().then(resolve, reject);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  cli.command('export').description('Export workspace memory').requiredOption('--workspace <name>').requiredOption('--output <path>').option('--json').action(async (options: { workspace: string; output: string; json?: boolean }) => {
    const result = await withDatabase((database) => writeExport(database, { workspace: options.workspace, output: options.output }));
    humanOrJson(options.json, 'export', { output: options.output, count: result.count, checksum: result.checksum }, `Exported ${result.count} entries`);
  });

  cli.command('import').description('Import workspace memory').requiredOption('--input <path>').option('--workspace <name>').option('--dry-run').option('--json').action(async (options: { input: string; workspace?: string; dryRun?: boolean; json?: boolean }) => {
    const importOptions: Parameters<typeof importWorkspace>[1] = { input: options.input };
    if (options.workspace !== undefined) importOptions.workspace = options.workspace;
    if (options.dryRun) importOptions.dryRun = true;
    const data = options.dryRun
      ? await importWorkspace(undefined, importOptions)
      : await withDatabase((database) => importWorkspace(database, importOptions));
    humanOrJson(options.json, 'import', data, `${data.count} records inspected`);
  });

  cli.command('call').description('Process one management JSON request; memory reads are not supported').requiredOption('--input-json <file>').option('--json').action(async (options: { inputJson: string }) => {
    const request = parseCallRequest(await readJsonInput(options.inputJson));
    const data = await dispatchRequest(request);
    emit(successEnvelope(request.operation, data));
  });

  return cli;
}

function operationFor(argv: string[]): string {
  const command = argv[2] ?? 'unknown';
  if (['server', 'agent', 'skills', 'embeddings'].includes(command) && argv[3] !== undefined && !argv[3].startsWith('-')) return `${command}.${argv[3]}`;
  return command;
}

function commanderDiagnostic(error: CommanderError): string {
  if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return '';
  return `Command line usage error (${error.code})\n`;
}

export async function runCli(argv: string[] = process.argv, dependencies: CliDependencies = {}): Promise<number> {
  let serveStarted = false;
  const serverDependencies: ServerCommandDependencies = {
    ...(dependencies.server ?? {}),
    onServeStarted: () => {
      serveStarted = true;
      dependencies.server?.onServeStarted?.();
    },
  };
  const cli = buildCli({ ...dependencies, server: serverDependencies });
  const jsonRequested = argv.includes('--json') || argv.includes('call');
  const operation = operationFor(argv);
  try {
    await cli.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      if (jsonRequested) {
        emit(errorEnvelope(operation, new KiokukoError('USAGE_ERROR', 'Invalid command-line usage', { commanderCode: error.code })));
        return 2;
      }
      const diagnostic = commanderDiagnostic(error);
      if (diagnostic.length > 0) process.stderr.write(diagnostic);
      return 2;
    }
    const envelope = errorEnvelope(operation, error);
    if (jsonRequested && !(serveStarted && operation === 'serve')) emit(envelope);
    else process.stderr.write(`${envelope.error.message}\n`);
    return exitCodeFor(error);
  }
}
