import { createHash } from 'node:crypto';
import { assertAtomicCleanupComplete, atomicWriteTextIfUnchanged } from '../agent-file/atomic-write.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { withDeferredReadTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readEntry } from '../memory/entries.js';
import { findSecretInValue } from '../memory/secrets.js';
import { canonicalEntryRevisionContentHash, canonicalJson, requireWorkspace } from '../serialization/validate.js';
import {
  WORKSPACE_ARCHIVE_MAX_BYTES,
  validateWorkspaceArchiveByteLayout,
} from './import.js';

export interface ExportOptions {
  workspace: string;
  output?: string;
}

export interface ExportResult {
  workspace: string;
  count: number;
  checksum: string;
  output?: string;
  content: string;
}

interface ExportLine {
  type: string;
  [key: string]: unknown;
}

const RELATIONS = new Set(['supports', 'contradicts', 'derived_from', 'related_to']);
const AUDIT_OPERATIONS = new Set(['record', 'promote', 'supersede', 'link', 'import', 'purge']);
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function rows(database: SqliteDatabase, sql: string, ...parameters: (string | number)[]): Record<string, unknown>[] {
  return database.prepare(sql).all<Record<string, unknown>>(...parameters);
}

function rejectStoredSecret(value: unknown): void {
  const finding = findSecretInValue(value);
  if (finding !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'Stored workspace archive data contains secret-like content', {
      kind: finding.kind,
    });
  }
}

function canonicalStoredJson(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new KiokukoError('INTEGRITY_ERROR', `Stored ${label} is not text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
    throw new KiokukoError('INTEGRITY_ERROR', `Stored ${label} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KiokukoError('INTEGRITY_ERROR', `Stored ${label} is not a JSON object`);
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch (error) {
    if (error instanceof RangeError
      || (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR')) {
      throw new KiokukoError('INTEGRITY_ERROR', `Stored ${label} is not canonical JSON`);
    }
    throw error;
  }
  if (canonical !== value) throw new KiokukoError('INTEGRITY_ERROR', `Stored ${label} is not canonical JSON`);
  rejectStoredSecret(parsed);
  return canonical;
}

function storedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KiokukoError('INTEGRITY_ERROR', `Stored ${label} is invalid`);
  }
  return value;
}

function storedTimestamp(value: unknown, label: string): string {
  const timestamp = storedString(value, label);
  const parsed = Date.parse(timestamp);
  if (!TIMESTAMP_PATTERN.test(timestamp) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new KiokukoError('INTEGRITY_ERROR', `Stored ${label} is not a canonical timestamp`);
  }
  return timestamp;
}

function validateExportSupersession(entries: readonly ReturnType<typeof readEntry>[]): void {
  const replacements = new Map(entries.map((entry) => [entry.id, entry.supersededBy] as const));
  const state = new Map<string, 'visiting' | 'complete'>();
  for (const entry of entries) {
    if (state.get(entry.id) === 'complete') continue;
    const path: string[] = [];
    let current: string | null = entry.id;
    while (current !== null) {
      if (!replacements.has(current)) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored supersession crosses the exported workspace');
      }
      const currentState = state.get(current);
      if (currentState === 'visiting') throw new KiokukoError('INTEGRITY_ERROR', 'Stored entries contain a supersession cycle');
      if (currentState === 'complete') break;
      state.set(current, 'visiting');
      path.push(current);
      current = replacements.get(current) ?? null;
    }
    for (const visited of path) state.set(visited, 'complete');
  }
}

/**
 * Export a complete workspace snapshot as deterministic, checksummed JSONL.
 * The first line is the checksum of every following line, including its final newline.
 */
