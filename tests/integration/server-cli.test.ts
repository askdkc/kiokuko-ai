import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { runCli } from '../../src/cli.js';
import { runServeCommand } from '../../src/commands/serve.js';
import { runServerStatusCommand } from '../../src/commands/server.js';
import { KiokukoError } from '../../src/errors.js';

function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    read: () => ({ stdout, stderr }),
    restore: () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

test('registers foreground serve and exactly one server status subcommand', () => {
  const cli = buildCli();
  const names = cli.commands.map((command) => command.name());
  assert.ok(names.includes('serve'));

  const server = cli.commands.find((command) => command.name() === 'server');
  assert.ok(server);
  assert.deepEqual(server.commands.map((command) => command.name()), ['status']);
});

test('starts one runtime, waits for foreground shutdown, and removes both signal listeners', async () => {
  const signals = new (await import('node:events')).EventEmitter();
  const descriptor = {
    protocolVersion: '1' as const,
    instanceId: '123e4567-e89b-12d3-a456-426614174010',
    pid: 4321,
    baseUrl: 'http://127.0.0.1:49152',
    databaseFingerprint: `sha256:${'a'.repeat(64)}`,
    startedAt: '2026-08-20T07:00:00.000Z',
  };
  let closeCalls = 0;
  let startup: unknown;
  const command = runServeCommand(
    { host: '127.0.0.1', port: 0 },
    {
      signals,
      startServer: async (options) => {
        assert.deepEqual(options, { host: '127.0.0.1', port: 0 });
        return {
          url: 'http://127.0.0.1:49152',
          descriptor,
          close: async () => {
            closeCalls += 1;
          },
        };
      },
      onStarted: (value) => {
        startup = value;
        signals.emit('SIGINT');
        signals.emit('SIGTERM');
      },
    },
  );

  await command;
  assert.deepEqual(startup, { status: 'running', url: 'http://127.0.0.1:49152', descriptor });
  assert.equal(closeCalls, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('cleans listeners after startup failure and restores counts across repeated runs', async () => {
  const signals = new (await import('node:events')).EventEmitter();
  const initialSigint = signals.listenerCount('SIGINT');
  const initialSigterm = signals.listenerCount('SIGTERM');
  await assert.rejects(
    () => runServeCommand({}, {
      signals,
      startServer: async () => {
        throw new Error('startup-token-sentinel /private/database');
      },
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'DATABASE_ERROR',
  );
  assert.equal(signals.listenerCount('SIGINT'), initialSigint);
  assert.equal(signals.listenerCount('SIGTERM'), initialSigterm);

  let closeCalls = 0;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    await runServeCommand({}, {
      signals,
      startServer: async () => ({
        url: 'http://127.0.0.1:49156',
        descriptor: {
          protocolVersion: '1' as const,
          instanceId: '123e4567-e89b-12d3-a456-426614174014',
          pid: 4325,
          baseUrl: 'http://127.0.0.1:49156',
          databaseFingerprint: `sha256:${'e'.repeat(64)}`,
          startedAt: '2026-08-20T07:00:00.000Z',
        },
        close: async () => {
          closeCalls += 1;
        },
      }),
      onStarted: () => {
        signals.emit(signal);
      },
    });
  }
  assert.equal(closeCalls, 2);
  assert.equal(signals.listenerCount('SIGINT'), initialSigint);
  assert.equal(signals.listenerCount('SIGTERM'), initialSigterm);
});

test('delegates server status queries to getServerStatus without changing missing status', async () => {
  const result = await runServerStatusCommand(
    {},
    {
      getServerStatus: async (options) => {
        assert.deepEqual(options, {});
        return { running: false, stale: false };
      },
    },
  );
  assert.deepEqual(result, { running: false, stale: false });
});

test('serve JSON emits one public startup envelope before graceful shutdown', async () => {
  const signals = new (await import('node:events')).EventEmitter();
  const capabilityToken = '9'.repeat(64);
  const output: string[] = [];
  let closeCalls = 0;
  const exitCode = await runCli(
    ['node', 'kiokuko-ai', 'serve', '--json'],
    {
      server: {
        signals,
        stdout: (text) => {
          output.push(text);
          signals.emit('SIGINT');
          signals.emit('SIGTERM');
        },
        startServer: async () => ({
          url: 'http://127.0.0.1:49153',
          descriptor: {
            protocolVersion: '1' as const,
            instanceId: '123e4567-e89b-12d3-a456-426614174011',
            pid: 4322,
            baseUrl: 'http://127.0.0.1:49153',
            databaseFingerprint: `sha256:${'b'.repeat(64)}`,
            startedAt: '2026-08-20T07:00:00.000Z',
            capabilityToken,
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(closeCalls, 1);
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0] ?? ''), {
    apiVersion: '1',
    ok: true,
    operation: 'serve',
    data: {
      status: 'running',
      url: 'http://127.0.0.1:49153',
      descriptor: {
        protocolVersion: '1',
        instanceId: '123e4567-e89b-12d3-a456-426614174011',
        pid: 4322,
        baseUrl: 'http://127.0.0.1:49153',
        databaseFingerprint: `sha256:${'b'.repeat(64)}`,
        startedAt: '2026-08-20T07:00:00.000Z',
      },
    },
  });
  assert.equal(output.join('').includes(capabilityToken), false);
});

test('normalizes raw startup failures before the JSON error envelope', async () => {
  const capabilityToken = 'startup-token-sentinel';
  const privatePath = '/private/kiokuko/database.sqlite3';
  const capture = captureProcessOutput();
  let exitCode: number;
  try {
    exitCode = await runCli(
      ['node', 'kiokuko-ai', 'serve', '--json'],
      {
        server: {
          startServer: async () => {
            throw new Error(`${capabilityToken} ${privatePath}`);
          },
        },
      },
    );
  } finally {
    const captured = capture.read();
    capture.restore();
    assert.equal(captured.stderr.includes(capabilityToken), false);
    assert.equal(captured.stderr.includes(privatePath), false);
    assert.equal(captured.stdout.includes(capabilityToken), false);
    assert.equal(captured.stdout.includes(privatePath), false);
  }

  assert.equal(exitCode, 6);
  const captured = capture.read();
  const envelope = JSON.parse(captured.stdout) as { operation: string; error: { code: string; message: string } };
  assert.equal(envelope.operation, 'serve');
  assert.equal(envelope.error.code, 'DATABASE_ERROR');
  assert.equal(envelope.error.message, 'Unable to start the HTTP server');
});

test('maps a close failure after serve startup without emitting a second JSON object', async () => {
  const signals = new (await import('node:events')).EventEmitter();
  const capabilityToken = 'close-token-sentinel';
  const capture = captureProcessOutput();
  const output: string[] = [];
  try {
    const exitCode = await runCli(
      ['node', 'kiokuko-ai', 'serve', '--json'],
      {
        server: {
          signals,
          stdout: (text) => {
            output.push(text);
            signals.emit('SIGTERM');
            signals.emit('SIGINT');
          },
          startServer: async () => ({
            url: 'http://127.0.0.1:49154',
            descriptor: {
              protocolVersion: '1' as const,
              instanceId: '123e4567-e89b-12d3-a456-426614174012',
              pid: 4323,
              baseUrl: 'http://127.0.0.1:49154',
              databaseFingerprint: `sha256:${'c'.repeat(64)}`,
              startedAt: '2026-08-20T07:00:00.000Z',
            },
            close: async () => {
              throw new Error(`${capabilityToken} /private/lock`);
            },
          }),
        },
      },
    );
    assert.equal(exitCode, 6);
  } finally {
    const captured = capture.read();
    capture.restore();
    assert.equal(captured.stderr.includes(capabilityToken), false);
    assert.equal(captured.stderr.includes('/private/lock'), false);
  }
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0] ?? '').ok, true);
});

test('uses server.status for JSON status success and typed failure envelopes', async () => {
  const output: string[] = [];
  const success = await runCli(
    ['node', 'kiokuko-ai', 'server', 'status', '--json'],
    {
      server: {
        stdout: (text) => output.push(text),
        getServerStatus: async () => ({ running: false, stale: false }),
      },
    },
  );
  assert.equal(success, 0);
  assert.deepEqual(JSON.parse(output.pop() ?? ''), {
    apiVersion: '1',
    ok: true,
    operation: 'server.status',
    data: { running: false, stale: false },
  });

  const capture = captureProcessOutput();
  let failure: number;
  try {
    failure = await runCli(
      ['node', 'kiokuko-ai', 'server', 'status', '--json'],
      {
        server: {
          getServerStatus: async () => {
            throw new KiokukoError('SERVICE_UNAVAILABLE', 'status-token-sentinel /private/status');
          },
        },
      },
    );
  } finally {
    capture.restore();
  }
  assert.equal(failure, 6);
  const failureEnvelope = JSON.parse(capture.read().stdout) as { operation: string; error: { code: string } };
  assert.equal(failureEnvelope.operation, 'server.status');
  assert.equal(failureEnvelope.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(capture.read().stdout.includes('status-token-sentinel'), false);
});

test('sanitizes injected status descriptors before JSON output', async () => {
  const output: string[] = [];
  const capabilityToken = 'status-token-sentinel';
  const status = {
    running: true,
    stale: false,
    descriptor: {
      protocolVersion: '1' as const,
      instanceId: '123e4567-e89b-12d3-a456-426614174013',
      pid: 4324,
      baseUrl: 'http://127.0.0.1:49155',
      databaseFingerprint: `sha256:${'d'.repeat(64)}`,
      startedAt: '2026-08-20T07:00:00.000Z',
      capabilityToken,
    },
  } as never;
  const exitCode = await runCli(
    ['node', 'kiokuko-ai', 'server', 'status', '--json'],
    {
      server: {
        stdout: (text) => output.push(text),
        getServerStatus: async () => status,
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(output.join('').includes(capabilityToken), false);
  const envelope = JSON.parse(output[0] ?? '') as { data: { descriptor: Record<string, unknown> } };
  assert.equal('capabilityToken' in envelope.data.descriptor, false);
});

test('returns one JSON usage envelope for Commander parsing failures without process.exit', async () => {
  const capture = captureProcessOutput();
  const originalExit = process.exit;
  let exitCalls = 0;
  process.exit = ((code?: number) => {
    exitCalls += 1;
    throw new Error(`process.exit called: ${String(code)}`);
  }) as typeof process.exit;
  let exitCode: number;
  try {
    exitCode = await runCli(['node', 'kiokuko-ai', 'server', 'status', '--json', '--unknown-option']);
  } finally {
    process.exit = originalExit;
  }
  const captured = capture.read();
  capture.restore();
  assert.equal(exitCode, 2);
  assert.equal(exitCalls, 0);
  assert.equal(captured.stderr, '');
  assert.equal(captured.stdout.split('\n').filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(captured.stdout), {
    apiVersion: '1',
    ok: false,
    operation: 'server.status',
    error: {
      code: 'USAGE_ERROR',
      message: 'Invalid command-line usage',
      details: { commanderCode: 'commander.unknownOption' },
    },
  });
});
