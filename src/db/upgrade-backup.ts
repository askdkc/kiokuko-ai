import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { isWellFormedUnicode } from '../serialization/boundary-json.js';
import type { SqliteSerializationDatabase } from './adapter.js';

function portableDatabaseLabel(databasePath: string): string {
  const basename = path.basename(databasePath);
  const sanitized = basename
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32) || 'file';
  const hash = createHash('sha256').update(basename, 'utf8').digest('hex').slice(0, 16);
  // The fixed `db-` prefix prevents Windows device-name collisions even when
  // the source basename is a valid POSIX name such as CON or NUL.
  return `db-${sanitized}-${hash}`;
}

function backupName(databasePath: string, fromVersion: number, toVersion: number): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  const nonce = randomBytes(8).toString('hex');
  return `${portableDatabaseLabel(databasePath)}.pre-upgrade-v${fromVersion}-to-v${toVersion}-${timestamp}-${nonce}.sqlite3`;
}

interface BackupDirectoryBinding {
  readonly directory: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: bigint;
  readonly group: bigint;
  readonly mode: bigint;
  readonly privateDirectory: boolean;
  readonly handle?: FileHandle;
}

export interface BackupArtifactAttestation {
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: bigint;
  readonly group: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly linkCount: bigint;
  readonly sha256: string;
}

export interface BackupDirectoryAttestation {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: bigint;
  readonly group: bigint;
  readonly mode: bigint;
}

export interface PreMigrationBackup {
  readonly path: string;
  readonly directory: BackupDirectoryAttestation;
  readonly artifact: BackupArtifactAttestation;
}

export interface BackupCreationHooks {
  /** Runs immediately before serializing the already-open source connection. */
  readonly beforeSerialization?: () => void | Promise<void>;
  /** Runs after the backup directory inode is bound, before the backup worker starts. */
  readonly afterDirectoryBound?: () => void | Promise<void>;
  /** Runs with the unpredictable output name before its create-only open. */
  readonly beforeArtifactWrite?: (output: string) => void | Promise<void>;
  /** Runs after the worker attests the artifact, before it is handed to init. */
  readonly afterArtifactWritten?: (output: string) => void | Promise<void>;
}

export interface SerializedBackupCreationHooks extends BackupCreationHooks {
  /** Runs with the canonical output path before source serialization or filesystem mutation. */
  readonly validateDestination?: (output: string) => void | Promise<void>;
}

export interface PosixBackupOpenFlags {
  readonly directory: number;
  readonly noFollow: number;
  readonly nonBlock: number;
}

type BackupOpenFlagConstants = Pick<
  typeof constants,
  'O_DIRECTORY' | 'O_NOFOLLOW' | 'O_NONBLOCK'
>;

/**
 * Resolve the pathname-safety flags as one mandatory POSIX capability. A
 * supported non-Windows runtime must provide every flag; dropping one to zero
 * would silently remove the directory, no-follow, or nonblocking guarantee.
 */
export function requirePosixBackupOpenFlags(
  platform: NodeJS.Platform = process.platform,
  openFlags: Partial<BackupOpenFlagConstants> = constants,
): PosixBackupOpenFlags | undefined {
  if (platform === 'win32') return undefined;
  function required(name: keyof BackupOpenFlagConstants): number {
    const value = openFlags[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        'Required POSIX backup open flags are unavailable',
        { flag: name },
      );
    }
    return value;
  }
  return Object.freeze({
    directory: required('O_DIRECTORY'),
    noFollow: required('O_NOFOLLOW'),
    nonBlock: required('O_NONBLOCK'),
  });
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

async function requireCanonicalDirectoryChain(directory: string): Promise<void> {
  const parsed = path.parse(directory);
  const relative = path.relative(parsed.root, directory);
  let current = parsed.root;
  for (const component of relative.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, component);
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Backup directory path contains a non-directory or symbolic link');
    }
  }
}

