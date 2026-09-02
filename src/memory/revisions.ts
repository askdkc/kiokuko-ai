import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError, storedMemoryIntegrityError } from '../errors.js';
import {
  canonicalEntryRevisionContentHash,
  canonicalJson,
  ENTRY_STATUSES,
  requireWorkspace,
  TRUST_LEVELS,
  validateRecordInput,
  type EntryKind,
  type EntryStatus,
  type JsonObject,
  type TrustLevel,
} from '../serialization/validate.js';
import {
  buildStructuredScope,
  type Applicability,
  type MemoryClass,
  type MemorySignals,
  type RetrievalScope,
} from './structured-memory.js';

export interface EntryRevisionRecord {
  entryId: string;
  workspace: string;
  revision: number;
  kind: EntryKind;
  title: string;
  body: string;
  summary: string | null;
  scope: JsonObject;
  provenance: JsonObject;
  tags: string[];
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

export interface EntryRevisionInput {
  entryId: string;
  workspace: string;
  revision: number;
  kind: EntryKind;
  title: string;
  body: string;
  summary?: string | null;
  scope?: JsonObject;
  provenance?: JsonObject;
  tags?: string[];
  contentHash?: string;
  createdBy: string;
  createdAt: string;
}

interface RevisionRow extends SqliteRow {
  entry_id: unknown;
  workspace: unknown;
  revision: unknown;
  kind: unknown;
  title: unknown;
  body: unknown;
  summary: unknown;
  scope_json: unknown;
  provenance_json: unknown;
  content_hash: unknown;
  created_by: unknown;
  created_at: unknown;
}

export interface StoredRevisionValues {
  entryId: unknown;
  workspace: unknown;
  revision: unknown;
  kind: unknown;
  title: unknown;
  body: unknown;
  summary: unknown;
  scopeJson: unknown;
  provenanceJson: unknown;
  contentHash: unknown;
  createdBy: unknown;
  createdAt: unknown;
}

export interface StoredEntryValues {
  id: unknown;
  workspace: unknown;
  status: unknown;
  trustLevel: unknown;
  confidence: unknown;
  currentRevision: unknown;
  minRevision: unknown;
  maxRevision: unknown;
  revisionCount: unknown;
  invalidRevisionCount: unknown;
  supersededBy: unknown;
  createdBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  verifiedAt: unknown;
}

export interface DecodedStoredEntryValues {
  id: string;
  workspace: string;
  status: EntryStatus;
  trustLevel: TrustLevel;
  confidence: number;
  currentRevision: number;
  supersededBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}

export interface DecodeStoredMemoryOptions {
  requireStructuredScope?: boolean;
}

interface NodeSqliteConstraintFailure extends Error {
  readonly code?: unknown;
  readonly errcode?: unknown;
}

const SQLITE_CONSTRAINT_PRIMARY_KEY = 1_555;
const SQLITE_CONSTRAINT_UNIQUE = 2_067;
const REVISION_UNIQUENESS_FAILURES = new Set([
  'UNIQUE constraint failed: entry_revisions.entry_id, entry_revisions.revision',
  'UNIQUE constraint failed: entry_revisions.workspace, entry_revisions.content_hash',
]);

function isExpectedRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as NodeSqliteConstraintFailure;
  return failure.code === 'ERR_SQLITE_ERROR'
    && (failure.errcode === SQLITE_CONSTRAINT_PRIMARY_KEY || failure.errcode === SQLITE_CONSTRAINT_UNIQUE)
    && REVISION_UNIQUENESS_FAILURES.has(failure.message);
}

function storedIntegrity(): never {
  throw storedMemoryIntegrityError();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function storedNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) storedIntegrity();
  return value;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseStoredObject(value: unknown): JsonObject {
  if (typeof value !== 'string') storedIntegrity();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) storedIntegrity();
    throw error;
  }
  if (!isPlainObject(parsed)) storedIntegrity();
  try {
    if (canonicalJson(parsed) !== value) storedIntegrity();
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') storedIntegrity();
    throw error;
  }
  return parsed as JsonObject;
}

export interface DecodedStoredStructuredScope {
  scope: JsonObject;
  canonicalScope: JsonObject;
}

