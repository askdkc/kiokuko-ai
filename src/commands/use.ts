import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertFileExpectation,
  assertAtomicCleanupComplete,
  AtomicCommittedMutationError,
  AtomicCommittedUnlinkError,
  type AtomicCleanupFailure,
  atomicWriteTextIfUnchanged,
  readPendingAtomicMutation,
  readRegularFile,
  unlinkRegularFileIfUnchanged,
  type FileExpectation,
  type FileIdentity,
  type PendingAtomicMutation,
  type RegularFileSnapshot,
} from '../agent-file/atomic-write.js';
import {
  readManagedBlockTemplateVersion,
  removeManagedBlock,
} from '../agent-file/managed-block.js';
import { AGENT_TEMPLATE_VERSION, renderAgentFile } from '../agent-file/render.js';
import { getGlobalDatabasePath } from '../config/paths.js';
import {
  parseProjectConfig,
  parseProjectConfigText,
  type ProjectConfig,
} from '../config/project-config.js';
import { initializeDatabase } from './init.js';
import { openConnection } from '../db/connection.js';
import { TransactionCommitUncertainError } from '../db/transaction.js';
import { registerRepositoryAndLocation } from '../repository/binding.js';
import { detectRepositoryRoot } from '../repository/detect-root.js';
import { createRepositoryIdentity } from '../repository/identity.js';
import { KiokukoError } from '../errors.js';
import { readGitOrigin } from '../repository/git-origin.js';
import { renderProjectGitignore } from '../repository/gitignore.js';

export interface UseOptions {
  cwd?: string;
  root?: string;
  workspace?: string;
  agentFile?: string;
  dryRun?: boolean;
  noAgentFile?: boolean;
  forceRebind?: boolean;
  allowDirectory?: boolean;
  databasePath?: string;
  migrationsDirectory?: string;
  repositoryId?: string;
  /** Setup-only policy: ignore a binding created by this use operation. */
  ensureNewBindingIgnored?: boolean;
}

export interface UseCommandDependencies {
  atomicWriteTextIfUnchanged?: typeof atomicWriteTextIfUnchanged;
  unlinkRegularFileIfUnchanged?: typeof unlinkRegularFileIfUnchanged;
  readBindingFileForConvergence?: typeof readRegularFile;
  readAgentFileForConvergence?: typeof readRegularFile;
  registerRepositoryAndLocation?: typeof registerRepositoryAndLocation;
  openConnection?: typeof openConnection;
}

export interface UseResult {
  repositoryRoot: string;
  repositoryId: string;
  workspace: string;
  databasePath: string;
  bindingFile: string;
  agentFile: string | null;
  agentFileAction: 'created' | 'updated' | 'unchanged' | 'skipped';
  bindingAction: 'created' | 'updated' | 'unchanged' | 'planned';
  dryRun: boolean;
  templateVersion: number;
}

function ensureChildPath(root: string, filePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, filePath);
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new KiokukoError('VALIDATION_ERROR', 'agentFile must remain inside the repository root');
  }
  return resolvedPath;
}

function parseBindingSnapshot(snapshot: RegularFileSnapshot | undefined): ProjectConfig | undefined {
  if (snapshot === undefined) return undefined;
  return parseProjectConfigText(snapshot.content);
}

function bindingText(value: ProjectConfig): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function bindingAction(existing: string | undefined, next: string): UseResult['bindingAction'] {
  if (existing === undefined) return 'created';
  return existing === next ? 'unchanged' : 'updated';
}

function preferredCliCommand(): 'kiokuko-ai' | 'npm exec -- kiokuko-ai' {
  return process.env.npm_command === 'exec' || process.env.npm_lifecycle_event === 'npx'
    ? 'npm exec -- kiokuko-ai'
    : 'kiokuko-ai';
}

interface InstalledFile {
  path: string;
  original: RegularFileSnapshot | undefined;
  installed: RegularFileSnapshot | undefined;
  containmentRoot: string;
  parentIdentity: FileIdentity;
}

interface ResolvedWrite {
  snapshot: RegularFileSnapshot;
  owned: boolean;
  cleanupFailures: readonly AtomicCleanupFailure[];
}

interface ConcurrentRetryParents {
  repositoryRoot: string;
  bindingParentIdentity: FileIdentity;
  agentParentIdentity: FileIdentity;
  agentSnapshot: RegularFileSnapshot | undefined;
}

class ConcurrentUseBinding extends Error {
  constructor(readonly binding: ProjectConfig) {
    super('A concurrent use operation created the repository binding');
    this.name = 'ConcurrentUseBinding';
  }
}

const CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS = 50;
const CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS = 10;

class CommittedRegistrationCloseError extends AggregateError {
  constructor(closeError: unknown) {
    super(
      [closeError],
      'Repository registration committed, but closing the database connection failed',
    );
    this.name = 'CommittedRegistrationCloseError';
  }
}

class UncertainRegistrationCloseError extends AggregateError {
  readonly registrationError: TransactionCommitUncertainError;
  readonly closeError: unknown;

  constructor(registrationError: TransactionCommitUncertainError, closeError: unknown) {
    super(
      [registrationError, closeError],
      'Repository registration may have committed, and closing the database connection also failed',
    );
    this.name = 'UncertainRegistrationCloseError';
    this.registrationError = registrationError;
    this.closeError = closeError;
  }
}

function expectation(
  expected: RegularFileSnapshot | undefined,
  containmentRoot: string,
  parentIdentity?: FileIdentity,
): FileExpectation {
  return {
    expected,
    containmentRoot,
    ...(parentIdentity === undefined ? {} : { expectedParentDirectory: parentIdentity }),
  };
}

async function existingParentIdentity(filePath: string): Promise<FileIdentity> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path.dirname(filePath), { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new KiokukoError('VALIDATION_ERROR', 'Managed file parent directory must already exist');
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new KiokukoError('SECURITY_REJECTION', 'Refusing to traverse a symbolic link');
  }
  if (!info.isDirectory()) {
    throw new KiokukoError('VALIDATION_ERROR', 'Managed file parent must be a directory');
  }
  const identity = { device: BigInt(info.dev), inode: BigInt(info.ino) };
  if (identity.inode === 0n) {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'The filesystem does not expose a stable parent-directory identity required for safe mutation',
    );
  }
  return identity;
}

