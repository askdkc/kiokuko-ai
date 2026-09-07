import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { ingestTraceRun, readStoredTraceContext } from '../../src/trace/ingest.js';
import { scanOrcaTraceStore } from '../../src/trace/scan.js';
import { createOrchestrationWorker } from '../../src/orchestration/worker.js';
import { traceId, traceLine, writeTrace } from '../fixtures/orca-trace.js';
async function fixture(t: test.TestContext) {
    const root = await mkdtemp(path.join(tmpdir(), 'trace-regression-'));
    const db = openConnection(path.join(root, 'db.sqlite'));
    migrateDatabase(db);
    t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
    return { db, runs: path.join(root, '.orca/runs') };
}
test('trace worker completes ingestion once with strict JSON results', async (t) => {
    const { db, runs } = await fixture(t);
    await writeTrace(runs, [traceLine(0, 'run.start'), traceLine(1, 'run.end')]);
    await scanOrcaTraceStore(db, runs);
    const worker = createOrchestrationWorker({ database: db, intervalMs: 10 });
    worker.start();
    try {
        const deadline = Date.now() + 1500;
        let row;
        do {
            row = db.prepare("SELECT state, attempts, error_code FROM orchestration_jobs WHERE kind='trace_ingestion'").get<{
                state: string;
                attempts: number;
                error_code: string | null;
            }>();
            if (row?.state === 'completed' || row?.state === 'failed')
                break;
            await new Promise(resolve => setTimeout(resolve, 10));
        } while (Date.now() < deadline);
        assert.deepEqual(row && { ...row }, { state: 'completed', attempts: 1, error_code: null });
    }
    finally {
        await worker.close();
    }
});
test('success replay and unsupported outcomes are canonical JSON', async (t) => {
    const { db, runs } = await fixture(t);
    await writeTrace(runs, [traceLine(0, 'run.start')]);
    for (let i = 0; i < 2; i++)
        canonicalContentHash(await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 }));
    await writeTrace(runs, [], '1.0.0');
    canonicalContentHash(await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 }));
    assert.throws(() => canonicalContentHash({ value: undefined }));
});
test('split ingestion preserves early errors notes and counts at finalization', async (t) => {
    const { db, runs } = await fixture(t);
    const lines = [traceLine(0, 'run.start'), traceLine(1, 'error', { kind: 'compile' }), traceLine(2, 'tool.call', { name: 'bash' }), traceLine(3, 'note', { rule: 'demo' })];
    await writeTrace(runs, lines);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    lines.push(traceLine(4, 'shell.result', { exit_code: 1 }), traceLine(5, 'run.end', { exit_code: 0 }));
    await writeTrace(runs, lines);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 4, fetchImpl: async () => { throw Error('offline'); } });
    const summary = readStoredTraceContext(db, runs, traceId)!.context.summary as any;
    assert.equal(summary.events, 6);
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.shellFailures, 1);
    assert.equal(summary.notes[0].rule, 'demo');
    assert.equal(summary.toolCalls[0].count, 1);
});
