import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { observeMemory, memoryContext, improveMemory } from '../../src/memory/learning.js';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { readEntry } from '../../src/memory/entries.js';
import { createOrchestrationWorker } from '../../src/orchestration/worker.js';
import { startHttpServer } from '../../src/server/http.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeTrace, traceLine, traceId } from '../fixtures/agentic-trace.js';
import { syncTraceStore } from '../../src/trace/sync.js';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';
import { pluginContextFixture } from '../fixtures/opencode-v2-plugin.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';
import { purgeEntry } from '../../src/commands/purge.js';

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kiokuko-learning-store-'));
  let database: ReturnType<typeof openConnection> | undefined;
  t.after(() => {
    try { database?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  const root = path.join(directory, 'repo'), other = path.join(directory, 'other');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['init', '-q', other]);
  const databasePath = path.join(directory, 'memory.sqlite');
  database = openConnection(databasePath); migrateDatabase(database);
  const observation = { cwd: root, eventId: 'evt_1', sessionId: 'session_1', kind: 'complaint',
    summary: 'Migration startup still fails after update.', issue: 'Migration startup fails.', prevention: 'Test existing migration startup before reporting completion.',
    tags: ['migration', 'startup'], outcome: 'unknown', verification: 'unknown', actions: [],
    source: { producer: 'kiokuko-ai', runId: 'session_1', eventIds: ['event-1'] } };
  return { root, other, database, databasePath, observation };
}

test('common v1 zero revision, higher correction, summaryless withdrawal and 24-hour handoff are enforced', async t => {
  const f = fixture(t);
  const event = { cwd: f.root, eventId: 'handoff_v1', sessionId: 'session_v1', kind: 'model_switch',
    summary: 'Public work is pending.', source: { producer: 'codex' } };
  assert.equal((await observeMemory(f.database, event)).sourceRevision, 0);
  const fresh = await memoryContext(f.database, { cwd: f.root, sessionId: 'session_v1' });
  assert.equal(fresh.entries.length, 0); assert.equal(fresh.handoff?.sessionId, 'session_v1');
  f.database.prepare('UPDATE learning_observations SET created_at=? WHERE event_id=?')
    .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), event.eventId);
  assert.equal((await memoryContext(f.database, { cwd: f.root, sessionId: 'session_v1' })).handoff, null);
  assert.equal((await observeMemory(f.database, { ...event, summary: 'A corrected handoff.', source: { ...event.source, revision: 7 } })).recorded, true);
  assert.equal((await observeMemory(f.database, { cwd: f.root, eventId: event.eventId, sessionId: event.sessionId,
    kind: event.kind, source: { ...event.source, revision: 8, tombstone: true } })).recorded, true);
  assert.equal((await memoryContext(f.database, { cwd: f.root, sessionId: event.sessionId })).handoff, null);
});

test('SQLite observation replay, conflicting identity, tagged recall and new-task delivery use the same repository', async t => {
  const f = fixture(t);
  const first = await observeMemory(f.database, f.observation);
  assert.equal(first.recorded, true);
  assert.equal((await observeMemory(f.database, f.observation)).duplicate, true);
  const conflict = await observeMemory(f.database, { ...f.observation, summary: 'changed without a revision' });
  assert.equal(conflict.recorded, false); assert.equal(conflict.workMayContinue, true);
  assert.deepEqual(conflict.diagnostics, ['CONFLICT']);
  const recall = await memoryContext(f.database, { cwd: f.root, query: 'startup', tags: ['migration'], sessionId: 'session_1' });
  assert.equal(recall.items.length, 1); assert.equal(recall.handoff, null);
  assert.equal((await memoryContext(f.database, { cwd: f.root, tags: ['unrelated'] })).items.length, 0);
  assert.equal((await memoryContext(f.database, { cwd: f.other, query: 'startup' })).items.length, 0);
  const reopened = openConnection(f.databasePath);
  try { assert.equal((await memoryContext(reopened, { cwd: f.root, sessionId: 'new_session' })).handoff, null); }
  finally { reopened.close(); }
  const task = await prepareOpenCodeTask(f.database, { cwd: f.root, requestId: 'next_task', task: 'Fix migration startup code',
    profileHints: { taskType: 'debug', target: 'migration startup code', expected: 'migration startup works after update', constraints: null },
    capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }], skillDiscoveryMode: 'off' });
  assert.ok(task.context?.items.some(item => item.entryId === recall.items[0]?.entryId));
  assert.equal(task.continuationPolicy.codingAllowed, true);
});