/** Normalize caller-supplied structured scope before it is persisted. */
export function normalizeStructuredScopeInput(scope: JsonObject): JsonObject {
  if (!hasOwn(scope, 'schemaVersion')) {
    return scope;
  }
  const allowed = new Set([
    'schemaVersion', 'visibility', 'retrievalScope', 'repositoryId', 'memoryClass',
    'applicability', 'signals', 'portableReason',
  ]);
  if (Object.keys(scope).some((field) => !allowed.has(field))) {
    throw new KiokukoError('VALIDATION_ERROR', 'Structured memory scope contains an unknown field');
  }
  if (scope.schemaVersion !== 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Structured memory scope schemaVersion is unsupported');
  }
  let normalized = buildStructuredScope({
    visibility: scope.visibility as 'project' | 'global',
    ...(hasOwn(scope, 'retrievalScope') ? { retrievalScope: scope.retrievalScope as RetrievalScope } : {}),
    ...(hasOwn(scope, 'repositoryId') ? { repositoryId: scope.repositoryId as string } : {}),
    ...(hasOwn(scope, 'memoryClass') ? { memoryClass: scope.memoryClass as MemoryClass } : {}),
    ...(hasOwn(scope, 'applicability') ? { applicability: scope.applicability as Applicability } : {}),
    ...(hasOwn(scope, 'signals') ? { signals: scope.signals as MemorySignals } : {}),
    ...(hasOwn(scope, 'portableReason') ? { portableReason: scope.portableReason as string } : {}),
  });
  return normalized;
}

function normalizeStoredStructuredScope(scope: JsonObject, required: boolean): JsonObject {
  if (required && scope.schemaVersion !== 1) storedIntegrity();
  try {
    return normalizeStructuredScopeInput(scope);
  } catch (error) {
    if (error instanceof KiokukoError && (error.code === 'VALIDATION_ERROR' || error.code === 'SECURITY_REJECTION')) storedIntegrity();
    throw error;
  }
}

/** Decode only the canonical persisted structured-scope representation. */
export function decodeStoredStructuredScope(scope: JsonObject, required = false): DecodedStoredStructuredScope {
  const normalized = normalizeStoredStructuredScope(scope, required);
  if (canonicalJson(normalized) !== canonicalJson(scope)) storedIntegrity();
  return { scope: normalized, canonicalScope: normalized };
}

function normalizedStoredRecord(
  input: StoredRevisionValues,
  tags: unknown[],
  options: DecodeStoredMemoryOptions,
): EntryRevisionRecord {
  const entryId = storedNonEmptyString(input.entryId);
  const createdBy = storedNonEmptyString(input.createdBy);
  const createdAt = storedNonEmptyString(input.createdAt);
  if (!canonicalTimestamp(createdAt)
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1
    || input.summary !== null && typeof input.summary !== 'string'
    || !Array.isArray(tags)) storedIntegrity();
  const decodedScope = decodeStoredStructuredScope(parseStoredObject(input.scopeJson), options.requireStructuredScope === true);
  const scope = decodedScope.canonicalScope;
  const provenance = parseStoredObject(input.provenanceJson);
  let validated: ReturnType<typeof validateRecordInput>;
  try {
    validated = validateRecordInput({
      workspace: input.workspace,
      kind: input.kind,
      status: 'candidate',
      title: input.title,
      body: input.body,
      summary: input.summary,
      scope,
      provenance,
      trustLevel: 'user_asserted',
      confidence: 1,
      tags,
      createdBy,
      actor: createdBy,
    });
  } catch (error) {
    if (error instanceof KiokukoError && (error.code === 'VALIDATION_ERROR' || error.code === 'SECURITY_REJECTION')) storedIntegrity();
    throw error;
  }
  if (validated.tags.length !== tags.length) storedIntegrity();
  const hashInput = {
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  };
  const contentHash = canonicalEntryRevisionContentHash(hashInput);
  if (input.contentHash !== contentHash) storedIntegrity();
  return {
    entryId,
    workspace: validated.workspace,
    revision: Number(input.revision),
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: decodedScope.canonicalScope,
    provenance: validated.provenance,
    tags: validated.tags,
    contentHash,
    createdBy,
    createdAt,
  };
}

