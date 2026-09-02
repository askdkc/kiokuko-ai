import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runCli } from '../../src/cli.js';
import { getGlobalDatabasePath } from '../../src/config/paths.js';

interface CapturedErrorEnvelope {
  ok: boolean;
  operation: string;
  error: { code: string; message: string };
}

async function captureCli(argv: string[]): Promise<{ exitCode: number; envelope: CapturedErrorEnvelope }> {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = await runCli(argv);
    return { exitCode, envelope: JSON.parse(output) as CapturedErrorEnvelope };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function withIsolatedDataHome<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const keys = ['HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE'] as const;
  const originals = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<(typeof keys)[number], string | undefined>;
  process.env.HOME = root;
  process.env.XDG_DATA_HOME = path.join(root, 'data');
  process.env.LOCALAPPDATA = path.join(root, 'local-app-data');
  process.env.APPDATA = path.join(root, 'app-data');
  process.env.USERPROFILE = root;
  try {
    return await operation();
  } finally {
    for (const key of keys) {
      const original = originals[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

async function captureStdinCall(input: string | Buffer, entryPoint = fileURLToPath(
  new URL('../../src/bin/kiokuko.ts', import.meta.url),
)): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    entryPoint,
    'call',
    '--input-json',
    '-',
  ], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

test('generic JSON call rejects every retired memory-returning operation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-call-cleanbreak-'));

  for (const operation of ['read', 'search', 'recall', 'guide_context']) {
    const inputPath = path.join(root, `${operation}.json`);
    await writeFile(inputPath, `${JSON.stringify({ apiVersion: '1', operation, arguments: {} })}\n`);
    const { exitCode, envelope } = await captureCli(['node', 'kiokuko-ai', 'call', '--input-json', inputPath]);
    assert.equal(exitCode, 3);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.operation, 'call');
    assert.equal(envelope.error.code, 'VALIDATION_ERROR');
    assert.equal(envelope.error.message, `Unknown operation: ${operation}`);
  }
});

test('generic JSON call rejects non-strict JSON and every noncanonical envelope shape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-call-boundary-'));
  const valid = '{"apiVersion":"1","operation":"backup","arguments":{}}';
  const cases: Array<{ name: string; content: string | Buffer; message: RegExp }> = [
    {
      name: 'duplicate-top-level',
      content: '{"apiVersion":"1","operation":"backup","operation":"doctor","arguments":{}}',
      message: /not valid JSON with unique keys/u,
    },
    {
      name: 'duplicate-arguments',
      content: '{"apiVersion":"1","operation":"backup","arguments":{"output":"a","output":"b"}}',
      message: /not valid JSON with unique keys/u,
    },
    { name: 'bom', content: `\uFEFF${valid}`, message: /not valid JSON with unique keys/u },
    { name: 'invalid-utf8', content: Buffer.from([0xc3, 0x28]), message: /not valid JSON with unique keys/u },
    { name: 'array-request', content: '[]', message: /^Request must be a JSON object$/u },
    {
      name: 'missing-arguments',
      content: '{"apiVersion":"1","operation":"backup"}',
      message: /exactly apiVersion, operation, and arguments/u,
    },
    {
      name: 'missing-operation',
      content: '{"apiVersion":"1","arguments":{}}',
      message: /exactly apiVersion, operation, and arguments/u,
    },
    {
      name: 'missing-api-version',
      content: '{"operation":"backup","arguments":{}}',
      message: /exactly apiVersion, operation, and arguments/u,
    },
    {
      name: 'extra-field',
      content: '{"apiVersion":"1","operation":"backup","arguments":{},"legacy":true}',
      message: /exactly apiVersion, operation, and arguments/u,
    },
    {
      name: 'wrong-api-version',
      content: '{"apiVersion":1,"operation":"backup","arguments":{}}',
      message: /^apiVersion must be "1"$/u,
    },
    {
      name: 'empty-operation',
      content: '{"apiVersion":"1","operation":"","arguments":{}}',
      message: /^operation must be a non-empty string$/u,
    },
    {
      name: 'wrong-operation-type',
      content: '{"apiVersion":"1","operation":1,"arguments":{}}',
      message: /^operation must be a non-empty string$/u,
    },
    {
      name: 'array-arguments',
      content: '{"apiVersion":"1","operation":"backup","arguments":[]}',
      message: /^arguments must be a JSON object$/u,
    },
    {
      name: 'missing-arguments-value',
      content: '{"apiVersion":"1","operation":"backup","arguments":null}',
      message: /^arguments must be a JSON object$/u,
    },
    {
      name: 'string-arguments',
      content: '{"apiVersion":"1","operation":"backup","arguments":"legacy"}',
      message: /^arguments must be a JSON object$/u,
    },
  ];

  for (const fixture of cases) {
    const inputPath = path.join(root, `${fixture.name}.json`);
    await writeFile(inputPath, fixture.content);
    const { exitCode, envelope } = await captureCli([
      'node',
      'kiokuko',
      'call',
      '--input-json',
      inputPath,
    ]);
    assert.equal(exitCode, 3, fixture.name);
    assert.equal(envelope.operation, 'call', fixture.name);
    assert.equal(envelope.error.code, 'VALIDATION_ERROR', fixture.name);
    assert.match(envelope.error.message, fixture.message, fixture.name);
  }

  const oversizedPath = path.join(root, 'oversized.json');
  await writeFile(oversizedPath, Buffer.alloc((2 * 1024 * 1024) + 1, 0x20));
  const oversized = await captureCli(['node', 'kiokuko-ai', 'call', '--input-json', oversizedPath]);
  assert.equal(oversized.exitCode, 3);
  assert.equal(oversized.envelope.error.code, 'VALIDATION_ERROR');
  assert.match(oversized.envelope.error.message, /not valid JSON with unique keys/u);

  const validPath = path.join(root, 'valid.json');
  await writeFile(validPath, valid);
  const dispatched = await captureCli(['node', 'kiokuko-ai', 'call', '--input-json', validPath]);
  assert.equal(dispatched.exitCode, 3);
  assert.equal(dispatched.envelope.error.message, 'backup output is required');
});

