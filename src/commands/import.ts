import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { SqliteDatabase } from '../db/adapter.js';
import { enqueueCurrentEntryEmbeddingInTransaction } from '../embedding/jobs.js';
import { withDeferredReadTransaction, withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { findSecretInValue } from '../memory/secrets.js';
import { readEntry, type EntryRecord } from '../memory/entries.js';
import { insertEntryRevisionInTransaction } from '../memory/revisions.js';
import { syncEntrySearchProjection } from '../memory/structured-memory.js';
import { isWellFormedUnicode } from '../serialization/boundary-json.js';
import {
  canonicalEntryRevisionContentHash,
  canonicalJson,
  requireWorkspace,
  validateRecordInput,
  type EntryKind,
  type EntryStatus,
  type JsonObject,
  type TrustLevel,
} from '../serialization/validate.js';
import { parseStrictJson } from '../setup/strict-json.js';

export interface ImportOptions {
  input: string;
  dryRun?: boolean;
  workspace?: string;
}

export interface ImportResult {
  count: number;
  imported: number;
  duplicates: number;
  dryRun: boolean;
  workspace: string | null;
}

export interface ImportDependencies {
  afterInputPlanned?: (filePath: string) => Promise<void> | void;
  afterInputBound?: (filePath: string) => Promise<void> | void;
  afterInputRead?: (filePath: string) => Promise<void> | void;
}

export const WORKSPACE_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_ARCHIVE_MAX_LINES = 10_000;
export const WORKSPACE_ARCHIVE_MAX_LINE_BYTES = 512 * 1024;

interface ImportDocument {
  manifest: Record<string, unknown>;
  entries: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  links: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

interface ImportEntry {
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

const RELATIONS = new Set(['supports', 'contradicts', 'derived_from', 'related_to']);
const AUDIT_OPERATIONS = new Set(['record', 'promote', 'supersede', 'link', 'import', 'purge']);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RECORD_FIELDS = {
  checksum: ['type', 'sha256'],
  manifest: ['type', 'workspace', 'format', 'version', 'counts'],
  entry: [
    'type', 'id', 'workspace', 'kind', 'status', 'title', 'body', 'summary',
    'scope_json', 'provenance_json', 'trust_level', 'confidence', 'content_hash',
    'revision', 'superseded_by', 'created_by', 'created_at', 'updated_at', 'verified_at',
  ],
  tag: ['type', 'entry_id', 'tag'],
  link: ['type', 'from_entry_id', 'to_entry_id', 'relation', 'created_at', 'created_by'],
  audit: ['type', 'event_id', 'entry_id', 'workspace', 'operation', 'actor', 'details_json', 'created_at'],
} as const;
const COUNT_FIELDS = ['entries', 'tags', 'links', 'audit'] as const;
const STRICT_JSON_OPTIONS = {
  allowTrailingComma: false,
  disallowComments: true,
  allowEmptyContent: false,
} as const;

function archiveChanged(): KiokukoError {
  return new KiokukoError('CONFLICT', 'Import input changed while it was being read');
}

function isSameArchiveFileState(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertBindableArchiveFile(state: BigIntStats): void {
  if (!state.isFile()) throw new KiokukoError('VALIDATION_ERROR', 'Import input must be a regular file');
  if (state.ino === 0n) {
    throw new KiokukoError('SECURITY_REJECTION', 'Import input does not expose a stable file identity');
  }
}

function archiveOpenFlags(): number {
  if (process.platform === 'win32') return constants.O_RDONLY;
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0
    || !Number.isSafeInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0) {
    throw new KiokukoError('SECURITY_REJECTION', 'This platform cannot safely open an import archive');
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

async function readBoundedArchive(filePath: string, dependencies: ImportDependencies): Promise<Buffer> {
  const planned = await lstat(filePath, { bigint: true });
  assertBindableArchiveFile(planned);
  if (planned.size > BigInt(WORKSPACE_ARCHIVE_MAX_BYTES)) {
    throw new KiokukoError('VALIDATION_ERROR', `Workspace archive exceeds the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte maximum`);
  }
  await dependencies.afterInputPlanned?.(filePath);

  const handle = await open(filePath, archiveOpenFlags());
  let result: Buffer | undefined;
  let operationError: unknown;
  try {
    const initial = await handle.stat({ bigint: true });
    assertBindableArchiveFile(initial);
    if (!isSameArchiveFileState(planned, initial)) throw archiveChanged();
    await dependencies.afterInputBound?.(filePath);
    if (initial.size > BigInt(WORKSPACE_ARCHIVE_MAX_BYTES)) {
      throw new KiokukoError('VALIDATION_ERROR', `Workspace archive exceeds the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte maximum`);
    }
    const expectedSize = Number(initial.size);
    const buffer = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const { bytesRead } = await handle.read(buffer, offset, expectedSize - offset, offset);
      if (bytesRead === 0) throw archiveChanged();
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytesRead } = await handle.read(extra, 0, 1, expectedSize);
    if (extraBytesRead !== 0) throw archiveChanged();
    await dependencies.afterInputRead?.(filePath);

    const final = await handle.stat({ bigint: true });
    if (!isSameArchiveFileState(initial, final)) throw archiveChanged();
    const finalPath = await lstat(filePath, { bigint: true });
    if (!isSameArchiveFileState(final, finalPath)) throw archiveChanged();
    result = buffer;
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (operationError !== undefined) {
      throw new AggregateError([operationError, closeError], 'Import read failed and the input file could not be closed');
    }
    throw closeError;
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Import read produced no result');
  return result;
}

export function validateWorkspaceArchiveByteLayout(bytes: Uint8Array): void {
  if (bytes.byteLength > WORKSPACE_ARCHIVE_MAX_BYTES) {
    throw new KiokukoError('VALIDATION_ERROR', `Workspace archive exceeds the ${WORKSPACE_ARCHIVE_MAX_BYTES}-byte maximum`);
  }
  let lineBytes = 0;
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines += 1;
      lineBytes = 0;
    } else {
      lineBytes += 1;
      if (lineBytes > WORKSPACE_ARCHIVE_MAX_LINE_BYTES) {
        throw new KiokukoError(
          'VALIDATION_ERROR',
          `Workspace archive line exceeds the ${WORKSPACE_ARCHIVE_MAX_LINE_BYTES}-byte maximum`,
        );
      }
    }
    if (lines > WORKSPACE_ARCHIVE_MAX_LINES) {
      throw new KiokukoError('VALIDATION_ERROR', `Workspace archive exceeds the ${WORKSPACE_ARCHIVE_MAX_LINES}-line maximum`);
    }
  }
  if (lineBytes > 0) lines += 1;
  if (lines > WORKSPACE_ARCHIVE_MAX_LINES) {
    throw new KiokukoError('VALIDATION_ERROR', `Workspace archive exceeds the ${WORKSPACE_ARCHIVE_MAX_LINES}-line maximum`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value);
  const allowed = new Set(fields);
  if (actual.length !== fields.length || actual.some((field) => !allowed.has(field))) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} has invalid fields`);
  }
}

function rejectSecretValue(value: unknown): void {
  const finding = findSecretInValue(value);
  if (finding !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'Import contains secret-like content', { kind: finding.kind });
  }
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  }
  if (!isWellFormedUnicode(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must contain well-formed Unicode`);
  }
  return value;
}

function inputPathValue(value: unknown): string {
  const filePath = stringValue(value, 'input');
  if (/\p{Cc}/u.test(filePath)) {
    throw new KiokukoError('VALIDATION_ERROR', 'input must not contain control characters');
  }
  return filePath;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return stringValue(value, label, true);
}

function parsedJsonObject(value: unknown, label: string): JsonObject {
  const text = stringValue(value, label);
  const parsed = parseStrictJson(text, STRICT_JSON_OPTIONS, `${label} must contain valid JSON`);
  const object = objectValue(parsed, label) as JsonObject;
  rejectSecretValue(object);
  if (canonicalJson(object) !== text) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must use canonical JSON encoding`);
  }
  return object;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a finite number`);
  }
  return value;
}

