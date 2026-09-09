import assert from 'node:assert/strict';
import test from 'node:test';
import { rm, writeFile, symlink, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SourceContextService } from '../../src/source-context/service.js';
import { runSourceProcess } from '../../src/source-context/process.js';
import { setupSource } from '../../src/source-context/install.js';
import { readReleaseArchive } from '../../src/source-context/archive.js';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sourceFixture, packFixture, tarFixture } from '../fixtures/source-context.js';

test('bounded source context preserves uncertainty, caches current content, and refreshes edits', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const service = new SourceContextService(); let scans = 0;
  const runner: typeof f.runner = async request => {
    if (!request.args.includes('--version')) {
      scans++;
      assert.notEqual(request.cwd, f.root);
      assert.equal(await readFile(path.join(request.cwd, 'code.ts'), 'utf8'), await readFile(path.join(f.root, 'code.ts'), 'utf8'));
      assert.ok(request.args.includes('--json')); assert.ok(!request.args.includes('--no-redact'));
    }
    return f.runner(request);
  };
  const input = { cwd: f.root, task: 'greet' }, deps = { directory: f.directory, runner };
  const first = await service.inspect(input, deps);
  assert.equal(first.status, 'degraded'); assert.equal(first.symbols[0]?.path, 'code.ts');
  assert.equal(first.completeness.parseHealth, null); assert.equal(first.completeness.testsExhaustive, false);
  const second = await service.inspect(input, deps);
  assert.equal(second.reused, true); assert.equal(scans, 1); assert.equal(second.resultDigest, first.resultDigest);
  await writeFile(path.join(f.root, 'code.ts'), 'export function greet() { return 2; }\n');
  const changed = await service.inspect(input, deps);
  assert.equal(scans, 2); assert.notEqual(changed.sourceDigest, first.sourceDigest);
  await writeFile(path.join(f.root, 'new.mts'), 'export function newer() {}');
  const added = await service.inspect(input, deps); assert.notEqual(added.sourceDigest, changed.sourceDigest);
  await rm(path.join(f.root, 'new.mts'));
  service.clear(); await service.inspect(input, deps); assert.equal(scans, 4);
  assert.ok((await readdir(path.join(f.directory, 'cache'))).every(p => !p.startsWith('.source-')));
});

test('ignored files and symlinks never enter the parser copy', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await writeFile(path.join(f.root, '.gitignore'), 'ignored.ts\n');
  await writeFile(path.join(f.root, 'ignored.ts'), 'do not read');
  await symlink('/does/not/exist/outside.ts', path.join(f.root, 'outside.ts'));
  const runner: typeof f.runner = async request => {
    if (!request.args.includes('--version')) {
      const names = await readdir(request.cwd); assert.deepEqual(names, ['code.ts']);
    }
    return f.runner(request);
  };
  const result = await new SourceContextService().inspect({ cwd: f.root, task: 'greet' }, { directory: f.directory, runner });
  assert.equal(result.status, 'degraded');
});

test('unknown versions, malformed output and paths degrade without forwarding unsafe bytes', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  for (const [expected, payload] of [
    ['invalid_response', '{'], ['invalid_response', JSON.stringify({ ...packFixture(), futureField: 1 })],
    ['unsafe_output_path', JSON.stringify({ ...packFixture(), ranking: [{ p: '../outside.ts', n: 'bad', l: 1 }] })],
  ] as const) {
    const result = await new SourceContextService().inspect({ cwd: f.root, task: 'greet' }, { directory: f.directory,
      runner: async request => request.args.includes('--version') ? f.runner(request) : { code: 0, stdout: Buffer.from(payload), stderr: Buffer.alloc(0) } });
    assert.deepEqual(result.reasons, [expected]); assert.deepEqual(result.symbols, []);
  }
  const result = await new SourceContextService().inspect({ cwd: f.root, task: 'greet' }, { directory: f.directory,
    runner: async () => ({ code: 0, stdout: Buffer.from('ripwire 99.0.0'), stderr: Buffer.alloc(0) }) });
  assert.deepEqual(result.reasons, ['unsupported_version']);
});

