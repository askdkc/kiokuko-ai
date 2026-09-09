import { readFile, writeFile, mkdtemp, mkdir, rm, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SourceContextService } from '../dist/source-context/service.js';
import { runSourceProcess } from '../dist/source-context/process.js';

const root = await realpath(path.resolve(import.meta.dirname, '..'));
const binary = process.env.KIOKUKO_TEST_RIPWIRE;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set KIOKUKO_TEST_RIPWIRE to an absolute pinned binary path');
const cases = JSON.parse(await readFile(new URL('../tests/fixtures/source-context-evaluation.json', import.meta.url), 'utf8'));
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-source-reuse-')));
const rows = [];
const median = values => { const s = [...values].sort((a,b) => a-b); return (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2; };

async function measure(service, input, directory, phase) {
  const processes = [];
  const start = performance.now();
  const result = await service.inspect(input, { directory, runner: async request => {
    const started = performance.now();
    const output = await runSourceProcess(request);
    processes.push({ kind: request.args.includes('--version') ? 'version' : 'analysis',
      ms: performance.now() - started, stdoutBytes: output.stdout.length, stderrBytes: output.stderr.length });
    return output;
  } });
  const ms = performance.now() - start;
  if (result.status === 'unavailable') throw new Error(`Investigation unavailable: ${result.reasons.join(',')}`);
  return { phase, ms, reused: result.reused, status: result.status, sourceDigest: result.sourceDigest,
    inputDigest: result.inputDigest, resultDigest: result.resultDigest, returnedBytes: Buffer.byteLength(JSON.stringify(result)),
    versionMs: processes.filter(p=>p.kind === 'version').reduce((a,p)=>a+p.ms,0),
    analysisMs: processes.filter(p=>p.kind === 'analysis').reduce((a,p)=>a+p.ms,0),
    otherMs: ms - processes.reduce((a,p)=>a+p.ms,0), analysisStarts: processes.filter(p=>p.kind === 'analysis').length,
    freshStdoutBytes: processes.reduce((a,p)=>a+p.stdoutBytes,0) };
}

try {
  for (let round = 0; round < 3; round++) {
    for (const c of round % 2 ? [...cases].reverse() : cases) {
      const directory = path.join(base, `${round}-${c.id}`);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(path.join(directory, 'config.json'), JSON.stringify({ binaryPath: binary }));
      const service = new SourceContextService(), input = { cwd: root, task: c.task };
      const ideal = await measure(service, input, directory, 'ideal_cold');
      const zenki = await measure(service, input, directory, 'zenki_parent_reuse');
      // Recreate only the parent, preserving the index blobs. A blob's presence is not proof of a hit.
      const restarted = await measure(new SourceContextService(), input, directory, 'parent_restart');
      if (!zenki.reused || zenki.analysisStarts !== 0 || ideal.resultDigest !== zenki.resultDigest
        || ideal.sourceDigest !== restarted.sourceDigest) throw new Error('Source identity/reuse invariant failed');
      const blobs = [];
      for (const name of await readdir(path.join(directory, 'cache'))) {
        if (name.endsWith('.ripwirecache')) blobs.push((await stat(path.join(directory, 'cache', name))).size);
      }
      rows.push({ id: c.id, round, ideal, zenki, restarted, indexBlobBytes: blobs.reduce((a,b)=>a+b,0) });
    }
    console.error(`Completed parent reuse round ${round + 1}/3`);
  }
  const phases = Object.fromEntries(['ideal','zenki','restarted'].map(phase => [phase,
    Object.fromEntries(['ms','versionMs','analysisMs','otherMs','analysisStarts'].map(k=>[k,median(rows.map(r=>r[phase][k]))]))]));
  const report = { version: 1, evaluatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
    repositoryCommit: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    ripwire: '0.4.0', cases: cases.length, repeats: 3, phases,
    pairMs: median(rows.map(r=>r.ideal.ms+r.zenki.ms)), withoutParentReusePairMs: median(rows.map(r=>r.ideal.ms+r.restarted.ms)),
    reusedAll: rows.every(r=>r.zenki.reused), rows,
    limitations: ['No LLM calls or plan quality measurement', 'Cache files observed; upstream index hits not instrumented',
      'Other time includes Git, snapshot reads, hashing, copy, projection and cleanup; those stages are not separately timed',
      'Three repetitions on one host; OS caches not flushed; source service called directly, not full OpenCode dispatch'] };
  if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({ phases, pairMs: report.pairMs, withoutParentReusePairMs: report.withoutParentReusePairMs, reusedAll: report.reusedAll }));
} finally { await rm(base,{recursive:true,force:true}); }
