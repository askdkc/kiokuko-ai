import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  extractOpenCodeCompactionSummary,
  KiokukoPlugin,
} from '../../src/opencode/plugin.js';
import { KIOKUKO_OPENCODE_MESSAGE_LIMIT } from '../../src/opencode/idle.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function acceptedChild(payloads: string[]) {
  return {
    stdin: { write(value: string) { payloads.push(value); }, end() {} },
    stdout: stream(JSON.stringify({ accepted: true })),
    stderr: stream(''),
    exited: Promise.resolve(0),
    kill() {},
  } as never;
}

function summary(id = 'summary-message'): object {
  return {
    info: { id, summary: true },
    parts: [{ type: 'text', text: ' bounded compaction summary ' }],
  };
}

function extractionFailureReason(messages: unknown): string {
  const result = extractOpenCodeCompactionSummary(messages);
  assert.equal(result.ok, false);
  return result.ok ? assert.fail('expected compaction summary extraction to fail') : result.reason;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for compaction operation');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function runtimeFixture(t: TestContext, payloads: string[], onSpawn: () => void) {
  const originalBun = (globalThis as { Bun?: unknown }).Bun;
  const root = await mkdtemp(path.join(os.tmpdir(), 'kiokuko-compaction-once-'));
  const executable = path.join(root, 'dist', 'bin', 'kiokuko.js');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, '#!/usr/bin/env node\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'kiokuko-ai', version: PACKAGE_VERSION }));
  await chmod(executable, 0o755);
  (globalThis as { Bun?: unknown }).Bun = {
    spawn: () => {
      onSpawn();
      return acceptedChild(payloads);
    },
  };
  t.after(async () => {
    (globalThis as { Bun?: unknown }).Bun = originalBun;
    await rm(root, { recursive: true, force: true });
  });
  return {
    protocolVersion: 1 as const,
    packageVersion: PACKAGE_VERSION,
    nodeExecutable: process.execPath,
    cliScript: executable,
  };
}

test('compaction summary extraction distinguishes missing, empty, and oversized content', () => {
  const messages = [summary('older'), summary('newer')];
  const original = structuredClone(messages);
  assert.deepEqual(extractOpenCodeCompactionSummary(messages), {
    ok: true,
    summaryMessageId: 'newer',
    summaryText: 'bounded compaction summary',
  });
  assert.deepEqual(messages, original);
  assert.equal(extractionFailureReason([]), 'summary_message_missing');
  assert.equal(extractionFailureReason([
    { info: { id: 'no-text', summary: true }, parts: [{ type: 'tool', text: 'ignored' }] },
  ]), 'summary_text_parts_missing');
  assert.equal(extractionFailureReason([
    { info: { id: 'empty', summary: true }, parts: [{ type: 'text', text: '   ' }] },
  ]), 'summary_text_empty');
  assert.equal(extractionFailureReason([
    { info: { id: 'large', summary: true }, parts: [{ type: 'text', text: 'x'.repeat(64 * 1024 + 1) }] },
  ]), 'summary_text_too_large');
});

test('unusable compaction summaries emit one reasoned warning', async () => {
  const cases = [
    { messages: [], reason: 'summary_message_missing' },
    {
      messages: [{ info: { id: 'no-text', summary: true }, parts: [{ type: 'tool', text: 'ignored' }] }],
      reason: 'summary_text_parts_missing',
    },
    {
      messages: [{ info: { id: 'empty', summary: true }, parts: [{ type: 'text', text: '  ' }] }],
      reason: 'summary_text_empty',
    },
    {
      messages: [{ info: { id: 'large', summary: true }, parts: [{ type: 'text', text: 'x'.repeat(64 * 1024 + 1) }] }],
      reason: 'summary_text_too_large',
    },
  ] as const;
  for (const [index, fixture] of cases.entries()) {
    const reasons: unknown[] = [];
    const hooks = await KiokukoPlugin({
      directory: '/repo',
      client: {
        app: { log: async ({ body }: { body: { extra?: { reason?: unknown } } }) => { reasons.push(body.extra?.reason); } },
        session: {
          list: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          messages: async () => ({ data: fixture.messages }),
        },
      },
    } as never);
    try {
      await hooks.event!({ event: { type: 'session.compacted', properties: { sessionID: `invalid-${index}` } } as never });
      await waitFor(() => reasons.includes(fixture.reason));
      assert.deepEqual(reasons.filter((reason) => reason === fixture.reason), [fixture.reason]);
    } finally {
      await hooks.dispose?.();
    }
  }
});

