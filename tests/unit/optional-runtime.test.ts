import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  checkOptionalRuntime,
  importOptionalRuntime,
  installOptionalRuntime,
  optionalRuntimeDirectory,
  type OptionalRuntimeInvocation,
  type OptionalRuntimeRunner,
} from '../../src/embedding/optional-runtime.js';

const peers = { '@huggingface/hub': '2.16.1', '@huggingface/transformers': '4.2.0', 'sqlite-vec': '0.1.9' };
const sourceManifest = {
  name: 'kiokuko-ai', version: '0.2.8', peerDependencies: peers,
  devDependencies: { ...peers, 'dev-preserved': '1.0.0' },
  peerDependenciesMeta: Object.fromEntries(Object.keys(peers).map((name) => [name, { optional: true }])),
  overrides: { sharp: '0.35.5', 'onnxruntime-node': { 'global-agent': '4.1.3' } },
  allowScripts: { 'onnxruntime-node': true, sharp: true, protobufjs: true },
};

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-managed-runtime-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'caller');
  await mkdir(path.join(packageRoot, 'node_modules', 'dev-preserved'), { recursive: true });
  const originalPackage = `${JSON.stringify(sourceManifest, null, 2)}\n`;
  const originalLock = '{"caller-owned-lock":true}\n';
  await writeFile(path.join(packageRoot, 'package.json'), originalPackage);
  await writeFile(path.join(packageRoot, 'package-lock.json'), originalLock);
  await writeFile(path.join(packageRoot, 'node_modules', 'dev-preserved', 'index.js'), 'caller-owned dependency\n');
  const home = path.join(root, 'home');
  await mkdir(home);
  const userConfig = path.join(home, '.npmrc');
  const userPolicy = 'registry=https://registry.example.invalid/\nproxy=http://proxy.example.invalid/\nallow-scripts=caller-owned-package\n';
  await writeFile(userConfig, userPolicy);
  const options = { env: {
    HOME: home, KIOKUKO_DATA_DIR: path.join(root, 'data'),
    npm_config_userconfig: userConfig, npm_config_registry: 'https://registry.example.invalid/',
    npm_config_proxy: 'http://proxy.example.invalid/', npm_config_prefix: path.join(root, 'wrong-prefix'),
    npm_config_global: 'true', npm_config_allow_scripts: 'inherited-policy', NPM_CONFIG_ALLOW_SCRIPTS: 'another-inherited-policy',
    'npm_config_allow-scripts': 'hyphenated-inherited-policy',
  } };
  const preserved = async () => {
    assert.equal(await readFile(path.join(packageRoot, 'package.json'), 'utf8'), originalPackage);
    assert.equal(await readFile(path.join(packageRoot, 'package-lock.json'), 'utf8'), originalLock);
    assert.equal(await readFile(path.join(packageRoot, 'node_modules', 'dev-preserved', 'index.js'), 'utf8'), 'caller-owned dependency\n');
    assert.equal(await readFile(userConfig, 'utf8'), userPolicy);
  };
  return { root, packageRoot, options, preserved };
}

async function installFixturePackages(directory: string, marker = 'managed'): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
    name: string; version: string; dependencies: Record<string, string>;
    overrides: { sharp: string; 'onnxruntime-node': { 'global-agent': string } };
  };
  const packages: Record<string, unknown> = { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } };
  const modules: Record<string, string> = {
    '@huggingface/hub': `export const downloadFile = () => ${JSON.stringify(marker)};`,
    '@huggingface/transformers': `export const env = {marker:${JSON.stringify(marker)}}; export const pipeline = () => ${JSON.stringify(marker)};`,
    'sqlite-vec': `export const getLoadablePath = () => ${JSON.stringify(marker)}; export const load = () => {};`,
  };
  for (const [name, source] of Object.entries(modules)) {
    const destination = path.join(directory, 'node_modules', name);
    await mkdir(destination, { recursive: true });
    // Distinct require/import branches make using createRequire for ESM fail this fixture.
    await writeFile(path.join(destination, 'package.json'), JSON.stringify({
      name, version: manifest.dependencies[name], type: 'module',
      exports: { import: './index.mjs', require: './wrong.cjs' },
    }));
    await writeFile(path.join(destination, 'index.mjs'), source);
    await writeFile(path.join(destination, 'wrong.cjs'), 'throw new Error("The runtime must preserve import conditions");');
    packages[`node_modules/${name}`] = { version: manifest.dependencies[name] };
  }
  for (const [name, version] of Object.entries({ sharp: manifest.overrides.sharp, 'global-agent': manifest.overrides['onnxruntime-node']['global-agent'] })) {
    await mkdir(path.join(directory, 'node_modules', name), { recursive: true });
    await writeFile(path.join(directory, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
    packages[`node_modules/${name}`] = { version };
  }
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages }));
}

