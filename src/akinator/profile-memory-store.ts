import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { findSecret } from '../memory/secrets.js';
import { readAkinatorAnswer, readAkinatorSession, readRunIntakeLink, type AkinatorProfileSources } from './store.js';
import type { AkinatorSessionView } from './types.js';
import { parseMemoryResolution, type MemoryResolution, type ProfileEvidence } from './memory-probe-types.js';

export interface ProfileDocument {
  session: AkinatorSessionView;
  sources: AkinatorProfileSources;
  completed: boolean;
  targetOriginVerified: boolean;
  evidence: ProfileEvidence;
}

/** Load authoritative data; an index hit never supplies profile values or trust. */
export function readProfileDocument(database: SqliteDatabase, workspace: string, repositoryId: string, runId: string): ProfileDocument | undefined {
  const row = database.prepare(`
    SELECT ri.session_id, lr.status, r.repository_id
    FROM ledger_runs AS lr JOIN run_intakes AS ri ON ri.run_id = lr.run_id
    JOIN repositories AS r ON r.workspace = lr.workspace
    WHERE lr.run_id = ? AND lr.workspace = ? AND r.repository_id = ?
  `).get<{ session_id: string; status: string; repository_id: string }>(runId, workspace, repositoryId);
  if (!row) return undefined;
  const link = readRunIntakeLink(database, { workspace, runId });
  const session = readAkinatorSession(database, { workspace, sessionId: row.session_id });
  if (session.status !== 'ready' || link.finalizedAt === null) return undefined;
  if (findSecret(session.task) || findSecret(JSON.stringify(session.profile))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Source profile contains secret material');
  }
  const targetOriginVerified = link.profileSources.target === 'client_supplied'
    || link.profileSources.target === 'user_answer'
      && readAkinatorAnswer(database, { workspace, sessionId: session.id, questionId: 'target' })?.answer === session.profile.target;
  return {
    targetOriginVerified,
    session, sources: link.profileSources, completed: row.status === 'completed',
    evidence: {
      runId, sessionId: session.id, workspace, repositoryId,
      profileHash: canonicalContentHash(session.profile),
      sourcesHash: canonicalContentHash(link.profileSources), score: 0,
    },
  };
}

