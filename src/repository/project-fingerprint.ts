import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import type { JsonObject } from '../ledger/types.js';
import type { ResolvedProjectWorkspace } from '../memory/workspaces.js';
import { canonicalJson, compareCanonicalStrings } from '../serialization/validate.js';
import { parseStrictJson } from '../setup/strict-json.js';

export interface ProjectFingerprint {
  repositoryId: string;
  languages: string[];
  frameworks: Array<{ name: string; version?: string }>;
  databases: string[];
  runtimes: string[];
  tools: string[];
  packages: Array<{ name: string; version?: string }>;
  manifestDigest: string;
}

interface CapturedManifest {
  name: string;
  content: Buffer;
}

interface Manifest {
  name: string;
  text: string;
  value: Record<string, unknown> | null;
}

export interface ProjectManifestSnapshot {
  readonly repositoryId: string;
  readonly manifestDigest: string;
}

interface CapturedSnapshot {
  repositoryRoot: string;
  manifests: CapturedManifest[];
}

const FINGERPRINT_FIELDS = new Set([
  'repositoryId', 'languages', 'frameworks', 'databases', 'runtimes', 'tools', 'packages', 'manifestDigest',
]);
const VERSIONED_VALUE_FIELDS = new Set(['name', 'version']);
const MAX_STRING_VALUES = 1_000;
const MAX_PACKAGES = 10_000;
const MAX_VALUE_LENGTH = 500;
const MAX_VERSION_LENGTH = 200;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_MANIFEST_BYTES = 8 * 1024 * 1024;
const SUPPORTED_MANIFESTS = ['composer.json', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml'] as const;
const MANIFEST_SNAPSHOT_FIELDS = new Set(['repositoryId', 'manifestDigest']);
const PROJECT_MANIFEST_BINDING_FIELDS = new Set(['version', 'repositoryId', 'manifestDigest']);
const CAPTURED_SNAPSHOTS = new WeakMap<ProjectManifestSnapshot, CapturedSnapshot>();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const PROJECT_MANIFEST_BINDING_METADATA_KEY = 'kiokukoProjectManifestBinding' as const;
export const PROJECT_MANIFEST_BINDING_VERSION = 1 as const;

function cacheIntegrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Cached project fingerprint is invalid');
}

function manifestValidation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Supported project manifest is invalid');
}

function manifestSecurity(): never {
  throw new KiokukoError('SECURITY_REJECTION', 'Supported project manifest must be a regular repository file');
}

function manifestChanged(): never {
  throw new KiokukoError('CONFLICT', 'Supported project manifest changed while it was captured');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, maxLength = MAX_VALUE_LENGTH): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function stringArray(value: unknown, maxItems = MAX_STRING_VALUES): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => boundedString(item))
    && new Set(value).size === value.length;
}

function versionedValues(value: unknown, maxItems: number): value is Array<{ name: string; version?: string }> {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  const names = new Set<string>();
  for (const item of value) {
    if (!plainObject(item)
      || Object.keys(item).some((key) => !VERSIONED_VALUE_FIELDS.has(key))
      || !Object.hasOwn(item, 'name')
      || !boundedString(item.name)
      || (Object.hasOwn(item, 'version') && !boundedString(item.version, MAX_VERSION_LENGTH))
      || names.has(item.name)) return false;
    names.add(item.name);
  }
  return true;
}

function validateFingerprint(value: unknown, repositoryId: string, manifestDigest: string, invalid: () => never): ProjectFingerprint {
  if (!plainObject(value)
    || Object.keys(value).length !== FINGERPRINT_FIELDS.size
    || Object.keys(value).some((key) => !FINGERPRINT_FIELDS.has(key))
    || value.repositoryId !== repositoryId
    || value.manifestDigest !== manifestDigest
    || !/^[0-9a-f]{64}$/u.test(manifestDigest)
    || !boundedString(value.repositoryId, 256)
    || !stringArray(value.languages)
    || !versionedValues(value.frameworks, MAX_STRING_VALUES)
    || !stringArray(value.databases)
    || !stringArray(value.runtimes)
    || !stringArray(value.tools)
    || !versionedValues(value.packages, MAX_PACKAGES)) invalid();
  return value as unknown as ProjectFingerprint;
}

