import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicWriteText,
  atomicWriteTextIfUnchanged,
  assertAtomicCleanupComplete,
  assertFileExpectation,
  AtomicCleanupFailure,
  AtomicCommittedMutationError,
  AtomicCommittedUnlinkError,
  readRegularFile,
  unlinkRegularFileIfUnchanged,
} from '../../src/agent-file/atomic-write.js';
import { KiokukoError } from '../../src/errors.js';

async function readDirectoryIdentity(directory: string): Promise<{ device: bigint; inode: bigint }> {
  const info = await lstat(directory, { bigint: true });
  assert.ok(info.isDirectory());
  assert.notEqual(info.ino, 0n);
  return { device: info.dev, inode: info.ino };
}

test('parent-bound atomic create does not create a missing parent or any path components', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-parent-missing-'));
  const missingParent = path.join(root, 'missing', 'nested');
  const target = path.join(missingParent, 'target.txt');

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: undefined,
      expectedParentDirectory: { device: 1n, inode: 1n },
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
  );

  assert.deepEqual(await readdir(root), []);
  await assert.rejects(access(missingParent), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  await assert.rejects(access(target), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
});

test('parent-bound atomic create rejects a replacement directory before mutating its target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-parent-replaced-'));
  const parent = path.join(root, 'managed');
  const displacedParent = path.join(root, 'displaced');
  const target = path.join(parent, 'target.txt');
  const sentinel = path.join(parent, 'concurrent.txt');
  await mkdir(parent);
  const plannedParent = await readDirectoryIdentity(parent);
  await rename(parent, displacedParent);
  await mkdir(parent);
  await writeFile(sentinel, 'concurrent owner\n');

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: undefined,
      expectedParentDirectory: plannedParent,
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
  );

  assert.equal(await readFile(sentinel, 'utf8'), 'concurrent owner\n');
  assert.deepEqual(await readdir(parent), ['concurrent.txt']);
  assert.deepEqual(await readdir(displacedParent), []);
  await assert.rejects(access(target), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
});

test('parent-bound atomic create rejects a symbolic-link parent without writing through it', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-parent-link-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-parent-outside-'));
  const parent = path.join(root, 'managed');
  const displacedParent = path.join(root, 'displaced');
  const target = path.join(parent, 'target.txt');
  await mkdir(parent);
  const plannedParent = await readDirectoryIdentity(parent);
  await rename(parent, displacedParent);
  await symlink(outside, parent);

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: undefined,
      expectedParentDirectory: plannedParent,
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'SECURITY_REJECTION',
  );

  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(displacedParent), []);
  await assert.rejects(access(path.join(outside, 'target.txt')), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
});

test('parent-bound atomic create succeeds while the planned parent identity is unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-parent-stable-'));
  const parent = path.join(root, 'managed');
  const target = path.join(parent, 'target.txt');
  await mkdir(parent);
  const plannedParent = await readDirectoryIdentity(parent);

  const outcome = await atomicWriteTextIfUnchanged(target, 'managed\n', {
    expected: undefined,
    expectedParentDirectory: plannedParent,
  }, 0o640);

  assert.equal(outcome.installed.content, 'managed\n');
  assert.equal(outcome.installed.mode, 0o640);
  assert.deepEqual(outcome.cleanupFailures, []);
  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  assert.deepEqual(await readdir(parent), ['target.txt']);
});

test('file expectation revalidates its parent after reading an exact hard-linked target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-parent-read-swap-'));
  const parent = path.join(root, 'managed');
  const displacedParent = path.join(root, 'displaced');
  const target = path.join(parent, 'target.txt');
  await mkdir(parent);
  await writeFile(target, 'planned\n');
  const planned = await readRegularFile(target);
  const plannedParent = await readDirectoryIdentity(parent);
  assert.ok(planned);
  let swapped = false;

  await assert.rejects(
    assertFileExpectation(target, {
      get expected() {
        if (!swapped) {
          swapped = true;
          renameSync(parent, displacedParent);
          mkdirSync(parent);
          linkSync(path.join(displacedParent, 'target.txt'), target);
        }
        return planned;
      },
      expectedParentDirectory: plannedParent,
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
  );

  assert.equal(swapped, true);
  assert.equal(await readFile(target, 'utf8'), 'planned\n');
  assert.equal(await readFile(path.join(displacedParent, 'target.txt'), 'utf8'), 'planned\n');
});

test('atomic write exposes both the operation and temporary-file cleanup failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-write-'));
  const target = path.join(directory, 'target.txt');
  const operationError = new Error('operation-secret-sentinel');
  const cleanupError = new Error('cleanup-secret-sentinel');
  let cleanupArtifact = '';
  let cleanupAttempts = 0;

  try {
    await assert.rejects(atomicWriteText(target, 'content', 0o640, {
      chmod: async () => {
        throw operationError;
      },
      beforeCleanup: async () => {
        cleanupAttempts += 1;
        throw cleanupError;
      },
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Atomic write failed and temporary-file cleanup also failed');
      assert.equal(error.errors[0], operationError);
      assert.ok(error.errors[1] instanceof AtomicCleanupFailure);
      assert.equal(error.errors[1].cause, cleanupError);
      assert.ok(error.errors[1].artifactPath);
      cleanupArtifact = error.errors[1].artifactPath;
      assert.doesNotMatch(error.message, /operation-secret|cleanup-secret|target\.txt/u);
      return true;
    });
  } finally {
    if (cleanupArtifact.length > 0) await unlink(cleanupArtifact);
  }

  assert.equal(cleanupAttempts, 1);
});

test('atomic write does not trust an unverified ENOENT cleanup claim', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-write-'));
  const target = path.join(directory, 'target.txt');
  const operationError = new Error('chmod failed');
  const missingError = Object.assign(new Error('missing'), { code: 'ENOENT' });
  let cleanupArtifact = '';
  let cleanupAttempts = 0;

  try {
    await assert.rejects(atomicWriteText(target, 'content', 0o640, {
      chmod: async () => {
        throw operationError;
      },
      beforeCleanup: async () => {
        cleanupAttempts += 1;
        throw missingError;
      },
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Atomic write failed and temporary-file cleanup also failed');
      assert.equal(error.errors[0], operationError);
      assert.ok(error.errors[1] instanceof AtomicCleanupFailure);
      assert.equal(error.errors[1].cause, missingError);
      assert.ok(error.errors[1].artifactPath);
      cleanupArtifact = error.errors[1].artifactPath;
      return true;
    });
  } finally {
    if (cleanupArtifact.length > 0) await unlink(cleanupArtifact);
  }

  assert.equal(cleanupAttempts, 1);
});