function decodedStoredEntry(input: StoredEntryValues, revision: EntryRevisionRecord): DecodedStoredEntryValues {
  const id = storedNonEmptyString(input.id);
  const workspace = storedNonEmptyString(input.workspace);
  const createdBy = storedNonEmptyString(input.createdBy);
  const createdAt = storedNonEmptyString(input.createdAt);
  const updatedAt = storedNonEmptyString(input.updatedAt);
  if (id !== revision.entryId || workspace !== revision.workspace
    || !Number.isSafeInteger(input.currentRevision) || input.currentRevision !== revision.revision
    || input.minRevision !== 1
    || !Number.isSafeInteger(input.maxRevision) || input.currentRevision !== input.maxRevision
    || !Number.isSafeInteger(input.revisionCount) || input.revisionCount !== input.maxRevision
    || input.invalidRevisionCount !== 0
    || typeof input.status !== 'string' || !ENTRY_STATUSES.includes(input.status as EntryStatus)
    || typeof input.trustLevel !== 'string' || !TRUST_LEVELS.includes(input.trustLevel as TrustLevel)
    || typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1
    || input.supersededBy !== null && (typeof input.supersededBy !== 'string' || input.supersededBy.trim().length === 0)
    || input.verifiedAt !== null && (typeof input.verifiedAt !== 'string' || input.verifiedAt.trim().length === 0)) storedIntegrity();
  const status = input.status as EntryStatus;
  const supersededBy = input.supersededBy as string | null;
  const verifiedAt = input.verifiedAt as string | null;
  if ((status === 'superseded') !== (supersededBy !== null)
    || status === 'candidate' && verifiedAt !== null
    || status === 'verified' && verifiedAt === null
    || !canonicalTimestamp(createdAt) || !canonicalTimestamp(updatedAt)
    || verifiedAt !== null && !canonicalTimestamp(verifiedAt)
    || createdAt > revision.createdAt || revision.createdAt > updatedAt
    || createdAt > updatedAt
    || verifiedAt !== null && (verifiedAt < createdAt || verifiedAt > updatedAt)) storedIntegrity();
  return {
    id,
    workspace,
    status,
    trustLevel: input.trustLevel as TrustLevel,
    confidence: input.confidence,
    currentRevision: input.currentRevision,
    supersededBy,
    createdBy,
    createdAt,
    updatedAt,
    verifiedAt,
  };
}

/** Decode persisted entry/revision data without trusting TypeScript row casts. */
export function decodeStoredMemoryRow(input: {
  revision: StoredRevisionValues;
  tags: unknown[];
  entry?: StoredEntryValues;
  options?: DecodeStoredMemoryOptions;
}): { revision: EntryRevisionRecord; entry?: DecodedStoredEntryValues } {
  const revision = normalizedStoredRecord(input.revision, input.tags, input.options ?? {});
  if (input.entry === undefined) return { revision };
  return { revision, entry: decodedStoredEntry(input.entry, revision) };
}

function revisionKey(input: { entryId: string; workspace: string; revision: number }): void {
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'entryId must be a non-empty string');
  }
  requireWorkspace(input.workspace);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'revision must be a positive integer');
  }
}

interface RevisionChainRow extends SqliteRow {
  workspace: unknown;
  current_revision: unknown;
  min_revision: unknown;
  max_revision: unknown;
  revision_count: unknown;
  invalid_revision_count: unknown;
}

function completeRevisionChain(row: RevisionChainRow): boolean {
  return Number.isSafeInteger(row.current_revision)
    && row.min_revision === 1
    && Number.isSafeInteger(row.max_revision)
    && row.current_revision === row.max_revision
    && Number.isSafeInteger(row.revision_count)
    && row.revision_count === row.max_revision
    && row.invalid_revision_count === 0;
}

function ownerRevisionChain(database: SqliteDatabase, entryId: string): RevisionChainRow | undefined {
  return database.prepare(`
    SELECT e.workspace, e.current_revision,
           MIN(r.revision) AS min_revision,
           MAX(r.revision) AS max_revision,
           COUNT(r.revision) AS revision_count,
           COUNT(CASE
             WHEN r.revision IS NOT NULL
              AND (typeof(r.revision) <> 'integer' OR r.revision < 1)
             THEN 1
           END) AS invalid_revision_count
      FROM entries AS e
      LEFT JOIN entry_revisions AS r ON r.entry_id = e.id
     WHERE e.id = ?
     GROUP BY e.id
  `).get<RevisionChainRow>(entryId);
}

function tagsFor(database: SqliteDatabase, entryId: string, revision: number): unknown[] {
  return database
    .prepare('SELECT tag FROM entry_revision_tags WHERE entry_id = ? AND revision = ? ORDER BY tag ASC')
    .all<{ tag: unknown }>(entryId, revision)
    .map((row) => row.tag);
}