test('generic JSON call validates exact operation arguments before any side effect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-call-arguments-'));
  await withIsolatedDataHome(root, async () => {
    const databasePath = getGlobalDatabasePath();
    const cases: Array<{ name: string; request: Record<string, unknown>; message: RegExp }> = [
      {
        name: 'malformed-use-root',
        request: { apiVersion: '1', operation: 'use', arguments: { root: 1, dryRun: true } },
        message: /^use\.root must be a non-empty string$/u,
      },
      {
        name: 'ignored-init-field',
        request: { apiVersion: '1', operation: 'init', arguments: { legacy: true } },
        message: /^Unknown init argument: legacy$/u,
      },
      {
        name: 'ignored-doctor-field',
        request: { apiVersion: '1', operation: 'doctor', arguments: { legacy: true } },
        message: /^Unknown doctor argument: legacy$/u,
      },
      {
        name: 'coerced-backup-output',
        request: { apiVersion: '1', operation: 'backup', arguments: { output: 123 } },
        message: /^backup\.output must be a non-empty string$/u,
      },
      {
        name: 'nul-backup-output',
        request: { apiVersion: '1', operation: 'backup', arguments: { output: 'bad\0path' } },
        message: /^backup\.output must be a bounded path without control characters$/u,
      },
      {
        name: 'extra-export-field',
        request: {
          apiVersion: '1',
          operation: 'export',
          arguments: { workspace: 'project:strict-call', output: 'out.jsonl', legacy: true },
        },
        message: /^Unknown export argument: legacy$/u,
      },
    ];

    for (const fixture of cases) {
      const inputPath = path.join(root, `${fixture.name}.json`);
      await writeFile(inputPath, JSON.stringify(fixture.request));
      const { exitCode, envelope } = await captureCli([
        'node',
        'kiokuko',
        'call',
        '--input-json',
        inputPath,
      ]);
      assert.equal(exitCode, 3, fixture.name);
      assert.equal(envelope.operation, 'call', fixture.name);
      assert.equal(envelope.error.code, 'VALIDATION_ERROR', fixture.name);
      assert.match(envelope.error.message, fixture.message, fixture.name);
      await assert.rejects(access(databasePath), fixture.name);
    }
  });
});

