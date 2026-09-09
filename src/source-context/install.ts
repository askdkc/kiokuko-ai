import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rename, rm, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readReleaseArchive } from './archive.js';
import { managedBinary, privateSourceDirectory, RIPWIRE_VERSION } from './config.js';
import { runSourceProcess, SourceFailure, type SourceRunner } from './process.js';

export const RELEASES: Readonly<Record<string, string>> = Object.freeze({
  'linux-arm64': '9b82e4d13928974349730b9e713ff71118f5a65967753b03a3ce0b5e352be9c1',
  'linux-x64': 'fd0bd0fa849c0e08db59a6a7e5c2d3e9bc062d3089b54196daf9332cd21bbfc8',
  'macos-arm64': 'ee8392f4e48be2076f18558ebae08c51dd90d616988a396e14fcdbc192f7a53d',
  'macos-x64': '34c0b99dcdc3c592d2bc41bb3a34f95338cba5e4fa4fbd0b9579ae0b80bd47e8',
});
export function releaseAsset(platform = process.platform, arch: string = process.arch) {
  const key = `${platform === 'darwin' ? 'macos' : platform}-${arch}`;
  const sha256 = RELEASES[key];
  if (!sha256) throw new SourceFailure('unsupported_platform');
  const root = `ripwire-${RIPWIRE_VERSION}-${key}`;
  return { root, name: `${root}.tar.gz`, sha256,
    url: `https://github.com/redhat-et/ripwire/releases/download/v${RIPWIRE_VERSION}/${root}.tar.gz` };
}
export async function probeSourceBinary(binary: string, cwd: string, signal: AbortSignal, runner: SourceRunner = runSourceProcess): Promise<void> {
  const file = await lstat(binary);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o111) === 0) throw new SourceFailure('unsafe_binary');
  const result = await runner({ executable: binary, args: ['--version'], cwd, signal, stdoutLimit: 4096, stderrLimit: 4096 });
  if (result.code !== 0 || !/^ripwire 0\.4\.0(?:\s|$)/u.test(result.stdout.toString('utf8')))
    throw new SourceFailure('unsupported_version');
}
export async function downloadRelease(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const response = await fetcher(url, { signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new SourceFailure('download_failed');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    length += chunk.byteLength;
    if (length > 32 * 1024 * 1024) throw new SourceFailure('download_limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export interface InstallDependencies { signal?: AbortSignal; fetcher?: typeof fetch; runner?: SourceRunner; release?: ReturnType<typeof releaseAsset> }
/** Only this explicit operation downloads. Publish a complete, probed directory once. */
export async function setupSource(directory: string, dependencies: InstallDependencies = {}) {
  const asset = dependencies.release ?? releaseAsset();
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  await privateSourceDirectory(directory);
  const lock = path.join(directory, 'setup.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SourceFailure('setup_in_progress');
    throw error;
  }
  let staging: string | undefined;
  try {
    const destination = path.dirname(managedBinary(directory));
    try {
      await lstat(destination);
      await probeSourceBinary(managedBinary(directory), directory, signal, dependencies.runner);
      return { status: 'ready', version: RIPWIRE_VERSION, source: 'managed', reused: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const compressed = await downloadRelease(asset.url, signal, dependencies.fetcher);
    if (createHash('sha256').update(compressed).digest('hex') !== asset.sha256) throw new SourceFailure('checksum_mismatch');
    const archive = readReleaseArchive(compressed, asset.root);
    signal.throwIfAborted();
    staging = await mkdtemp(path.join(directory, '.setup-'));
    await writeFile(path.join(staging, 'ripwire'), archive.binary, { flag: 'wx', mode: 0o700 });
    await writeFile(path.join(staging, 'LICENSE'), archive.license, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(staging, 'release.json'), JSON.stringify({ version: RIPWIRE_VERSION, archiveSha256: asset.sha256,
      binarySha256: createHash('sha256').update(archive.binary).digest('hex') }), { flag: 'wx', mode: 0o600 });
    await probeSourceBinary(path.join(staging, 'ripwire'), staging, signal, dependencies.runner);
    const probe = path.join(staging, 'probe');
    await mkdir(probe, { mode: 0o700 });
    await writeFile(path.join(probe, 'probe.ts'), 'export function sourceProbe(value: number) { return value + 1; }\n');
    const output = await (dependencies.runner ?? runSourceProcess)({ executable: path.join(staging, 'ripwire'),
      args: ['.', '--pack-task=sourceProbe', '--json', '--token-budget=512', '--no-cache'], cwd: probe, signal });
    let parsed;
    try { parsed = JSON.parse(output.stdout.toString('utf8')); } catch { throw new SourceFailure('probe_failed'); }
    if (output.code !== 0 || !Array.isArray(parsed.ranking) || !parsed.ranking.some((r: { n?: unknown }) => r.n === 'sourceProbe'))
      throw new SourceFailure('probe_failed');
    await rm(probe, { recursive: true });
    signal.throwIfAborted();
    await rename(staging, destination);
    staging = undefined;
    return { status: 'ready', version: RIPWIRE_VERSION, source: 'managed', reused: false };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}
