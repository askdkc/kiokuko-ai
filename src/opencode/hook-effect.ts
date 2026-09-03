import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findSecretInValue } from '../memory/secrets.js';
import { PACKAGE_VERSION } from '../package-version.js';
import {
  OPENCODE_HOOK_PROTOCOL_VERSION,
  inspectOpenCodeHookResponse,
} from './hook-protocol.js';

export const KIOKUKO_HOOK_TIMEOUT_MS = 10_000;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const CHILD_SETTLE_TIMEOUT_MS = 250;

interface BunPipe {
  write(value: string): void | Promise<void>;
  end(): void | Promise<void>;
}

interface BunChild {
  stdin: BunPipe;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

interface BunRuntime {
  spawn(argv: readonly string[], options: {
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
    cwd?: string;
  }): BunChild;
}

export interface HookEffectInput {
  sessionId: string;
  terminalMessageId: string;
  cwd: string;
}

export interface OpenCodeRuntimeInvocation {
  protocolVersion: typeof OPENCODE_HOOK_PROTOCOL_VERSION;
  packageVersion: typeof PACKAGE_VERSION;
  nodeExecutable: string;
  cliScript: string;
}

export type HookFailureReason =
  | 'adapter_unavailable'
  | 'runtime_unavailable'
  | 'cli_unavailable'
  | 'spawn_failed'
  | 'timeout'
  | 'hook_failed'
  | 'invalid_response'
  | 'version_mismatch'
  | 'unsafe_continuation'
  | 'cancelled';

export type HookDecision =
  | { kind: 'continue'; text: string }
  | { kind: 'stop'; reason: 'no_active_run' | 'ambiguous_run' | 'continuation_limit' }
  | { kind: 'failure'; retryable: boolean; reason: HookFailureReason };

export interface HookEffectDependencies {
  env?: NodeJS.ProcessEnv;
  spawn?: BunRuntime['spawn'];
  lstat?: typeof lstat;
  readFile?: typeof readFile;
  runtime?: OpenCodeRuntimeInvocation;
  runtimeFailure?: HookFailureReason;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u206f]/u.test(value)) {
    return undefined;
  }
  return value;
}

function runtimeSpawn(): BunRuntime['spawn'] | undefined {
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  return runtime?.spawn?.bind(runtime);
}

function packageOwnedCli(): string {
  return fileURLToPath(new URL('../bin/kiokuko.js', import.meta.url));
}

