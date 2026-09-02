import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { initializeDatabase } from './init.js';
import { databaseFileIdentity, openConnection } from '../db/connection.js';
import { KiokukoError } from '../errors.js';
import { readRegularFile } from '../agent-file/atomic-write.js';
import { BEGIN_MARKER, END_MARKER } from '../agent-file/managed-block.js';
import { readProjectConfig } from '../config/project-config.js';
import { getOpenCodeConfigDirectory, getDatabaseLockPath, getGlobalDatabasePath, getRuntimeDescriptorPath } from '../config/paths.js';
import { listRepositoryLocations, type RepositoryLocation } from '../repository/binding.js';
import { isPidAlive } from '../server/instance-lock.js';
import { readRuntimeDescriptor } from '../server/runtime-descriptor.js';
import { inspectLedger } from '../ledger/maintenance.js';
import { findSecret } from '../memory/secrets.js';
import { hybridSearchProjectionStatus } from '../memory/rebuild-search.js';
import { hybridSearchProjectionSchema } from '../memory/structured-memory.js';
import { readEntryRevision } from '../memory/revisions.js';
import { inspectMigrationSnapshot, loadMigrationSnapshot } from '../db/migrate.js';
import { inspectEmbeddingHealth } from '../embedding/diagnostics.js';
import { EmbeddingBackendUnavailableError, openEmbeddingDatabase } from '../embedding/backend.js';
import { parseEmbeddingConfig } from '../embedding/config.js';
import { readPersistedEmbeddingSettings } from '../embedding/settings.js';
import type { VectorSearchBackend } from '../embedding/types.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { renderOpenCodeConfig } from '../setup/opencode-config.js';
import { setupMcpIdentityConflictClient } from '../setup/mcp-conflict.js';

export interface DoctorCheck {
  ok: boolean;
  count?: number;
  detail?: string;
}

export interface DoctorResult {
  ok: boolean;
  databasePath: string;
  currentVersion: number;
  capabilities: Awaited<ReturnType<typeof initializeDatabase>>['capabilities'] | null;
  integrity: string;
  fts5: boolean;
  checks: {
    integrity: DoctorCheck;
    foreignKeys: DoctorCheck;
    entryRevisions: DoctorCheck;
    revisionTags: DoctorCheck;
    deliveryRevisions: DoctorCheck;
    revisionHashes: DoctorCheck;
    migrations: DoctorCheck;
    fts: DoctorCheck;
    danglingLinks: DoctorCheck;
    contradictions: DoctorCheck;
    bindings: DoctorCheck;
    agentFiles: DoctorCheck;
    permissions: DoctorCheck;
    secrets: DoctorCheck;
    ledger: DoctorCheck;
    nudgeDeliveries: DoctorCheck;
    runtime: DoctorCheck;
    hybridSearch: DoctorCheck;
    embeddings: DoctorCheck;
    ennoOperations: DoctorCheck;
    openCodeMcp: DoctorCheck;
  };
}

export interface DoctorOptions {
  databasePath?: string;
  migrationsDirectory?: string;
  runtimeDescriptorPath?: string;
  embeddingEnvironment?: NodeJS.ProcessEnv;
  embeddingBackend?: VectorSearchBackend;
}

export interface DoctorDependencies {
  openConnection?: typeof openConnection;
}

export interface DoctorPromptOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const MAX_DOCTOR_PROMPT_LOCATIONS = 20;

/** Ask before removing registry rows for repository roots that no longer exist. */
export async function promptRemoveMissingRepositoryLocations(
  locations: readonly RepositoryLocation[],
  options: DoctorPromptOptions = {},
): Promise<boolean> {
  if (locations.length < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Missing repository locations must not be empty');
  }
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const prompt = createInterface({ input, output });
  try {
    const count = locations.length;
    output.write(
      `Doctor found ${count} repository location${count === 1 ? '' : 's'} with a missing root. `
      + 'The following registry rows are candidates:\n',
    );
    for (const location of locations.slice(0, MAX_DOCTOR_PROMPT_LOCATIONS)) {
      output.write(`  - ${location.canonicalRoot}\n`);
    }
    if (locations.length > MAX_DOCTOR_PROMPT_LOCATIONS) {
      output.write(`  ... and ${locations.length - MAX_DOCTOR_PROMPT_LOCATIONS} more\n`);
    }
    output.write('This removes registry rows only; it does not delete files or memory.\n');
    const answer = (await prompt.question('Remove these stale locations? [Y/n] ')).trim();
    return answer.length === 0 || /^(?:y|yes|はい)$/iu.test(answer);
  } finally {
    prompt.close();
  }
}

