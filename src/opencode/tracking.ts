import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';

export interface TrackedOpenCodeSession {
  sessionId: string;
  runId: string;
  workspace: string;
  orchestrationId: string;
  repositoryRoot: string;
  revision: number;
  mutationRevision: number;
  routeEpoch: number;
}

export interface ContinuationReceipt {
  contractRevision: number;
  mutationRevision: number;
  attempts: number;
  directiveDigest: string;
  routeEpoch: number;
}

/** A receipt is evidence of one allowed directive, never authority to send a prompt. */
export function readContinuationReceipt(
  database: SqliteDatabase, runId: string, sessionId: string, terminalMessageId: string,
): ContinuationReceipt | undefined {
  const terminalHash = createHash('sha256')
    .update('kiokuko-opencode-terminal-v1\0', 'utf8')
    .update(sessionId, 'utf8').update('\0', 'utf8')
    .update(terminalMessageId, 'utf8').digest('hex');
  return database.prepare(`
    SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision,
      attempts, directive_digest AS directiveDigest, route_epoch AS routeEpoch
    FROM enno_opencode_continuation_receipts
    WHERE run_id = ? AND client_kind = 'opencode'
      AND source_session_id = ? AND source_terminal_hash = ?
  `).get<Record<string, unknown>>(runId, sessionId, terminalHash) as ContinuationReceipt | undefined;
}

/** Read only the run bindings owned by this repository. This must not claim a lease. */
export function listTrackedOpenCodeSessions(database: SqliteDatabase, directory: string): TrackedOpenCodeSession[] {
  if (!path.isAbsolute(directory) || directory.includes('\0')) {
    throw new KiokukoError('VALIDATION_ERROR', 'OpenCode repository directory must be absolute');
  }
  return database.prepare(`
    SELECT c.client_session_id AS sessionId, c.run_id AS runId,
      c.workspace, c.orchestration_session_id AS orchestrationId,
      c.repository_root AS repositoryRoot, c.revision,
      c.mutation_revision AS mutationRevision, c.route_epoch AS routeEpoch
    FROM enno_contracts AS c
    JOIN ledger_runs AS r ON r.run_id = c.run_id AND r.workspace = c.workspace
    WHERE c.repository_root = ? AND c.client_kind = 'opencode'
      AND c.client_session_id IS NOT NULL
      AND c.status NOT IN ('completed', 'cancelled')
      AND r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
    ORDER BY c.run_id
  `).all<Record<string, unknown>>(directory).map(row => {
    if (typeof row.sessionId !== 'string' || typeof row.runId !== 'string'
      || typeof row.workspace !== 'string' || typeof row.orchestrationId !== 'string'
      || typeof row.repositoryRoot !== 'string' || typeof row.revision !== 'number'
      || typeof row.mutationRevision !== 'number' || typeof row.routeEpoch !== 'number') {
      throw new KiokukoError('INTEGRITY_ERROR', 'Tracked OpenCode session binding is invalid');
    }
    return {
      sessionId: row.sessionId, runId: row.runId, workspace: row.workspace,
      orchestrationId: row.orchestrationId, repositoryRoot: row.repositoryRoot,
      revision: row.revision, mutationRevision: row.mutationRevision, routeEpoch: row.routeEpoch,
    };
  });
}