async function trustedFile(filePath: string, check: typeof lstat): Promise<boolean> {
  if (!path.isAbsolute(filePath)) return false;
  try {
    const status = await check(filePath);
    return status.isFile() && !status.isSymbolicLink()
      && (process.platform === 'win32' || (status.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

async function packageIdentityMatches(cliScript: string, read: typeof readFile): Promise<boolean> {
  try {
    const packagePath = path.resolve(path.dirname(cliScript), '..', '..', 'package.json');
    const value = JSON.parse(await read(packagePath, 'utf8')) as { name?: unknown; version?: unknown };
    return value.name === 'kiokuko-ai' && value.version === PACKAGE_VERSION;
  } catch {
    return false;
  }
}

async function trustedInvocation(
  dependencies: HookEffectDependencies,
): Promise<{ argv?: readonly string[]; failure?: 'cli_unavailable' | 'version_mismatch' }> {
  const check = dependencies.lstat ?? lstat;
  const read = dependencies.readFile ?? readFile;
  const runtime = dependencies.runtime;
  if (runtime !== undefined) {
    if (runtime.protocolVersion !== OPENCODE_HOOK_PROTOCOL_VERSION || runtime.packageVersion !== PACKAGE_VERSION) {
      return { failure: 'version_mismatch' };
    }
    if (!await trustedFile(runtime.nodeExecutable, check) || !await trustedFile(runtime.cliScript, check)) {
      return { failure: 'cli_unavailable' };
    }
    if (!await packageIdentityMatches(runtime.cliScript, read)) return { failure: 'version_mismatch' };
    return { argv: [runtime.nodeExecutable, runtime.cliScript] };
  }

  const nodeExecutable = process.execPath;
  const cliScript = packageOwnedCli();
  if (!await trustedFile(nodeExecutable, check) || !await trustedFile(cliScript, check)) return { failure: 'cli_unavailable' };
  if (!await packageIdentityMatches(cliScript, read)) return { failure: 'version_mismatch' };
  return { argv: [nodeExecutable, cliScript] };
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_HOOK_OUTPUT_BYTES) throw new Error('hook output exceeded bound');
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function settleChild(child: BunChild): Promise<void> {
  await Promise.race([
    child.exited.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, CHILD_SETTLE_TIMEOUT_MS)),
  ]);
}

function decisionFromOutput(value: unknown): HookDecision {
  const parsed = inspectOpenCodeHookResponse(value);
  if (!parsed.ok) return { kind: 'failure', retryable: false, reason: parsed.reason };
  const response = parsed.value;
  if (response.disposition === 'continue') {
    if (response.reason === null || response.reason.length === 0 || findSecretInValue(response.reason) !== undefined) {
      return { kind: 'failure', retryable: false, reason: 'unsafe_continuation' };
    }
    return { kind: 'continue', text: response.reason };
  }
  if (response.disposition === 'stop') {
    if (response.code === 'no_active_run' || response.code === 'ambiguous_run' || response.code === 'continuation_limit') {
      return { kind: 'stop', reason: response.code };
    }
    return { kind: 'failure', retryable: false, reason: 'invalid_response' };
  }
  switch (response.code) {
    case 'adapter_unavailable':
    case 'runtime_unavailable':
    case 'cli_unavailable':
    case 'spawn_failed':
    case 'timeout':
    case 'hook_failed':
      return { kind: 'failure', retryable: true, reason: response.code };
    case 'invalid_response':
    case 'version_mismatch':
    case 'unsafe_continuation':
      return { kind: 'failure', retryable: false, reason: response.code };
    default:
      return { kind: 'failure', retryable: false, reason: 'invalid_response' };
  }
}

function abortRace(signal: AbortSignal | undefined, child?: BunChild): {
  promise: Promise<never>;
  cleanup(): void;
} | undefined {
  if (signal === undefined) return undefined;
  let abort = (): void => undefined;
  const promise = new Promise<never>((_, reject) => {
    abort = (): void => {
      try { child?.kill(); } catch { /* cleanup is best-effort after cancellation */ }
      reject(new Error('cancelled'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  return { promise, cleanup: () => signal.removeEventListener('abort', abort) };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Run the OpenCode hook through one argv-only, time-bounded subprocess. */
export async function runKiokukoHook(
  input: HookEffectInput,
  dependencies: HookEffectDependencies = {},
): Promise<HookDecision> {
  const sessionId = boundedString(input.sessionId, 256);
  const terminalMessageId = boundedString(input.terminalMessageId, 256);
  const cwd = boundedString(input.cwd, 4_096);
  if (sessionId === undefined || terminalMessageId === undefined || cwd === undefined
    || findSecretInValue({ sessionId, terminalMessageId, cwd }) !== undefined) {
    return { kind: 'failure', retryable: false, reason: 'unsafe_continuation' };
  }
  if (isAborted(dependencies.signal)) return { kind: 'failure', retryable: true, reason: 'cancelled' };
  if (dependencies.runtimeFailure !== undefined) {
    return { kind: 'failure', retryable: false, reason: dependencies.runtimeFailure };
  }
  const spawn = dependencies.spawn ?? runtimeSpawn();
  if (spawn === undefined) return { kind: 'failure', retryable: true, reason: 'runtime_unavailable' };
  const invocation = await trustedInvocation(dependencies);
  if (invocation.argv === undefined) {
    return { kind: 'failure', retryable: invocation.failure !== 'version_mismatch', reason: invocation.failure ?? 'cli_unavailable' };
  }
  const payload = JSON.stringify({
    protocolVersion: OPENCODE_HOOK_PROTOCOL_VERSION,
    packageVersion: PACKAGE_VERSION,
    sessionId,
    terminalMessageId,
    cwd,
  });
  let child: BunChild | undefined;
  try {
    const spawned = spawn([...invocation.argv, 'enno', 'hook', '--input-json', '-'], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd,
    });
    child = spawned;
    const write = Promise.resolve(spawned.stdin.write(payload)).then(() => spawned.stdin.end());
    const cancellation = abortRace(dependencies.signal, spawned);
    try {
      await (cancellation === undefined ? write : Promise.race([write, cancellation.promise]));
    } finally {
      cancellation?.cleanup();
    }
  } catch {
    try { child?.kill(); } catch { /* preserve the public spawn failure */ }
    if (child !== undefined) await settleChild(child);
    if (isAborted(dependencies.signal)) return { kind: 'failure', retryable: true, reason: 'cancelled' };
    return { kind: 'failure', retryable: true, reason: 'spawn_failed' };
  }
  if (child === undefined) return { kind: 'failure', retryable: true, reason: 'spawn_failed' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stdout = readBounded(child.stdout);
    const stderr = readBounded(child.stderr);
    const exitCode = child.exited;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error('timeout'));
      }, dependencies.timeoutMs ?? KIOKUKO_HOOK_TIMEOUT_MS);
    });
    const work = Promise.all([stdout, stderr, exitCode]);
    const cancellation = abortRace(dependencies.signal, child);
    let settled;
    try {
      settled = await Promise.race(
        cancellation === undefined ? [work, timeout] : [work, timeout, cancellation.promise],
      );
    } finally {
      cancellation?.cleanup();
    }
    const [output, , code] = settled as [string, string, number];
    if (code !== 0) return { kind: 'failure', retryable: true, reason: 'hook_failed' };
    try {
      return decisionFromOutput(JSON.parse(output));
    } catch {
      return { kind: 'failure', retryable: false, reason: 'invalid_response' };
    }
  } catch (error) {
    try { child.kill(); } catch { /* the bounded settle below remains authoritative */ }
    if (error instanceof Error && error.message === 'timeout') return { kind: 'failure', retryable: true, reason: 'timeout' };
    if (error instanceof Error && error.message === 'cancelled') return { kind: 'failure', retryable: true, reason: 'cancelled' };
    return { kind: 'failure', retryable: true, reason: 'hook_failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await settleChild(child);
  }
}