test('temporary content tampering fails before commit and preserves the exact planned target', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-temp-content-'));
  const target = path.join(directory, 'target.txt');
  await writeFile(target, 'original\n', { mode: 0o600 });
  const planned = await readRegularFile(target);
  assert.ok(planned);
  let temporaryPath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: planned }, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await chmod(filePath, mode);
      },
      beforeCommit: async () => writeFile(temporaryPath, 'tampered\n'),
    }),
    (error: unknown) => {
      assert.ok(!(error instanceof AtomicCommittedMutationError));
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'INTEGRITY_ERROR');
      return true;
    },
  );

  const current = await readRegularFile(target);
  assert.ok(current);
  assert.deepEqual(current, planned);
  assert.deepEqual(await readdir(directory), ['target.txt']);
  await assert.rejects(access(temporaryPath), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
});

test('temporary mode tampering fails before create and removes the unowned artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-temp-mode-'));
  const target = path.join(directory, 'target.txt');
  let temporaryPath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: undefined }, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await chmod(filePath, mode);
      },
      beforeCommit: async () => chmod(temporaryPath, 0o600),
    }),
    (error: unknown) => {
      assert.ok(!(error instanceof AtomicCommittedMutationError));
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'INTEGRITY_ERROR');
      return true;
    },
  );

  await assert.rejects(access(target), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  await assert.rejects(access(temporaryPath), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  assert.deepEqual(await readdir(directory), []);
});

test('byte-identical temporary replacement fails closed on file identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-temp-identity-'));
  const target = path.join(directory, 'target.txt');
  let temporaryPath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: undefined }, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await chmod(filePath, mode);
      },
      beforeCommit: async () => {
        await unlink(temporaryPath);
        await writeFile(temporaryPath, 'managed\n', { mode: 0o640 });
        await chmod(temporaryPath, 0o640);
      },
    }),
    (error: unknown) => {
      assert.ok(!(error instanceof AtomicCommittedMutationError));
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors[0] instanceof KiokukoError);
      assert.equal(error.errors[0].code, 'INTEGRITY_ERROR');
      assert.ok(error.errors[1] instanceof AtomicCleanupFailure);
      return true;
    },
  );

  assert.deepEqual(await readdir(directory), [path.basename(temporaryPath)]);
  assert.equal(await readFile(temporaryPath, 'utf8'), 'managed\n');
  await unlink(temporaryPath);
});

test('byte-identical replacement during chmod cannot become the installed inode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-chmod-swap-'));
  const target = path.join(directory, 'target.txt');
  const attackerAlias = path.join(directory, 'attacker-alias.txt');
  let temporaryPath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: undefined }, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await unlink(temporaryPath);
        await writeFile(temporaryPath, 'managed\n', { mode: 0o640 });
        await chmod(temporaryPath, mode);
        await link(temporaryPath, attackerAlias);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors[0] instanceof KiokukoError);
      assert.equal(error.errors[0].code, 'INTEGRITY_ERROR');
      assert.ok(error.errors[1] instanceof AtomicCleanupFailure);
      return true;
    },
  );

  await assert.rejects(access(target), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  const replacement = await lstat(temporaryPath, { bigint: true });
  const alias = await lstat(attackerAlias, { bigint: true });
  assert.equal(replacement.ino, alias.ino);
  assert.equal(replacement.nlink, 2n);
  await writeFile(attackerAlias, 'attacker mutation\n');
  assert.equal(await readFile(temporaryPath, 'utf8'), 'attacker mutation\n');
  await unlink(attackerAlias);
  await unlink(temporaryPath);
});

test('a hard-link alias added before commit rejects the temporary inode and installs nothing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-temp-alias-'));
  const target = path.join(directory, 'target.txt');
  const attackerAlias = path.join(directory, 'attacker-alias.txt');
  let temporaryPath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: undefined }, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await chmod(temporaryPath, mode);
      },
      beforeCommit: async () => link(temporaryPath, attackerAlias),
    }),
    (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'INTEGRITY_ERROR');
      return true;
    },
  );

  await assert.rejects(access(target), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  await assert.rejects(access(temporaryPath), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  const alias = await lstat(attackerAlias, { bigint: true });
  assert.equal(alias.nlink, 1n);
  assert.equal(await readFile(attackerAlias, 'utf8'), 'managed\n');
  await unlink(attackerAlias);
});

test('final temporary revalidation restores the original after quarantine-time tampering', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-temp-quarantine-'));
  const target = path.join(directory, 'target.txt');
  await writeFile(target, 'original\n', { mode: 0o600 });
  const planned = await readRegularFile(target);
  assert.ok(planned);
  let temporaryPath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: planned }, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await chmod(filePath, mode);
      },
      afterQuarantine: async () => writeFile(temporaryPath, 'late tamper\n'),
    }),
    (error: unknown) => {
      assert.ok(!(error instanceof AtomicCommittedMutationError));
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors[0] instanceof KiokukoError);
      assert.equal(error.errors[0].code, 'INTEGRITY_ERROR');
      assert.ok(error.errors[1] instanceof AtomicCleanupFailure);
      return true;
    },
  );

  const restored = await readRegularFile(target);
  assert.ok(restored);
  assert.deepEqual(restored, planned);
  assert.deepEqual((await readdir(directory)).sort(), [path.basename(temporaryPath), 'target.txt'].sort());
  assert.equal(await readFile(temporaryPath, 'utf8'), 'late tamper\n');
  await unlink(temporaryPath);
});

test('a replaced quarantine is never restored or removed after a later failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-quarantine-swap-'));
  const target = path.join(directory, 'target.txt');
  const savedOriginal = path.join(directory, 'saved-original.txt');
  await writeFile(target, 'original\n', { mode: 0o600 });
  const planned = await readRegularFile(target);
  assert.ok(planned);
  let temporaryPath = '';
  let quarantinePath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: planned }, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await chmod(temporaryPath, mode);
      },
      afterQuarantine: async () => {
        const [quarantineName] = (await readdir(directory)).filter((name) => name.endsWith('.previous'));
        assert.ok(quarantineName);
        quarantinePath = path.join(directory, quarantineName);
        await rename(quarantinePath, savedOriginal);
        await writeFile(quarantinePath, 'attacker quarantine\n', { mode: 0o600 });
        await writeFile(temporaryPath, 'late temporary tamper\n');
      },
    }),
    (error: unknown) => error instanceof AggregateError,
  );

  await assert.rejects(access(target), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  assert.equal(await readFile(savedOriginal, 'utf8'), 'original\n');
  assert.equal(await readFile(quarantinePath, 'utf8'), 'attacker quarantine\n');
  assert.equal(await readFile(temporaryPath, 'utf8'), 'late temporary tamper\n');
});

