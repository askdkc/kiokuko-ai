import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareOpenCodeTask } from '../../src/akinator/opencode-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { readTaskContextRevisions, recordTaskContextRevision } from '../../src/context/revisions.js';
import { openConnection } from '../../src/db/connection.js';
import { publishPlanArtifact } from '../../src/enno-oduno/plan-artifact.js';
import { claimEnnoWork, reportEnnoWork, submitEnnoPlan, submitOdunoIdeal } from '../../src/enno-oduno/service.js';
import { appendEnnoEventInTransaction } from '../../src/enno-oduno/store.js';
import { captureCompactionBoundary, processCompactionMeditationJob, queueCompactionMeditation } from '../../src/meditation/compaction.js';
import {
  claimOrchestrationJobs,
  completeOrchestrationJob,
  enqueueOrchestrationJob,
  failOrchestrationJob,
} from '../../src/orchestration/jobs.js';

const capabilities = [
  { kind: 'skill', name: 'kiokuko-soul', description: 'Memory-first task router.' },
  { kind: 'skill', name: 'kiokuko-enno-oduno', description: 'Revision-bound orchestration.' },
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-nonblocking-repo-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture","type":"module"}\n');
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-nonblocking-data-'));
  const databasePath = path.join(dataDirectory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  return { root, dataDirectory, database: openConnection(databasePath) };
}

async function prepare(database: ReturnType<typeof openConnection>, root: string, requestId: string) {
  return prepareOpenCodeTask(database, {
    requestId,
    cwd: root,
    task: 'Document and verify the fixture behavior',
    profileHints: { taskType: 'build', target: 'docs/fixture.md', expected: 'documentation is verified', constraints: null },
    capabilities,
    client: { kind: 'opencode', sessionId: `session-${requestId}` },
    skillDiscoveryMode: 'official',
    fetchImpl: async () => {
      throw new Error('task_prepare must not fetch external Skills');
    },
  });
}

function idealize(database: ReturnType<typeof openConnection>, prepared: Awaited<ReturnType<typeof prepare>>) {
  return submitOdunoIdeal(database, {
    runId: prepared.run.runId,
    workspace: prepared.project.workspace,
    orchestrationId: prepared.intake.sessionId,
    expectedRevision: 1,
    idempotencyKey: `ideal-${prepared.run.runId}`,
    ideal: {
      objective: 'Produce verified documentation without blocking on optional enrichment',
      principles: ['Use current repository evidence and preserve safety boundaries'],
      skillContributions: prepared.skillDiscovery.selected.map((skill) => ({
        skillName: skill.name,
        contribution: `Treat ${skill.name} as reference-only guidance`,
      })),
      successSignals: ['The focused verifier passes'],
    },
  });
}

test('task_prepare returns lexical context and queues enrichment without external fetch', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepare(database, root, 'hot-path');
    assert.equal(prepared.nextAction, 'proceed');
    assert.deepEqual(prepared.continuationPolicy, { codingAllowed: true, blockingReason: null });
    assert.equal(prepared.contextRevision, 1);
    assert.ok(prepared.context);
    const jobs = database.prepare(`
      SELECT kind, state FROM orchestration_jobs WHERE run_id = ? ORDER BY kind
    `).all<{ kind: string; state: string }>(prepared.run.runId);
    assert.ok(jobs.some((job) => job.kind === 'semantic_context' && job.state === 'pending'));
    assert.ok(jobs.every((job) => job.state === 'pending'));
  } finally {
    database.close();
  }
});

test('late context revisions are immutable, idempotent, and cursor-readable', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepare(database, root, 'late-context');
    const late = recordTaskContextRevision(database, {
      runId: prepared.run.runId,
      context: { kind: 'semantic_context', items: [{ id: 'memory-1', score: 0.75 }] },
    });
    assert.equal(late.contextRevision, prepared.contextRevision + 1);
    assert.equal(recordTaskContextRevision(database, {
      runId: prepared.run.runId,
      context: { kind: 'semantic_context', items: [{ id: 'memory-1', score: 0.75 }] },
    }).contextRevision, late.contextRevision);
    assert.deepEqual(
      readTaskContextRevisions(database, { runId: prepared.run.runId, afterContextRevision: prepared.contextRevision })
        .map((revision) => revision.contextRevision),
      [late.contextRevision],
    );
  } finally {
    database.close();
  }
});

