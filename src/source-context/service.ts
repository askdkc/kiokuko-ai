import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import * as z from 'zod/v4';
import { canonicalContentHash } from '../serialization/validate.js';
import { findSecretInValue } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';
import { sourceDirectory, readSourceConfig, managedBinary, privateSourceDirectory, RIPWIRE_VERSION, SOURCE_AUTO_ACCEPTED } from './config.js';
import { runSourceProcess, SourceFailure, type SourceRunner } from './process.js';
import { canonicalSourceRoot, sourceSnapshot } from './snapshot.js';
import { probeSourceBinary, releaseAsset } from './install.js';
import { finishSourceResult, projectSourceOutput, unavailableSource, type SourceResult } from './result.js';

export const sourceInputSchema = z.object({
  cwd: z.string().min(1).max(4096).refine(p => path.isAbsolute(p)),
  task: z.string().trim().min(1).max(8192), query: z.string().trim().min(1).max(8192).optional(),
  maxTokens: z.number().int().min(256).max(8000).optional(),
}).strict();
export type SourceInput = z.infer<typeof sourceInputSchema>;
export interface SourceDependencies { directory?: string; runner?: SourceRunner; signal?: AbortSignal }
export class SourceContextService {
  private readonly memo = new Map<string, SourceResult>();
  clear(): void { this.memo.clear(); }
  async inspect(raw: SourceInput, dependencies: SourceDependencies = {}): Promise<SourceResult> {
    const start = performance.now();
    const input = sourceInputSchema.parse(raw);
    const inputDigest = canonicalContentHash(input);
    if (findSecretInValue({ task: input.task, query: input.query })) return unavailableSource('unsafe_query', inputDigest, 0);
    const directory = dependencies.directory ?? sourceDirectory();
    let scratch: string | undefined;
    dependencies.signal?.throwIfAborted();
    try {
      releaseAsset();
      const config = await readSourceConfig(directory);
      if (config.mode === 'off') return unavailableSource('disabled', inputDigest, performance.now() - start);
      const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs);
      const runner = dependencies.runner ?? runSourceProcess;
      const binary = config.binaryPath ?? managedBinary(directory);
      await probeSourceBinary(binary, path.dirname(binary), signal, runner);
      const root = await canonicalSourceRoot(input.cwd, signal);
      const storage = await realpath(directory);
      if (storage === root || storage.startsWith(`${root}${path.sep}`)) throw new KiokukoError('SECURITY_REJECTION', 'Source storage must be outside the repository');
      const snapshot = await sourceSnapshot(root, signal);
      const maxTokens = input.maxTokens ?? config.maxTokens;
      const key = canonicalContentHash({ inputDigest, digest: snapshot.digest, maxTokens, config, binary: await realpath(binary), version: RIPWIRE_VERSION });
      const cached = this.memo.get(key);
      if (cached) {
        const after = await sourceSnapshot(root, signal);
        if (after.digest !== snapshot.digest) throw new SourceFailure('source_changed');
        return { ...structuredClone(cached), reused: true, durationMs: performance.now() - start };
      }
      await privateSourceDirectory(directory);
      const cacheDirectory = path.join(directory, 'cache');
      await privateSourceDirectory(cacheDirectory);
      scratch = await mkdtemp(path.join(cacheDirectory, '.source-'));
      for (const [name, bytes] of snapshot.files) {
        signal.throwIfAborted();
        const destination = path.join(scratch, name);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      }
      // Content-bound blobs cannot go stale after same-size/same-mtime source edits.
      // Scratch trees contain no repository configuration, executable scripts, links or document converters.
      const cache = path.join(cacheDirectory, `${canonicalContentHash({ root, snapshot: snapshot.digest, version: RIPWIRE_VERSION })}.ripwirecache`);
      const result = await runner({ executable: binary, cwd: scratch, signal,
        args: ['.', `--pack-task=${input.query ?? input.task}`, '--json', `--token-budget=${maxTokens}`, `--cache=${cache}`],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: scratch, TMPDIR: scratch,
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
      signal.throwIfAborted();
      if (result.code !== 0) throw new SourceFailure('analysis_failed');
      const projected = projectSourceOutput(result.stdout, result.stderr, snapshot, inputDigest);
      const after = await sourceSnapshot(root, signal);
      if (after.digest !== snapshot.digest) throw new SourceFailure('source_changed');
      projected.durationMs = performance.now() - start;
      const final = finishSourceResult(projected, config.maxOutputBytes);
      this.memo.set(key, structuredClone(final));
      if (this.memo.size > 8) this.memo.delete(this.memo.keys().next().value!);
      return final;
    } catch (error) {
      if (dependencies.signal?.aborted) throw dependencies.signal.reason;
      if (error instanceof KiokukoError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw new KiokukoError('SECURITY_REJECTION', 'Source files are not accessible');
      const reason = error instanceof SourceFailure ? error.reason : code === 'ENOENT' ? 'not_installed'
        : (error as Error).name === 'TimeoutError' ? 'timeout' : 'analysis_failed';
      return unavailableSource(reason, inputDigest, performance.now() - start);
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
}
export async function sourceStatus(directory = sourceDirectory()) {
  let config: Awaited<ReturnType<typeof readSourceConfig>> | undefined;
  try {
    config = await readSourceConfig(directory);
    releaseAsset();
    const binary = config.binaryPath ?? managedBinary(directory);
    await probeSourceBinary(binary, path.dirname(binary), AbortSignal.timeout(3000));
    return { status: 'ready', version: RIPWIRE_VERSION, source: config.binaryPath ? 'explicit' : 'managed', mode: config.mode,
      compatible: true, autoEnabled: config.mode === 'auto' && SOURCE_AUTO_ACCEPTED,
      reason: config.mode === 'off' ? 'disabled' : SOURCE_AUTO_ACCEPTED ? null : 'acceptance_pending' };
  } catch (error) {
    return { status: 'unavailable', version: null, source: config ? config.binaryPath ? 'explicit' : 'managed' : null,
      mode: config?.mode ?? null, disabledReason: config?.mode === 'off' ? 'disabled' : null, compatible: false, autoEnabled: false,
      reason: error instanceof SourceFailure ? error.reason : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_installed' : 'probe_failed' };
  }
}
