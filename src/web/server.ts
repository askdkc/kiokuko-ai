import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { rollbackFailedTransaction } from '../db/transaction.js';
import { readEntry, updateCandidateEntry, type EntryRecord } from '../memory/entries.js';
import { searchEntries } from '../memory/retrieval.js';
import { compareCanonicalStrings, ENTRY_KINDS, ENTRY_STATUSES, requireWorkspace, type EntryKind, type EntryStatus } from '../serialization/validate.js';
import { AgentGatewayService } from '../gateway/agent-service.js';
import { ContextBroker } from '../context/broker.js';
import { listContextFeedback, listIntakeFeedback, listRunFeedback } from '../context/feedback.js';
import { projectLedger } from '../ledger/projection.js';
import { readAkinatorSession, readRunIntakeLink } from '../akinator/store.js';
import { startHttpServer, type HttpApplicationContext, type HttpServerOptions } from '../server/http.js';
import { createAgentV1Handler } from '../server/agent-application.js';
import { WEB_HTML } from './ui.js';
import { curateMemoryCandidates, curatorFacets, globalizeCuratorCandidate } from '../memory/curator.js';
import { MEMORY_CLASSES } from '../memory/structured-memory.js';
import type { KnowledgeEvidenceTier } from '../akinator/knowledge-path.js';
import { GLOBAL_WORKSPACE } from '../memory/workspaces.js';
import { recallScopedMemory } from '../memory/scoped-memory.js';
import type { ResolvedProjectWorkspace } from '../memory/workspaces.js';
import { documentsFromSkillSnapshot } from '../skills/import-preparation.js';
import { readSkillDiscoveryConfig } from '../skills/config.js';
import { GitHubSkillSourceFetcher } from '../skills/source/github-fetcher.js';
import { SkillSourceError } from '../skills/source/errors.js';
import { externalSkillRequirement, externalSkillSourceFetchRequest, listExternalSkills, listExternalSkillsPage, markExternalSkillRefreshFailure, readExternalSkill, refreshExternalSkillSnapshot, setExternalSkillState, type ExternalSkillRecord, type ExternalSkillState } from '../skills/store.js';
import type { SkillCandidate } from '../skills/types.js';
import { createSkillRegistryProvider } from '../skills/find.js';
import { parseStrictJson } from '../setup/strict-json.js';
import { fetchMaterializableSkillSnapshot } from '../skills/materialization-service.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_WEB_ENTRIES = 200;

type JsonRecord = Record<string, unknown>;

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function isInvalidUtf8EncodingError(error: unknown): boolean {
  return error instanceof TypeError && 'code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA';
}

export type WebServerHttpOptions = Omit<
  HttpServerOptions,
  'databasePath' | 'host' | 'port' | 'app' | 'v1' | 'applicationFactory'
>;

export interface WebServerOptions {
  databasePath?: string;
  host?: string;
  port?: number;
  httpOptions?: WebServerHttpOptions;
}

export interface WebServerHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

interface WorkspaceSummary {
  workspace: string;
  displayName: string;
  count: number;
}

interface ExternalSkillRefreshFlights {
  readonly database: SqliteDatabase;
  readonly operations: Map<string, Promise<unknown>>;
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function htmlResponse(response: ServerResponse, sessionToken: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': `kiokuko_ui_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
    'content-length': Buffer.byteLength(WEB_HTML),
  });
  response.end(WEB_HTML);
}

const UI_SESSION_COOKIE = 'kiokuko_ui_session';

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return undefined;
}

function requireTrustedWebOrigin(request: IncomingMessage, trustedOrigin: string | undefined): void {
  if (trustedOrigin === undefined) {
    throw new KiokukoError('AUTHENTICATION_ERROR', 'Origin is invalid');
  }
  const expectedHost = new URL(trustedOrigin).host;
  if (request.headers.host !== expectedHost) {
    throw new KiokukoError('AUTHENTICATION_ERROR', 'Origin is invalid');
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== trustedOrigin) {
    throw new KiokukoError('AUTHENTICATION_ERROR', 'Origin is invalid');
  }
  const referer = request.headers.referer;
  if (referer !== undefined) {
    try {
      if (new URL(referer).origin !== trustedOrigin) throw new Error('origin');
    } catch {
      throw new KiokukoError('AUTHENTICATION_ERROR', 'Origin is invalid');
    }
  }
}

function requireUiSession(request: IncomingMessage, sessionToken: string): void {
  if (cookieValue(request, UI_SESSION_COOKIE) !== sessionToken) {
    throw new KiokukoError('AUTHENTICATION_ERROR', 'Authorization is invalid');
  }
}