test('Zenki plan is published only under the Kiokuko data directory', async () => {
  const { root, dataDirectory, database } = await fixture();
  try {
    const prepared = await prepare(database, root, 'plan-artifact');
    idealize(database, prepared);
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    const planned = await submitEnnoPlan(database, {
      ...identity,
      expectedRevision: 1,
      idempotencyKey: 'plan-artifact-submit',
      scope: ['docs/fixture.md'],
      exclusions: [],
      acceptanceCriteria: [{ id: 'documented', description: 'documentation is verified' }],
      workPlan: {
        objective: 'Document the fixture',
        units: [{
          id: 'docs', objective: 'Write the fixture documentation', scope: ['docs/fixture.md'], dependencies: [],
          routes: ['docs'], skillNames: [], expertRefs: [], acceptanceCriteria: ['documentation is verified'],
          focusedVerifiers: [], resourceClaims: [{ key: 'docs/fixture.md', access: 'write' }],
          isolationPreference: 'shared_serial', outputContract: 'Return changed paths and verification evidence.',
        }],
      },
      skillRequirements: [],
      finalVerifiers: [{ id: 'pass', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5_000 }],
      maxAttempts: 1,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'explicit_user',
        skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(planned.ennoOduno.planArtifact?.state, 'pending');
    const published = await publishPlanArtifact(database, { runId: identity.runId, contractRevision: 2, dataDirectory });
    assert.equal(published.state, 'published');
    const planPath = path.join(dataDirectory, published.path);
    assert.match(await readFile(planPath, 'utf8'), /# Kiokuko WorkPlan/u);
    await assert.rejects(access(path.join(root, 'PLAN.md')));
    assert.equal((await publishPlanArtifact(database, { runId: identity.runId, contractRevision: 2, dataDirectory })).digest, published.digest);
  } finally {
    database.close();
  }
});

test('independent read-only WorkUnits receive distinct parallel leases', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepare(database, root, 'parallel-work');
    idealize(database, prepared);
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    const unit = (id: string, scope: string) => ({
      id, objective: `Inspect ${scope}`, scope: [scope], dependencies: [], routes: ['docs'] as const,
      skillNames: [], expertRefs: [], acceptanceCriteria: [`${scope} inspected`], focusedVerifiers: [],
      resourceClaims: [{ key: scope, access: 'read' as const }], isolationPreference: 'read_only' as const,
      outputContract: 'Return one evidence summary.',
    });
    const planned = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'parallel-plan', scope: ['README.md', 'docs/fixture.md'], exclusions: [],
      acceptanceCriteria: [{ id: 'inspected', description: 'both documents are inspected' }],
      workPlan: { objective: 'Inspect independent documents', units: [unit('readme', 'README.md'), unit('docs', 'docs/fixture.md')] },
      skillRequirements: [],
      finalVerifiers: [{ id: 'pass', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5_000 }],
      maxAttempts: 1,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'explicit_user',
        skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(planned.executionLeases?.length, 2);
    assert.equal(new Set(planned.executionLeases?.map((lease) => lease.workUnitId)).size, 2);
    assert.equal(new Set(planned.executionLeases?.map((lease) => lease.leaseToken)).size, 2);
    assert.ok(planned.executionLeases?.every((lease) => lease.attempt === 1 && /^[0-9a-f]{64}$/u.test(lease.inputManifestDigest)));
  } finally {
    database.close();
  }
});

test('conflicting writes serialize and an expired WorkUnit lease fences the stale result', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepare(database, root, 'write-conflict');
    idealize(database, prepared);
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    const writeUnit = (id: string) => ({
      id, objective: `Write from ${id}`, scope: ['docs/fixture.md'], dependencies: [], routes: ['docs'] as const,
      skillNames: [], expertRefs: [], acceptanceCriteria: [`${id} output is bounded`], focusedVerifiers: [],
      resourceClaims: [{ key: 'docs/fixture.md', access: 'write' as const }], isolationPreference: 'shared_serial' as const,
      outputContract: 'Return one changed path.',
    });
    const planned = await submitEnnoPlan(database, {
      ...identity, expectedRevision: 1, idempotencyKey: 'write-conflict-plan', scope: ['docs/fixture.md'], exclusions: [],
      acceptanceCriteria: [{ id: 'written', description: 'both writes are complete' }],
      workPlan: { objective: 'Serialize conflicting writes', units: [writeUnit('first'), writeUnit('second')] },
      skillRequirements: [],
      finalVerifiers: [{ id: 'pass', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 5_000 }],
      maxAttempts: 3,
      provenance: {
        scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'explicit_user',
        skillSet: 'explicit_user', finalVerifiers: 'explicit_user', maxAttempts: 'explicit_user',
      },
      capabilities,
    });
    assert.equal(planned.executionLeases?.length, 1);
    const stale = planned.executionLeases?.[0];
    assert.ok(stale);
    assert.equal(claimEnnoWork(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'write-conflict-claim-blocked', maxParallel: 8,
    }).executionLeases?.length ?? 0, 0);
    database.prepare(`
      UPDATE enno_execution_leases SET lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE run_id = ? AND contract_revision = ? AND work_unit_id = ?
    `).run(identity.runId, 2, stale.workUnitId);
    const reclaimed = claimEnnoWork(database, {
      ...identity, expectedRevision: 2, idempotencyKey: 'write-conflict-reclaim', maxParallel: 8,
    });
    assert.equal(reclaimed.executionLeases?.length, 1);
    assert.equal(reclaimed.executionLeases?.[0]?.workUnitId, stale.workUnitId);
    assert.equal(reclaimed.executionLeases?.[0]?.attempt, stale.attempt + 1);
    await assert.rejects(reportEnnoWork(database, {
      ...identity,
      expectedRevision: 2,
      idempotencyKey: 'write-conflict-stale-result',
      workUnitId: stale.workUnitId,
      attempt: stale.attempt,
      leaseToken: stale.leaseToken,
      routeEpoch: stale.routeEpoch,
      inputManifestDigest: stale.inputManifestDigest,
      result: { outcome: 'completed', summary: 'Late stale write', mutated: false, changedPaths: [] },
    }), /lease|stale|identity/iu);
  } finally {
    database.close();
  }
});

