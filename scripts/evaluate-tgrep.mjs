// Local-only trial. No downloads, package installation, or source uploads.
// Usage: node scripts/evaluate-tgrep.mjs /absolute/path/to/tgrep [output.json]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) throw new Error('Supply an absolute tgrep binary path');
const repository = process.cwd();
const repetitions = 10;
const queries = [
  { id: 'routing', pattern: 'readExecutionRouting|createExecutionHooks' },
  { id: 'deadline', pattern: 'runWithMcpDeadline', fixed: true },
  { id: 'advisory', pattern: 'submitEnnoAdvice|advisoryInputDigest' },
  { id: 'repository-state', pattern: 'captureRepositoryState', fixed: true },
  { id: 'lease', pattern: 'claimEnnoWork', fixed: true },
  { id: 'managed-files', pattern: 'withManagedFileLock', fixed: true },
  { id: 'cancellation', pattern: 'AbortController|AbortSignal' },
  { id: 'dispatch-digest', pattern: 'dispatch.*[Dd]igest' },
  { id: 'case-insensitive', pattern: 'workunit', insensitive: true, fixed: true },
  { id: 'japanese-literal', pattern: '二重実行', fixed: true },
  { id: 'short-literal', pattern: 'db', fixed: true },
  { id: 'absent-literal', pattern: 'TgrepTrialAbsentSymbol7ce183', fixed: true },
];
const env = { ...process.env };
delete env.RIPGREP_CONFIG_PATH;
const start = () => performance.now();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(command, args, cwd = repository) {
  const before = start();
  const result = spawnSync(command, args, { cwd, env, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error(`${command}: ${result.error || result.stderr || result.status}`);
  return { ms: start() - before, stdout: result.stdout, bytes: Buffer.byteLength(result.stdout), code: result.status };
}
const hash = value => createHash('sha256').update(value).digest('hex');
const distribution = values => {
  const s = [...values].sort((a, b) => a - b);
  return { medianMs: (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2, p95Ms: s[Math.ceil(s.length * 0.95) - 1] };
};
const canonical = rows => JSON.stringify(rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')));
function cliRows(output) {
  return canonical(output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => ['match', 'context'].includes(row.type)).map(({ type, data }) => {
      if (typeof data.path.text !== 'string' || typeof data.lines.text !== 'string') throw new Error('Non-UTF8 output is outside this trial');
      return [type, data.path.text.replace(/^\.\//, ''), data.line_number, data.lines.text.replace(/\r?\n$/, '')];
    }));
}
function rpcRows(result) {
  if (!Array.isArray(result.matches)) throw new Error('Invalid RPC matches');
  return canonical(result.matches.map(row => {
    if (!['match', 'context'].includes(row.type) || typeof row.file !== 'string' || typeof row.content !== 'string' || !Number.isInteger(row.line)) throw new Error('Unexpected RPC row');
    return [row.type, row.file.replace(/^\.\//, ''), row.line, row.content.replace(/\r?\n$/, '')];
  }));
}
async function connect(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  let buffer = '', pending, sequence = 0;
  const fail = error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; } };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('RPC socket closed')));
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { fail(new Error('RPC output limit')); socket.destroy(); return; }
    const at = buffer.indexOf('\n');
    if (at < 0 || !pending) return;
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    const current = pending; pending = undefined; clearTimeout(current.timer);
    try {
      const response = JSON.parse(line);
      if (response.id !== current.id || response.error || !response.result) throw new Error(JSON.stringify(response.error || 'Invalid RPC response'));
      current.resolve({ result: response.result, bytes: Buffer.byteLength(line) + 1, ms: start() - current.before });
    } catch (error) { current.reject(error); }
  });
  return {
    socket,
    request(method, params = {}) {
      if (pending) throw new Error('Concurrent RPC requests are unsupported in this trial');
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, resolve, reject, before: start(), timer: setTimeout(() => { fail(new Error('RPC deadline')); socket.destroy(); }, 10000) };
        socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
  };
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kiokuko-tgrep-trial-'));
const root = path.join(temporary, 'repository'), index = path.join(temporary, 'index');
let server, rpc, serverDone;
async function stopServer() {
  rpc?.socket.destroy(); rpc = undefined;
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 2000);
  try { await serverDone; } finally { clearTimeout(timer); }
}
const interrupted = () => { void stopServer().finally(() => process.exit(130)); };
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
try {
  const version = run(binary, ['--version']).stdout.trim();
  if (version !== 'tgrep 1.0.5') throw new Error(`This trial targets tgrep 1.0.5; got ${version}`);
  const beforeCopy = start();
  await fs.mkdir(root);
  const tracked = run('git', ['ls-files', '-z', '--', 'src', 'tests', '.gitignore', '.ignore']).stdout.split('\0').filter(Boolean);
  const corpus = [], digest = createHash('sha256');
  for (const relative of tracked) {
    const source = path.join(repository, relative), destination = path.join(root, relative);
    const stat = await fs.lstat(source);
    if (!stat.isFile()) throw new Error(`Non-regular tracked file: ${relative}`);
    const bytes = await fs.readFile(source);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
    corpus.push({ path: relative, bytes: bytes.length }); digest.update(relative + '\0').update(hash(bytes) + '\0');
  }
  run('git', ['init', '-q'], root); run('git', ['add', '-f', '.'], root);
  const preparationMs = start() - beforeCopy;
  const probe = path.join(root, 'src/tgrep-trial-probe.ts');
  await fs.writeFile(probe, 'export const TgrepTrialOriginalToken = 1;\n');
  const build = run(binary, ['index', '--index-path', index, '--max-filesize', '2M', root]);
  const beforeServe = start();
  let serverLog = '';
  server = spawn(binary, ['serve', '--index-path', index, '--max-filesize', '2M', root], { cwd: root, env, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
  serverDone = once(server, 'close');
  server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-16384); });
  let info;
  while (start() - beforeServe < 10000) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { info = JSON.parse(await fs.readFile(path.join(index, 'serve.json'), 'utf8')); break; } catch { await delay(20); }
  }
  if (!info || info.pid !== server.pid) throw new Error(`Owned server did not become ready: ${serverLog}`);
  rpc = await connect(info.port);
  let status;
  do {
    status = (await rpc.request('status')).result;
    if (!status.indexing && !status.reconcile_running && status.last_reconcile_at && status.watch_mode_active === 'native') break;
    if (start() - beforeServe > 10000) throw new Error(`Native watcher / initial reconciliation not ready: ${JSON.stringify(status)}`);
    await delay(20);
  } while (true);
  const startupMs = start() - beforeServe;
  const cli = (engine, query, noIndex = false) => run(engine.startsWith('rg') ? 'rg' : binary, [
    ...(engine.startsWith('rg') ? (engine === 'rgSingleThread' ? ['--threads', '1'] : []) : ['--index-path', index, ...(noIndex ? ['--no-index'] : [])]),
    '--json', '--max-filesize', '2M', '-C', '2', ...(query.fixed ? ['-F'] : []), ...(query.insensitive ? ['-i'] : []), '--', query.pattern, '.',
  ], root);
  const search = query => rpc.request('search', { pattern: query.pattern, fixed_string: !!query.fixed, case_insensitive: !!query.insensitive, before_context: 2, after_context: 2, max_filesize: 2 * 1024 * 1024, detail: true, positions: true, binary_lines: true });
  const results = [];
  for (const query of queries) {
    const firstRg = cli('rg', query), firstTgrep = cli('tgrep', query);
    const expected = cliRows(firstRg.stdout);
    if (query.id !== 'absent-literal' && expected === '[]') throw new Error(`Expected a positive reference query: ${query.id}`);
    const samples = { rg: [], rgSingleThread: [], tgrepCli: [], tgrepRpc: [] }, bytes = { rg: [], rgSingleThread: [], tgrepCli: [], tgrepRpc: [] };
    let allEqual = expected === cliRows(firstTgrep.stdout);
    for (let iteration = 0; iteration < repetitions; iteration++) {
      // Rotate order to avoid always granting one engine the hottest filesystem cache.
      const order = ['rg', 'rgSingleThread', 'tgrepCli', 'tgrepRpc'];
      for (const engine of [...order.slice(iteration % order.length), ...order.slice(0, iteration % order.length)]) {
        const result = engine === 'tgrepRpc' ? await search(query) : cli(engine, query);
        const normalized = engine === 'tgrepRpc' ? rpcRows(result.result) : cliRows(result.stdout);
        allEqual &&= normalized === expected;
        samples[engine].push(result.ms); bytes[engine].push(result.bytes);
      }
    }
    const record = { ...query, allEqual, rows: JSON.parse(expected).length, normalizedBytes: Buffer.byteLength(expected), normalizedDigest: hash(expected), firstQueryMs: { rg: firstRg.ms, tgrepCli: firstTgrep.ms }, stats: Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, distribution(value)])), samples, bytes };
    results.push(record);
    console.error(`${query.id}: equal=${allEqual}, rg=${record.stats.rg.medianMs.toFixed(2)}ms rg-1=${record.stats.rgSingleThread.medianMs.toFixed(2)}ms cli=${record.stats.tgrepCli.medianMs.toFixed(2)}ms rpc=${record.stats.tgrepRpc.medianMs.toFixed(2)}ms`);
  }
  const filesOnly = [];
  for (const query of queries) {
    const samples = { rg: [], rgSingleThread: [], tgrepCli: [] };
    let expected, allEqual = true, outputBytes;
    for (let iteration = 0; iteration < repetitions; iteration++) {
      const order = ['rg', 'rgSingleThread', 'tgrepCli'];
      for (const engine of [...order.slice(iteration % 3), ...order.slice(0, iteration % 3)]) {
        const result = run(engine.startsWith('rg') ? 'rg' : binary, [
          ...(engine.startsWith('rg') ? (engine === 'rgSingleThread' ? ['--threads', '1'] : []) : ['--index-path', index]),
          '-l', '--null', '--max-filesize', '2M', ...(query.fixed ? ['-F'] : []), ...(query.insensitive ? ['-i'] : []), '--', query.pattern, '.',
        ], root);
        const normalized = JSON.stringify(result.stdout.split('\0').filter(Boolean).map(file => file.replace(/^\.\//, '')).sort());
        expected ??= normalized;
        allEqual &&= normalized === expected;
        outputBytes = Buffer.byteLength(normalized);
        samples[engine].push(result.ms);
      }
    }
    filesOnly.push({ id: query.id, allEqual, normalizedBytes: outputBytes, samples, stats: Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, distribution(value)])) });
  }
  const freshness = [];
  async function mutation(id, mutate, pattern) {
    const before = start(); await mutate();
    const query = { pattern, fixed: true };
    const immediate = await search(query);
    const expected = cliRows(cli('rg', query).stdout);
    const immediateEqual = rpcRows(immediate.result) === expected;
    const fullScan = cli('tgrep', query, true);
    let current = immediate, polls = 0;
    while (rpcRows(current.result) !== expected && start() - before < 10000) { await delay(20); current = await search(query); polls++; }
    freshness.push({ id, immediateEqual, eventualEqual: rpcRows(current.result) === expected, observedConvergenceMs: start() - before, polls, fullScanEqual: cliRows(fullScan.stdout) === expected });
  }
  await mutation('same-size-edit', () => fs.writeFile(probe, 'export const TgrepTrialModifiedToken = 1;\n'), 'TgrepTrialModifiedToken');
  const added = path.join(root, 'src/tgrep-trial-new.ts'), renamed = path.join(root, 'src/tgrep-trial-renamed.ts');
  await mutation('untracked-create', () => fs.writeFile(added, 'export const TgrepTrialNewFileToken = 1;\n'), 'TgrepTrialNewFileToken');
  await mutation('rename', () => fs.rename(added, renamed), 'TgrepTrialNewFileToken');
  await mutation('delete', () => fs.unlink(renamed), 'TgrepTrialNewFileToken');
  await mutation('ignored-file', async () => { await fs.mkdir(path.join(root, 'node_modules')); await fs.writeFile(path.join(root, 'node_modules/ignored.ts'), 'TgrepTrialIgnoredToken\n'); }, 'TgrepTrialIgnoredToken');
  const outside = path.join(temporary, 'outside.ts');
  await fs.writeFile(outside, 'TgrepTrialExternalToken\n');
  await mutation('external-symlink', () => fs.symlink(outside, path.join(root, 'src/tgrep-trial-link.ts')), 'TgrepTrialExternalToken');
  // Give ignored/symlink watcher events time to arrive, then check again.
  await delay(500);
  for (const pattern of ['TgrepTrialIgnoredToken', 'TgrepTrialExternalToken']) {
    if (rpcRows((await search({ pattern, fixed: true })).result) !== '[]') throw new Error(`Excluded file appeared: ${pattern}`);
  }
  const finalStatus = (await rpc.request('status')).result;
  const serverResources = run('ps', ['-o', 'rss=', '-p', String(server.pid)]).stdout.trim();
  await stopServer();
  await fs.writeFile(probe, 'export const TgrepTrialOfflineToken = 1;\n');
  const offlineQuery = { pattern: 'TgrepTrialOfflineToken', fixed: true };
  const offlineExpected = cliRows(cli('rg', offlineQuery).stdout);
  const offline = { indexedEqual: cliRows(cli('tgrep', offlineQuery).stdout) === offlineExpected, fullScanEqual: cliRows(cli('tgrep', offlineQuery, true).stdout) === offlineExpected };
  async function treeBytes(directory) {
    let size = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) size += await treeBytes(name); else if (entry.isFile()) size += (await fs.stat(name)).size;
    }
    return size;
  }
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(), commit: run('git', ['rev-parse', 'HEAD']).stdout.trim(), platform: `${os.platform()}-${os.arch()}`, tgrep: version, rg: run('rg', ['--version']).stdout.split('\n')[0], repetitions, corpus: { trackedFiles: corpus.length, bytes: corpus.reduce((sum, file) => sum + file.bytes, 0), digest: digest.digest('hex'), preparationMs, scope: 'Current tracked src/, tests/, root ignore files; one additional synthetic probe; no node_modules or prior untracked ripwire artifacts' }, initialIndexMs: build.ms, serverReadyAndReconciledMs: startupMs, indexBytes: await treeBytes(index), serverRssKiB: Number(serverResources), initialStatus: status, finalStatus, results, filesOnly, freshness, offline, summary: Object.fromEntries(['rg', 'rgSingleThread', 'tgrepCli', 'tgrepRpc'].map(engine => [engine, distribution(results.map(result => result.stats[engine].medianMs))])), filesOnlySummary: Object.fromEntries(['rg', 'rgSingleThread', 'tgrepCli'].map(engine => [engine, distribution(filesOnly.map(result => result.stats[engine].medianMs))])), limitations: ['Single macOS arm64 machine; warm OS caches, new tgrep index rather than cold OS cache.', '12 lexical queries, not 12 natural-language/LLM tasks; no LLM calls, token usage or plan quality measurement.', 'RPC timing includes transport and JSON parsing; CLI timing includes process start and output transfer but excludes evaluator JSON parsing.', 'Equality covers path, line, match/context kind and text; excludes submatch offsets, binary/invalid UTF8 and complete CLI compatibility.', 'Freshness is sampled; immediate mismatch proves a stale window, eventual time includes verification overhead.', 'Ignored files and symlinks checked twice, not a security proof for arbitrary trees.', 'RSS is one sample, not peak memory.'] };
  if (process.argv[3]) await fs.writeFile(path.resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ summary: report.summary, filesOnlySummary: report.filesOnlySummary, initialIndexMs: build.ms, startupMs, indexBytes: report.indexBytes, serverRssKiB: report.serverRssKiB, allEqual: [...results, ...filesOnly].every(result => result.allEqual), freshness, offline }, null, 2));
  if (![...results, ...filesOnly].every(result => result.allEqual) || freshness.some(result => !result.eventualEqual || !result.fullScanEqual) || !offline.fullScanEqual) process.exitCode = 1;
} finally {
  await stopServer();
  await fs.rm(temporary, { recursive: true, force: true });
}
