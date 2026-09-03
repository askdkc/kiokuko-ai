import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { getGlobalDatabasePath } from '../../src/config/paths.js';
import { openConnection } from '../../src/db/connection.js';
import { inspectMigrationSnapshot } from '../../src/db/migrate.js';
import {
  SAMPLE_EXTERNAL_SKILL_DOCUMENT_COUNT,
  SAMPLE_EXTERNAL_SKILL_ID,
  SAMPLE_EXTERNAL_SKILL_WORKSPACE,
  SAMPLE_GLOBAL_TITLES,
  SAMPLE_GLOBAL_WORKSPACE,
  SAMPLE_PROJECT_TITLES,
  SAMPLE_PROJECT_UNICODE_BODY,
  SAMPLE_PROJECT_WORKSPACE,
  SAMPLE_SQLITE_WRITER_VERSION,
} from '../fixtures/sample-database.js';
import {
  CURRENT_MIGRATION_VERSIONS,
  CURRENT_MIGRATION_SNAPSHOT,
  CURRENT_SCHEMA_VERSION,
} from '../fixtures/current-migrations.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(repositoryRoot, 'dist/bin/kiokuko.js');
const sampleDatabasePath = path.join(repositoryRoot, 'tests/sampledb/kiokuko-ai.sqlite');

interface CliEnvelope {
  version: number;
  ok: true;
  operation: string;
  data: Record<string, unknown>;
}

type WebProcess = ChildProcessByStdio<null, Readable, Readable>;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.notEqual(value, null, `${label} must be an object`);
  assert.equal(Array.isArray(value), false, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  const result = value[field];
  assert.ok(Array.isArray(result), `${field} must be an array`);
  return result;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  assert.equal(typeof result, 'string', `${field} must be a string`);
  return result as string;
}

function parseCliEnvelope(stdout: string, operation: string): CliEnvelope {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 1, `${operation} must emit exactly one JSON line`);
  const envelope = objectValue(JSON.parse(lines[0]!) as unknown, `${operation} envelope`);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.operation, operation);
  return {
    version: 1,
    ok: true,
    operation,
    data: objectValue(envelope.data, `${operation}.data`),
  };
}

async function runCliJson(args: string[], operation: string, environment: NodeJS.ProcessEnv): Promise<CliEnvelope> {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(result.stderr, '', `${operation} wrote unexpected stderr`);
  return parseCliEnvelope(result.stdout, operation);
}

async function assertCurrentFixture(): Promise<void> {
  assert.ok(
    CURRENT_SCHEMA_VERSION > 0,
    'The sample database must use the current single-migration schema',
  );
  const header = (await readFile(sampleDatabasePath)).subarray(0, 100);
  assert.equal(header.byteLength, 100, 'The sample database header is truncated');
  assert.equal(
    header.readUInt32BE(96),
    SAMPLE_SQLITE_WRITER_VERSION,
    'The sample database must normalize the informational SQLite writer version',
  );
  const database = openConnection(sampleDatabasePath, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA application_id').get<{ application_id: number }>()?.application_id, 0x4B494F4B);
    assert.equal(
      database.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version,
      CURRENT_SCHEMA_VERSION,
    );
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all<{ version: number }>()
      .map(({ version }) => version);
    assert.deepEqual(
      versions,
      CURRENT_MIGRATION_VERSIONS,
      'The committed sample database must contain exactly the current migration history',
    );
  } finally {
    database.close();
  }
}

async function isolatedEnvironment(root: string): Promise<{ env: NodeJS.ProcessEnv; databasePath: string }> {
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const runtime = path.join(root, 'runtime');
  const emptyBin = path.join(root, 'empty-bin');
  await Promise.all([home, data, runtime, emptyBin].map((directory) => mkdir(directory, { recursive: true })));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: data,
    APPDATA: data,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: data,
    XDG_RUNTIME_DIR: runtime,
    PATH: emptyBin,
    Path: emptyBin,
    KIOKUKO_SKILL_DISCOVERY: 'off',
    NO_COLOR: '1',
  };
  for (const key of ['KIOKUKO_SKILLS_API_URL', 'KIOKUKO_SKILLS_V1_TOKEN']) {
    delete env[key];
  }
  return { env, databasePath: getGlobalDatabasePath({ platform: process.platform, env }) };
}

function migrationVersions(value: unknown): number[] {
  assert.ok(Array.isArray(value), 'setup appliedMigrations must be an array');
  for (const version of value) assert.ok(Number.isSafeInteger(version), 'applied migration versions must be integers');
  return value as number[];
}

