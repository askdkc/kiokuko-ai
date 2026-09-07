import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, realpath, mkdir, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { syncTraceStore } from '../../src/trace/sync.js';
import { findSecretInValue } from '../../src/memory/secrets.js';
import { readTraceCursor } from '../../src/trace/ingest.js';
// Explicit opt-in: never download or update the user's global installation.
const executable = process.env.KIOKUKO_TEST_ORCA;
const pinnedVersion = '0.2.1';
test('real OrcaReplay 0.2.1 output seals a fake OpenCode run and imports with verified integrity', { skip: !executable ? 'Set KIOKUKO_TEST_ORCA to an installed OrcaReplay 0.2.1 executable' : false }, async (t) => {
    assert.equal(execFileSync(executable!, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), pinnedVersion);
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-real-contract-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', root]);
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}\nprocess.stdout.write('controlled fake OpenCode\\n');process.exit(7);\n`, { mode: 0o755 });
    const child = spawn(executable!, ['record', 'opencode', '--', 'run', 'local contract'], { cwd: root, env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', x => output += x);
    child.stderr.on('data', x => output += x);
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    const runs = path.join(root, '.orca/runs');
    const ids = (await readdir(runs)).filter(x => /^run_[0-9a-f]+$/.test(x));
    assert.equal(ids.length, 1, output);
    const manifest = JSON.parse(await readFile(path.join(runs, ids[0]!, 'manifest.json'), 'utf8'));
    assert.ok(manifest.ended_at);
    const events = (await readFile(path.join(runs, ids[0]!, 'events.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x));
    for (const event of events) {
        for (const [key, value] of Object.entries(event.attrs ?? {})) {
            const hit = findSecretInValue({ [key]: value });
            if (hit)
                t.diagnostic(`secret-shaped attribute type=${event.type}, key=${key}, kind=${hit.kind}`);
        }
    }
    const db = openConnection(path.join(root, 'db.sqlite'));
    t.after(() => db.close());
    migrateDatabase(db);
    const sync = await syncTraceStore(db, { captureCwd: root, timeoutMs: 5000 });
    assert.equal(sync.exitCode, 0, JSON.stringify(sync));
    const cursor = readTraceCursor(db, runs, ids[0]!)!;
    assert.equal(cursor.finalization, 'finalized');
    assert.equal(cursor.integrity, 'verified');
    assert.equal(cursor.aggregate?.exitCode, 7);
    t.diagnostic(`Orca ${pinnedVersion}: child exit=7, Orca CLI exit=${exit}, events=${cursor.aggregate?.events}, seq=${cursor.lastSeq}`);
});
