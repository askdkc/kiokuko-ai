import { constants, type BigIntStats } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { KiokukoError } from '../errors.js';

export interface FileIdentity {
  device: bigint;
  inode: bigint;
}

export interface RegularFileSnapshot {
  content: string;
  mode: number;
  identity: FileIdentity;
}

interface BoundRegularArtifact {
  snapshot: RegularFileSnapshot;
  linkCount: bigint;
}

interface BoundDirectory {
  directoryPath: string;
  identity: FileIdentity;
}

export interface FileExpectation {
  expected: RegularFileSnapshot | undefined;
  /** Paths whose absence is part of the same decision (for example an alternate config path). */
  mustRemainAbsent?: readonly string[];
  /** Reject every symbolic-link component below this already-resolved root. */
  containmentRoot?: string;
  /** When present, the parent must preexist and retain this exact directory identity. */
  expectedParentDirectory?: FileIdentity;
}

export class AtomicCleanupFailure extends Error {
  constructor(
    /** Exact pathname of the owned artifact, when its full binding was proven after the failure. */
    readonly artifactPath: string | undefined,
    options: { cause: unknown },
  ) {
    super('Atomic artifact cleanup failed or could not be proven complete', options);
    this.name = 'AtomicCleanupFailure';
  }
}

export interface AtomicWriteResult {
  installed: RegularFileSnapshot;
  cleanupFailures: readonly AtomicCleanupFailure[];
}

export interface AtomicUnlinkResult {
  cleanupFailures: readonly AtomicCleanupFailure[];
}

export class AtomicCommittedMutationError extends AggregateError {
  constructor(
    readonly outcome: AtomicWriteResult,
    readonly operationError: unknown,
  ) {
    super(
      [operationError, ...outcome.cleanupFailures],
      'File target committed before post-install validation failed',
    );
    this.name = 'AtomicCommittedMutationError';
  }
}

export class AtomicCommittedUnlinkError extends AggregateError {
  constructor(
    readonly outcome: AtomicUnlinkResult,
    readonly operationError: unknown,
  ) {
    super(
      [operationError, ...outcome.cleanupFailures],
      'File target was quarantined before post-unlink validation failed',
    );
    this.name = 'AtomicCommittedUnlinkError';
  }
}

export function assertAtomicCleanupComplete(
  result: Pick<AtomicWriteResult | AtomicUnlinkResult, 'cleanupFailures'>,
): void {
  if (result.cleanupFailures.length === 0) return;
  throw new AggregateError(
    result.cleanupFailures,
    'File mutation committed, but committed-artifact cleanup failed',
  );
}

export interface AtomicWriteDependencies {
  chmod?: typeof chmod;
  beforeLink?: (source: string, destination: string) => void | Promise<void>;
  afterLink?: (source: string, destination: string) => void | Promise<void>;
  beforeRename?: (source: string, destination: string) => void | Promise<void>;
  afterRename?: (source: string, destination: string) => void | Promise<void>;
  beforeCleanup?: (artifactPath: string) => void | Promise<void>;
  beforeCommit?: (filePath: string) => void | Promise<void>;
  afterQuarantine?: (filePath: string) => void | Promise<void>;
  afterInstall?: (filePath: string) => void | Promise<void>;
}

export interface ReadRegularFileDependencies {
  /** Test seam for proving that reads remain bound to the opened descriptor. */
  afterOpen?: (filePath: string, handle: FileHandle) => void | Promise<void>;
  /** Test seam for preserving an operation failure when descriptor close also fails. */
  closeHandle?: (handle: FileHandle) => Promise<void>;
  /** Test seam for exercising the Windows no-O_NOFOLLOW strategy on any host. */
  platform?: NodeJS.Platform;
}

export interface ConditionalUnlinkDependencies {
  beforeRename?: (source: string, destination: string) => void | Promise<void>;
  afterRename?: (source: string, destination: string) => void | Promise<void>;
  beforeCleanup?: (artifactPath: string) => void | Promise<void>;
  beforeCommit?: (filePath: string) => void | Promise<void>;
}

function errno(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isMissingFile(error: unknown): boolean {
  return errno(error) === 'ENOENT';
}

function isSymlinkFailure(error: unknown): boolean {
  return ['ELOOP', 'EMLINK'].includes(errno(error) ?? '');
}

function isAlreadyExists(error: unknown): boolean {
  return errno(error) === 'EEXIST';
}

function changedAfterPlanning(filePath?: string): KiokukoError {
  return new KiokukoError(
    'CONFLICT',
    'Setup target changed after planning',
    filePath === undefined ? {} : { target: filePath },
  );
}

function identityFromStat(info: Awaited<ReturnType<FileHandle['stat']>>): FileIdentity {
  const device = BigInt(info.dev);
  const inode = BigInt(info.ino);
  if (inode === 0n) {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'The filesystem does not expose a stable file identity required for safe mutation',
    );
  }
  return { device, inode };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameSnapshot(left: RegularFileSnapshot | undefined, right: RegularFileSnapshot | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameIdentity(left.identity, right.identity)
    && left.content === right.content
    && left.mode === right.mode;
}

function artifactFromOpenHandle(
  info: Awaited<ReturnType<FileHandle['stat']>>,
  content: string,
): BoundRegularArtifact {
  if (!info.isFile()) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Atomic artifact is not a regular file');
  }
  return {
    snapshot: {
      content,
      mode: Number(info.mode) & 0o777,
      identity: identityFromStat(info),
    },
    linkCount: BigInt(info.nlink),
  };
}

async function readOpenHandleArtifact(
  handle: FileHandle,
  filePath: string,
): Promise<BoundRegularArtifact> {
  const before = await handle.stat();
  if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Atomic artifact cannot be read safely');
  }
  const buffer = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Atomic artifact changed while it was read');
    }
    offset += result.bytesRead;
  }
  const after = await handle.stat();
  const initial = artifactFromOpenHandle(before, decodeUtf8(buffer, filePath));
  const final = artifactFromOpenHandle(after, initial.snapshot.content);
  if (!sameArtifact(initial, final) || before.size !== after.size) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Atomic artifact changed while it was read');
  }
  return final;
}

function sameArtifact(
  left: BoundRegularArtifact | undefined,
  right: BoundRegularArtifact,
): boolean {
  return left !== undefined
    && sameSnapshot(left.snapshot, right.snapshot)
    && left.linkCount === right.linkCount;
}