async function bindBackupDirectory(
  databasePath: string,
  posixFlags: PosixBackupOpenFlags | undefined,
): Promise<BackupDirectoryBinding> {
  const databaseDirectory = await realpath(path.dirname(databasePath));
  await requireCanonicalDirectoryChain(databaseDirectory);
  const directory = path.join(databaseDirectory, 'backups');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Backup directory must be a non-symbolic-link directory');
  }

  let handle: FileHandle | undefined;
  try {
    if (posixFlags !== undefined) {
      handle = await open(
        directory,
        constants.O_RDONLY | posixFlags.directory | posixFlags.noFollow,
      );
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new KiokukoError('CONFLICT', 'Backup directory changed while it was being opened');
      }
      await handle.chmod(0o700);
    }
    const secured = handle === undefined
      ? await lstat(directory, { bigint: true })
      : await handle.stat({ bigint: true });
    if (!secured.isDirectory() || secured.dev !== before.dev || secured.ino !== before.ino) {
      throw new KiokukoError('CONFLICT', 'Backup directory changed while it was being secured');
    }
    const binding = {
      directory,
      device: secured.dev,
      inode: secured.ino,
      owner: secured.uid,
      group: secured.gid,
      mode: secured.mode,
      privateDirectory: true,
      ...(handle === undefined ? {} : { handle }),
    };
    await requireBackupDirectory(binding);
    return binding;
  } catch (error) {
    if (handle === undefined) throw error;
    const pendingHandle = handle;
    handle = undefined;
    try {
      await pendingHandle.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Backup directory binding failed and closing it also failed',
      );
    }
    throw error;
  }
}

async function bindExistingOutputDirectory(
  destination: string,
  posixFlags: PosixBackupOpenFlags | undefined,
): Promise<BackupDirectoryBinding> {
  const directory = path.dirname(destination);
  await requireCanonicalDirectoryChain(directory);
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Backup output directory must be a non-symbolic-link directory');
  }

  let handle: FileHandle | undefined;
  try {
    if (posixFlags !== undefined) {
      handle = await open(
        directory,
        constants.O_RDONLY | posixFlags.directory | posixFlags.noFollow,
      );
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new KiokukoError('CONFLICT', 'Backup output directory changed while it was being opened');
      }
    }
    const secured = handle === undefined
      ? await lstat(directory, { bigint: true })
      : await handle.stat({ bigint: true });
    if (!secured.isDirectory() || secured.dev !== before.dev || secured.ino !== before.ino) {
      throw new KiokukoError('CONFLICT', 'Backup output directory changed while it was being bound');
    }
    const binding: BackupDirectoryBinding = {
      directory,
      device: secured.dev,
      inode: secured.ino,
      owner: secured.uid,
      group: secured.gid,
      mode: secured.mode,
      privateDirectory: false,
      ...(handle === undefined ? {} : { handle }),
    };
    await requireBackupDirectory(binding);
    return binding;
  } catch (error) {
    if (handle === undefined) throw error;
    const pendingHandle = handle;
    handle = undefined;
    try {
      await pendingHandle.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Backup output directory binding failed and closing it also failed',
      );
    }
    throw error;
  }
}

async function requireBackupDirectory(binding: BackupDirectoryBinding): Promise<void> {
  await requireCanonicalDirectoryChain(path.dirname(binding.directory));
  const status = await lstat(binding.directory, { bigint: true });
  if (!status.isDirectory()
    || status.isSymbolicLink()
    || status.dev !== binding.device
    || status.ino !== binding.inode
    || status.uid !== binding.owner
    || status.gid !== binding.group
    || status.mode !== binding.mode
    || (binding.privateDirectory && process.platform !== 'win32' && (status.mode & 0o777n) !== 0o700n)) {
    throw new KiokukoError('CONFLICT', 'Backup output directory changed during backup creation');
  }
  if (binding.handle !== undefined) {
    const opened = await binding.handle.stat({ bigint: true });
    if (!opened.isDirectory()
      || opened.dev !== binding.device
      || opened.ino !== binding.inode
      || opened.uid !== binding.owner
      || opened.gid !== binding.group
      || opened.mode !== binding.mode
      || (binding.privateDirectory && process.platform !== 'win32' && (opened.mode & 0o777n) !== 0o700n)) {
      throw new KiokukoError('CONFLICT', 'Backup output directory changed during backup creation');
    }
  }
}

const WRITER_DEADLINE_MS = 30_000;
const WRITER_PROTOCOL_LIMIT_BYTES = 64 * 1024;

