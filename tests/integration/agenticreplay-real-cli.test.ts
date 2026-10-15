import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import semver from 'semver';
import { readFileSync } from 'node:fs';
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
const executable = process.env.AGENTICREPLAY_BIN ?? process.env.KIOKUKO_TEST_AGENTICREPLAY;
test('real compatible AgenticReplay output seals a fake OpenCode run and imports with verified integrity', { skip: !executable ? 'Set KIOKUKO_TEST_AGENTICREPLAY to an installed AgenticReplay executable' : false }, async (t) => {
    const packageManifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const range: unknown = packageManifest.devDependencies?.agenticreplay;
    assert.ok(typeof range === 'string' && semver.validRange(range), 'AgenticReplay compatibility range is missing');
    const recorderVersion = execFileSync(executable!, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    assert.ok(semver.satisfies(recorderVersion, range), `AgenticReplay ${recorderVersion} does not satisfy ${range}`);
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agenticreplay-real-contract-')));
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
    const runs = path.join(root, '.agenticreplay/runs');
    const directories = (await readdir(runs, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
    assert.equal(directories.length, 1, output);
    const runDirectory = path.join(runs, directories[0]!);
    const manifest = JSON.parse(await readFile(path.join(runDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.agenticreplay_version, recorderVersion);
    assert.match(manifest.run_id, /^run_[0-9a-f]{6,32}$/u);
    assert.ok(manifest.ended_at, output);
    const events = (await readFile(path.join(runDirectory, 'events.jsonl'), 'utf8')).trim().split('\n').map(x => JSON.parse(x));
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
    const cursor = readTraceCursor(db, runs, manifest.run_id)!;
    assert.equal(cursor.finalization, 'finalized');
    assert.equal(cursor.integrity, 'verified');
    assert.equal(cursor.aggregate?.exitCode, 7);
    t.diagnostic(`AgenticReplay ${recorderVersion}: child exit=7, AgenticReplay CLI exit=${exit}, events=${cursor.aggregate?.events}, seq=${cursor.lastSeq}`);
});
