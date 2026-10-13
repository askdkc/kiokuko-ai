import { completeVerification } from '../../scripts/verification-completion.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
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
  'node-domexception',
  'msgpackr-extract',
  '@opencode/plugin',
  '@opencode/client',
]);
let npmCacheDirectory;
let npmUserConfig;

async function run(command, args, cwd, environment = {}) {
  const childEnvironment = {
    ...process.env,
    ...environment,
    npm_config_loglevel: 'warn',
    ...(npmCacheDirectory === undefined ? {} : { npm_config_cache: npmCacheDirectory }),
    ...(npmUserConfig === undefined ? {} : { npm_config_userconfig: npmUserConfig }),
  };
  // npm run exports this project's allowScripts policy. A consumer install
  // must use its own policy, without the parent lifecycle's generated setting.
  delete childEnvironment.npm_config_allow_scripts;
  try {
    return await execFileAsync(command, args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      env: childEnvironment,
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

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kiokuko-global-install-')));
const packDirectory = path.join(temporaryRoot, 'pack');
const prefixDirectory = path.join(temporaryRoot, 'prefix');
npmCacheDirectory = process.env.KIOKUKO_TEST_NPM_CACHE ?? path.join(temporaryRoot, 'npm-cache');
npmUserConfig = path.join(temporaryRoot, 'consumer.npmrc');

try {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'kiokuko-ai', 'the published package identity must be kiokuko-ai');
  await mkdir(packDirectory, { recursive: true });
  if (!process.env.KIOKUKO_VERIFY_TARBALL) await run('npm', ['run', 'build'], repositoryRoot);
  const packed = process.env.KIOKUKO_VERIFY_TARBALL
    ? { stdout: await readFile(process.env.KIOKUKO_VERIFY_PACK_METADATA, 'utf8') }
    : await run('npm', ['pack', '--pack-destination', packDirectory, '--json'], repositoryRoot);
  const tarball = process.env.KIOKUKO_VERIFY_TARBALL ?? packedFilename(packed.stdout, packDirectory);
  const install = await run('npm', [
    'install',
    '--global',
    '--prefix',
    prefixDirectory,
    tarball,
  ], repositoryRoot);
  const npmOutput = `${install.stdout}\n${install.stderr}`;
  // Dependency warnings are diagnostic; import/setup and dependency-tree assertions below decide installation success.
  if (/deprecated\s/iu.test(npmOutput)) process.stderr.write('Dependency deprecation warning observed during isolated install.\n');

  const cliPath = path.join(prefixDirectory, 'bin', 'kiokuko-ai');
  const version = await run(cliPath, ['--version'], repositoryRoot);
  assert.equal(version.stdout.trim(), packageJson.version, 'installed CLI version must match package.json');
  const pluginPath = path.join(prefixDirectory, 'lib', 'node_modules', packageJson.name, 'dist', 'opencode', 'plugin.js');
  await run(process.execPath, ['--input-type=module', '--eval',
    `const { default: plugin } = await import(${JSON.stringify(pluginPath)}); if (plugin.id !== 'kiokuko-ai' || typeof plugin.setup !== 'function') throw new Error('invalid plugin');`,
  ], temporaryRoot);

  const isolatedEnvironment = {
    HOME: path.join(temporaryRoot, 'home'),
    XDG_CONFIG_HOME: path.join(temporaryRoot, 'config'),
    XDG_DATA_HOME: path.join(temporaryRoot, 'data'),
    KIOKUKO_DATA_DIR: path.join(temporaryRoot, 'memory'),
  };
  await mkdir(isolatedEnvironment.HOME, { recursive: true });
  const setup = await run(cliPath, ['setup', '--no-embeddings', '--json'], temporaryRoot, isolatedEnvironment);
  const setupResult = JSON.parse(setup.stdout).data;
  const routineFiles = setupResult.files.filter(file => file.path.includes('/coding-ideal-routine-skill/'));
  assert.equal(routineFiles.length, 3, 'normal installed setup must deliver the coding routine and references');
  for (const file of routineFiles) {
    const content = await readFile(file.path, 'utf8');
    assert.match(content, /<!-- KIOKUKO MANAGED STANDARD SKILL: coding-ideal-routine-skill -->/u);
  }
  const instructions = setupResult.files.find(file => file.purpose === 'instructions');
  assert.match(await readFile(instructions.path, 'utf8'), /before writing or changing code, read and apply `coding-ideal-routine-skill`/u);
  const repeated = await run(cliPath, ['setup', '--no-embeddings', '--json'], temporaryRoot, isolatedEnvironment);
  assert.equal(JSON.parse(repeated.stdout).data.files.every(file => file.action === 'unchanged'), true);

  const hostRequests = [];
  const host = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    hostRequests.push(url.pathname);
    assert.equal(url.searchParams.get('location[directory]'), temporaryRoot);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ location: { directory: temporaryRoot }, data: url.pathname === '/api/plugin'
      ? [{ id: 'kiokuko-ai', state: { status: 'active' }, source: { type: 'package', target: `kiokuko-ai@${packageJson.version}` } }]
      : [{ name: 'kiokuko', status: { status: 'connected' } }],
    }));
  });
  try {
    await new Promise((resolve, reject) => {
      host.once('error', reject);
      host.listen(0, '127.0.0.1', resolve);
    });
    const address = host.address();
    assert.ok(address && typeof address === 'object');
    const doctor = await run(cliPath, ['doctor', '--opencode-url', `http://127.0.0.1:${address.port}`, '--json'], temporaryRoot, isolatedEnvironment);
    assert.equal(JSON.parse(doctor.stdout).data.checks.openCodeHost.ok, true, 'installed doctor must inspect the OpenCode host');
    assert.deepEqual(hostRequests, ['/api/plugin', '/api/mcp']);
  } finally {
    await new Promise((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
  }

  const installedNames = await installedPackageNames(path.join(prefixDirectory, 'lib', 'node_modules'));
  assert.equal(installedNames.has(packageJson.name), true, 'the minimal install must contain the published package');
  for (const forbidden of forbiddenPackages) {
    assert.equal(installedNames.has(forbidden), false, `${forbidden} must not be in the minimal dependency tree`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Global install smoke test passed.\n');

completeVerification({});