const BOUND_WRITER_SCRIPT = String.raw`
  const { createHash } = require('node:crypto');
  const {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
    writeFileSync,
  } = require('node:fs');
  const path = require('node:path');

  function plain(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function exact(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
      && actual.every((key, index) => key === expected[index]);
  }

  function unsigned(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new Error('Bound backup request contains an invalid integer');
    }
    return BigInt(value);
  }

  function parseDirectory(value) {
    if (!plain(value) || !exact(value, ['device', 'inode', 'owner', 'group', 'mode'])) {
      throw new Error('Bound backup directory identity is invalid');
    }
    return {
      device: unsigned(value.device),
      inode: unsigned(value.inode),
      owner: unsigned(value.owner),
      group: unsigned(value.group),
      mode: unsigned(value.mode),
    };
  }

  function portableDestination(value) {
    const stem = value.split('.', 1)[0].replace(/[ .]+$/u, '').toUpperCase();
    return !/[<>:"\/\\|?*\u0000-\u001F]/u.test(value)
      && !/[\uD800-\uDFFF]/u.test(value)
      && !/[ .]$/u.test(value)
      && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/u.test(stem);
  }

  function parseRequest() {
    const value = JSON.parse(process.argv[1]);
    if (!plain(value)
      || !exact(value, [
        'destination', 'directory', 'enforcePosixFileMode', 'requirePrivateDirectory', 'sha256', 'size',
      ])
      || typeof value.destination !== 'string'
      || value.destination.length === 0
      || value.destination.includes('\0')
      || value.destination.includes('/')
      || value.destination.includes('\\')
      || value.destination === '.'
      || value.destination === '..'
      || path.basename(value.destination) !== value.destination
      || !portableDestination(value.destination)
      || typeof value.enforcePosixFileMode !== 'boolean'
      || typeof value.requirePrivateDirectory !== 'boolean'
      || typeof value.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.sha256)) {
      throw new Error('Bound backup request is invalid');
    }
    return {
      destination: value.destination,
      directory: parseDirectory(value.directory),
      enforcePosixFileMode: value.enforcePosixFileMode,
      requirePrivateDirectory: value.requirePrivateDirectory,
      sha256: value.sha256,
      size: unsigned(value.size),
    };
  }

  function requireDirectory(request) {
    const status = statSync('.', { bigint: true });
    if (!status.isDirectory()
      || status.dev !== request.directory.device
      || status.ino !== request.directory.inode
      || status.uid !== request.directory.owner
      || status.gid !== request.directory.group
      || status.mode !== request.directory.mode
      || (request.requirePrivateDirectory && (status.mode & 0o777n) !== 0o700n)) {
      throw new Error('Bound backup directory identity changed');
    }
  }

  function requiredOpenFlag(name) {
    const value = constants[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Required POSIX backup open flag is unavailable: ' + name);
    }
    return value;
  }

  function descriptorHash(descriptor, size) {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0n;
    while (offset < size) {
      const length = Number(size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : size - offset);
      const bytesRead = readSync(descriptor, buffer, 0, length, Number(offset));
      if (bytesRead === 0) throw new Error('Bound backup output was truncated');
      hash.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    return hash.digest('hex');
  }

  function serializedError(error) {
    return {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : 'Bound backup writer failed',
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    };
  }

  let descriptor;
  let result;
  let failure;
  try {
    const request = parseRequest();
    const bytes = readFileSync(0);
    if (BigInt(bytes.length) !== request.size
      || createHash('sha256').update(bytes).digest('hex') !== request.sha256) {
      throw new Error('Bound backup input bytes do not match their attestation');
    }
    requireDirectory(request);
    const noFollow = request.enforcePosixFileMode ? requiredOpenFlag('O_NOFOLLOW') : 0;
    descriptor = openSync(
      request.destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
        | noFollow,
      0o600,
    );
    if (request.enforcePosixFileMode) fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.size !== request.size
      || opened.nlink !== 1n
      || (request.enforcePosixFileMode && (opened.mode & 0o777n) !== 0o600n)
      || descriptorHash(descriptor, opened.size) !== request.sha256) {
      throw new Error('Bound backup output failed descriptor attestation');
    }
    closeSync(descriptor);
    descriptor = undefined;
    const named = lstatSync(request.destination, { bigint: true });
    if (!named.isFile()
      || named.isSymbolicLink()
      || named.dev !== opened.dev
      || named.ino !== opened.ino
      || named.uid !== opened.uid
      || named.gid !== opened.gid
      || named.mode !== opened.mode
      || named.size !== opened.size
      || named.nlink !== opened.nlink) {
      throw new Error('Bound backup output changed before handoff');
    }
    requireDirectory(request);
    result = {
      ok: true,
      artifact: {
        device: opened.dev.toString(),
        inode: opened.ino.toString(),
        owner: opened.uid.toString(),
        group: opened.gid.toString(),
        mode: opened.mode.toString(),
        size: opened.size.toString(),
        linkCount: opened.nlink.toString(),
        sha256: request.sha256,
      },
    };
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (closeError) {
      failure = failure === undefined
        ? closeError
        : new AggregateError([failure, closeError], 'Bound backup write and descriptor close both failed');
    }
  }
  if (failure !== undefined) result = { ok: false, error: serializedError(failure) };
  process.stdout.write(JSON.stringify(result));
`;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedSerializedSnapshot(database: SqliteSerializationDatabase): Buffer {
  const serialized = Buffer.from(database.serializeDatabase());
  if (serialized.length < 100
    || !serialized.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'binary'))
    || !((serialized[18] === 1 && serialized[19] === 1)
      || (serialized[18] === 2 && serialized[19] === 2))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Serialized SQLite backup has an invalid file header');
  }

  // sqlite3_serialize preserves the WAL read/write header bytes. The serialized
  // image already contains the connection's complete logical snapshot, so set
  // the standalone image to rollback-journal format before deserializing it.
  serialized[18] = 1;
  serialized[19] = 1;
  const verification = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  let failed = false;
  let operationError: unknown;
  try {
    const methods = verification as DatabaseSync & {
      deserialize?: (bytes: Uint8Array) => void;
      serialize?: () => Uint8Array;
    };
    if (typeof methods.deserialize !== 'function' || typeof methods.serialize !== 'function') {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        'SQLite serialization requires Node.js 24.16.0 or newer; upgrade Node.js before backing up this database',
      );
    }
    methods.deserialize(serialized);
    const integrity = verification.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        'SQLite integrity check failed; the source database was not changed and must be preserved for recovery',
      );
    }
    if (verification.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        'SQLite foreign-key integrity check failed; the source database was not changed and must be preserved for recovery',
      );
    }
    const normalized = Buffer.from(methods.serialize());
    if (normalized.length < 100 || normalized[18] !== 1 || normalized[19] !== 1) {
      throw new Error('Serialized SQLite backup did not normalize to a standalone image');
    }
    return normalized;
  } catch (error) {
    failed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      verification.close();
    } catch (closeError) {
      if (failed) {
        throw new AggregateError(
          [operationError, closeError],
          'Serialized backup verification failed and closing it also failed',
        );
      }
      throw closeError;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseUnsigned(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error('Bound backup writer returned an invalid integer');
  }
  return BigInt(value);
}

