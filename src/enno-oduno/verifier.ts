import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { unwatchFile, watchFile, type Stats } from 'node:fs';
import type { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { canonicalDirectory } from '../repository/detect-root.js';
import { captureRepositoryState } from './repository-state.js';
import { assertVerifierCwd, parseVerifierSpec } from './schemas.js';
import type { VerifierRunResult, VerifierSpec } from './types.js';

const MAX_PREVIEW_BYTES = 8 * 1024;
const DESCENDANT_SETTLE_MS = 500;

export interface VerifierDependencies {
  spawn?: typeof spawn;
  now?: () => number;
  descendantSettleMs?: number;
}

function repositoryMutationAudit(repositoryRoot: string): { close: () => void; observed: () => boolean } {
  let changed = false;
  let baselineDigest: string | undefined;
  const watched: Array<{ target: string; listener: (current: Stats, previous: Stats) => void }> = [];
  try {
    baselineDigest = captureRepositoryState(repositoryRoot).digest;
  } catch {
    changed = true;
  }
  const observeRepositoryState = (): void => {
    if (changed || baselineDigest === undefined) return;
    try {
      if (captureRepositoryState(repositoryRoot).digest !== baselineDigest) changed = true;
    } catch {
      changed = true;
    }
  };
  try {
    const paths = execFileSync('git', [
      '-C', repositoryRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
    const targets = new Set([repositoryRoot]);
    const trackedFiles = new Set<string>();
    for (const candidate of paths) {
      const target = path.resolve(repositoryRoot, candidate);
      if (target !== repositoryRoot && !target.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('invalid Git path');
      targets.add(target);
      trackedFiles.add(target);
      targets.add(path.dirname(target));
    }
    for (const target of targets) {
      const listener = (current: Stats, previous: Stats): void => {
        if (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs
          || current.size !== previous.size || current.ino !== previous.ino) {
          if (trackedFiles.has(target)) changed = true;
          else observeRepositoryState();
        }
      };
      watchFile(target, { persistent: false, interval: 20 }, listener);
      watched.push({ target, listener });
    }
  } catch {
    // Evidence cannot be called mutation-free when the audit boundary is unavailable.
    changed = true;
  }
  return {
    close: () => watched.forEach(({ target, listener }) => unwatchFile(target, listener)),
    observed: () => {
      // File notifications are an optimization, not the completeness boundary:
      // a detached descendant can finish between polling callbacks.
      observeRepositoryState();
      return changed;
    },
  };
}

function appendPreview(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (current.byteLength >= MAX_PREVIEW_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_PREVIEW_BYTES - current.byteLength)]);
}

function digestHex(hash: ReturnType<typeof createHash>): string {
  return hash.digest('hex');
}

export async function runVerifier(
  rawVerifier: VerifierSpec,
  repositoryRoot: string,
  dependencies: VerifierDependencies = {},
): Promise<VerifierRunResult> {
  const verifier = parseVerifierSpec(rawVerifier);
  const canonicalRoot = canonicalDirectory(repositoryRoot);
  const canonicalCwd = canonicalDirectory(path.isAbsolute(verifier.cwd)
    ? verifier.cwd
    : path.resolve(canonicalRoot, verifier.cwd));
  const normalized = { ...verifier, cwd: canonicalCwd };
  assertVerifierCwd(canonicalRoot, normalized);

  const start = dependencies.now?.() ?? performance.now();
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stdoutPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderrPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = (dependencies.spawn ?? spawn)(normalized.executable, normalized.args, {
      cwd: normalized.cwd,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return {
      verifier: { ...verifier, args: [...verifier.args] },
      status: 'spawn_failed',
      exitCode: null,
      signal: null,
      durationMs: Math.max(0, Math.round((dependencies.now?.() ?? performance.now()) - start)),
      stdoutPreview: '',
      stderrPreview: '',
      stdoutDigest: createHash('sha256').digest('hex'),
      stderrDigest: createHash('sha256').digest('hex'),
    };
  }

  child.stdout.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutHash.update(bytes);
    stdoutPreview = appendPreview(stdoutPreview, bytes);
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrHash.update(bytes);
    stderrPreview = appendPreview(stderrPreview, bytes);
  });

  const completion = await new Promise<{ status: VerifierRunResult['status']; exitCode: number | null; signal: string | null }>((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceKillAttempted = false;
    const settle = (value: { status: VerifierRunResult['status']; exitCode: number | null; signal: string | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(value);
    };
    const tryKill = (signal: NodeJS.Signals): boolean => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          process.kill(-child.pid, signal);
          return true;
        }
        return child.kill(signal);
      } catch {
        return false;
      }
    };
    const forceKill = (): void => {
      if (settled || forceKillAttempted) return;
      forceKillAttempted = true;
      tryKill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (!tryKill('SIGTERM')) forceKill();
      if (!forceKillAttempted) {
        killTimer = setTimeout(forceKill, 1_000);
        killTimer.unref();
      }
    }, normalized.timeoutMs);
    timer.unref();
    child.on('error', () => {
      if (timedOut) {
        // A failed termination request is not completion; force the child down and wait for close.
        forceKill();
        return;
      }
      settle({ status: 'spawn_failed', exitCode: null, signal: null });
    });
    child.once('close', (code, signal) => {
      if (!timedOut) tryKill('SIGTERM');
      settle({
        status: timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed',
        exitCode: timedOut ? null : code,
        signal: timedOut ? signal ?? 'SIGTERM' : signal,
      });
    });
  });
  return {
    verifier: { ...verifier, args: [...verifier.args] },
    ...completion,
    durationMs: Math.max(0, Math.round((dependencies.now?.() ?? performance.now()) - start)),
    stdoutPreview: stdoutPreview.toString('utf8'),
    stderrPreview: stderrPreview.toString('utf8'),
    stdoutDigest: digestHex(stdoutHash),
    stderrDigest: digestHex(stderrHash),
  };
}

export async function runVerifiers(
  verifiers: readonly VerifierSpec[],
  repositoryRoot: string,
  dependencies: VerifierDependencies = {},
): Promise<VerifierRunResult[]> {
  const audit = repositoryMutationAudit(repositoryRoot);
  const results: VerifierRunResult[] = [];
  try {
    for (const verifier of verifiers) results.push(await runVerifier(verifier, repositoryRoot, dependencies));
    const settleMs = dependencies.descendantSettleMs ?? DESCENDANT_SETTLE_MS;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const changedDuringVerification = audit.observed();
    return results.map((result) => ({ ...result, changedDuringVerification }));
  } finally {
    audit.close();
  }
}