async function restoreInstalledWrites(
  files: InstalledFile[],
  dependencies: Required<Pick<
    UseCommandDependencies,
    'atomicWriteTextIfUnchanged' | 'unlinkRegularFileIfUnchanged'
  >>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const file of [...files].reverse()) {
    try {
      if (file.original === undefined) {
        if (file.installed === undefined) {
          throw new KiokukoError('INTEGRITY_ERROR', 'Invalid file-restoration state');
        }
        const outcome = await dependencies.unlinkRegularFileIfUnchanged(
          file.path,
          expectation(file.installed, file.containmentRoot, file.parentIdentity),
        );
        assertAtomicCleanupComplete(outcome);
      } else {
        const outcome = await dependencies.atomicWriteTextIfUnchanged(
          file.path,
          file.original.content,
          expectation(file.installed, file.containmentRoot, file.parentIdentity),
          file.original.mode,
        );
        assertAtomicCleanupComplete(outcome);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function isConflict(error: unknown): error is KiokukoError {
  return error instanceof KiokukoError && error.code === 'CONFLICT';
}

function isTargetConflict(error: unknown, filePath: string): error is KiokukoError {
  return isConflict(error) && error.details.target === filePath;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertSupportedManagedTemplate(
  snapshot: RegularFileSnapshot | undefined,
  label: string,
): void {
  if (snapshot === undefined) return;
  const version = readManagedBlockTemplateVersion(snapshot.content);
  if (version !== undefined && version > AGENT_TEMPLATE_VERSION) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      `${label} uses managed template version ${version}, newer than supported version ${AGENT_TEMPLATE_VERSION}`,
    );
  }
}

type ConcurrentTargetObservation =
  | { kind: 'absent' }
  | { kind: 'different' }
  | { kind: 'linked'; snapshot: RegularFileSnapshot }
  | { kind: 'identical'; snapshot: RegularFileSnapshot };

interface ObservedTarget {
  snapshot: RegularFileSnapshot;
  linkCount: bigint;
}

interface SettledBindingSnapshot {
  snapshot: RegularFileSnapshot | undefined;
  observedConcurrentChange: boolean;
}

function sameRegularFileSnapshot(
  left: RegularFileSnapshot,
  right: RegularFileSnapshot,
): boolean {
  return left.content === right.content
    && left.mode === right.mode
    && sameFileIdentity(left.identity, right.identity);
}

async function readObservedTarget(
  filePath: string,
  containmentRoot: string,
  parentIdentity: FileIdentity,
  readFile: typeof readRegularFile = readRegularFile,
): Promise<ObservedTarget | undefined> {
  const current = await readFile(filePath, { containmentRoot });
  await assertFileExpectation(
    filePath,
    expectation(current, containmentRoot, parentIdentity),
  );
  if (current === undefined) return undefined;

  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new KiokukoError('CONFLICT', 'Concurrent target changed during convergence', {
        target: filePath,
      });
    }
    throw error;
  }
  if (!info.isFile()
    || info.dev !== current.identity.device
    || info.ino !== current.identity.inode
    || Number(info.mode & 0o777n) !== current.mode) {
    throw new KiokukoError('CONFLICT', 'Concurrent target changed during convergence', {
      target: filePath,
    });
  }
  await assertFileExpectation(
    filePath,
    expectation(current, containmentRoot, parentIdentity),
  );
  return { snapshot: current, linkCount: info.nlink };
}

async function readStrictSettledTarget(
  filePath: string,
  containmentRoot: string,
  parentIdentity: FileIdentity,
  label: string,
): Promise<RegularFileSnapshot | undefined> {
  const first = await readObservedTarget(filePath, containmentRoot, parentIdentity);
  const firstPending = await readPendingAtomicMutation(
    filePath,
    parentIdentity,
    containmentRoot,
  );
  if (firstPending !== undefined) {
    throw new KiokukoError('CONFLICT', `${label} has a concurrent atomic mutation`, {
      target: filePath,
    });
  }
  const second = await readObservedTarget(filePath, containmentRoot, parentIdentity);
  const secondPending = await readPendingAtomicMutation(
    filePath,
    parentIdentity,
    containmentRoot,
  );
  if (secondPending !== undefined
    || (first === undefined) !== (second === undefined)
    || (first !== undefined
      && second !== undefined
      && !sameRegularFileSnapshot(first.snapshot, second.snapshot))) {
    throw new KiokukoError('CONFLICT', `${label} changed while settling`, {
      target: filePath,
    });
  }
  const linked = first?.linkCount !== undefined && first.linkCount !== 1n
    ? first
    : second?.linkCount !== undefined && second.linkCount !== 1n
      ? second
      : undefined;
  if (linked !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', `${label} must have exactly one link`, {
      target: filePath,
    });
  }
  return second?.snapshot;
}

async function observeConcurrentTarget(
  filePath: string,
  content: string,
  mode: number,
  containmentRoot: string,
  parentIdentity: FileIdentity,
  readFile: typeof readRegularFile = readRegularFile,
): Promise<ConcurrentTargetObservation> {
  const observed = await readObservedTarget(
    filePath,
    containmentRoot,
    parentIdentity,
    readFile,
  );
  if (observed === undefined) return { kind: 'absent' };
  if (observed.snapshot.content !== content || observed.snapshot.mode !== mode) {
    return { kind: 'different' };
  }
  if (observed.linkCount !== 1n) return { kind: 'linked', snapshot: observed.snapshot };
  return { kind: 'identical', snapshot: observed.snapshot };
}

