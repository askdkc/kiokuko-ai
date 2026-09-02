import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { recordAuditEvent } from '../memory/audit.js';

export interface PurgeInput {
  workspace: string;
  entryId: string;
  confirm: boolean;
  actor?: string;
  now?: string;
}

export function purgeEntry(database: SqliteDatabase, input: PurgeInput): void {
  if (!input.confirm) throw new KiokukoError('VALIDATION_ERROR', 'purge requires explicit confirmation');
  const now = input.now ?? new Date().toISOString();
  const actor = input.actor ?? 'kiokuko-cli';
  withImmediateTransaction(database, () => {
    const existing = database.prepare('SELECT id FROM entries WHERE id = ? AND workspace = ?').get<{ id: string }>(input.entryId, input.workspace);
    if (!existing) throw new KiokukoError('NOT_FOUND', 'Entry not found');
    const managedExternal = database.prepare('SELECT 1 AS present FROM external_skill_entries WHERE entry_id = ? LIMIT 1').get<{ present: number }>(input.entryId);
    if (managedExternal) throw new KiokukoError('CONFLICT', 'Managed external Skill entries cannot be purged individually; disable the external Skill instead');
    database.prepare('DELETE FROM entry_links WHERE from_entry_id = ? OR to_entry_id = ?').run(input.entryId, input.entryId);
    database.prepare('DELETE FROM audit_events WHERE entry_id = ?').run(input.entryId);
    database.prepare('DELETE FROM entries WHERE id = ? AND workspace = ?').run(input.entryId, input.workspace);
    recordAuditEvent(database, {
      entryId: null,
      workspace: input.workspace,
      operation: 'purge',
      actor,
      details: { purgedEntryId: input.entryId, warning: 'Backups may still contain the purged content' },
      createdAt: now,
    });
  });
}