function parseCachedFingerprint(value: string, current: ProjectFingerprint): ProjectFingerprint {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(
      value,
      { allowTrailingComma: false, disallowComments: true },
      'Cached project fingerprint is invalid',
    );
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') cacheIntegrity();
    throw error;
  }
  const fingerprint = validateFingerprint(parsed, current.repositoryId, current.manifestDigest, cacheIntegrity);
  if (canonicalJson(fingerprint) !== canonicalJson(current)) cacheIntegrity();
  return fingerprint;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort(compareCanonicalStrings);
}

function versionOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const match = value.match(/\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/u);
  return match?.[0];
}

function dependencies(value: Record<string, unknown> | null): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  for (const section of ['require', 'require-dev', 'dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const input = value?.[section];
    if (input === undefined) continue;
    if (!plainObject(input)) manifestValidation();
    for (const [name, version] of Object.entries(input)) {
      if (!boundedString(name) || typeof version !== 'string' || version.trim().length === 0 || version.length > MAX_VALUE_LENGTH
        || /[\u0000-\u001f\u007f]/u.test(version)) manifestValidation();
      result.set(name, versionOf(version));
    }
  }
  return result;
}

function sameManifestIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

function sameManifestState(left: BigIntStats, right: BigIntStats): boolean {
  return sameManifestIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function captureManifest(root: string, name: string, remainingBytes: number): CapturedManifest | undefined {
  const filePath = path.join(root, name);
  let planned: BigIntStats;
  try {
    planned = lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (planned.isSymbolicLink()) manifestSecurity();
  if (!planned.isFile() || planned.ino === 0n) manifestSecurity();
  if (planned.size < 0n
    || planned.size > BigInt(MAX_MANIFEST_BYTES)
    || planned.size > BigInt(remainingBytes)
    || planned.size > BigInt(Number.MAX_SAFE_INTEGER)) manifestValidation();

  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let descriptor: number;
  try {
    descriptor = openSync(filePath, flags);
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined;
    if (code === 'ELOOP' || code === 'EMLINK') manifestSecurity();
    if (code === 'ENOENT') manifestChanged();
    throw error;
  }

  let captured: CapturedManifest | undefined;
  let operationError: unknown;
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameManifestState(planned, before)) manifestChanged();
    if (before.size > BigInt(MAX_MANIFEST_BYTES)
      || before.size > BigInt(remainingBytes)
      || before.size > BigInt(Number.MAX_SAFE_INTEGER)) manifestValidation();
    const content = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < content.byteLength) {
      const bytesRead = readSync(descriptor, content, offset, content.byteLength - offset, offset);
      if (bytesRead === 0) manifestChanged();
      offset += bytesRead;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameManifestState(before, after)) manifestChanged();
    let finalPath: BigIntStats;
    try {
      finalPath = lstatSync(filePath, { bigint: true });
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') manifestChanged();
      throw error;
    }
    if (finalPath.isSymbolicLink() || !finalPath.isFile() || !sameManifestState(after, finalPath)) manifestChanged();
    captured = { name, content };
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined) {
    if (closeError !== undefined) {
      throw new AggregateError([operationError, closeError], 'Project manifest capture and descriptor close both failed');
    }
    throw operationError;
  }
  if (closeError !== undefined) throw closeError;
  if (captured === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Project manifest capture produced no result');
  return captured;
}

function digestManifests(manifests: readonly CapturedManifest[]): string {
  const digest = createHash('sha256');
  manifests.forEach((manifest, index) => {
    if (index > 0) digest.update('\u0001', 'utf8');
    digest.update(manifest.name, 'utf8');
    digest.update('\u0000', 'utf8');
    digest.update(manifest.content);
  });
  return digest.digest('hex');
}

function capturedSnapshot(
  snapshot: ProjectManifestSnapshot,
  project?: Pick<ResolvedProjectWorkspace, 'repositoryId' | 'repositoryRoot'>,
): CapturedSnapshot {
  if (!plainObject(snapshot)
    || Object.keys(snapshot).length !== MANIFEST_SNAPSHOT_FIELDS.size
    || Object.keys(snapshot).some((key) => !MANIFEST_SNAPSHOT_FIELDS.has(key))
    || typeof snapshot.repositoryId !== 'string'
    || typeof snapshot.manifestDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(snapshot.manifestDigest)
    || (project !== undefined && snapshot.repositoryId !== project.repositoryId)) manifestValidation();
  const captured = CAPTURED_SNAPSHOTS.get(snapshot);
  if (captured === undefined
    || (project !== undefined && captured.repositoryRoot !== project.repositoryRoot)
    || digestManifests(captured.manifests) !== snapshot.manifestDigest) manifestValidation();
  return captured;
}