function writeBoundArtifact(
  binding: BackupDirectoryBinding,
  fileName: string,
  bytes: Buffer,
  posixFlags: PosixBackupOpenFlags | undefined,
): BackupArtifactAttestation {
  const request = {
    destination: fileName,
    directory: {
      device: binding.device.toString(),
      inode: binding.inode.toString(),
      owner: binding.owner.toString(),
      group: binding.group.toString(),
      mode: binding.mode.toString(),
    },
    enforcePosixFileMode: posixFlags !== undefined,
    requirePrivateDirectory: binding.privateDirectory && posixFlags !== undefined,
    sha256: sha256(bytes),
    size: bytes.length.toString(),
  };
  const child = spawnSync(
    process.execPath,
    ['--input-type=commonjs', '--eval', BOUND_WRITER_SCRIPT, JSON.stringify(request)],
    {
      cwd: binding.directory,
      // The worker uses only built-in modules and an absolute executable path.
      // Do not inherit preload, loader, search-path, or application environment.
      env: {},
      shell: false,
      input: bytes,
      timeout: WRITER_DEADLINE_MS,
      maxBuffer: WRITER_PROTOCOL_LIMIT_BYTES,
    },
  );
  if (child.error !== undefined) throw child.error;
  if (child.status !== 0 || child.signal !== null) {
    throw new Error('Bound backup writer subprocess failed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(child.stdout.toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Bound backup writer returned invalid JSON');
    throw error;
  }
  if (!isPlainObject(parsed) || typeof parsed.ok !== 'boolean') {
    throw new Error('Bound backup writer returned an invalid result');
  }
  if (!parsed.ok) {
    if (!exactKeys(parsed, ['error', 'ok']) || !isPlainObject(parsed.error)
      || !Object.hasOwn(parsed.error, 'name')
      || !Object.hasOwn(parsed.error, 'message')
      || Object.keys(parsed.error).some((key) => !['code', 'message', 'name'].includes(key))
      || typeof parsed.error.name !== 'string'
      || typeof parsed.error.message !== 'string'
      || (Object.hasOwn(parsed.error, 'code') && typeof parsed.error.code !== 'string')) {
      throw new Error('Bound backup writer returned an invalid result');
    }
    if (parsed.error.code === 'EEXIST') {
      throw new KiokukoError('CONFLICT', 'Backup destination already exists');
    }
    throw Object.assign(new Error(parsed.error.message), {
      name: parsed.error.name,
      ...(typeof parsed.error.code === 'string' ? { code: parsed.error.code } : {}),
    });
  }
  if (!exactKeys(parsed, ['artifact', 'ok']) || !isPlainObject(parsed.artifact)
    || !exactKeys(parsed.artifact, [
      'device', 'group', 'inode', 'linkCount', 'mode', 'owner', 'sha256', 'size',
    ])
    || typeof parsed.artifact.sha256 !== 'string'
    || parsed.artifact.sha256 !== request.sha256) {
    throw new Error('Bound backup writer returned an invalid artifact attestation');
  }
  const attestation = Object.freeze({
    device: parseUnsigned(parsed.artifact.device),
    inode: parseUnsigned(parsed.artifact.inode),
    owner: parseUnsigned(parsed.artifact.owner),
    group: parseUnsigned(parsed.artifact.group),
    mode: parseUnsigned(parsed.artifact.mode),
    size: parseUnsigned(parsed.artifact.size),
    linkCount: parseUnsigned(parsed.artifact.linkCount),
    sha256: parsed.artifact.sha256,
  });
  if (attestation.size !== BigInt(bytes.length)
    || attestation.linkCount !== 1n
    || (process.platform !== 'win32' && (attestation.mode & 0o777n) !== 0o600n)) {
    throw new Error('Bound backup writer returned an invalid artifact attestation');
  }
  return attestation;
}