test('mutation during investigation discards the result and caller cancellation propagates', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const result = await new SourceContextService().inspect({ cwd: f.root, task: 'greet' }, { directory: f.directory,
    runner: async request => {
      if (!request.args.includes('--version')) await writeFile(path.join(f.root, 'code.ts'), 'export function greet() { return 9; }');
      return f.runner(request);
    } });
  assert.deepEqual(result.reasons, ['source_changed']);
  const controller = new AbortController(); controller.abort(new Error('caller cancelled'));
  await assert.rejects(new SourceContextService().inspect({ cwd: f.root, task: 'greet' }, { directory: f.directory, signal: controller.signal }), /caller cancelled/u);
});

test('real process adapter bounds output and kills process groups on cancellation', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await assert.rejects(runSourceProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(10000))'],
    cwd: f.root, signal: AbortSignal.timeout(2000), stdoutLimit: 100 }), /output_limit/u);
  await assert.rejects(runSourceProcess({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: f.root, signal: AbortSignal.timeout(50) }), { name: 'TimeoutError' });
  await assert.rejects(runSourceProcess({ executable: process.execPath, args: ['-e', 'process.stderr.write("x".repeat(10000))'],
    cwd: f.root, signal: AbortSignal.timeout(2000), stderrLimit: 100 }), /output_limit/u);
  const descendants = await runSourceProcess({ executable: process.execPath,
    args: ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});process.exit(0)'],
    cwd: f.root, signal: AbortSignal.timeout(2000) });
  assert.equal(descendants.code, 0, 'descendants retaining stdout are killed before returning');
});

test('release archive rejects traversal, links, duplicate names and invalid checksums', () => {
  for (const entries of [
    [{ name: 'release/../escape' }], [{ name: 'release/link', type: '2' }], [{ name: '/release/absolute' }],
    [{ name: 'release/dup' }, { name: 'release/dup' }],
  ]) assert.throws(() => readReleaseArchive(tarFixture(entries), 'release'), /invalid_archive/u);
  const corrupt = gunzipSync(tarFixture([{ name: 'release/ripwire' }])); corrupt[0] = 0;
  assert.throws(() => readReleaseArchive(gzipSync(corrupt), 'release'), /invalid_archive/u);
});

test('secret sources never enter the mirror, and secret output is discarded', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const token = 'ghp_' + 'a'.repeat(24);
  await writeFile(path.join(f.root, 'credential.ts'), `export const credential = '${token}';`);
  const runner: typeof f.runner = async request => {
    if (!request.args.includes('--version')) assert.deepEqual(await readdir(request.cwd), ['code.ts']);
    return f.runner(request);
  };
  const input = { cwd: f.root, task: 'greet' };
  const safe = await new SourceContextService().inspect(input, { directory: f.directory, runner });
  assert.ok(safe.reasons.includes('files_excluded'));
  const rejected = await new SourceContextService().inspect(input, { directory: f.directory,
    runner: async request => request.args.includes('--version') ? f.runner(request)
      : { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({ ...packFixture(), notes: [token] })) } });
  assert.deepEqual(rejected.reasons, ['unsafe_output']); assert.ok(!JSON.stringify(rejected).includes(token));
  const query = await new SourceContextService().inspect({ ...input, query: token }, { directory: f.directory, runner });
  assert.deepEqual(query.reasons, ['unsafe_query']);
});