async function verifySetup(environment: NodeJS.ProcessEnv, databasePath: string): Promise<void> {
  const setup = await runCliJson(
    ['setup', '--no-standard-skills', '--skill-discovery', 'off', '--json'],
    'setup',
    environment,
  );
  assert.equal(setup.data.databasePath, databasePath);
  const applied = migrationVersions(setup.data.appliedMigrations);
  assert.deepEqual(applied, [], 'setup must not apply migrations to the current sample database');
}

async function verifyDoctor(environment: NodeJS.ProcessEnv): Promise<void> {
  const doctor = await runCliJson(['doctor', '--json'], 'doctor', environment);
  assert.equal(doctor.data.ok, true);
  const currentVersion = doctor.data.currentVersion;
  assert.ok(Number.isSafeInteger(currentVersion));
  assert.equal(currentVersion, CURRENT_SCHEMA_VERSION);
  const checks = objectValue(doctor.data.checks, 'doctor.checks');
  assert.ok(Object.keys(checks).length > 0, 'doctor must return integrity checks');
  for (const [name, value] of Object.entries(checks)) {
    assert.equal(objectValue(value, `doctor.checks.${name}`).ok, true, `doctor check failed: ${name}`);
  }
}

function verifyCurrentMigrationHistory(databasePath: string): void {
  const database = openConnection(databasePath, { readOnly: true });
  try {
    const plan = inspectMigrationSnapshot(database, CURRENT_MIGRATION_SNAPSHOT);
    assert.deepEqual(plan.applied, CURRENT_MIGRATION_VERSIONS);
    assert.deepEqual(plan.pending, []);
    assert.equal(plan.databaseVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(plan.currentVersion, CURRENT_SCHEMA_VERSION);
  } finally {
    database.close();
  }
}

function waitForWebReady(child: WebProcess): Promise<{ url: string; stderr: () => string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => finish(new Error(`kiokuko-ai web did not become ready; stderr=${stderr}`)), 20_000);
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.off('exit', onExit);
      if (error !== undefined) reject(error);
      else resolve({ url: url!, stderr: () => stderr });
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        const envelope = parseCliEnvelope(stdout.slice(0, newline + 1), 'web');
        finish(undefined, stringField(envelope.data, 'url'));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`kiokuko-ai web exited before readiness: code=${String(code)} signal=${String(signal)} stderr=${stderr}`));
    };
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', onStdout);
    child.once('exit', onExit);
  });
}

async function stopWeb(child: WebProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('kiokuko-ai web did not stop after SIGTERM')), 10_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (signal === 'SIGTERM' || code === 0) resolve();
      else reject(new Error(`kiokuko-ai web stopped unexpectedly: code=${String(code)} signal=${String(signal)}`));
    });
  });
}

async function jsonResponse(baseUrl: string, pathname: string, cookie?: string): Promise<Record<string, unknown>> {
  const headers = new Headers();
  if (cookie !== undefined) headers.set('cookie', cookie);
  const response = await fetch(`${baseUrl}${pathname}`, { headers });
  if (response.status !== 200) {
    assert.fail(`${pathname} returned ${response.status}: ${await response.text()}`);
  }
  return objectValue(await response.json() as unknown, pathname);
}

async function verifyWorkspaceEntries(
  baseUrl: string,
  workspace: string,
  expectedTitles: readonly string[],
  cookie: string,
): Promise<Record<string, unknown>[]> {
  const response = await jsonResponse(baseUrl, `/api/entries?workspace=${encodeURIComponent(workspace)}`, cookie);
  const entries = arrayField(response, 'entries').map((entry, index) => objectValue(entry, `entries[${index}]`));
  assert.deepEqual(entries.map((entry) => stringField(entry, 'title')).sort(), [...expectedTitles].sort());
  for (const listed of entries) {
    const entryId = stringField(listed, 'id');
    assert.equal(listed.workspace, workspace);
    const detail = await jsonResponse(
      baseUrl,
      `/api/entries/${encodeURIComponent(entryId)}?workspace=${encodeURIComponent(workspace)}`,
      cookie,
    );
    const stored = objectValue(detail.entry, `entry ${entryId}`);
    assert.equal(stored.id, entryId);
    assert.equal(stored.workspace, workspace);
    assert.equal(stored.title, listed.title);
  }
  return entries;
}