test('parent replacement after install is a committed failure and cleanup touches neither directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-parent-postinstall-'));
  const parent = path.join(root, 'managed');
  const displacedParent = path.join(root, 'displaced');
  const target = path.join(parent, 'target.txt');
  await mkdir(parent);
  const plannedParent = await readDirectoryIdentity(parent);

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: undefined,
      expectedParentDirectory: plannedParent,
    }, 0o640, {
      afterInstall: async () => {
        await rename(parent, displacedParent);
        await mkdir(parent);
        await link(path.join(displacedParent, 'target.txt'), target);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.ok(error.operationError instanceof KiokukoError);
      assert.equal(error.operationError.code, 'CONFLICT');
      assert.ok(error.outcome.cleanupFailures.length >= 1);
      return true;
    },
  );

  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  assert.equal(await readFile(path.join(displacedParent, 'target.txt'), 'utf8'), 'managed\n');
  assert.ok((await readdir(displacedParent)).some((name) => name.endsWith('.tmp')));
  assert.deepEqual(await readdir(parent), ['target.txt']);
});

test('a committed install link is classified before parent revalidation can fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-link-boundary-'));
  const parent = path.join(root, 'managed');
  const displacedParent = path.join(root, 'displaced');
  const target = path.join(parent, 'target.txt');
  await mkdir(parent);
  const plannedParent = await readDirectoryIdentity(parent);

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: undefined,
      expectedParentDirectory: plannedParent,
    }, 0o640, {
      afterLink: async () => {
        await rename(parent, displacedParent);
        await mkdir(parent);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.ok(error.operationError instanceof KiokukoError);
      assert.equal(error.operationError.code, 'CONFLICT');
      return true;
    },
  );

  assert.deepEqual(await readdir(parent), []);
  assert.equal(await readFile(path.join(displacedParent, 'target.txt'), 'utf8'), 'managed\n');
  assert.ok((await readdir(displacedParent)).some((name) => name.endsWith('.tmp')));
});

test('an install link that commits and then throws is still a committed mutation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-link-throws-'));
  const target = path.join(directory, 'target.txt');
  const sentinel = new Error('post-link sentinel');

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: undefined }, 0o640, {
      afterLink: async () => { throw sentinel; },
    }),
    (error: unknown) => error instanceof AtomicCommittedMutationError
      && error.operationError === sentinel,
  );

  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  assert.deepEqual(await readdir(directory), ['target.txt']);
  const installed = await lstat(target, { bigint: true });
  assert.equal(installed.nlink, 1n);
});

test('an install link with an extra hard link reports its exact retained temporary pathname', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-link-extra-alias-'));
  const target = path.join(directory, 'target.txt');
  const alias = path.join(directory, 'alias.txt');
  const sentinel = new Error('post-link alias sentinel');
  let temporaryPath: string | undefined;

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: undefined }, 0o640, {
      afterLink: async (source) => {
        await link(source, alias);
        throw sentinel;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.equal(error.operationError, sentinel);
      temporaryPath = error.outcome.cleanupFailures.find(
        (failure) => failure.artifactPath?.endsWith('.tmp') === true,
      )?.artifactPath;
      assert.ok(temporaryPath);
      return true;
    },
  );

  const targetInfo = await lstat(target, { bigint: true });
  const aliasInfo = await lstat(alias, { bigint: true });
  assert.ok(temporaryPath);
  const temporaryInfo = await lstat(temporaryPath, { bigint: true });
  assert.equal(targetInfo.ino, aliasInfo.ino);
  assert.equal(targetInfo.ino, temporaryInfo.ino);
  assert.equal(targetInfo.nlink, 3n);
  assert.equal(aliasInfo.nlink, 3n);
  assert.equal(temporaryInfo.nlink, 3n);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => !name.endsWith('.tmp')).sort(),
    ['alias.txt', 'target.txt'],
  );
});

test('a committed update quarantine is classified before parent revalidation can fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-quarantine-boundary-'));
  const parent = path.join(root, 'managed');
  const displacedParent = path.join(root, 'displaced');
  const target = path.join(parent, 'target.txt');
  await mkdir(parent);
  await writeFile(target, 'original\n');
  const planned = await readRegularFile(target);
  const plannedParent = await readDirectoryIdentity(parent);
  assert.ok(planned);

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: planned,
      expectedParentDirectory: plannedParent,
    }, 0o640, {
      afterRename: async (_source, destination) => {
        if (!destination.endsWith('.previous')) return;
        await rename(parent, displacedParent);
        await mkdir(parent);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedUnlinkError);
      assert.ok(error.operationError instanceof KiokukoError);
      assert.equal(error.operationError.code, 'CONFLICT');
      assert.ok(error.outcome.cleanupFailures.some((failure) => failure.artifactPath === undefined));
      return true;
    },
  );

  assert.deepEqual(await readdir(parent), []);
  const displaced = await readdir(displacedParent);
  const quarantineName = displaced.find((name) => name.endsWith('.previous'));
  assert.ok(quarantineName);
  assert.equal(await readFile(path.join(displacedParent, quarantineName), 'utf8'), 'original\n');
  assert.ok(displaced.some((name) => name.endsWith('.tmp')));
});