function withLinkCount(artifact: BoundRegularArtifact, linkCount: bigint): BoundRegularArtifact {
  return { snapshot: artifact.snapshot, linkCount };
}

function requireArtifact(
  current: BoundRegularArtifact | undefined,
  expected: BoundRegularArtifact,
  message: string,
): BoundRegularArtifact {
  if (current === undefined || !sameArtifact(current, expected)) {
    throw new KiokukoError('INTEGRITY_ERROR', message);
  }
  return current;
}

function ensureContained(root: string, filePath: string): { root: string; target: string } {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(filePath);
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Managed file must remain inside its repository root');
  }
  return { root: resolvedRoot, target };
}

async function rejectLinkedComponents(root: string, filePath: string): Promise<void> {
  const contained = ensureContained(root, filePath);
  const relative = path.relative(contained.root, contained.target);
  let current = contained.root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new KiokukoError('SECURITY_REJECTION', 'Refusing to traverse a symbolic link');
      }
      if (current !== contained.target && !info.isDirectory()) {
        throw new KiokukoError('VALIDATION_ERROR', `Expected a directory: ${current}`);
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }
}

function decodeUtf8(buffer: Buffer, filePath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', `Managed text file is not valid UTF-8: ${filePath}`);
  }
}

export async function readRegularFile(
  filePath: string,
  dependencies: ReadRegularFileDependencies & { containmentRoot?: string } = {},
): Promise<RegularFileSnapshot | undefined> {
  if (dependencies.containmentRoot !== undefined) {
    await rejectLinkedComponents(dependencies.containmentRoot, filePath);
  }

  let plannedIdentity: FileIdentity | undefined;
  try {
    const planned = await lstat(filePath, { bigint: true });
    if (planned.isSymbolicLink()) {
      throw new KiokukoError('SECURITY_REJECTION', 'Refusing to follow a symbolic link');
    }
    if (!planned.isFile()) throw new KiokukoError('VALIDATION_ERROR', `Expected a regular file: ${filePath}`);
    plannedIdentity = { device: planned.dev, inode: planned.ino };
    if (plannedIdentity.inode === 0n) {
      throw new KiokukoError(
        'SECURITY_REJECTION',
        'The filesystem does not expose a stable file identity required for safe mutation',
      );
    }
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let handle: FileHandle;
  const platform = dependencies.platform ?? process.platform;
  const flags = platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    if (isMissingFile(error)) throw changedAfterPlanning();
    if (isSymlinkFailure(error)) throw new KiokukoError('SECURITY_REJECTION', 'Refusing to follow a symbolic link');
    throw error;
  }
  let operationResult: { value: RegularFileSnapshot } | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    await dependencies.afterOpen?.(filePath, handle);
    const info = await handle.stat();
    if (!info.isFile()) throw new KiokukoError('VALIDATION_ERROR', `Expected a regular file: ${filePath}`);
    const identity = identityFromStat(info);
    if (!sameIdentity(identity, plannedIdentity)) throw changedAfterPlanning();
    const content = decodeUtf8(await handle.readFile(), filePath);
    operationResult = { value: { content, mode: info.mode & 0o777, identity } };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await (dependencies.closeHandle ?? ((openHandle: FileHandle) => openHandle.close()))(handle);
  } catch (closeError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        'Regular-file read failed and its file descriptor could not be closed',
      );
    }
    throw closeError;
  }
  if (operationFailed) throw operationError;
  if (operationResult === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Regular-file read produced no result');
  }
  return operationResult.value;
}

async function readBoundArtifact(
  filePath: string,
  containmentRoot?: string,
): Promise<BoundRegularArtifact | undefined> {
  const snapshot = await readRegularFile(filePath, {
    ...(containmentRoot === undefined ? {} : { containmentRoot }),
  });
  if (snapshot === undefined) return undefined;

  let current: BigIntStats;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  if (current.isSymbolicLink()) {
    throw new KiokukoError('SECURITY_REJECTION', 'Refusing to follow a symbolic link');
  }
  if (!current.isFile()) {
    throw new KiokukoError('VALIDATION_ERROR', `Expected a regular file: ${filePath}`);
  }
  const identity = { device: current.dev, inode: current.ino };
  if (identity.inode === 0n) {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'The filesystem does not expose a stable file identity required for safe mutation',
    );
  }
  if (!sameIdentity(identity, snapshot.identity) || Number(current.mode & 0o777n) !== snapshot.mode) {
    throw changedAfterPlanning(filePath);
  }
  return { snapshot, linkCount: current.nlink };
}

/** Read an exact directory identity without following its final path component. */
export async function readDirectoryIdentity(directoryPath: string): Promise<FileIdentity | undefined> {
  let info: BigIntStats;
  try {
    info = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new KiokukoError('SECURITY_REJECTION', 'Refusing to traverse a symbolic link');
  }
  if (!info.isDirectory()) {
    throw new KiokukoError('VALIDATION_ERROR', `Expected a directory: ${directoryPath}`);
  }
  if (info.ino === 0n) {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'The filesystem does not expose a stable directory identity required for safe mutation',
    );
  }
  return { device: info.dev, inode: info.ino };
}

const ATOMIC_QUARANTINE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(deleted|previous|rollback)$/iu;
const ATOMIC_QUARANTINE_CLEANUP_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(deleted|previous|rollback)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cleanup$/iu;

export interface PendingAtomicMutation {
  kind: 'deleted' | 'previous' | 'rollback';
  snapshot: RegularFileSnapshot;
}

/**
 * Bind a native atomic-write quarantine for this exact basename without
 * following path components. Its snapshot may constrain convergence, but it
 * never grants the caller ownership of the artifact.
 */