function errorStatus(error: unknown): number {
  if (!(error instanceof KiokukoError)) return 500;
  if (error.code === 'AUTHENTICATION_ERROR') return 401;
  if (error.code === 'VALIDATION_ERROR' || error.code === 'USAGE_ERROR') return 400;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'CONFLICT') return 409;
  if (error.code === 'BACKPRESSURE') return 429;
  if (error.code === 'SECURITY_REJECTION') return 422;
  if (error.code === 'SERVICE_UNAVAILABLE' || error.code === 'DATABASE_ERROR') return 503;
  if (error.code === 'NOT_IMPLEMENTED') return 501;
  return 500;
}

function boundedRetryAfterSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(60, Math.max(1, Math.trunc(value)));
}

function errorBody(error: unknown): { error: { code: string; message: string; details: Record<string, unknown> } } {
  if (!(error instanceof KiokukoError)) {
    return { error: { code: 'INTEGRITY_ERROR', message: 'Unexpected server error', details: {} } };
  }
  if (error.code === 'AUTHENTICATION_ERROR') return { error: { code: error.code, message: 'Authorization is invalid', details: {} } };
  if (error.code === 'VALIDATION_ERROR' || error.code === 'USAGE_ERROR') return { error: { code: error.code, message: 'Request is invalid', details: {} } };
  if (error.code === 'NOT_FOUND') return { error: { code: error.code, message: 'Resource not found', details: {} } };
  if (error.code === 'CONFLICT') return { error: { code: error.code, message: 'Request conflicts with current state', details: {} } };
  if (error.code === 'BACKPRESSURE') return { error: { code: error.code, message: 'Service is busy', details: { retryAfterSeconds: boundedRetryAfterSeconds(error.details.retryAfterSeconds) } } };
  if (error.code === 'DATABASE_ERROR') return { error: { code: error.code, message: 'Database unavailable', details: {} } };
  if (error.code === 'SERVICE_UNAVAILABLE') return { error: { code: error.code, message: 'Service unavailable', details: {} } };
  if (error.code === 'SECURITY_REJECTION') return { error: { code: error.code, message: 'Request rejected', details: {} } };
  if (error.code === 'INTEGRITY_ERROR') return { error: { code: error.code, message: 'Internal integrity error', details: {} } };
  if (error.code === 'PARTIAL_FAILURE') return { error: { code: error.code, message: 'Operation partially failed', details: {} } };
  if (error.code === 'NOT_IMPLEMENTED') return { error: { code: error.code, message: 'Operation is not implemented', details: {} } };
  return { error: { code: 'INTEGRITY_ERROR', message: 'Unexpected server error', details: {} } };
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function enumQuery<T extends readonly string[]>(value: string | null, allowed: T, field: string): T[number] | undefined {
  if (value === null || value.length === 0) return undefined;
  if (!allowed.includes(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function booleanQuery(value: string | null, field: string): boolean | undefined {
  if (value === null || value.length === 0) return undefined;
  if (value !== 'true' && value !== 'false') throw new KiokukoError('VALIDATION_ERROR', `${field} must be true or false`);
  return value === 'true';
}

function limitQuery(value: string | null): number {
  if (value === null || value.length === 0) return MAX_WEB_ENTRIES;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEB_ENTRIES) {
    throw new KiokukoError('VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_WEB_ENTRIES}`);
  }
  return limit;
}

type ExternalSkillListCursor = readonly [
  version: 1,
  listVersion: number,
  state: ExternalSkillState | null,
  sourceLocator: string,
  slug: string,
  provider: string,
  skillId: string,
];

function invalidExternalSkillCursor(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'cursor is invalid');
}

function externalSkillCursor(record: ExternalSkillRecord, listVersion: number, state: ExternalSkillState | undefined): string {
  const value: ExternalSkillListCursor = [
    1,
    listVersion,
    state ?? null,
    record.sourceLocator,
    record.slug,
    record.provider,
    record.skillId,
  ];
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function externalSkillCursorQuery(url: URL): ExternalSkillListCursor | undefined {
  const values = url.searchParams.getAll('cursor');
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{1,4096}$/u.test(values[0]!)) invalidExternalSkillCursor();
  let decoded: Buffer;
  let parsed: unknown;
  try {
    decoded = Buffer.from(values[0]!, 'base64url');
    if (decoded.toString('base64url') !== values[0] || decoded.byteLength > 3_000 || hasUtf8Bom(decoded)) invalidExternalSkillCursor();
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded)) as unknown;
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    if (error instanceof SyntaxError || isInvalidUtf8EncodingError(error)) invalidExternalSkillCursor();
    throw error;
  }
  if (!Array.isArray(parsed) || parsed.length !== 7 || parsed[0] !== 1
    || typeof parsed[1] !== 'number' || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0
    || parsed[2] !== null && (typeof parsed[2] !== 'string'
      || !['discovered', 'imported', 'blocked', 'stale', 'disabled'].includes(parsed[2]))
    || parsed.slice(3).some((value) => typeof value !== 'string' || value.length < 1 || value.length > 2_000 || /\p{Cc}/u.test(value))) {
    invalidExternalSkillCursor();
  }
  return parsed as unknown as ExternalSkillListCursor;
}

function externalSkillListItem(record: ExternalSkillRecord): Omit<ExternalSkillRecord, 'metadata'> & { metadata: { documents: number; technology: string | null } } {
  const metadata = record.metadata as Record<string, unknown>;
  const documents = record.sourceCommit === null ? 0 : metadata.documents;
  const technology = record.sourceCommit === null ? null : metadata.technology;
  if (typeof documents !== 'number' || !Number.isSafeInteger(documents) || documents < 0 || documents > 64
    || technology !== null && (typeof technology !== 'string' || technology.length < 1 || technology.length > 500)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'External skill list metadata is invalid');
  }
  return { ...record, metadata: { documents, technology } };
}