test('an update quarantine rename that commits and then throws reports an absent target', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-update-rename-throws-'));
  const target = path.join(directory, 'target.txt');
  const sentinel = new Error('post-update-rename sentinel');
  await writeFile(target, 'original\n');
  const planned = await readRegularFile(target);
  assert.ok(planned);

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: planned }, 0o640, {
      afterRename: async (_source, destination) => {
        if (!destination.endsWith('.previous')) return;
        throw sentinel;
      },
    }),
    (error: unknown) => error instanceof AtomicCommittedUnlinkError
      && error.operationError === sentinel,
  );

  await assert.rejects(access(target), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  const [quarantineName] = (await readdir(directory)).filter((name) => name.endsWith('.previous'));
  assert.ok(quarantineName);
  assert.equal(await readFile(path.join(directory, quarantineName), 'utf8'), 'original\n');
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('a committed quarantine with an extra owned hard link retains its recoverable pathname', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-update-quarantine-extra-link-'));
  const target = path.join(directory, 'target.txt');
  const alias = path.join(directory, 'original-alias.txt');
  const sentinel = new Error('quarantine gained an extra link');
  await writeFile(target, 'original\n');
  const planned = await readRegularFile(target);
  assert.ok(planned);
  let artifact: AtomicCleanupFailure | undefined;

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: planned }, 0o640, {
      afterRename: async (_source, destination) => {
        if (!destination.endsWith('.previous')) return;
        await link(destination, alias);
        throw sentinel;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedUnlinkError);
      artifact = error.outcome.cleanupFailures.find(
        (failure) => failure.artifactPath?.endsWith('.previous') === true,
      );
      assert.ok(artifact);
      return true;
    },
  );

  assert.ok(artifact?.artifactPath);
  assert.equal(await readFile(artifact.artifactPath, 'utf8'), 'original\n');
  const artifactInfo = await lstat(artifact.artifactPath, { bigint: true });
  const aliasInfo = await lstat(alias, { bigint: true });
  assert.equal(artifactInfo.ino, aliasInfo.ino);
  assert.equal(artifactInfo.nlink, 2n);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('a post-quarantine rename hook that relinks the original retains committed ownership', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-update-quarantine-relink-'));
  const target = path.join(directory, 'target.txt');
  const sentinel = new Error('rename restored source with a hard link');
  await writeFile(target, 'original\n');
  const planned = await readRegularFile(target);
  assert.ok(planned);
  let artifact: AtomicCleanupFailure | undefined;

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: planned }, 0o640, {
      afterRename: async (source, destination) => {
        if (!destination.endsWith('.previous')) return;
        await link(destination, source);
        throw sentinel;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedUnlinkError);
      assert.equal(error.operationError, sentinel);
      artifact = error.outcome.cleanupFailures.find(
        (failure) => failure.artifactPath?.endsWith('.previous') === true,
      );
      assert.ok(artifact);
      return true;
    },
  );

  const current = await readRegularFile(target);
  assert.ok(current);
  assert.deepEqual(current, planned);
  assert.ok(artifact?.artifactPath);
  const alias = await readRegularFile(artifact.artifactPath);
  assert.ok(alias);
  assert.deepEqual(alias, planned);
  const targetInfo = await lstat(target, { bigint: true });
  const aliasInfo = await lstat(artifact.artifactPath, { bigint: true });
  assert.equal(targetInfo.ino, aliasInfo.ino);
  assert.equal(targetInfo.nlink, 2n);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('a committed unlink quarantine has an explicit ownership error before parent revalidation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-unlink-boundary-'));
  const parent = path.join(root, 'managed');
  const displacedParent = path.join(root, 'displaced');
  const target = path.join(parent, 'target.txt');
  await mkdir(parent);
  await writeFile(target, 'original\n');
  const planned = await readRegularFile(target);
  const plannedParent = await readDirectoryIdentity(parent);
  assert.ok(planned);

  await assert.rejects(
    unlinkRegularFileIfUnchanged(target, {
      expected: planned,
      expectedParentDirectory: plannedParent,
    }, {
      afterRename: async (_source, destination) => {
        if (!destination.endsWith('.deleted')) return;
        await rename(parent, displacedParent);
        await mkdir(parent);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedUnlinkError);
      assert.ok(error.operationError instanceof KiokukoError);
      assert.equal(error.operationError.code, 'CONFLICT');
      assert.ok(error.outcome.cleanupFailures.some((failure) => failure.artifactPath === undefined));
      return true;
    },
  );

  assert.deepEqual(await readdir(parent), []);
  const [quarantineName] = (await readdir(displacedParent)).filter((name) => name.endsWith('.deleted'));
  assert.ok(quarantineName);
  assert.equal(await readFile(path.join(displacedParent, quarantineName), 'utf8'), 'original\n');
});

test('an unlink quarantine rename that commits and then throws retains explicit ownership', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-unlink-rename-throws-'));
  const target = path.join(directory, 'target.txt');
  const sentinel = new Error('post-unlink-rename sentinel');
  await writeFile(target, 'original\n');
  const planned = await readRegularFile(target);
  assert.ok(planned);

  await assert.rejects(
    unlinkRegularFileIfUnchanged(target, { expected: planned }, {
      afterRename: async (_source, destination) => {
        if (!destination.endsWith('.deleted')) return;
        throw sentinel;
      },
    }),
    (error: unknown) => error instanceof AtomicCommittedUnlinkError
      && error.operationError === sentinel,
  );

  await assert.rejects(access(target), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
  const [quarantineName] = (await readdir(directory)).filter((name) => name.endsWith('.deleted'));
  assert.ok(quarantineName);
  assert.equal(await readFile(path.join(directory, quarantineName), 'utf8'), 'original\n');
});

test('an alternate read failure after unlink quarantine restores the exact original before failing', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-unlink-alternate-read-'));
  const target = path.join(directory, 'target.txt');
  const alternate = path.join(directory, 'alternate.txt');
  await writeFile(target, 'original\n', { mode: 0o600 });
  const planned = await readRegularFile(target);
  assert.ok(planned);

  await assert.rejects(
    unlinkRegularFileIfUnchanged(target, {
      expected: planned,
      mustRemainAbsent: [alternate],
    }, {
      afterRename: async (_source, destination) => {
        if (!destination.endsWith('.deleted')) return;
        await symlink(destination, alternate);
      },
    }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'SECURITY_REJECTION',
  );

  const restored = await readRegularFile(target);
  assert.ok(restored);
  assert.deepEqual(restored, planned);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.deleted')), false);
});

test('a failed restore after a post-quarantine alternate read error retains committed-unlink ownership', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-unlink-alternate-restore-'));
  const target = path.join(directory, 'target.txt');
  const alternate = path.join(directory, 'alternate.txt');
  await writeFile(target, 'original\n', { mode: 0o600 });
  const planned = await readRegularFile(target);
  assert.ok(planned);
  let ownedArtifact: AtomicCleanupFailure | undefined;

  await assert.rejects(
    unlinkRegularFileIfUnchanged(target, {
      expected: planned,
      mustRemainAbsent: [alternate],
    }, {
      afterRename: async (source, destination) => {
        if (!destination.endsWith('.deleted')) return;
        await writeFile(source, 'concurrent owner\n');
        await symlink(destination, alternate);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedUnlinkError);
      ownedArtifact = error.outcome.cleanupFailures.find((failure) => failure.artifactPath !== undefined);
      assert.ok(ownedArtifact);
      return true;
    },
  );

  assert.equal(await readFile(target, 'utf8'), 'concurrent owner\n');
  assert.ok(ownedArtifact?.artifactPath);
  const artifact = await readRegularFile(ownedArtifact.artifactPath);
  assert.ok(artifact);
  assert.deepEqual(artifact, planned);
  const artifactInfo = await lstat(ownedArtifact.artifactPath, { bigint: true });
  assert.equal(artifactInfo.nlink, 1n);
});

test('an unconditional rename that commits and then throws reports the installed target', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-rename-throws-'));
  const target = path.join(directory, 'target.txt');
  const sentinel = new Error('post-rename sentinel');

  await assert.rejects(
    atomicWriteText(target, 'managed\n', 0o640, {
      afterRename: async () => { throw sentinel; },
    }),
    (error: unknown) => error instanceof AtomicCommittedMutationError
      && error.operationError === sentinel,
  );

  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  assert.deepEqual(await readdir(directory), ['target.txt']);
});

