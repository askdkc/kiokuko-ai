import { spawn } from 'node:child_process';
import type { SqliteDatabase } from '../db/adapter.js';
import { resolveTraceStoreLocation, registerTraceStore } from './store-location.js';
import { syncTraceStore, type TraceSyncResult } from './sync.js';
export interface TraceRecordOptions {
    cwd: string;
    args: readonly string[];
    syncTimeoutMs?: number;
    spawnImpl?: typeof spawn;
    executable?: string;
    environment?: NodeJS.ProcessEnv;
    stderr?: NodeJS.WritableStream;
}
export async function recordTrace(database: SqliteDatabase, options: TraceRecordOptions): Promise<{
    exitCode: number;
    recordExitCode: number;
    sync: TraceSyncResult | null;
}> {
    const location = await resolveTraceStoreLocation(options.cwd);
    registerTraceStore(database, location);
    const abort = new AbortController();
    let child: ReturnType<typeof spawn> | undefined;
    let syncing = false;
    let lastSignal: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals) => { if (syncing) {
        abort.abort();
        return;
    } if (lastSignal === signal)
        return; lastSignal = signal; child?.kill(signal); };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const stderr = options.stderr ?? process.stderr;
    let recordExitCode = 1;
    let sync: TraceSyncResult | null = null;
    try {
        try {
            child = (options.spawnImpl ?? spawn)(options.executable ?? 'orca', ['record', 'opencode', '--', ...options.args], { cwd: location.captureCwd, stdio: 'inherit', shell: false, ...(options.environment ? { env: options.environment } : {}) });
            recordExitCode = await new Promise<number>((resolve, reject) => { child!.once('error', reject); child!.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1))); });
        }
        catch {
            stderr.write('OrcaReplay could not be started. Check that orca is executable.\n');
        }
        if (recordExitCode === 0 && lastSignal)
            recordExitCode = lastSignal === 'SIGINT' ? 130 : 143;
        syncing = true;
        try {
            sync = await syncTraceStore(database, { captureCwd: location.captureCwd, ...(options.syncTimeoutMs === undefined ? {} : { timeoutMs: options.syncTimeoutMs }), signal: abort.signal });
        }
        catch {
            stderr.write('Trace synchronization failed.\n');
        }
        if (!sync || sync.exitCode !== 0)
            stderr.write(`Resume with: kiokuko-ai trace sync --capture-cwd '${location.captureCwd.replaceAll("'", "'\\''")}' --timeout-ms 120000\n`);
        return { exitCode: recordExitCode !== 0 ? recordExitCode : sync?.exitCode ?? 3, recordExitCode, sync };
    }
    finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
    }
}