async function descriptorSha256(handle: FileHandle, size: bigint): Promise<string> {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Serialized backup artifact size is unsupported');
  }
  const expectedLength = Number(size);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < expectedLength) {
    const length = Math.min(buffer.length, expectedLength - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead === 0) {
      throw new KiokukoError('CONFLICT', 'Serialized backup artifact changed during verification');
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

function sameArtifactStatus(
  status: Awaited<ReturnType<FileHandle['stat']>>,
  attestation: BackupArtifactAttestation,
): boolean {
  return status.isFile()
    && status.dev === attestation.device
    && status.ino === attestation.inode
    && status.uid === attestation.owner
    && status.gid === attestation.group
    && status.mode === attestation.mode
    && status.size === attestation.size
    && status.nlink === attestation.linkCount
    && status.size > 0n
    && status.nlink === 1n
    && (process.platform === 'win32' || (status.mode & 0o777n) === 0o600n);
}

async function requireBoundArtifact(
  output: string,
  attestation: BackupArtifactAttestation,
  posixFlags: PosixBackupOpenFlags | undefined,
): Promise<void> {
  let handle: FileHandle | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    handle = await open(
      output,
      posixFlags === undefined
        ? constants.O_RDONLY
        : constants.O_RDONLY | posixFlags.noFollow | posixFlags.nonBlock,
    );
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(output, { bigint: true });
    if (!sameArtifactStatus(opened, attestation)
      || !named.isFile()
      || named.isSymbolicLink()
      || named.dev !== opened.dev
      || named.ino !== opened.ino
      || named.uid !== opened.uid
      || named.gid !== opened.gid
      || named.mode !== opened.mode
      || named.size !== opened.size
      || named.nlink !== opened.nlink
      || await descriptorSha256(handle, opened.size) !== attestation.sha256) {
      throw new KiokukoError('CONFLICT', 'Serialized backup artifact changed before parent verification');
    }
    const after = await handle.stat({ bigint: true });
    if (!sameArtifactStatus(after, attestation)) {
      throw new KiokukoError('CONFLICT', 'Serialized backup artifact changed during parent verification');
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        if (operationFailed) {
          throw new AggregateError(
            [operationError, closeError],
            'Serialized backup verification failed and closing its descriptor also failed',
          );
        }
        throw closeError;
      }
    }
  }
}

function directoryAttestation(binding: BackupDirectoryBinding): BackupDirectoryAttestation {
  return Object.freeze({
    path: binding.directory,
    device: binding.device,
    inode: binding.inode,
    owner: binding.owner,
    group: binding.group,
    mode: binding.mode,
  });
}