test('an unconditional rename with an extra hard link is committed but not reported as an exact install', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-rename-extra-link-'));
  const target = path.join(directory, 'target.txt');
  const alias = path.join(directory, 'alias.txt');
  const sentinel = new Error('rename committed with alias');

  await assert.rejects(
    atomicWriteText(target, 'managed\n', 0o640, {
      afterRename: async (_source, destination) => {
        await link(destination, alias);
        throw sentinel;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.equal(error.operationError, sentinel);
      assert.equal(error.outcome.cleanupFailures.length, 1);
      assert.equal(error.outcome.cleanupFailures[0]?.artifactPath, undefined);
      return true;
    },
  );

  const targetInfo = await lstat(target, { bigint: true });
  const aliasInfo = await lstat(alias, { bigint: true });
  assert.equal(targetInfo.ino, aliasInfo.ino);
  assert.equal(targetInfo.nlink, 2n);
});

test('temporary cleanup refuses an ABA replacement and reports the owned alias left behind', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-cleanup-aba-'));
  const target = path.join(directory, 'target.txt');
  const movedTemporary = path.join(directory, 'owned-temporary.txt');
  let temporaryPath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: undefined }, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await chmod(temporaryPath, mode);
      },
      afterInstall: async () => {
        await rename(temporaryPath, movedTemporary);
        await writeFile(temporaryPath, 'attacker cleanup replacement\n', { mode: 0o640 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.ok(error.outcome.cleanupFailures.some((failure) => failure.artifactPath === undefined));
      return true;
    },
  );

  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  assert.equal(await readFile(movedTemporary, 'utf8'), 'managed\n');
  assert.equal(await readFile(temporaryPath, 'utf8'), 'attacker cleanup replacement\n');
  const targetInfo = await lstat(target, { bigint: true });
  const movedInfo = await lstat(movedTemporary, { bigint: true });
  assert.equal(targetInfo.ino, movedInfo.ino);
  assert.equal(targetInfo.nlink, 2n);
});

test('cleanup passes its exact quarantine pathname to the pre-cleanup hook', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-cleanup-delegate-'));
  const target = path.join(directory, 'target.txt');
  const calls: string[] = [];

  const outcome = await atomicWriteTextIfUnchanged(
    target,
    'managed\n',
    { expected: undefined },
    0o640,
    {
      beforeCleanup: async (artifactPath) => {
        calls.push(String(artifactPath));
      },
    },
  );

  assert.deepEqual(outcome.cleanupFailures, []);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.endsWith('.cleanup'));
  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  await assert.rejects(access(calls[0] ?? ''), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ENOENT'
  ));
});

test('cleanup refuses hook-swapped quarantine content and never unlinks the unowned replacement', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-cleanup-hook-swap-'));
  const target = path.join(directory, 'target.txt');
  const movedOwned = path.join(directory, 'moved-owned.txt');
  let cleanupPath = '';

  const outcome = await atomicWriteTextIfUnchanged(
    target,
    'managed\n',
    { expected: undefined },
    0o640,
    {
      beforeCleanup: async (artifactPath) => {
        cleanupPath = artifactPath;
        await rename(artifactPath, movedOwned);
        await writeFile(artifactPath, 'unowned replacement\n', { mode: 0o600 });
      },
    },
  );

  assert.equal(outcome.cleanupFailures.length, 1);
  assert.equal(outcome.cleanupFailures[0]?.artifactPath, undefined);
  assert.equal(await readFile(cleanupPath, 'utf8'), 'unowned replacement\n');
  assert.equal(await readFile(movedOwned, 'utf8'), 'managed\n');
  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  const targetInfo = await lstat(target, { bigint: true });
  const movedInfo = await lstat(movedOwned, { bigint: true });
  assert.equal(targetInfo.ino, movedInfo.ino);
  assert.equal(targetInfo.nlink, 2n);
});

test('a post-cleanup validation failure does not run temporary cleanup twice', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-cleanup-once-'));
  const target = path.join(directory, 'target.txt');
  let temporaryPath = '';
  let cleanupCalls = 0;
  let replaced = false;
  const expectation = {
    expected: undefined,
    get containmentRoot(): string {
      if (!replaced && temporaryPath.length > 0 && !existsSync(temporaryPath)) {
        replaced = true;
        unlinkSync(target);
        writeFileSync(target, 'post-cleanup replacement\n');
      }
      return directory;
    },
  };

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', expectation, 0o640, {
      chmod: async (filePath, mode) => {
        temporaryPath = String(filePath);
        await chmod(filePath, mode);
      },
      beforeCleanup: async () => {
        cleanupCalls += 1;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.deepEqual(error.outcome.cleanupFailures, []);
      return true;
    },
  );

  assert.equal(cleanupCalls, 1);
  assert.equal(replaced, true);
  assert.equal(await readFile(target, 'utf8'), 'post-cleanup replacement\n');
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('quarantine cleanup refuses an ABA replacement without deleting attacker or original bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-quarantine-cleanup-aba-'));
  const target = path.join(directory, 'target.txt');
  const savedOriginal = path.join(directory, 'saved-original.txt');
  await writeFile(target, 'original\n', { mode: 0o600 });
  const planned = await readRegularFile(target);
  assert.ok(planned);
  let quarantinePath = '';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: planned }, 0o640, {
      afterInstall: async () => {
        const [quarantineName] = (await readdir(directory)).filter((name) => name.endsWith('.previous'));
        assert.ok(quarantineName);
        quarantinePath = path.join(directory, quarantineName);
        await rename(quarantinePath, savedOriginal);
        await writeFile(quarantinePath, 'attacker cleanup replacement\n', { mode: 0o600 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.ok(error.outcome.cleanupFailures.some((failure) => failure.artifactPath === undefined));
      return true;
    },
  );

  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  assert.equal(await readFile(savedOriginal, 'utf8'), 'original\n');
  assert.equal(await readFile(quarantinePath, 'utf8'), 'attacker cleanup replacement\n');
});

test('temporary tampering reports cleanup failure without claiming target ownership', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-temp-cleanup-'));
  const target = path.join(directory, 'target.txt');
  const cleanupError = new Error('temporary cleanup failed');
  let temporaryPath = '';
  let cleanupArtifact = '';

  try {
    await assert.rejects(
      atomicWriteTextIfUnchanged(target, 'managed\n', { expected: undefined }, 0o640, {
        chmod: async (filePath, mode) => {
          temporaryPath = String(filePath);
          await chmod(filePath, mode);
        },
        beforeCommit: async () => writeFile(temporaryPath, 'tampered\n'),
        beforeCleanup: async () => { throw cleanupError; },
      }),
      (error: unknown) => {
        assert.ok(!(error instanceof AtomicCommittedMutationError));
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, 'Atomic write failed and temporary-file cleanup also failed');
        assert.equal(error.errors.length, 2);
        const [integrityError, reportedCleanupError] = error.errors;
        assert.ok(integrityError instanceof KiokukoError);
        assert.equal(integrityError.code, 'INTEGRITY_ERROR');
        assert.ok(reportedCleanupError instanceof AtomicCleanupFailure);
        assert.equal(reportedCleanupError.cause, cleanupError);
        assert.ok(reportedCleanupError.artifactPath);
        cleanupArtifact = reportedCleanupError.artifactPath;
        return true;
      },
    );

    await assert.rejects(access(target), (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
    ));
    assert.equal(await readFile(cleanupArtifact, 'utf8'), 'tampered\n');
  } finally {
    if (cleanupArtifact.length > 0) await unlink(cleanupArtifact);
  }
});