function parseCapturedManifest(manifest: CapturedManifest): Manifest {
  let text: string;
  try {
    text = UTF8_DECODER.decode(manifest.content);
  } catch {
    manifestValidation();
  }
  let value: Record<string, unknown> | null = null;
  if (manifest.name.endsWith('.json')) {
    const parsed = parseStrictJson(
      text,
      { allowTrailingComma: false, disallowComments: true },
      'Supported project manifest is invalid',
    );
    if (!plainObject(parsed)) manifestValidation();
    value = parsed;
  }
  return { name: manifest.name, text, value };
}

function addDependencyPackages(packages: Array<{ name: string; version?: string }>, input: Map<string, string | undefined>): void {
  for (const [name, version] of input) packages.push({ name, ...(version === undefined ? {} : { version }) });
}

function addFrameworks(frameworks: Array<{ name: string; version?: string }>, input: Map<string, string | undefined>, mappings: Array<[string, string]>): void {
  for (const [packageName, frameworkName] of mappings) {
    const version = input.get(packageName);
    if (version !== undefined || input.has(packageName)) frameworks.push({ name: frameworkName, ...(version === undefined ? {} : { version }) });
  }
}

function rawFingerprint(repositoryId: string, manifests: Manifest[], manifestDigest: string): ProjectFingerprint {
  const languages: string[] = [];
  const frameworks: Array<{ name: string; version?: string }> = [];
  const databases: string[] = [];
  const runtimes: string[] = [];
  const tools: string[] = [];
  const packages: Array<{ name: string; version?: string }> = [];
  for (const manifest of manifests) {
    const deps = dependencies(manifest.value);
    if (manifest.name === 'composer.json') {
      languages.push('PHP'); runtimes.push('PHP');
      addDependencyPackages(packages, deps);
      addFrameworks(frameworks, deps, [['laravel/framework', 'Laravel'], ['symfony/framework-bundle', 'Symfony'], ['symfony/symfony', 'Symfony']]);
      if (deps.has('doctrine/dbal')) tools.push('Doctrine DBAL');
    } else if (manifest.name === 'package.json') {
      languages.push('JavaScript'); runtimes.push('Node.js');
      addDependencyPackages(packages, deps);
      addFrameworks(frameworks, deps, [
        ['svelte', 'Svelte'], ['@sveltejs/kit', 'SvelteKit'], ['react', 'React'], ['next', 'Next.js'],
        ['vue', 'Vue'], ['nuxt', 'Nuxt'], ['vite', 'Vite'], ['tailwindcss', 'Tailwind CSS'],
      ]);
      if (deps.has('typescript')) { languages.push('TypeScript'); tools.push('TypeScript'); }
      if (deps.has('vite')) tools.push('Vite');
      if (deps.has('pg')) databases.push('PostgreSQL');
      if (deps.has('mysql2')) databases.push('MySQL');
      if (deps.has('sqlite3') || deps.has('better-sqlite3')) databases.push('SQLite');
    } else if (manifest.name === 'go.mod') {
      languages.push('Go'); runtimes.push('Go');
      const moduleLines = manifest.text.split(/\r?\n/u);
      if (moduleLines.some((line) => /jackc\/pgx|lib\/pq/iu.test(line))) databases.push('PostgreSQL');
    } else if (manifest.name === 'Cargo.toml') {
      languages.push('Rust'); runtimes.push('Rust');
    } else if (manifest.name === 'pyproject.toml') {
      languages.push('Python'); runtimes.push('Python');
      if (/django/iu.test(manifest.text)) frameworks.push({ name: 'Django' });
      if (/postgres|psycopg/iu.test(manifest.text)) databases.push('PostgreSQL');
    }
  }
  const dedupedFrameworks = [...new Map(frameworks.map((item) => [item.name, item])).values()]
    .sort((left, right) => compareCanonicalStrings(left.name, right.name));
  return {
    repositoryId,
    languages: unique(languages),
    frameworks: dedupedFrameworks,
    databases: unique(databases),
    runtimes: unique(runtimes),
    tools: unique(tools),
    packages: [...new Map(packages.map((item) => [item.name, item])).values()].sort((left, right) => compareCanonicalStrings(left.name, right.name)),
    manifestDigest,
  };
}

