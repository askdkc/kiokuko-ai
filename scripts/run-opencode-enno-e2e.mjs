import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kiokuko = path.join(repositoryRoot, 'dist', 'bin', 'kiokuko.js');
const client = 'opencode';
const maxOutput = 64 * 1024;
const timeoutMs = 5 * 60 * 1000;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function execute(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const append = (current, chunk) => current.byteLength >= maxOutput
      ? current
      : Buffer.concat([current, Buffer.from(chunk).subarray(0, maxOutput - current.byteLength)]);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeoutMs ?? timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, stdout, stderr, spawnCode: error?.code ?? 'spawn_failed' });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr, spawnCode: null });
    });
  });
}

async function requireSuccess(command, args, options) {
  const result = await execute(command, args, options);
  if (result.code !== 0) throw new Error(`fixture command failed: ${path.basename(command)} (${result.spawnCode ?? result.code ?? result.signal ?? 'unknown'})`);
}

async function runOpenCode() {
  if (process.argv.length > 2) return { client, status: 'failed', reason: 'unexpected_argument' };
  if (process.env.RUN_OPENCODE_E2E !== '1') return { client, status: 'not-run', reason: 'RUN_OPENCODE_E2E=1 is not set' };

  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-enno-${client}-e2e-`));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  const config = path.join(root, 'config');
  await Promise.all([mkdir(home), mkdir(project), mkdir(data), mkdir(config)]);
  await writeFile(path.join(project, 'add.js'), 'export function add(a, b) { return a - b; }\n');
  await writeFile(path.join(project, 'add.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './add.js'; test('adds', () => assert.equal(add(2, 3), 5));\n");
  await writeFile(path.join(project, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
  await requireSuccess('git', ['init', '-q'], { cwd: project, timeoutMs: 10_000 });
  await requireSuccess('git', ['add', '.'], { cwd: project, timeoutMs: 10_000 });
  await requireSuccess('git', ['-c', 'user.name=Kiokuko E2E', '-c', 'user.email=kiokuko-e2e@example.invalid', 'commit', '-qm', 'fixture'], { cwd: project, timeoutMs: 10_000 });

  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    KIOKUKO_DATABASE: databasePath,
  };
  const command = process.env.OPENCODE_E2E_COMMAND || 'opencode';
  await requireSuccess(kiokuko, ['setup', '--enno-oduno', 'on', '--skill-discovery', 'off', '--json'], {
    cwd: project, env: environment, timeoutMs: 60_000,
  });
  await requireSuccess(kiokuko, ['use', '--root', project, '--json'], { cwd: project, env: environment, timeoutMs: 60_000 });

  const task = 'Use Kiokuko Enno-Oduno. Fix the incorrect add function, keep the public API, and make node --test pass. Use at most three repair loops.';
  const result = await execute(command, ['run', task], { cwd: project, env: environment, timeoutMs });
  if (result.code !== 0) {
    return {
      client, status: 'failed', reason: result.timedOut ? 'timeout' : result.spawnCode ?? 'client_failed',
      exitCode: result.code, stdoutDigest: digest(result.stdout), stderrDigest: digest(result.stderr),
    };
  }

  const { openConnection } = await import('../dist/db/connection.js');
  const database = openConnection(databasePath, { readOnly: true });
  try {
    const run = database.prepare(`
      SELECT ec.run_id AS runId, ec.status, ec.contract_json AS contractJson
      FROM enno_contracts AS ec JOIN ledger_runs AS lr ON lr.run_id = ec.run_id
      WHERE lr.client_kind = ? ORDER BY ec.created_at DESC LIMIT 1
    `).get(client);
    if (run?.status !== 'completed') return { client, status: 'failed', reason: 'enno_run_not_completed' };
    const events = database.prepare(`
      SELECT event_type AS eventType FROM ledger_events WHERE run_id = ?
      AND (event_type LIKE 'enno.%' OR event_type LIKE 'zenki.%' OR event_type LIKE 'goki.%')
      ORDER BY sequence
    `).all(run.runId).map((row) => row.eventType);
    const required = ['enno.started', 'zenki.plan_created', 'enno.plan_confirmed', 'goki.work_started', 'goki.work_completed', 'enno.verification_started', 'enno.verification_passed', 'enno.completed'];
    let cursor = 0;
    for (const event of events) if (event === required[cursor]) cursor += 1;
    if (cursor !== required.length) return { client, status: 'failed', reason: 'ledger_role_sequence_incomplete', events };
    const loops = events.filter((event) => event === 'goki.work_started').length;
    if (loops > 3) return { client, status: 'failed', reason: 'loop_limit_exceeded', loops };
    const contract = JSON.parse(run.contractJson);
    const skillSnapshotPresent = Array.isArray(contract?.skillSet?.entries) && contract.skillSet.entries.length > 0;
    const workCompleted = database.prepare("SELECT COUNT(*) AS count FROM enno_work_units WHERE run_id = ? AND status = 'completed'").get(run.runId)?.count > 0;
    const freshEvidence = database.prepare("SELECT COUNT(*) AS count FROM enno_verifier_runs WHERE run_id = ? AND status = 'passed'").get(run.runId)?.count > 0;
    if (!skillSnapshotPresent || !workCompleted || !freshEvidence) {
      return { client, status: 'failed', reason: 'required_run_evidence_missing' };
    }
    return { client, status: 'passed', loops };
  } finally {
    database.close();
  }
}

const results = [await runOpenCode()];
process.stdout.write(`${JSON.stringify({ protocolVersion: 1, results })}\n`);
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