test('conditional atomic create preserves a file created immediately before commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-write-cas-'));
  const target = path.join(directory, 'target.txt');
  const concurrent = 'concurrent owner\n';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'kiokuko content\n', { expected: undefined }, 0o640, {
      beforeCommit: async () => writeFile(target, concurrent),
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
  assert.equal(await readFile(target, 'utf8'), concurrent);
});

test('conditional atomic create reports a peer installed during the link hook as a conflict', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-write-prelink-cas-'));
  const target = path.join(directory, 'target.txt');
  const concurrent = 'concurrent owner during link hook\n';

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'kiokuko content\n', { expected: undefined }, 0o640, {
      beforeLink: async () => writeFile(target, concurrent),
    }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && error.details.target === target,
  );
  assert.equal(await readFile(target, 'utf8'), concurrent);
  assert.deepEqual(await readdir(directory), ['target.txt']);
});

test('conditional unlink preserves content edited immediately before commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-unlink-cas-'));
  const target = path.join(directory, 'target.txt');
  await writeFile(target, 'planned content\n');
  const planned = await readRegularFile(target);
  assert.ok(planned);

  await assert.rejects(
    unlinkRegularFileIfUnchanged(target, { expected: planned }, {
      beforeCommit: async () => writeFile(target, 'concurrent edit\n'),
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
  assert.equal(await readFile(target, 'utf8'), 'concurrent edit\n');
});

test('conditional rollback rejects a byte-identical ABA replacement by file identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-aba-'));
  const target = path.join(directory, 'target.txt');
  const displaced = path.join(directory, 'displaced.txt');
  await writeFile(target, 'same bytes\n');
  const planned = await readRegularFile(target);
  assert.ok(planned);

  await assert.rejects(
    unlinkRegularFileIfUnchanged(target, { expected: planned }, {
      beforeCommit: async () => {
        await rename(target, displaced);
        await writeFile(target, 'same bytes\n');
      },
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
  assert.equal(await readFile(target, 'utf8'), 'same bytes\n');
});

test('a committed conditional create returns explicit cleanup failure state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-cleanup-'));
  const target = path.join(directory, 'target.txt');
  const outcome = await atomicWriteTextIfUnchanged(target, 'committed\n', { expected: undefined }, 0o640, {
    chmod: async (filePath, mode) => {
      await chmod(filePath, mode);
    },
    beforeCleanup: async () => {
      throw new Error('cleanup failure after commit');
    },
  });

  assert.equal(outcome.installed.content, 'committed\n');
  assert.equal(outcome.cleanupFailures.length, 1);
  assert.throws(
    () => assertAtomicCleanupComplete(outcome),
    (error: unknown) => error instanceof AggregateError
      && error.message === 'File mutation committed, but committed-artifact cleanup failed',
  );
  assert.equal(await readFile(target, 'utf8'), 'committed\n');
  const [cleanupFailure] = outcome.cleanupFailures;
  assert.ok(cleanupFailure);
  assert.ok(cleanupFailure.artifactPath);
  const cleanupSnapshot = await readRegularFile(cleanupFailure.artifactPath);
  assert.ok(cleanupSnapshot);
  assert.deepEqual(cleanupSnapshot, outcome.installed);
  const cleanupInfo = await lstat(cleanupFailure.artifactPath, { bigint: true });
  assert.equal(cleanupInfo.nlink, 2n);
  await unlink(cleanupFailure.artifactPath);
});

test('committed conditional update and unlink return explicit cleanup failure state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-postcommit-cleanup-'));
  const updateTarget = path.join(directory, 'update.txt');
  await writeFile(updateTarget, 'before\n');
  const before = await readRegularFile(updateTarget);
  assert.ok(before);

  const updated = await atomicWriteTextIfUnchanged(updateTarget, 'after\n', { expected: before }, 0o640, {
    beforeCleanup: async () => { throw new Error('postcommit cleanup failed'); },
  });
  assert.equal(updated.installed.content, 'after\n');
  assert.equal(updated.cleanupFailures.length, 2);
  assert.throws(() => assertAtomicCleanupComplete(updated), AggregateError);
  assert.equal(await readFile(updateTarget, 'utf8'), 'after\n');

  const deleteTarget = path.join(directory, 'delete.txt');
  await writeFile(deleteTarget, 'delete me\n');
  const deleteSnapshot = await readRegularFile(deleteTarget);
  assert.ok(deleteSnapshot);
  const deleted = await unlinkRegularFileIfUnchanged(deleteTarget, { expected: deleteSnapshot }, {
    beforeCleanup: async () => { throw new Error('postcommit cleanup failed'); },
  });
  assert.equal(deleted.cleanupFailures.length, 1);
  assert.throws(() => assertAtomicCleanupComplete(deleted), AggregateError);
  await assert.rejects(access(deleteTarget));
});

test('post-rename and post-link failures carry committed target ownership', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-post-install-'));
  const sentinel = new Error('post-install-read-sentinel');
  for (const [name, operation] of [
    ['renamed.txt', (target: string) => atomicWriteText(target, 'committed\n', 0o640, {
      afterInstall: async () => { throw sentinel; },
    })],
    ['linked.txt', (target: string) => atomicWriteTextIfUnchanged(
      target,
      'committed\n',
      { expected: undefined },
      0o640,
      { afterInstall: async () => { throw sentinel; } },
    )],
  ] as const) {
    const target = path.join(directory, name);
    await assert.rejects(operation(target), (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.equal(error.operationError, sentinel);
      assert.equal(error.outcome.installed.content, 'committed\n');
      return true;
    });
    assert.equal(await readFile(target, 'utf8'), 'committed\n');
  }
});

test('conditional update restores the exact original when an alternate appears after install', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-alternate-update-'));
  const target = path.join(directory, 'opencode.json');
  const alternate = path.join(directory, 'opencode.jsonc');
  await writeFile(target, 'original\n');
  const original = await readRegularFile(target);
  assert.ok(original);

  await assert.rejects(
    atomicWriteTextIfUnchanged(
      target,
      'managed\n',
      { expected: original, mustRemainAbsent: [alternate] },
      0o640,
      { afterInstall: async () => writeFile(alternate, 'concurrent\n') },
    ),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
  const restored = await readRegularFile(target);
  assert.ok(restored);
  assert.deepEqual(restored.identity, original.identity);
  assert.equal(restored.content, original.content);
  assert.equal(await readFile(alternate, 'utf8'), 'concurrent\n');
});

