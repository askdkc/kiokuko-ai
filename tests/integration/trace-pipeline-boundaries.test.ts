import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, appendFile, realpath, symlink, rename, open, copyFile, stat, utimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { recordTaskContextRevision } from '../../src/context/revisions.js';
import { ingestTraceRun, readTraceCursor, readStoredTraceContext } from '../../src/trace/ingest.js';
import { readTraceBatch, readOrcaTraceManifest, resolveBlobPayload } from '../../src/trace/orca-trace.js';
import { TraceInputError, TRACE_LIMITS, parseTraceJson } from '../../src/trace/bounded-read.js';
import { applyTraceEvents, buildTraceContext } from '../../src/trace/aggregate.js';
import { TraceScanSession, scanOrcaTraceStore } from '../../src/trace/scan.js';
import { TraceDiscoveryCoordinator } from '../../src/trace/discovery.js';
import { syncTraceStore } from '../../src/trace/sync.js';
import { resolveTraceStoreLocation, registerTraceStore } from '../../src/trace/store-location.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { enqueueOrchestrationJob, claimOrchestrationJobs } from '../../src/orchestration/jobs.js';
import { traceId, traceLine, writeTrace } from '../fixtures/orca-trace.js';
async function fixture(t: test.TestContext) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'trace-bounds-')));
    const dbpath = path.join(root, 'db.sqlite');
    const db = openConnection(dbpath);
    migrateDatabase(db);
    t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
    return { root, db, dbpath, runs: path.join(root, '.orca/runs') };
}
const completed = [traceLine(0, 'run.start'), traceLine(1, 'error', { kind: 'compile' }), traceLine(2, 'note', { rule: 'demo' }), traceLine(3, 'run.end')];
test('tiny batches advance byte offsets and retain a Unicode line until LF arrives', async (t) => {
    const { db, runs } = await fixture(t);
    const lines = [traceLine(0, 'run.start'), traceLine(1, 'note', { rule: '日本語😀' }), traceLine(2, 'note', { rule: 'last' })];
    await writeTrace(runs, lines);
    let lastOffset = 0;
    for (let i = 0; i < 3; i++) {
        const out = await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0, maxBytes: 1, maxEvents: 1 });
        const cursor = readTraceCursor(db, runs, traceId)!;
        assert.ok(cursor.offset > lastOffset);
        lastOffset = cursor.offset;
        assert.equal(cursor.aggregate?.events, i + 1);
        assert.equal(out.hasMore, i < 2);
    }
    const file = path.join(runs, traceId, 'events.jsonl');
    const tail = traceLine(3, 'note', { rule: '追記' });
    await appendFile(file, tail.slice(0, -2));
    const held = await readTraceBatch(runs, traceId, { offset: lastOffset, lastSeq: 2 });
    assert.equal(held.nextByteOffset, lastOffset);
    assert.equal(held.waitingForCompleteLine, true);
    await appendFile(file, tail.slice(-2) + '\n');
    const done = await readTraceBatch(runs, traceId, { offset: lastOffset, lastSeq: 2 });
    assert.equal(done.events[0]?.attrs?.rule, '追記');
    assert.equal(done.lastSeq, 3);
});
test('UTF-8 crossing the read buffer and deterministic reducer partitions', async (t) => {
    const { runs } = await fixture(t);
    const lines = [traceLine(0, 'note', { rule: 'first', detail: '😀'.repeat(17000) }), traceLine(1, 'tool.call', { name: 'bash' }), traceLine(2, 'error', { kind: 'compile' })];
    await writeTrace(runs, lines);
    const batch = await readTraceBatch(runs, traceId);
    const all = applyTraceEvents(undefined, batch.events);
    let split;
    for (const event of batch.events)
        split = applyTraceEvents(split, [event]);
    assert.deepEqual(split, all);
    canonicalContentHash(all);
});
test('manifest-only finalization and unsupported manifest recovery do not depend on events mtime', async (t) => {
    const { db, runs } = await fixture(t);
    await writeTrace(runs, completed, '1.0.0');
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    const file = path.join(runs, traceId, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.schema_version = '0.1.0';
    delete manifest.integrity;
    await writeFile(file, JSON.stringify(manifest));
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    assert.equal(readTraceCursor(db, runs, traceId)?.finalization, 'ended_pending_manifest');
    const before = await stat(path.join(runs, traceId, 'events.jsonl'));
    manifest.integrity = { events_sha256: createHash('sha256').update(await readFile(path.join(runs, traceId, 'events.jsonl'))).digest('hex') };
    await writeFile(file, JSON.stringify(manifest));
    const out = await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 999 });
    assert.equal(out.finalization, 'finalized');
    assert.equal((await stat(path.join(runs, traceId, 'events.jsonl'))).mtimeMs, before.mtimeMs);
    await writeFile(file, '{"schema_version":');
    assert.equal((await readOrcaTraceManifest(runs, traceId)).ok, false);
    await writeFile(file, JSON.stringify(manifest));
    assert.equal((await readOrcaTraceManifest(runs, traceId)).ok, true);
});
test('two SQLite connections reject stale commit and preserve exactly one aggregate', async (t) => {
    const { db, runs, dbpath } = await fixture(t);
    const other = openConnection(dbpath);
    t.after(() => other.close());
    await writeTrace(runs, completed);
    let arrived!: () => void;
    const barrier = new Promise<void>(r => arrived = r);
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    const first = ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0, beforeCommit: async () => { arrived(); await gate; } });
    await barrier;
    await ingestTraceRun(other, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    release();
    await assert.rejects(first, (e: unknown) => (e as {
        code: string;
    }).code === 'CONFLICT');
    assert.equal(readTraceCursor(db, runs, traceId)?.aggregate?.events, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orchestration_jobs WHERE kind='memory_promotion'").get<{
        n: number;
    }>()!.n, 1);
});
test('failure before commit and expired lease publish neither context nor cursor', async (t) => {
    const { db, runs } = await fixture(t);
    await writeTrace(runs, completed);
    await assert.rejects(() => ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0, beforeCommit: () => { throw Error('injected'); } }));
    assert.equal(readTraceCursor(db, runs, traceId), undefined);
    enqueueOrchestrationJob(db, { kind: 'trace_ingestion', payload: { directory: runs, traceRunId: traceId } });
    const [job] = claimOrchestrationJobs(db, { owner: 'test', limit: 1 });
    await assert.rejects(() => ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0, lease: { jobId: job!.jobId, owner: 'test' }, beforeCommit: () => {
            db.prepare("UPDATE orchestration_jobs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE job_id=?").run(job!.jobId);
        } }));
    assert.equal(readStoredTraceContext(db, runs, traceId), undefined);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    assert.equal(readTraceCursor(db, runs, traceId)?.aggregate?.events, 4);
});
test('11 runs progress in batches of three while a hot run changes', async (t) => {
    const { db, runs } = await fixture(t);
    const session = new TraceScanSession(runs);
    t.after(() => session.close());
    for (let i = 0; i < 11; i++)
        await writeTrace(runs, [traceLine(0, 'run.start')], '0.1.0', `run_${i.toString(16).padStart(6, '0')}`);
    for (let i = 0; i < 4; i++) {
        await writeTrace(runs, [traceLine(0, 'run.start'), traceLine(1, 'note', { rule: `hot${i}` })], '0.1.0', 'run_000000');
        const out = await scanOrcaTraceStore(db, runs, { session, maxRuns: 3 });
        assert.ok(out.scanned <= 3);
    }
    const rows = db.prepare("SELECT DISTINCT json_extract(payload_json,'$.traceRunId') AS id FROM orchestration_jobs WHERE kind='trace_ingestion'").all();
    assert.equal(rows.length, 11);
});
test('retained directory enumeration reaches beyond 200 and closes without scheduling after stop', async (t) => {
    const { db, runs, root } = await fixture(t);
    for (let i = 0; i < 205; i++)
        await mkdir(path.join(runs, `run_${i.toString(16).padStart(6, '0')}`), { recursive: true });
    const session = new TraceScanSession(runs);
    assert.equal(await session.step(db), 200);
    assert.equal(session.complete, false);
    assert.equal(await session.step(db), 5);
    assert.equal(session.complete, true);
    await session.close();
    const coordinator = new TraceDiscoveryCoordinator(db);
    coordinator.register(await resolveTraceStoreLocation(root));
    await coordinator.close();
    await coordinator.step();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orchestration_jobs').get<{
        n: number;
    }>()!.n, 0);
});
for (const kind of ['manifest', 'events', 'run', 'fifo'] as const)
    test(`rejects ${kind} links or special files without modifying originals`, async (t) => {
        if (kind === 'fifo' && process.platform === 'win32') {
            t.skip('POSIX FIFO');
            return;
        }
        const { runs, root } = await fixture(t);
        await writeTrace(runs, completed);
        const target = kind === 'run' ? path.join(runs, traceId) : path.join(runs, traceId, kind === 'manifest' ? 'manifest.json' : 'events.jsonl');
        const saved = path.join(root, 'original');
        await rename(target, saved);
        if (kind === 'fifo')
            execFileSync('mkfifo', [target]);
        else
            await symlink(saved, target);
        await assert.rejects(() => kind === 'manifest' || kind === 'run' ? readOrcaTraceManifest(runs, traceId) : readTraceBatch(runs, traceId), e => e instanceof TraceInputError);
        assert.ok(await stat(saved));
    });