async function readIdenticalTargetAfterConflict(
  filePath: string,
  content: string,
  mode: number,
  containmentRoot: string,
  parentIdentity: FileIdentity,
  planned: RegularFileSnapshot | undefined,
  readFile: typeof readRegularFile = readRegularFile,
): Promise<RegularFileSnapshot | undefined> {
  let settlingCandidate: RegularFileSnapshot | undefined;
  let lastObservation: ConcurrentTargetObservation | undefined;
  let lastHadPendingArtifact = false;
  for (let attempt = 0; attempt < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    let observation: ConcurrentTargetObservation;
    try {
      observation = await observeConcurrentTarget(
        filePath,
        content,
        mode,
        containmentRoot,
        parentIdentity,
        readFile,
      );
    } catch (error) {
      if (!isTargetConflict(error, filePath)) throw error;
      if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
        await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
        continue;
      }
      throw new KiokukoError('CONFLICT', 'Concurrent target mutation did not settle', {
        target: filePath,
      });
    }
    if (settlingCandidate !== undefined) {
      if (observation.kind === 'absent') return undefined;
      if (observation.kind === 'different'
        || !sameRegularFileSnapshot(settlingCandidate, observation.snapshot)) {
        throw new KiokukoError('CONFLICT', 'Concurrent target changed while settling', {
          target: filePath,
        });
      }
    }
    lastObservation = observation;
    if (observation.kind === 'different') return undefined;
    if (observation.kind === 'absent') {
      if (planned === undefined) return undefined;
      const pending = await readPendingAtomicMutation(filePath, parentIdentity, containmentRoot);
      if (pending === undefined
        || pending.kind !== 'previous'
        || !sameRegularFileSnapshot(pending.snapshot, planned)) {
        return undefined;
      }
      lastHadPendingArtifact = true;
    } else if (observation.kind === 'linked') {
      settlingCandidate = observation.snapshot;
      lastHadPendingArtifact = false;
    } else {
      if (planned !== undefined
        && sameFileIdentity(observation.snapshot.identity, planned.identity)) {
        throw new KiokukoError(
          'CONFLICT',
          'Concurrent target was modified in place instead of atomically replaced',
          { target: filePath },
        );
      }
      const pending = await readPendingAtomicMutation(filePath, parentIdentity, containmentRoot);
      if (pending === undefined) return observation.snapshot;
      if (planned === undefined
        || pending.kind !== 'previous'
        || !sameRegularFileSnapshot(pending.snapshot, planned)) {
        throw new KiokukoError(
          'CONFLICT',
          'Concurrent target retained an incompatible atomic artifact',
          { target: filePath },
        );
      }
      settlingCandidate = observation.snapshot;
      lastHadPendingArtifact = true;
    }
    if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
      await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
    }
  }
  if (lastObservation?.kind === 'linked') {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'Refusing to adopt a hard-linked concurrent target',
      { target: filePath },
    );
  }
  if (lastHadPendingArtifact) {
    throw new KiokukoError('CONFLICT', 'Concurrent target mutation did not settle', {
      target: filePath,
    });
  }
  return undefined;
}

async function writeOrConvergeIdentical(
  dependencies: Required<Pick<UseCommandDependencies, 'atomicWriteTextIfUnchanged'>>,
  filePath: string,
  content: string,
  planned: RegularFileSnapshot | undefined,
  mode: number,
  containmentRoot: string,
  parentIdentity: FileIdentity,
  readFile: typeof readRegularFile = readRegularFile,
): Promise<ResolvedWrite> {
  try {
    const outcome = await dependencies.atomicWriteTextIfUnchanged(
      filePath,
      content,
      expectation(planned, containmentRoot, parentIdentity),
      mode,
    );
    return {
      snapshot: outcome.installed,
      owned: true,
      cleanupFailures: outcome.cleanupFailures,
    };
  } catch (error) {
    if (!isTargetConflict(error, filePath)) throw error;
    const current = await readIdenticalTargetAfterConflict(
      filePath,
      content,
      mode,
      containmentRoot,
      parentIdentity,
      planned,
      readFile,
    );
    if (current === undefined) throw error;
    return { snapshot: current, owned: false, cleanupFailures: [] };
  }
}

async function writeStrict(
  dependencies: Required<Pick<UseCommandDependencies, 'atomicWriteTextIfUnchanged'>>,
  filePath: string,
  content: string,
  planned: RegularFileSnapshot | undefined,
  mode: number,
  containmentRoot: string,
  parentIdentity: FileIdentity,
): Promise<ResolvedWrite> {
  const outcome = await dependencies.atomicWriteTextIfUnchanged(
    filePath,
    content,
    expectation(planned, containmentRoot, parentIdentity),
    mode,
  );
  return {
    snapshot: outcome.installed,
    owned: true,
    cleanupFailures: outcome.cleanupFailures,
  };
}

async function readSettledBindingSnapshot(
  bindingFile: string,
  repositoryRoot: string,
  bindingParentIdentity: FileIdentity,
  readFile: typeof readRegularFile = readRegularFile,
): Promise<SettledBindingSnapshot> {
  let candidate: RegularFileSnapshot | undefined;
  let pendingOriginal: RegularFileSnapshot | undefined;
  let sawPending = false;
  let observedConcurrentChange = false;
  let lastState: 'linked' | 'pending' | undefined;
  for (let attempt = 0; attempt < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    let observed: ObservedTarget | undefined;
    try {
      observed = await readObservedTarget(
        bindingFile,
        repositoryRoot,
        bindingParentIdentity,
        readFile,
      );
    } catch (error) {
      if (!isTargetConflict(error, bindingFile)) throw error;
      observedConcurrentChange = true;
      lastState = 'pending';
      if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
        await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
        continue;
      }
      break;
    }
    let pending = await readPendingAtomicMutation(
      bindingFile,
      bindingParentIdentity,
      repositoryRoot,
    );
    if (observed === undefined && candidate !== undefined) {
      throw new KiokukoError('CONFLICT', 'Repository binding disappeared while settling', {
        target: bindingFile,
      });
    }
    if (observed === undefined && pending === undefined) {
      try {
        observed = await readObservedTarget(
          bindingFile,
          repositoryRoot,
          bindingParentIdentity,
          readFile,
        );
      } catch (error) {
        if (!isTargetConflict(error, bindingFile)) throw error;
        observedConcurrentChange = true;
        lastState = 'pending';
        if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
          await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
          continue;
        }
        break;
      }
      if (observed === undefined) {
        pending = await readPendingAtomicMutation(
          bindingFile,
          bindingParentIdentity,
          repositoryRoot,
        );
        if (pending === undefined) {
          if (sawPending) {
            throw new KiokukoError(
              'CONFLICT',
              'Concurrent repository binding mutation ended without a target',
              { target: bindingFile },
            );
          }
          return { snapshot: undefined, observedConcurrentChange };
        }
      }
    }
    if (pending !== undefined) {
      sawPending = true;
      if (pending.kind !== 'previous'
        || (pendingOriginal !== undefined
          && !sameRegularFileSnapshot(pendingOriginal, pending.snapshot))) {
        throw new KiokukoError(
          'CONFLICT',
          'Repository binding has an incompatible atomic artifact',
          { target: bindingFile },
        );
      }
      pendingOriginal = pending.snapshot;
    }
    if (observed !== undefined) {
      if (candidate !== undefined && !sameRegularFileSnapshot(candidate, observed.snapshot)) {
        throw new KiokukoError('CONFLICT', 'Repository binding changed while settling', {
          target: bindingFile,
        });
      }
      candidate = observed.snapshot;
      if (pending === undefined && observed.linkCount === 1n) {
        return { snapshot: observed.snapshot, observedConcurrentChange };
      }
      lastState = pending === undefined ? 'linked' : 'pending';
    } else {
      lastState = 'pending';
    }
    if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
      await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
    }
  }
  if (lastState === 'linked') {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'Refusing to plan from a hard-linked repository binding file',
      { target: bindingFile },
    );
  }
  throw new KiokukoError('CONFLICT', 'Concurrent repository binding mutation did not settle', {
    target: bindingFile,
  });
}