/** Called inside the transaction that finalizes an intake. No filesystem or network access. */
export function projectProfileInTransaction(database: SqliteDatabase, runId: string, now: string): void {
  const scope = database.prepare(`SELECT r.workspace, r.repository_id FROM repositories AS r
    JOIN ledger_runs AS lr ON lr.workspace = r.workspace WHERE lr.run_id = ?`)
    .get<{ workspace: string; repository_id: string }>(runId);
  if (!scope) return; // Standalone sessions are never promoted into repository history.
  const source = readProfileDocument(database, scope.workspace, scope.repository_id, runId);
  database.prepare('DELETE FROM akinator_profile_documents WHERE run_id = ?').run(runId);
  if (!source) return;
  const target = source.session.profile.target ?? '';
  database.prepare(`INSERT INTO akinator_profile_documents
    (run_id, session_id, workspace, repository_id, profile_hash, sources_hash, task_text, target_text, projected_at, projection_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(runId, source.session.id, scope.workspace, scope.repository_id,
      source.evidence.profileHash, source.evidence.sourcesHash, source.session.task.slice(0, 2048), target.slice(0, 512), now);
  if (target.length > 0 && target.length <= 512) {
    database.prepare(`INSERT INTO akinator_profile_signals(document_id, workspace, repository_id, value)
      SELECT id, workspace, repository_id, ? FROM akinator_profile_documents WHERE run_id = ?`).run(target, runId);
  }
}

export function profileCoverage(database: SqliteDatabase, workspace: string, repositoryId: string): 'complete' | 'partial' {
  const missing = database.prepare(`SELECT 1 AS missing FROM ledger_runs AS lr
    JOIN run_intakes AS ri ON ri.run_id = lr.run_id
    JOIN akinator_sessions AS s ON s.id = ri.session_id
    LEFT JOIN akinator_profile_documents AS d ON d.run_id = lr.run_id AND d.repository_id = ?
    WHERE lr.workspace = ? AND s.status = 'ready' AND ri.finalized_at IS NOT NULL AND d.id IS NULL LIMIT 1`)
    .get(repositoryId, workspace);
  return missing ? 'partial' : 'complete';
}

export function readMemoryResolution(database: SqliteDatabase, runId: string): MemoryResolution | undefined {
  const row = database.prepare('SELECT resolution_json FROM akinator_memory_resolutions WHERE run_id = ?')
    .get<{ resolution_json: string }>(runId);
  if (!row) return undefined;
  try { return parseMemoryResolution(JSON.parse(row.resolution_json)); }
  catch (cause) { throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile memory resolution is invalid'); }
}

export function saveMemoryResolution(database: SqliteDatabase, runId: string, resolution: MemoryResolution, now: string): void {
  database.prepare('INSERT INTO akinator_memory_resolutions(run_id, resolution_json, created_at) VALUES (?, ?, ?)')
    .run(runId, canonicalJson(parseMemoryResolution(resolution)), now);
}

/** Explicit, resumable maintenance: one bounded batch and one transaction per call. */
export function backfillProfiles(database: SqliteDatabase, workspace: string, batchSize = 100): { processed: number; complete: boolean; cursor: string } {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new KiokukoError('VALIDATION_ERROR', 'Profile backfill batch size must be between 1 and 1000');
  }
  return withImmediateTransaction(database, () => {
    const repo = database.prepare('SELECT repository_id FROM repositories WHERE workspace = ?').get(workspace);
    if (!repo) throw new KiokukoError('NOT_FOUND', 'Profile backfill requires a registered repository workspace');
    const state = database.prepare('SELECT cursor, complete FROM akinator_profile_backfill WHERE workspace = ?')
      .get<{ cursor: string; complete: number }>(workspace);
    if (state?.complete === 1) return { processed: 0, complete: true, cursor: state.cursor };
    const rows = database.prepare(`SELECT lr.run_id FROM ledger_runs AS lr JOIN run_intakes AS ri ON ri.run_id = lr.run_id
      WHERE lr.workspace = ? AND lr.run_id > ? ORDER BY lr.run_id LIMIT ?`)
      .all<{ run_id: string }>(workspace, state?.cursor ?? '', batchSize + 1);
    const batch = rows.slice(0, batchSize);
    const now = new Date().toISOString();
    for (const row of batch) projectProfileInTransaction(database, row.run_id, now);
    const cursor = batch.at(-1)?.run_id ?? state?.cursor ?? '';
    const complete = rows.length <= batchSize;
    database.prepare(`INSERT INTO akinator_profile_backfill(workspace, cursor, complete) VALUES (?, ?, ?)
      ON CONFLICT(workspace) DO UPDATE SET cursor = excluded.cursor, complete = excluded.complete`).run(workspace, cursor, complete ? 1 : 0);
    return { processed: batch.length, complete, cursor };
  });
}

export function currentProfileEvidence(database: SqliteDatabase, ref: ProfileEvidence): ProfileDocument | undefined {
  const current = readProfileDocument(database, ref.workspace, ref.repositoryId, ref.runId);
  if (!current || current.session.id !== ref.sessionId || current.evidence.profileHash !== ref.profileHash
    || current.evidence.sourcesHash !== ref.sourcesHash) return undefined;
  return current;
}


/** Explicit rebuild invalidates coverage before any bounded backfill batch is run. */
export function resetProfileProjection(database: SqliteDatabase, workspace: string): void {
  withImmediateTransaction(database, () => {
    if (!database.prepare('SELECT 1 FROM repositories WHERE workspace = ?').get(workspace)) {
      throw new KiokukoError('NOT_FOUND', 'Profile rebuild requires a registered repository workspace');
    }
    database.prepare('DELETE FROM akinator_profile_documents WHERE workspace = ?').run(workspace);
    database.prepare('DELETE FROM akinator_profile_backfill WHERE workspace = ?').run(workspace);
  });
}