function integerValue(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function timestampValue(value: unknown, label: string): string {
  const timestamp = stringValue(value, label);
  const parsed = Date.parse(timestamp);
  if (!TIMESTAMP_PATTERN.test(timestamp) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a canonical ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function hashValue(value: unknown, label: string): string {
  const hash = stringValue(value, label);
  if (!HASH_PATTERN.test(hash)) throw new KiokukoError('VALIDATION_ERROR', `${label} must be a lowercase SHA-256 hash`);
  return hash;
}

function parseJsonLine(text: string, label: string): Record<string, unknown> {
  const parsed = parseStrictJson(text, STRICT_JSON_OPTIONS, `${label} contains invalid JSON`);
  const object = objectValue(parsed, label);
  if (canonicalJson(object) !== text) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must use canonical JSON encoding`);
  }
  return object;
}

function validateEntryRecord(record: Record<string, unknown>, workspace: string): void {
  if (record.type !== 'entry') throw new KiokukoError('VALIDATION_ERROR', 'Entry record type is invalid');
  stringValue(record.id, 'entry.id');
  if (stringValue(record.workspace, 'entry.workspace') !== workspace) {
    throw new KiokukoError('VALIDATION_ERROR', 'Entry workspace does not match manifest workspace');
  }
  stringValue(record.kind, 'entry.kind');
  stringValue(record.status, 'entry.status');
  stringValue(record.title, 'entry.title');
  stringValue(record.body, 'entry.body', true);
  nullableString(record.summary, 'entry.summary');
  parsedJsonObject(record.scope_json, 'entry.scope_json');
  parsedJsonObject(record.provenance_json, 'entry.provenance_json');
  stringValue(record.trust_level, 'entry.trust_level');
  numberValue(record.confidence, 'entry.confidence');
  hashValue(record.content_hash, 'entry.content_hash');
  if (integerValue(record.revision, 'entry.revision', 1) !== 1) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'Workspace archive v1 can import only revision 1 snapshots; higher revisions require a history-preserving archive format',
    );
  }
  nullableString(record.superseded_by, 'entry.superseded_by');
  stringValue(record.created_by, 'entry.created_by');
  timestampValue(record.created_at, 'entry.created_at');
  timestampValue(record.updated_at, 'entry.updated_at');
  if (record.verified_at !== null) timestampValue(record.verified_at, 'entry.verified_at');
}

function validateTagRecord(record: Record<string, unknown>): void {
  if (record.type !== 'tag') throw new KiokukoError('VALIDATION_ERROR', 'Tag record type is invalid');
  stringValue(record.entry_id, 'tag.entry_id');
  stringValue(record.tag, 'tag.tag');
}

function validateLinkRecord(record: Record<string, unknown>): void {
  if (record.type !== 'link') throw new KiokukoError('VALIDATION_ERROR', 'Link record type is invalid');
  stringValue(record.from_entry_id, 'link.from_entry_id');
  stringValue(record.to_entry_id, 'link.to_entry_id');
  stringValue(record.relation, 'link.relation');
  timestampValue(record.created_at, 'link.created_at');
  stringValue(record.created_by, 'link.created_by');
}

function validateAuditRecord(record: Record<string, unknown>, workspace: string): void {
  if (record.type !== 'audit') throw new KiokukoError('VALIDATION_ERROR', 'Audit record type is invalid');
  stringValue(record.event_id, 'audit.event_id');
  nullableString(record.entry_id, 'audit.entry_id');
  if (stringValue(record.workspace, 'audit.workspace') !== workspace) {
    throw new KiokukoError('VALIDATION_ERROR', 'Audit workspace does not match manifest workspace');
  }
  stringValue(record.operation, 'audit.operation');
  stringValue(record.actor, 'audit.actor');
  parsedJsonObject(record.details_json, 'audit.details_json');
  timestampValue(record.created_at, 'audit.created_at');
}

function parseImport(text: string): ImportDocument {
  if (!text.endsWith('\n')) throw new KiokukoError('VALIDATION_ERROR', 'Import must end with exactly one newline');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2 || lines.some((line) => line.length === 0)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Import file is empty, truncated, or contains blank lines');
  }
  const checksumLine = parseJsonLine(lines[0]!, 'Import checksum line');
  exactFields(checksumLine, RECORD_FIELDS.checksum, 'Import checksum line');
  if (checksumLine.type !== 'checksum') {
    throw new KiokukoError('VALIDATION_ERROR', 'Import checksum line is invalid');
  }
  const checksum = hashValue(checksumLine.sha256, 'Import checksum');
  const payload = `${lines.slice(1).join('\n')}\n`;
  const actual = createHash('sha256').update(payload, 'utf8').digest('hex');
  if (actual !== checksum) throw new KiokukoError('INTEGRITY_ERROR', 'Import checksum mismatch');

  const payloadLines = lines.slice(1).map((line, index) => parseJsonLine(line, `Import payload line ${index + 1}`));
  const manifest = payloadLines[0]!;
  exactFields(manifest, RECORD_FIELDS.manifest, 'Import manifest');
  if (manifest.format !== 'kiokuko-jsonl' || manifest.version !== 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Unsupported import format');
  }
  if (manifest.type !== 'manifest') throw new KiokukoError('VALIDATION_ERROR', 'Import manifest is invalid');
  rejectSecretValue(manifest);
  const workspace = requireWorkspace(manifest.workspace);
  const counts = objectValue(manifest.counts, 'manifest.counts');
  exactFields(counts, COUNT_FIELDS, 'manifest.counts');
  for (const field of COUNT_FIELDS) integerValue(counts[field], `manifest.counts.${field}`);

  const entries: Record<string, unknown>[] = [];
  const tags: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  for (const line of payloadLines.slice(1)) {
    if (line.type === 'manifest' || line.type === 'checksum') {
      throw new KiokukoError('INTEGRITY_ERROR', `Import contains a duplicate ${String(line.type)} record`);
    }
    switch (line.type) {
      case 'entry':
        exactFields(line, RECORD_FIELDS.entry, 'Import entry record');
        validateEntryRecord(line, workspace);
        rejectSecretValue(line);
        entries.push(line);
        break;
      case 'tag':
        exactFields(line, RECORD_FIELDS.tag, 'Import tag record');
        validateTagRecord(line);
        rejectSecretValue(line);
        tags.push(line);
        break;
      case 'link':
        exactFields(line, RECORD_FIELDS.link, 'Import link record');
        validateLinkRecord(line);
        rejectSecretValue(line);
        links.push(line);
        break;
      case 'audit':
        exactFields(line, RECORD_FIELDS.audit, 'Import audit record');
        validateAuditRecord(line, workspace);
        rejectSecretValue(line);
        audit.push(line);
        break;
      default:
        throw new KiokukoError('VALIDATION_ERROR', `Import contains unsupported record type ${String(line.type)}`);
    }
  }
  for (const [key, actualCount] of Object.entries({ entries, tags, links, audit })) {
    if (counts[key] !== actualCount.length) {
      throw new KiokukoError('INTEGRITY_ERROR', `Import ${key} count does not match manifest`);
    }
  }
  return { manifest, entries, tags, links, audit };
}

function importedEntry(raw: Record<string, unknown>, workspace: string): ImportEntry {
  const id = stringValue(raw.id, 'entry.id');
  const kind = stringValue(raw.kind, 'entry.kind') as EntryKind;
  const status = stringValue(raw.status, 'entry.status') as EntryStatus;
  const title = stringValue(raw.title, 'entry.title');
  const body = stringValue(raw.body, 'entry.body', true);
  const summary = nullableString(raw.summary, 'entry.summary');
  const scope = parsedJsonObject(raw.scope_json, 'entry.scope_json');
  const provenance = parsedJsonObject(raw.provenance_json, 'entry.provenance_json');
  const trustLevel = stringValue(raw.trust_level, 'entry.trust_level') as TrustLevel;
  const confidence = numberValue(raw.confidence, 'entry.confidence');
  const persistedTags = Array.isArray(raw.tags) ? raw.tags : [];
  const createdBy = stringValue(raw.created_by, 'entry.created_by');
  const supersededBy = nullableString(raw.superseded_by, 'entry.superseded_by');
  const createdAt = timestampValue(raw.created_at, 'entry.created_at');
  const updatedAt = timestampValue(raw.updated_at, 'entry.updated_at');
  const verifiedAt = raw.verified_at === null ? null : timestampValue(raw.verified_at, 'entry.verified_at');
  const revision = integerValue(raw.revision, 'entry.revision', 1);
  const contentHash = hashValue(raw.content_hash, 'entry.content_hash');

  const validated = validateRecordInput({
    workspace,
    kind,
    status,
    title,
    body,
    summary,
    scope,
    provenance,
    trustLevel,
    confidence,
    tags: persistedTags,
    createdBy,
  });
  if ((status === 'superseded') !== (supersededBy !== null)) {
    throw new KiokukoError('VALIDATION_ERROR', 'entry.status and entry.superseded_by are inconsistent');
  }
  if (status === 'candidate' && verifiedAt !== null) {
    throw new KiokukoError('VALIDATION_ERROR', 'Candidate entries cannot have entry.verified_at');
  }
  if (status === 'verified' && verifiedAt === null) {
    throw new KiokukoError('VALIDATION_ERROR', 'Verified entries require entry.verified_at');
  }
  if (createdAt > updatedAt
    || verifiedAt !== null && (verifiedAt < createdAt || verifiedAt > updatedAt)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Entry lifecycle timestamps are inconsistent');
  }
  if (revision !== 1) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'Workspace archive v1 can import only revision 1 snapshots; higher revisions require a history-preserving archive format',
    );
  }
  const hashInput = {
    kind: validated.kind,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    tags: validated.tags,
  };
  const expectedHash = canonicalEntryRevisionContentHash(hashInput);
  if (expectedHash !== contentHash) {
    throw new KiokukoError('INTEGRITY_ERROR', `Content hash mismatch for entry ${id}`);
  }
  if (persistedTags.length !== validated.tags.length
    || persistedTags.some((tag, index) => tag !== validated.tags[index])) {
    throw new KiokukoError('VALIDATION_ERROR', `Tags for entry ${id} are not in canonical archive order`);
  }
  return {
    id,
    workspace,
    kind: validated.kind,
    status: validated.status,
    title: validated.title,
    body: validated.body,
    summary: validated.summary,
    scope: validated.scope,
    provenance: validated.provenance,
    trustLevel: validated.trustLevel,
    confidence: validated.confidence,
    contentHash,
    revision,
    supersededBy,
    createdBy: validated.createdBy,
    createdAt,
    updatedAt,
    verifiedAt,
    tags: validated.tags,
  };
}

function validateSupersessionGraph(entries: readonly ImportEntry[]): void {
  const replacements = new Map(entries.map((entry) => [entry.id, entry.supersededBy] as const));
  const state = new Map<string, 'visiting' | 'complete'>();
  for (const entry of entries) {
    if (state.get(entry.id) === 'complete') continue;
    const path: string[] = [];
    let current: string | null = entry.id;
    while (current !== null) {
      if (!replacements.has(current)) {
        throw new KiokukoError('VALIDATION_ERROR', `Supersession references unknown entry ${current}`);
      }
      const currentState = state.get(current);
      if (currentState === 'visiting') throw new KiokukoError('VALIDATION_ERROR', 'Import contains a supersession cycle');
      if (currentState === 'complete') break;
      state.set(current, 'visiting');
      path.push(current);
      current = replacements.get(current) ?? null;
    }
    for (const visited of path) state.set(visited, 'complete');
  }
}

function validateRelatedLines(document: ImportDocument, entryIds: Set<string>): void {
  const seenTags = new Set<string>();
  for (const tag of document.tags) {
    const entryId = stringValue(tag.entry_id, 'tag.entry_id');
    const value = stringValue(tag.tag, 'tag.tag');
    if (!entryIds.has(entryId)) throw new KiokukoError('VALIDATION_ERROR', `Tag references unknown entry ${entryId}`);
    const identity = `${entryId}\u0000${value}`;
    if (seenTags.has(identity)) throw new KiokukoError('VALIDATION_ERROR', 'Import contains a duplicate tag record');
    seenTags.add(identity);
  }
  const seenLinks = new Set<string>();
  for (const link of document.links) {
    const from = stringValue(link.from_entry_id, 'link.from_entry_id');
    const to = stringValue(link.to_entry_id, 'link.to_entry_id');
    const relation = stringValue(link.relation, 'link.relation');
    if (!entryIds.has(from) || !entryIds.has(to) || !RELATIONS.has(relation)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Import contains an invalid link');
    }
    const identity = `${from}\u0000${to}\u0000${relation}`;
    if (seenLinks.has(identity)) throw new KiokukoError('VALIDATION_ERROR', 'Import contains a duplicate link record');
    seenLinks.add(identity);
  }
  const seenAuditEvents = new Set<string>();
  for (const event of document.audit) {
    const entryId = nullableString(event.entry_id, 'audit.entry_id');
    const operation = stringValue(event.operation, 'audit.operation');
    if (entryId !== null && !entryIds.has(entryId)) throw new KiokukoError('VALIDATION_ERROR', `Audit references unknown entry ${entryId}`);
    if (!AUDIT_OPERATIONS.has(operation)) throw new KiokukoError('VALIDATION_ERROR', `Unsupported audit operation ${operation}`);
    const eventId = stringValue(event.event_id, 'audit.event_id');
    if (seenAuditEvents.has(eventId)) throw new KiokukoError('VALIDATION_ERROR', 'Import contains a duplicate audit event');
    seenAuditEvents.add(eventId);
    stringValue(event.workspace, 'audit.workspace');
    stringValue(event.actor, 'audit.actor');
    stringValue(event.details_json, 'audit.details_json', true);
    stringValue(event.created_at, 'audit.created_at');
  }
}

interface ImportPlan {
  newEntries: ImportEntry[];
  duplicates: number;
}

interface PlannedLink {
  from: string;
  to: string;
  relation: string;
  createdAt: string;
  createdBy: string;
}

interface PlannedAuditEvent {
  eventId: string;
  entryId: string | null;
  operation: string;
  actor: string;
  detailsJson: string;
  createdAt: string;
}

interface RelatedImportPlan {
  links: PlannedLink[];
  audit: PlannedAuditEvent[];
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function entryMatchesArchive(
  existing: EntryRecord,
  imported: ImportEntry,
): boolean {
  return existing.id === imported.id
    && existing.workspace === imported.workspace
    && existing.kind === imported.kind
    && existing.status === imported.status
    && existing.title === imported.title
    && existing.body === imported.body
    && existing.summary === imported.summary
    && canonicalJson(existing.scope) === canonicalJson(imported.scope)
    && canonicalJson(existing.provenance) === canonicalJson(imported.provenance)
    && existing.trustLevel === imported.trustLevel
    && existing.confidence === imported.confidence
    && existing.contentHash === imported.contentHash
    && existing.revision === imported.revision
    && existing.supersededBy === imported.supersededBy
    && existing.createdBy === imported.createdBy
    && existing.createdAt === imported.createdAt
    && existing.updatedAt === imported.updatedAt
    && existing.verifiedAt === imported.verifiedAt
    && sameStringArray(existing.tags, imported.tags);
}

function planEntryImport(
  database: SqliteDatabase | undefined,
  entries: readonly ImportEntry[],
  workspace: string,
): ImportPlan {
  const newEntries: ImportEntry[] = [];
  const duplicateIds = new Set<string>();
  if (database === undefined) {
    return { newEntries: [...entries], duplicates: 0 };
  }

  for (const entry of entries) {
    const owner = database.prepare('SELECT workspace FROM entries WHERE id = ?').get<{ workspace: unknown }>(entry.id);
    if (owner !== undefined) {
      if (typeof owner.workspace !== 'string') throw new KiokukoError('INTEGRITY_ERROR', 'Stored entry workspace is invalid');
      if (owner.workspace !== workspace) {
        throw new KiokukoError('CONFLICT', `Entry ID ${entry.id} already belongs to another workspace`);
      }
      const existing = readEntry(database, { workspace, entryId: entry.id });
      if (existing.contentHash !== entry.contentHash) {
        throw new KiokukoError('CONFLICT', `Entry ID ${entry.id} already contains different content`);
      }
      duplicateIds.add(entry.id);
      continue;
    }

    const hashMatch = database.prepare(`
      SELECT entry_id
        FROM entry_revisions
       WHERE workspace = ? AND content_hash = ?
    `).get<{ entry_id: unknown }>(workspace, entry.contentHash);
    if (hashMatch !== undefined) {
      if (typeof hashMatch.entry_id !== 'string') {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored content identity is invalid');
      }
      if (hashMatch.entry_id === entry.id) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored revision has no owning entry');
      }
      throw new KiokukoError('CONFLICT', 'Archive content already belongs to a different entry ID');
    }

    newEntries.push(entry);
  }

  for (const entry of entries) {
    if (!duplicateIds.has(entry.id)) continue;
    const existing = readEntry(database, { workspace, entryId: entry.id });
    if (!entryMatchesArchive(existing, entry)) {
      throw new KiokukoError('CONFLICT', `Entry ${entry.id} already exists with different archive metadata`);
    }
  }

  return { newEntries, duplicates: duplicateIds.size };
}

function planRelatedImport(
  database: SqliteDatabase | undefined,
  document: ImportDocument,
  workspace: string,
): RelatedImportPlan {
  const links: PlannedLink[] = [];
  for (const link of document.links) {
    const planned: PlannedLink = {
      from: stringValue(link.from_entry_id, 'link.from_entry_id'),
      to: stringValue(link.to_entry_id, 'link.to_entry_id'),
      relation: stringValue(link.relation, 'link.relation'),
      createdAt: timestampValue(link.created_at, 'link.created_at'),
      createdBy: stringValue(link.created_by, 'link.created_by'),
    };
    const existing = database?.prepare(`
      SELECT created_at, created_by
        FROM entry_links
       WHERE from_entry_id = ? AND to_entry_id = ? AND relation = ?
    `).get<{ created_at: unknown; created_by: unknown }>(planned.from, planned.to, planned.relation);
    if (existing !== undefined) {
      if (existing.created_at !== planned.createdAt || existing.created_by !== planned.createdBy) {
        throw new KiokukoError('CONFLICT', 'Existing link has different archive metadata');
      }
      continue;
    }
    links.push(planned);
  }

  const audit: PlannedAuditEvent[] = [];
  for (const event of document.audit) {
    const planned: PlannedAuditEvent = {
      eventId: stringValue(event.event_id, 'audit.event_id'),
      entryId: nullableString(event.entry_id, 'audit.entry_id'),
      operation: stringValue(event.operation, 'audit.operation'),
      actor: stringValue(event.actor, 'audit.actor'),
      detailsJson: stringValue(event.details_json, 'audit.details_json'),
      createdAt: timestampValue(event.created_at, 'audit.created_at'),
    };
    const existing = database?.prepare(`
      SELECT entry_id, workspace, operation, actor, details_json, created_at
        FROM audit_events
       WHERE event_id = ?
    `).get<{
      entry_id: unknown;
      workspace: unknown;
      operation: unknown;
      actor: unknown;
      details_json: unknown;
      created_at: unknown;
    }>(planned.eventId);
    if (existing !== undefined) {
      if (existing.entry_id !== planned.entryId
        || existing.workspace !== workspace
        || existing.operation !== planned.operation
        || existing.actor !== planned.actor
        || existing.details_json !== planned.detailsJson
        || existing.created_at !== planned.createdAt) {
        throw new KiokukoError('CONFLICT', `Audit event ${planned.eventId} already contains different metadata`);
      }
      continue;
    }
    audit.push(planned);
  }
  return { links, audit };
}

export async function importWorkspace(
  database: SqliteDatabase | undefined,
  options: ImportOptions,
  dependencies: ImportDependencies = {},
): Promise<ImportResult> {
  const archiveBytes = await readBoundedArchive(inputPathValue(options.input), dependencies);
  validateWorkspaceArchiveByteLayout(archiveBytes);
  if (archiveBytes[0] === 0xEF && archiveBytes[1] === 0xBB && archiveBytes[2] === 0xBF) {
    throw new KiokukoError('VALIDATION_ERROR', 'Import must not begin with a UTF-8 BOM');
  }
  let archiveText: string;
  try {
    archiveText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(archiveBytes);
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'Import is not valid UTF-8');
  }
  const parsed = parseImport(archiveText);
  const sourceWorkspace = requireWorkspace(parsed.manifest.workspace);
  const workspace = requireWorkspace(
    options.workspace === undefined ? sourceWorkspace : stringValue(options.workspace, 'workspace'),
  );
  rejectSecretValue(workspace);
  const tagsByEntry = new Map<string, string[]>();
  for (const tag of parsed.tags) {
    const entryId = stringValue(tag.entry_id, 'tag.entry_id');
    const values = tagsByEntry.get(entryId) ?? [];
    values.push(stringValue(tag.tag, 'tag.tag'));
    tagsByEntry.set(entryId, values);
  }
  const entries = parsed.entries.map((entry) => importedEntry({ ...entry, tags: tagsByEntry.get(String(entry.id)) ?? [] }, workspace));
  const sourceIds = new Set(entries.map((entry) => entry.id));
  if (sourceIds.size !== entries.length) throw new KiokukoError('VALIDATION_ERROR', 'Import contains duplicate entry IDs');
  if (new Set(entries.map((entry) => entry.contentHash)).size !== entries.length) {
    throw new KiokukoError('VALIDATION_ERROR', 'Import contains duplicate entry content');
  }
  validateSupersessionGraph(entries);
  validateRelatedLines(parsed, sourceIds);

  if (database === undefined && !options.dryRun) throw new KiokukoError('DATABASE_ERROR', 'Database is required for a non-dry import');

  if (options.dryRun) {
    const preflight = () => {
      const entryPlan = planEntryImport(database, entries, workspace);
      planRelatedImport(database, parsed, workspace);
      return entryPlan;
    };
    const plan = database === undefined ? preflight() : withDeferredReadTransaction(database, preflight);
    return {
      count: entries.length,
      imported: plan.newEntries.length,
      duplicates: plan.duplicates,
      dryRun: true,
      workspace,
    };
  }

  const db = database!;
  const result = withImmediateTransaction(db, () => {
    const plan = planEntryImport(db, entries, workspace);
    const related = planRelatedImport(db, parsed, workspace);
    const { newEntries } = plan;
    const insertEntry = db.prepare(`
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of newEntries) {
      insertEntry.run(
        entry.id,
        workspace,
        'candidate',
        entry.trustLevel,
        entry.confidence,
        1,
        null,
        entry.createdBy,
        entry.createdAt,
        entry.updatedAt,
        null,
      );
      insertEntryRevisionInTransaction(db, {
        entryId: entry.id,
        workspace,
        revision: 1,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        summary: entry.summary,
        scope: entry.scope,
        provenance: entry.provenance,
        tags: entry.tags,
        contentHash: entry.contentHash,
        createdBy: entry.createdBy,
        createdAt: entry.createdAt,
      });
      syncEntrySearchProjection(db, {
        entryId: entry.id,
        title: entry.title,
        body: entry.body,
        summary: entry.summary,
        tags: entry.tags,
        scope: entry.scope,
      });
      enqueueCurrentEntryEmbeddingInTransaction(db, {
        entryId: entry.id,
        revision: 1,
        contentHash: entry.contentHash,
        now: entry.updatedAt,
      });
    }

    const applyLifecycle = db.prepare(`
      UPDATE entries
         SET status = ?, superseded_by = ?, verified_at = ?
       WHERE id = ? AND workspace = ? AND current_revision = 1
    `);
    for (const entry of newEntries) {
      applyLifecycle.run(entry.status, entry.supersededBy, entry.verifiedAt, entry.id, workspace);
    }

    const insertLink = db.prepare(`
      INSERT INTO entry_links (from_entry_id, to_entry_id, relation, created_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const link of related.links) {
      insertLink.run(link.from, link.to, link.relation, link.createdAt, link.createdBy);
    }

    const insertAudit = db.prepare(`
      INSERT INTO audit_events (event_id, entry_id, workspace, operation, actor, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of related.audit) {
      insertAudit.run(
        event.eventId,
        event.entryId,
        workspace,
        event.operation,
        event.actor,
        event.detailsJson,
        event.createdAt,
      );
    }
    return plan;
  });

  return {
    count: entries.length,
    imported: result.newEntries.length,
    duplicates: result.duplicates,
    dryRun: false,
    workspace,
  };
}