function rowToRevision(database: SqliteDatabase, row: RevisionRow, checkOwnerChronology = true): EntryRevisionRecord {
  const entryId = storedNonEmptyString(row.entry_id);
  if (!Number.isSafeInteger(row.revision)) storedIntegrity();
  const tags = tagsFor(database, entryId, Number(row.revision));
  const decoded = decodeStoredMemoryRow({
    revision: {
      entryId,
      workspace: row.workspace,
      revision: row.revision,
      kind: row.kind,
      title: row.title,
      body: row.body,
      summary: row.summary,
      scopeJson: row.scope_json,
      provenanceJson: row.provenance_json,
      contentHash: row.content_hash,
      createdBy: row.created_by,
      createdAt: row.created_at,
    },
    tags,
  }).revision;
  if (checkOwnerChronology) {
    const owner = database.prepare(`
      SELECT e.created_at, e.updated_at, e.current_revision,
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
                 AND (typeof(all_revisions.revision) <> 'integer' OR all_revisions.revision < 1)) AS invalid_revision_count
        FROM entries AS e
       WHERE e.id = ? AND e.workspace = ?
    `).get<{
      created_at: unknown;
      updated_at: unknown;
      current_revision: unknown;
      min_revision: unknown;
      max_revision: unknown;
      revision_count: unknown;
      invalid_revision_count: unknown;
    }>(decoded.entryId, decoded.workspace);
    if (owner === undefined || !canonicalTimestamp(owner.created_at) || !canonicalTimestamp(owner.updated_at)
      || !completeRevisionChain({ workspace: decoded.workspace, ...owner })
      || owner.created_at > decoded.createdAt || decoded.createdAt > owner.updated_at) storedIntegrity();
  }
  return decoded;
}

function selectRevision(
  database: SqliteDatabase,
  input: { entryId: string; workspace: string; revision: number },
  checkOwnerChronology = true,
): EntryRevisionRecord | undefined {
  const row = database.prepare(`
    SELECT entry_id, workspace, revision, kind, title, body, summary,
           scope_json, provenance_json, content_hash, created_by, created_at
      FROM entry_revisions
     WHERE entry_id = ? AND workspace = ? AND revision = ?
  `).get<RevisionRow>(input.entryId, input.workspace, input.revision);
  return row === undefined ? undefined : rowToRevision(database, row, checkOwnerChronology);
}

export function readEntryRevision(database: SqliteDatabase, input: { entryId: string; workspace: string; revision: number }): EntryRevisionRecord {
  revisionKey(input);
  const result = selectRevision(database, input);
  if (result === undefined) throw new KiokukoError('NOT_FOUND', 'Entry revision not found');
  return result;
}

export function findEntryRevision(database: SqliteDatabase, input: { entryId: string; workspace: string; revision: number }): EntryRevisionRecord | undefined {
  revisionKey(input);
  return selectRevision(database, input);
}

export function insertEntryRevisionInTransaction(database: SqliteDatabase, input: EntryRevisionInput): EntryRevisionRecord {
  revisionKey(input);
  if (typeof input.createdBy !== 'string' || input.createdBy.length === 0 || typeof input.createdAt !== 'string' || input.createdAt.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Revision creator and timestamp are required');
  }
  const owner = ownerRevisionChain(database, input.entryId);
  if (owner === undefined) throw new KiokukoError('NOT_FOUND', 'Entry not found');
  if (owner.workspace !== input.workspace) throw new KiokukoError('NOT_FOUND', 'Entry does not belong to workspace');
  let nextRevision: number;
  if (owner.revision_count === 0) {
    if (owner.min_revision !== null || owner.max_revision !== null || owner.current_revision !== 1) storedIntegrity();
    nextRevision = 1;
  } else {
    if (!completeRevisionChain(owner)) storedIntegrity();
    nextRevision = Number(owner.max_revision) + 1;
  }
  if (input.revision !== nextRevision) {
    throw new KiokukoError('CONFLICT', 'Entry revision must be the exact next revision', {
      expectedRevision: nextRevision,
      actualRevision: input.revision,
    });
  }

  const validated = validateRecordInput({
    workspace: input.workspace,
    kind: input.kind,
    title: input.title,
    body: input.body,
    summary: input.summary,
    scope: input.scope,
    provenance: input.provenance,
    tags: input.tags,
    createdBy: input.createdBy,
    actor: input.createdBy,
  });
  const canonicalScope = normalizeStructuredScopeInput(validated.scope);
  const contentHash = canonicalEntryRevisionContentHash({
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: canonicalScope,
    provenance: validated.provenance,
    tags: validated.tags,
  });
  if (input.contentHash !== undefined && input.contentHash !== contentHash) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Entry revision content hash does not match its content');
  }
  try {
    database.prepare(`
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, summary, scope_json,
        provenance_json, content_hash, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.entryId,
      input.workspace,
      input.revision,
      validated.kind,
      validated.title,
      validated.body,
      validated.summary,
      canonicalJson(canonicalScope),
      canonicalJson(validated.provenance),
      contentHash,
      input.createdBy,
      input.createdAt,
    );
  } catch (error) {
    if (isExpectedRevisionConflict(error)) {
      throw new KiokukoError('CONFLICT', 'Entry revision or content already exists');
    }
    throw error;
  }
  for (const tag of validated.tags) {
    database.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)').run(input.entryId, input.revision, tag);
  }
  const result = selectRevision(database, input, false);
  if (result === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Inserted entry revision could not be read back');
  return result;
}