async function readConcurrentBinding(
  bindingFile: string,
  repositoryRoot: string,
  requestedAgentFile: string,
  bindingParentIdentity: FileIdentity,
  readFile: typeof readRegularFile,
): Promise<ProjectConfig> {
  const { snapshot } = await readSettledBindingSnapshot(
    bindingFile,
    repositoryRoot,
    bindingParentIdentity,
    readFile,
  );
  const binding = parseBindingSnapshot(snapshot);
  if (snapshot === undefined || binding === undefined) {
    throw new KiokukoError(
      'CONFLICT',
      'Concurrent repository binding disappeared during convergence',
      { target: bindingFile },
    );
  }
  if (snapshot.content !== bindingText(binding)
    || (process.platform !== 'win32' && snapshot.mode !== 0o644)
    || binding.agentFile !== requestedAgentFile
    || binding.templateVersion !== AGENT_TEMPLATE_VERSION) {
    throw new KiokukoError(
      'CONFLICT',
      'Concurrent use operation created an incompatible repository binding',
      { target: bindingFile },
    );
  }
  return binding;
}

async function readSettledAgentPlan(
  filePath: string,
  containmentRoot: string,
  parentIdentity: FileIdentity,
  forbiddenBindingIdentity?: FileIdentity,
  intendedFromOriginal?: (
    original: RegularFileSnapshot,
  ) => { content: string; mode: number } | undefined,
  readFile: typeof readRegularFile = readRegularFile,
): Promise<RegularFileSnapshot | undefined> {
  const continuePendingMutation = async (
    pending: PendingAtomicMutation,
    observedFinalCandidate?: RegularFileSnapshot,
  ): Promise<RegularFileSnapshot> => {
    const intended = pending.kind === 'previous'
      ? intendedFromOriginal?.(pending.snapshot)
      : undefined;
    if (intended === undefined) {
      throw new KiokukoError(
        'CONFLICT',
        'Agent target is absent during an incompatible atomic mutation',
        { target: filePath },
      );
    }
    if (observedFinalCandidate !== undefined
      && (observedFinalCandidate.content !== intended.content
        || observedFinalCandidate.mode !== intended.mode)) {
      throw new KiokukoError(
        'CONFLICT',
        'Observed agent target is not the intended atomic result',
        { target: filePath },
      );
    }
    // The retried reader verifies the pending artifact on every observation.
    // Let it settle a transient restored-original state instead of rejecting
    // before the concurrent atomic mutation has finished cleaning up.
    const settled = await readRetriedAgentPlan(
      filePath,
      pending.snapshot,
      intended.content,
      intended.mode,
      containmentRoot,
      parentIdentity,
      forbiddenBindingIdentity,
      observedFinalCandidate,
    );
    if (settled === undefined) {
      throw new KiokukoError('CONFLICT', 'Concurrent agent mutation did not settle', {
        target: filePath,
      });
    }
    return settled;
  };
  let linkedCandidate: RegularFileSnapshot | undefined;
  for (let attempt = 0; attempt < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    let observed: ObservedTarget | undefined;
    try {
      observed = await readObservedTarget(
        filePath,
        containmentRoot,
        parentIdentity,
        readFile,
      );
    } catch (error) {
      if (!isTargetConflict(error, filePath)) throw error;
      if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
        await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
        continue;
      }
      throw new KiokukoError('CONFLICT', 'Concurrent agent mutation did not settle', {
        target: filePath,
      });
    }
    if (observed === undefined && linkedCandidate !== undefined) {
      throw new KiokukoError('CONFLICT', 'Agent target disappeared while settling', {
        target: filePath,
      });
    }
    if (observed === undefined) {
      let pending = await readPendingAtomicMutation(filePath, parentIdentity, containmentRoot);
      if (pending === undefined) {
        try {
          observed = await readObservedTarget(
            filePath,
            containmentRoot,
            parentIdentity,
            readFile,
          );
        } catch (error) {
          if (!isTargetConflict(error, filePath)) throw error;
          if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
            await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
            continue;
          }
          throw new KiokukoError('CONFLICT', 'Concurrent agent mutation did not settle', {
            target: filePath,
          });
        }
        if (observed === undefined) {
          pending = await readPendingAtomicMutation(filePath, parentIdentity, containmentRoot);
          if (pending === undefined) return undefined;
        }
      }
      if (observed === undefined) {
        if (pending === undefined) {
          throw new KiokukoError('INTEGRITY_ERROR', 'Atomic quarantine observation was lost');
        }
        return continuePendingMutation(pending);
      }
    }
    if (forbiddenBindingIdentity !== undefined
      && sameFileIdentity(observed.snapshot.identity, forbiddenBindingIdentity)) {
      throw new KiokukoError('CONFLICT', 'agentFile resolves to the repository binding file');
    }
    if (linkedCandidate !== undefined
      && !sameRegularFileSnapshot(linkedCandidate, observed.snapshot)) {
      throw new KiokukoError('CONFLICT', 'Agent target changed while settling', {
        target: filePath,
      });
    }
    linkedCandidate = observed.snapshot;
    if (observed.linkCount === 1n) {
      const pending = await readPendingAtomicMutation(filePath, parentIdentity, containmentRoot);
      if (pending === undefined) return observed.snapshot;
      return continuePendingMutation(pending, observed.snapshot);
    }
    if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
      await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
    }
  }
  throw new KiokukoError(
    'SECURITY_REJECTION',
    'Refusing to plan from a hard-linked agent target',
    { target: filePath },
  );
}

