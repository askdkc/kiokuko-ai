import { createHash } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { findSecret } from '../memory/secrets.js';
import { recordEntryInTransaction } from '../memory/entries.js';
import { recordAuditEvent } from '../memory/audit.js';
import { captureRepositoryState } from '../enno-oduno/repository-state.js';
import { canonicalContentHash, canonicalJson, type JsonObject } from '../serialization/validate.js';
import { enqueueOrchestrationJob, type OrchestrationJob } from '../orchestration/jobs.js';

export interface CompactionBoundaryInput {
  clientSessionId: string;
  runId: string;
  workspace: string;
  orchestrationId: string;
  contractRevision: number | null;
  contextRevision: number | null;
  routeEpoch: number | null;
  terminalMessageId?: string | null;
}

export interface CompactionPostInput {
  clientSessionId: string;
  runId?: string | null;
  summaryMessageId?: string | null;
  summaryText?: string | null;
}

export interface CompactionCycle {
  cycleId: string;
  runId: string | null;
  state: 'captured' | 'compacted' | 'queued' | 'completed' | 'failed';
  boundaryDigest: string;
  summaryDigest: string | null;
}

interface CycleRow extends SqliteRow {
  cycle_id: string;
  client_session_id: string;
  run_id: string | null;
  workspace: string | null;
  contract_revision: number | null;
  context_revision: number | null;
  route_epoch: number | null;
  through_sequence: number | null;
  repository_digest: string | null;
  boundary_digest: string;
  summary_digest: string | null;
  state: CompactionCycle['state'];
}

interface PendingPostRow extends SqliteRow {
  client_session_id: string;
  summary_digest: string;
  run_id: string | null;
  summary_message_id: string | null;
  claims_json: string;
}

function publicCycle(row: CycleRow): CompactionCycle {
  return {
    cycleId: row.cycle_id,
    runId: row.run_id,
    state: row.state,
    boundaryDigest: row.boundary_digest,
    summaryDigest: row.summary_digest,
  };
}