test('expired orchestration-job ownership cannot settle or overwrite a reclaimed job', async () => {
  const { database } = await fixture();
  try {
    const queued = enqueueOrchestrationJob(database, {
      kind: 'memory_promotion', payload: { candidateId: 'candidate-1' }, now: '2026-01-01T00:00:00.000Z',
    });
    const [first] = claimOrchestrationJobs(database, {
      owner: 'worker-a', leaseMs: 1_000, now: '2026-01-01T00:00:00.000Z', kinds: ['memory_promotion'],
    });
    assert.equal(first?.jobId, queued.jobId);
    assert.throws(() => failOrchestrationJob(database, {
      jobId: queued.jobId, owner: 'worker-a', errorCode: 'late', now: '2026-01-01T00:00:02.000Z',
    }), /stale/iu);
    const [second] = claimOrchestrationJobs(database, {
      owner: 'worker-b', leaseMs: 1_000, now: '2026-01-01T00:00:02.000Z', kinds: ['memory_promotion'],
    });
    assert.equal(second?.jobId, queued.jobId);
    assert.throws(() => completeOrchestrationJob(database, {
      jobId: queued.jobId, owner: 'worker-a', result: { stale: true }, now: '2026-01-01T00:00:02.100Z',
    }), /stale/iu);
    completeOrchestrationJob(database, {
      jobId: queued.jobId, owner: 'worker-b', result: { promoted: false }, now: '2026-01-01T00:00:02.100Z',
    });
    assert.equal(database.prepare('SELECT state FROM orchestration_jobs WHERE job_id = ?')
      .get<{ state: string }>(queued.jobId)?.state, 'completed');
  } finally {
    database.close();
  }
});