function fakeNpm(version = '11.19.0', fail?: 'config' | 'install' | 'rebuild' | 'probe' | 'exports' | 'lock' | 'escape' | 'override', policy = true) {
  const calls: OptionalRuntimeInvocation[] = [];
  const runner: OptionalRuntimeRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[0] === '--version') return { stdout: `${version}\n` };
    if (invocation.args[0] === 'config') {
      const userConfig = invocation.args[invocation.args.indexOf('--userconfig') + 1]!;
      const globalConfig = invocation.args[invocation.args.indexOf('--globalconfig') + 1]!;
      assert.notEqual(userConfig, globalConfig);
      for (const file of [userConfig, globalConfig]) {
        assert.equal(path.dirname(file), invocation.cwd);
        assert.equal(await readFile(file, 'utf8'), '');
      }
      if (fail === 'config') throw new Error('Fixture npm config unavailable');
      return { stdout: policy ? '\n' : 'undefined\n' };
    }
    if (invocation.args[0] === 'install') {
      await installFixturePackages(invocation.cwd);
      if (fail === 'install') throw new Error('Fixture npm install failed');
      if (fail === 'probe') await rm(path.join(invocation.cwd, 'node_modules', 'sqlite-vec'), { recursive: true });
      if (fail === 'exports') await writeFile(path.join(invocation.cwd, 'node_modules', 'sqlite-vec', 'index.mjs'), 'export const version = "0.1.9";');
      if (fail === 'lock' || fail === 'escape') {
        const lockPath = path.join(invocation.cwd, 'package-lock.json');
        const lock = JSON.parse(await readFile(lockPath, 'utf8'));
        if (fail === 'lock') lock.version = 'file:../outside-project';
        else lock.packages['../outside-project/node_modules/sharp'] = { version: '0.34.5' };
        await writeFile(lockPath, JSON.stringify(lock));
      }
      if (fail === 'override') await writeFile(path.join(invocation.cwd, 'node_modules', 'sharp', 'package.json'), JSON.stringify({ name: 'sharp', version: '0.34.5' }));
    }
    if (invocation.args[0] === 'rebuild' && fail === 'rebuild') throw new Error('Fixture npm rebuild failed');
    return { stdout: '' };
  };
  return { calls, runner };
}

test('managed runtime identity follows shipped dependencies, overrides and native platform', async (context) => {
  const { packageRoot, options } = await fixture(context);
  const original = optionalRuntimeDirectory(options, packageRoot);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ ...sourceManifest, overrides: { 'onnxruntime-node': { 'global-agent': '4.1.3' }, sharp: '0.35.5' } }));
  assert.equal(optionalRuntimeDirectory(options, packageRoot), original);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ ...sourceManifest, overrides: { ...sourceManifest.overrides, sharp: '0.35.6' } }));
  assert.notEqual(optionalRuntimeDirectory(options, packageRoot), original);
  assert.notEqual(optionalRuntimeDirectory({ ...options, platform: 'linux' }, packageRoot), optionalRuntimeDirectory({ ...options, platform: 'darwin' }, packageRoot));
});

