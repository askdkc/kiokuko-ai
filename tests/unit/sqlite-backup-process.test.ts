import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createBackup } from '../../src/commands/backup.js';
import { initializeDatabase } from '../../src/commands/init.js';
import type { SqliteSerializationDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import {
  createSerializedBackupArtifact,
  requirePosixBackupOpenFlags,
} from '../../src/db/upgrade-backup.js';
import { KiokukoError } from '../../src/errors.js';

const execFile = promisify(execFileCallback);

async function createSentinelDatabase(filePath: string, value: string): Promise<void> {
  await initializeDatabase({ databasePath: filePath });
  const database = openConnection(filePath);
  try {
    database.exec('CREATE TABLE backup_sentinel (value TEXT NOT NULL);');
    database.prepare('INSERT INTO backup_sentinel (value) VALUES (?)').run(value);
    database.exec('PRAGMA journal_mode = DELETE;');
  } finally {
    database.close();
  }
}

function sentinelValue(filePath: string): string | undefined {
  const database = openConnection(filePath, { readOnly: true });
  try {
    return database.prepare('SELECT value FROM backup_sentinel').get<{ value: string }>()?.value;
  } finally {
    database.close();
  }
}

test('serialized backup creates one readable exact snapshot without chmodding its parent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-serialized-backup-'));
  const sourcePath = path.join(directory, 'source.sqlite3');
  const destinationPath = path.join(directory, 'destination.sqlite3');
  await createSentinelDatabase(sourcePath, 'preserved');
  const parentMode = (await stat(directory)).mode;
  const source = openConnection(sourcePath, { readOnly: true });
  try {
    const created = await createSerializedBackupArtifact(source, destinationPath);
    assert.equal(created.path, path.join(await realpath(directory), path.basename(destinationPath)));
  } finally {
    source.close();
  }

  assert.equal((await stat(directory)).mode, parentMode);
  if (process.platform !== 'win32') {
    assert.equal((await stat(destinationPath)).mode & 0o777, 0o600);
  }
  const backup = openConnection(destinationPath, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
    assert.equal(backup.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
    assert.equal(backup.prepare('SELECT value FROM backup_sentinel').get<{ value: string }>()?.value, 'preserved');
  } finally {
    backup.close();
  }
});

test('backup command serializes the already-open source across a pathname ABA', {
  skip: process.platform === 'win32' ? 'Windows does not permit renaming an open SQLite database' : false,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-source-aba-'));
  const sourcePath = path.join(directory, 'source.sqlite3');
  const replacementPath = path.join(directory, 'replacement.sqlite3');
  const displacedPath = path.join(directory, 'source.displaced.sqlite3');
  const destinationPath = path.join(directory, 'destination.sqlite3');
  await createSentinelDatabase(sourcePath, 'original');
  await createSentinelDatabase(replacementPath, 'replacement');
  let swapped = false;

  try {
    await createBackup(destinationPath, sourcePath, {
      async beforeSerialization() {
        await rename(sourcePath, displacedPath);
        await rename(replacementPath, sourcePath);
        swapped = true;
      },
      async afterArtifactWritten() {
        await rename(sourcePath, replacementPath);
        await rename(displacedPath, sourcePath);
        swapped = false;
      },
    });
  } finally {
    if (swapped) {
      await rename(sourcePath, replacementPath);
      await rename(displacedPath, sourcePath);
    }
  }

  assert.equal(sentinelValue(destinationPath), 'original');
  assert.equal(sentinelValue(sourcePath), 'original');
  assert.equal(sentinelValue(replacementPath), 'replacement');
});

test('backup command reads the current database without initializing or migrating it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-no-init-'));
  const sourcePath = path.join(directory, 'source.sqlite3');
  const destinationPath = path.join(directory, 'destination.sqlite3');
  const source = openConnection(sourcePath);
  try {
    source.exec('CREATE TABLE backup_sentinel (value TEXT NOT NULL);');
    source.prepare('INSERT INTO backup_sentinel (value) VALUES (?)').run('unmigrated');
    source.exec('PRAGMA journal_mode = DELETE;');
  } finally {
    source.close();
  }
  const sourceBefore = await readFile(sourcePath);

  await createBackup(destinationPath, sourcePath);

  assert.deepEqual(await readFile(sourcePath), sourceBefore);
  assert.equal(sentinelValue(destinationPath), 'unmigrated');
  const unchanged = openConnection(sourcePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('backup command reports CONFLICT and preserves a pre-existing destination exactly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-existing-'));
  const sourcePath = path.join(directory, 'source.sqlite3');
  const destinationPath = path.join(directory, 'destination.sqlite3');
  const victim = Buffer.from('existing destination must survive');
  await createSentinelDatabase(sourcePath, 'source');
  const sourceBefore = await readFile(sourcePath);
  await writeFile(destinationPath, victim, { flag: 'wx' });

  await assert.rejects(
    createBackup(destinationPath, sourcePath),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && error.message === 'Backup destination already exists',
  );
  assert.deepEqual(await readFile(destinationPath), victim);
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
});