function boundedIdentifier(value: string, label: string): string {
  if (value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} is invalid`);
  }
  return value;
}

function cycleId(boundaryDigest: string): string {
  return `cmp_${boundaryDigest.slice(0, 48)}`;
}

export function captureCompactionBoundary(database: SqliteDatabase, input: CompactionBoundaryInput): CompactionCycle {
  boundedIdentifier(input.clientSessionId, 'Compaction client session ID');
  boundedIdentifier(input.runId, 'Compaction run ID');
  boundedIdentifier(input.workspace, 'Compaction workspace');
  boundedIdentifier(input.orchestrationId, 'Compaction orchestration ID');
  const run = new LedgerStore(database).readRun(input.runId, input.workspace);
  if (run === undefined) throw new KiokukoError('NOT_FOUND', 'Compaction run was not found');
  const contract = database.prepare(`
    SELECT orchestration_session_id AS orchestrationId, repository_root AS repositoryRoot,
           revision, route_epoch AS routeEpoch
    FROM enno_contracts WHERE run_id = ? AND workspace = ?
  `).get<{ orchestrationId: string; repositoryRoot: string; revision: number; routeEpoch: number }>(input.runId, input.workspace);
  if (contract === undefined || contract.orchestrationId !== input.orchestrationId) {
    throw new KiokukoError('CONFLICT', 'Compaction run identity changed');
  }
  if (input.contractRevision !== null && input.contractRevision !== contract.revision) {
    throw new KiokukoError('CONFLICT', 'Compaction contract revision changed');
  }
  if (input.routeEpoch !== null && input.routeEpoch !== contract.routeEpoch) {
    throw new KiokukoError('CONFLICT', 'Compaction route epoch changed');
  }
  const contextRevision = database.prepare(`
    SELECT MAX(context_revision) AS revision FROM task_context_revisions WHERE run_id = ?
  `).get<{ revision: number | null }>(input.runId)?.revision ?? input.contextRevision;
  const repositoryDigest = captureRepositoryState(contract.repositoryRoot).digest;
  const boundary = {
    version: 1,
    clientSessionId: input.clientSessionId,
    runId: input.runId,
    workspace: input.workspace,
    contractRevision: contract.revision,
    contextRevision,
    routeEpoch: contract.routeEpoch,
    throughSequence: run.lastSequence,
    terminalMessageId: input.terminalMessageId ?? null,
    repositoryDigest,
  };
  const boundaryDigest = canonicalContentHash(boundary);
  const id = cycleId(boundaryDigest);
  const now = new Date().toISOString();
  const captured = withImmediateTransaction(database, () => {
    database.prepare(`
      INSERT INTO compaction_cycles (
        cycle_id, client_session_id, run_id, workspace, contract_revision,
        context_revision, route_epoch, through_sequence, terminal_message_id,
        repository_digest, boundary_digest, summary_message_id, summary_digest,
        state, created_at, compacted_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'captured', ?, NULL, NULL)
      ON CONFLICT(client_session_id, boundary_digest) DO NOTHING
    `).run(
      id,
      input.clientSessionId,
      input.runId,
      input.workspace,
      contract.revision,
      contextRevision,
      contract.routeEpoch,
      run.lastSequence,
      input.terminalMessageId ?? null,
      repositoryDigest,
      boundaryDigest,
      now,
    );
    const row = database.prepare(`
      SELECT * FROM compaction_cycles WHERE client_session_id = ? AND boundary_digest = ?
    `).get<CycleRow>(input.clientSessionId, boundaryDigest);
    if (row === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Compaction boundary could not be read back');
    return publicCycle(row);
  });
  const pending = database.prepare(`
    SELECT client_session_id, summary_digest, run_id, summary_message_id, claims_json
    FROM compaction_post_events
    WHERE client_session_id = ? AND bound_cycle_id IS NULL
      AND (run_id IS NULL OR run_id = ?)
    ORDER BY created_at DESC, summary_digest DESC
    LIMIT 1
  `).get<PendingPostRow>(input.clientSessionId, input.runId);
  if (pending === undefined) return captured;
  let claims: unknown;
  try {
    claims = JSON.parse(pending.claims_json);
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored compaction claim projection is invalid');
  }
  if (!Array.isArray(claims) || claims.length > 128 || claims.some((claim) => typeof claim !== 'string')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored compaction claim projection is invalid');
  }
  const attached = attachCompactionPost(database, captured.cycleId, {
    summaryMessageId: pending.summary_message_id,
    summaryDigest: pending.summary_digest,
    claims: claims as string[],
  });
  database.prepare(`
    UPDATE compaction_post_events SET bound_cycle_id = ?
    WHERE client_session_id = ? AND summary_digest = ? AND bound_cycle_id IS NULL
  `).run(attached.cycleId, pending.client_session_id, pending.summary_digest);
  return attached;
}

function extractClaims(summary: string | null | undefined): string[] {
  if (summary === null || summary === undefined || summary.length === 0 || summary.length > 64 * 1024) return [];
  const claims = summary
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[-*+] |\d+[.)] )/u, '').trim())
    .filter((line) => line.length >= 8 && line.length <= 2_000)
    .filter((line) => findSecret(line) === undefined)
    .slice(0, 128);
  return [...new Set(claims)];
}

function attachCompactionPost(database: SqliteDatabase, cycleIdValue: string, input: {
  summaryMessageId: string | null;
  summaryDigest: string;
  claims: string[];
}): CompactionCycle {
  return withImmediateTransaction(database, () => {
    const current = database.prepare('SELECT * FROM compaction_cycles WHERE cycle_id = ?').get<CycleRow>(cycleIdValue);
    if (current === undefined) throw new KiokukoError('CONFLICT', 'Compaction cycle disappeared');
    if (current.summary_digest !== null && current.summary_digest !== input.summaryDigest) {
      throw new KiokukoError('CONFLICT', 'Compaction cycle already has a different summary');
    }
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE compaction_cycles
      SET summary_message_id = COALESCE(summary_message_id, ?), summary_digest = ?,
          state = CASE WHEN state = 'completed' THEN state ELSE 'queued' END,
          compacted_at = COALESCE(compacted_at, ?)
      WHERE cycle_id = ? AND boundary_digest = ?
    `).run(input.summaryMessageId, input.summaryDigest, now, current.cycle_id, current.boundary_digest);
    if (current.state !== 'completed') {
      enqueueOrchestrationJob(database, {
        kind: 'compaction_meditation',
        runId: current.run_id,
        payload: {
          cycleId: current.cycle_id,
          boundaryDigest: current.boundary_digest,
          summaryDigest: input.summaryDigest,
          claims: input.claims,
        },
      });
    }
    const updated = database.prepare('SELECT * FROM compaction_cycles WHERE cycle_id = ?').get<CycleRow>(current.cycle_id);
    if (updated === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Compaction cycle could not be read back');
    return publicCycle(updated);
  });
}