test('feedback revision and tombstone retain evidence but remove withdrawn advice and derived Global candidates immediately', async t => {
  const f = fixture(t);
  assert.equal((await observeMemory(f.database, f.observation)).recorded, true);
  const old = (await memoryContext(f.database, { cwd: f.root })).items[0]!;
  const improved = await improveMemory(f.database, { cwd: f.root });
  assert.equal(improved.recorded, true);
  assert.equal((await memoryContext(f.database, { cwd: f.root })).principles?.length, 1);
  const globalId = f.database.prepare("SELECT entry_id FROM learning_principles WHERE workspace='global'").get<{ entry_id: string }>()!.entry_id;
  const edited = { ...f.observation, issue: 'Correction: startup actually succeeds.', summary: 'The earlier failure report was mistaken.',
    source: { ...f.observation.source, revision: 2 } };
  assert.equal((await observeMemory(f.database, edited)).recorded, true);
  assert.equal(readEntry(f.database, { workspace: 'global', entryId: globalId }).status, 'superseded');
  const project = f.database.prepare('SELECT workspace FROM learning_observations LIMIT 1').get<{ workspace: string }>()!.workspace;
  assert.equal(readEntry(f.database, { workspace: project, entryId: old.entryId! }).revision, 2);
  assert.equal((await memoryContext(f.database, { cwd: f.root })).items[0]?.entryId, old.entryId);
  assert.equal((await observeMemory(f.database, { ...edited, source: { ...edited.source, revision: 3, tombstone: true } })).recorded, true);
  assert.equal((await memoryContext(f.database, { cwd: f.root })).items.length, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM learning_observations').get<{ n: number }>()!.n, 3);
  assert.equal((await observeMemory(f.database, f.observation)).recorded, false);
});

test('confirmed entry purge retracts observation recall while preserving source tombstone history', async t => {
  const f = fixture(t);
  await observeMemory(f.database, f.observation);
  const context = await memoryContext(f.database, { cwd: f.root });
  const workspace = f.database.prepare('SELECT workspace FROM learning_observations LIMIT 1').get<{ workspace: string }>()!.workspace;
  purgeEntry(f.database, { workspace, entryId: context.items[0]!.entryId!, confirm: true });
  assert.equal((await memoryContext(f.database, { cwd: f.root })).items.length, 0);
  assert.equal(f.database.prepare('SELECT tombstone FROM learning_observations ORDER BY source_revision DESC LIMIT 1').get<{ tombstone: number }>()!.tombstone, 1);
});

test('corrupted stored observation cannot become advice or a Global principle', async t => {
  const f = fixture(t);
  await observeMemory(f.database, f.observation);
  f.database.prepare("UPDATE learning_observations SET observation_json=json_set(observation_json,'$.summary','tampered evidence')").run();
  const context = await memoryContext(f.database, { cwd: f.root });
  assert.equal(context.accepted, false); assert.deepEqual(context.items, []);
  assert.equal(context.workMayContinue, true);
  assert.equal((await improveMemory(f.database, { cwd: f.root })).recorded, false);
});

test('independent repeated completions create low-confidence candidates without promoting silence to verification', async t => {
  const f = fixture(t);
  for (const n of [1, 2]) assert.equal((await observeMemory(f.database, { cwd: f.root, eventId: `complete-${n}`, sessionId: `task-${n}`,
    kind: 'completion', summary: 'Public completion with no reported tests.', outcome: 'passed',
    actions: [{ kind: 'inspect', outcome: 'passed', summary: 'Read current implementation.' }, { kind: 'edit', outcome: 'unknown', summary: 'Applied a fix.' }],
    source: { producer: 'kiokuko-ai', runId: `task-${n}`, eventIds: [`complete-${n}`] } })).recorded, true);
  const improved = await improveMemory(f.database, { cwd: f.root });
  assert.ok('routines' in improved); assert.equal(improved.routines, 1);
  const row = f.database.prepare("SELECT workspace,entry_id FROM learning_principles WHERE workspace!='global'").get<{ workspace: string; entry_id: string }>()!;
  const entry = readEntry(f.database, { workspace: row.workspace, entryId: row.entry_id });
  assert.equal(entry.status, 'candidate'); assert.equal(entry.trustLevel, 'untrusted'); assert.equal(entry.confidence, 0.3);
  assert.match(entry.body, /silence is not success evidence/);
  const routineContext = await memoryContext(f.database, { cwd: f.root, tags: ['learning-routine'] });
  assert.ok(routineContext.entries.some(item => item.entryId === entry.id));
  assert.equal(routineContext.entries.find(item => item.entryId === entry.id)?.verification, 'unknown');
  assert.ok((await memoryContext(f.database, { cwd: f.root, tags: ['learning-principle'] })).entries.some(item => item.scope === 'global'));
  assert.equal((await improveMemory(f.database, { cwd: f.root })).recorded, false);
  await observeMemory(f.database, { ...f.observation, eventId: 'late_complaint', sessionId: 'task-1',
    source: { ...f.observation.source, runId: 'task-1' } });
  assert.equal(readEntry(f.database, { workspace: row.workspace, entryId: row.entry_id }).status, 'superseded');
});

test('secret input fails without persistence and project personal text is excluded from fixed Global principles', async t => {
  const f = fixture(t);
  const secret = await observeMemory(f.database, { ...f.observation, summary: 'password=reallysecretpassword123' });
  assert.equal(secret.recorded, false); assert.equal(secret.workMayContinue, true);
  for (const summary of ['Cookie: session=private-session-cookie', 'Authorization: Basic cHJpdmF0ZS1hdXRo']) {
    assert.equal((await observeMemory(f.database, { ...f.observation, summary })).recorded, false);
  }
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM learning_observations').get<{ n: number }>()!.n, 0);
  assert.equal((await observeMemory(f.database, { ...f.observation, summary: 'Contact private-person@example.test about /Users/private/work and the startup failure.' })).recorded, true);
  await improveMemory(f.database, { cwd: f.root });
  const row = f.database.prepare("SELECT entry_id FROM learning_principles WHERE workspace='global'").get<{ entry_id: string }>()!;
  const entry = readEntry(f.database, { workspace: 'global', entryId: row.entry_id });
  assert.doesNotMatch(JSON.stringify(entry), /private-person|\/Users\/private|startup failure/);
  assert.equal(entry.status, 'candidate');
});

test('the existing background worker extracts Global principles from queued observations', async t => {
  const f = fixture(t);
  await observeMemory(f.database, f.observation);
  const worker = createOrchestrationWorker({ database: f.database, intervalMs: 10 });
  worker.start();
  try {
    const deadline = Date.now() + 3000;
    while (!f.database.prepare("SELECT 1 FROM learning_principles WHERE workspace='global'").get() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(f.database.prepare("SELECT 1 FROM learning_principles WHERE workspace='global'").get());
  } finally { await worker.close(); }
});

test('real local HTTP endpoints enforce existing Bearer authorization and persist SQLite receipts', async t => {
  const f = fixture(t);
  const token = 'c'.repeat(64);
  const server = await startHttpServer({ databasePath: f.databasePath, runtimeDirectory: path.join(f.root, 'isolated-runtime'),
    host: '127.0.0.1', port: 0, capabilityToken: token });
  const post = (name: string, input: unknown, authorized = true) => fetch(`${server.url}/api/memory/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input),
  });
  try {
    assert.equal((await post('observe', f.observation, false)).status, 401);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM learning_observations').get<{ n: number }>()!.n, 0);
    const saved = await (await post('observe', f.observation)).json();
    assert.equal(saved.recorded, true); assert.equal(saved.workMayContinue, true);
    await post('observe', { ...f.observation, eventId: 'model-switch', kind: 'model_switch', tags: ['handoff'] });
    const context = await (await post('context', { cwd: f.root, sessionId: 'session_1' })).json();
    assert.equal(context.items.length, 1); assert.equal(context.handoff.sessionId, 'session_1');
    const conflict = await (await post('observe', { ...f.observation, summary: 'conflicting reuse' })).json();
    assert.equal(conflict.recorded, false); assert.equal(conflict.workMayContinue, true);
    assert.equal((await (await post('improve', { cwd: f.root })).json()).accepted, true);
  } finally { await server.close(); }
});

test('MCP exposes the same local observation, context and improvement semantics', async t => {
  const f = fixture(t);
  const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.root });
  const client = new Client({ name: 'opencode', version: '2.0.18' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const saved = await client.callTool({ name: 'memory_observe', arguments: f.observation });
    assert.equal(saved.isError, undefined); assert.equal((saved.structuredContent as Record<string, unknown>)?.recorded, true);
    const recalled = await client.callTool({ name: 'memory_context', arguments: { cwd: f.root, tags: ['migration'] } });
    assert.equal(((recalled.structuredContent as Record<string, unknown>)?.items as unknown[]).length, 1);
    const improved = await client.callTool({ name: 'memory_improve', arguments: { cwd: f.root } });
    assert.equal((improved.structuredContent as Record<string, unknown>)?.workMayContinue, true);
  } finally { await client.close(); await server.close(); }
});

test('ordinary local CLI works with an isolated database and requires no external core service', async t => {
  const f = fixture(t);
  const environment = { ...process.env, KIOKUKO_DATA_DIR: path.join(f.root, 'cli-data'), KIOKUKO_SKILL_DISCOVERY: 'off' };
  const cli = process.env.KIOKUKO_TEST_BUILT_CLI ?? path.resolve('src/bin/kiokuko.ts');
  const run = (operation: string, input: unknown) => JSON.parse(execFileSync(process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, 'memory', operation, '--input-json', '-'], { cwd: f.root, env: environment,
      input: JSON.stringify(input), encoding: 'utf8' }));
  assert.equal(run('observe', f.observation).recorded, true);
  assert.equal(run('observe', f.observation).duplicate, true);
  assert.equal(run('context', { cwd: f.root, sessionId: 'session_1' }).handoff, null);
  assert.equal(run('improve', { cwd: f.root }).accepted, true);
});

test('praise uses the exact ingested AgenticReplay source without guessing a latest run', async t => {
  const f = fixture(t);
  await writeTrace(path.join(f.root, '.agenticreplay/runs'), [traceLine(0, 'run.start'),
    traceLine(1, 'tool.call', { name: 'read' }), traceLine(2, 'run.end', { exit_code: 0 })]);
  assert.equal((await syncTraceStore(f.database, { captureCwd: f.root, traceRunId: traceId, timeoutMs: 5000 })).exitCode, 0);
  const praise = { ...f.observation, kind: 'praise', summary: 'Thank you, that worked.',
    source: { producer: 'agenticreplay', runId: traceId, eventIds: ['seq:1'] } };
  assert.equal((await observeMemory(f.database, praise)).recorded, true);
  const context = await memoryContext(f.database, { cwd: f.root });
  const workspace = f.database.prepare('SELECT workspace FROM learning_observations LIMIT 1').get<{ workspace: string }>()!.workspace;
  const entry = readEntry(f.database, { workspace, entryId: context.items[0]!.entryId! });
  assert.match(entry.body, /AgenticReplay recorded action\/result summary/);
  assert.match(entry.body, /"read"/);
  assert.equal(entry.confidence, 0.3);
  const previousDirectory = process.env.AGENTICREPLAY_RUN_DIR;
  try {
    process.env.AGENTICREPLAY_RUN_DIR = path.join(f.root, '.agenticreplay/runs', traceId);
    const nativePraise = { ...praise, eventId: 'native-praise', source: { producer: 'kiokuko-ai', runId: 'host-session', eventIds: ['host-message'] } };
    assert.equal((await observeMemory(f.database, nativePraise)).recorded, true);
    const native = (await memoryContext(f.database, { cwd: f.root })).items.find(item => item.source.eventId === 'native-praise')!;
    assert.match(readEntry(f.database, { workspace, entryId: native.entryId }).body, /source run_abcdef123456/);
  } finally {
    if (previousDirectory === undefined) delete process.env.AGENTICREPLAY_RUN_DIR; else process.env.AGENTICREPLAY_RUN_DIR = previousDirectory;
  }
  assert.equal((await observeMemory(f.database, { ...praise, eventId: 'missing-trace', source: { ...praise.source, runId: 'run_00000000' } })).recorded, false);
  assert.equal((await observeMemory(f.database, { ...praise, cwd: f.other, eventId: 'wrong-repo' })).recorded, false);
  const privateTraceId = 'run_abcdef999999';
  await writeTrace(path.join(f.root, '.agenticreplay/runs'), [traceLine(0, 'run.start'),
    traceLine(1, 'note', { rule: 'private', detail: 'Cookie: private-session-value' }), traceLine(2, 'run.end', { exit_code: 0 })], '0.4.0', privateTraceId);
  await syncTraceStore(f.database, { captureCwd: f.root, traceRunId: privateTraceId, timeoutMs: 5000 });
  const unsafe = await observeMemory(f.database, { ...praise, eventId: 'private-trace', source: { ...praise.source, runId: privateTraceId } });
  assert.equal(unsafe.recorded, false); assert.equal(unsafe.workMayContinue, true);
});

test('shipped OpenCode hooks cross the pinned CLI, persist SQLite and feed a new session without a core service', async t => {
  const f = fixture(t);
  const data = path.join(f.root, 'host-data');
  const cli = path.resolve('dist/bin/kiokuko.js');
  const runtimeGlobal = globalThis as typeof globalThis & { Bun?: unknown };
  const original = runtimeGlobal.Bun;
  runtimeGlobal.Bun = { spawn(argv: string[], options: { cwd: string }) {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd,
      env: { ...process.env, KIOKUKO_DATA_DIR: data, KIOKUKO_SKILL_DISCOVERY: 'off' }, stdio: 'pipe' });
    return { stdin: { write: (text: string) => { child.stdin.write(text); }, end: () => { child.stdin.end(); } },
      stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr),
      exited: new Promise<number>(resolve => { child.once('exit', code => resolve(code ?? 1)); child.once('error', () => resolve(1)); }),
      kill: () => { child.kill(); } };
  } };
  const fixtureHost = pluginContextFixture(f.root);
  Object.assign(fixtureHost.ctx, { options: { protocolVersion: 1, packageVersion: PACKAGE_VERSION, nodeExecutable: process.execPath, cliScript: cli } });
  fixtureHost.ctx.session.context = async () => [{ type: 'assistant', content: [{ type: 'text', text: 'Migration startup remains broken. A regression is pending.' }] }] as never;
  const cleanup = await KiokukoPlugin.setup(fixtureHost.ctx);
  const until = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 8000;
    while (!await condition()) { if (Date.now() > deadline) throw new Error('Host learning timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  let observed: ReturnType<typeof openConnection> | undefined;
  try {
    await fixtureHost.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'msg_failure', prompt: { text: 'まだ起動失敗する。migration startupを確認して。' } } as never);
    await until(async () => {
      try { observed ??= openConnection(path.join(data, 'kiokuko-ai.sqlite'), { readOnly: true });
        return !!observed.prepare('SELECT 1 FROM learning_observations WHERE event_id=?').get('msg_failure'); }
      catch { observed?.close(); observed = undefined; return false; }
    });
    assert.equal(observed!.prepare('SELECT count(*) AS n FROM learning_observations WHERE event_id=?').get<{ n: number }>('msg_failure')!.n, 1);
    fixtureHost.ctx.session.get = async ({ sessionID }) => ({ id: sessionID, location: { directory: f.root }, projectID: 'prj' }) as never;
    await fixtureHost.hooks.get('session:prompt')!({ sessionID: 'ses_new', messageID: 'msg_new', prompt: { text: '別の新機能を追加して' } } as never);
    const system: Array<{ type: string; text: string }> = [];
    await until(async () => { system.length = 0;
      await fixtureHost.hooks.get('session:context')!({ sessionID: 'ses_new', system, model: { providerID: 'p', id: 'new' } } as never);
      return system.some(part => part.text.includes('msg_failure')); });
    assert.match(JSON.stringify(system), /まだ起動失敗/);
    assert.doesNotMatch(JSON.stringify(system), /"sessionId":"ses_1"/);
    fixtureHost.emit({ id: 'evt_compact', type: 'session.compaction.ended', location: { directory: f.root },
      data: { sessionID: 'ses_new', text: 'Migration correction pending; check existing startup before reporting completion.' } });
    await until(() => !!observed!.prepare('SELECT 1 FROM learning_observations WHERE event_id=?').get('evt_compact'));
    fixtureHost.emit({ id: 'evt_model', type: 'session.model.selected', location: { directory: f.root },
      data: { sessionID: 'ses_new', previous: { providerID: 'p', id: 'old' }, model: { providerID: 'p', id: 'new' } } });
    await until(() => !!observed!.prepare('SELECT 1 FROM learning_observations WHERE event_id=?').get('evt_model'));
    const switched = JSON.parse(observed!.prepare('SELECT observation_json FROM learning_observations WHERE event_id=?').get<{ observation_json: string }>('evt_model')!.observation_json);
    assert.equal(switched.fromModel, 'p/old'); assert.equal(switched.toModel, 'p/new'); assert.equal(switched.sessionId, 'ses_new');
  } finally { await cleanup?.(); observed?.close(); runtimeGlobal.Bun = original; }
});