function count(database: SqliteDatabase, sql: string, ...parameters: Array<string | number>): number {
  return Number(database.prepare(sql).get<{ count: number }>(...parameters)?.count ?? 0);
}

function hasColumn(database: SqliteDatabase, table: string, column: string): boolean {
  return database.prepare(`PRAGMA table_info(${table})`).all<{ name: unknown }>()
    .some((row) => row.name === column);
}

function balancedMarkers(content: string): boolean {
  return content.split(BEGIN_MARKER).length - 1 === 1 && content.split(END_MARKER).length - 1 === 1;
}

/** Resolve the OpenCode config path using setup's opencode.jsonc-before-json precedence. */
async function openCodeConfigPath(): Promise<string> {
  const directory = getOpenCodeConfigDirectory();
  const jsonc = path.join(directory, 'opencode.jsonc');
  if (await readRegularFile(jsonc) !== undefined) return jsonc;
  return path.join(directory, 'opencode.json');
}

/** Inspect the OpenCode MCP identity using the same canonical parser as setup. */
async function openCodeMcpCheck(): Promise<DoctorCheck> {
  let config;
  try {
    config = await readRegularFile(await openCodeConfigPath());
  } catch {
    return { ok: false, count: 1, detail: 'config=unavailable' };
  }
  if (config === undefined) return { ok: true, count: 0, detail: 'config=absent' };
  try {
    // Rendering is intentionally discarded: it validates the existing identity
    // without writing, and accepts configs that simply have not been configured.
    renderOpenCodeConfig(config.content);
    return { ok: true, count: 0, detail: 'config=canonical-or-not-configured' };
  } catch (error) {
    if (setupMcpIdentityConflictClient(error) === 'opencode') {
      return { ok: false, count: 1, detail: 'config=conflict' };
    }
    return { ok: false, count: 1, detail: 'config=invalid' };
  }
}

function skippedOpenCodeMcpCheck(): DoctorCheck {
  return { ok: true, count: 0, detail: 'config=skipped-for-explicit-database' };
}

async function runtimeCheck(databasePath: string, descriptorPath = getRuntimeDescriptorPath()): Promise<DoctorCheck> {
  let findings = 0;
  let descriptor: Awaited<ReturnType<typeof readRuntimeDescriptor>>;
  let descriptorPresent = false;
  let lockPresent = false;
  try {
    descriptor = await readRuntimeDescriptor(descriptorPath);
    if (descriptor !== undefined) {
      const expected = `sha256:${createHash('sha256').update(path.resolve(databasePath), 'utf8').digest('hex')}`;
      // A single runtime descriptor is shared by the normal CLI/server
      // installation. It may legitimately describe another database when
      // doctor is run against an explicit backup or test database.
      if (descriptor.databaseFingerprint === expected) {
        descriptorPresent = true;
        if (!(await isPidAlive(descriptor.pid))) findings += 1;
      }
    }
  } catch {
    findings += 1;
  }

  const lockPath = getDatabaseLockPath(databasePath);
  try {
    const info = lstatSync(lockPath);
    lockPresent = true;
    if (info.isSymbolicLink() || !info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) findings += 1;
    try {
      const value = JSON.parse(readFileSync(lockPath, 'utf8')) as { instanceId?: unknown; pid?: unknown };
      if (typeof value.instanceId !== 'string' || typeof value.pid !== 'number' || !(await isPidAlive(value.pid))) findings += 1;
      if (descriptor !== undefined && value.instanceId !== descriptor.instanceId) findings += 1;
    } catch {
      findings += 1;
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) findings += 1;
  }
  if (descriptorPresent !== lockPresent) findings += 1;
  return { ok: findings === 0, count: findings, detail: `findings=${findings}` };
}

interface DoctorCollectionOptions {
  databasePath: string;
  databaseVersion: number;
  currentVersion: number;
  capabilities: DoctorResult['capabilities'];
  runtimeDescriptorPath?: string;
  embeddingEnvironment?: NodeJS.ProcessEnv;
  embeddingBackend?: VectorSearchBackend;
  openCodeMcp: DoctorCheck;
}

