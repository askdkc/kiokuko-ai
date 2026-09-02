import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError, storedMemoryIntegrityError } from '../errors.js';
import { enqueueCurrentEntryEmbeddingInTransaction } from '../embedding/jobs.js';
import { canonicalEntryRevisionContentHash, canonicalJson, type JsonObject, validateRecordInput, requireWorkspace, type EntryKind, type EntryStatus, type TrustLevel, type ValidatedRecordInput } from '../serialization/validate.js';
import { recordAuditEvent } from './audit.js';
import { findSecret } from './secrets.js';
import { syncEntrySearchProjection } from './structured-memory.js';
import { decodeStoredMemoryRow, insertEntryRevisionInTransaction, normalizeStructuredScopeInput, type DecodeStoredMemoryOptions } from './revisions.js';

export interface RecordEntryInput {
  workspace: string;
  kind: EntryKind;
  status?: EntryStatus;
  title: string;
  body: string;
  summary?: string | null;
  scope?: JsonObject;
  provenance?: JsonObject;
  trustLevel?: TrustLevel;
  confidence?: number;
  tags?: string[];
  createdBy?: string;
  actor?: string;
}

export interface RecordEntryOptions {
  now?: string;
  idFactory?: () => string;
}

export interface ReadEntryInput {
  workspace: string;
  entryId: string;
}

export interface UpdateCandidateEntryInput {
  workspace: string;
  entryId: string;
  expectedRevision: number;
  kind: EntryKind;
  title: string;
  body: string;
  summary?: string | null;
  scope?: JsonObject;
  provenance?: JsonObject;
  tags?: string[];
  createdBy?: string;
  actor?: string;
  now?: string;
}

export interface EntryRecord {
  id: string;
  workspace: string;
  kind: EntryKind;
  status: EntryStatus;
  title: string;
  body: string;
  summary: string | null;
  scope: JsonObject;
  provenance: JsonObject;
  trustLevel: TrustLevel;
  confidence: number;
  contentHash: string;
  revision: number;
  supersededBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  tags: string[];
}

interface EntryRow extends SqliteRow {
  id: unknown;
  workspace: unknown;
  status: unknown;
  trust_level: unknown;
  confidence: unknown;
  current_revision: unknown;
  min_revision: unknown;
  max_revision: unknown;
  revision_count: unknown;
  invalid_revision_count: unknown;
  revision_entry_id: unknown;
  revision_workspace: unknown;
  kind: unknown;
  title: unknown;
  body: unknown;
  summary: unknown;
  scope_json: unknown;
  provenance_json: unknown;
  content_hash: unknown;
  superseded_by: unknown;
  created_by: unknown;
  created_at: unknown;
  updated_at: unknown;
  verified_at: unknown;
  revision_created_by: unknown;
  revision_created_at: unknown;
}

function rowToEntry(database: SqliteDatabase, row: EntryRow, options: DecodeStoredMemoryOptions = {}): EntryRecord {
  if (typeof row.revision_entry_id !== 'string' || !Number.isSafeInteger(row.current_revision)) {
    throw storedMemoryIntegrityError();
  }
  const tags = database
    .prepare('SELECT tag FROM entry_revision_tags WHERE entry_id = ? AND revision = ? ORDER BY tag ASC')
    .all<{ tag: unknown }>(row.revision_entry_id, Number(row.current_revision))
    .map((tag) => tag.tag);
  const decoded = decodeStoredMemoryRow({
    revision: {
      entryId: row.revision_entry_id,
      workspace: row.revision_workspace,
      revision: row.current_revision,
      kind: row.kind,
      title: row.title,
      body: row.body,
      summary: row.summary,
      scopeJson: row.scope_json,
      provenanceJson: row.provenance_json,
      contentHash: row.content_hash,
      createdBy: row.revision_created_by,
      createdAt: row.revision_created_at,
    },
    tags,
    entry: {
      id: row.id,
      workspace: row.workspace,
      status: row.status,
      trustLevel: row.trust_level,
      confidence: row.confidence,
      currentRevision: row.current_revision,
      minRevision: row.min_revision,
      maxRevision: row.max_revision,
      revisionCount: row.revision_count,
      invalidRevisionCount: row.invalid_revision_count,
      supersededBy: row.superseded_by,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      verifiedAt: row.verified_at,
    },
    options,
  });
  const entry = decoded.entry;
  if (entry === undefined) throw storedMemoryIntegrityError();
  const revision = decoded.revision;
  return {
    id: entry.id,
    workspace: entry.workspace,
    kind: revision.kind,
    status: entry.status,
    title: revision.title,
    body: revision.body,
    summary: revision.summary,
    scope: revision.scope,
    provenance: revision.provenance,
    trustLevel: entry.trustLevel,
    confidence: entry.confidence,
    contentHash: revision.contentHash,
    revision: revision.revision,
    supersededBy: entry.supersededBy,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    verifiedAt: entry.verifiedAt,
    tags: revision.tags,
  };
}