test('conditional update reports a target-scoped conflict when a concurrent writer wins before quarantine', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-concurrent-quarantine-'));
  const target = path.join(directory, 'target.txt');
  await writeFile(target, 'original\n');
  const planned = await readRegularFile(target);
  assert.ok(planned);

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: planned }, 0o640, {
      beforeRename: async () => {
        await rename(target, `${target}.concurrent`);
        await writeFile(target, 'concurrent\n');
      },
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && 'details' in error
      && (error.details as { target?: string }).target === target,
  );
  assert.equal(await readFile(target, 'utf8'), 'concurrent\n');
  assert.equal(await readFile(`${target}.concurrent`, 'utf8'), 'original\n');
});

test('a failed create rollback reports the still-installed target as a committed mutation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-alternate-create-rollback-'));
  const target = path.join(directory, 'target.txt');
  const alternate = path.join(directory, 'alternate.txt');
  const sentinel = new Error('create rollback rename failed');

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: undefined,
      mustRemainAbsent: [alternate],
    }, 0o640, {
      afterInstall: async () => writeFile(alternate, 'concurrent\n'),
      beforeRename: async (_source, destination) => {
        if (destination.endsWith('.rollback')) throw sentinel;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.ok(error.operationError instanceof AggregateError);
      assert.equal(error.operationError.errors.includes(sentinel), true);
      assert.equal(error.outcome.cleanupFailures.length, 0);
      return true;
    },
  );

  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  assert.equal(await readFile(alternate, 'utf8'), 'concurrent\n');
  assert.equal((await lstat(target, { bigint: true })).nlink, 1n);
  assert.deepEqual((await readdir(directory)).sort(), ['alternate.txt', 'target.txt']);
});

test('a rollback that removes the managed target still cleans its exact single-link temporary path', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-alternate-create-replaced-'));
  const target = path.join(directory, 'target.txt');
  const alternate = path.join(directory, 'alternate.txt');
  const sentinel = new Error('rollback replaced target after removing managed inode');

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: undefined,
      mustRemainAbsent: [alternate],
    }, 0o640, {
      afterInstall: async () => writeFile(alternate, 'concurrent alternate\n'),
      afterRename: async (source, destination) => {
        if (!destination.endsWith('.rollback')) return;
        await unlink(destination);
        await writeFile(source, 'unrelated target\n');
        throw sentinel;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(!(error instanceof AtomicCommittedMutationError));
      return true;
    },
  );

  assert.equal(await readFile(target, 'utf8'), 'unrelated target\n');
  assert.equal(await readFile(alternate, 'utf8'), 'concurrent alternate\n');
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.rollback')), false);
});

test('a failed update rollback reports the still-installed target and displaced original', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-alternate-update-rollback-'));
  const target = path.join(directory, 'target.txt');
  const alternate = path.join(directory, 'alternate.txt');
  const sentinel = new Error('update rollback rename failed');
  await writeFile(target, 'original\n');
  const original = await readRegularFile(target);
  assert.ok(original);
  let rollbackAttempts = 0;
  let originalArtifact: AtomicCleanupFailure | undefined;

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: original,
      mustRemainAbsent: [alternate],
    }, 0o640, {
      afterInstall: async () => writeFile(alternate, 'concurrent\n'),
      beforeRename: async (_source, destination) => {
        if (!destination.endsWith('.rollback')) return;
        rollbackAttempts += 1;
        throw sentinel;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.ok(error.operationError instanceof AggregateError);
      assert.equal(error.operationError.errors.includes(sentinel), true);
      originalArtifact = error.outcome.cleanupFailures.find(
        (failure) => failure.artifactPath?.endsWith('.previous') === true,
      );
      assert.ok(originalArtifact);
      return true;
    },
  );

  assert.equal(rollbackAttempts, 1);
  assert.equal(await readFile(target, 'utf8'), 'managed\n');
  assert.equal(await readFile(alternate, 'utf8'), 'concurrent\n');
  assert.equal((await lstat(target, { bigint: true })).nlink, 1n);
  assert.ok(originalArtifact?.artifactPath);
  const retainedOriginal = await readRegularFile(originalArtifact.artifactPath);
  assert.ok(retainedOriginal);
  assert.deepEqual(retainedOriginal, original);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('an exact original restored during alternate rollback stays noncommitted when temp observation fails', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-alternate-original-restored-'));
  const target = path.join(directory, 'target.txt');
  const alternate = path.join(directory, 'alternate.txt');
  const attacker = path.join(directory, 'attacker.txt');
  const sentinel = new Error('alternate rollback restored original and replaced temp');
  await writeFile(target, 'original\n');
  await writeFile(attacker, 'attacker\n');
  const original = await readRegularFile(target);
  assert.ok(original);
  let rollbackHooks = 0;
  let rollbackArtifactPath: string | undefined;

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: original,
      mustRemainAbsent: [alternate],
    }, 0o640, {
      afterInstall: async () => writeFile(alternate, 'concurrent\n'),
      afterRename: async (source, destination) => {
        if (!destination.endsWith('.rollback')) return;
        rollbackHooks += 1;
        const names = await readdir(directory);
        const previousName = names.find((name) => name.endsWith('.previous'));
        const temporaryName = names.find((name) => name.endsWith('.tmp'));
        assert.ok(previousName);
        assert.ok(temporaryName);
        await rename(path.join(directory, previousName), source);
        await unlink(path.join(directory, temporaryName));
        await symlink(attacker, path.join(directory, temporaryName));
        throw sentinel;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(!(error instanceof AtomicCommittedMutationError));
      assert.ok(!(error instanceof AtomicCommittedUnlinkError));
      const visit = (item: unknown): void => {
        if (item instanceof AtomicCleanupFailure && item.artifactPath?.endsWith('.rollback') === true) {
          rollbackArtifactPath = item.artifactPath;
        }
        if (item instanceof AggregateError) item.errors.forEach(visit);
      };
      visit(error);
      assert.ok(rollbackArtifactPath);
      return true;
    },
  );

  assert.equal(rollbackHooks, 1);
  const restored = await readRegularFile(target);
  assert.ok(restored);
  assert.deepEqual(restored, original);
  assert.ok(rollbackArtifactPath);
  assert.equal(await readFile(rollbackArtifactPath, 'utf8'), 'managed\n');
  assert.equal(await readFile(attacker, 'utf8'), 'attacker\n');
  const temporaryName = (await readdir(directory)).find((name) => name.endsWith('.tmp'));
  assert.ok(temporaryName);
  assert.equal((await lstat(path.join(directory, temporaryName))).isSymbolicLink(), true);
});

