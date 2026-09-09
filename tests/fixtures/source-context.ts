import { mkdtemp, writeFile, realpath, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import type { SourceRunner } from '../../src/source-context/process.js';

export function packFixture() {
  return { task: 'greet', route: 'fixture', root: '.', budget_tokens: 4000, budget_bytes: 8496, budget_ceiling_bytes: 9440,
    ranking_capped: false, ranking: [{ p: 'code.ts', n: 'greet', l: 1, r: 1, sig: 'function greet()' }],
    far_total: 0, far_kept: 0, far_of_top: 0, far: [], bodies_total: 1, bodies_kept: 1,
    bodies: [{ p: 'code.ts', n: 'greet', l: 1, body: 'function greet() { return 1; }', truncated: false }],
    callers_total: 0, callers_kept: 0, callers_of_top: 1, callers: [], notes_total: 0, notes_kept: 0, notes: [],
    tests_total: 0, tests_kept: 0, tests_to_run: [] };
}
export async function sourceFixture(binary?: string) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-source-test-')));
  const root = path.join(base, 'repo'), directory = path.join(base, 'data');
  await mkdir(root); await mkdir(directory, { mode: 0o700 });
  execFileSync('/usr/bin/git', ['init', '-q', root]);
  const executable = binary ?? path.join(base, 'ripwire');
  if (!binary) { await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700); }
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ binaryPath: executable }));
  await writeFile(path.join(root, 'code.ts'), 'export function greet() { return 1; }\n');
  const runner: SourceRunner = async request => ({ code: 0, stderr: Buffer.alloc(0),
    stdout: Buffer.from(request.args.includes('--version') ? 'ripwire 0.4.0 (fixture)' : JSON.stringify(packFixture())) });
  return { base, root, directory, runner, executable };
}
export function tarFixture(entries: Array<{ name: string; bytes?: Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? Buffer.alloc(0), h = Buffer.alloc(512);
    h.write(entry.name, 0, 100); h.write('0000700\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
    h.fill(32, 148, 156); h.write(entry.type ?? '0', 156); h.write('ustar\0', 257);
    const sum = h.reduce((a,b) => a+b, 0); h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