for (const policy of [false, true]) {
  test(`managed runtime first install and repeat preserve caller state with script-policy support=${policy}`, async (context) => {
    const { packageRoot, options, preserved } = await fixture(context);
    const directory = optionalRuntimeDirectory(options, packageRoot);
    await assert.rejects(checkOptionalRuntime(directory, packageRoot), /not installed/u);
    const npm = fakeNpm('vendor-build', undefined, policy);
    await installOptionalRuntime(options, { packageRoot, runner: npm.runner });
    await checkOptionalRuntime(directory, packageRoot);
    assert.deepEqual(npm.calls.map((call) => call.args[0]), ['config', 'install', 'rebuild']);
    assert.deepEqual(npm.calls[0]!.args.slice(0, 4), ['config', 'get', 'allow-scripts', '--json']);
    const canonicalParent = await realpath(path.dirname(directory));
    assert.ok(npm.calls.every((call) => call.cwd !== packageRoot && call.cwd.startsWith(canonicalParent)));
    for (const call of npm.calls) {
      assert.equal(call.args[call.args.indexOf('--prefix') + 1], call.cwd);
      assert.ok(call.args.includes('--global=false'));
      assert.equal(call.env.npm_config_userconfig, options.env.npm_config_userconfig);
      assert.equal(call.env.npm_config_registry, options.env.npm_config_registry);
      assert.equal(call.env.npm_config_proxy, options.env.npm_config_proxy);
      assert.equal(Object.keys(call.env).some((key) => /^npm_config_allow[-_]scripts$/iu.test(key)), false);
      assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 300_000);
    }
    const install = npm.calls[1]!;
    assert.ok(install.args.includes('--ignore-scripts'));
    assert.ok(install.args.includes('--save=true'));
    assert.ok(install.args.includes('--package-lock=true'));
    assert.equal(install.args.includes('--no-save'), false);
    assert.deepEqual(npm.calls[2]!.args.slice(0, 5), ['rebuild', '--ignore-scripts=false', 'onnxruntime-node', 'sharp', 'protobufjs']);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.allowScripts, undefined);
    assert.deepEqual(manifest.dependencies, peers);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.peerDependencies, undefined);
    if (policy) assert.equal(await readFile(path.join(directory, '.npmrc'), 'utf8'), 'allow-scripts=onnxruntime-node,sharp,protobufjs\n');
    else await assert.rejects(readFile(path.join(directory, '.npmrc')), { code: 'ENOENT' });
    assert.ok(!(await readdir(directory)).some(name => name.startsWith('.probe-')));
    assert.ok(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
    await installOptionalRuntime(options, { packageRoot, runner: npm.runner });
    assert.equal(npm.calls.length, 3);
    assert.deepEqual(await readdir(path.dirname(directory)), [path.basename(directory)]);
    await preserved();
  });
}

for (const failure of ['config', 'install', 'rebuild', 'probe', 'exports', 'lock', 'escape', 'override'] as const) {
  test(`managed runtime ${failure} failure cleans staging and permits a successful retry`, async (context) => {
    const { packageRoot, options, preserved } = await fixture(context);
    const directory = optionalRuntimeDirectory(options, packageRoot);
    await assert.rejects(installOptionalRuntime(options, { packageRoot, runner: fakeNpm('11.19.0', failure).runner }));
    assert.deepEqual(await readdir(path.dirname(directory)), []);
    await preserved();
    await installOptionalRuntime(options, { packageRoot, runner: fakeNpm().runner });
    await checkOptionalRuntime(directory, packageRoot);
    await preserved();
  });
}

test('failure of a new runtime contract leaves the previous ready installation intact', async (context) => {
  const { packageRoot, options } = await fixture(context);
  await installOptionalRuntime(options, { packageRoot, runner: fakeNpm().runner });
  const previous = optionalRuntimeDirectory(options, packageRoot);
  const previousManifest = await readFile(path.join(previous, 'package.json'), 'utf8');
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ ...sourceManifest, overrides: { ...sourceManifest.overrides, sharp: '0.35.6' } }));
  const next = optionalRuntimeDirectory(options, packageRoot);
  await assert.rejects(installOptionalRuntime(options, { packageRoot, runner: fakeNpm('11.19.0', 'install').runner }));
  assert.equal(await readFile(path.join(previous, 'package.json'), 'utf8'), previousManifest);
  assert.deepEqual(await readdir(path.dirname(next)), [path.basename(previous)]);
  await installOptionalRuntime(options, { packageRoot, runner: fakeNpm().runner });
  assert.equal(await readFile(path.join(previous, 'package.json'), 'utf8'), previousManifest);
  await checkOptionalRuntime(next, packageRoot);
});

test('managed imports preserve ESM conditions for all three consumers', async (context) => {
  const { packageRoot, options } = await fixture(context);
  await installOptionalRuntime(options, { packageRoot, runner: fakeNpm().runner });
  const hub = await importOptionalRuntime('@huggingface/hub', options, packageRoot);
  const transformers = await importOptionalRuntime('@huggingface/transformers', options, packageRoot);
  const sqlite = await importOptionalRuntime('sqlite-vec', options, packageRoot);
  assert.equal(typeof hub.downloadFile, 'function');
  assert.equal((transformers.env as unknown as { marker: string }).marker, 'managed');
  assert.equal(typeof transformers.pipeline, 'function');
  assert.equal(sqlite.getLoadablePath(), 'managed');
});