async function collectDoctorResult(
  database: SqliteDatabase,
  options: DoctorCollectionOptions,
): Promise<DoctorResult> {
  const integrity = database.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check ?? 'unknown';
  const foreignKeyRows = database.prepare('PRAGMA foreign_key_check').all();
  const fts5 = Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'").get());
  const migrationRows = count(database, 'SELECT COUNT(*) AS count FROM schema_migrations');
  const migrationCheck = { ok: migrationRows === options.currentVersion, count: migrationRows, detail: `expected ${options.currentVersion}` };

  const entryCount = count(database, 'SELECT COUNT(*) AS count FROM entries');
  const ftsCount = fts5 ? count(database, 'SELECT COUNT(*) AS count FROM entries_fts') : 0;
  let ftsCurrentMismatches = 0;
  if (fts5) {
    const currentRows = database.prepare(`
      SELECT e.rowid, e.id, r.title, r.body, r.summary, e.current_revision
        FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
    `).all<{ rowid: number; id: string; title: string; body: string; summary: string | null; current_revision: number }>();
    for (const row of currentRows) {
      const projected = database.prepare('SELECT title, body, summary, tags_text FROM entries_fts WHERE rowid = ?').get<{ title: string; body: string; summary: string; tags_text: string }>(row.rowid);
      const tags = database.prepare('SELECT tag FROM entry_revision_tags WHERE entry_id = ? AND revision = ? ORDER BY tag').all<{ tag: string }>(row.id, row.current_revision).map((tag) => tag.tag);
      if (!projected || projected.title !== row.title || projected.body !== row.body || projected.summary !== (row.summary ?? '') || projected.tags_text !== tags.join(' ')) ftsCurrentMismatches += 1;
    }
  }
  const ftsCheck = {
    ok: fts5 && entryCount === ftsCount && ftsCurrentMismatches === 0,
    count: Math.abs(entryCount - ftsCount) + ftsCurrentMismatches + (fts5 ? 0 : 1),
    detail: `present=${fts5}, entries=${entryCount}, fts=${ftsCount}, currentMismatches=${ftsCurrentMismatches}`,
  };
  const missingCurrentRevisions = count(database, `
    SELECT COUNT(*) AS count FROM entries e
    LEFT JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
    WHERE r.entry_id IS NULL
  `);
  const orphanRevisionTags = count(database, `
    SELECT COUNT(*) AS count FROM entry_revision_tags t
    LEFT JOIN entry_revisions r ON r.entry_id = t.entry_id AND r.revision = t.revision
    WHERE r.entry_id IS NULL
  `);
  const missingDeliveryRevisions = count(database, `
    SELECT COUNT(*) AS count FROM context_delivery_entries d
    LEFT JOIN entry_revisions r ON r.entry_id = d.entry_id AND r.revision = d.entry_revision
    WHERE r.entry_id IS NULL
  `);
  const revisionRows = database.prepare(`
    SELECT r.entry_id, r.workspace, r.revision
      FROM entry_revisions AS r
  `).all<{ entry_id: string; workspace: string; revision: number }>();
  const hashFormatTable = database.prepare(`
    SELECT type
      FROM sqlite_schema
     WHERE name = 'entry_revision_hash_format'
  `).get<{ type: unknown }>();
  const hashFormats = hashFormatTable?.type === 'table'
    ? database.prepare('SELECT singleton, algorithm FROM entry_revision_hash_format')
      .all<{ singleton: unknown; algorithm: unknown }>()
    : [];
  let revisionHashMismatches = 0;
  revisionHashMismatches = hashFormats.length === 1
    && hashFormats[0]?.singleton === 1
    && hashFormats[0].algorithm === 'canonical-json-utf16-tags-v1'
    ? 0
    : 1;
  for (const row of revisionRows) {
    try {
      // The shared decoder accepts only the canonical JSON preimage and the
      // single locale-independent revision hash format.
      readEntryRevision(database, {
        entryId: row.entry_id,
        workspace: row.workspace,
        revision: row.revision,
      });
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR') {
        revisionHashMismatches += 1;
        continue;
      }
      throw error;
    }
  }
  const revisionHashCheck = { ok: revisionHashMismatches === 0, count: revisionHashMismatches };
  const hybridCheck = (() => {
    try {
      const projection = hybridSearchProjectionStatus(database);
      return {
        ok: projection.missingSignals === 0 && projection.extraSignals === 0 && projection.staleTrigram === 0,
        count: projection.missingSignals + projection.extraSignals + projection.staleTrigram,
        detail: `entries=${projection.entries}, trigram=${projection.trigram}, signals=${projection.signals}, missingSignals=${projection.missingSignals}, extraSignals=${projection.extraSignals}, staleTrigram=${projection.staleTrigram}`,
      };
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR') {
        return { ok: false, count: 1, detail: 'stored projection source is invalid' };
      }
      throw error;
    }
  })();
  const danglingLinks = count(database, `
    SELECT COUNT(*) AS count FROM entry_links l
    LEFT JOIN entries f ON f.id = l.from_entry_id
    LEFT JOIN entries t ON t.id = l.to_entry_id
    WHERE f.id IS NULL OR t.id IS NULL
  `);
  const contradictions = count(database, `
    SELECT COUNT(*) AS count FROM entry_links l
    JOIN entries f ON f.id = l.from_entry_id
    JOIN entries t ON t.id = l.to_entry_id
    WHERE l.relation = 'contradicts' AND f.status = 'verified' AND t.status = 'verified'
  `);

  const bindingRows = listRepositoryLocations(database);
  const missingRoots = bindingRows.filter((row) => !existsSync(row.canonicalRoot)).length;
  const bindingCheck = { ok: missingRoots === 0, count: missingRoots, detail: `locations=${bindingRows.length}` };

  let missingAgentFiles = 0;
  for (const row of bindingRows) {
    if (!existsSync(row.canonicalRoot)) continue;
    const configPath = `${row.canonicalRoot}/.kiokuko.json`;
    try {
      const config = await readProjectConfig(configPath);
      const agentPath = `${row.canonicalRoot}/${config.agentFile}`;
      if (!existsSync(agentPath) || !balancedMarkers(readFileSync(agentPath, 'utf8'))) missingAgentFiles += 1;
    } catch {
      missingAgentFiles += 1;
    }
  }
  const agentFilesCheck = { ok: missingAgentFiles === 0, count: missingAgentFiles };

  let secretCount = 0;
  const secretRows = database.prepare(`
    SELECT r.title, r.body, r.summary, r.scope_json, r.provenance_json
      FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
  `).all<{ title: string; body: string; summary: string | null; scope_json: string; provenance_json: string }>();
  for (const row of secretRows) {
    if (findSecret(`${row.title}\n${row.body}\n${row.summary ?? ''}\n${row.scope_json}\n${row.provenance_json}`)) secretCount += 1;
  }
  const permissions = (() => {
    try {
      const mode = statSync(options.databasePath).mode & 0o777;
      return { ok: (mode & 0o077) === 0, count: mode, detail: `mode=${mode.toString(8)}` };
    } catch {
      return { ok: false, count: 0, detail: 'database file is not accessible' };
    }
  })();

  const ledgerReport = inspectLedger(database);
  const ledgerCheck = { ok: ledgerReport.ok, count: ledgerReport.findingCount, detail: `findings=${ledgerReport.findingCount}` };
  const nudgeDeliveries = {
    ok: ledgerReport.checks.nudgeDeliveries.ok,
    count: ledgerReport.checks.nudgeDeliveries.findingCount,
    detail: `deliveries=${ledgerReport.counts.nudgeDeliveries}, findings=${ledgerReport.checks.nudgeDeliveries.findingCount}`,
  };
  const runtime = await runtimeCheck(options.databasePath, options.runtimeDescriptorPath);
  const embeddings = inspectEmbeddingHealth(
    database,
    options.embeddingEnvironment ?? readPersistedEmbeddingSettings(database),
    options.embeddingBackend,
  );
  const ennoLeaseSchemaPresent = ['enno_operation_receipts', 'enno_verifier_runs'].every((table) => (
    Boolean(database.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = ?
    `).get(table)) && hasColumn(database, table, 'lease_expires_at')
  ));
  const ennoOperations = !ennoLeaseSchemaPresent
      ? { ok: false, count: 1, detail: 'Enno operation lease schema is incomplete' }
    : (() => {
      const now = new Date().toISOString();
      const expiredReceipts = count(database, `
        SELECT COUNT(*) AS count FROM enno_operation_receipts
        WHERE state = 'started'
          AND (julianday(lease_expires_at) IS NULL OR lease_expires_at <= ?)
      `, now);
      const recoveredReceipts = count(database, `
        SELECT COUNT(*) AS count FROM enno_operation_receipts WHERE state = 'abandoned'
      `);
      const expiredVerifiers = count(database, `
        SELECT COUNT(*) AS count FROM enno_verifier_runs
        WHERE status = 'started'
          AND (julianday(lease_expires_at) IS NULL OR lease_expires_at <= ?)
      `, now);
      const recoveredVerifiers = count(database, `
        SELECT COUNT(*) AS count FROM enno_verifier_runs WHERE status = 'abandoned'
      `);
      return {
        ok: expiredReceipts + expiredVerifiers === 0,
        count: expiredReceipts + expiredVerifiers,
        detail: `staleReceipts=${expiredReceipts}, staleVerifiers=${expiredVerifiers}, recoveredReceipts=${recoveredReceipts}, recoveredVerifiers=${recoveredVerifiers}`,
      };
    })();
  const checks = {
    integrity: { ok: integrity === 'ok', detail: integrity },
    foreignKeys: { ok: foreignKeyRows.length === 0, count: foreignKeyRows.length },
    entryRevisions: { ok: missingCurrentRevisions === 0, count: missingCurrentRevisions },
    revisionTags: { ok: orphanRevisionTags === 0, count: orphanRevisionTags },
    deliveryRevisions: { ok: missingDeliveryRevisions === 0, count: missingDeliveryRevisions },
    revisionHashes: revisionHashCheck,
    migrations: migrationCheck,
    fts: ftsCheck,
    danglingLinks: { ok: danglingLinks === 0, count: danglingLinks },
    contradictions: { ok: contradictions === 0, count: contradictions, detail: 'verified contradictions require review' },
    bindings: bindingCheck,
    agentFiles: agentFilesCheck,
    permissions,
    secrets: { ok: secretCount === 0, count: secretCount },
    ledger: ledgerCheck,
    nudgeDeliveries,
    runtime,
    hybridSearch: hybridCheck,
    embeddings: embeddings.check,
    ennoOperations,
    openCodeMcp: options.openCodeMcp,
  };
  const ok = Object.values(checks).every((check) => check.ok);
  return {
    ok,
    databasePath: '<redacted>',
    currentVersion: options.currentVersion,
    capabilities: options.capabilities,
    integrity,
    fts5,
    checks,
  };
}

export async function runDoctor(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
): Promise<DoctorResult> {
  const initOptions = {
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    ...(options.migrationsDirectory === undefined ? {} : { migrationsDirectory: options.migrationsDirectory }),
  };
  const initialized = await initializeDatabase(initOptions);
  const openCodeMcp = options.databasePath === undefined ? await openCodeMcpCheck() : skippedOpenCodeMcpCheck();
  let embeddingConfig;
  try {
    embeddingConfig = options.embeddingEnvironment === undefined
      ? undefined
      : parseEmbeddingConfig(options.embeddingEnvironment);
  } catch {
    embeddingConfig = undefined;
  }
  let opened: { database: SqliteDatabase; backend: VectorSearchBackend | undefined };
  try {
    opened = await openEmbeddingDatabase(initialized.databasePath, {
      ...(embeddingConfig === undefined ? {} : { config: embeddingConfig }),
      openDatabase: dependencies.openConnection ?? openConnection,
      ...(options.embeddingBackend === undefined ? {} : { backend: options.embeddingBackend }),
    });
  } catch (error) {
    if (!(error instanceof EmbeddingBackendUnavailableError)) throw error;
    opened = {
      database: (dependencies.openConnection ?? openConnection)(initialized.databasePath),
      backend: undefined,
    };
  }
  const database = opened.database;
  let doctorResult: DoctorResult | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    doctorResult = await collectDoctorResult(database, {
      databasePath: initialized.databasePath,
      databaseVersion: initialized.currentVersion,
      currentVersion: initialized.currentVersion,
      capabilities: initialized.capabilities,
      ...(options.runtimeDescriptorPath === undefined ? {} : { runtimeDescriptorPath: options.runtimeDescriptorPath }),
      ...(options.embeddingEnvironment === undefined ? {} : { embeddingEnvironment: options.embeddingEnvironment }),
      ...((opened.backend ?? options.embeddingBackend) === undefined
        ? {}
        : { embeddingBackend: opened.backend ?? options.embeddingBackend }),
      openCodeMcp,
    });
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
        'Doctor checks failed and closing the database connection also failed',
      );
    }
    throw closeError;
  }
  if (operationFailed) throw operationError;
  if (doctorResult === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Doctor checks produced no result');
  }
  return doctorResult;
}
