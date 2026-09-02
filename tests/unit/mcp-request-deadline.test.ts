import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { BoundedStdioServerTransport } from '../../src/mcp/bounded-stdio-transport.js';
import {
  McpRequestCancelledError,
  McpRequestTimeoutError,
  createMcpDeadlinePolicy,
  operationDeadlineClass,
  runWithMcpDeadline,
} from '../../src/mcp/request-deadline.js';

test('stdio input end closes the transport exactly once', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new BoundedStdioServerTransport(input, output);
  let closes = 0;
  transport.onclose = () => { closes += 1; };
  await transport.start();
  await new Promise<void>((resolve) => {
    transport.onclose = () => { closes += 1; resolve(); };
    input.end();
  });
  await transport.close();
  assert.equal(closes, 1);
});

test('deadline utility validates policy and bounds child operations by the parent deadline', () => {
  const policy = createMcpDeadlinePolicy({ readMs: 20, externalMs: 15, mutationMs: 25, hardMaxMs: 30 });
  assert.deepEqual(policy, { readMs: 20, externalMs: 15, mutationMs: 25, hardMaxMs: 30 });
  assert.throws(() => createMcpDeadlinePolicy({ readMs: 9 }), /between/u);
  assert.throws(() => createMcpDeadlinePolicy({ hardMaxMs: 20, mutationMs: 21 }), /hard maximum/u);
});

test('enno_advice_read uses the read deadline class', () => {
  assert.equal(operationDeadlineClass('enno_advice_read'), 'read');
});

test('deadline utility aborts the operation and rejects with a stable timeout error', async () => {
  let aborted = false;
  const secret = 'timeout-secret-must-not-escape';
  await assert.rejects(
    runWithMcpDeadline({
      operation: 'task_prepare',
      timeoutMs: 20,
      operationFn: async (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = signal.aborted;
          reject(secret);
        }, { once: true });
      }),
    }),
    (error: unknown) => {
      assert.equal(error instanceof McpRequestTimeoutError, true);
      assert.deepEqual(error instanceof McpRequestTimeoutError ? {
        code: error.code,
        message: error.message,
        operation: error.operation,
        retryable: error.retryable,
      } : undefined, {
        code: 'MCP_REQUEST_TIMEOUT',
        message: 'MCP request timed out',
        operation: 'task_prepare',
        retryable: true,
      });
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
  assert.equal(aborted, true);
});

test('deadline utility distinguishes caller cancellation from timeout and operation failure', async () => {
  const caller = new AbortController();
  let started = false;
  const cancelled = runWithMcpDeadline({
    operation: 'curator_check',
    timeoutMs: 100,
    signal: caller.signal,
    operationFn: (signal) => new Promise<never>((_resolve, reject) => {
      started = true;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  caller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof McpRequestCancelledError);
  assert.equal(started, false);

  await assert.rejects(
    runWithMcpDeadline({ operation: 'curator_check', timeoutMs: 100, operationFn: async () => { throw new Error('operation failed'); } }),
    /operation failed/u,
  );
});

test('deadline utility consumes late operation rejection and exposes remaining time', async () => {
  let childTimeout = 0;
  await assert.rejects(
    runWithMcpDeadline({
      operation: 'task_answer',
      timeoutMs: 20,
      operationFn: (signal, context) => new Promise<never>((_resolve, reject) => {
        childTimeout = context.childTimeoutMs(1000);
        signal.addEventListener('abort', () => setTimeout(() => reject(new Error('late failure')), 10), { once: true });
      }),
    }),
    (error: unknown) => error instanceof McpRequestTimeoutError,
  );
  assert.ok(childTimeout >= 0 && childTimeout <= 20);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
});