test('compaction meditation coalesces duplicates and verifies only boundary-supported claims', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepare(database, root, 'compaction');
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    appendEnnoEventInTransaction(database, identity.runId, 'verification.recorded', 'enno-oduno', 'passed', { test: 'fixture' });
    const boundary = captureCompactionBoundary(database, {
      clientSessionId: 'session-compaction', ...identity, contractRevision: 1,
      contextRevision: prepared.contextRevision, routeEpoch: 0, terminalMessageId: 'terminal-1',
    });
    appendEnnoEventInTransaction(database, identity.runId, 'goki.work_failed', 'goki', 'failed', { afterBoundary: true });
    const queued = queueCompactionMeditation(database, {
      clientSessionId: 'session-compaction', runId: identity.runId, summaryMessageId: 'summary-1',
      summaryText: 'Contract revision: 1\nA claim with no evidence must remain unknown\nAKIA1234567890ABCDEF',
    });
    const replay = queueCompactionMeditation(database, {
      clientSessionId: 'session-compaction', runId: identity.runId, summaryMessageId: 'summary-1',
      summaryText: 'Contract revision: 1\nA claim with no evidence must remain unknown\nAKIA1234567890ABCDEF',
    });
    assert.equal(queued?.cycleId, boundary.cycleId);
    assert.equal(replay?.cycleId, boundary.cycleId);
    const [job] = claimOrchestrationJobs(database, { owner: 'test-worker', kinds: ['compaction_meditation'] });
    assert.ok(job);
    const result = await processCompactionMeditationJob(database, job);
    assert.deepEqual(result, { cycleId: boundary.cycleId, supported: 1, contradicted: 0, unknown: 1 });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM meditation_claims WHERE cycle_id = ?').get<{ count: number }>(boundary.cycleId)?.count, 2);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM meditation_memory_links AS l
      JOIN entries AS e ON e.id = l.entry_id
      WHERE l.claim_id IN (SELECT claim_id FROM meditation_claims WHERE cycle_id = ?)
        AND l.promotion_state = 'verified' AND e.workspace = ?
    `).get<{ count: number }>(boundary.cycleId, identity.workspace)?.count, 1);
  } finally {
    database.close();
  }
});

test('a post-compaction event arriving before its boundary is durably coalesced', async () => {
  const { root, database } = await fixture();
  try {
    const prepared = await prepare(database, root, 'compaction-reverse-order');
    const identity = { runId: prepared.run.runId, workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId };
    appendEnnoEventInTransaction(database, identity.runId, 'verification.recorded', 'enno-oduno', 'passed', { test: 'reverse-order' });
    assert.equal(queueCompactionMeditation(database, {
      clientSessionId: 'session-compaction-reverse', runId: identity.runId,
      summaryMessageId: 'summary-before-boundary', summaryText: 'Contract revision: 1',
    }), null);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM compaction_post_events
      WHERE client_session_id = ? AND bound_cycle_id IS NULL
    `).get<{ count: number }>('session-compaction-reverse')?.count, 1);
    const boundary = captureCompactionBoundary(database, {
      clientSessionId: 'session-compaction-reverse', ...identity, contractRevision: 1,
      contextRevision: prepared.contextRevision, routeEpoch: 0, terminalMessageId: 'terminal-after-summary',
    });
    assert.equal(boundary.state, 'queued');
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM orchestration_jobs
      WHERE run_id = ? AND kind = 'compaction_meditation'
    `).get<{ count: number }>(identity.runId)?.count, 1);
    const [job] = claimOrchestrationJobs(database, { owner: 'reverse-worker', kinds: ['compaction_meditation'] });
    assert.ok(job);
    assert.deepEqual(await processCompactionMeditationJob(database, job), {
      cycleId: boundary.cycleId, supported: 1, contradicted: 0, unknown: 0,
    });
  } finally {
    database.close();
  }
});
