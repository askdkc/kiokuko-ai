import path from 'node:path';
import type { Command } from 'commander';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { successEnvelope } from '../serialization/envelope.js';
import {
  ORCA_TRACE_SCAN_MAX_RUNS,
  orcaRunsDirectory,
  scanOrcaTraceStore,
} from '../trace/scan.js';

export interface TraceCommandDependencies {
  readonly withDatabase: <T>(operation: (database: SqliteDatabase) => T | Promise<T>) => Promise<T>;
}

function parseRunLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
    throw new KiokukoError('VALIDATION_ERROR', 'Trace scan run limit is invalid');
  }
  return limit;
}

function emit(json: boolean | undefined, data: Awaited<ReturnType<typeof scanOrcaTraceStore>>): void {
  const message = `Scanned ${data.scanned} OrcaReplay run${data.scanned === 1 ? '' : 's'}; enqueued ${data.enqueued} trace ingestion job${data.enqueued === 1 ? '' : 's'}`;
  process.stdout.write(json ? `${JSON.stringify(successEnvelope('trace.scan', data))}\n` : `${message}\n`);
}

export function registerTraceCommands(cli: Command, dependencies: TraceCommandDependencies): void {
  const trace = cli.command('trace').description('Inspect the read-only OrcaReplay trace store');
  trace.command('scan')
    .description('Probe .orca/runs and enqueue bounded trace ingestion jobs')
    .option('--project-root <path>', 'Project root containing .orca/runs', process.cwd())
    .option('--max-runs <number>', 'Maximum runs to inspect', String(ORCA_TRACE_SCAN_MAX_RUNS))
    .option('--json', 'Emit a JSON response')
    .action(async (options: { projectRoot: string; maxRuns: string; json?: boolean }) => {
      const projectRoot = path.resolve(options.projectRoot);
      const data = await dependencies.withDatabase((database) => scanOrcaTraceStore(
        database,
        orcaRunsDirectory(projectRoot),
        { maxRuns: parseRunLimit(options.maxRuns) },
      ));
      emit(options.json, data);
    });
}