for (const mode of ['timeout', 'failure'] as const) {
  test(`compaction message read ${mode} emits a reasoned warning and does not reject the hook`, async (t) => {
    if (mode === 'timeout') {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      t.mock.method(AbortSignal, 'timeout', () => timeout(5));
    }
    const reasons: unknown[] = [];
    let query: { limit?: number } | undefined;
    const hooks = await KiokukoPlugin({
      directory: '/repo',
      client: {
        app: { log: async ({ body }: { body: { extra?: { reason?: unknown } } }) => { reasons.push(body.extra?.reason); } },
        session: {
          list: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          messages: ({ query: received, signal }: { query?: { limit?: number }; signal?: AbortSignal }) => {
            query = received;
            if (mode === 'failure') return Promise.reject(new Error('transport unavailable'));
            return new Promise<never>((_resolve, reject) => {
              const abort = () => reject(signal?.reason);
              if (signal?.aborted) abort();
              else signal?.addEventListener('abort', abort, { once: true });
            });
          },
        },
      },
    } as never);
    try {
      await hooks.event!({ event: { type: 'session.compacted', properties: { sessionID: `read-${mode}` } } as never });
      const expected = mode === 'timeout' ? 'read_timeout' : 'read_failed';
      await waitFor(() => reasons.includes(expected));
      assert.equal(query?.limit, KIOKUKO_OPENCODE_MESSAGE_LIMIT);
      assert.equal(reasons.includes('compaction_post_failed'), false);
    } finally {
      await hooks.dispose?.();
    }
  });
}

test('event then autocontinue then event reads three times but enqueues one compaction meditation', async (t) => {
  const payloads: string[] = [];
  const warnings: Array<{ message?: unknown; extra?: { reason?: unknown } }> = [];
  const queries: Array<{ limit?: number } | undefined> = [];
  let hookCalls = 0;
  const runtime = await runtimeFixture(t, payloads, () => { hookCalls += 1; });
  const hooks = await KiokukoPlugin({
    directory: '/repo',
    client: {
      app: { log: async ({ body }: { body: { message?: unknown; extra?: { reason?: unknown } } }) => { warnings.push(body); } },
      session: {
        list: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        messages: async ({ query }: { query?: { limit?: number } }) => {
          queries.push(query);
          return { data: [summary()] };
        },
      },
    },
  } as never, runtime);
  try {
    await hooks.event!({ event: { type: 'session.compacted', properties: { sessionID: 'session-once' } } as never });
    await waitFor(() => hookCalls === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await hooks['experimental.compaction.autocontinue']!({ sessionID: 'session-once' } as never, { enabled: true });
    await waitFor(() => warnings.filter((entry) => entry.extra?.reason === 'already_processed').length === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await hooks.event!({ event: { type: 'session.compacted', properties: { sessionID: 'session-once' } } as never });
    await waitFor(() => warnings.filter((entry) => entry.extra?.reason === 'already_processed').length === 2);

    assert.equal(queries.length, 3);
    assert.equal(queries.every((query) => query?.limit === KIOKUKO_OPENCODE_MESSAGE_LIMIT), true);
    assert.equal(hookCalls, 1);
    assert.equal(payloads.length, 1);
    assert.equal((JSON.parse(payloads[0]!) as { summaryMessageId?: unknown }).summaryMessageId, 'summary-message');
  } finally {
    await hooks.dispose?.();
  }
});

test('concurrent event and autocontinue join one in-flight compaction read', async (t) => {
  const payloads: string[] = [];
  let hookCalls = 0;
  let reads = 0;
  let release!: (value: { data: object[] }) => void;
  const response = new Promise<{ data: object[] }>((resolve) => { release = resolve; });
  const runtime = await runtimeFixture(t, payloads, () => { hookCalls += 1; });
  const hooks = await KiokukoPlugin({
    directory: '/repo',
    client: {
      app: { log: async () => undefined },
      session: {
        list: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        messages: async ({ query }: { query?: { limit?: number } }) => {
          reads += 1;
          assert.equal(query?.limit, KIOKUKO_OPENCODE_MESSAGE_LIMIT);
          return response;
        },
      },
    },
  } as never, runtime);
  try {
    await Promise.all([
      hooks.event!({ event: { type: 'session.compacted', properties: { sessionID: 'session-concurrent' } } as never }),
      hooks['experimental.compaction.autocontinue']!({ sessionID: 'session-concurrent' } as never, { enabled: true }),
    ]);
    assert.equal(reads, 1);
    release({ data: [summary()] });
    await waitFor(() => hookCalls === 1);
    assert.equal(reads, 1);
    assert.equal(payloads.length, 1);
  } finally {
    release?.({ data: [summary()] });
    await hooks.dispose?.();
  }
});
