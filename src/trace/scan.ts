import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { enqueueOrchestrationJob } from '../orchestration/jobs.js';
import { readTraceCursor, upsertTraceCursor } from './ingest.js';
import { readOrcaTraceRun, ORCA_TRACE_RUN_ID_PATTERN } from './orca-trace.js';
import { canonicalContentHash } from '../serialization/validate.js';

export const ORCA_TRACE_SCAN_MAX_RUNS = 8;
export const ORCA_TRACE_SCAN_MIN_INTERVAL_MS = 5_000;
export const ORCA_TRACE_SCAN_TIMEOUT_MS = 1_500;

export interface TraceStoreProbe {
  readonly present: boolean;
  readonly signature: string | null;
  readonly newestRunIds: readonly string[];
}

export interface TraceScanOutcome {
  readonly runsDirectory: string;
  readonly scanned: number;
  readonly enqueued: number;
  readonly skippedUnsupported: number;
}

export function orcaRunsDirectory(projectRoot: string): string {
  if (typeof projectRoot !== 'string'
    || !path.isAbsolute(projectRoot)
    || projectRoot.length === 0
    || projectRoot.length > 4096) {
    throw new KiokukoError('VALIDATION_ERROR', 'Project root must be a bounded absolute path');
  }
  return path.join(projectRoot, '.orca', 'runs');
}

interface ProbeEntry {
  readonly runId: string;
  readonly mtimeMs: number;
}

function listTraceRunEntries(runsDirectory: string, maximum: number): ProbeEntry[] {
  const entries = readdirSync(runsDirectory, { encoding: 'utf8' })
    .filter((entry) => ORCA_TRACE_RUN_ID_PATTERN.test(entry));
  const scanned: ProbeEntry[] = [];
  for (const runId of entries) {
    try {
      const eventsStat = statSync(path.join(runsDirectory, runId, 'events.jsonl'));
      if (eventsStat.isFile() && statSync(path.join(runsDirectory, runId, 'manifest.json')).isFile()) {
        scanned.push({ runId, mtimeMs: eventsStat.mtimeMs });
      }
    } catch {
      continue;
    }
  }
  scanned.sort((left, right) => right.mtimeMs - left.mtimeMs || left.runId.localeCompare(right.runId));
  return scanned.slice(0, maximum);
}

export function probeOrcaTraceStore(projectRoot: string): TraceStoreProbe {
  const runsDirectory = orcaRunsDirectory(projectRoot);
  let entries: ProbeEntry[];
  try {
    entries = listTraceRunEntries(runsDirectory, Number.MAX_SAFE_INTEGER);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      return { present: false, signature: null, newestRunIds: [] };
    }
    throw error;
  }
  if (entries.length === 0) return { present: false, signature: null, newestRunIds: [] };
  const newest = entries.slice(0, ORCA_TRACE_SCAN_MAX_RUNS);
  return {
    present: true,
    signature: JSON.stringify(newest.map((entry) => [entry.runId, entry.mtimeMs])),
    newestRunIds: newest.map((entry) => entry.runId),
  };
}

interface TraceScanPlan {
  readonly scanned: number;
  readonly enqueues: ReadonlyArray<{ readonly traceRunId: string; readonly fromSeq: number; readonly throughSeq: number }>;
  readonly unsupportedRunIds: readonly string[];
}

async function planTraceScan(
  database: SqliteDatabase,
  runsDirectory: string,
  maxRuns: number,
  now: string,
): Promise<TraceScanPlan> {
  const entries = listTraceRunEntries(runsDirectory, maxRuns);
  const enqueues: Array<{ traceRunId: string; fromSeq: number; throughSeq: number }> = [];
  const unsupportedRunIds: string[] = [];
  for (const entry of entries) {
    const read = await readOrcaTraceRun(runsDirectory, entry.runId);
    if (read.status !== 'ready') {
      if (read.status === 'unsupported_schema') {
        unsupportedRunIds.push(entry.runId);
      }
      continue;
    }
    const cursor = readTraceCursor(database, runsDirectory, entry.runId);
    if (cursor !== undefined && cursor.state === 'unsupported') continue;
    if (read.maxSeq < 0) continue;
    const lagsBySequence = read.maxSeq > (cursor?.lastSeq ?? -1);
    const lagsByMtime = cursor === undefined
      ? false
      : entry.mtimeMs > Date.parse(cursor.updatedAt);
    if (cursor !== undefined && !lagsBySequence && !lagsByMtime) continue;
    enqueues.push({
      traceRunId: entry.runId,
      fromSeq: cursor === undefined ? 0 : cursor.lastSeq + 1,
      throughSeq: read.maxSeq,
    });
  }
  return { scanned: entries.length, enqueues, unsupportedRunIds };
}

