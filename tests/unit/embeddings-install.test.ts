import assert from 'node:assert/strict';
import test from 'node:test';
import { optionalRuntimeInstallInvocation } from '../../src/commands/embeddings.js';

test('optional runtime installation uses npm directly on macOS', () => {
  const packageRoot = '/tmp/kiokuko-package';
  const invocation = optionalRuntimeInstallInvocation('darwin', packageRoot);
  assert.equal(invocation.command, 'npm');
  assert.equal(invocation.args[0], 'install');
  assert.equal(invocation.args.includes('--global'), false);
  assert.equal(invocation.args.includes('--no-save'), true);
  assert.equal(invocation.args.includes('--package-lock=false'), true);
  assert.equal(invocation.args.some((arg) => arg.startsWith('--allow-scripts')), false);
  assert.deepEqual(invocation.args.slice(3, 5), ['--prefix', packageRoot]);
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
