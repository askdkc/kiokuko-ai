import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { withImmediateTransaction } from '../../src/db/transaction.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { TaskRunService } from '../../src/task-run/service.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { captureProfileProbeContext, probeProfileMemory, profileHintsForRun } from '../../src/akinator/memory-probe.js';
import { backfillProfiles, resetProfileProjection, projectProfileInTransaction, readMemoryResolution } from '../../src/akinator/profile-memory-store.js';
import { readRunIntakeLink } from '../../src/akinator/store.js';
import { taggedEntries, getAkinatorStateService, getAkinatorContextService, startAkinatorService } from '../../src/akinator/service.js';
import { exportLedgerArchive, importLedgerArchive } from '../../src/ledger/archive.js';
import { purgeLedgerTarget } from '../../src/ledger/maintenance.js';
import { recordTaskContextRevision, readTaskContextRevisions } from '../../src/context/revisions.js';
import { prepareOpenCodeTask, answerOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { canonicalJson, type JsonObject } from '../../src/serialization/validate.js';
import type { TaskProfile } from '../../src/akinator/types.js';
import type { ProbeMode } from '../../src/akinator/memory-probe-types.js';

const now = '2026-09-13T00:00:00.000Z';
const missing: TaskProfile = { taskType: 'build', target: null, expected: null, constraints: null };
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-profile-probe-'));
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/alpha.ts'), 'export const alpha = 1;');
  const db = openConnection(':memory:');
  migrateDatabase(db);
  const project = await resolveProjectWorkspace(db, root);
  assert.ok(project);
  const previousMode = process.env.KIOKUKO_AKINATOR_MEMORY_MODE;
  process.env.KIOKUKO_AKINATOR_MEMORY_MODE = 'off';
  t.after(() => {
    if (previousMode === undefined) delete process.env.KIOKUKO_AKINATOR_MEMORY_MODE;
    else process.env.KIOKUKO_AKINATOR_MEMORY_MODE = previousMode;
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  let serial = 0;
  const source = (target = 'src/alpha.ts', completed = true) => {
    const run = new TaskRunService(db, { now: () => now }).createRun({ requestId: `source-${++serial}`, workspace: project.workspace,
      task: { title: 'Implement alpha', query: `Implement ${target}`, profileHints: { taskType: 'build', target, expected: 'Previous acceptance only', constraints: 'Previous constraint only' } }, metadata: {} });
    if (completed) new LedgerStore(db).updateRunStatus(run.runId, 'completed', now);
    return run;
  };
  const create = (mode: ProbeMode, requestId: string, hints = missing, task = 'Implement src/alpha.ts') => new TaskRunService(db, {
    now: () => now, profileMemory: captureProfileProbeContext(project, task, mode),
  }).createRun({ requestId, workspace: project.workspace, task: { title: task, query: task, profileHints: hints }, metadata: {} });
  return { root, db, project, source, create };
}

test('resolve adopts only the exact existing target, preserves sources, and replays after history/config changes', async t => {
  const f = await fixture(t);
  f.source();
  const run = f.create('resolve', 'request-1');
  assert.equal(run.taskProfile.target, 'src/alpha.ts');
  assert.equal(run.taskProfile.expected, null);
  assert.equal(run.taskProfile.constraints, null);
  assert.equal(readRunIntakeLink(f.db, { workspace: f.project.workspace, runId: run.runId }).profileSources.target, 'memory');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM akinator_answers').get<{ n: number }>()?.n, 0);
  f.source('src/other.ts');
  assert.deepEqual(f.create('off', 'request-1'), run);
  assert.throws(() => f.create('resolve', 'request-1', missing, 'Changed request'), { code: 'CONFLICT' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM akinator_memory_resolutions').get<{ n: number }>()?.n, 1);
});

test('off and shadow leave profiles untouched; complete inputs skip profile SQL', async t => {
  const f = await fixture(t);
  f.source();
  for (const mode of ['off', 'shadow'] as const) assert.equal(f.create(mode, mode).taskProfile.target, null);
  assert.equal(readMemoryResolution(f.db, f.create('off', 'off').runId)?.queryCount, 0);
  assert.ok(readMemoryResolution(f.db, f.create('shadow', 'shadow').runId)?.shadowAdoption);
  assert.equal(readMemoryResolution(f.db, f.create('shadow', 'shadow').runId)?.adopted, null);
  const full = { ...missing, target: 'explicit.ts', expected: 'Current acceptance' };
  const run = f.create('resolve', 'full', full);
  assert.deepEqual(run.taskProfile, full);
  assert.equal(readMemoryResolution(f.db, run.runId)?.queryCount, 0);
});

test('partial backfill, ambiguous targets, failed runs and memory-origin history never auto-adopt', async t => {
  const f = await fixture(t);
  const source = f.source();
  f.db.prepare('DELETE FROM akinator_profile_documents').run();
  const partial = f.create('resolve', 'partial');
  assert.equal(partial.taskProfile.target, null);
  assert.equal(readMemoryResolution(f.db, partial.runId)?.coverage, 'partial');
  let result;
  do { result = backfillProfiles(f.db, f.project.workspace, 1); } while (!result.complete);
  assert.equal(backfillProfiles(f.db, f.project.workspace).processed, 0);
  f.db.prepare("UPDATE run_intakes SET profile_sources_json = ? WHERE run_id = ?")
    .run(JSON.stringify({ target: 'memory' }), source.runId);
  withImmediateTransaction(f.db, () => projectProfileInTransaction(f.db, source.runId, now));
  assert.equal(f.create('resolve', 'memory-source').taskProfile.target, null);
  f.source('src/alpha.ts', false);
  assert.equal(f.create('resolve', 'active-source').taskProfile.target, null);
  f.source('src/alpha.ts'); f.source('src/other.ts');
  assert.equal(f.create('resolve', 'ambiguous').taskProfile.target, null);
});

test('path verification rejects absent, absolute, traversing and out-of-repository symlink targets', async t => {
  const f = await fixture(t);
  symlinkSync(tmpdir(), path.join(f.root, 'outside'));
  const context = captureProfileProbeContext(f.project, 'src/missing.ts ../outside.ts /tmp/outside.ts outside/test.ts', 'resolve');
  assert.equal(context.verifiedTargets.size, 0);
  f.source();
  for (const [index, task] of ['Implement alpha', 'Do not modify src/alpha.ts', 'Example src/alpha.ts', 'Fix src/alpha.ts and src/other.ts', 'Fix src/other.ts, not src/alpha.ts'].entries()) {
    assert.equal(f.create('resolve', `vague-${index}`, missing, task).taskProfile.target, null);
  }
});

test('candidate cap and malformed FTS input remain bounded without automatic adoption', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 65; i++) f.source();
  const run = f.create('resolve', 'cap');
  const resolution = readMemoryResolution(f.db, run.runId)!;
  assert.equal(run.taskProfile.target, null);
  assert.equal(resolution.truncated, true);
  assert.equal(resolution.scannedCandidates, 64);
  assert.ok(resolution.queryCount <= 3);
  for (const query of ['修正 「機能」', 'a OR " * NEAR(foo)', '語', 'x'.repeat(5000)]) {
    const outcome = probeProfileMemory(f.db, captureProfileProbeContext(f.project, query, 'suggest'), query, missing);
    assert.ok(outcome.resolution.scannedCandidates <= 64);
  }
});

test('projection FTS update, deletion and rebuild follow canonical profiles', async t => {
  const f = await fixture(t);
  const source = f.source();
  f.db.prepare('UPDATE akinator_sessions SET task_text = ? WHERE id = ?').run('独自検索対象', source.intakeSessionId);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM akinator_profile_documents').get<{ n: number }>()?.n, 0);
  backfillProfiles(f.db, f.project.workspace);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM akinator_profile_trigram WHERE akinator_profile_trigram MATCH '独自検索'").get<{ n: number }>()?.n, 1);
  f.db.exec("INSERT INTO akinator_profile_fts(akinator_profile_fts) VALUES ('rebuild'); INSERT INTO akinator_profile_trigram(akinator_profile_trigram) VALUES ('rebuild');");
  f.db.prepare('DELETE FROM ledger_runs WHERE run_id = ?').run(source.runId);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM akinator_profile_trigram WHERE akinator_profile_trigram MATCH '独自検索'").get<{ n: number }>()?.n, 0);
});

test('revision snapshots contain references only and never redisplay changed or purged candidate values', async t => {
  const f = await fixture(t);
  const source = f.source();
  const run = f.create('suggest', 'suggest');
  process.env.KIOKUKO_AKINATOR_MEMORY_MODE = 'suggest';
  const hints = profileHintsForRun(f.db, run.runId, missing)!;
  assert.equal(hints.candidates.find(item => item.field === 'expected')?.value, 'Previous acceptance only');
  const revision = recordTaskContextRevision(f.db, { runId: run.runId, context: { intake: { memoryHints: hints } } as unknown as JsonObject });
  assert.ok(!JSON.stringify(revision.context).includes('Previous acceptance only'));
  assert.ok(JSON.stringify(readTaskContextRevisions(f.db, { runId: run.runId })).includes('Previous acceptance only'));
  process.env.KIOKUKO_AKINATOR_MEMORY_MODE = 'off';
  assert.ok(!JSON.stringify(readTaskContextRevisions(f.db, { runId: run.runId })).includes('Previous acceptance only'));
  process.env.KIOKUKO_AKINATOR_MEMORY_MODE = 'suggest';
  purgeLedgerTarget(f.db, { workspace: f.project.workspace, targetType: 'run', targetId: source.runId,
    actor: 'operator', reason: 'test purge', purgeId: 'purge-source', createdAt: now, confirmed: true });
  assert.equal(profileHintsForRun(f.db, run.runId, missing)?.candidates.length, 0);
  assert.ok(!JSON.stringify(readTaskContextRevisions(f.db, { runId: run.runId })).includes('Previous acceptance only'));
  assert.equal(readMemoryResolution(f.db, run.runId)?.candidates.length, 0);
});

test('resolution storage failure rolls back the new run and intake', async t => {
  const f = await fixture(t);
  f.source();
  f.db.exec("CREATE TRIGGER reject_resolution BEFORE INSERT ON akinator_memory_resolutions BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get();
  assert.throws(() => f.create('resolve', 'rollback'), /injected/);
  assert.deepEqual(f.db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get(), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM akinator_sessions').get<{ n: number }>()?.n, 1);
});

test('archive roundtrip preserves memory source and resolution audit; projections rebuild explicitly', async t => {
  const f = await fixture(t);
  f.source();
  const run = f.create('resolve', 'archive', { ...missing, expected: 'Current acceptance' });
  const archive = exportLedgerArchive(f.db, { workspace: f.project.workspace });
  assert.equal(archive.counts.memoryResolutions, 1);
  const restored = openConnection(':memory:');
  try {
    migrateDatabase(restored);
    // Register the same authoritative repository mapping before using restored profile history.
    for (const table of ['repositories', 'repository_locations']) {
      for (const row of f.db.prepare(`SELECT * FROM ${table}`).all()) {
        const keys = Object.keys(row);
        restored.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row) as string[]);
      }
    }
    importLedgerArchive(restored, { content: archive.content });
    assert.deepEqual(readMemoryResolution(restored, run.runId), readMemoryResolution(f.db, run.runId));
    assert.equal(readRunIntakeLink(restored, { workspace: f.project.workspace, runId: run.runId }).profileSources.target, 'memory');
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM akinator_profile_documents').get<{ n: number }>()?.n, 0);
    assert.equal(backfillProfiles(restored, f.project.workspace).complete, true);
  } finally { restored.close(); }
});

test('OpenCode prepare/answer exposes advisory hints and preserves answers on retry', async t => {
  const f = await fixture(t);
  f.source();
  process.env.KIOKUKO_AKINATOR_MEMORY_MODE = 'suggest';
  const input = { requestId: 'mcp-1', task: 'Implement src/alpha.ts', cwd: f.root, capabilities: [], skillDiscoveryMode: 'off' as const };
  const prepared = await prepareOpenCodeTask(f.db, input);
  assert.equal(prepared.nextAction, 'proceed');
  assert.equal(prepared.continuationPolicy.codingAllowed, true);
  assert.equal(prepared.intake.memoryHints?.candidates.some(item => item.value === 'src/alpha.ts'), true);
  const answered = await answerOpenCodeTask(f.db, { runId: prepared.run.runId, sessionId: prepared.intake.sessionId,
    questionId: 'target', value: 'src/current.ts', cwd: f.root, capabilities: [], skillDiscoveryMode: 'off' });
  assert.equal(answered.intake.profile.target, 'src/current.ts');
  assert.equal((await prepareOpenCodeTask(f.db, input)).intake.profile.target, 'src/current.ts');
});

test('state-only reads perform no memory SQL and tag search never expands unrelated entries', async t => {
  const f = await fixture(t);
  const started = await startAkinatorService(f.db, { workspace: f.project.workspace, task: 'Implement unique-state-word', profileHints: { target: 'none', expected: 'none' } });
  const statements: string[] = [];
  const observed = { filePath: f.db.filePath, exec: f.db.exec.bind(f.db), close() {}, prepare(sql: string) { statements.push(sql); return f.db.prepare(sql); } };
  getAkinatorStateService(observed, { workspace: f.project.workspace, sessionId: started.session.id });
  assert.ok(statements.every(sql => !/\b(entries|entry_revisions|entry_revision_tags)\b/.test(sql)));
  for (let i = 0; i < 40; i++) recordEntry(f.db, { workspace: f.project.workspace, kind: 'fact', title: `unrelated ${i}`, body: 'irrelevant contents', tags: ['unrelated'] });
  const expected: ReturnType<typeof recordEntry>[] = [];
  for (let i = 0; i < 15; i++) expected.push(recordEntry(f.db, { workspace: f.project.workspace, kind: 'fact', title: `tagged ${i}`, body: 'tag contents', tags: ['bot:builder', 'skill:tdd'] }));
  statements.length = 0;
  const context = await getAkinatorContextService(observed, { workspace: f.project.workspace, sessionId: started.session.id });
  assert.equal(context.entries.length, 12);
  assert.equal(new Set(context.entries.map(item => item.id)).size, 12);
  assert.ok(context.entries.every(item => expected.some(entry => entry.id === item.id)));
  assert.ok(statements.some(sql => /FROM entry_revision_tags AS t/.test(sql)));
  assert.ok(!statements.some(sql => /FROM entries e\s+WHERE e.workspace = \?\s+ORDER BY/.test(sql)));
});


test('tag keyset crosses ineligible pages, deduplicates equal timestamps and ignores old revisions', async t => {
  const f = await fixture(t);
  const expected: string[] = [];
  for (let i = 0; i < 15; i++) expected.push(recordEntry(f.db, { workspace: f.project.workspace, kind: 'fact',
    title: `valid ${i}`, body: 'valid body', tags: ['bot:builder', 'skill:tdd'] }, { now }).id);
  const changed = recordEntry(f.db, { workspace: f.project.workspace, kind: 'fact', title: 'changed', body: 'old body', tags: ['bot:builder'] }, { now });
  updateCandidateEntry(f.db, { workspace: f.project.workspace, entryId: changed.id, expectedRevision: changed.revision, kind: 'fact', title: 'changed', body: 'new body', tags: ['unrelated'] });
  for (let i = 0; i < 40; i++) recordEntry(f.db, { workspace: f.project.workspace, kind: 'reference', status: 'candidate',
    title: `detached ${i}`, body: 'detached skill', scope: { retrievalScope: 'ecosystem' },
    provenance: { type: 'source_sync', reference: 'github:fixture/example' }, trustLevel: 'untrusted',
    tags: ['bot:builder', 'external:skill'], createdBy: 'kiokuko-source-sync', actor: 'kiokuko-source-sync',
  }, { now: '2026-09-13T01:00:00.000Z' });
  const result = taggedEntries(f.db, f.project.workspace, ['bot:builder', 'skill:tdd']);
  assert.deepEqual(result.map(entry => entry.id), expected.sort().slice(0, 12));
});

test('source updates suppress old hints and repository mismatches reject adoption', async t => {
  const f = await fixture(t);
  const source = f.source();
  const run = f.create('suggest', 'stale');
  process.env.KIOKUKO_AKINATOR_MEMORY_MODE = 'suggest';
  const hints = profileHintsForRun(f.db, run.runId, missing)!;
  recordTaskContextRevision(f.db, { runId: run.runId, context: { intake: { memoryHints: hints } } as unknown as JsonObject });
  f.db.prepare('UPDATE akinator_sessions SET profile_json = ? WHERE id = ?')
    .run(canonicalJson({ ...missing, target: 'src/changed.ts', expected: 'New acceptance' }), source.intakeSessionId);
  assert.equal(profileHintsForRun(f.db, run.runId, missing)?.candidates.length, 0);
  assert.ok(!JSON.stringify(readTaskContextRevisions(f.db, { runId: run.runId })).includes('Previous acceptance only'));
  const context = captureProfileProbeContext(f.project, 'Implement src/alpha.ts', 'resolve');
  assert.throws(() => probeProfileMemory(f.db, { ...context, repositoryId: 'repo_other' }, 'Implement src/alpha.ts', missing), { code: 'CONFLICT' });
  assert.throws(() => new TaskRunService(f.db, { profileMemory: { ...context, workspace: 'project:other' } })
    .createRun({ requestId: 'cross-workspace', workspace: f.project.workspace, task: { title: 'Implement alpha', query: 'Implement alpha', profileHints: missing }, metadata: {} }), { code: 'CONFLICT' });
});

test('optional path failures retain an unavailable diagnostic and never become empty successful searches', async t => {
  const f = await fixture(t);
  f.source();
  const context = captureProfileProbeContext(f.project, 'Implement src/alpha.ts', 'resolve');
  const result = probeProfileMemory(f.db, { ...context, unavailableReason: 'path_permission_denied' }, 'Implement src/alpha.ts', missing);
  assert.equal(result.profile.target, null);
  assert.equal(result.resolution.status, 'unavailable');
  assert.equal(result.resolution.warning, 'path_permission_denied');
  assert.equal(result.resolution.queryCount, 0);
  process.env.KIOKUKO_AKINATOR_MEMORY_MODE = 'invalid';
  const prepared = await prepareOpenCodeTask(f.db, { requestId: 'bad-config', task: 'Implement alpha', cwd: f.root, capabilities: [], skillDiscoveryMode: 'off' });
  assert.equal(prepared.continuationPolicy.codingAllowed, true);
  assert.equal(prepared.intake.memoryHints, undefined);
  assert.ok(prepared.warnings.some(item => item.code === 'PROFILE_MEMORY_CONFIG_INVALID'));
});


test('concurrent processes reuse one initial resolution and reopening preserves it', async t => {
  const f = await fixture(t);
  const databasePath = path.join(f.root, 'concurrent.sqlite');
  const disk = openConnection(databasePath);
  migrateDatabase(disk);
  const project = await resolveProjectWorkspace(disk, f.root);
  assert.ok(project);
  const prior = new TaskRunService(disk, { now: () => now }).createRun({ requestId: 'prior', workspace: project.workspace,
    task: { title: 'Implement alpha', query: 'Implement src/alpha.ts', profileHints: { ...missing, target: 'src/alpha.ts', expected: 'Previous' } }, metadata: {} });
  new LedgerStore(disk).updateRunStatus(prior.runId, 'completed', now);
  disk.close();
  const script = `
    import { openConnection } from './src/db/connection.ts';
    import { TaskRunService } from './src/task-run/service.ts';
    import { captureProfileProbeContext } from './src/akinator/memory-probe.ts';
    const database = openConnection(process.argv[1]);
    const project = JSON.parse(process.argv[2]);
    try {
      const service = new TaskRunService(database, { profileMemory: captureProfileProbeContext(project, 'Implement src/alpha.ts', 'resolve') });
      const run = service.createRun({ requestId: 'same-concurrent-request', workspace: project.workspace,
        task: { title: 'Implement alpha', query: 'Implement src/alpha.ts', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } }, metadata: {} });
      process.stdout.write(JSON.stringify(run));
    } finally { database.close(); }
  `;
  const execute = promisify(execFile);
  const results = await Promise.all([0, 1].map(() => execute(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, databasePath, JSON.stringify(project)], { cwd: process.cwd() })));
  assert.deepEqual(JSON.parse(results[0]!.stdout), JSON.parse(results[1]!.stdout));
  const run = JSON.parse(results[0]!.stdout);
  const reopened = openConnection(databasePath);
  try {
    assert.equal(readMemoryResolution(reopened, run.runId)?.adopted?.runId, prior.runId);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM akinator_memory_resolutions').get<{ n: number }>()?.n, 1);
    assert.equal(run.taskProfile.target, 'src/alpha.ts');
  } finally { reopened.close(); }
});


test('rebuild resets completed coverage and mismatched source labels cannot prove user provenance', async t => {
  const f = await fixture(t);
  const source = f.source();
  backfillProfiles(f.db, f.project.workspace);
  resetProfileProjection(f.db, f.project.workspace);
  assert.equal(f.create('resolve', 'during-rebuild').taskProfile.target, null);
  assert.equal(backfillProfiles(f.db, f.project.workspace).complete, true);
  f.db.prepare('UPDATE run_intakes SET profile_sources_json = ? WHERE run_id = ?').run(canonicalJson({ target: 'user_answer' }), source.runId);
  // A forged label has no matching canonical answer, even after a fresh projection.
  assert.equal(backfillProfiles(f.db, f.project.workspace).complete, true);
  assert.equal(f.create('resolve', 'forged-source').taskProfile.target, null);
});


test('a completed canonical target answer is eligible without fabricating a new answer', async t => {
  const f = await fixture(t);
  const service = new TaskRunService(f.db, { now: () => now });
  const prior = service.createRun({ requestId: 'answered-source', workspace: f.project.workspace,
    task: { title: 'Implement alpha', query: 'Implement src/alpha.ts', profileHints: { ...missing, expected: 'Previous acceptance' } }, metadata: {} });
  service.answerIntake({ requestId: 'answer-target', runId: prior.runId, questionId: 'target', value: 'src/alpha.ts' });
  new LedgerStore(f.db).updateRunStatus(prior.runId, 'completed', now);
  const run = f.create('resolve', 'use-answered-source');
  assert.equal(run.taskProfile.target, 'src/alpha.ts');
  assert.equal(readMemoryResolution(f.db, run.runId)?.adopted?.runId, prior.runId);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM akinator_answers WHERE session_id = ?').get<{ n: number }>(run.intakeSessionId)?.n, 0);
});