async function readRetriedAgentPlan(
  filePath: string,
  initial: RegularFileSnapshot | undefined,
  intendedContent: string | undefined,
  intendedMode: number,
  containmentRoot: string,
  parentIdentity: FileIdentity,
  forbiddenBindingIdentity?: FileIdentity,
  initialFinalCandidate?: RegularFileSnapshot,
  readFile: typeof readRegularFile = readRegularFile,
): Promise<RegularFileSnapshot | undefined> {
  let finalCandidate = initialFinalCandidate;
  let linkedCandidate: RegularFileSnapshot | undefined;
  let lastWasLinked = false;
  for (let attempt = 0; attempt < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS; attempt += 1) {
    let observed: ObservedTarget | undefined;
    try {
      observed = await readObservedTarget(
        filePath,
        containmentRoot,
        parentIdentity,
        readFile,
      );
    } catch (error) {
      if (!isTargetConflict(error, filePath)) throw error;
      if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
        await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
        continue;
      }
      throw new KiokukoError('CONFLICT', 'Concurrent agent mutation did not settle', {
        target: filePath,
      });
    }
    if (observed === undefined) {
      lastWasLinked = false;
      if (linkedCandidate !== undefined || finalCandidate !== undefined) {
        throw new KiokukoError('CONFLICT', 'Concurrent agent target disappeared while settling', {
          target: filePath,
        });
      }
      const pending = await readPendingAtomicMutation(filePath, parentIdentity, containmentRoot);
      if (initial === undefined) {
        if (pending !== undefined) {
          throw new KiokukoError(
            'CONFLICT',
            'An unexpected atomic quarantine appeared for an initially absent agent target',
            { target: filePath },
          );
        }
        return undefined;
      }
      if (pending === undefined
        || pending.kind !== 'previous'
        || !sameRegularFileSnapshot(pending.snapshot, initial)) {
        throw new KiokukoError(
          'CONFLICT',
          'Agent target disappeared outside its exact atomic quarantine',
          { target: filePath },
        );
      }
    } else {
      if (forbiddenBindingIdentity !== undefined
        && sameFileIdentity(observed.snapshot.identity, forbiddenBindingIdentity)) {
        throw new KiokukoError('CONFLICT', 'agentFile resolves to the repository binding file');
      }
      if (linkedCandidate !== undefined
        && !sameRegularFileSnapshot(linkedCandidate, observed.snapshot)) {
        throw new KiokukoError('CONFLICT', 'Concurrent agent target changed while settling', {
          target: filePath,
        });
      }
      const isInitial = initial !== undefined
        && sameRegularFileSnapshot(observed.snapshot, initial);
      const isIntendedFinal = intendedContent !== undefined
        && observed.snapshot.content === intendedContent
        && observed.snapshot.mode === intendedMode
        && (initial === undefined
          || !sameFileIdentity(observed.snapshot.identity, initial.identity));
      if (finalCandidate !== undefined
        && !sameRegularFileSnapshot(finalCandidate, observed.snapshot)) {
        throw new KiokukoError('CONFLICT', 'Concurrent agent result changed while settling', {
          target: filePath,
        });
      }
      if (!isInitial && !isIntendedFinal) {
        throw new KiokukoError(
          'CONFLICT',
          'Concurrent agent target is neither the planned original nor the intended final state',
          { target: filePath },
        );
      }
      if (isIntendedFinal) finalCandidate = observed.snapshot;
      lastWasLinked = observed.linkCount !== 1n;
      if (lastWasLinked) {
        linkedCandidate = observed.snapshot;
      } else {
        const pending = await readPendingAtomicMutation(
          filePath,
          parentIdentity,
          containmentRoot,
        );
        if (pending === undefined) return observed.snapshot;
        if (initial === undefined
          || pending.kind !== 'previous'
          || !sameRegularFileSnapshot(pending.snapshot, initial)) {
          throw new KiokukoError(
            'CONFLICT',
            'Concurrent agent target retained an incompatible atomic artifact',
            { target: filePath },
          );
        }
      }
    }
    if (attempt + 1 < CONCURRENT_IDENTICAL_OBSERVATION_ATTEMPTS) {
      await delay(CONCURRENT_IDENTICAL_OBSERVATION_DELAY_MS);
    }
  }
  if (lastWasLinked) {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'Refusing to plan from a hard-linked concurrent agent target',
      { target: filePath },
    );
  }
  throw new KiokukoError('CONFLICT', 'Concurrent agent mutation did not settle', {
    target: filePath,
  });
}