function selectEntry(database: SqliteDatabase, workspace: string, entryId: string, options: DecodeStoredMemoryOptions = {}): EntryRecord | undefined {
  const row = database
    .prepare(
      `SELECT e.id, e.workspace, e.status, e.trust_level, e.confidence,
              e.current_revision,
              (SELECT MIN(all_revisions.revision)
                 FROM entry_revisions AS all_revisions
                WHERE all_revisions.entry_id = e.id) AS min_revision,
              (SELECT MAX(all_revisions.revision)
                 FROM entry_revisions AS all_revisions
                WHERE all_revisions.entry_id = e.id) AS max_revision,
              (SELECT COUNT(all_revisions.revision)
                 FROM entry_revisions AS all_revisions
                WHERE all_revisions.entry_id = e.id) AS revision_count,
              (SELECT COUNT(*)
                 FROM entry_revisions AS all_revisions
                WHERE all_revisions.entry_id = e.id
                  AND (typeof(all_revisions.revision) <> 'integer' OR all_revisions.revision < 1)) AS invalid_revision_count,
              r.entry_id AS revision_entry_id,
              r.workspace AS revision_workspace, r.kind, r.title, r.body, r.summary,
              r.scope_json, r.provenance_json, r.content_hash, e.superseded_by,
              e.created_by, e.created_at, e.updated_at, e.verified_at,
              r.created_by AS revision_created_by, r.created_at AS revision_created_at
         FROM entries AS e
         JOIN entry_revisions AS r
           ON r.entry_id = e.id AND r.revision = e.current_revision
        WHERE e.id = ? AND e.workspace = ?`,
    )
    .get<EntryRow>(entryId, workspace);
  if (row) return rowToEntry(database, row, options);
  const orphan = database.prepare('SELECT 1 AS present FROM entries WHERE id = ? AND workspace = ?').get<{ present: number }>(entryId, workspace);
  if (orphan !== undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Stored entry points to a missing current revision');
  return undefined;
}

function semanticRevision(
  database: SqliteDatabase,
  workspace: string,
  canonicalHash: string,
): { id: string; revision: number } | undefined {
  return database.prepare(`
    SELECT entry_id AS id, revision
      FROM entry_revisions
     WHERE workspace = ? AND content_hash = ?
  `).get<{ id: string; revision: number }>(workspace, canonicalHash);
}

/** Validate and canonicalize every input-derived field used to create a new entry. */
export function validateNewEntryInput(input: RecordEntryInput): {
  record: ValidatedRecordInput;
  contentHash: string;
} {
  const validated = validateRecordInput(input);
  const canonicalScope = normalizeStructuredScopeInput(validated.scope);
  const secretFinding = findSecret(canonicalJson({
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: canonicalScope,
    provenance: validated.provenance,
    tags: validated.tags,
  }));
  if (secretFinding) {
    throw new KiokukoError('SECURITY_REJECTION', 'Entry content resembles a secret and was not stored', { kind: secretFinding.kind });
  }
  if (validated.status === 'superseded') {
    throw new KiokukoError('CONFLICT', 'A new entry cannot start in superseded status');
  }
  const contentHash = canonicalEntryRevisionContentHash({
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: canonicalScope,
    provenance: validated.provenance,
    tags: validated.tags,
  });
  return { record: { ...validated, scope: canonicalScope }, contentHash };
}

export function recordEntryInTransaction(database: SqliteDatabase, input: RecordEntryInput, options: RecordEntryOptions = {}): EntryRecord {
  const { record: validated, contentHash } = validateNewEntryInput(input);
  const now = options.now ?? new Date().toISOString();
  const idFactory = options.idFactory ?? randomUUID;

  const existing = semanticRevision(database, validated.workspace, contentHash);
  if (existing) {
    const record = selectEntry(database, validated.workspace, existing.id);
    if (!record) throw new KiokukoError('INTEGRITY_ERROR', 'Entry hash index points to a missing entry');
    if (record.revision !== Number(existing.revision) || record.contentHash !== contentHash) {
      throw new KiokukoError('CONFLICT', 'This content exists only as a historical entry revision');
    }
    if (record.status !== validated.status
      || record.trustLevel !== validated.trustLevel
      || record.confidence !== validated.confidence
      || record.createdBy !== validated.createdBy) {
      throw new KiokukoError('CONFLICT', 'Current entry content exists with different record metadata');
    }
    return record;
  }

  const id = idFactory();
  const verifiedAt = validated.status === 'verified' ? now : null;
  database
    .prepare(
      `INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      validated.workspace,
      validated.status,
      validated.trustLevel,
      validated.confidence,
      1,
      null,
      validated.createdBy,
      now,
      now,
      verifiedAt,
    );

  insertEntryRevisionInTransaction(database, {
    entryId: id,
    workspace: validated.workspace,
    revision: 1,
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
    contentHash,
    createdBy: validated.createdBy,
    createdAt: now,
  });
  syncEntrySearchProjection(database, {
    entryId: id,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    tags: validated.tags,
    scope: validated.scope,
  });
  enqueueCurrentEntryEmbeddingInTransaction(database, {
    entryId: id,
    revision: 1,
    contentHash,
    now,
  });

  recordAuditEvent(database, {
    entryId: id,
    workspace: validated.workspace,
    operation: 'record',
    actor: validated.actor,
    details: { contentHash, status: validated.status },
    createdAt: now,
  });

  const record = selectEntry(database, validated.workspace, id);
  if (!record) throw new KiokukoError('INTEGRITY_ERROR', 'Recorded entry could not be read back');
  return record;
}

export function recordEntry(database: SqliteDatabase, input: RecordEntryInput, options: RecordEntryOptions = {}): EntryRecord {
  return withImmediateTransaction(database, () => recordEntryInTransaction(database, input, options));
}

export function readEntry(database: SqliteDatabase, input: ReadEntryInput, options: DecodeStoredMemoryOptions = {}): EntryRecord {
  const workspace = requireWorkspace(input.workspace);
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'entryId must be a non-empty string');
  }
  const record = selectEntry(database, workspace, input.entryId, options);
  if (!record) throw new KiokukoError('NOT_FOUND', 'Entry not found');
  return record;
}

function updateCandidateEntryInTransactionInternal(database: SqliteDatabase, input: UpdateCandidateEntryInput, allowManagedExternal: boolean): EntryRecord {
  const workspace = requireWorkspace(input.workspace);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'expectedRevision must be a positive integer');
  }
  if (!allowManagedExternal) {
    const managedExternal = database.prepare('SELECT 1 AS present FROM external_skill_entries WHERE entry_id = ? LIMIT 1').get<{ present: number }>(input.entryId);
    if (managedExternal) throw new KiokukoError('CONFLICT', 'Managed external Skill entries cannot be edited');
  }
  const createdBy = input.createdBy ?? 'kiokuko-web';
  const validated = validateRecordInput({
    workspace,
    kind: input.kind,
    status: 'candidate',
    title: input.title,
    body: input.body,
    summary: input.summary,
    scope: input.scope,
    provenance: input.provenance,
    tags: input.tags,
    createdBy,
    actor: input.actor ?? createdBy,
  });
  const canonicalScope = normalizeStructuredScopeInput(validated.scope);
  const secretFinding = findSecret(canonicalJson({
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: canonicalScope,
    provenance: validated.provenance,
    tags: validated.tags,
  }));
  if (secretFinding) throw new KiokukoError('SECURITY_REJECTION', 'Entry content resembles a secret and was not stored', { kind: secretFinding.kind });
  const contentHash = canonicalEntryRevisionContentHash({
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: canonicalScope,
    provenance: validated.provenance,
    tags: validated.tags,
  });
  const now = input.now ?? new Date().toISOString();

  const current = readEntry(database, { workspace, entryId: input.entryId });
  if (current.status !== 'candidate') throw new KiokukoError('CONFLICT', 'Verified or superseded entries must be replaced, not edited');
  if (current.revision !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Entry revision is stale');
  const duplicate = semanticRevision(database, workspace, contentHash);
  if (duplicate) {
    if (duplicate.id !== input.entryId) {
      throw new KiokukoError('CONFLICT', 'Another entry already contains this content');
    }
    throw new KiokukoError('CONFLICT', 'An entry revision already contains this content');
  }

  const nextRevision = input.expectedRevision + 1;
  insertEntryRevisionInTransaction(database, {
    entryId: input.entryId,
    workspace,
    revision: nextRevision,
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: canonicalScope,
    provenance: validated.provenance,
    tags: validated.tags,
    contentHash,
    createdBy,
    createdAt: now,
  });
  database.prepare(`
    UPDATE entries SET current_revision = ?, updated_at = ?, verified_at = NULL
     WHERE id = ? AND workspace = ? AND current_revision = ?
  `).run(
    nextRevision,
    now,
    input.entryId,
    workspace,
    input.expectedRevision,
  );
  const pointer = database.prepare('SELECT current_revision FROM entries WHERE id = ? AND workspace = ?').get<{ current_revision: number }>(input.entryId, workspace);
  if (!pointer || Number(pointer.current_revision) !== nextRevision) throw new KiokukoError('CONFLICT', 'Entry revision is stale');
  syncEntrySearchProjection(database, {
    entryId: input.entryId,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    tags: validated.tags,
    scope: canonicalScope,
  });
  enqueueCurrentEntryEmbeddingInTransaction(database, {
    entryId: input.entryId,
    revision: nextRevision,
    contentHash,
    now,
  });
  recordAuditEvent(database, {
    entryId: input.entryId,
    workspace,
    operation: 'record',
    actor: validated.actor,
    details: {
      edited: true,
      previousRevision: input.expectedRevision,
      revision: nextRevision,
      previousContentHash: current.contentHash,
      contentHash,
    },
    createdAt: now,
  });
  const updated = selectEntry(database, workspace, input.entryId);
  if (!updated) throw new KiokukoError('INTEGRITY_ERROR', 'Updated entry could not be read back');
  return updated;
}

export function updateCandidateEntry(database: SqliteDatabase, input: UpdateCandidateEntryInput): EntryRecord {
  return withImmediateTransaction(database, () => updateCandidateEntryInTransaction(database, input));
}

export function updateCandidateEntryInTransaction(database: SqliteDatabase, input: UpdateCandidateEntryInput): EntryRecord {
  return updateCandidateEntryInTransactionInternal(database, input, false);
}

/** Internal snapshot refresh path; callers must already be inside the import transaction. */
export function updateManagedExternalEntryInTransaction(database: SqliteDatabase, input: UpdateCandidateEntryInput): EntryRecord {
  return updateCandidateEntryInTransactionInternal(database, input, true);
}