export async function readPendingAtomicMutation(
  filePath: string,
  expectedParentDirectory: FileIdentity,
  containmentRoot?: string,
): Promise<PendingAtomicMutation | undefined> {
  if (containmentRoot !== undefined) {
    await rejectLinkedComponents(containmentRoot, filePath);
  }
  const directory = path.dirname(filePath);
  const parent = await bindMutationDirectory(directory, expectedParentDirectory);
  const basename = path.basename(filePath);
  const activePrefix = `.${basename}.`;
  const cleanupPrefix = `..${basename}.`;
  const names = await readdir(directory);
  await requireBoundDirectory(parent);
  if (containmentRoot !== undefined) {
    await rejectLinkedComponents(containmentRoot, filePath);
  }
  const matches = names.flatMap((name): Array<{ name: string; kind: PendingAtomicMutation['kind'] }> => {
    const match = name.startsWith(activePrefix)
      ? ATOMIC_QUARANTINE_NAME.exec(name.slice(activePrefix.length))
      : name.startsWith(cleanupPrefix)
        ? ATOMIC_QUARANTINE_CLEANUP_NAME.exec(name.slice(cleanupPrefix.length))
        : null;
    if (match === null) return [];
    const kind = match[1];
    if (kind !== 'deleted' && kind !== 'previous' && kind !== 'rollback') return [];
    return [{ name, kind }];
  });
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw new KiokukoError(
      'CONFLICT',
      'Multiple atomic quarantines exist for one target',
      { target: filePath },
    );
  }
  const match = matches[0];
  if (match === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Atomic quarantine match vanished');
  const artifactPath = path.join(directory, match.name);
  const artifact = await readArtifactInBoundDirectory(artifactPath, parent, containmentRoot);
  if (artifact === undefined) throw changedAfterPlanning(artifactPath);
  if (artifact.linkCount !== 1n) {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'Atomic quarantine must have exactly one link',
      { target: artifactPath },
    );
  }
  await requireBoundDirectory(parent);
  return { kind: match.kind, snapshot: artifact.snapshot };
}

async function readBoundDirectory(directoryPath: string): Promise<BoundDirectory> {
  const identity = await readDirectoryIdentity(directoryPath);
  if (identity === undefined) throw changedAfterPlanning(directoryPath);
  return {
    directoryPath,
    identity,
  };
}

async function requireBoundDirectory(binding: BoundDirectory): Promise<void> {
  const current = await readBoundDirectory(binding.directoryPath);
  if (!sameIdentity(current.identity, binding.identity)) {
    throw changedAfterPlanning(binding.directoryPath);
  }
}

async function readArtifactInBoundDirectory(
  filePath: string,
  parent: BoundDirectory,
  containmentRoot?: string,
): Promise<BoundRegularArtifact | undefined> {
  await requireBoundDirectory(parent);
  const artifact = await readBoundArtifact(filePath, containmentRoot);
  await requireBoundDirectory(parent);
  return artifact;
}

async function requireAbsentInBoundDirectory(
  filePath: string,
  parent: BoundDirectory,
  message: string,
  containmentRoot?: string,
): Promise<void> {
  if (await readArtifactInBoundDirectory(filePath, parent, containmentRoot) !== undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', message, { target: filePath });
  }
}

async function bindMutationDirectory(
  directoryPath: string,
  expected?: FileIdentity,
): Promise<BoundDirectory> {
  const binding = await readBoundDirectory(directoryPath);
  if (expected !== undefined && !sameIdentity(binding.identity, expected)) {
    throw changedAfterPlanning(directoryPath);
  }
  return binding;
}

export async function assertFileExpectation(
  filePath: string,
  expectation: FileExpectation,
): Promise<void> {
  const parent = expectation.expectedParentDirectory === undefined
    ? undefined
    : await bindMutationDirectory(path.dirname(filePath), expectation.expectedParentDirectory);
  const current = await readRegularFile(filePath, {
    ...(expectation.containmentRoot === undefined ? {} : { containmentRoot: expectation.containmentRoot }),
  });
  if (!sameSnapshot(current, expectation.expected)) throw changedAfterPlanning(filePath);
  if (parent !== undefined) await requireBoundDirectory(parent);
  for (const absentPath of expectation.mustRemainAbsent ?? []) {
    const alternate = await readRegularFile(absentPath, {
      ...(expectation.containmentRoot === undefined ? {} : { containmentRoot: expectation.containmentRoot }),
    });
    if (alternate !== undefined) throw changedAfterPlanning(absentPath);
    if (parent !== undefined) await requireBoundDirectory(parent);
  }
}