function listQuery(url: URL, name: string, max = 50): string[] {
  const values = url.searchParams.getAll(name).map((value) => value.trim()).filter(Boolean);
  if (values.length > max || values.some((value) => value.length > 300)) throw new KiokukoError('VALIDATION_ERROR', `${name} contains too many or too-large values`);
  return [...new Set(values)];
}

function requireExactJsonMediaType(request: IncomingMessage): void {
  const contentTypes: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'content-type') {
      contentTypes.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  if (contentTypes.length !== 1 || contentTypes[0]!.trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new KiokukoError('VALIDATION_ERROR', 'Content-Type must be exactly application/json');
  }
}

function decodeJsonBody(bytes: Buffer): string {
  if (hasUtf8Bom(bytes)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Request body must not contain a byte-order mark');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (isInvalidUtf8EncodingError(error)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Request body must be valid UTF-8');
    }
    throw error;
  }
}

function requireOnlyJsonFields(payload: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedFields = new Set(allowed);
  if (Object.keys(payload).some((field) => !allowedFields.has(field))) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} contains an unknown field`);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  requireExactJsonMediaType(request);
  const chunks: Buffer[] = [];
  let size = 0;
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new KiokukoError('VALIDATION_ERROR', 'Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('aborted', () => reject(new KiokukoError('VALIDATION_ERROR', 'Request body is incomplete')));
  });
  const parsed = parseStrictJson(
    decodeJsonBody(bytes),
    { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
    'Request body is not valid strict JSON',
  );
  return asRecord(parsed, 'Request body');
}

function requireNoQueryParameters(url: URL): void {
  if (url.searchParams.entries().next().done !== true) {
    throw new KiokukoError('VALIDATION_ERROR', 'This endpoint does not accept query parameters');
  }
}

async function requireEmptyBody(request: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.once('data', () => {
      request.resume();
      reject(new KiokukoError('VALIDATION_ERROR', 'Request body must be empty'));
    });
    request.once('end', resolve);
    request.once('error', reject);
    request.once('aborted', () => reject(new KiokukoError('VALIDATION_ERROR', 'Request body is incomplete')));
  });
}

function workspaceSummaries(database: SqliteDatabase): WorkspaceSummary[] {
  database.exec('BEGIN DEFERRED');
  try {
    const externalWorkspaces = new Set(listExternalSkills(database).map((skill) => skill.sourceWorkspace));
    const summaries = new Map<string, WorkspaceSummary>();
    for (const row of database.prepare('SELECT workspace, display_name FROM repositories ORDER BY workspace ASC').all<{ workspace: string; display_name: string }>()) {
      if (!externalWorkspaces.has(row.workspace)) summaries.set(row.workspace, { workspace: row.workspace, displayName: row.display_name, count: 0 });
    }
    for (const row of database.prepare("SELECT workspace, COUNT(*) AS count FROM entries WHERE status <> 'superseded' GROUP BY workspace").all<{ workspace: string; count: number }>()) {
      if (externalWorkspaces.has(row.workspace)) continue;
      const existing = summaries.get(row.workspace);
      if (existing) existing.count = Number(row.count);
      else summaries.set(row.workspace, { workspace: row.workspace, displayName: '', count: Number(row.count) });
    }
    database.exec('COMMIT');
    return [...summaries.values()].sort((left, right) => compareCanonicalStrings(left.workspace, right.workspace));
  } catch (error) {
    rollbackFailedTransaction(database, error);
  }
}

function workspaceTags(database: SqliteDatabase, workspace: string): Array<{ tag: string; count: number }> {
  return database
    .prepare("SELECT t.tag, COUNT(*) AS count FROM entry_revision_tags t JOIN entries e ON e.id = t.entry_id AND e.current_revision = t.revision WHERE e.workspace = ? AND e.status <> 'superseded' GROUP BY t.tag ORDER BY t.tag ASC")
    .all<{ tag: string; count: number }>(workspace)
    .map((row) => ({ tag: row.tag, count: Number(row.count) }));
}

function workspaceProject(database: SqliteDatabase, workspace: string): ResolvedProjectWorkspace | undefined {
  const row = database.prepare('SELECT r.repository_id, r.workspace, l.canonical_root FROM repository_locations AS l JOIN repositories AS r ON r.repository_id = l.repository_id WHERE r.workspace = ? ORDER BY l.last_seen_at DESC, l.canonical_root ASC LIMIT 1').get<{ repository_id: string; workspace: string; canonical_root: string }>(workspace);
  if (!row) return undefined;
  return { repositoryId: row.repository_id, workspace: row.workspace, repositoryRoot: row.canonical_root, source: 'location' };
}

function listEntries(
  database: SqliteDatabase,
  workspace: string,
  query: string,
  kind: EntryKind | undefined,
  status: EntryStatus | undefined,
  tag: string | undefined,
  includeSuperseded: boolean,
  limit: number,
): { entries: EntryRecord[]; count: number } {
  if (query.trim().length > 0) {
    const searchInput: Parameters<typeof searchEntries>[1] = { workspace, query, limit, includeSuperseded };
    if (kind !== undefined) searchInput.kind = kind;
    if (status !== undefined) searchInput.status = status;
    if (tag !== undefined) searchInput.tag = tag;
    const result = searchEntries(database, searchInput);
    return { entries: result.items, count: result.count };
  }

  const parameters: Array<string | number> = [workspace];
  const clauses = ['e.workspace = ?'];
  if (!includeSuperseded) clauses.push("e.status <> 'superseded'");
  if (kind !== undefined) {
    clauses.push('r.kind = ?');
    parameters.push(kind);
  }
  if (status !== undefined) {
    clauses.push('e.status = ?');
    parameters.push(status);
  }
  if (tag !== undefined) {
    clauses.push('EXISTS (SELECT 1 FROM entry_revision_tags filter_tags WHERE filter_tags.entry_id = e.id AND filter_tags.revision = e.current_revision AND filter_tags.tag = ?)');
    parameters.push(tag);
  }
  parameters.push(limit);
  const rows = database.prepare(`SELECT e.id FROM entries AS e JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision WHERE ${clauses.join(' AND ')} ORDER BY e.updated_at DESC, e.id ASC LIMIT ?`).all<{ id: string }>(...parameters);
  const entries = rows.map((row) => readEntry(database, { workspace, entryId: row.id }));
  return { entries, count: entries.length };
}

function entryIdFromPath(pathname: string): string {
  const prefix = '/api/entries/';
  if (!pathname.startsWith(prefix) || pathname.slice(prefix.length).includes('/')) {
    throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
  }
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'entry id is not valid URL encoding');
  }
}

function externalSkillIdFromPath(pathname: string): string | undefined {
  const prefix = '/api/skills/';
  if (!pathname.startsWith(prefix)) return undefined;
  const encoded = pathname.slice(prefix.length);
  if (encoded.length === 0 || encoded.includes('/')) throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
  try {
    const skillId = decodeURIComponent(encoded);
    if (skillId.length === 0 || skillId.length > 500) throw new Error('invalid');
    return skillId;
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'skill id is not valid URL encoding');
  }
}

function externalSkillSourceFailure(
  error: SkillSourceError,
  code: 'CONFLICT' | 'SECURITY_REJECTION' | 'SERVICE_UNAVAILABLE',
  message: string,
): KiokukoError {
  const failure = new KiokukoError(code, message, {
    failureCode: error.code,
    ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  });
  Object.defineProperty(failure, 'cause', {
    value: error,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return failure;
}

function refreshExternalSkill(
  context: HttpApplicationContext,
  skillId: string,
  flights: ExternalSkillRefreshFlights,
): Promise<unknown> {
  if (flights.database !== context.database) {
    throw new KiokukoError('INTEGRITY_ERROR', 'External skill refresh coordinator is bound to another database');
  }
  const detail = readExternalSkill(context.database, skillId);
  if (!detail) throw new KiokukoError('NOT_FOUND', 'External skill not found');
  if (detail.skill.sourceType !== 'github') throw new KiokukoError('NOT_IMPLEMENTED', 'Only GitHub external skills can be refreshed automatically');
  const candidate: SkillCandidate = {
    id: detail.skill.skillId,
    provider: detail.skill.provider,
    name: detail.skill.name,
    slug: detail.skill.slug,
    source: detail.skill.sourceLocator,
    sourceType: 'github',
    installUrl: detail.skill.installUrl,
    installs: detail.skill.installs,
    duplicate: detail.skill.duplicate,
    officialStatus: detail.skill.officialStatus as SkillCandidate['officialStatus'],
    auditStatus: detail.skill.auditStatus,
  };
  const expected = { generation: detail.skill.generation, sourceCommit: detail.skill.sourceCommit, snapshotHash: detail.skill.snapshotHash, state: detail.skill.state, lastCheckedAt: detail.skill.lastCheckedAt };
  const flightKey = JSON.stringify([
    skillId,
    expected.generation,
    expected.sourceCommit,
    expected.snapshotHash,
    expected.state,
    expected.lastCheckedAt,
  ]);
  const existing = flights.operations.get(flightKey);
  if (existing !== undefined) return existing;

  const operation = Promise.resolve().then(async () => {
    try {
      const materialized = await fetchMaterializableSkillSnapshot(context.database, candidate, {
        provider: createSkillRegistryProvider(),
        sourceFetcher: new GitHubSkillSourceFetcher({ token: readSkillDiscoveryConfig().githubToken }),
        sourceRequest: externalSkillSourceFetchRequest(detail),
        cacheWrite: (operation) => context.enqueueWrite(operation),
      });
      const snapshot = materialized.snapshot;
      if (!snapshot.files.some((file) => file.primary)) throw new KiokukoError('VALIDATION_ERROR', 'Skill snapshot has no primary document');
      const requirement = externalSkillRequirement(context.database, skillId);
      return await context.enqueueWrite(() => refreshExternalSkillSnapshot(
        context.database,
        skillId,
        snapshot,
        documentsFromSkillSnapshot(snapshot),
        requirement,
        expected,
        undefined,
        materialized.authorization,
      ));
    } catch (error) {
      if (!(error instanceof SkillSourceError)) throw error;
      if (error.code === 'source_missing' || error.code === 'candidate_not_found_at_source') {
        await context.enqueueWrite(() => markExternalSkillRefreshFailure(context.database, skillId, 'stale', expected));
        throw externalSkillSourceFailure(error, 'CONFLICT', 'External skill source is stale');
      }
      if (error.code === 'skill_disabled_for_model_invocation' || error.code === 'skill_secret_detected' || error.code === 'skill_blocked') {
        await context.enqueueWrite(() => markExternalSkillRefreshFailure(context.database, skillId, 'blocked', expected));
        throw externalSkillSourceFailure(error, 'SECURITY_REJECTION', 'External skill snapshot was blocked');
      }
      if (error.code === 'source_rate_limited' || error.code === 'source_unavailable') {
        throw externalSkillSourceFailure(error, 'SERVICE_UNAVAILABLE', 'External skill source is temporarily unavailable');
      }
      if (error.code === 'source_tree_truncated' || error.code === 'skill_too_large' || error.code === 'skill_validation_failed') {
        throw externalSkillSourceFailure(error, 'SECURITY_REJECTION', 'External skill source failed validation');
      }
      throw error;
    }
  });
  flights.operations.set(flightKey, operation);
  const cleanup = (): void => {
    if (flights.operations.get(flightKey) === operation) flights.operations.delete(flightKey);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

function operatorRunIdFromPath(pathname: string): string | undefined {
  const prefix = '/api/operator/runs/';
  if (!pathname.startsWith(prefix) || pathname.slice(prefix.length).includes('/')) return undefined;
  try {
    const runId = decodeURIComponent(pathname.slice(prefix.length));
    if (runId.length === 0) throw new Error('empty');
    return runId;
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'run id is not valid URL encoding');
  }
}

function operatorRunList(context: HttpApplicationContext, url: URL): unknown {
  const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
  const service = new AgentGatewayService(context.database);
  const input: Record<string, unknown> = { workspace };
  for (const field of ['client', 'status', 'cursor'] as const) {
    const value = url.searchParams.get(field);
    if (value !== null) input[field] = value;
  }
  const limit = url.searchParams.get('limit');
  if (limit !== null) input.limit = Math.min(limitQuery(limit), 100);
  return { workspace, ...service.listRuns(input) };
}

function operatorRunDetail(context: HttpApplicationContext, runId: string): unknown {
  const service = new AgentGatewayService(context.database);
  const run = service.readRun({ runId });
  const intake = service.readIntake({ runId });
  const events = service.listEvents({ runId, limit: 100 });
  const link = readRunIntakeLink(context.database, { workspace: run.workspace, runId });
  const session = readAkinatorSession(context.database, { workspace: run.workspace, sessionId: link.sessionId });
  const initialProfile = { ...session.profile };
  const projection = projectLedger({
    initialProfile,
    intakeStatus: session.status,
    coverage: run.coverage,
    throughSequence: run.lastSequence,
    events: events.items.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.eventType as never,
      ...(event.outcome === null ? {} : { outcome: event.outcome }),
      payload: event.payload,
    })),
  });
  const deliveries = new ContextBroker(context.database).listDeliveries({ runId, limit: 100 });
  const feedback = {
    context: listContextFeedback(context.database, { workspace: run.workspace, runId, limit: 100 }),
    run: listRunFeedback(context.database, { workspace: run.workspace, runId, limit: 100 }),
    intake: listIntakeFeedback(context.database, { workspace: run.workspace, runId, limit: 100 }),
  };
  const evidence = context.database.prepare(`
    SELECT evidence_id AS evidenceId, event_id AS eventId, kind, digest_algorithm AS digestAlgorithm,
      digest, byte_size AS byteSize, summary, created_at AS createdAt
    FROM ledger_evidence WHERE run_id = ? ORDER BY created_at ASC, evidence_id ASC LIMIT 100
  `).all<Record<string, unknown>>(runId);
  const memoryLinks = context.database.prepare(`
    SELECT link_id AS linkId, event_id AS eventId, delivery_id AS deliveryId, entry_id AS entryId, created_at AS createdAt
    FROM ledger_memory_links WHERE run_id = ? ORDER BY created_at ASC, link_id ASC LIMIT 100
  `).all<Record<string, unknown>>(runId);
  const warnings: string[] = [];
  if (run.coverage.run !== 'complete') warnings.push('coverage is partial');
  if (projection.evidenceState !== 'fresh') warnings.push(`evidence is ${projection.evidenceState}`);
  if (session.status === 'active') warnings.push('intake is incomplete');
  return {
    run,
    intake,
    profile: {
      initial: initialProfile,
      projected: projection.taskProfile,
      source: link.profileSources,
      policyVersion: link.policyVersion,
      initialProfileHash: link.initialProfileHash,
    },
    timeline: events,
    evidence,
    coverage: run.coverage,
    evidenceState: projection.evidenceState,
    warnings,
    deliveries,
    feedback,
    memoryLinks,
    proposals: events.items.filter((event) => event.eventType === 'memory.proposed').map((event) => ({ eventId: event.eventId, sequence: event.sequence })),
    untrusted: true,
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpApplicationContext,
  sessionToken: string,
  externalSkillRefreshFlights: ExternalSkillRefreshFlights,
): Promise<void> {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/') {
    htmlResponse(response, sessionToken);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    jsonResponse(response, 200, { ok: true });
    return;
  }
  requireUiSession(request, sessionToken);
  if (request.method === 'GET' && url.pathname === '/api/skills') {
    if ([...url.searchParams.keys()].some((key) => key !== 'state' && key !== 'limit' && key !== 'cursor')
      || url.searchParams.getAll('state').length > 1 || url.searchParams.getAll('limit').length > 1) {
      throw new KiokukoError('VALIDATION_ERROR', 'External skill list query is invalid');
    }
    const state = enumQuery(url.searchParams.get('state'), ['discovered', 'imported', 'blocked', 'stale', 'disabled'] as const, 'state');
    const limit = limitQuery(url.searchParams.get('limit'));
    const cursor = externalSkillCursorQuery(url);
    const normalizedState = state as ExternalSkillState | undefined;
    if (cursor !== undefined && cursor[2] !== (normalizedState ?? null)) {
      throw new KiokukoError('CONFLICT', 'External skill list filter changed; restart pagination');
    }
    const page = listExternalSkillsPage(context.database, {
      ...(normalizedState === undefined ? {} : { state: normalizedState }),
      limit,
      ...(cursor === undefined ? {} : {
        expectedVersion: cursor[1],
        after: { sourceLocator: cursor[3], slug: cursor[4], provider: cursor[5], skillId: cursor[6] },
      }),
    });
    const skills = page.skills.map(externalSkillListItem);
    jsonResponse(response, 200, {
      skills,
      count: skills.length,
      truncated: page.truncated,
      nextCursor: page.truncated ? externalSkillCursor(page.skills.at(-1)!, page.version, normalizedState) : null,
      untrusted: true,
    });
    return;
  }
  const isExternalSkillAction = url.pathname.endsWith('/refresh') || url.pathname.endsWith('/disable') || url.pathname.endsWith('/enable');
  const externalSkillId = isExternalSkillAction ? undefined : externalSkillIdFromPath(url.pathname);
  if (externalSkillId !== undefined && request.method === 'GET') {
    requireNoQueryParameters(url);
    const detail = readExternalSkill(context.database, externalSkillId);
    if (!detail) throw new KiokukoError('NOT_FOUND', 'External skill not found');
    jsonResponse(response, 200, {
      skill: externalSkillListItem(detail.skill),
      entries: detail.entries.slice(0, MAX_WEB_ENTRIES),
      entriesTruncated: detail.entries.length > MAX_WEB_ENTRIES,
      untrusted: true,
    });
    return;
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/skills/') && url.pathname.endsWith('/refresh')) {
    const skillId = externalSkillIdFromPath(url.pathname.slice(0, -'/refresh'.length));
    if (skillId === undefined) throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
    requireNoQueryParameters(url);
    await requireEmptyBody(request);
    jsonResponse(response, 200, await refreshExternalSkill(context, skillId, externalSkillRefreshFlights));
    return;
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/skills/') && (url.pathname.endsWith('/disable') || url.pathname.endsWith('/enable'))) {
    const suffix = url.pathname.endsWith('/disable') ? '/disable' : '/enable';
    const skillId = externalSkillIdFromPath(url.pathname.slice(0, -suffix.length));
    if (skillId === undefined) throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
    requireNoQueryParameters(url);
    await requireEmptyBody(request);
    const state = suffix === '/disable' ? 'disabled' : 'imported';
    const skill = await context.enqueueWrite(() => setExternalSkillState(context.database, skillId, state));
    jsonResponse(response, 200, { skill, untrusted: true });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/operator/runs') {
    jsonResponse(response, 200, operatorRunList(context, url));
    return;
  }
  if (request.method === 'GET' && operatorRunIdFromPath(url.pathname) !== undefined) {
    jsonResponse(response, 200, operatorRunDetail(context, operatorRunIdFromPath(url.pathname) as string));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/workspaces') {
    const workspaces = await workspaceSummaries(context.database);
    jsonResponse(response, 200, { workspaces });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/tags') {
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
    const tags = await workspaceTags(context.database, workspace);
    jsonResponse(response, 200, { workspace, tags });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/memory/recall') {
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
    const query = url.searchParams.get('q')?.trim() ?? '';
    if (query.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'q must be a non-empty search query');
    const scope = enumQuery(url.searchParams.get('scope'), ['auto', 'project', 'ecosystem', 'global'] as const, 'scope') ?? 'auto';
    const project = workspace === GLOBAL_WORKSPACE ? undefined : workspaceProject(context.database, workspace);
    if (scope !== 'global' && workspace !== GLOBAL_WORKSPACE && project === undefined) throw new KiokukoError('NOT_FOUND', 'The selected workspace has no repository root for scoped recall');
    const result = await recallScopedMemory(context.database, {
      query,
      scope,
      ...(project === undefined ? {} : { project }),
      limit: Math.min(limitQuery(url.searchParams.get('limit')), 100),
      maxChars: 50_000,
    });
    jsonResponse(response, 200, { workspace, ...result });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/curator/candidates') {
    const workspaceParam = url.searchParams.get('workspace');
    const skillReadyOnly = booleanQuery(url.searchParams.get('skillReadyOnly'), 'skillReadyOnly') ?? false;
    const workspaces = listQuery(url, 'project');
    const tags = listQuery(url, 'tag');
    const frameworks = listQuery(url, 'framework');
    const languages = listQuery(url, 'language');
    const memoryClasses = listQuery(url, 'memoryClass').map((value) => enumQuery(value, MEMORY_CLASSES, 'memoryClass') as typeof MEMORY_CLASSES[number]);
    const tiers = listQuery(url, 'tier').map((value) => enumQuery(value, ['unobserved', 'observed', 'repeated', 'portable'] as const, 'tier') as KnowledgeEvidenceTier);
    const tagMode = enumQuery(url.searchParams.get('tagMode'), ['any', 'all'] as const, 'tagMode');
    const includeGlobalized = booleanQuery(url.searchParams.get('includeGlobalized'), 'includeGlobalized') ?? false;
    const cursor = url.searchParams.get('cursor');
    const input = {
      ...(workspaceParam !== null && workspaceParam !== 'all' ? { workspace: requireWorkspace(workspaceParam) } : {}),
      ...(workspaces.length > 0 ? { workspaces } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(tagMode === undefined ? {} : { tagMode }),
      ...(frameworks.length > 0 ? { frameworks } : {}),
      ...(languages.length > 0 ? { languages } : {}),
      ...(memoryClasses.length > 0 ? { memoryClasses } : {}),
      ...(tiers.length > 0 ? { tiers } : {}),
      ...(url.searchParams.get('search') === null ? {} : { search: url.searchParams.get('search') ?? '' }),
      ...(cursor === null ? {} : { cursor }),
      allWorkspaces: workspaceParam === null || workspaceParam === 'all' || workspaces.length > 0,
      skillReadyOnly,
      includeGlobalized,
      limit: Math.min(limitQuery(url.searchParams.get('limit')), 50),
    } as Parameters<typeof curateMemoryCandidates>[1];
    const result = await curateMemoryCandidates(context.database, input);
    jsonResponse(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/curator/facets') {
    const workspaceParam = url.searchParams.get('workspace');
    const projects = listQuery(url, 'project');
    const includeGlobalized = booleanQuery(url.searchParams.get('includeGlobalized'), 'includeGlobalized') ?? false;
    jsonResponse(response, 200, { facets: curatorFacets(context.database, {
      ...(workspaceParam !== null && workspaceParam !== 'all' ? { workspace: requireWorkspace(workspaceParam) } : {}),
      ...(projects.length > 0 ? { workspaces: projects } : {}),
      includeGlobalized,
    }) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/curator/globalize') {
    const payload = await readJsonBody(request);
    requireOnlyJsonFields(payload, ['workspace', 'entryId', 'expectedRevision', 'actor'], 'Curator globalize request');
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? (typeof payload.workspace === 'string' ? payload.workspace : ''));
    const result = await context.enqueueWrite(() => globalizeCuratorCandidate(context.database, {
      workspace,
      entryId: payload.entryId as string,
      expectedRevision: payload.expectedRevision as number,
      ...(typeof payload.actor === 'string' ? { actor: payload.actor } : {}),
    }));
    jsonResponse(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/entries') {
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
    const kind = enumQuery(url.searchParams.get('kind'), ENTRY_KINDS, 'kind');
    const status = enumQuery(url.searchParams.get('status'), ENTRY_STATUSES, 'status');
    const tagValue = url.searchParams.get('tag');
    const tag = tagValue === null || tagValue.trim().length === 0 ? undefined : tagValue;
    const includeSuperseded = booleanQuery(url.searchParams.get('includeSuperseded'), 'includeSuperseded') ?? false;
    const result = await listEntries(context.database, workspace, url.searchParams.get('q') ?? '', kind, status, tag, includeSuperseded, limitQuery(url.searchParams.get('limit')));
    jsonResponse(response, 200, { workspace, entries: result.entries, count: result.count });
    return;
  }
  if ((request.method === 'GET' || request.method === 'PUT') && url.pathname.startsWith('/api/entries/')) {
    const workspace = requireWorkspace(url.searchParams.get('workspace') ?? '');
    const entryId = entryIdFromPath(url.pathname);
    if (request.method === 'GET') {
      const entry = await readEntry(context.database, { workspace, entryId });
      jsonResponse(response, 200, { entry });
      return;
    }
    const payload = await readJsonBody(request);
    requireOnlyJsonFields(payload, ['expectedRevision', 'kind', 'title', 'body', 'summary', 'scope', 'provenance', 'tags', 'actor'], 'Entry update request');
    const expectedRevision = payload.expectedRevision;
    const input: Parameters<typeof updateCandidateEntry>[1] = {
      workspace,
      entryId,
      expectedRevision: expectedRevision as number,
      kind: payload.kind as EntryKind,
      title: payload.title as string,
      body: payload.body as string,
    };
    if ('summary' in payload) input.summary = payload.summary as string | null;
    if ('scope' in payload) input.scope = payload.scope as never;
    if ('provenance' in payload) input.provenance = payload.provenance as never;
    if ('tags' in payload) input.tags = payload.tags as string[];
    if ('actor' in payload) input.actor = payload.actor as string;
    const entry = await context.enqueueWrite(() => updateCandidateEntry(context.database, input));
    jsonResponse(response, 200, { entry });
    return;
  }
  throw new KiokukoError('NOT_FOUND', 'Endpoint not found');
}

function isSharedServerPath(pathname: string): boolean {
  return pathname.startsWith('/health/') || pathname === '/api/v1' || pathname.startsWith('/api/v1/');
}

function createWebApplication(context: HttpApplicationContext, trustedOrigin: () => string | undefined): RequestListener {
  const sharedApplication = context.createAuthenticatedApp(createAgentV1Handler(context));
  const sessionToken = randomBytes(32).toString('base64url');
  const externalSkillRefreshFlights: ExternalSkillRefreshFlights = {
    database: context.database,
    operations: new Map(),
  };
  return (request, response) => {
    try {
      requireTrustedWebOrigin(request, trustedOrigin());
    } catch (error) {
      jsonResponse(response, errorStatus(error), errorBody(error));
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (isSharedServerPath(pathname)) {
      sharedApplication(request, response);
      return;
    }
    void handleRequest(request, response, context, sessionToken, externalSkillRefreshFlights).catch((error: unknown) => {
      if (!response.headersSent) jsonResponse(response, errorStatus(error), errorBody(error));
      else response.destroy();
    });
  };
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  let trustedOrigin: string | undefined;
  const runtime = await startHttpServer({
    ...(options.httpOptions ?? {}),
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    applicationFactory: (context) => createWebApplication(context, () => trustedOrigin),
  });
  trustedOrigin = new URL(runtime.url).origin;
  return {
    server: runtime.server,
    url: runtime.url,
    close: () => runtime.close(),
  };
}