test('backup command rejects every reserved SQLite sidecar name without source mutation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-sidecar-'));
  const sourcePath = path.join(directory, 'source.sqlite3');
  await createSentinelDatabase(sourcePath, 'source');
  const sourceBefore = await readFile(sourcePath);

  for (const suffix of ['-wal', '-shm', '-journal', '-mj deterministic']) {
    const destinationPath = `${sourcePath}${suffix}`;
    await assert.rejects(
      createBackup(destinationPath, sourcePath),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'VALIDATION_ERROR'
        && /reserved SQLite sidecar/u.test(error.message),
      suffix,
    );
    await assert.rejects(stat(destinationPath), { code: 'ENOENT' });
    assert.deepEqual(await readFile(sourcePath), sourceBefore);
  }
});

test('backup command fails explicitly when the source database does not exist', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-missing-'));
  const sourcePath = path.join(directory, 'missing.sqlite3');
  const destinationPath = path.join(directory, 'destination.sqlite3');

  await assert.rejects(
    createBackup(destinationPath, sourcePath),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'NOT_FOUND'
      && /does not exist/u.test(error.message),
  );
  await assert.rejects(stat(sourcePath), { code: 'ENOENT' });
  await assert.rejects(stat(destinationPath), { code: 'ENOENT' });
});

test('serialized backup rejects unavailable or malformed serialization before filesystem mutation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-invalid-serialize-'));
  const unsupportedOutput = path.join(directory, 'unsupported.sqlite3');
  const malformedOutput = path.join(directory, 'malformed.sqlite3');
  const unsupportedError = new Error('serialize unavailable sentinel');
  const unsupported: SqliteSerializationDatabase = {
    serializeDatabase() { throw unsupportedError; },
  };
  const malformed: SqliteSerializationDatabase = {
    serializeDatabase() { return new Uint8Array(100); },
  };

  await assert.rejects(
    createSerializedBackupArtifact(unsupported, unsupportedOutput),
    (error: unknown) => error === unsupportedError,
  );
  await assert.rejects(
    createSerializedBackupArtifact(malformed, malformedOutput),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && /invalid file header/u.test(error.message),
  );
  await assert.rejects(stat(unsupportedOutput), { code: 'ENOENT' });
  await assert.rejects(stat(malformedOutput), { code: 'ENOENT' });
});