export function queueCompactionMeditation(database: SqliteDatabase, input: CompactionPostInput): CompactionCycle | null {
  boundedIdentifier(input.clientSessionId, 'Compaction client session ID');
  const summaryText = input.summaryText ?? null;
  const summaryDigest = summaryText === null ? canonicalContentHash({ unavailable: true }) : canonicalContentHash(summaryText);
  const claims = extractClaims(summaryText);
  const row = database.prepare(`
    SELECT * FROM compaction_cycles
    WHERE client_session_id = ?
      AND (? IS NULL OR run_id = ?)
      AND state IN ('captured', 'compacted', 'queued', 'completed')
    ORDER BY created_at DESC, cycle_id DESC
    LIMIT 1
  `).get<CycleRow>(input.clientSessionId, input.runId ?? null, input.runId ?? null);
  if (row === undefined) {
    // Ordinary OpenCode sessions also emit post-compaction events. Without a
    // run or a captured boundary there is no Kiokuko cycle to recover later.
    if (input.runId === undefined || input.runId === null) return null;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO compaction_post_events (
        client_session_id, summary_digest, run_id, summary_message_id,
        claims_json, bound_cycle_id, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(client_session_id, summary_digest) DO NOTHING
    `).run(
      input.clientSessionId,
      summaryDigest,
      input.runId ?? null,
      input.summaryMessageId ?? null,
      canonicalJson(claims),
      now,
    );
    return null;
  }
  return attachCompactionPost(database, row.cycle_id, {
    summaryMessageId: input.summaryMessageId ?? null,
    summaryDigest,
    claims,
  });
}

interface EvidenceEvent extends SqliteRow {
  sequence: number;
  event_type: string;
  outcome: string | null;
  payload_json: string;
  event_hash: string;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function classifyClaim(claim: string, cycle: CycleRow, events: EvidenceEvent[]): {
  classification: 'supported' | 'contradicted' | 'unknown';
  deterministic: boolean;
  evidenceIds: string[];
} {
  const text = normalized(claim);
  const evidenceIds: string[] = [];
  const revisionMatch = /^(?:contract\s*revision|contractrevision)\s*[:=]\s*(\d+)$/iu.exec(claim);
  if (revisionMatch !== null && cycle.contract_revision !== null) {
    return Number(revisionMatch[1]) === cycle.contract_revision
      ? { classification: 'supported', deterministic: true, evidenceIds: [`boundary:${cycle.boundary_digest}`] }
      : { classification: 'contradicted', deterministic: true, evidenceIds: [`boundary:${cycle.boundary_digest}`] };
  }
  if (cycle.run_id !== null && new RegExp(`^run(?: id)?\\s*[:=]\\s*${cycle.run_id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'iu').test(claim)) {
    return { classification: 'supported', deterministic: true, evidenceIds: [`boundary:${cycle.boundary_digest}`] };
  }
  const exactRelevant = events.filter((event) => {
    const haystack = normalized(`${event.event_type} ${event.outcome ?? ''} ${event.payload_json}`);
    return text.length >= 20 && haystack.includes(text);
  });
  evidenceIds.push(...exactRelevant.map((event) => `event:${event.sequence}:${event.event_hash}`));
  const testClaim = /(?:test|verify|verification|テスト|検証)/iu.test(claim);
  const passingClaim = /(?:pass(?:ed|ing)?|success(?:ful)?|成功|合格)/iu.test(claim);
  if (testClaim && passingClaim) {
    const failed = events.find((event) => ['test.completed', 'verification.recorded', 'enno.verification_failed'].includes(event.event_type)
      && ['failed', 'timeout', 'spawn_failed'].includes(event.outcome ?? ''));
    if (failed !== undefined) return {
      classification: 'contradicted', deterministic: true,
      evidenceIds: [`event:${failed.sequence}:${failed.event_hash}`],
    };
    const passed = events.filter((event) => ['test.completed', 'verification.recorded', 'enno.verification_passed'].includes(event.event_type)
      && ['passed', 'completed', 'success'].includes(event.outcome ?? ''));
    if (passed.length > 0) return {
      classification: 'supported', deterministic: true,
      evidenceIds: passed.map((event) => `event:${event.sequence}:${event.event_hash}`),
    };
  }
  if (/(?:completed|finished|完了)/iu.test(claim)) {
    const completed = events.find((event) => event.event_type === 'enno.completed');
    const blocked = events.find((event) => event.event_type === 'enno.blocked' || event.event_type === 'goki.work_failed');
    if (completed !== undefined) return {
      classification: 'supported', deterministic: true,
      evidenceIds: [`event:${completed.sequence}:${completed.event_hash}`],
    };
    if (blocked !== undefined) return {
      classification: 'contradicted', deterministic: true,
      evidenceIds: [`event:${blocked.sequence}:${blocked.event_hash}`],
    };
  }
  if (exactRelevant.length > 0) return { classification: 'supported', deterministic: true, evidenceIds };
  return { classification: 'unknown', deterministic: false, evidenceIds: [] };
}

function jsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

/** Process only the event range frozen before compaction; later runs/events are invisible. */
export async function processCompactionMeditationJob(database: SqliteDatabase, job: OrchestrationJob): Promise<JsonObject> {
  const cycleIdValue = typeof job.payload.cycleId === 'string' ? job.payload.cycleId : undefined;
  const claimsValue = job.payload.claims;
  if (cycleIdValue === undefined || !Array.isArray(claimsValue)
    || claimsValue.length > 128 || claimsValue.some((claim) => typeof claim !== 'string')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Compaction meditation job payload is invalid');
  }
  return withImmediateTransaction(database, () => {
    const cycle = database.prepare('SELECT * FROM compaction_cycles WHERE cycle_id = ?').get<CycleRow>(cycleIdValue);
    if (cycle === undefined || cycle.run_id === null || cycle.workspace === null || cycle.through_sequence === null) {
      throw new KiokukoError('CONFLICT', 'Compaction meditation boundary is unavailable');
    }
    if (cycle.state === 'completed') return { cycleId: cycle.cycle_id, replayed: true };
    const events = database.prepare(`
      SELECT sequence, event_type, outcome, payload_json, event_hash
      FROM ledger_events
      WHERE run_id = ? AND sequence <= ?
      ORDER BY sequence
    `).all<EvidenceEvent>(cycle.run_id, cycle.through_sequence);
    let supported = 0;
    let contradicted = 0;
    let unknown = 0;
    for (const [index, claimValue] of (claimsValue as string[]).entries()) {
      if (findSecret(claimValue) !== undefined) continue;
      const result = classifyClaim(claimValue, cycle, events);
      if (result.classification === 'supported') supported += 1;
      else if (result.classification === 'contradicted') contradicted += 1;
      else unknown += 1;
      const claimDigest = canonicalContentHash({ cycleId: cycle.cycle_id, claim: claimValue });
      const claimId = `mcl_${createHash('sha256').update(`${cycle.cycle_id}\0${claimDigest}`).digest('hex').slice(0, 48)}`;
      database.prepare(`
        INSERT INTO meditation_claims (
          claim_id, cycle_id, claim_index, classification, claim_json,
          evidence_json, claim_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cycle_id, claim_index) DO NOTHING
      `).run(
        claimId,
        cycle.cycle_id,
        index,
        result.classification,
        canonicalJson({ text: claimValue }),
        canonicalJson({ deterministic: result.deterministic, evidenceIds: result.evidenceIds }),
        claimDigest,
        new Date().toISOString(),
      );
      if (result.classification === 'supported') {
        const entry = recordEntryInTransaction(database, {
          workspace: cycle.workspace,
          kind: 'fact',
          status: 'candidate',
          title: `Compaction fact: ${claimValue.slice(0, 160)}`,
          body: claimValue,
          summary: null,
          scope: { visibility: 'project' },
          provenance: {
            type: 'compaction_meditation',
            reference: `compaction:${cycle.cycle_id}`,
            runId: cycle.run_id,
            evidenceIds: result.evidenceIds,
            timestamp: new Date().toISOString(),
          },
          tags: ['compaction-meditation', 'project-memory'],
          trustLevel: 'source_verified',
          confidence: result.deterministic ? 1 : 0.7,
          createdBy: 'kiokuko-compaction',
          actor: 'kiokuko-compaction',
        });
        let promotionState: 'candidate' | 'verified' = 'candidate';
        if (result.deterministic && entry.createdBy === 'kiokuko-compaction') {
          const now = new Date().toISOString();
          const promoted = database.prepare(`
            UPDATE entries
            SET status = 'verified', verified_at = ?, updated_at = ?
            WHERE id = ? AND workspace = ? AND current_revision = ? AND status = 'candidate'
            RETURNING id
          `).get<{ id: string }>(now, now, entry.id, entry.workspace, entry.revision);
          if (promoted !== undefined || entry.status === 'verified') {
            promotionState = 'verified';
            if (promoted !== undefined) {
              recordAuditEvent(database, {
                entryId: entry.id,
                workspace: entry.workspace,
                operation: 'promote',
                actor: 'kiokuko-compaction',
                details: { expectedRevision: entry.revision, cycleId: cycle.cycle_id },
                createdAt: now,
              });
            }
          }
        }
        database.prepare(`
          INSERT INTO meditation_memory_links (
            claim_id, entry_id, entry_revision, promotion_state, created_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(claim_id, entry_id) DO NOTHING
        `).run(claimId, entry.id, entry.revision, promotionState, new Date().toISOString());
      } else if (result.classification === 'contradicted') {
        const supersedeCandidates = database.prepare(`
          SELECT e.id, e.current_revision AS revision
          FROM entries AS e
          JOIN entry_revisions AS er
            ON er.entry_id = e.id AND er.revision = e.current_revision
          WHERE e.workspace = ? AND e.status <> 'superseded'
            AND (er.body = ? OR er.title = ?)
          ORDER BY e.id
          LIMIT 32
        `).all<{ id: string; revision: number }>(cycle.workspace, claimValue, claimValue);
        for (const candidate of supersedeCandidates) {
          database.prepare(`
            INSERT INTO meditation_memory_links (
              claim_id, entry_id, entry_revision, promotion_state, created_at
            ) VALUES (?, ?, ?, 'rejected', ?)
            ON CONFLICT(claim_id, entry_id) DO NOTHING
          `).run(claimId, candidate.id, candidate.revision, new Date().toISOString());
        }
        new LedgerStore(database).appendBatchInTransaction(cycle.run_id, { events: [{
          eventType: 'correction.recorded',
          actor: 'kiokuko-compaction',
          outcome: 'contradicted',
          payload: jsonObject({
            cycleId: cycle.cycle_id,
            claimDigest,
            evidenceIds: result.evidenceIds,
            supersedeCandidateIds: supersedeCandidates.map((candidate) => candidate.id),
          }),
        }] });
      }
    }
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE compaction_cycles SET state = 'completed', completed_at = ?
      WHERE cycle_id = ? AND boundary_digest = ?
    `).run(now, cycle.cycle_id, cycle.boundary_digest);
    return { cycleId: cycle.cycle_id, supported, contradicted, unknown };
  });
}