async function normalizedDestination(destination: string): Promise<{ output: string; fileName: string }> {
  if (typeof destination !== 'string'
    || destination.length === 0
    || destination.includes('\0')
    || !isWellFormedUnicode(destination)
    || /[\\/]$/u.test(destination)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Backup destination must be a non-empty pathname');
  }
  const requestedOutput = path.resolve(destination);
  const fileName = path.basename(requestedOutput);
  const portableStem = fileName.split('.', 1)[0]?.replace(/[ .]+$/u, '').toUpperCase();
  if (fileName.length === 0
    || fileName === '.'
    || fileName === '..'
    || /[<>:"\/\\|?*\u0000-\u001F]/u.test(fileName)
    || /[ .]$/u.test(fileName)
    || portableStem === undefined
    || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/u.test(portableStem)) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'Backup destination must name one portable standalone file',
    );
  }
  const directory = await realpath(path.dirname(requestedOutput));
  await requireCanonicalDirectoryChain(directory);
  return { output: path.join(directory, fileName), fileName };
}

async function syncBackupDirectory(binding: BackupDirectoryBinding): Promise<void> {
  if (process.platform !== 'win32' && binding.handle !== undefined) {
    await binding.handle.sync();
  }
}

/**
 * Serialize the exact already-open source and install one create-only backup.
 * The output directory must already exist and is never chmodded by this path.
 */
export async function createSerializedBackupArtifact(
  database: SqliteSerializationDatabase,
  destination: string,
  hooks: SerializedBackupCreationHooks = {},
): Promise<PreMigrationBackup> {
  const posixFlags = requirePosixBackupOpenFlags();
  const { output, fileName } = await normalizedDestination(destination);
  await hooks.validateDestination?.(output);
  let directoryBinding: BackupDirectoryBinding | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    await hooks.beforeSerialization?.();
    const bytes = normalizedSerializedSnapshot(database);
    directoryBinding = await bindExistingOutputDirectory(output, posixFlags);
    await hooks.afterDirectoryBound?.();
    await hooks.beforeArtifactWrite?.(output);
    const artifact = writeBoundArtifact(directoryBinding, fileName, bytes, posixFlags);
    await requireBoundArtifact(output, artifact, posixFlags);
    await hooks.afterArtifactWritten?.(output);
    await requireBoundArtifact(output, artifact, posixFlags);
    await requireBackupDirectory(directoryBinding);
    await syncBackupDirectory(directoryBinding);
    return Object.freeze({
      path: output,
      directory: directoryAttestation(directoryBinding),
      artifact,
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    if (directoryBinding?.handle !== undefined) {
      try {
        await directoryBinding.handle.close();
      } catch (closeError) {
        if (operationFailed) {
          throw new AggregateError(
            [operationError, closeError],
            'Serialized backup creation failed and closing its directory also failed',
          );
        }
        throw closeError;
      }
    }
  }
}

export async function createPreMigrationBackup(
  database: SqliteSerializationDatabase,
  databasePath: string,
  fromVersion: number,
  toVersion: number,
  hooks: BackupCreationHooks = {},
): Promise<PreMigrationBackup> {
  const posixFlags = requirePosixBackupOpenFlags();
  let directoryBinding: BackupDirectoryBinding | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    await hooks.beforeSerialization?.();
    const bytes = normalizedSerializedSnapshot(database);
    directoryBinding = await bindBackupDirectory(databasePath, posixFlags);
    const fileName = backupName(databasePath, fromVersion, toVersion);
    const output = path.join(directoryBinding.directory, fileName);
    await hooks.afterDirectoryBound?.();
    await hooks.beforeArtifactWrite?.(output);
    const artifact = writeBoundArtifact(directoryBinding, fileName, bytes, posixFlags);
    await requireBoundArtifact(output, artifact, posixFlags);
    await hooks.afterArtifactWritten?.(output);
    await requireBoundArtifact(output, artifact, posixFlags);
    await requireBackupDirectory(directoryBinding);
    await syncBackupDirectory(directoryBinding);
    return Object.freeze({
      path: output,
      directory: directoryAttestation(directoryBinding),
      artifact,
    });
  } catch (error) {
    const failure = new KiokukoError(
      'DATABASE_ERROR',
      'Could not create and verify the pre-migration backup; the database was not migrated',
    );
    Object.defineProperty(failure, 'cause', { value: error });
    operationFailed = true;
    operationError = failure;
    throw failure;
  } finally {
    if (directoryBinding?.handle !== undefined) {
      try {
        await directoryBinding.handle.close();
      } catch (closeError) {
        if (operationFailed) {
          throw new AggregateError(
            [operationError, closeError],
            'Pre-migration backup failed and closing its directory also failed',
          );
        }
        throw closeError;
      }
    }
  }
}