test('conditional installed-target rollback retains committed-unlink ownership after parent replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-rollback-parent-'));
  const parent = path.join(root, 'managed');
  const displacedParent = path.join(root, 'displaced');
  const target = path.join(parent, 'target.txt');
  const alternate = path.join(parent, 'alternate.txt');
  await mkdir(parent);
  await writeFile(target, 'original\n');
  const original = await readRegularFile(target);
  const plannedParent = await readDirectoryIdentity(parent);
  assert.ok(original);
  let rollbackHooks = 0;

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', {
      expected: original,
      expectedParentDirectory: plannedParent,
      mustRemainAbsent: [alternate],
    }, 0o640, {
      afterInstall: async () => writeFile(alternate, 'concurrent\n'),
      afterRename: async (_source, destination) => {
        if (!destination.endsWith('.rollback')) return;
        rollbackHooks += 1;
        await rename(parent, displacedParent);
        await mkdir(parent);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedUnlinkError);
      assert.ok(error.outcome.cleanupFailures.length >= 1);
      assert.ok(error.outcome.cleanupFailures.every((failure) => failure.artifactPath === undefined));
      return true;
    },
  );

  assert.equal(rollbackHooks, 1);
  assert.deepEqual(await readdir(parent), []);
  const displacedNames = await readdir(displacedParent);
  assert.ok(displacedNames.some((name) => name.endsWith('.previous')));
  assert.ok(displacedNames.some((name) => name.endsWith('.rollback')));
  assert.ok(displacedNames.some((name) => name.endsWith('.tmp')));
  assert.ok(displacedNames.includes('alternate.txt'));
  assert.equal(displacedNames.includes('target.txt'), false);
});

test('conditional update preserves a concurrent EEXIST target and reports displaced original artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-quarantine-conflict-'));
  const target = path.join(directory, 'target.txt');
  await writeFile(target, 'original\n');
  const original = await readRegularFile(target);
  assert.ok(original);
  let artifact: AtomicCleanupFailure | undefined;

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: original }, 0o640, {
      afterQuarantine: async () => writeFile(target, 'concurrent owner\n'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      artifact = error.errors.find((item): item is AtomicCleanupFailure => item instanceof AtomicCleanupFailure);
      assert.ok(artifact);
      return true;
    },
  );
  assert.equal(await readFile(target, 'utf8'), 'concurrent owner\n');
  assert.ok(artifact);
  assert.ok(artifact.artifactPath);
  const quarantinedOriginal = await readRegularFile(artifact.artifactPath);
  assert.ok(quarantinedOriginal);
  assert.deepEqual(quarantinedOriginal, original);
  assert.equal((await lstat(artifact.artifactPath, { bigint: true })).nlink, 1n);
  await unlink(artifact.artifactPath);
});

test('post-install replacement preserves concurrent target and reports recoverable original quarantine', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-post-install-swap-'));
  const target = path.join(directory, 'target.txt');
  await writeFile(target, 'original\n');
  const original = await readRegularFile(target);
  assert.ok(original);
  let artifact: AtomicCleanupFailure | undefined;

  await assert.rejects(
    atomicWriteTextIfUnchanged(target, 'managed\n', { expected: original }, 0o640, {
      afterInstall: async () => {
        await unlink(target);
        await writeFile(target, 'concurrent replacement\n');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      artifact = error.errors.find((item): item is AtomicCleanupFailure => item instanceof AtomicCleanupFailure);
      assert.ok(artifact);
      return true;
    },
  );
  assert.equal(await readFile(target, 'utf8'), 'concurrent replacement\n');
  assert.ok(artifact);
  assert.ok(artifact.artifactPath);
  const quarantinedOriginal = await readRegularFile(artifact.artifactPath);
  assert.ok(quarantinedOriginal);
  assert.deepEqual(quarantinedOriginal, original);
  assert.equal((await lstat(artifact.artifactPath, { bigint: true })).nlink, 1n);
  await unlink(artifact.artifactPath);
});

test('managed reads reject invalid UTF-8 instead of replacing bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-utf8-'));
  const target = path.join(directory, 'target.txt');
  await writeFile(target, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    readRegularFile(target),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
  );
});

test('contained managed reads reject intermediate symbolic-link components', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-contained-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-outside-'));
  await writeFile(path.join(outside, 'AGENTS.md'), 'outside\n');
  await mkdir(path.join(root, 'nested'));
  await symlink(outside, path.join(root, 'nested', 'escape'));

  await assert.rejects(
    readRegularFile(path.join(root, 'nested', 'escape', 'AGENTS.md'), { containmentRoot: root }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SECURITY_REJECTION',
  );
});

test('Windows strategy rejects a final symlink without relying on O_NOFOLLOW', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-atomic-windows-'));
  const target = path.join(directory, 'target.txt');
  const linkPath = path.join(directory, 'link.txt');
  await writeFile(target, 'content\n');
  await symlink(target, linkPath);
  await assert.rejects(
    readRegularFile(linkPath, { platform: 'win32' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SECURITY_REJECTION',
  );
});

test('regular-file reads stay on the opened descriptor across a symlink swap', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-regular-file-swap-'));
  const target = path.join(directory, 'target.txt');
  const moved = path.join(directory, 'opened.txt');
  const secret = path.join(directory, 'secret.txt');
  await writeFile(target, 'planned content\n');
  await writeFile(secret, 'secret replacement\n');

  const result = await readRegularFile(target, {
    afterOpen: async () => {
      await rename(target, moved);
      await symlink(secret, target);
    },
  });

  assert.equal(result?.content, 'planned content\n');
  assert.equal(await readFile(target, 'utf8'), 'secret replacement\n');
  assert.equal(await readFile(secret, 'utf8'), 'secret replacement\n');
});

test('regular-file reads reject an initial symbolic link', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-regular-file-link-'));
  const target = path.join(directory, 'target.txt');
  const linkPath = path.join(directory, 'link.txt');
  await writeFile(target, 'content\n');
  await symlink(target, linkPath);

  await assert.rejects(
    readRegularFile(linkPath),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SECURITY_REJECTION',
  );
});

test('regular-file reads preserve both the read failure and descriptor-close failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-regular-file-dual-failure-'));
  const target = path.join(directory, 'target.txt');
  await writeFile(target, 'content\n');
  const readFailure = new Error('read-failure-sentinel');
  const closeFailure = new Error('close-failure-sentinel');

  await assert.rejects(readRegularFile(target, {
    afterOpen: () => { throw readFailure; },
    closeHandle: async (handle) => {
      await handle.close();
      throw closeFailure;
    },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'Regular-file read failed and its file descriptor could not be closed');
    assert.deepEqual(error.errors, [readFailure, closeFailure]);
    return true;
  });
});