test('serialized backup rejects non-portable Windows aliases before serialization or filesystem mutation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-portable-name-'));
  let serializationCalls = 0;
  const database: SqliteSerializationDatabase = {
    serializeDatabase() {
      serializationCalls += 1;
      throw new Error('destination validation must precede serialization');
    },
  };

  for (const fileName of [
    'destination.sqlite3:stream',
    'source.sqlite3-wal.',
    'source.sqlite3-journal ',
    'CON',
    'nul.sqlite3',
    'COM1.backup',
    'LPT9.sqlite3',
    'COM¹.backup',
    'LPT³.sqlite3',
    'CONIN$.sqlite3',
    'CONOUT$.sqlite3',
    'invalid<.sqlite3',
    'invalid>.sqlite3',
    'invalid".sqlite3',
    'invalid|.sqlite3',
    'invalid?.sqlite3',
    'invalid*.sqlite3',
    'invalid\u0001.sqlite3',
  ]) {
    await assert.rejects(
      createSerializedBackupArtifact(database, path.join(directory, fileName)),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'VALIDATION_ERROR'
        && /portable standalone file/u.test(error.message),
      fileName,
    );
  }

  for (const destination of [
    `${path.join(directory, 'missing-parent')}${path.sep}`,
    path.join(directory, 'malformed-\ud800.sqlite3'),
  ]) {
    await assert.rejects(
      createSerializedBackupArtifact(database, destination),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'VALIDATION_ERROR',
      destination,
    );
  }

  assert.equal(serializationCalls, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('POSIX backup open flags are one mandatory fail-closed capability', () => {
  const complete = { O_DIRECTORY: 0x01, O_NOFOLLOW: 0x02, O_NONBLOCK: 0x04 };
  assert.deepEqual(requirePosixBackupOpenFlags('linux', complete), {
    directory: 0x01,
    noFollow: 0x02,
    nonBlock: 0x04,
  });
  assert.equal(requirePosixBackupOpenFlags('win32', {}), undefined);

  for (const [flag, available] of [
    ['O_DIRECTORY', { O_NOFOLLOW: 0x02, O_NONBLOCK: 0x04 }],
    ['O_NOFOLLOW', { O_DIRECTORY: 0x01, O_NONBLOCK: 0x04 }],
    ['O_NONBLOCK', { O_DIRECTORY: 0x01, O_NOFOLLOW: 0x02 }],
  ] as const) {
    assert.throws(
      () => requirePosixBackupOpenFlags('linux', available),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'INTEGRITY_ERROR'
        && error.details.flag === flag,
      flag,
    );
  }
});

test('handoff replacement fails closed and is never deleted by cleanup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-replacement-'));
  const sourcePath = path.join(directory, 'source.sqlite3');
  const destinationPath = path.join(directory, 'destination.sqlite3');
  const displacedPath = path.join(directory, 'destination.attested.sqlite3');
  const replacement = Buffer.from('replacement must survive failed handoff');
  await createSentinelDatabase(sourcePath, 'source');
  const source = openConnection(sourcePath, { readOnly: true });
  try {
    await assert.rejects(
      createSerializedBackupArtifact(source, destinationPath, {
        async afterArtifactWritten(output) {
          await rename(output, displacedPath);
          await writeFile(output, replacement, { flag: 'wx' });
        },
      }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
    );
  } finally {
    source.close();
  }

  assert.deepEqual(await readFile(destinationPath), replacement);
  assert.equal(sentinelValue(displacedPath), 'source');
});

test('FIFO substitution fails closed without blocking artifact verification', {
  skip: process.platform === 'win32' ? 'Windows named pipes are not filesystem FIFOs' : false,
  timeout: 5_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-fifo-'));
  const sourcePath = path.join(directory, 'source.sqlite3');
  const destinationPath = path.join(directory, 'destination.sqlite3');
  const displacedPath = path.join(directory, 'destination.attested.sqlite3');
  await createSentinelDatabase(sourcePath, 'source');
  const source = openConnection(sourcePath, { readOnly: true });
  try {
    await assert.rejects(
      createSerializedBackupArtifact(source, destinationPath, {
        async afterArtifactWritten(output) {
          await rename(output, displacedPath);
          await execFile('/usr/bin/mkfifo', [output]);
        },
      }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
    );
  } finally {
    source.close();
  }

  assert.equal((await stat(destinationPath)).isFIFO(), true);
  assert.equal(sentinelValue(displacedPath), 'source');
});

test('explicit output-directory interposition fails without writing through the replacement', {
  skip: process.platform === 'win32' ? 'Directory symlink creation requires privileges on Windows' : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-backup-directory-race-'));
  const sourcePath = path.join(root, 'source.sqlite3');
  const outputDirectory = path.join(root, 'output');
  const displacedDirectory = path.join(root, 'output.displaced');
  const outsideDirectory = path.join(root, 'outside');
  const destinationPath = path.join(outputDirectory, 'destination.sqlite3');
  await createSentinelDatabase(sourcePath, 'source');
  await mkdir(outputDirectory, { mode: 0o700 });
  await mkdir(outsideDirectory, { mode: 0o700 });
  const sourceBefore = await readFile(sourcePath);
  const source = openConnection(sourcePath, { readOnly: true });
  try {
    await assert.rejects(
      createSerializedBackupArtifact(source, destinationPath, {
        async afterDirectoryBound() {
          await rename(outputDirectory, displacedDirectory);
          await symlink(outsideDirectory, outputDirectory, 'dir');
        },
      }),
      /directory identity changed|directory changed/u,
    );
  } finally {
    source.close();
  }

  assert.deepEqual(await readdir(outsideDirectory), []);
  assert.deepEqual(await readdir(displacedDirectory), []);
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
});
