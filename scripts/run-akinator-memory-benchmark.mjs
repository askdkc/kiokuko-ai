import { execFileSync } from 'node:child_process';
import { prepareOpenCodeTask } from '../dist/akinator/opencode-task.js';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { recordEntry, readEntry } from '../dist/memory/entries.js';
import { isRetrievableEntry } from '../dist/memory/hybrid-retrieval.js';
import { taggedEntries } from '../dist/akinator/service.js';
import { captureProfileProbeContext, probeProfileMemory } from '../dist/akinator/memory-probe.js';
import { profileFixture } from './akinator-memory-fixture.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' }, 'prepare-samples': { type: 'string', default: '1' }, entries: { type: 'string', default: '1000' }, profiles: { type: 'string', default: '100' }, samples: { type: 'string', default: '10' } } });
const counts = Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'output').map(([key, value]) => [key, Number(value)]));
for (const [key, value] of Object.entries(counts)) if (!Number.isSafeInteger(value) || value < 1 || value > (key.endsWith('samples') ? 100 : 100000)) throw new Error(`Invalid --${key}`);
const fixture = profileFixture();
const originalMode = process.env.KIOKUKO_AKINATOR_MEMORY_MODE;
const latency = monitorEventLoopDelay({ resolution: 10 });
try {
  const { database, project } = fixture;
  execFileSync('git', ['init', '-q', project.repositoryRoot]);
  process.stderr.write(`Preparing ${counts.entries} entries and ${counts.profiles} profiles\n`);
  for (let i = 0; i < counts.entries; i++) recordEntry(database, { workspace: project.workspace, kind: 'fact', title: `entry ${i}`, body: 'fixture body', tags: [i < 20 ? 'bot:builder' : 'unrelated'] });
  for (let i = 0; i < counts.profiles; i++) fixture.source();
  const samples = {};
  let queries = 0; let entryReads = 0; let profileReads = 0; let lockStart; let locks = [];
  const observed = { filePath: database.filePath, close() {}, exec(sql) {
    database.exec(sql);
    if (/^BEGIN IMMEDIATE/i.test(sql)) lockStart = performance.now();
    if (/^(COMMIT|ROLLBACK)/i.test(sql) && lockStart !== undefined) { locks.push(performance.now() - lockStart); lockStart = undefined; }
  }, prepare(sql) {
    const statement = database.prepare(sql);
    return Object.fromEntries(['all', 'get', 'run'].map(method => [method, (...parameters) => { queries++; const result = statement[method](...parameters); if (/FROM entries (?:AS )?e\b/.test(sql) && /r\.body\b/.test(sql)) entryReads += method === 'all' ? result.length : result === undefined ? 0 : 1; if (/FROM akinator_sessions\b/.test(sql)) profileReads++; return result; }]));
  } };
  const legacy = () => observed.prepare('SELECT id FROM entries WHERE workspace = ? ORDER BY updated_at DESC, id ASC').all(project.workspace)
    .map(row => readEntry(observed, { workspace: project.workspace, entryId: row.id }))
    .filter(entry => isRetrievableEntry(observed, entry) && entry.status !== 'superseded' && entry.tags.includes('bot:builder')).slice(0, 12);
  const context = captureProfileProbeContext(project, 'Implement src/alpha.ts', 'suggest');
  const cpuStart = process.cpuUsage();
  latency.enable();
  await new Promise(resolve => setTimeout(resolve, 20));
  let request = 0;
  const actions = { legacyTagScan: legacy, indexedTagScan: () => taggedEntries(observed, project.workspace, ['bot:builder']),
    profileProbe: () => probeProfileMemory(observed, context, 'Implement src/alpha.ts', { taskType: 'build', target: null, expected: null, constraints: null }),
    ...Object.fromEntries(['off', 'shadow', 'suggest', 'resolve'].map(mode => [`prepare_${mode}`, async () => {
      process.env.KIOKUKO_AKINATOR_MEMORY_MODE = mode;
      return prepareOpenCodeTask(observed, { requestId: `benchmark-${++request}`, task: 'Implement src/alpha.ts', cwd: project.repositoryRoot,
        profileHints: { taskType: 'build', target: null, expected: null, constraints: null },
        capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }], skillDiscoveryMode: 'off' });
    }])) };
  for (const [name, action] of Object.entries(actions)) {
    const sampleCount = name.startsWith('prepare_') ? counts['prepare-samples'] : counts.samples;
    process.stderr.write(`Measuring ${name} (${sampleCount} samples)\n`);
    const times = []; const sql = []; const bodyReads = []; const canonicalReads = []; const lockSamples = []; let last;
    for (let i = 0; i < sampleCount; i++) {
      queries = 0; entryReads = 0; profileReads = 0; locks = [];
      const start = performance.now(); last = await action(); times.push(performance.now() - start); sql.push(queries);
      bodyReads.push(entryReads); canonicalReads.push(profileReads); lockSamples.push({ totalMs: locks.reduce((sum, ms) => sum + ms, 0), maxMs: Math.max(0, ...locks), transactions: locks.length });
      await new Promise(resolve => setImmediate(resolve));
    }
    const sorted = [...times].sort((a, b) => a - b);
    samples[name] = { sampleCount, firstMs: times[0], medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)], sqlExecutions: sql, entryBodyReads: bodyReads, canonicalProfileReads: canonicalReads, writeLocks: lockSamples,
      ...(name === 'profileProbe' ? { expandedProfiles: last.resolution.scannedCandidates, truncated: last.resolution.truncated } : {}) };
  }
  latency.disable();
  const report = { node: process.version, sqlite: database.prepare('SELECT sqlite_version() AS version').get().version,
    seed: 'fixed sequential fixture v1', counts, samples, cpu: process.cpuUsage(cpuStart), rss: process.memoryUsage().rss,
    eventLoopDelayMaxMs: latency.max / 1e6, scope: 'disposable in-memory DB; full prepare excludes background semantic/external discovery; wall time is not task-token savings; legacy reproduces the prior tag algorithm; write-lock timings start after successful BEGIN IMMEDIATE' };
  if (values.output !== undefined) writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
} finally {
  if (originalMode === undefined) delete process.env.KIOKUKO_AKINATOR_MEMORY_MODE;
  else process.env.KIOKUKO_AKINATOR_MEMORY_MODE = originalMode;
  latency.disable(); fixture.close();
}
