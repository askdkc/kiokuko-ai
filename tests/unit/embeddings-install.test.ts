import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkOptionalRuntime, optionalRuntimeInstallInvocation } from '../../src/commands/embeddings.js';

test('optional runtime checks recover after dependencies become available', async (context) => {
  const packageRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-runtime-check-'));
  context.after(async () => rm(packageRoot, { recursive: true, force: true }));

  await assert.rejects(() => checkOptionalRuntime(packageRoot), /dependencies are unavailable/u);
  await symlink(path.resolve('node_modules'), path.join(packageRoot, 'node_modules'), 'dir');
  await checkOptionalRuntime(packageRoot);
});

test('optional runtime installation uses npm directly on macOS', () => {
  const packageRoot = '/tmp/kiokuko-package';
  const invocation = optionalRuntimeInstallInvocation('darwin', packageRoot);
  assert.equal(invocation.command, 'npm');
  assert.equal(invocation.args[0], 'install');
  assert.equal(invocation.args.includes('--global'), false);
  assert.equal(invocation.args.includes('--no-save'), true);
  assert.equal(invocation.args.includes('--package-lock=false'), true);
  assert.equal(invocation.args.includes('--omit=dev'), true);
  assert.equal(invocation.args.some((arg) => arg.startsWith('--allow-scripts')), false);
  assert.equal(invocation.args[invocation.args.indexOf('--prefix') + 1], packageRoot);
  assert.equal(invocation.cwd, packageRoot);
  assert.equal(invocation.args.includes('sudo'), false);
});

test('optional runtime installation uses the sudo wrapper only on Linux', () => {
  const invocation = optionalRuntimeInstallInvocation('linux');
  assert.equal(invocation.command, 'sudo');
  assert.equal(invocation.args[0], 'npm');
  assert.equal(invocation.args[1], 'install');
  assert.equal(invocation.args.includes('--allow-scripts=onnxruntime-node,sharp,protobufjs'), true);
});