function exportWorkspaceInSnapshot(database: SqliteDatabase, options: ExportOptions): ExportResult {
  const workspace = requireWorkspace(options.workspace);
  const entryRows = rows(
    database,
    'SELECT id FROM entries WHERE workspace = ? ORDER BY id ASC',
    workspace,
  );
  const decodedEntries = entryRows.map((row) => {
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored entry identity is invalid');
    }
    const entry = readEntry(database, { workspace, entryId: row.id });
    if (entry.revision !== 1) {
      throw new KiokukoError(
        'VALIDATION_ERROR',
        'Workspace archive v1 cannot represent revision history; use a full SQLite backup for entries newer than revision 1',
        { entryId: entry.id, revision: entry.revision },
      );
    }
    const canonicalHash = canonicalEntryRevisionContentHash({
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      summary: entry.summary,
      scope: entry.scope,
      provenance: entry.provenance,
      tags: entry.tags,
    });
    if (canonicalHash !== entry.contentHash) {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        'Stored entry revision hash is not canonical',
      );
    }
    return entry;
  });
  const entries: Record<string, unknown>[] = decodedEntries.map((entry) => ({
    id: entry.id,
    workspace: entry.workspace,
    kind: entry.kind,
    status: entry.status,
    title: entry.title,
    body: entry.body,
    summary: entry.summary,
    scope_json: canonicalJson(entry.scope),
    provenance_json: canonicalJson(entry.provenance),
    trust_level: entry.trustLevel,
    confidence: entry.confidence,
    content_hash: entry.contentHash,
    revision: entry.revision,
    superseded_by: entry.supersededBy,
    created_by: entry.createdBy,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    verified_at: entry.verifiedAt,
  }));
  rejectStoredSecret(decodedEntries);
  const entryIds = new Set(entries.map((entry) => String(entry.id)));
  validateExportSupersession(decodedEntries);
  const tags = decodedEntries.flatMap((entry) => entry.tags.map((tag) => ({ entry_id: entry.id, tag })));
  const linkRows = rows(
    database,
    `SELECT l.from_entry_id, l.to_entry_id, l.relation, l.created_at, l.created_by,
            from_entry.workspace AS from_workspace, to_entry.workspace AS to_workspace
     FROM entry_links AS l
     LEFT JOIN entries AS from_entry ON from_entry.id = l.from_entry_id
     LEFT JOIN entries AS to_entry ON to_entry.id = l.to_entry_id
     WHERE from_entry.workspace = ? OR to_entry.workspace = ?
     ORDER BY l.from_entry_id ASC, l.to_entry_id ASC, l.relation ASC`,
    workspace,
    workspace,
  );
  const links = linkRows.map((link) => {
    const from = storedString(link.from_entry_id, 'link.from_entry_id');
    const to = storedString(link.to_entry_id, 'link.to_entry_id');
    const relation = storedString(link.relation, 'link.relation');
    if (link.from_workspace !== workspace || link.to_workspace !== workspace
      || !entryIds.has(from) || !entryIds.has(to) || !RELATIONS.has(relation)) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored link crosses or does not belong to the exported workspace');
    }
    return {
      from_entry_id: from,
      to_entry_id: to,
      relation,
      created_at: storedTimestamp(link.created_at, 'link.created_at'),
      created_by: storedString(link.created_by, 'link.created_by'),
    };
  });
  const auditRows = rows(
    database,
    `SELECT audit.event_id, audit.entry_id, audit.workspace, audit.operation, audit.actor,
            audit.details_json, audit.created_at, entry.workspace AS entry_workspace
       FROM audit_events AS audit
       LEFT JOIN entries AS entry ON entry.id = audit.entry_id
      WHERE audit.workspace = ? OR entry.workspace = ?
      ORDER BY audit.event_id ASC`,
    workspace,
    workspace,
  );
  const audit: Record<string, unknown>[] = auditRows.map((event) => {
    const eventId = storedString(event.event_id, 'audit.event_id');
    const operation = storedString(event.operation, 'audit.operation');
    const actor = storedString(event.actor, 'audit.actor');
    if (event.workspace !== workspace || !AUDIT_OPERATIONS.has(operation)) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored audit event does not belong to the exported workspace');
    }
    let entryId: string | null = null;
    if (event.entry_id !== null) {
      entryId = storedString(event.entry_id, 'audit.entry_id');
      if (event.entry_workspace !== workspace || !entryIds.has(entryId)) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored audit event references an entry outside the exported workspace');
      }
    }
    return {
      event_id: eventId,
      entry_id: entryId,
      workspace,
      operation,
      actor,
      details_json: canonicalStoredJson(event.details_json, 'audit details'),
      created_at: storedTimestamp(event.created_at, 'audit.created_at'),
    };
  });

  const manifest: ExportLine = {
    type: 'manifest',
    apiVersion: '1',
    workspace,
    format: 'kiokuko-jsonl',
    version: 1,
    counts: { entries: entries.length, tags: tags.length, links: links.length, audit: audit.length },
  };
  const payloadLines: ExportLine[] = [
    manifest,
    ...entries.map((entry) => ({ type: 'entry', ...entry })),
    ...tags.map((tag) => ({ type: 'tag', ...tag })),
    ...links.map((link) => ({ type: 'link', ...link })),
    ...audit.map((event) => ({ type: 'audit', ...event })),
  ];
  rejectStoredSecret(payloadLines);
  const payload = `${payloadLines.map((value) => canonicalJson(value)).join('\n')}\n`;
  const checksum = createHash('sha256').update(payload, 'utf8').digest('hex');
  const content = `${canonicalJson({ type: 'checksum', sha256: checksum })}\n${payload}`;
  if (Buffer.byteLength(content, 'utf8') > WORKSPACE_ARCHIVE_MAX_BYTES) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      `Workspace archive exceeds the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte maximum`,
    );
  }
  validateWorkspaceArchiveByteLayout(Buffer.from(content, 'utf8'));
  return { workspace, count: entries.length, checksum, ...(options.output === undefined ? {} : { output: options.output }), content };
}

export function exportWorkspace(database: SqliteDatabase, options: ExportOptions): ExportResult {
  return withDeferredReadTransaction(database, () => exportWorkspaceInSnapshot(database, options));
}

export async function writeExport(database: SqliteDatabase, options: ExportOptions & { output: string }): Promise<ExportResult> {
  const result = exportWorkspace(database, options);
  const outcome = await atomicWriteTextIfUnchanged(
    options.output,
    result.content,
    { expected: undefined },
    0o600,
  );
  assertAtomicCleanupComplete(outcome);
  return result;
}
