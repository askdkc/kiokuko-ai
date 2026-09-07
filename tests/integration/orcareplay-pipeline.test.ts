import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { scanOrcaTraceStore } from '../../src/trace/scan.js';
import { createOrchestrationWorker } from '../../src/orchestration/worker.js';
import { syncTraceStore } from '../../src/trace/sync.js';
import { readStoredTraceContext } from '../../src/trace/ingest.js';
import { getGlobalDatabasePath } from '../../src/config/paths.js';
import { traceId } from '../fixtures/orca-trace.js';
const cli = path.resolve('src/bin/kiokuko.ts');
async function until(check: () => boolean | Promise<boolean>, ms = 10000) {
    const end = Date.now() + ms;
    while (!await check()) {
        if (Date.now() > end)
            throw Error('deadline');
        await new Promise(r => setTimeout(r, 10));
    }
}
async function prepare(db: ReturnType<typeof openConnection>, root: string, id: string) {
    return prepareOpenCodeTask(db, { requestId: id, cwd: root, task: 'Review recorded work',
        profileHints: { taskType: 'review', target: 'trace', expected: 'safe reference', constraints: null }, skillDiscoveryMode: 'off',
        capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }], client: { kind: 'opencode', sessionId: 'pipeline' } });
}
test('real CLI wrapper waits for fake Orca final writes and delivers the cumulative snapshot', async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'trace-pipeline-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', root]);
    const cwd = path.join(root, 'nested');
    const bin = path.join(root, 'bin');
    await mkdir(cwd);
    await mkdir(bin);
    const data = path.join(root, 'data');
    await mkdir(data);
    const environment = { ...process.env, HOME: root, KIOKUKO_DATA_DIR: data, KIOKUKO_SKILL_DISCOVERY: 'off', PATH: `${bin}:${process.env.PATH}` };
    const fake = path.join(bin, 'orca');
    await writeFile(fake, `#!${process.execPath}
const fs=require('node:fs');const p=require('node:path');const crypto=require('node:crypto');const cp=require('node:child_process');
const cwd=process.cwd(),dir=p.join(cwd,'.orca/runs/${traceId}');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(p.join(cwd,'args.json'),JSON.stringify(process.argv.slice(2)));
const line=(seq,type,attrs={})=>JSON.stringify({seq,type,attrs,ts:'2026-09-07T00:00:00Z',mono_us:seq,turn:0,actor:'host'});
const file=p.join(dir,'events.jsonl');let raw=[line(0,'run.start'),line(1,'error',{kind:'compile'}),line(2,'tool.call',{name:'bash'}),line(3,'note',{rule:'demo'})].join('\\n')+'\\n';
const manifest=()=>fs.writeFileSync(p.join(dir,'manifest.json'),JSON.stringify({schema_version:'0.1.0',run_id:'${traceId}',created_at:'2026-09-07T00:00:00Z',counts:{events:raw.split('\\n').length-1},integrity:{events_sha256:crypto.createHash('sha256').update(raw).digest('hex')}}));
fs.writeFileSync(file,raw);manifest();fs.writeFileSync(p.join(cwd,'ready'),'1');
const timer=setInterval(()=>{if(!fs.existsSync(p.join(cwd,'continue')))return;clearInterval(timer);
cp.execFileSync(process.execPath,['-e','process.exit(0)']);
raw+=line(4,'shell.result',{exit_code:1})+'\\n'+line(5,'run.end',{exit_code:0})+'\\n';fs.writeFileSync(file,raw);manifest();},10);
`, { mode: 0o755 });
    const args = ['run', 'space and "quotes"', "single'quote", 'line\nbreak', '--model', 'unchanged'];
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'trace', 'record', '--', ...args], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', x => stderr += x);
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    t.after(() => {
        if (child.exitCode === null)
            child.kill('SIGKILL');
    });
    await until(async () => {
        if (child.exitCode !== null)
            throw Error(stderr);
        return stat(path.join(cwd, 'ready')).then(() => true, () => false);
    });
    const db = openConnection(getGlobalDatabasePath({ env: environment }));
    t.after(() => db.close());
    migrateDatabase(db);
    const runs = path.join(cwd, '.orca/runs');
    await scanOrcaTraceStore(db, runs);
    const worker = createOrchestrationWorker({ database: db, intervalMs: 10 });
    worker.start();
    await until(() => readStoredTraceContext(db, runs, traceId) !== undefined);
    await worker.close();
    await writeFile(path.join(cwd, 'continue'), '1');
    assert.equal(await closed, 0, stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'args.json'), 'utf8')), ['record', 'opencode', '--', ...args]);
    const stored = readStoredTraceContext(db, runs, traceId)!;
    const summary = stored.context.summary as Record<string, any>;
    assert.equal(summary.events, 6);
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.shellFailures, 1);
    assert.equal(summary.notes[0].rule, 'demo');
    assert.equal(stored.context.finalization, 'finalized');
    assert.equal(stored.context.integrity, 'verified');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orchestration_jobs WHERE kind='trace_ingestion' AND state<>'completed'").get<{
        n: number;
    }>()!.n, 0);
    const prepared = await prepare(db, root, 'pipeline-first');
    assert.deepEqual(prepared.traceContext?.context, stored.context);
    assert.ok(Buffer.byteLength(JSON.stringify(prepared.traceContext)) <= 4096);
    const revision = db.prepare('SELECT context_json AS json FROM task_context_revisions WHERE run_id=? ORDER BY context_revision DESC LIMIT 1').get<{
        json: string;
    }>(prepared.run.runId)!;
    assert.deepEqual(JSON.parse(revision.json).traceContext, prepared.traceContext);
    await syncTraceStore(db, { captureCwd: cwd });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orchestration_jobs WHERE kind='memory_promotion'").get<{
        n: number;
    }>()!.n, 1);
    // A different worktree location never receives the same repository's trace implicitly.
    const other = path.join(root, 'other');
    await mkdir(other);
    execFileSync('git', ['init', '-q', other]);
    const empty = await prepare(db, other, 'pipeline-empty');
    assert.equal(empty.traceContext, undefined);
    assert.ok(!empty.warnings.some(x => x.code === 'TRACE_CONTEXT_REJECTED'));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
    test(`CLI forwards ${signal}, waits for child close, and retains its final trace`, async (t) => {
        if (process.platform === 'win32') {
            t.skip('POSIX signal exit convention');
            return;
        }
        const root = await realpath(await mkdtemp(path.join(tmpdir(), 'trace-signal-')));
        t.after(() => rm(root, { recursive: true, force: true }));
        const bin = path.join(root, 'bin');
        await mkdir(bin);
        const data = path.join(root, 'data');
        await mkdir(data);
        const fake = path.join(bin, 'orca');
        await writeFile(fake, `#!${process.execPath}
 const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto');
 const dir=p.join(process.cwd(),'.orca/runs/${traceId}');fs.mkdirSync(dir,{recursive:true});
 const line=(seq,type)=>JSON.stringify({seq,type,ts:'2026-09-07T00:00:00Z',mono_us:seq,turn:0,actor:'host'});
 const finish=()=>{const raw=line(0,'run.start')+'\\n'+line(1,'run.end')+'\\n';fs.writeFileSync(p.join(dir,'events.jsonl'),raw);fs.writeFileSync(p.join(dir,'manifest.json'),JSON.stringify({schema_version:'0.1.0',run_id:'${traceId}',counts:{events:2},integrity:{events_sha256:crypto.createHash('sha256').update(raw).digest('hex')}}));process.exit(0);};
 process.on('SIGINT',finish);process.on('SIGTERM',finish);fs.writeFileSync('ready','1');setInterval(()=>{},1000);
 `, { mode: 0o755 });
        const environment = { ...process.env, HOME: root, KIOKUKO_DATA_DIR: data, KIOKUKO_SKILL_DISCOVERY: 'off', PATH: `${bin}:${process.env.PATH}` };
        const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'trace', 'record', '--'], { cwd: root, env: environment, stdio: 'ignore' });
        const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        t.after(() => {
            if (child.exitCode === null)
                child.kill('SIGKILL');
        });
        await until(() => stat(path.join(root, 'ready')).then(() => true, () => false));
        child.kill(signal);
        assert.equal(await closed, signal === 'SIGINT' ? 130 : 143);
        const db = openConnection(getGlobalDatabasePath({ env: environment }));
        t.after(() => db.close());
        assert.equal(readStoredTraceContext(db, path.join(root, '.orca/runs'), traceId)?.context.finalization, 'finalized');
    });