async function verifyWebApi(baseUrl: string): Promise<void> {
  const health = await jsonResponse(baseUrl, '/api/health');
  assert.deepEqual(health, { ok: true });

  const home = await fetch(baseUrl);
  assert.equal(home.status, 200);
  const cookie = home.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie !== undefined && cookie.startsWith('kiokuko_ui_session='), 'Web UI must issue a session cookie');
  assert.match(await home.text(), /<title>Kiokuko Web<\/title>/u);

  const workspaces = await jsonResponse(baseUrl, '/api/workspaces', cookie);
  const workspaceNames = arrayField(workspaces, 'workspaces')
    .map((workspace, index) => stringField(objectValue(workspace, `workspaces[${index}]`), 'workspace'));
  for (const expected of [SAMPLE_PROJECT_WORKSPACE, SAMPLE_GLOBAL_WORKSPACE]) {
    assert.ok(workspaceNames.includes(expected), `Missing Web workspace: ${expected}`);
  }
  assert.equal(
    workspaceNames.includes(SAMPLE_EXTERNAL_SKILL_WORKSPACE),
    false,
    'Managed external-skill workspaces must not appear in the ordinary workspace selector',
  );

  const projectEntries = await verifyWorkspaceEntries(baseUrl, SAMPLE_PROJECT_WORKSPACE, SAMPLE_PROJECT_TITLES, cookie);
  await verifyWorkspaceEntries(baseUrl, SAMPLE_GLOBAL_WORKSPACE, SAMPLE_GLOBAL_TITLES, cookie);
  const unicodeEntry = projectEntries.find((entry) => entry.title === SAMPLE_PROJECT_TITLES[1]);
  assert.equal(unicodeEntry?.body, SAMPLE_PROJECT_UNICODE_BODY);

  const projectTags = await jsonResponse(baseUrl, `/api/tags?workspace=${encodeURIComponent(SAMPLE_PROJECT_WORKSPACE)}`, cookie);
  const fixtureTag = arrayField(projectTags, 'tags')
    .map((tag, index) => objectValue(tag, `tags[${index}]`))
    .find((tag) => tag.tag === 'fixture:ci');
  assert.equal(fixtureTag?.count, SAMPLE_PROJECT_TITLES.length);

  const skills = await jsonResponse(baseUrl, '/api/skills', cookie);
  const skillRows = arrayField(skills, 'skills').map((skill, index) => objectValue(skill, `skills[${index}]`));
  assert.equal(skillRows.length, 1);
  assert.equal(skillRows[0]!.skillId, SAMPLE_EXTERNAL_SKILL_ID);
  assert.equal(skillRows[0]!.state, 'imported');
  assert.equal(skillRows[0]!.sourceWorkspace, SAMPLE_EXTERNAL_SKILL_WORKSPACE);

  const detail = await jsonResponse(baseUrl, `/api/skills/${encodeURIComponent(SAMPLE_EXTERNAL_SKILL_ID)}`, cookie);
  const mappings = arrayField(detail, 'entries').map((entry, index) => objectValue(entry, `skill.entries[${index}]`));
  assert.equal(mappings.length, SAMPLE_EXTERNAL_SKILL_DOCUMENT_COUNT);
  assert.ok(mappings.every((mapping) => mapping.active === true));
  const firstEntryId = stringField(mappings[0]!, 'entryId');
  const externalEntry = await jsonResponse(
    baseUrl,
    `/api/entries/${encodeURIComponent(firstEntryId)}?workspace=${encodeURIComponent(SAMPLE_EXTERNAL_SKILL_WORKSPACE)}`,
    cookie,
  );
  assert.equal(stringField(objectValue(externalEntry.entry, 'external entry'), 'workspace'), SAMPLE_EXTERNAL_SKILL_WORKSPACE);
}

async function verifyWeb(environment: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [cliPath, 'web', '--host', '127.0.0.1', '--port', '0', '--json'], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await waitForWebReady(child);
  let verificationError: unknown;
  try {
    await verifyWebApi(ready.url);
    assert.equal(ready.stderr(), '', 'kiokuko-ai web wrote unexpected stderr');
  } catch (error) {
    verificationError = error;
  }
  try {
    await stopWeb(child);
  } catch (stopError) {
    if (verificationError !== undefined) {
      throw new AggregateError([verificationError, stopError], 'Web verification and shutdown both failed');
    }
    throw stopError;
  }
  if (verificationError !== undefined) throw verificationError;
}

async function main(): Promise<void> {
  await assertCurrentFixture();
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-sampledb-ci-'));
  try {
    const isolated = await isolatedEnvironment(temporaryRoot);
    await mkdir(path.dirname(isolated.databasePath), { recursive: true });
    await copyFile(sampleDatabasePath, isolated.databasePath);
    await chmod(isolated.databasePath, 0o600);
    await verifySetup(isolated.env, isolated.databasePath);
    verifyCurrentMigrationHistory(isolated.databasePath);
    await verifyDoctor(isolated.env);
    await verifyWeb(isolated.env);
    await verifyDoctor(isolated.env);
    process.stdout.write('Fresh-schema sample database and Web API verification passed.\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