test('generic JSON call reports a missing input file as not found', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-call-missing-input-'));
  const { exitCode, envelope } = await captureCli([
    'node',
    'kiokuko',
    'call',
    '--input-json',
    path.join(root, 'missing.json'),
  ]);
  assert.equal(exitCode, 4);
  assert.equal(envelope.operation, 'call');
  assert.equal(envelope.error.code, 'NOT_FOUND');
  assert.equal(envelope.error.message, 'JSON input file does not exist');
});

test('record input uses the same bounded strict JSON boundary before database initialization', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-record-boundary-'));
  await withIsolatedDataHome(root, async () => {
    const databasePath = getGlobalDatabasePath();
    const cases: Array<{ name: string; content: string | Buffer; message: RegExp }> = [
      {
        name: 'duplicate',
        content: '{"kind":"fact","kind":"lesson"}',
        message: /not valid JSON with unique keys/u,
      },
      {
        name: 'bom',
        content: '\uFEFF{"kind":"fact"}',
        message: /not valid JSON with unique keys/u,
      },
      {
        name: 'invalid-utf8',
        content: Buffer.from([0xc3, 0x28]),
        message: /not valid JSON with unique keys/u,
      },
      {
        name: 'array',
        content: '[]',
        message: /^record input must be a JSON object$/u,
      },
      {
        name: 'missing-required-fields',
        content: '{}',
        message: /^kind must be one of:/u,
      },
    ];
    for (const fixture of cases) {
      const inputPath = path.join(root, `record-${fixture.name}.json`);
      await writeFile(inputPath, fixture.content);
      const { exitCode, envelope } = await captureCli([
        'node',
        'kiokuko',
        'record',
        '--workspace',
        'project:strict-record',
        '--input-json',
        inputPath,
        '--json',
      ]);
      assert.equal(exitCode, 3, fixture.name);
      assert.equal(envelope.operation, 'record', fixture.name);
      assert.equal(envelope.error.code, 'VALIDATION_ERROR', fixture.name);
      assert.match(envelope.error.message, fixture.message, fixture.name);
      await assert.rejects(access(databasePath), fixture.name);
    }
  });
});

test('generic JSON call preserves strict stdin input with --input-json -', async () => {
  const result = await captureStdinCall(
    '{"apiVersion":"1","operation":"backup","arguments":{}}\n',
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout) as CapturedErrorEnvelope;
  assert.equal(envelope.operation, 'call');
  assert.equal(envelope.error.code, 'VALIDATION_ERROR');
  assert.equal(envelope.error.message, 'backup output is required');
});

test('generic JSON call fails closed when an embedding pre-decodes stdin bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-call-encoded-stdin-'));
  const launcherPath = path.join(root, 'encoded-stdin.mjs');
  const binUrl = pathToFileURL(
    fileURLToPath(new URL('../../src/bin/kiokuko.ts', import.meta.url)),
  ).href;
  await writeFile(
    launcherPath,
    `process.stdin.setEncoding('utf8');\nawait import(${JSON.stringify(binUrl)});\n`,
  );
  const malformed = Buffer.concat([
    Buffer.from('{"apiVersion":"1","operation":"backup","arguments":{"value":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}}\n'),
  ]);

  const result = await captureStdinCall(malformed, launcherPath);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout) as CapturedErrorEnvelope;
  assert.equal(envelope.operation, 'call');
  assert.equal(envelope.error.code, 'VALIDATION_ERROR');
  assert.equal(envelope.error.message, 'Input is not valid JSON with unique keys');
});

test('generic JSON call fails closed when an embedding already consumed stdin bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-call-consumed-stdin-'));
  const launcherPath = path.join(root, 'consumed-stdin.mjs');
  const binUrl = pathToFileURL(
    fileURLToPath(new URL('../../src/bin/kiokuko.ts', import.meta.url)),
  ).href;
  await writeFile(
    launcherPath,
    `await new Promise((resolve) => process.stdin.once('readable', resolve));\nprocess.stdin.read(1);\nawait import(${JSON.stringify(binUrl)});\n`,
  );

  const result = await captureStdinCall(
    'X{"apiVersion":"1","operation":"backup","arguments":{}}\n',
    launcherPath,
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout) as CapturedErrorEnvelope;
  assert.equal(envelope.operation, 'call');
  assert.equal(envelope.error.code, 'VALIDATION_ERROR');
  assert.equal(envelope.error.message, 'Input is not valid JSON with unique keys');
});
