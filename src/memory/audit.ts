import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { canonicalJson, requireWorkspace } from '../serialization/validate.js';

export type AuditOperation = 'record' | 'promote' | 'supersede' | 'link' | 'import' | 'purge';

export interface AuditEventInput {
  entryId: string | null;
  workspace: string;
  operation: AuditOperation;
  actor: string;
  details?: Record<string, unknown>;
  eventId?: string;
  createdAt?: string;
}

export function recordAuditEvent(database: SqliteDatabase, input: AuditEventInput): string {
  const workspace = requireWorkspace(input.workspace);
  const eventId = input.eventId ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const detailsJson = canonicalJson(input.details ?? {});
  database
    .prepare(
      `INSERT INTO audit_events
        (event_id, entry_id, workspace, operation, actor, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(eventId, input.entryId, workspace, input.operation, input.actor, detailsJson, createdAt);
  return eventId;
}
