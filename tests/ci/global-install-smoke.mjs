import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const forbiddenPackages = new Set([
  '@huggingface/hub',
  '@huggingface/transformers',
  '@opencode-ai/plugin',
  '@opencode-ai/sdk',
  'sqlite-vec',
  'onnxruntime-node',
  'sharp',
  'protobufjs',
  'boolean',
]);
let npmCacheDirectory;

async function run(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_loglevel: 'warn',
        ...(npmCacheDirectory === undefined ? {} : { npm_config_cache: npmCacheDirectory }),
      },
    });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const detail = [stdout, stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`, { cause: error });
  }
}

function packedFilename(stdout, packDirectory) {
  const records = JSON.parse(stdout);
  assert.ok(Array.isArray(records) && records.length === 1, 'npm pack must return one package record');
  assert.equal(typeof records[0].filename, 'string', 'npm pack must return a tarball filename');
  return path.join(packDirectory, records[0].filename);
}

async function installedPackageNames(nodeModulesDirectory, names = new Set()) {
  let entries;
  try {
    entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return names;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === '.bin') continue;
    const entryPath = path.join(nodeModulesDirectory, entry.name);
    if (entry.name.startsWith('@')) {
      const scopedEntries = await readdir(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        await recordInstalledPackage(path.join(entryPath, scopedEntry.name), names);
      }
      continue;
    }
    if (entry.isDirectory()) await recordInstalledPackage(entryPath, names);
  }
  return names;
}

async function recordInstalledPackage(packageDirectory, names) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (typeof manifest.name === 'string') names.add(manifest.name);
  await installedPackageNames(path.join(packageDirectory, 'node_modules'), names);
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kiokuko-global-install-'));
const packDirectory = path.join(temporaryRoot, 'pack');
const prefixDirectory = path.join(temporaryRoot, 'prefix');
npmCacheDirectory = path.join(temporaryRoot, 'npm-cache');

try {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'kiokuko-ai', 'the published package identity must be kiokuko-ai');
  await mkdir(packDirectory, { recursive: true });
  await run('npm', ['run', 'build'], repositoryRoot);
  const packed = await run('npm', ['pack', '--pack-destination', packDirectory, '--json'], repositoryRoot);
  const tarball = packedFilename(packed.stdout, packDirectory);
  const install = await run('npm', [
    'install',
    '--global',
    '--prefix',
    prefixDirectory,
    tarball,
  ], repositoryRoot);
  const npmOutput = `${install.stdout}\n${install.stderr}`;
  assert.doesNotMatch(npmOutput, /deprecated\s+boolean|install-scripts/iu, 'minimal install emitted an optional-runtime warning');

  const cliPath = path.join(prefixDirectory, 'bin', 'kiokuko-ai');
  const version = await run(cliPath, ['--version'], repositoryRoot);
  assert.equal(version.stdout.trim(), packageJson.version, 'installed CLI version must match package.json');

  const installedNames = await installedPackageNames(path.join(prefixDirectory, 'lib', 'node_modules'));
  assert.equal(installedNames.has(packageJson.name), true, 'the minimal install must contain the published package');
  for (const forbidden of forbiddenPackages) {
    assert.equal(installedNames.has(forbidden), false, `${forbidden} must not be in the minimal dependency tree`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Global install smoke test passed.\n');