for (const file of ['package.json', 'loader.mjs']) {
  test(`managed readiness rejects a changed ${file} without replacing the installation`, async (context) => {
    const { packageRoot, options } = await fixture(context);
    await installOptionalRuntime(options, { packageRoot, runner: fakeNpm().runner });
    const directory = optionalRuntimeDirectory(options, packageRoot);
    const changed = `${await readFile(path.join(directory, file), 'utf8')}\n`;
    await writeFile(path.join(directory, file), changed);
    const npm = fakeNpm();
    await assert.rejects(checkOptionalRuntime(directory, packageRoot), /does not match/u);
    await assert.rejects(installOptionalRuntime(options, { packageRoot, runner: npm.runner }), /does not match/u);
    await assert.rejects(importOptionalRuntime('@huggingface/hub', options, packageRoot), /does not match/u);
    assert.equal(npm.calls.length, 0);
    assert.equal(await readFile(path.join(directory, file), 'utf8'), changed);
  });
}

test('a managed module failure is not hidden by an available package-owned fallback', async (context) => {
  const { packageRoot, options } = await fixture(context);
  // With no managed installation the existing developer dependency remains usable.
  assert.equal(typeof (await importOptionalRuntime('@huggingface/hub', options, packageRoot)).downloadFile, 'function');
  await installOptionalRuntime(options, { packageRoot, runner: fakeNpm().runner });
  const directory = optionalRuntimeDirectory(options, packageRoot);
  await writeFile(path.join(directory, 'node_modules', '@huggingface', 'hub', 'index.mjs'), 'throw new Error("broken managed module");');
  await assert.rejects(importOptionalRuntime('@huggingface/hub', options, packageRoot), /broken managed module/u);
});


test('compatible public peer ranges preserve the shipped managed runtime and reject an incompatible artifact', async context => {
  const {packageRoot, options} = await fixture(context);
  const original = optionalRuntimeDirectory(options, packageRoot);
  const ranged = {...sourceManifest, peerDependencies:Object.fromEntries(Object.entries(peers).map(([name,version]) => [name, `^${version}`]))};
  await writeFile(path.join(packageRoot,'package.json'),JSON.stringify(ranged));
  assert.equal(optionalRuntimeDirectory(options,packageRoot),original,'consumer compatibility must not replace a valid existing managed runtime');
  const npm=fakeNpm();
  await installOptionalRuntime(options,{packageRoot,runner:npm.runner});
  const installed=JSON.parse(await readFile(path.join(original,'package.json'),'utf8'));
  assert.deepEqual(installed.dependencies,peers,'the owned artifact stays reproducible while public peers allow compatible versions');
  await checkOptionalRuntime(original,packageRoot);
  await writeFile(path.join(packageRoot,'package.json'),JSON.stringify({...ranged,devDependencies:{...ranged.devDependencies,'sqlite-vec':'0.2.0'}}));
  assert.throws(() => optionalRuntimeDirectory(options,packageRoot),/outside its public peer range/);
});

for (const [label, policy] of [['vendor-build', true], ['10.0.0', true], ['99.0.0', false]] as const) {
  test(`actual npm config capability governs policy for reported ${label}`, async context => {
    const { packageRoot, options, preserved } = await fixture(context);
    const npm = fakeNpm(label, undefined, policy);
    await installOptionalRuntime(options, { packageRoot, runner: npm.runner });
    const directory = optionalRuntimeDirectory(options, packageRoot);
    if (policy) assert.equal(await readFile(path.join(directory, '.npmrc'), 'utf8'), 'allow-scripts=onnxruntime-node,sharp,protobufjs\n');
    else await assert.rejects(readFile(path.join(directory, '.npmrc')), { code: 'ENOENT' });
    assert.ok(npm.calls.some(call => call.args[0] === 'install' && call.args.includes('--ignore-scripts')));
    assert.ok(npm.calls.some(call => call.args[0] === 'rebuild' && call.args.includes('sharp')));
    await preserved();
  });
}