test('parallel recordings synchronize both explicit store runs without selecting last', async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'trace-parallel-record-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin'), data = path.join(root, 'data');
    await mkdir(bin);
    await mkdir(data);
    await writeFile(path.join(bin, 'orca'), `#!${process.execPath}
 const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto');const id=process.argv.at(-1);const dir=p.join(process.cwd(),'.orca/runs',id);fs.mkdirSync(dir,{recursive:true});
 const raw=[{seq:0,type:'note',attrs:{rule:id}},{seq:1,type:'run.end',attrs:{}}].map(e=>JSON.stringify({...e,ts:'2026-09-07T00:00:00Z',mono_us:e.seq,turn:0,actor:'host'})).join('\\n')+'\\n';
 fs.writeFileSync(p.join(dir,'events.jsonl'),raw);fs.writeFileSync(p.join(dir,'manifest.json'),JSON.stringify({schema_version:'0.1.0',run_id:id,counts:{events:2},integrity:{events_sha256:crypto.createHash('sha256').update(raw).digest('hex')}}));
 `, { mode: 0o755 });
    const environment = { ...process.env, HOME: root, KIOKUKO_DATA_DIR: data, KIOKUKO_SKILL_DISCOVERY: 'off', PATH: `${bin}:${process.env.PATH}` };
    // Initialize before simultaneous processes so this case isolates recording/sync concurrency.
    const db = openConnection(getGlobalDatabasePath({ env: environment }));
    migrateDatabase(db);
    t.after(() => db.close());
    const ids = ['run_aaaaaa', 'run_bbbbbb'];
    const codes = await Promise.all(ids.map(id => new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'trace', 'record', '--', id], { cwd: root, env: environment, stdio: 'ignore' });
        child.once('error', reject);
        child.once('close', resolve);
    })));
    assert.deepEqual(codes, [0, 0]);
    for (const id of ids) {
        const context = readStoredTraceContext(db, path.join(root, '.orca/runs'), id)!.context;
        assert.equal(context.traceRunId, id);
        assert.equal(context.finalization, 'finalized');
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orchestration_jobs WHERE kind='memory_promotion'").get<{
        n: number;
    }>()!.n, 2);
});
test('wrapper preserves nonzero exit and distinguishes executable startup failure', async (t) => {
    const { recordTrace } = await import('../../src/trace/record.js');
    const { PassThrough } = await import('node:stream');
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'trace-record-failure-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const db = openConnection(path.join(root, 'db.sqlite'));
    migrateDatabase(db);
    t.after(() => db.close());
    const fake = path.join(root, 'orca');
    await writeFile(fake, `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o755 });
    const stderr = new PassThrough();
    let text = '';
    stderr.on('data', x => text += x);
    const failed = await recordTrace(db, { cwd: root, args: [], executable: fake, stderr });
    assert.equal(failed.exitCode, 7);
    const missing = await recordTrace(db, { cwd: root, args: [], executable: path.join(root, 'missing'), stderr });
    assert.equal(missing.exitCode, 1);
    assert.match(text, /could not be started/);
});
