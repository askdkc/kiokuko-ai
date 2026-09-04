import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalJson, type JsonObject } from '../serialization/validate.js';

export interface TaskContextRevision {
  runId: string;
  contextRevision: number;
  selectionStateHash: string;
  context: JsonObject;
  createdAt: string;
}

interface RevisionRow extends SqliteRow {
  run_id: unknown;
  context_revision: unknown;
  selection_state_hash: unknown;
  context_json: unknown;
  created_at: unknown;
}

function parseRevision(row: RevisionRow): TaskContextRevision {
  if (typeof row.run_id !== 'string' || typeof row.context_revision !== 'number'
    || typeof row.selection_state_hash !== 'string' || typeof row.context_json !== 'string'
    || typeof row.created_at !== 'string') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored task context revision is invalid');
  }
  let context: unknown;
  try {
    context = JSON.parse(row.context_json);
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored task context revision is invalid');
  }
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored task context revision is invalid');
  }
  return {
    runId: row.run_id,
    contextRevision: row.context_revision,
    selectionStateHash: row.selection_state_hash,
    context: context as JsonObject,
    createdAt: row.created_at,
  };
}

export function recordTaskContextRevision(database: SqliteDatabase, input: {
  runId: string;
  context: JsonObject;
  now?: string;
}): TaskContextRevision {
  return withImmediateTransaction(database, () => {
    const now = input.now ?? new Date().toISOString();
    const selectionStateHash = canonicalContentHash(input.context);
    const existing = database.prepare(`
      SELECT run_id, context_revision, selection_state_hash, context_json, created_at
      FROM task_context_revisions
      WHERE run_id = ? AND selection_state_hash = ?
    `).get<RevisionRow>(input.runId, selectionStateHash);
    if (existing !== undefined) return parseRevision(existing);
    const next = database.prepare(`
      SELECT COALESCE(MAX(context_revision), 0) + 1 AS revision
      FROM task_context_revisions WHERE run_id = ?
    `).get<{ revision: number }>(input.runId)?.revision ?? 1;
    database.prepare(`
      INSERT INTO task_context_revisions (
        run_id, context_revision, selection_state_hash, context_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(input.runId, next, selectionStateHash, canonicalJson(input.context), now);
    const stored = database.prepare(`
      SELECT run_id, context_revision, selection_state_hash, context_json, created_at
      FROM task_context_revisions WHERE run_id = ? AND context_revision = ?
    `).get<RevisionRow>(input.runId, next);
    if (stored === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Task context revision could not be read back');
    return parseRevision(stored);
  });
}

export function readTaskContextRevisions(database: SqliteDatabase, input: {
  runId: string;
  afterContextRevision?: number;
  limit?: number;
}): TaskContextRevision[] {
  const after = input.afterContextRevision ?? 0;
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new KiokukoError('VALIDATION_ERROR', 'Task context revision cursor is invalid');
  }
  return database.prepare(`
    SELECT run_id, context_revision, selection_state_hash, context_json, created_at
    FROM task_context_revisions
    WHERE run_id = ? AND context_revision > ?
    ORDER BY context_revision
    LIMIT ?
  `).all<RevisionRow>(input.runId, after, limit).map(parseRevision);
}
