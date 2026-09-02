import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findSecretInValue } from '../memory/secrets.js';

export const KIOKUKO_HOOK_TIMEOUT_MS = 10_000;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const MAX_CONTINUATION_BYTES = 16 * 1024;
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
  }): BunChild;
}

export interface HookEffectInput {
  sessionId: string;
  cwd: string;
}

export type HookDecision =
  | { kind: 'continue'; text: string }
  | { kind: 'skip'; reason: string };

export interface HookEffectDependencies {
  env?: NodeJS.ProcessEnv;
  spawn?: BunRuntime['spawn'];
  lstat?: typeof lstat;
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

async function trustedExecutable(
  env: NodeJS.ProcessEnv,
  check: typeof lstat,
): Promise<string | undefined> {
  const configured = boundedString(env.KIOKUKO_BIN, 4_096);
  const executable = configured ?? packageOwnedCli();
  if (!path.isAbsolute(executable)) return undefined;
  try {
    const status = await check(executable);
    if (!status.isFile() || status.isSymbolicLink()) return undefined;
    if (process.platform !== 'win32' && (status.mode & 0o111) === 0) return undefined;
    return executable;
  } catch {
    return undefined;
  }
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'skip', reason: 'invalid_response' };
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = ['continue', 'runId', 'status', 'directive', 'reason', 'warning', 'resumeToken', 'routeEpoch', 'executionLease'];
  const keys = Object.keys(candidate);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    return { kind: 'skip', reason: 'invalid_response' };
  }
  if (typeof candidate.continue !== 'boolean'
    || (candidate.runId !== null && typeof candidate.runId !== 'string')
    || (candidate.status !== null && typeof candidate.status !== 'string')
    || (candidate.directive !== null && (typeof candidate.directive !== 'object' || Array.isArray(candidate.directive)))
    || (candidate.reason !== null && typeof candidate.reason !== 'string')
    || (candidate.warning !== null && typeof candidate.warning !== 'string')
    || (candidate.resumeToken !== null && typeof candidate.resumeToken !== 'string')
    || (candidate.routeEpoch !== null && (typeof candidate.routeEpoch !== 'number'
      || !Number.isSafeInteger(candidate.routeEpoch) || candidate.routeEpoch < 0))
    || (candidate.executionLease !== null && (typeof candidate.executionLease !== 'object' || Array.isArray(candidate.executionLease)))
    || findSecretInValue(candidate) !== undefined) {
    return { kind: 'skip', reason: 'invalid_response' };
  }
  if (candidate.continue !== true) return { kind: 'skip', reason: 'continuation_not_requested' };
  const text = boundedString(candidate.reason, MAX_CONTINUATION_BYTES);
  if (text === undefined || findSecretInValue(text) !== undefined) {
    return { kind: 'skip', reason: 'unsafe_continuation' };
  }
  return { kind: 'continue', text };
}

/** Run the OpenCode hook through one argv-only, time-bounded subprocess. */
export async function runKiokukoHook(
  input: HookEffectInput,
  dependencies: HookEffectDependencies = {},
): Promise<HookDecision> {
  const sessionId = boundedString(input.sessionId, 256);
  const cwd = boundedString(input.cwd, 4_096);
  if (sessionId === undefined || cwd === undefined || findSecretInValue({ sessionId, cwd }) !== undefined) {
    return { kind: 'skip', reason: 'invalid_input' };
  }
  const spawn = dependencies.spawn ?? runtimeSpawn();
  if (spawn === undefined) return { kind: 'skip', reason: 'bun_unavailable' };
  const env = dependencies.env ?? process.env;
  const check = dependencies.lstat ?? lstat;
  const executable = await trustedExecutable(env, check);
  if (executable === undefined) return { kind: 'skip', reason: 'cli_unavailable' };
  const payload = JSON.stringify({ sessionId, cwd });
  let child: BunChild;
  try {
    child = spawn([executable, 'enno', 'hook', '--client', 'opencode', '--input-json', '-'], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    await child.stdin.write(payload);
    await child.stdin.end();
  } catch {
    return { kind: 'skip', reason: 'spawn_failed' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stdout = readBounded(child.stdout);
    const stderr = readBounded(child.stderr);
    const exitCode = child.exited;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error('timeout'));
      }, KIOKUKO_HOOK_TIMEOUT_MS);
    });
    const [output, , code] = await Promise.race([
      Promise.all([stdout, stderr, exitCode]),
      timeout,
    ]) as [string, string, number];
    if (code !== 0) return { kind: 'skip', reason: 'hook_failed' };
    try {
      return decisionFromOutput(JSON.parse(output));
    } catch {
      return { kind: 'skip', reason: 'invalid_response' };
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'timeout') return { kind: 'skip', reason: 'timeout' };
    return { kind: 'skip', reason: 'hook_failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await settleChild(child);
  }
}