async function cleanupBoundArtifact(
  beforeCleanup: ((artifactPath: string) => void | Promise<void>) | undefined,
  filePath: string,
  expected: BoundRegularArtifact | undefined,
  parent: BoundDirectory,
): Promise<AtomicCleanupFailure | undefined> {
  if (expected === undefined) {
    return new AtomicCleanupFailure(undefined, {
      cause: new KiokukoError(
        'INTEGRITY_ERROR',
        'Refusing to remove an atomic artifact whose exact identity was not bound',
      ),
    });
  }
  const disposalPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.cleanup`,
  );
  try {
    requireArtifact(
      await readArtifactInBoundDirectory(filePath, parent),
      expected,
      'Refusing to remove a changed atomic artifact',
    );
    await requireAbsentInBoundDirectory(
      disposalPath,
      parent,
      'Atomic cleanup quarantine already exists',
    );
    await rename(filePath, disposalPath);
    requireArtifact(
      await readArtifactInBoundDirectory(disposalPath, parent),
      expected,
      'Atomic cleanup quarantine does not match the bound artifact',
    );
    await requireAbsentInBoundDirectory(
      filePath,
      parent,
      'Atomic cleanup source pathname was replaced',
    );
    await beforeCleanup?.(disposalPath);
    requireArtifact(
      await readArtifactInBoundDirectory(disposalPath, parent),
      expected,
      'Atomic cleanup quarantine changed during the cleanup hook',
    );
    await requireAbsentInBoundDirectory(
      filePath,
      parent,
      'Atomic cleanup hook recreated the source pathname',
    );
    await unlink(disposalPath);
    await requireAbsentInBoundDirectory(
      disposalPath,
      parent,
      'Atomic cleanup quarantine was not removed',
    );
    return undefined;
  } catch (error) {
    return bindOwnedCleanupFailure(error, [
      { artifactPath: disposalPath, expected },
      { artifactPath: filePath, expected },
    ], parent);
  }
}

interface OwnedArtifactCandidate {
  artifactPath: string;
  expected: BoundRegularArtifact;
}

/**
 * Report a recovery pathname only after rebinding the exact inode, bytes, and
 * mode. A changed link count is itself a cleanup failure, but it does not make
 * the pathname's inode ownership ambiguous.
 */
async function bindOwnedCleanupFailure(
  cause: unknown,
  candidates: readonly OwnedArtifactCandidate[],
  parent: BoundDirectory,
): Promise<AtomicCleanupFailure> {
  const observationErrors: unknown[] = [];
  for (const candidate of candidates) {
    try {
      await requireBoundDirectory(parent);
      const current = await readBoundArtifact(candidate.artifactPath);
      await requireBoundDirectory(parent);
      if (
        current !== undefined
        && sameSnapshot(current.snapshot, candidate.expected.snapshot)
      ) {
        return new AtomicCleanupFailure(candidate.artifactPath, { cause });
      }
    } catch (observationError) {
      observationErrors.push(observationError);
    }
  }
  return new AtomicCleanupFailure(undefined, {
    cause: observationErrors.length === 0
      ? cause
      : new AggregateError(
        [cause, ...observationErrors],
        'Atomic cleanup failed and no owned artifact pathname could be proven',
      ),
  });
}

async function cleanupBeforeCommit(
  beforeCleanup: ((artifactPath: string) => void | Promise<void>) | undefined,
  filePath: string,
  operationError: unknown,
  expected: BoundRegularArtifact | undefined,
  parent: BoundDirectory,
): Promise<never> {
  const cleanupFailure = await cleanupBoundArtifact(beforeCleanup, filePath, expected, parent);
  if (cleanupFailure !== undefined) {
    throw new AggregateError(
      [operationError, cleanupFailure],
      'Atomic write failed and temporary-file cleanup also failed',
    );
  }
  if (operationError instanceof KiokukoError || operationError instanceof AggregateError) throw operationError;
  throw new KiokukoError('PARTIAL_FAILURE', `Unable to atomically write ${filePath}`, {
    cause: operationError instanceof Error ? operationError.message : String(operationError),
  });
}

async function restoreQuarantinedTarget(
  quarantinePath: string,
  filePath: string,
  beforeCleanup: ((artifactPath: string) => void | Promise<void>) | undefined,
  quarantined: BoundRegularArtifact,
  parent: BoundDirectory,
): Promise<AtomicCleanupFailure[]> {
  try {
    requireArtifact(
      await readArtifactInBoundDirectory(quarantinePath, parent),
      quarantined,
      'Quarantined target changed before rollback',
    );
    await requireAbsentInBoundDirectory(
      filePath,
      parent,
      'Rollback target pathname is no longer absent',
    );
    await link(quarantinePath, filePath);
    const linked = withLinkCount(quarantined, quarantined.linkCount + 1n);
    requireArtifact(
      await readArtifactInBoundDirectory(quarantinePath, parent),
      linked,
      'Quarantined target changed while rollback was installed',
    );
    requireArtifact(
      await readArtifactInBoundDirectory(filePath, parent),
      linked,
      'Restored target does not match the bound quarantine',
    );
    const cleanupFailure = await cleanupBoundArtifact(beforeCleanup, quarantinePath, linked, parent);
    if (cleanupFailure !== undefined) return [cleanupFailure];
    requireArtifact(
      await readArtifactInBoundDirectory(filePath, parent),
      quarantined,
      'Restored target changed during quarantine cleanup',
    );
    return [];
  } catch (error) {
    return [await bindOwnedCleanupFailure(error, [
      { artifactPath: quarantinePath, expected: quarantined },
      { artifactPath: quarantinePath, expected: withLinkCount(quarantined, quarantined.linkCount + 1n) },
    ], parent)];
  }
}

function throwWithArtifactFailures(
  error: unknown,
  failures: readonly AtomicCleanupFailure[],
  message: string,
): never {
  if (failures.length === 0) throw error;
  throw new AggregateError([error, ...failures], message);
}

async function throwAfterOriginalRestoreAttempt(
  operationError: unknown,
  failures: readonly AtomicCleanupFailure[],
  filePath: string,
  expected: RegularFileSnapshot,
  parent: BoundDirectory,
  message: string,
): Promise<never> {
  let current: RegularFileSnapshot | undefined;
  try {
    await requireBoundDirectory(parent);
    current = await readRegularFile(filePath);
    await requireBoundDirectory(parent);
  } catch (validationError) {
    throw new AtomicCommittedUnlinkError({
      cleanupFailures: [
        ...failures,
        new AtomicCleanupFailure(undefined, { cause: validationError }),
      ],
    }, operationError);
  }
  if (sameSnapshot(current, expected)) {
    if (failures.length === 0) throw operationError;
    throw new AggregateError([operationError, ...failures], message);
  }
  throw new AtomicCommittedUnlinkError({ cleanupFailures: failures }, operationError);
}

async function conditionalUnlinkInstalled(
  temporaryPath: string,
  filePath: string,
  expected: BoundRegularArtifact,
  beforeCleanup: ((artifactPath: string) => void | Promise<void>) | undefined,
  dependencies: Pick<AtomicWriteDependencies, 'afterRename' | 'beforeRename'>,
  parent: BoundDirectory,
  state: ConditionalInstallState,
): Promise<AtomicUnlinkResult> {
  requireArtifact(
    await readArtifactInBoundDirectory(filePath, parent),
    expected,
    'Installed target changed before conditional rollback',
  );
  const quarantinePath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.rollback`);
  await requireAbsentInBoundDirectory(
    quarantinePath,
    parent,
    'Conditional rollback quarantine already exists',
  );
  await dependencies.beforeRename?.(filePath, quarantinePath);
  requireArtifact(
    await readArtifactInBoundDirectory(filePath, parent),
    expected,
    'Installed target changed during the conditional rollback hook',
  );
  await requireAbsentInBoundDirectory(
    quarantinePath,
    parent,
    'Conditional rollback hook created its quarantine path',
  );
  await rename(filePath, quarantinePath);

  // Built-in rename fulfillment is the commit boundary. Every later failure
  // reports an absent-target committed outcome.
  let postRenameError: unknown;
  try {
    await dependencies.afterRename?.(filePath, quarantinePath);
  } catch (error) {
    postRenameError = error;
  }
  try {
    requireArtifact(
      await readArtifactInBoundDirectory(quarantinePath, parent),
      expected,
      'Installed target changed while entering conditional rollback',
    );
    await requireAbsentInBoundDirectory(
      filePath,
      parent,
      'Conditional rollback source pathname was recreated',
    );
  } catch (error) {
    const cleanupFailures = [await bindOwnedCleanupFailure(error, [
      { artifactPath: quarantinePath, expected },
    ], parent)];
    try {
      const currentTemporary = await readArtifactInBoundDirectory(temporaryPath, parent);
      if (
        currentTemporary !== undefined
        && sameSnapshot(currentTemporary.snapshot, expected.snapshot)
      ) {
        state.temporaryLinkCount = currentTemporary.linkCount;
      }
    } catch (observationError) {
      cleanupFailures.push(new AtomicCleanupFailure(undefined, { cause: observationError }));
    }
    throw new AtomicCommittedUnlinkError({
      cleanupFailures,
    }, postRenameError ?? error);
  }

  const cleanupFailure = await cleanupBoundArtifact(beforeCleanup, quarantinePath, expected, parent);
  const cleanupFailures = cleanupFailure === undefined ? [] : [cleanupFailure];
  if (cleanupFailure === undefined) {
    state.temporaryLinkCount = 1n;
  } else {
    try {
      const currentTemporary = await readArtifactInBoundDirectory(temporaryPath, parent);
      if (
        currentTemporary !== undefined
        && sameSnapshot(currentTemporary.snapshot, expected.snapshot)
      ) {
        state.temporaryLinkCount = currentTemporary.linkCount;
      }
    } catch (observationError) {
      cleanupFailures.push(new AtomicCleanupFailure(undefined, { cause: observationError }));
    }
  }
  const outcome = { cleanupFailures };
  try {
    await requireBoundDirectory(parent);
  } catch (error) {
    throw new AtomicCommittedUnlinkError(outcome, error);
  }
  if (postRenameError !== undefined) {
    throw new AtomicCommittedUnlinkError(outcome, postRenameError);
  }
  return outcome;
}