export function captureProjectManifestSnapshot(
  project: Pick<ResolvedProjectWorkspace, 'repositoryId' | 'repositoryRoot'>,
): ProjectManifestSnapshot {
  const manifests: CapturedManifest[] = [];
  let remainingBytes = MAX_TOTAL_MANIFEST_BYTES;
  for (const name of SUPPORTED_MANIFESTS) {
    const manifest = captureManifest(project.repositoryRoot, name, remainingBytes);
    if (manifest === undefined) continue;
    manifests.push(manifest);
    remainingBytes -= manifest.content.byteLength;
  }
  const snapshot = Object.freeze({
    repositoryId: project.repositoryId,
    manifestDigest: digestManifests(manifests),
  });
  CAPTURED_SNAPSHOTS.set(snapshot, { repositoryRoot: project.repositoryRoot, manifests });
  return snapshot;
}

function fingerprintFromCaptured(snapshot: ProjectManifestSnapshot, captured: CapturedSnapshot): ProjectFingerprint {
  const manifests = captured.manifests.map(parseCapturedManifest);
  const fingerprint = rawFingerprint(snapshot.repositoryId, manifests, snapshot.manifestDigest);
  return validateFingerprint(fingerprint, snapshot.repositoryId, fingerprint.manifestDigest, manifestValidation);
}

export function computeProjectFingerprint(snapshot: ProjectManifestSnapshot): ProjectFingerprint {
  return fingerprintFromCaptured(snapshot, capturedSnapshot(snapshot));
}

export function bindProjectManifestSnapshot(
  metadata: JsonObject,
  project: Pick<ResolvedProjectWorkspace, 'repositoryId' | 'repositoryRoot'>,
  snapshot: ProjectManifestSnapshot,
): JsonObject {
  capturedSnapshot(snapshot, project);
  if (Object.hasOwn(metadata, PROJECT_MANIFEST_BINDING_METADATA_KEY)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Run metadata contains a reserved project manifest binding');
  }
  return {
    ...metadata,
    [PROJECT_MANIFEST_BINDING_METADATA_KEY]: {
      version: PROJECT_MANIFEST_BINDING_VERSION,
      repositoryId: snapshot.repositoryId,
      manifestDigest: snapshot.manifestDigest,
    },
  };
}

export function assertProjectManifestSnapshotBinding(
  metadata: JsonObject,
  project: Pick<ResolvedProjectWorkspace, 'repositoryId' | 'repositoryRoot'>,
  snapshot: ProjectManifestSnapshot,
): void {
  capturedSnapshot(snapshot, project);
  const binding = metadata[PROJECT_MANIFEST_BINDING_METADATA_KEY];
  if (!plainObject(binding)
    || Object.keys(binding).length !== PROJECT_MANIFEST_BINDING_FIELDS.size
    || Object.keys(binding).some((key) => !PROJECT_MANIFEST_BINDING_FIELDS.has(key))
    || binding.version !== PROJECT_MANIFEST_BINDING_VERSION
    || !boundedString(binding.repositoryId, 256)
    || typeof binding.manifestDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(binding.manifestDigest)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Run project manifest binding is missing or invalid');
  }
  if (binding.repositoryId !== snapshot.repositoryId || binding.manifestDigest !== snapshot.manifestDigest) {
    throw new KiokukoError('CONFLICT', 'Project manifest differs from the snapshot bound when the run was opened');
  }
}

export function resolveProjectFingerprint(
  database: SqliteDatabase,
  project: ResolvedProjectWorkspace,
  snapshot: ProjectManifestSnapshot,
  options: { readOnly?: boolean } = {},
): ProjectFingerprint {
  const current = fingerprintFromCaptured(snapshot, capturedSnapshot(snapshot, project));
  const cached = database.prepare('SELECT fingerprint_json, manifest_digest FROM repository_fingerprints WHERE repository_id = ?').get<{ fingerprint_json: string; manifest_digest: string }>(project.repositoryId);
  if (cached !== undefined && !/^[0-9a-f]{64}$/u.test(cached.manifest_digest)) cacheIntegrity();
  if (cached?.manifest_digest === current.manifestDigest) {
    return parseCachedFingerprint(cached.fingerprint_json, current);
  }
  if (options.readOnly === true) return current;
  database.prepare(`
    INSERT INTO repository_fingerprints (repository_id, fingerprint_json, manifest_digest, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET fingerprint_json = excluded.fingerprint_json, manifest_digest = excluded.manifest_digest, updated_at = excluded.updated_at
  `).run(project.repositoryId, JSON.stringify(current), current.manifestDigest, new Date().toISOString());
  return current;
}
