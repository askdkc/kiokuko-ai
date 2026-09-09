import { readFile, writeFile, mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { getEncoding } from 'js-tiktoken';
import { SourceContextService } from '../dist/source-context/service.js';

// Frozen deterministic file-localization comparison, not a claim about agent task completion.
// Both arms use the same literal terms and first eight sorted matches. Gold is scoring-only.
const root = await realpath(path.resolve(import.meta.dirname, '..'));
const binary = process.env.KIOKUKO_TEST_RIPWIRE;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set KIOKUKO_TEST_RIPWIRE to the pinned absolute binary path');
const cases = JSON.parse(await readFile(new URL('../tests/fixtures/source-context-evaluation.json', import.meta.url), 'utf8'));
const tokenizer = getEncoding('cl100k_base');
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-source-evaluation-')));
const rows = [];
const median = values => { const s = [...values].sort((a,b) => a-b); return (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2; };
const count = value => ({ bytes: Buffer.byteLength(value), tokens: tokenizer.encode(value).length });
async function search(c) {
  let output;
  try { output = execFileSync('rg', ['-l', '-F', ...c.terms.flatMap(t => ['-e', t]), '-g', '*.ts', '-g', '*.mts', 'src', 'tests'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 }); }
  catch (e) { if (e.status === 1) output = ''; else throw e; }
  const files = output.trim().split('\n').filter(Boolean).sort().slice(0, 8);
  return { output, files };
}
function recall(c, contents) {
  return c.gold.filter(g => contents.some(x => x.path === g.path && x.text.includes(g.symbol))).length / c.gold.length;
}
try {
  for (const c of cases) {
    for (const g of c.gold) if (!(await readFile(path.join(root, g.path), 'utf8')).includes(g.symbol)) throw new Error(`Stale gold: ${c.id}`);
    const directory = path.join(base, c.id); await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, 'config.json'), JSON.stringify({ binaryPath: binary }));
    for (const temperature of ['cold', 'warm']) {
      const start = performance.now();
      const found = await search(c);
      const baseline = await Promise.all(found.files.map(async p => ({ path: p, text: await readFile(path.join(root, p), 'utf8') })));
      const baselineMs = performance.now() - start;
      const baselineText = found.output + baseline.map(x => `${x.path}\n${x.text}`).join('\n');
      // A fresh parent service keeps warm measurement honest: only persistent index caches are warm.
      const sourceStart = performance.now();
      const source = await new SourceContextService().inspect({ cwd: root, task: c.task }, { directory });
      const supplementalSearch = await search(c);
      const contents = [...source.symbols, ...source.related].map(s => ({ path: s.path, text: [s.name, s.signature, s.body].filter(Boolean).join('\n') }));
      const extra = [];
      for (const p of supplementalSearch.files) {
        // A file is covered only if a returned definition/signature names a search term.
        if (!contents.some(x => x.path === p && c.terms.some(term => x.text.includes(term))))
          extra.push({ path: p, text: await readFile(path.join(root, p), 'utf8') });
      }
      const sourceMs = performance.now() - sourceStart;
      const sourceText = JSON.stringify(source) + supplementalSearch.output + extra.map(x => `${x.path}\n${x.text}`).join('\n');
      rows.push({ id: c.id, language: c.language, temperature,
        baseline: { ...count(baselineText), ms: baselineMs, recall: recall(c, baseline) },
        source: { ...count(sourceText), ms: sourceMs, recall: recall(c, [...contents, ...extra]), status: source.status,
          sourceDigest: source.sourceDigest, inputDigest: source.inputDigest, resultDigest: source.resultDigest,
          reasons: source.reasons, additionalFiles: extra.length, receivedBytes: source.receivedBytes } });
    }
  }
  const warm = rows.filter(r => r.temperature === 'warm');
  const medianTokenRatio = median(rows.map(r => r.source.tokens)) / median(rows.map(r => r.baseline.tokens));
  const criteria = {
    recallMaintained: rows.every(r => r.source.recall >= r.baseline.recall),
    tokenReduction30Percent: medianTokenRatio <= 0.7,
    warmLatencyNotIncreased: median(warm.map(r => r.source.ms)) <= median(warm.map(r => r.baseline.ms)),
    noFalseVerification: rows.every(r => r.source.status !== 'ready'),
    investigationAvailable: rows.every(r => r.source.status !== 'unavailable'),
  };
  const report = { version: 1, ripwire: '0.4.0', tokenizer: 'js-tiktoken@1.0.21/cl100k_base',
    repositoryCommit: execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    trackedChanges: execFileSync('git', ['diff','--stat'], { cwd: root, encoding: 'utf8' }).trim(),
    evaluatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, criteria,
    accepted: Object.values(criteria).every(Boolean),
    medianTokenRatio, medianPairedTokenRatio: median(rows.map(r => r.source.tokens / r.baseline.tokens)),
    baselineWarmMs: median(warm.map(r => r.baseline.ms)), sourceWarmMs: median(warm.map(r => r.source.ms)), rows,
    limitations: ['Deterministic localization, not agent task completion', '12 task prompts in 6 paired subsystems; small sample',
      'Baseline runs first in each pair; OS filesystem cache is not flushed', 'All mirror creation, snapshots and supplemental reads counted; tokenization excluded from both timings'] };
  const output = process.argv[2];
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ accepted: report.accepted, criteria, medianTokenRatio: report.medianTokenRatio,
    baselineWarmMs: report.baselineWarmMs, sourceWarmMs: report.sourceWarmMs }));
  // Evaluation failure is a release decision, not an infrastructure crash; retain the report.
} finally { await rm(base, { recursive: true, force: true }); }