interface ConditionalInstallState {
  temporaryLinkCount: bigint;
}

async function conditionalInstall(
  temporaryPath: string,
  filePath: string,
  expectation: FileExpectation,
  beforeCleanup: ((artifactPath: string) => void | Promise<void>) | undefined,
  temporary: BoundRegularArtifact,
  parent: BoundDirectory,
  state: ConditionalInstallState,
  dependencies: AtomicWriteDependencies,
): Promise<AtomicWriteResult> {
  await requireBoundDirectory(parent);
  await assertFileExpectation(filePath, expectation);
  const expected = expectation.expected;
  let quarantinePath: string | undefined;
  let quarantined: BoundRegularArtifact | undefined;

  if (expected !== undefined) {
    const plannedTarget = await readArtifactInBoundDirectory(
      filePath,
      parent,
      expectation.containmentRoot,
    );
    if (plannedTarget === undefined || !sameSnapshot(plannedTarget.snapshot, expected)) {
      throw changedAfterPlanning(filePath);
    }
    quarantinePath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.previous`);
    await requireAbsentInBoundDirectory(
      quarantinePath,
      parent,
      'Conditional update quarantine already exists',
      expectation.containmentRoot,
    );
    await dependencies.beforeRename?.(filePath, quarantinePath);
    const targetAfterQuarantineHook = await readArtifactInBoundDirectory(
      filePath,
      parent,
      expectation.containmentRoot,
    );
    if (!sameArtifact(targetAfterQuarantineHook, plannedTarget)) {
      // A concurrent atomic writer can win between the initial read and this
      // second observation. Report a target-scoped conflict so callers that
      // support convergence can observe the winner instead of treating the
      // expected race as an integrity failure.
      throw changedAfterPlanning(filePath);
    }
    await requireAbsentInBoundDirectory(
      quarantinePath,
      parent,
      'Conditional update hook created its quarantine path',
      expectation.containmentRoot,
    );
    try {
      await rename(filePath, quarantinePath);
    } catch (error) {
      if (isMissingFile(error)) throw changedAfterPlanning(filePath);
      throw error;
    }

    // Built-in rename fulfillment is the commit boundary. Retain the exact
    // pre-rename binding before any post-rename hook or pathname observation.
    quarantined = plannedTarget;
    let postRenameError: unknown;
    try {
      await dependencies.afterRename?.(filePath, quarantinePath);
    } catch (error) {
      postRenameError = error;
    }
    try {
      requireArtifact(
        await readArtifactInBoundDirectory(quarantinePath, parent, expectation.containmentRoot),
        quarantined,
        'Quarantined target changed after update rename',
      );
      await requireAbsentInBoundDirectory(
        filePath,
        parent,
        'Update quarantine left or recreated the target pathname',
        expectation.containmentRoot,
      );
    } catch (error) {
      throw new AtomicCommittedUnlinkError({
        cleanupFailures: [await bindOwnedCleanupFailure(error, [
          { artifactPath: quarantinePath, expected: quarantined },
        ], parent)],
      }, postRenameError ?? error);
    }
    if (postRenameError !== undefined) {
      throw new AtomicCommittedUnlinkError({
        cleanupFailures: [await bindOwnedCleanupFailure(postRenameError, [
          { artifactPath: quarantinePath, expected: quarantined },
        ], parent)],
      }, postRenameError);
    }

    try {
      await dependencies.afterQuarantine?.(filePath);
      requireArtifact(
        await readArtifactInBoundDirectory(quarantinePath, parent, expectation.containmentRoot),
        quarantined,
        'Quarantined target changed after quarantine',
      );
      await requireAbsentInBoundDirectory(
        filePath,
        parent,
        'Quarantine hook recreated the target pathname',
        expectation.containmentRoot,
      );
    } catch (error) {
      const failures = await restoreQuarantinedTarget(
        quarantinePath,
        filePath,
        beforeCleanup,
        quarantined,
        parent,
      );
      await throwAfterOriginalRestoreAttempt(
        error,
        failures,
        filePath,
        expected,
        parent,
        'Conditional installation was interrupted and rollback left an artifact',
      );
    }
  }

  const validatePreInstall = async (): Promise<void> => {
    requireArtifact(
      await readArtifactInBoundDirectory(temporaryPath, parent, expectation.containmentRoot),
      temporary,
      'Atomic temporary file changed before installation',
    );
    if (expected === undefined) {
      if (await readArtifactInBoundDirectory(
        filePath,
        parent,
        expectation.containmentRoot,
      ) !== undefined) {
        throw changedAfterPlanning(filePath);
      }
    } else {
      await requireAbsentInBoundDirectory(
        filePath,
        parent,
        'Conditional installation target is no longer absent',
        expectation.containmentRoot,
      );
    }
    if (quarantinePath !== undefined && quarantined !== undefined) {
      requireArtifact(
        await readArtifactInBoundDirectory(quarantinePath, parent, expectation.containmentRoot),
        quarantined,
        'Quarantined target changed before installation',
      );
    }
  };

  try {
    await validatePreInstall();
    await dependencies.beforeLink?.(temporaryPath, filePath);
    await validatePreInstall();
    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      if (isAlreadyExists(error)) throw changedAfterPlanning(filePath);
      throw error;
    }
  } catch (error) {
    const failures = quarantinePath === undefined || quarantined === undefined
      ? []
      : await restoreQuarantinedTarget(
        quarantinePath,
        filePath,
        beforeCleanup,
        quarantined,
        parent,
      );
    if (quarantined !== undefined && expected !== undefined) {
      await throwAfterOriginalRestoreAttempt(
        error,
        failures,
        filePath,
        expected,
        parent,
        'Conditional installation failed and rollback left an artifact',
      );
    }
    throwWithArtifactFailures(error, failures, 'Conditional installation failed and rollback left an artifact');
  }

  // Built-in link fulfillment is the commit boundary. Record the second link
  // before any hook or pathname validation can fail.
  state.temporaryLinkCount = 2n;
  const linkedTemporary = withLinkCount(temporary, 2n);
  const validateInstalled = async (): Promise<void> => {
    requireArtifact(
      await readArtifactInBoundDirectory(temporaryPath, parent, expectation.containmentRoot),
      linkedTemporary,
      'Atomic temporary file changed after installation',
    );
    requireArtifact(
      await readArtifactInBoundDirectory(filePath, parent, expectation.containmentRoot),
      linkedTemporary,
      'Installed target changed after installation',
    );
    if (quarantinePath !== undefined && quarantined !== undefined) {
      requireArtifact(
        await readArtifactInBoundDirectory(quarantinePath, parent, expectation.containmentRoot),
        quarantined,
        'Quarantined target changed after installation',
      );
    }
  };
  try {
    await dependencies.afterLink?.(temporaryPath, filePath);
    await validateInstalled();
    await dependencies.afterInstall?.(filePath);
    await validateInstalled();
  } catch (error) {
    const cleanupFailures = quarantinePath === undefined || quarantined === undefined
      ? []
      : [await bindOwnedCleanupFailure(error, [
        { artifactPath: quarantinePath, expected: quarantined },
      ], parent)];
    throw new AtomicCommittedMutationError({ installed: temporary.snapshot, cleanupFailures }, error);
  }

  for (const absentPath of expectation.mustRemainAbsent ?? []) {
    let alternate: RegularFileSnapshot | undefined;
    try {
      await requireBoundDirectory(parent);
      alternate = await readRegularFile(absentPath, {
        ...(expectation.containmentRoot === undefined ? {} : { containmentRoot: expectation.containmentRoot }),
      });
      await requireBoundDirectory(parent);
    } catch (error) {
      const displacedOriginal = quarantinePath === undefined || quarantined === undefined
        ? []
        : [await bindOwnedCleanupFailure(error, [
          { artifactPath: quarantinePath, expected: quarantined },
        ], parent)];
      throw new AtomicCommittedMutationError({ installed: temporary.snapshot, cleanupFailures: displacedOriginal }, error);
    }
    if (alternate !== undefined) {
      const conflict = changedAfterPlanning(absentPath);
      let rollback: AtomicUnlinkResult;
      try {
        rollback = await conditionalUnlinkInstalled(
          temporaryPath,
          filePath,
          linkedTemporary,
          beforeCleanup,
          dependencies,
          parent,
          state,
        );
      } catch (error) {
        const rollbackFailure = new AggregateError(
          [conflict, error],
          'Alternate target appeared and conditional rollback failed',
        );
        if (error instanceof AtomicCommittedUnlinkError) {
          const failures = [...error.outcome.cleanupFailures];
          if (
            quarantinePath !== undefined
            && quarantined !== undefined
            && expected !== undefined
          ) {
            failures.push(...await restoreQuarantinedTarget(
              quarantinePath,
              filePath,
              beforeCleanup,
              quarantined,
              parent,
            ));
            await throwAfterOriginalRestoreAttempt(
              rollbackFailure,
              failures,
              filePath,
              expected,
              parent,
              'Alternate target appeared; original target was restored but artifact cleanup failed',
            );
          }
          throwWithArtifactFailures(
            rollbackFailure,
            failures,
            'Alternate target appeared and committed rollback left an artifact',
          );
        }

        const displacedOriginal = quarantinePath === undefined || quarantined === undefined
          ? []
          : [await bindOwnedCleanupFailure(error, [
            { artifactPath: quarantinePath, expected: quarantined },
          ], parent)];
        throw new AtomicCommittedMutationError({
          installed: temporary.snapshot,
          cleanupFailures: displacedOriginal,
        }, rollbackFailure);
      }

      const failures = [...rollback.cleanupFailures];
      if (
        quarantinePath !== undefined
        && quarantined !== undefined
        && expected !== undefined
      ) {
        failures.push(...await restoreQuarantinedTarget(
          quarantinePath,
          filePath,
          beforeCleanup,
          quarantined,
          parent,
        ));
        await throwAfterOriginalRestoreAttempt(
          conflict,
          failures,
          filePath,
          expected,
          parent,
          'Alternate target appeared; original target was restored but artifact cleanup failed',
        );
      }
      throwWithArtifactFailures(
        conflict,
        failures,
        'Alternate target appeared and committed rollback left an artifact',
      );
    }
  }
  const cleanupFailures: AtomicCleanupFailure[] = [];
  if (quarantinePath !== undefined && quarantined !== undefined) {
    const cleanupFailure = await cleanupBoundArtifact(beforeCleanup, quarantinePath, quarantined, parent);
    if (cleanupFailure !== undefined) cleanupFailures.push(cleanupFailure);
  }
  try {
    await requireBoundDirectory(parent);
  } catch (error) {
    throw new AtomicCommittedMutationError({ installed: temporary.snapshot, cleanupFailures }, error);
  }
  return { installed: temporary.snapshot, cleanupFailures };
}

async function atomicWriteTextInternal(
  filePath: string,
  content: string,
  mode: number,
  dependencyOverrides: AtomicWriteDependencies,
  expectation?: FileExpectation,
): Promise<AtomicWriteResult> {
  const changeMode = dependencyOverrides.chmod ?? chmod;
  const beforeCleanup = dependencyOverrides.beforeCleanup;
  const directory = path.dirname(filePath);
  if (expectation?.containmentRoot !== undefined) {
    await rejectLinkedComponents(expectation.containmentRoot, filePath);
  }
  if (expectation?.expectedParentDirectory === undefined) {
    await mkdir(directory, { recursive: true });
  } else {
    await assertFileExpectation(filePath, expectation);
  }
  const parent = await bindMutationDirectory(directory, expectation?.expectedParentDirectory);
  if (expectation?.containmentRoot !== undefined) {
    await rejectLinkedComponents(expectation.containmentRoot, filePath);
  }
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let temporaryHandle: FileHandle | undefined;
  let temporaryCreated = false;
  let temporary: BoundRegularArtifact;
  try {
    temporaryHandle = await open(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    temporaryCreated = true;
    await requireBoundDirectory(parent);
    const opened = artifactFromOpenHandle(await temporaryHandle.stat(), '');
    if (opened.linkCount !== 1n) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Atomic temporary file must have exactly one link');
    }
    await temporaryHandle.writeFile(content, { encoding: 'utf8' });
    await temporaryHandle.sync();
    const written = await readOpenHandleArtifact(temporaryHandle, temporaryPath);
    if (
      !sameIdentity(written.snapshot.identity, opened.snapshot.identity)
      || written.snapshot.content !== content
      || written.linkCount !== 1n
    ) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Atomic temporary file changed during preparation');
    }
    await requireBoundDirectory(parent);
    await changeMode(temporaryPath, mode);
    await temporaryHandle.sync();
    const prepared = await readOpenHandleArtifact(temporaryHandle, temporaryPath);
    if (
      !sameIdentity(prepared.snapshot.identity, opened.snapshot.identity)
      || prepared.snapshot.content !== content
      || prepared.snapshot.mode !== (mode & 0o777)
      || prepared.linkCount !== 1n
    ) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Atomic temporary file changed during mode preparation');
    }
    await requireBoundDirectory(parent);
    requireArtifact(
      await readBoundArtifact(temporaryPath, expectation?.containmentRoot),
      prepared,
      'Atomic temporary pathname changed during mode preparation',
    );
    await dependencyOverrides.beforeCommit?.(filePath);
    await requireBoundDirectory(parent);
    const descriptorPrepared = await readOpenHandleArtifact(temporaryHandle, temporaryPath);
    requireArtifact(
      descriptorPrepared,
      prepared,
      'Atomic temporary file changed before commit',
    );
    temporary = requireArtifact(
      await readBoundArtifact(temporaryPath, expectation?.containmentRoot),
      prepared,
      'Atomic temporary pathname changed before commit',
    );
    await temporaryHandle.close();
    temporaryHandle = undefined;
  } catch (error) {
    let operationError = error;
    let cleanupBinding: BoundRegularArtifact | undefined;
    if (temporaryHandle !== undefined) {
      try {
        cleanupBinding = await readOpenHandleArtifact(temporaryHandle, temporaryPath);
      } catch (bindingError) {
        operationError = new AggregateError(
          [operationError, bindingError],
          'Atomic write failed and its temporary artifact could not be rebound',
        );
      }
      try {
        await temporaryHandle.close();
      } catch (closeError) {
        operationError = new AggregateError(
          [operationError, closeError],
          'Atomic write failed and its temporary handle could not be closed',
        );
      }
      temporaryHandle = undefined;
    }
    if (temporaryCreated) {
      return cleanupBeforeCommit(
        beforeCleanup,
        temporaryPath,
        operationError,
        cleanupBinding,
        parent,
      );
    }
    if (operationError instanceof KiokukoError || operationError instanceof AggregateError) throw operationError;
    throw new KiokukoError('PARTIAL_FAILURE', `Unable to atomically write ${filePath}`, {
      cause: operationError instanceof Error ? operationError.message : String(operationError),
    });
  }

  if (expectation === undefined) {
    try {
      requireArtifact(
        await readArtifactInBoundDirectory(temporaryPath, parent),
        temporary,
        'Atomic temporary file changed before rename',
      );
      await dependencyOverrides.beforeRename?.(temporaryPath, filePath);
      requireArtifact(
        await readArtifactInBoundDirectory(temporaryPath, parent),
        temporary,
        'Atomic temporary file changed during the rename hook',
      );
      await rename(temporaryPath, filePath);
    } catch (error) {
      return cleanupBeforeCommit(beforeCleanup, temporaryPath, error, temporary, parent);
    }

    // Built-in rename fulfillment is the commit boundary. Construct the
    // committed outcome before any post-rename hook or observation.
    const outcome: AtomicWriteResult = { installed: temporary.snapshot, cleanupFailures: [] };
    try {
      await dependencyOverrides.afterRename?.(temporaryPath, filePath);
      requireArtifact(
        await readArtifactInBoundDirectory(filePath, parent),
        temporary,
        'Renamed target does not match the bound temporary file',
      );
      await requireAbsentInBoundDirectory(
        temporaryPath,
        parent,
        'Unconditional rename left or recreated its temporary pathname',
      );
      await dependencyOverrides.afterInstall?.(filePath);
      requireArtifact(
        await readArtifactInBoundDirectory(filePath, parent),
        temporary,
        'Installed target changed after rename',
      );
      await requireAbsentInBoundDirectory(
        temporaryPath,
        parent,
        'Post-install hook recreated the temporary pathname',
      );
      return outcome;
    } catch (error) {
      const cleanupFailures: AtomicCleanupFailure[] = [];
      try {
        const installed = await readArtifactInBoundDirectory(filePath, parent);
        const temporaryAlias = await readArtifactInBoundDirectory(temporaryPath, parent);
        if (!sameArtifact(installed, temporary)) {
          cleanupFailures.push(new AtomicCleanupFailure(
            temporaryAlias !== undefined
              && sameSnapshot(temporaryAlias.snapshot, temporary.snapshot)
              ? temporaryPath
              : undefined,
            { cause: error },
          ));
        }
      } catch (observationError) {
        cleanupFailures.push(new AtomicCleanupFailure(undefined, { cause: observationError }));
      }
      throw new AtomicCommittedMutationError({
        installed: temporary.snapshot,
        cleanupFailures,
      }, error);
    }
  }

  const state: ConditionalInstallState = { temporaryLinkCount: 1n };
  let outcome: AtomicWriteResult;
  try {
    outcome = await conditionalInstall(
      temporaryPath,
      filePath,
      expectation,
      beforeCleanup,
      temporary,
      parent,
      state,
      dependencyOverrides,
    );
  } catch (error) {
    const cleanupFailure = await cleanupBoundArtifact(
      beforeCleanup,
      temporaryPath,
      withLinkCount(temporary, state.temporaryLinkCount),
      parent,
    );
    if (error instanceof AtomicCommittedUnlinkError) {
      throw new AtomicCommittedUnlinkError({
        cleanupFailures: cleanupFailure === undefined
          ? error.outcome.cleanupFailures
          : [...error.outcome.cleanupFailures, cleanupFailure],
      }, error.operationError);
    }
    if (error instanceof AtomicCommittedMutationError) {
      throw new AtomicCommittedMutationError({
        installed: error.outcome.installed,
        cleanupFailures: cleanupFailure === undefined
          ? error.outcome.cleanupFailures
          : [...error.outcome.cleanupFailures, cleanupFailure],
      }, error.operationError);
    }
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [error, cleanupFailure],
        'Atomic file mutation failed and temporary artifact cleanup also failed',
      );
    }
    throw error;
  }

  const cleanupFailure = await cleanupBoundArtifact(
    beforeCleanup,
    temporaryPath,
    withLinkCount(temporary, state.temporaryLinkCount),
    parent,
  );
  const finalOutcome = cleanupFailure === undefined
    ? outcome
    : { installed: outcome.installed, cleanupFailures: [...outcome.cleanupFailures, cleanupFailure] };
  try {
    if (cleanupFailure === undefined) {
      requireArtifact(
        await readArtifactInBoundDirectory(filePath, parent, expectation.containmentRoot),
        temporary,
        'Installed target did not reach its final single-link state',
      );
    }
    await requireBoundDirectory(parent);
  } catch (error) {
    throw new AtomicCommittedMutationError(finalOutcome, error);
  }
  return finalOutcome;
}

export async function atomicWriteText(
  filePath: string,
  content: string,
  mode = 0o644,
  dependencyOverrides: AtomicWriteDependencies = {},
): Promise<AtomicWriteResult> {
  return atomicWriteTextInternal(filePath, content, mode, dependencyOverrides);
}

/** Write only when the target is still the exact file observed at planning time. */
export async function atomicWriteTextIfUnchanged(
  filePath: string,
  content: string,
  expectation: FileExpectation,
  mode = 0o644,
  dependencyOverrides: AtomicWriteDependencies = {},
): Promise<AtomicWriteResult> {
  return atomicWriteTextInternal(filePath, content, mode, dependencyOverrides, expectation);
}

/** Delete only when the target is still the exact planned file identity and content. */
export async function unlinkRegularFileIfUnchanged(
  filePath: string,
  expectation: FileExpectation,
  dependencyOverrides: ConditionalUnlinkDependencies = {},
): Promise<AtomicUnlinkResult> {
  const parent = await bindMutationDirectory(
    path.dirname(filePath),
    expectation.expectedParentDirectory,
  );
  await assertFileExpectation(filePath, expectation);
  await dependencyOverrides.beforeCommit?.(filePath);
  await requireBoundDirectory(parent);
  await assertFileExpectation(filePath, expectation);
  const expected = expectation.expected;
  if (expected === undefined) throw changedAfterPlanning();
  const plannedTarget = await readArtifactInBoundDirectory(
    filePath,
    parent,
    expectation.containmentRoot,
  );
  if (plannedTarget === undefined || !sameSnapshot(plannedTarget.snapshot, expected)) {
    throw changedAfterPlanning(filePath);
  }

  const quarantinePath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.deleted`);
  await requireAbsentInBoundDirectory(
    quarantinePath,
    parent,
    'Conditional unlink quarantine already exists',
    expectation.containmentRoot,
  );
  await dependencyOverrides.beforeRename?.(filePath, quarantinePath);
  requireArtifact(
    await readArtifactInBoundDirectory(filePath, parent, expectation.containmentRoot),
    plannedTarget,
    'Planned unlink target changed during the rename hook',
  );
  await requireAbsentInBoundDirectory(
    quarantinePath,
    parent,
    'Conditional unlink hook created its quarantine path',
    expectation.containmentRoot,
  );
  await rename(filePath, quarantinePath);

  // Built-in rename fulfillment is the commit boundary. The exact original
  // binding is retained before any post-rename hook or observation.
  const boundQuarantined = plannedTarget;
  let postRenameError: unknown;
  try {
    await dependencyOverrides.afterRename?.(filePath, quarantinePath);
  } catch (error) {
    postRenameError = error;
  }
  try {
    requireArtifact(
      await readArtifactInBoundDirectory(quarantinePath, parent, expectation.containmentRoot),
      boundQuarantined,
      'Quarantined unlink target changed after rename',
    );
    await requireAbsentInBoundDirectory(
      filePath,
      parent,
      'Conditional unlink rename left or recreated the target pathname',
      expectation.containmentRoot,
    );
  } catch (error) {
    throw new AtomicCommittedUnlinkError({
      cleanupFailures: [await bindOwnedCleanupFailure(error, [
        { artifactPath: quarantinePath, expected: boundQuarantined },
      ], parent)],
    }, postRenameError ?? error);
  }
  if (postRenameError !== undefined) {
    throw new AtomicCommittedUnlinkError({
      cleanupFailures: [await bindOwnedCleanupFailure(postRenameError, [
        { artifactPath: quarantinePath, expected: boundQuarantined },
      ], parent)],
    }, postRenameError);
  }
  for (const absentPath of expectation.mustRemainAbsent ?? []) {
    let conflict: unknown;
    try {
      await requireBoundDirectory(parent);
      const alternate = await readRegularFile(absentPath, {
        ...(expectation.containmentRoot === undefined ? {} : { containmentRoot: expectation.containmentRoot }),
      });
      await requireBoundDirectory(parent);
      if (alternate !== undefined) conflict = changedAfterPlanning(absentPath);
    } catch (error) {
      conflict = error;
    }
    if (conflict !== undefined) {
      const failures = await restoreQuarantinedTarget(
        quarantinePath,
        filePath,
        dependencyOverrides.beforeCleanup,
        boundQuarantined,
        parent,
      );
      await throwAfterOriginalRestoreAttempt(
        conflict,
        failures,
        filePath,
        expected,
        parent,
        'Conditional unlink conflicted and rollback left an artifact',
      );
    }
  }
  const cleanupFailure = await cleanupBoundArtifact(
    dependencyOverrides.beforeCleanup,
    quarantinePath,
    boundQuarantined,
    parent,
  );
  const outcome = { cleanupFailures: cleanupFailure === undefined ? [] : [cleanupFailure] };
  try {
    await requireBoundDirectory(parent);
  } catch (error) {
    throw new AtomicCommittedUnlinkError(outcome, error);
  }
  return outcome;
}