test('response truncation preserves uncertainty and unresolved call targets', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await writeFile(path.join(f.directory, 'config.json'), JSON.stringify({ binaryPath: f.executable, maxOutputBytes: 2048 }));
  const payload = { ...packFixture(), bodies: [{ p: 'code.ts', n: 'greet', l: 1, body: 'x'.repeat(30_000),
    calls_total: 2, calls_capped: true, calls: [{ n: 'unknownTarget', l: 9999 }] }] };
  const result = await new SourceContextService().inspect({ cwd: f.root, task: 'greet' }, { directory: f.directory,
    runner: async request => request.args.includes('--version') ? f.runner(request)
      : { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify(payload)) } });
  assert.equal(result.status, 'degraded'); assert.ok(result.reasons.includes('response_truncated'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
  assert.equal(result.symbols[0]?.body, null); assert.equal(result.symbols[0]?.truncated, true);
  assert.deepEqual(result.symbols[0]?.unresolvedCallees, [{ name: 'unknownTarget', signature: null }]);
  assert.equal(result.completeness.bodiesOmitted, null);
});

test('missing installation, parser failure and timeouts remain small unavailable results', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const input = { cwd: f.root, task: 'greet' };
  for (const [reason, runner] of [
    ['analysis_failed', async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('private diagnostic') })],
    ['timeout', async () => { throw new DOMException('expired', 'TimeoutError'); }],
  ] as const) {
    const result = await new SourceContextService().inspect(input, { directory: f.directory,
      runner: request => request.args.includes('--version') ? f.runner(request) : runner() });
    assert.deepEqual(result.reasons, [reason]); assert.equal(result.status, 'unavailable');
    assert.ok(!JSON.stringify(result).includes('private diagnostic'));
  }
  await rm(f.executable);
  const missing = await new SourceContextService().inspect(input, { directory: f.directory });
  assert.deepEqual(missing.reasons, ['not_installed']);
});

test('concurrent setup is rejected and cancellation removes unpublished state', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  let started!: () => void;
  const downloading = new Promise<void>(resolve => { started = resolve; });
  const controller = new AbortController();
  const first = setupSource(f.directory, { signal: controller.signal, fetcher: (async (_url, options) => {
    started();
    return new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    });
  }) as typeof fetch });
  const rejected = assert.rejects(first, /cancel setup/u);
  await downloading;
  await assert.rejects(setupSource(f.directory), /setup_in_progress/u);
  controller.abort(new Error('cancel setup'));
  await rejected;
  assert.deepEqual(await readdir(f.directory), ['config.json']);
});

test('setup validates before publishing, is repeatable, and retains an existing installation', async t => {
  const f = await sourceFixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const root = 'ripwire-0.4.0-test';
  const archive = tarFixture([{ name: `${root}/ripwire`, bytes: Buffer.from('#!/bin/sh\nexit 0\n') },
    { name: `${root}/LICENSE`, bytes: Buffer.from('license') }, { name: `${root}/skills/evil.sh`, bytes: Buffer.from('unused') }]);
  const release = { root, name: `${root}.tar.gz`, sha256: createHash('sha256').update(archive).digest('hex'), url: 'https://example.invalid/pinned' };
  let downloads = 0;
  const dependencies = { release, fetcher: (async () => { downloads++; return new Response(new Uint8Array(archive)); }) as typeof fetch,
    runner: (async request => ({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(request.args.includes('--version')
      ? 'ripwire 0.4.0' : JSON.stringify({ ranking: [{ n: 'sourceProbe' }] })) })) as typeof f.runner };
  const installed = await setupSource(f.directory, dependencies); assert.equal(installed.reused, false);
  assert.equal((await setupSource(f.directory, dependencies)).reused, true); assert.equal(downloads, 1);
  assert.deepEqual((await readdir(path.join(f.directory, 'ripwire-0.4.0'))).sort(), ['LICENSE', 'release.json', 'ripwire']);
  await assert.rejects(setupSource(path.join(f.base, 'bad'), { ...dependencies, release: { ...release, sha256: '0'.repeat(64) } }), /checksum_mismatch/u);
  assert.equal(await readFile(path.join(f.directory, 'ripwire-0.4.0', 'LICENSE'), 'utf8'), 'license');
});
