import semver from 'semver';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { getPlatformDataDirectory, type PathEnvironment } from '../config/paths.js';
import { KiokukoError } from '../errors.js';

const executeFile = promisify(execFile);
const packageNames = ['@huggingface/hub', '@huggingface/transformers', 'sqlite-vec'] as const;
const scriptPackages = ['onnxruntime-node', 'sharp', 'protobufjs'] as const;
const loaderSource = 'export const load = (name) => import(name);\n';
const runningPackageRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

type OptionalRuntimePackage = typeof packageNames[number];
type OptionalRuntimeModules = {
  '@huggingface/hub': typeof import('@huggingface/hub');
  '@huggingface/transformers': typeof import('@huggingface/transformers');
  'sqlite-vec': typeof import('sqlite-vec');
};

export interface OptionalRuntimeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

export type OptionalRuntimeRunner = (invocation: OptionalRuntimeInvocation) => Promise<{ readonly stdout: string }>;

interface RuntimeContract {
  readonly manifest: string;
  readonly identity: string;
  readonly overrides: Readonly<Record<string, string>>;
}

/** Bind each managed installation to the shipped dependency and native-runtime contract. */
function runtimeContract(packageRoot: string, platform: NodeJS.Platform): RuntimeContract {
  const source = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    overrides?: Record<string, unknown>;
  };
  const dependencies: Record<string, string> = {};
  for (const name of packageNames) {
    // Consumer peers are ranges; this owned, reproducible runtime uses the shipped development lock.
    const version = source.devDependencies?.[name] ?? source.peerDependencies?.[name];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version)) {
      throw new KiokukoError('INTEGRITY_ERROR', `The optional runtime requires an exact shipped version for ${name}`);
    }
    const peerRange = source.peerDependencies?.[name];
    if (typeof peerRange !== 'string' || !semver.satisfies(version, peerRange)) {
      throw new KiokukoError('INTEGRITY_ERROR', `The shipped optional runtime version for ${name} is outside its public peer range`);
    }
    dependencies[name] = version;
  }
  const overrides = Object.fromEntries(Object.entries(source.overrides ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  const manifest = `${JSON.stringify({ name: 'kiokuko-embedding-runtime', version: '1.0.0', private: true, type: 'module', dependencies, overrides }, null, 2)}\n`;
  const digest = createHash('sha256').update(JSON.stringify({ schemaVersion: 2, manifest, scriptPackages, loaderSource, platform, arch: process.arch, abi: process.versions.modules })).digest('hex');
  const onnxOverrides = overrides['onnxruntime-node'];
  const overridden = {
    ...Object.fromEntries(Object.entries(overrides).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    ...(onnxOverrides !== null && typeof onnxOverrides === 'object' && 'global-agent' in onnxOverrides
      && typeof onnxOverrides['global-agent'] === 'string' ? { 'global-agent': onnxOverrides['global-agent'] } : {}),
  };
  return { manifest, overrides: overridden, identity: `${platform}-${process.arch}-${process.versions.modules}-${digest}` };
}

export function optionalRuntimeDirectory(options: PathEnvironment = {}, packageRoot = runningPackageRoot): string {
  return path.join(getPlatformDataDirectory(options), 'runtimes', 'embeddings', runtimeContract(packageRoot, options.platform ?? process.platform).identity);
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new KiokukoError('SECURITY_REJECTION', 'The managed optional runtime must be a private directory');
    }
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertRuntimeContract(directory: string, contract: RuntimeContract): Promise<void> {
  if (await readFile(path.join(directory, 'package.json'), 'utf8') !== contract.manifest
    || await readFile(path.join(directory, 'loader.mjs'), 'utf8') !== loaderSource) {
    throw new KiokukoError('INTEGRITY_ERROR', 'The managed optional runtime does not match its shipped contract');
  }
}

/** Reject npm trees that escaped their project root or lost shipped security overrides. */
async function assertRuntimeLock(directory: string, contract: RuntimeContract): Promise<void> {
  const manifest = JSON.parse(contract.manifest) as { name: string; version: string; dependencies: Record<string, string> };
  const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8')) as {
    name?: string; version?: string; packages?: Record<string, { name?: string; version?: string; dependencies?: Record<string, string>; optional?: boolean; link?: boolean }>;
  };
  const root = lock.packages?.[''];
  if (lock.name !== manifest.name || lock.version !== manifest.version || root?.name !== manifest.name
    || root.version !== manifest.version || JSON.stringify(root.dependencies) !== JSON.stringify(manifest.dependencies)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'The optional runtime lockfile does not describe its managed project');
  }
  for (const [location, installed] of Object.entries(lock.packages ?? {})) {
    if (location === '') continue;
    if (!location.startsWith('node_modules/') || location.includes('\\') || location.split('/').some((part) => part === '.' || part === '..') || installed.link) {
      throw new KiokukoError('INTEGRITY_ERROR', 'The optional runtime dependency tree escaped its managed project');
    }
    const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const expected = contract.overrides[name];
    if (expected === undefined) continue;
    if (installed.version !== expected) throw new KiokukoError('INTEGRITY_ERROR', `The optional runtime lost the shipped override for ${name}`);
    try {
      const actual = JSON.parse(await readFile(path.join(directory, location, 'package.json'), 'utf8')) as { version?: string };
      if (actual.version !== expected) throw new KiokukoError('INTEGRITY_ERROR', `The installed optional runtime violates the shipped override for ${name}`);
    } catch (error) {
      if (!(installed.optional && error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}

/** Probe in a fresh process so a failed import cannot poison a successful retry. */
export async function checkOptionalRuntime(
  directory = optionalRuntimeDirectory(),
  packageRoot = runningPackageRoot,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const source = `
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const names = ${JSON.stringify(packageNames)};
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    const root = pathToFileURL(path.join(process.cwd(), 'node_modules') + path.sep).href;
    const modules = await Promise.all(names.map(async (name) => {
      if (!import.meta.resolve(name).startsWith(root)) throw new Error(name + ' resolved outside the managed runtime');
      const installed = JSON.parse(await readFile(path.join('node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== manifest.dependencies?.[name]) throw new Error(name + ' has an unexpected version');
      return import(name);
    }));
    if (typeof modules[0].downloadFile !== 'function'
      || typeof modules[1].pipeline !== 'function' || typeof modules[1].env !== 'object'
      || typeof modules[2].getLoadablePath !== 'function' || typeof modules[2].load !== 'function') {
      throw new Error('The optional runtime exports are incomplete');
    }
  `;
  try {
    if (!await directoryExists(directory)) throw new Error('The managed optional runtime is not installed');
    const contract = runtimeContract(packageRoot, platform);
    await assertRuntimeContract(directory, contract);
    await assertRuntimeLock(directory, contract);
    await executeFile(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: directory, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 16_384) : 'Runtime probe failed';
    throw new KiokukoError('SERVICE_UNAVAILABLE', `Local semantic retrieval dependencies are unavailable: ${detail}`);
  }
}

async function runNpm(invocation: OptionalRuntimeInvocation): Promise<{ stdout: string }> {
  try {
    const result = await executeFile(invocation.command, [...invocation.args], {
      cwd: invocation.cwd, env: invocation.env, timeout: invocation.timeoutMs,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    if (invocation.args[0] !== '--version') {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    return { stdout: result.stdout };
  } catch (error) {
    if (error !== null && typeof error === 'object') {
      if ('stdout' in error && typeof error.stdout === 'string') process.stderr.write(error.stdout);
      if ('stderr' in error && typeof error.stderr === 'string') process.stderr.write(error.stderr);
    }
    throw error;
  }
}

function runtimeEnvironment(options: PathEnvironment): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...options.env };
  // npm lifecycle exports can otherwise turn the inherited project policy into
  // a forbidden CLI policy for this separate managed project. Keep all user
  // registry, proxy, authentication, cache and other configuration intact.
  for (const key of Object.keys(environment)) {
    if (/^npm_config_allow_scripts$/iu.test(key)) delete environment[key];
  }
  return environment;
}

function supportsScriptPolicy(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.exec(version.trim());
  if (!match) throw new KiokukoError('SERVICE_UNAVAILABLE', 'The npm version could not be determined');
  return Number(match[1]) > 11 || (Number(match[1]) === 11 && Number(match[2]) >= 19);
}

/** Provision a separate runtime, then expose it only after every required import succeeds. */
export async function installOptionalRuntime(
  options: PathEnvironment = {},
  dependencies: { readonly packageRoot?: string; readonly runner?: OptionalRuntimeRunner } = {},
): Promise<void> {
  const packageRoot = dependencies.packageRoot ?? runningPackageRoot;
  const contract = runtimeContract(packageRoot, options.platform ?? process.platform);
  const finalDirectory = optionalRuntimeDirectory(options, packageRoot);
  if (await directoryExists(finalDirectory)) {
    await assertRuntimeContract(finalDirectory, contract);
    await checkOptionalRuntime(finalDirectory, packageRoot, options.platform ?? process.platform);
    return;
  }
  const parent = path.dirname(finalDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await directoryExists(parent);
  // npm compares its prefix to process.cwd(); on macOS /tmp is a symlink.
  // Use one canonical spelling or npm treats this project as a linked package
  // and can silently ignore its overrides.
  const staging = await realpath(await mkdtemp(path.join(parent, '.staging-')));
  const runner = dependencies.runner ?? runNpm;
  const environment = runtimeEnvironment(options);
  const invoke = (args: readonly string[], timeoutMs = 300_000) => runner({
    command: (options.platform ?? process.platform) === 'win32' ? 'npm.cmd' : 'npm',
    args: [...args, '--global=false', '--prefix', staging],
    cwd: staging, env: environment, timeoutMs,
  });
  try {
    await writeFile(path.join(staging, 'package.json'), contract.manifest, { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(staging, 'loader.mjs'), loaderSource, { mode: 0o600, flag: 'wx' });
    const version = await invoke(['--version'], 30_000);
    if (supportsScriptPolicy(version.stdout)) {
      // A project .npmrc shares the normal user config cascade without the
      // package.json-vs-user-allowScripts conflict in newer npm versions.
      await writeFile(path.join(staging, '.npmrc'), `allow-scripts=${scriptPackages.join(',')}\n`, { mode: 0o600, flag: 'wx' });
    }
    await invoke(['install', '--ignore-scripts', '--package-lock=true', '--save=true', '--include=optional']);
    // Older npm lacks allowScripts. Explicit rebuild targets keep its script
    // execution limited to the same approved package names.
    await invoke(['rebuild', '--ignore-scripts=false', ...scriptPackages]);
    await assertRuntimeContract(staging, contract);
    await checkOptionalRuntime(staging, packageRoot, options.platform ?? process.platform);
    try {
      await rename(staging, finalDirectory);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error;
      await directoryExists(finalDirectory);
      await assertRuntimeContract(finalDirectory, contract);
      await checkOptionalRuntime(finalDirectory, packageRoot, options.platform ?? process.platform);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Prefer the current managed runtime; legacy package-owned imports remain a fallback only when absent. */
export async function importOptionalRuntime<Name extends OptionalRuntimePackage>(
  packageName: Name,
  options: PathEnvironment = {},
  packageRoot = runningPackageRoot,
): Promise<OptionalRuntimeModules[Name]> {
  if (!packageNames.includes(packageName)) throw new KiokukoError('VALIDATION_ERROR', 'Unknown optional runtime package');
  const directory = optionalRuntimeDirectory(options, packageRoot);
  if (!await directoryExists(directory)) return import(packageName) as Promise<OptionalRuntimeModules[Name]>;
  await assertRuntimeContract(directory, runtimeContract(packageRoot, options.platform ?? process.platform));
  const loader = await import(pathToFileURL(path.join(directory, 'loader.mjs')).href) as { load: (name: OptionalRuntimePackage) => Promise<OptionalRuntimeModules[Name]> };
  return loader.load(packageName);
}