test('manifest line JSON and explicit blob budgets reject before unbounded allocation', async (t) => {
    const { runs } = await fixture(t);
    await writeTrace(runs, completed);
    const dir = path.join(runs, traceId);
    await writeFile(path.join(dir, 'manifest.json'), 'x'.repeat(TRACE_LIMITS.manifest + 1));
    await assert.rejects(() => readOrcaTraceManifest(runs, traceId), e => e instanceof TraceInputError);
    await writeTrace(runs, [traceLine(0, 'note', { detail: 'x'.repeat(TRACE_LIMITS.line) })]);
    await assert.rejects(() => readTraceBatch(runs, traceId), e => e instanceof TraceInputError);
    assert.throws(() => parseTraceJson('{"a":1,"a":2}'));
    assert.throws(() => parseTraceJson('['.repeat(65) + '0' + ']'.repeat(65)));
    assert.throws(() => parseTraceJson('[' + '0,'.repeat(20001) + '0]'));
    assert.throws(() => parseTraceJson(Buffer.from([0xff])));
    const bytes = Buffer.from('{"safe":true}');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const blob = path.join(dir, 'blobs', digest.slice(0, 2));
    await mkdir(blob, { recursive: true });
    await writeFile(path.join(blob, digest), bytes);
    assert.equal((await resolveBlobPayload(dir, { $blob: `sha256:${digest}`, bytes: bytes.length })).ok, true);
    assert.equal((await resolveBlobPayload(dir, { $blob: `sha256:${digest}`, bytes: bytes.length + 1 })).ok, false);
});
test('final replay replaces changed prefix and truncation never mixes generations', async (t) => {
    const { db, runs } = await fixture(t);
    await writeTrace(runs, [traceLine(0, 'error', { kind: 'old' })]);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    await writeTrace(runs, [traceLine(0, 'note', { rule: 'replacement' }), traceLine(1, 'run.end')]);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 1 });
    let aggregate = readTraceCursor(db, runs, traceId)!.aggregate!;
    assert.equal(aggregate.errorCount, 0);
    assert.equal(aggregate.notes[0]?.rule, 'replacement');
    const generation = readTraceCursor(db, runs, traceId)!.generation;
    await writeTrace(runs, [traceLine(0, 'run.end')]);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    assert.ok(readTraceCursor(db, runs, traceId)!.generation > generation);
    assert.equal(readTraceCursor(db, runs, traceId)!.aggregate?.events, 1);
});
test('secret before truncation is rejected and tool overflow is explicit and bounded', async (t) => {
    const { db, runs } = await fixture(t);
    await writeTrace(runs, [traceLine(0, 'note', { rule: 'demo', detail: 'x'.repeat(199) + ' api_key = super-secret-value-12345' })]);
    await assert.rejects(() => ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 }), (e: unknown) => (e as {
        code: string;
    }).code === 'SECURITY_REJECTION');
    assert.equal(readTraceCursor(db, runs, traceId), undefined);
    await writeTrace(runs, Array.from({ length: 300 }, (_, i) => traceLine(i, 'tool.call', { name: `${'😀'.repeat(120)}${i}` })));
    const batch = await readTraceBatch(runs, traceId);
    const aggregate = applyTraceEvents(undefined, batch.events);
    assert.ok(aggregate.overflow);
    assert.ok(aggregate.otherToolCalls > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(aggregate)) <= TRACE_LIMITS.aggregate);
    const built = buildTraceContext(traceId, '0.1.0', 299, 'unavailable', aggregate, {});
    canonicalContentHash(built.context);
    assert.ok(Buffer.byteLength(JSON.stringify(built.context)) < 4096);
});
test('explicit sync only claims its store and reports a missing explicit run', async (t) => {
    const { db, runs, root } = await fixture(t);
    await writeTrace(runs, completed);
    const other = enqueueOrchestrationJob(db, { kind: 'trace_ingestion', payload: { directory: '/other/store', traceRunId: traceId } });
    const plan = enqueueOrchestrationJob(db, { kind: 'plan_publish', payload: { runId: 'not-claimed' } });
    const synced = await syncTraceStore(db, { captureCwd: root, timeoutMs: 5000 });
    assert.equal(synced.exitCode, 0);
    for (const job of [other, plan])
        assert.equal(db.prepare('SELECT state FROM orchestration_jobs WHERE job_id=?').get<{
            state: string;
        }>(job.jobId)!.state, 'pending');
    await assert.rejects(() => syncTraceStore(db, { captureCwd: root, traceRunId: 'run_ffffff' }), (e: unknown) => (e as {
        code: string;
    }).code === 'NOT_FOUND');
    const before = readTraceCursor(db, runs, traceId)!.generation;
    await syncTraceStore(db, { captureCwd: root, rebuild: true });
    assert.equal(readTraceCursor(db, runs, traceId)!.generation, before + 1);
});
test('80 MiB log reaches its tail using bounded batches and final streaming rebuild', async (t) => {
    const { db, runs } = await fixture(t);
    const dir = path.join(runs, traceId);
    await mkdir(dir, { recursive: true });
    const handle = await open(path.join(dir, 'events.jsonl'), 'w');
    const hash = createHash('sha256');
    let bytes = 0;
    let seq = 0;
    try {
        while (bytes < 80 * 1024 * 1024) {
            const line = JSON.stringify({ ...JSON.parse(traceLine(seq++, 'model.response')), payload: { text: 'x'.repeat(64 * 1024) } }) + '\n';
            await handle.write(line);
            hash.update(line);
            bytes += Buffer.byteLength(line);
        }
        const tail = traceLine(seq++, 'run.end') + '\n';
        await handle.write(tail);
        hash.update(tail);
        bytes += Buffer.byteLength(tail);
    }
    finally {
        await handle.close();
    }
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ schema_version: '0.1.0', run_id: traceId, counts: { events: seq }, integrity: { events_sha256: hash.digest('hex') } }));
    let batches = 0;
    let prior = 0;
    for (;;) {
        const out = await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
        batches++;
        const cursor = readTraceCursor(db, runs, traceId)!;
        assert.ok(cursor.offset > prior);
        prior = cursor.offset;
        if (!out.hasMore)
            break;
    }
    const final = readTraceCursor(db, runs, traceId)!;
    assert.ok(batches > 16);
    assert.equal(final.offset, bytes);
    assert.equal(final.lastSeq, seq - 1);
    assert.equal(final.finalization, 'finalized');
    assert.equal(final.integrity, 'verified');
    assert.equal(final.aggregate?.events, seq);
    t.diagnostic(`bytes=${bytes}, batches=${batches}, offset=${final.offset}, seq=${final.lastSeq}`);
});
test('v3 migration preserves normal memory and snapshots, rolls back atomically, and quarantines legacy trace', async (t) => {
    const { root } = await fixture(t);
    const migrations = path.join(root, 'migrations');
    await mkdir(migrations);
    for (const file of ['001_initial.sql', '002_non_blocking_orchestration.sql', '003_orcareplay_trace.sql'])
        await copyFile(path.resolve('migrations', file), path.join(migrations, file));
    const db = openConnection(path.join(root, 'legacy.sqlite'));
    t.after(() => db.close());
    migrateDatabase(db, migrations);
    db.prepare("INSERT INTO orcareplay_trace_context VALUES('/missing/.orca/runs','run_abcdef','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','orcareplay','time','time')").run();
    db.prepare("INSERT INTO orcareplay_trace_cursors VALUES('/missing/.orca/runs','run_abcdef',123,'active','time','time')").run();
    db.prepare("INSERT INTO ledger_runs(run_id,workspace,client_kind,protocol_version,capture_profile,coverage_json,status,title,metadata_json,last_sequence,started_at,created_at,updated_at) VALUES('history','project:test','opencode','1','minimal','{}','active','history','{}',0,'time','time','time')").run();
    recordEntry(db, { workspace: 'project:test', kind: 'fact', title: 'Existing project fact', body: 'This entry predates the trace migration.' });
    recordTaskContextRevision(db, { runId: 'history', context: { advisory: { source: 'orcareplay', historical: true }, preserved: 'immutable revision' } });
    const tables = ['entries', 'entry_revisions', 'ledger_runs', 'task_context_revisions', 'curator_approvals'];
    const existing = tables.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
    const snapshots = existing.map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()] as const);
    const checksums = db.prepare('SELECT version,checksum FROM schema_migrations').all();
    await copyFile(path.resolve('migrations/004_orcareplay_pipeline.sql'), path.join(migrations, '004_orcareplay_pipeline.sql'));
    assert.throws(() => migrateDatabase(db, migrations, { beforeMarkApplied: (_db, migration) => {
            if (migration.version === 4)
                throw Error('injected rollback');
        } }));
    assert.equal(db.prepare('PRAGMA user_version').get<{
        user_version: number;
    }>()!.user_version, 3);
    assert.equal(db.prepare('SELECT last_seq FROM orcareplay_trace_cursors').get<{
        last_seq: number;
    }>()!.last_seq, 123);
    migrateDatabase(db, migrations);
    for (const [name, rows] of snapshots)
        assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(), rows);
    assert.deepEqual(db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=3').all(), checksums);
    assert.equal(db.prepare('SELECT reader_policy_version FROM orcareplay_trace_context').get<{
        reader_policy_version: number;
    }>()!.reader_policy_version, 1);
    assert.equal(db.prepare('SELECT last_seq FROM orcareplay_trace_cursors').get<{
        last_seq: number;
    }>()!.last_seq, -1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
test('multiple stores get round-robin discovery opportunities', async (t) => {
    const { db, root } = await fixture(t);
    const huge = path.join(root, 'huge'), small = path.join(root, 'small');
    await mkdir(huge);
    await mkdir(small);
    const a = await resolveTraceStoreLocation(huge, root), b = await resolveTraceStoreLocation(small, root);
    for (let i = 0; i < 205; i++)
        await mkdir(path.join(a.runsDirectory, `run_${i.toString(16).padStart(6, '0')}`), { recursive: true });
    await writeTrace(b.runsDirectory, completed);
    const coordinator = new TraceDiscoveryCoordinator(db);
    t.after(() => coordinator.close());
    coordinator.register(a);
    coordinator.register(b);
    await coordinator.step();
    await coordinator.step();
    assert.ok(db.prepare("SELECT 1 FROM orchestration_jobs WHERE json_extract(payload_json,'$.directory')=?").get(b.runsDirectory));
});
test('integrity mismatch is neither delivered nor promoted and original bytes stay unchanged', async (t) => {
    const { db, runs, root } = await fixture(t);
    await writeTrace(runs, completed);
    const file = path.join(runs, traceId, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.integrity.events_sha256 = '0'.repeat(64);
    await writeFile(file, JSON.stringify(manifest));
    const original = await readFile(path.join(runs, traceId, 'events.jsonl'));
    const out = await syncTraceStore(db, { captureCwd: root });
    assert.equal(out.exitCode, 3);
    assert.equal(readTraceCursor(db, runs, traceId)?.integrity, 'mismatch');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orchestration_jobs WHERE kind='memory_promotion'").get<{
        n: number;
    }>()!.n, 0);
    const { readTraceAdvisory } = await import('../../src/trace/advisory.js');
    assert.equal(readTraceAdvisory(db, root, root).context, undefined);
    assert.deepEqual(await readFile(path.join(runs, traceId, 'events.jsonl')), original);
});
test('off and failed optional skill enrichment leave finalized context and candidates intact', async (t) => {
    const { db, runs } = await fixture(t);
    await writeTrace(runs, [traceLine(0, 'tool.call', { name: 'typescript' }), traceLine(1, 'note', { rule: 'demo' }), traceLine(2, 'run.end')]);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0, skillDiscoveryMode: 'off' });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orchestration_jobs WHERE kind='skill_discovery'").get<{
        n: number;
    }>()!.n, 0);
    const cursor = readTraceCursor(db, runs, traceId)!;
    const context = readStoredTraceContext(db, runs, traceId)!;
    enqueueOrchestrationJob(db, { kind: 'skill_discovery', payload: { source: 'orcareplay', directory: runs, traceRunId: traceId, generation: cursor.generation, readerPolicyVersion: 2, sourceDigest: context.context.sourceDigest!, mode: 'official', queries: ['typescript'] } });
    const [job] = claimOrchestrationJobs(db, { owner: 'enrich', kinds: ['skill_discovery'], limit: 1 });
    const { enrichTraceSkills } = await import('../../src/trace/enrichment.js');
    await enrichTraceSkills(db, job!, async () => { throw Error('offline'); });
    assert.equal(readStoredTraceContext(db, runs, traceId)?.digest, context.digest);
    assert.equal(readTraceCursor(db, runs, traceId)?.finalization, 'finalized');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orchestration_jobs WHERE kind='memory_promotion'").get<{
        n: number;
    }>()!.n, 1);
});
test('interrupted final verification keeps resumable progress and does not claim verified', async (t) => {
    const { db, runs, root } = await fixture(t);
    await writeTrace(runs, completed);
    const abort = new AbortController();
    const result = await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0, signal: abort.signal, beforeFinalVerify: () => abort.abort() });
    assert.equal(result.finalization, 'ended_unverified');
    assert.equal(result.integrity, 'unavailable');
    const stored = readTraceCursor(db, runs, traceId)!;
    assert.ok(stored.offset > 0);
    assert.equal(stored.aggregate?.events, 4);
    const retried = await syncTraceStore(db, { captureCwd: root, timeoutMs: 5000 });
    assert.equal(retried.exitCode, 0);
    assert.equal(readTraceCursor(db, runs, traceId)?.finalization, 'finalized');
});
test('same-size rewrite with preserved mtime starts a new generation', async (t) => {
    const { db, runs } = await fixture(t);
    await writeTrace(runs, [traceLine(0, 'note', { rule: 'first' })]);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    const before = readTraceCursor(db, runs, traceId)!;
    const target = path.join(runs, traceId, 'events.jsonl');
    const info = await stat(target);
    await writeFile(target, (await readFile(target, 'utf8')).replace('first', 'other'));
    await utimes(target, info.atime, info.mtime);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
    const after = readTraceCursor(db, runs, traceId)!;
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.aggregate?.notes[0]?.rule, 'other');
});
test('reopening mid-ingestion resumes the stored byte position and generation', async (t) => {
    const { db, runs, dbpath } = await fixture(t);
    await writeTrace(runs, completed);
    await ingestTraceRun(db, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0, maxEvents: 1 });
    const before = readTraceCursor(db, runs, traceId)!;
    const reopened = openConnection(dbpath);
    try {
        const result = await ingestTraceRun(reopened, { runsDirectory: runs, traceRunId: traceId, fromSeq: 0 });
        assert.equal(result.finalization, 'finalized');
        assert.equal(readTraceCursor(reopened, runs, traceId)?.generation, before.generation);
        assert.equal(readTraceCursor(reopened, runs, traceId)?.aggregate?.events, 4);
    }
    finally {
        reopened.close();
    }
});
test('aggregate budget also holds for maximum details with heavily escaped strings', async (t) => {
    const { runs } = await fixture(t);
    const lines: string[] = [];
    for (let i = 0; i < 256; i++)
        lines.push(traceLine(lines.length, 'tool.call', { name: `${'x'.repeat(120)}${i}` }));
    for (let i = 0; i < 8; i++)
        lines.push(traceLine(lines.length, 'fs.change', { path: '\u0001'.repeat(512), status: '\u0001'.repeat(40) }));
    for (let i = 0; i < 4; i++)
        lines.push(traceLine(lines.length, 'error', { kind: '\u0001'.repeat(200), suite: '\u0001'.repeat(200) }));
    for (let i = 0; i < 4; i++)
        lines.push(traceLine(lines.length, 'note', { rule: '\u0001'.repeat(120), detail: '\u0001'.repeat(200) }));
    await writeTrace(runs, lines);
    const batch = await readTraceBatch(runs, traceId);
    const all = applyTraceEvents(undefined, batch.events);
    let split;
    for (const event of batch.events)
        split = applyTraceEvents(split, [event]);
    assert.deepEqual(all, split);
    assert.ok(Buffer.byteLength(JSON.stringify(all)) <= TRACE_LIMITS.aggregate);
    assert.ok(all.overflow);
    canonicalContentHash(all);
});
test('sync timeout preserves a different owner lease and reports partial completion', async (t) => {
    const { db, runs, root } = await fixture(t);
    await writeTrace(runs, completed);
    await scanOrcaTraceStore(db, runs);
    const [job] = claimOrchestrationJobs(db, { owner: 'external-worker', kinds: ['trace_ingestion'], leaseMs: 120000 });
    assert.ok(job);
    const result = await syncTraceStore(db, { captureCwd: root, timeoutMs: 20 });
    assert.equal(result.exitCode, 3);
    assert.equal(result.status, 'partial');
    assert.equal(db.prepare('SELECT lease_owner FROM orchestration_jobs WHERE job_id=?').get<{
        lease_owner: string;
    }>(job.jobId)!.lease_owner, 'external-worker');
});
test('canonical capture aliases deduplicate one registration', async (t) => {
    const { db, root } = await fixture(t);
    const real = path.join(root, 'real'), alias = path.join(root, 'alias');
    await mkdir(real);
    await symlink(real, alias);
    const a = await resolveTraceStoreLocation(real, root), b = await resolveTraceStoreLocation(alias, root);
    assert.deepEqual(a, b);
    registerTraceStore(db, a);
    registerTraceStore(db, b);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orcareplay_trace_stores').get<{
        n: number;
    }>()!.n, 1);
});