export async function scanOrcaTraceStore(
  database: SqliteDatabase,
  runsDirectory: string,
  options: { maxRuns?: number; now?: string } = {},
): Promise<TraceScanOutcome> {
  if (typeof runsDirectory !== 'string'
    || !path.isAbsolute(runsDirectory)
    || runsDirectory.length === 0
    || runsDirectory.length > 4096) {
    throw new KiokukoError('VALIDATION_ERROR', 'OrcaReplay runs directory must be a bounded absolute path');
  }
  const maxRuns = options.maxRuns ?? ORCA_TRACE_SCAN_MAX_RUNS;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 64) {
    throw new KiokukoError('VALIDATION_ERROR', 'Trace scan run limit is invalid');
  }
  const now = options.now ?? new Date().toISOString();
  let plan: TraceScanPlan;
  try {
    plan = await planTraceScan(database, runsDirectory, maxRuns, now);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { runsDirectory, scanned: 0, enqueued: 0, skippedUnsupported: 0 };
    }
    throw error;
  }
  return withImmediateTransaction(database, () => {
    let enqueued = 0;
    for (const enqueue of plan.enqueues) {
      const cursor = readTraceCursor(database, runsDirectory, enqueue.traceRunId);
      const currentFromSeq = cursor === undefined ? 0 : cursor.lastSeq + 1;
      if (cursor !== undefined && cursor.state === 'unsupported') continue;
      if (cursor !== undefined && cursor.lastSeq >= enqueue.throughSeq) continue;
      const payload = {
        directory: runsDirectory,
        traceRunId: enqueue.traceRunId,
        fromSeq: currentFromSeq,
      };
      const inputDigest = canonicalContentHash({ kind: 'trace_ingestion', runId: null, payload });
      const existing = database.prepare(`
        SELECT 1 AS present
        FROM orchestration_jobs
        WHERE kind = 'trace_ingestion' AND input_digest = ?
      `).get<{ present: number }>(inputDigest);
      if (existing !== undefined) continue;
      const job = enqueueOrchestrationJob(database, {
        kind: 'trace_ingestion',
        runId: null,
        payload,
        now,
      });
      void job;
      enqueued += 1;
    }
    for (const traceRunId of plan.unsupportedRunIds) {
      upsertTraceCursor(database, {
        runsDirectory,
        traceRunId,
        lastSeq: 0,
        state: 'unsupported',
        now,
      });
    }
    return {
      runsDirectory,
      scanned: plan.scanned,
      enqueued,
      skippedUnsupported: plan.unsupportedRunIds.length,
    };
  });
}

export interface TraceScanTickOptions {
  readonly projectRoot: string;
  readonly log?: (message: string, extra?: Record<string, unknown>) => void | Promise<void>;
  readonly spawnImpl?: typeof spawn;
  readonly nodeExecutable?: string;
  readonly cliScript?: string;
  readonly minIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface TraceScanTickState {
  lastSignature: string | null;
  lastStartedAtMs: number;
}

function packageOwnedCli(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '../bin/kiokuko.js'),
    path.resolve(moduleDirectory, '../../dist/bin/kiokuko.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export async function runBoundedScanSubprocess(
  spawnImpl: typeof spawn,
  projectRoot: string,
  timeoutMs: number,
  nodeExecutable = process.execPath,
  cliScript = packageOwnedCli(),
): Promise<boolean> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnImpl(
      nodeExecutable,
      [cliScript, 'trace', 'scan', '--project-root', projectRoot],
      { cwd: projectRoot, stdio: 'ignore' },
    );
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(accepted);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* the exit listener below settles the race */ }
      settle(false);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      settle(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      settle(code === 0);
    });
  });
}

export function createTraceScanTick(options: TraceScanTickOptions): () => Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const minIntervalMs = options.minIntervalMs ?? ORCA_TRACE_SCAN_MIN_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? ORCA_TRACE_SCAN_TIMEOUT_MS;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 300_000) {
    throw new KiokukoError('VALIDATION_ERROR', 'Trace scan interval is invalid');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new KiokukoError('VALIDATION_ERROR', 'Trace scan timeout is invalid');
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const cliScript = options.cliScript ?? packageOwnedCli();
  if (typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable) || nodeExecutable.length > 4096
    || typeof cliScript !== 'string' || !path.isAbsolute(cliScript) || cliScript.length > 4096) {
    throw new KiokukoError('VALIDATION_ERROR', 'Trace scan subprocess paths are invalid');
  }
  const now = options.now ?? Date.now;
  const state: TraceScanTickState = { lastSignature: null, lastStartedAtMs: 0 };
  let inFlight: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    let probe: TraceStoreProbe;
    try {
      probe = probeOrcaTraceStore(options.projectRoot);
    } catch (error) {
      await options.log?.('OrcaReplay trace store probe failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!probe.present) {
      state.lastSignature = null;
      return;
    }
    if (probe.signature === state.lastSignature) return;
    const nowMs = now();
    if (nowMs - state.lastStartedAtMs < minIntervalMs) return;
    state.lastSignature = probe.signature;
    state.lastStartedAtMs = nowMs;
    const accepted = await runBoundedScanSubprocess(
      spawnImpl,
      options.projectRoot,
      timeoutMs,
      nodeExecutable,
      cliScript,
    );
    if (!accepted) state.lastSignature = null;
  };
  return (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    const operation = run();
    inFlight = operation;
    void operation.then(
      () => { if (inFlight === operation) inFlight = undefined; },
      () => { if (inFlight === operation) inFlight = undefined; },
    );
    return operation;
  };
}
