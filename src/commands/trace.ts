import { syncTraceStore, traceStatus } from '../trace/sync.js';
import { recordTrace } from '../trace/record.js';
import { resolveTraceStoreLocation, registerTraceStore } from '../trace/store-location.js';
import path from 'node:path';
import type { Command } from 'commander';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { successEnvelope } from '../serialization/envelope.js';
import { ORCA_TRACE_SCAN_MAX_RUNS, orcaRunsDirectory, scanOrcaTraceStore, } from '../trace/scan.js';
export interface TraceCommandDependencies {
    readonly cwd?: () => string;
    readonly output?: NodeJS.WritableStream;
    readonly setExitCode?: (code: number) => void;
    readonly withDatabase: <T>(operation: (database: SqliteDatabase) => T | Promise<T>) => Promise<T>;
}
function parseRunLimit(value: string): number {
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
        throw new KiokukoError('VALIDATION_ERROR', 'Trace scan run limit is invalid');
    }
    return limit;
}
export function registerTraceCommands(cli: Command, dependencies: TraceCommandDependencies): void {
    const output = dependencies.output ?? process.stdout;
    const exit = (code: number) => { if (dependencies.setExitCode)
        dependencies.setExitCode(code);
    else
        process.exitCode = code; };
    const emit = (name: string, json: boolean | undefined, data: unknown) => output.write(json ? `${JSON.stringify(successEnvelope(name, data))}\n` : `${JSON.stringify(data)}\n`);
    const cwd = () => dependencies.cwd?.() ?? process.cwd();
    const trace = cli.command('trace').description('Inspect the read-only OrcaReplay trace store');
    trace.command('scan')
        .description('Probe .orca/runs and enqueue bounded trace ingestion jobs')
        .option('--project-root <path>', 'Project root containing .orca/runs', process.cwd())
        .option('--max-runs <number>', 'Maximum runs to inspect', String(ORCA_TRACE_SCAN_MAX_RUNS))
        .option('--json', 'Emit a JSON response')
        .action(async (options: {
        projectRoot: string;
        maxRuns: string;
        json?: boolean;
    }) => {
        const projectRoot = path.resolve(options.projectRoot);
        const location = await resolveTraceStoreLocation(projectRoot);
        const data = await dependencies.withDatabase((database) => {
            registerTraceStore(database, location);
            return scanOrcaTraceStore(database, location.runsDirectory, { maxRuns: parseRunLimit(options.maxRuns) });
        });
        emit('trace.scan', options.json, data);
    });
    trace.command('sync').description('Synchronize one capture store snapshot')
        .option('--capture-cwd <path>', 'Recording working directory', cwd())
        .option('--run <id>', 'Synchronize only this run').option('--rebuild', 'Rebuild derived trace state')
        .option('--timeout-ms <number>', 'Sync deadline in milliseconds', '120000').option('--json', 'Emit JSON')
        .action(async (options) => {
        const data = await dependencies.withDatabase(db => syncTraceStore(db, { captureCwd: path.resolve(options.captureCwd), timeoutMs: Number(options.timeoutMs),
            ...(options.run ? { traceRunId: options.run } : {}), ...(options.rebuild ? { rebuild: true } : {}) }));
        emit('trace.sync', options.json, data);
        exit(data.exitCode);
    });
    trace.command('status').description('Show trace progress without raw trace content')
        .option('--capture-cwd <path>', 'Recording working directory', cwd()).option('--json', 'Emit JSON')
        .action(async (options) => {
        const location = await resolveTraceStoreLocation(path.resolve(options.captureCwd));
        const data = await dependencies.withDatabase(db => traceStatus(db, location));
        emit('trace.status', options.json, data);
    });
    trace.command('record').description('Record OpenCode and synchronize after Orca exits')
        .option('--sync-timeout-ms <number>', 'Post-recording deadline', '120000').argument('[args...]', 'OpenCode arguments after --')
        .action(async (args: string[], options: {
        syncTimeoutMs: string;
    }) => {
        const timeout = Number(options.syncTimeoutMs);
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86400000)
            throw new KiokukoError('VALIDATION_ERROR', 'Sync timeout invalid');
        const data = await dependencies.withDatabase(db => recordTrace(db, { cwd: cwd(), args, syncTimeoutMs: timeout }));
        exit(data.exitCode);
    });
}
