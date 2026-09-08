import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const { downloadRelease } = await import(new URL('../../scripts/install-opencode-release.mjs', import.meta.url).href);
const url = 'https://github.com/fixture/release.zip';
const quiet = { log: () => undefined, wait: async () => undefined };
const reset = () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });

test('release download recovers from a connection reset and an interrupted body', async () => {
  let calls = 0;
  const waits: number[] = [];
  const signals: AbortSignal[] = [];
  const bytes = await downloadRelease(url, {
    ...quiet,
    wait: async (milliseconds: number) => { waits.push(milliseconds); },
    fetchImpl: async (requested: string, { signal }: { signal: AbortSignal }) => {
      assert.equal(requested, url);
      signals.push(signal);
      calls++;
      if (calls === 1) throw reset();
      if (calls === 2) return new Response(new ReadableStream({ start(controller) { controller.error(reset()); } }));
      return new Response('complete archive');
    },
  });
  assert.equal(bytes.toString(), 'complete archive');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(new Set(signals).size, 3, 'Every attempt has its own timeout');
});

test('transient HTTP failures release their body and respect Retry-After', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let calls = 0;
    let cancelled = 0;
    const waits: number[] = [];
    await downloadRelease(url, {
      ...quiet,
      wait: async (milliseconds: number) => { waits.push(milliseconds); },
      fetchImpl: async () => ++calls === 1
        ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { status, headers: { 'retry-after': '3' } })
        : new Response('archive'),
    });
    assert.equal(calls, 2);
    assert.equal(cancelled, 1);
    assert.deepEqual(waits, [3000]);
  }
});

test('persistent connection failures and body timeouts stop after three attempts', async () => {
  for (const failure of ['reset', 'body timeout']) {
    let calls = 0;
    const waits: number[] = [];
    await assert.rejects(downloadRelease(url, {
      ...quiet,
      timeoutMs: 1,
      wait: async (milliseconds: number) => { waits.push(milliseconds); },
      fetchImpl: async (_url: string, { signal }: { signal: AbortSignal }) => {
        calls++;
        if (failure === 'reset') throw reset();
        return { ok: true, arrayBuffer: async () => { await delay(10); signal.throwIfAborted(); } };
      },
    }), /(?:ECONNRESET|timeout); attempt 3\/3/u);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
  }
});

test('permanent HTTP errors, TLS failures and excessive Retry-After are not retried', async () => {
  for (const failure of [401, 403, 404, 501, 'tls', 'long delay']) {
    let calls = 0;
    await assert.rejects(downloadRelease(url, {
      ...quiet,
      wait: async () => assert.fail('Permanent failure must not retry'),
      fetchImpl: async () => {
        calls++;
        if (failure === 'tls') throw new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } });
        return new Response(null, {
          status: typeof failure === 'number' ? failure : 429,
          headers: failure === 'long delay' ? { 'retry-after': '120' } : {},
        });
      },
    }), /attempt 1\/3/u);
    assert.equal(calls, 1);
  }
});

test('installer rejects checksum mismatch before writing or extracting, without retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-release-checksum-'));
  try {
    const preload = path.join(root, 'fetch.mjs');
    await writeFile(preload, "globalThis.fetch = async () => { process.stderr.write('fixture-fetch\\n'); return new Response('corrupt archive'); };\n");
    const output = path.join(root, 'opencode');
    await assert.rejects(promisify(execFile)(process.execPath, [
      '--import', preload,
      new URL('../../scripts/install-opencode-release.mjs', import.meta.url).pathname,
      '--version', '1.18.26', '--platform', 'macos-x64', '--output', output,
    ]), (error: unknown) => {
      const result = error as { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /OpenCode release checksum mismatch/u);
      assert.equal(result.stderr.match(/fixture-fetch/gu)?.length, 1);
      return true;
    });
    await assert.rejects(access(output), { code: 'ENOENT' });
    await assert.rejects(access(path.join(root, 'opencode-1.18.26-opencode-darwin-x64.zip')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