async function useRepositoryAttempt(
  options: UseOptions = {},
  dependencyOverrides: UseCommandDependencies = {},
  allowConcurrentConvergence: boolean,
  allowConcurrentAgentConvergence: boolean,
  retryParents?: ConcurrentRetryParents,
): Promise<UseResult> {
  const dependencies = {
    atomicWriteTextIfUnchanged: dependencyOverrides.atomicWriteTextIfUnchanged ?? atomicWriteTextIfUnchanged,
    unlinkRegularFileIfUnchanged: dependencyOverrides.unlinkRegularFileIfUnchanged ?? unlinkRegularFileIfUnchanged,
    readBindingFileForConvergence: dependencyOverrides.readBindingFileForConvergence ?? readRegularFile,
    readAgentFileForConvergence: dependencyOverrides.readAgentFileForConvergence ?? readRegularFile,
    registerRepositoryAndLocation: dependencyOverrides.registerRepositoryAndLocation ?? registerRepositoryAndLocation,
    openConnection: dependencyOverrides.openConnection ?? openConnection,
  };
  const rootOptions: Parameters<typeof detectRepositoryRoot>[0] = {};
  if (options.cwd !== undefined) rootOptions.cwd = options.cwd;
  if (options.root !== undefined) rootOptions.root = options.root;
  if (options.allowDirectory !== undefined) rootOptions.allowDirectory = options.allowDirectory;
  const detected = detectRepositoryRoot(rootOptions);
  const repositoryRoot = detected.root;
  if (retryParents !== undefined && repositoryRoot !== retryParents.repositoryRoot) {
    throw new KiokukoError('CONFLICT', 'Repository root changed during concurrent binding convergence');
  }
  const bindingFile = path.join(repositoryRoot, '.kiokuko.json');
  const bindingParentIdentity = await existingParentIdentity(bindingFile);
  if (retryParents !== undefined
    && !sameFileIdentity(bindingParentIdentity, retryParents.bindingParentIdentity)) {
    throw new KiokukoError('CONFLICT', 'Repository root changed during concurrent binding convergence');
  }
  const bindingObservation = await readSettledBindingSnapshot(
    bindingFile,
    repositoryRoot,
    bindingParentIdentity,
    dependencies.readBindingFileForConvergence,
  );
  const bindingSnapshot = bindingObservation.snapshot;
  const existingBinding = parseBindingSnapshot(bindingSnapshot);
  if (existingBinding !== undefined && existingBinding.templateVersion > AGENT_TEMPLATE_VERSION) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      `Project binding templateVersion ${existingBinding.templateVersion} is newer than supported version ${AGENT_TEMPLATE_VERSION}`,
    );
  }
  if (options.forceRebind && existingBinding === undefined) {
    throw new KiokukoError('CONFLICT', 'Cannot rebind a repository without an existing project binding');
  }
  if (existingBinding && !options.forceRebind) {
    if (options.repositoryId !== undefined && existingBinding.repositoryId !== options.repositoryId) {
      throw new KiokukoError('CONFLICT', 'Existing binding uses another repository ID; pass --force-rebind to change it');
    }
    if (options.workspace !== undefined && existingBinding.workspace !== options.workspace) {
      throw new KiokukoError('CONFLICT', 'Existing binding uses another workspace; pass --force-rebind to change it');
    }
  }

  const requestedAgentFile = options.agentFile ?? existingBinding?.agentFile ?? 'AGENTS.md';
  const identityOptions: Parameters<typeof createRepositoryIdentity>[0] = { repositoryRoot };
  const remote = readGitOrigin(repositoryRoot);
  if (remote !== undefined) identityOptions.remoteUrl = remote;
  if (existingBinding && options.forceRebind) {
    if (options.repositoryId === undefined && options.workspace === undefined) {
      throw new KiokukoError('CONFLICT', 'Forced rebind requires a different target identity');
    }
    identityOptions.repositoryId = options.repositoryId ?? `repo_${randomUUID()}`;
    if (options.workspace !== undefined) identityOptions.workspace = options.workspace;
  } else if (existingBinding) {
    identityOptions.existingBinding = {
      repositoryId: existingBinding.repositoryId,
      workspace: existingBinding.workspace,
    };
  } else {
    if (options.repositoryId !== undefined) identityOptions.repositoryId = options.repositoryId;
    if (options.workspace !== undefined) identityOptions.workspace = options.workspace;
  }
  const identity = createRepositoryIdentity(identityOptions);
  if (existingBinding && options.forceRebind
    && (identity.repositoryId === existingBinding.repositoryId
      || identity.workspace === existingBinding.workspace)) {
    throw new KiokukoError(
      'CONFLICT',
      'Forced rebind requires both a different repository ID and a different workspace',
    );
  }

  // Validate the exact serialized binding before resolving, reading, initializing,
  // or writing anything. Absolute and non-canonical lexical paths cannot persist.
  const nextBinding = parseProjectConfig({
    schemaVersion: 1,
    repositoryId: identity.repositoryId,
    workspace: identity.workspace,
    agentFile: requestedAgentFile,
    templateVersion: AGENT_TEMPLATE_VERSION,
  });
  const agentFile = ensureChildPath(repositoryRoot, nextBinding.agentFile);
  const agentParentIdentity = await existingParentIdentity(agentFile);
  if (retryParents !== undefined
    && !sameFileIdentity(agentParentIdentity, retryParents.agentParentIdentity)) {
    throw new KiokukoError('CONFLICT', 'agentFile parent changed during concurrent binding convergence');
  }
  const agentTemplateValues = {
    repositoryId: identity.repositoryId,
    workspace: identity.workspace,
    cliCommand: preferredCliCommand(),
    templateVersion: AGENT_TEMPLATE_VERSION,
  };
  const retryRendered = retryParents === undefined || options.noAgentFile
    ? undefined
    : renderAgentFile(retryParents.agentSnapshot?.content, agentTemplateValues);
  const plannedAgent = retryParents === undefined
    ? await readSettledAgentPlan(
        agentFile,
        repositoryRoot,
        agentParentIdentity,
        bindingSnapshot?.identity,
        options.noAgentFile
          ? undefined
          : (original) => ({
              content: renderAgentFile(original.content, agentTemplateValues).content,
              mode: original.mode,
            }),
        dependencies.readAgentFileForConvergence,
      )
    : await readRetriedAgentPlan(
        agentFile,
        retryParents.agentSnapshot,
        retryRendered?.action === 'unchanged' ? undefined : retryRendered?.content,
        retryParents.agentSnapshot?.mode ?? 0o644,
        repositoryRoot,
        agentParentIdentity,
        bindingSnapshot?.identity,
        undefined,
        dependencies.readAgentFileForConvergence,
      );
  assertSupportedManagedTemplate(plannedAgent, 'Prospective agentFile');
  const existingAgent = options.noAgentFile ? undefined : plannedAgent;
  if (options.noAgentFile && plannedAgent !== undefined) {
    const plannedManagedBlock = removeManagedBlock(plannedAgent.content);
    if (plannedManagedBlock.action !== 'absent'
      && renderAgentFile(plannedAgent.content, agentTemplateValues).action !== 'unchanged') {
      throw new KiokukoError(
        'CONFLICT',
        'Cannot use --no-agent-file while the prospective agentFile contains a stale managed block',
      );
    }
  }
  if (bindingSnapshot !== undefined
    && plannedAgent !== undefined
    && bindingSnapshot.identity.device === plannedAgent.identity.device
    && bindingSnapshot.identity.inode === plannedAgent.identity.inode) {
    throw new KiokukoError('CONFLICT', 'agentFile resolves to the repository binding file');
  }
  const previousAgentFile = existingBinding !== undefined
    && existingBinding.agentFile !== nextBinding.agentFile
    ? ensureChildPath(repositoryRoot, existingBinding.agentFile)
    : undefined;
  const previousAgentParentIdentity = previousAgentFile === undefined
    ? bindingParentIdentity
    : await existingParentIdentity(previousAgentFile);
  const previousAgent = previousAgentFile === undefined
    ? undefined
    : await readStrictSettledTarget(
      previousAgentFile,
      repositoryRoot,
      previousAgentParentIdentity,
      'Previous agentFile',
    );
  assertSupportedManagedTemplate(previousAgent, 'Previous agentFile');
  if (bindingSnapshot !== undefined
    && previousAgent !== undefined
    && bindingSnapshot.identity.device === previousAgent.identity.device
    && bindingSnapshot.identity.inode === previousAgent.identity.inode) {
    throw new KiokukoError('CONFLICT', 'Previous agentFile resolves to the repository binding file');
  }
  if (previousAgent !== undefined
    && plannedAgent !== undefined
    && previousAgent.identity.device === plannedAgent.identity.device
    && previousAgent.identity.inode === plannedAgent.identity.inode) {
    throw new KiokukoError('CONFLICT', 'Old and new agentFile paths resolve to the same regular file');
  }
  const previousAgentRemoval = previousAgent === undefined
    ? undefined
    : removeManagedBlock(previousAgent.content);
  const nextBindingText = bindingText(nextBinding);
  const gitignoreFile = path.join(repositoryRoot, '.gitignore');
  const shouldIgnoreNewBinding = options.ensureNewBindingIgnored === true
    && existingBinding === undefined;
  const gitignoreSnapshot = shouldIgnoreNewBinding
    ? await readStrictSettledTarget(
        gitignoreFile,
        repositoryRoot,
        bindingParentIdentity,
        'Project .gitignore',
      )
    : undefined;
  const renderedGitignore = shouldIgnoreNewBinding
    ? renderProjectGitignore(gitignoreSnapshot?.content)
    : undefined;
  const rendered = options.noAgentFile
    ? undefined
    : renderAgentFile(existingAgent?.content, agentTemplateValues);
  const databasePath = options.databasePath ?? getGlobalDatabasePath();
  const result: UseResult = {
    repositoryRoot,
    repositoryId: identity.repositoryId,
    workspace: identity.workspace,
    databasePath,
    bindingFile,
    agentFile: options.noAgentFile ? null : agentFile,
    agentFileAction: options.noAgentFile ? 'skipped' : rendered?.action ?? 'unchanged',
    bindingAction: options.dryRun ? 'planned' : bindingAction(bindingSnapshot?.content, nextBindingText),
    dryRun: options.dryRun ?? false,
    templateVersion: AGENT_TEMPLATE_VERSION,
  };
  if (options.dryRun) return result;

  const initOptions: Parameters<typeof initializeDatabase>[0] = { databasePath };
  if (options.migrationsDirectory !== undefined) initOptions.migrationsDirectory = options.migrationsDirectory;
  await initializeDatabase(initOptions);

  const installed: InstalledFile[] = [];
  try {
    let resolvedBinding = bindingSnapshot;
    if (result.bindingAction !== 'unchanged') {
      try {
        const resolution = bindingSnapshot === undefined
          ? await writeOrConvergeIdentical(
              dependencies,
              bindingFile,
              nextBindingText,
              bindingSnapshot,
              0o644,
              repositoryRoot,
              bindingParentIdentity,
              dependencies.readBindingFileForConvergence,
            )
          : await writeStrict(
              dependencies,
              bindingFile,
              nextBindingText,
              bindingSnapshot,
              bindingSnapshot.mode,
              repositoryRoot,
              bindingParentIdentity,
            );
        resolvedBinding = resolution.snapshot;
        if (resolution.owned) {
          installed.push({
            path: bindingFile,
            original: bindingSnapshot,
            installed: resolution.snapshot,
            containmentRoot: repositoryRoot,
            parentIdentity: bindingParentIdentity,
          });
        }
        assertAtomicCleanupComplete(resolution);
      } catch (error) {
        if (error instanceof AtomicCommittedMutationError) {
          installed.push({
            path: bindingFile,
            original: bindingSnapshot,
            installed: error.outcome.installed,
            containmentRoot: repositoryRoot,
            parentIdentity: bindingParentIdentity,
          });
        } else if (error instanceof AtomicCommittedUnlinkError && bindingSnapshot !== undefined) {
          installed.push({
            path: bindingFile,
            original: bindingSnapshot,
            installed: undefined,
            containmentRoot: repositoryRoot,
            parentIdentity: bindingParentIdentity,
          });
        }
        if (allowConcurrentConvergence
          && isTargetConflict(error, bindingFile)
          && bindingSnapshot === undefined
          && existingBinding === undefined
          && options.repositoryId === undefined
          && options.workspace === undefined) {
          throw new ConcurrentUseBinding(
            await readConcurrentBinding(
              bindingFile,
              repositoryRoot,
              requestedAgentFile,
              bindingParentIdentity,
              dependencies.readBindingFileForConvergence,
            ),
          );
        }
        throw error;
      }
    } else if (bindingSnapshot !== undefined) {
      await assertFileExpectation(
        bindingFile,
        expectation(bindingSnapshot, repositoryRoot, bindingParentIdentity),
      );
      resolvedBinding = bindingSnapshot;
    }

    let resolvedGitignore = gitignoreSnapshot;
    if (renderedGitignore !== undefined && renderedGitignore.action !== 'unchanged') {
      try {
        const resolution = await writeOrConvergeIdentical(
          dependencies,
          gitignoreFile,
          renderedGitignore.content,
          gitignoreSnapshot,
          gitignoreSnapshot?.mode ?? 0o644,
          repositoryRoot,
          bindingParentIdentity,
        );
        resolvedGitignore = resolution.snapshot;
        if (resolution.owned) {
          installed.push({
            path: gitignoreFile,
            original: gitignoreSnapshot,
            installed: resolution.snapshot,
            containmentRoot: repositoryRoot,
            parentIdentity: bindingParentIdentity,
          });
        }
        assertAtomicCleanupComplete(resolution);
      } catch (error) {
        if (error instanceof AtomicCommittedMutationError) {
          installed.push({
            path: gitignoreFile,
            original: gitignoreSnapshot,
            installed: error.outcome.installed,
            containmentRoot: repositoryRoot,
            parentIdentity: bindingParentIdentity,
          });
        }
        throw error;
      }
    } else if (renderedGitignore !== undefined && gitignoreSnapshot !== undefined) {
      await assertFileExpectation(
        gitignoreFile,
        expectation(gitignoreSnapshot, repositoryRoot, bindingParentIdentity),
      );
    }

    let resolvedAgent = existingAgent;
    if (rendered && rendered.action !== 'unchanged') {
      try {
        const resolution = !options.forceRebind
          || allowConcurrentAgentConvergence
          || bindingObservation.observedConcurrentChange
          ? await writeOrConvergeIdentical(
              dependencies,
              agentFile,
              rendered.content,
              existingAgent,
              existingAgent?.mode ?? 0o644,
              repositoryRoot,
              agentParentIdentity,
              dependencies.readAgentFileForConvergence,
            )
          : await writeStrict(
              dependencies,
              agentFile,
              rendered.content,
              existingAgent,
              existingAgent?.mode ?? 0o644,
              repositoryRoot,
              agentParentIdentity,
            );
        resolvedAgent = resolution.snapshot;
        if (resolution.owned) {
          installed.push({
            path: agentFile,
            original: existingAgent,
            installed: resolution.snapshot,
            containmentRoot: repositoryRoot,
            parentIdentity: agentParentIdentity,
          });
        }
        assertAtomicCleanupComplete(resolution);
      } catch (error) {
        if (error instanceof AtomicCommittedMutationError) {
          installed.push({
            path: agentFile,
            original: existingAgent,
            installed: error.outcome.installed,
            containmentRoot: repositoryRoot,
            parentIdentity: agentParentIdentity,
          });
        } else if (error instanceof AtomicCommittedUnlinkError && existingAgent !== undefined) {
          installed.push({
            path: agentFile,
            original: existingAgent,
            installed: undefined,
            containmentRoot: repositoryRoot,
            parentIdentity: agentParentIdentity,
          });
        }
        throw error;
      }
    } else if (rendered && existingAgent !== undefined) {
      await assertFileExpectation(
        agentFile,
        expectation(existingAgent, repositoryRoot, agentParentIdentity),
      );
      resolvedAgent = existingAgent;
    }

    let resolvedPreviousAgent = previousAgent;
    if (previousAgentFile !== undefined
      && previousAgent !== undefined
      && previousAgentRemoval?.action === 'updated'
      && previousAgentRemoval.content !== undefined) {
      try {
        const outcome = await dependencies.atomicWriteTextIfUnchanged(
          previousAgentFile,
          previousAgentRemoval.content,
          expectation(previousAgent, repositoryRoot, previousAgentParentIdentity),
          previousAgent.mode,
        );
        resolvedPreviousAgent = outcome.installed;
        installed.push({
          path: previousAgentFile,
          original: previousAgent,
          installed: outcome.installed,
          containmentRoot: repositoryRoot,
          parentIdentity: previousAgentParentIdentity,
        });
        assertAtomicCleanupComplete(outcome);
      } catch (error) {
        if (error instanceof AtomicCommittedMutationError) {
          installed.push({
            path: previousAgentFile,
            original: previousAgent,
            installed: error.outcome.installed,
            containmentRoot: repositoryRoot,
            parentIdentity: previousAgentParentIdentity,
          });
        } else if (error instanceof AtomicCommittedUnlinkError) {
          installed.push({
            path: previousAgentFile,
            original: previousAgent,
            installed: undefined,
            containmentRoot: repositoryRoot,
            parentIdentity: previousAgentParentIdentity,
          });
        }
        throw error;
      }
    } else if (previousAgentFile !== undefined
      && previousAgent !== undefined
      && previousAgentRemoval?.action === 'deleted') {
      try {
        const outcome = await dependencies.unlinkRegularFileIfUnchanged(
          previousAgentFile,
          expectation(previousAgent, repositoryRoot, previousAgentParentIdentity),
        );
        resolvedPreviousAgent = undefined;
        installed.push({
          path: previousAgentFile,
          original: previousAgent,
          installed: undefined,
          containmentRoot: repositoryRoot,
          parentIdentity: previousAgentParentIdentity,
        });
        assertAtomicCleanupComplete(outcome);
      } catch (error) {
        if (error instanceof AtomicCommittedUnlinkError) {
          installed.push({
            path: previousAgentFile,
            original: previousAgent,
            installed: undefined,
            containmentRoot: repositoryRoot,
            parentIdentity: previousAgentParentIdentity,
          });
        }
        throw error;
      }
    }

    const finalBinding = (await readSettledBindingSnapshot(
      bindingFile,
      repositoryRoot,
      bindingParentIdentity,
      dependencies.readBindingFileForConvergence,
    )).snapshot;
    if (resolvedBinding === undefined
      || finalBinding === undefined
      || !sameRegularFileSnapshot(finalBinding, resolvedBinding)) {
      throw new KiokukoError('CONFLICT', 'Repository binding changed before registration', {
        target: bindingFile,
      });
    }
    if (renderedGitignore !== undefined) {
      await assertFileExpectation(
        gitignoreFile,
        expectation(resolvedGitignore, repositoryRoot, bindingParentIdentity),
      );
    }
    if (!options.noAgentFile) {
      await assertFileExpectation(
        agentFile,
        expectation(resolvedAgent, repositoryRoot, agentParentIdentity),
      );
    } else {
      await assertFileExpectation(
        agentFile,
        expectation(plannedAgent, repositoryRoot, agentParentIdentity),
      );
    }
    if (previousAgentFile !== undefined) {
      const finalPreviousAgent = await readStrictSettledTarget(
        previousAgentFile,
        repositoryRoot,
        previousAgentParentIdentity,
        'Previous agentFile',
      );
      if ((resolvedPreviousAgent === undefined) !== (finalPreviousAgent === undefined)
        || (resolvedPreviousAgent !== undefined
          && finalPreviousAgent !== undefined
          && !sameRegularFileSnapshot(resolvedPreviousAgent, finalPreviousAgent))) {
        throw new KiokukoError('CONFLICT', 'Previous agentFile changed before registration', {
          target: previousAgentFile,
        });
      }
    }

    const database = dependencies.openConnection(databasePath);
    try {
      dependencies.registerRepositoryAndLocation(database, {
        repositoryId: identity.repositoryId,
        workspace: identity.workspace,
        displayName: identity.displayName,
        canonicalRoot: repositoryRoot,
        remoteFingerprint: identity.remoteFingerprint,
        bindingSchemaVersion: 1,
        agentTemplateVersion: AGENT_TEMPLATE_VERSION,
        ...(options.forceRebind && existingBinding !== undefined
          ? {
              rebindFrom: {
                repositoryId: existingBinding.repositoryId,
                workspace: existingBinding.workspace,
              },
            }
          : {}),
      });
    } catch (registrationError) {
      try {
        database.close();
      } catch (closeError) {
        if (registrationError instanceof TransactionCommitUncertainError) {
          throw new UncertainRegistrationCloseError(registrationError, closeError);
        }
        throw new AggregateError(
          [registrationError, closeError],
          'Repository registration failed and closing the database connection also failed',
        );
      }
      throw registrationError;
    }
    try {
      database.close();
    } catch (closeError) {
      throw new CommittedRegistrationCloseError(closeError);
    }
  } catch (error) {
    if (error instanceof CommittedRegistrationCloseError
      || error instanceof TransactionCommitUncertainError
      || error instanceof UncertainRegistrationCloseError) {
      throw error;
    }
    const restorationFailures = await restoreInstalledWrites(installed, dependencies);
    if (restorationFailures.length > 0) {
      throw new AggregateError(
        [error, ...restorationFailures],
        'Repository setup failed and file restoration also failed',
      );
    }
    if (error instanceof ConcurrentUseBinding) {
      return useRepositoryAttempt(
        {
          ...options,
          repositoryId: error.binding.repositoryId,
          workspace: error.binding.workspace,
        },
        dependencyOverrides,
        false,
        true,
        {
          repositoryRoot,
          bindingParentIdentity,
          agentParentIdentity,
          agentSnapshot: plannedAgent,
        },
      );
    }
    throw error;
  }
  return result;
}

export async function useRepository(
  options: UseOptions = {},
  dependencyOverrides: UseCommandDependencies = {},
): Promise<UseResult> {
  return useRepositoryAttempt(options, dependencyOverrides, true, false);
}
