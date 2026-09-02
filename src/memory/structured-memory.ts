import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { canonicalTagOrder, compareCanonicalStrings, type JsonObject } from '../serialization/validate.js';
import { findSecret } from './secrets.js';
import { normalizeSearchSignal } from './retrieval-query.js';

export const MEMORY_CLASSES = [
  'implementation-pattern', 'troubleshooting', 'tool-usage', 'extension-usage',
  'configuration', 'workflow', 'gotcha', 'reference', 'preference',
] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

export const RETRIEVAL_SCOPES = ['project-only', 'ecosystem', 'global'] as const;
export type RetrievalScope = (typeof RETRIEVAL_SCOPES)[number];

export interface Applicability {
  languages?: string[];
  frameworks?: Array<{ name: string; version?: string }>;
  databases?: string[];
  runtimes?: string[];
  tools?: string[];
  platforms?: string[];
}

export interface MemorySignals {
  symbols?: string[];
  paths?: string[];
  errors?: string[];
  packages?: string[];
  commands?: string[];
}

export interface StructuredMemoryOptions {
  visibility: 'project' | 'global';
  retrievalScope?: RetrievalScope;
  repositoryId?: string;
  memoryClass?: MemoryClass;
  applicability?: Applicability;
  signals?: MemorySignals;
  portableReason?: string;
}

/** Resolve the retrieval policy of a structured scope. */
export function effectiveRetrievalScope(scope: Record<string, unknown>): RetrievalScope {
  if (scope.retrievalScope !== undefined) {
    if (!RETRIEVAL_SCOPES.includes(scope.retrievalScope as RetrievalScope)) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored retrieval scope is invalid');
    }
    return scope.retrievalScope as RetrievalScope;
  }
  return scope.visibility === 'global' ? 'global' : 'project-only';
}

export function hasExplicitApplicability(scope: Record<string, unknown>): boolean {
  const applicability = scope.applicability;
  if (typeof applicability !== 'object' || applicability === null || Array.isArray(applicability)) return false;
  const values = Object.entries(applicability as Record<string, unknown>);
  const dimensions = new Set(['languages', 'frameworks', 'databases', 'runtimes', 'tools', 'platforms']);
  if (values.some(([key, value]) => !dimensions.has(key) || !Array.isArray(value))) return false;
  return values.some(([, value]) => (value as unknown[]).length > 0);
}

const SIGNAL_TYPES = {
  language: 'language', framework: 'framework', runtime: 'runtime', database: 'database',
  tool: 'tool', platform: 'platform', package: 'package', symbol: 'symbol', path: 'path',
  error: 'error', command: 'command', tag: 'tag',
} as const;

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Structured memory metadata is invalid');
}

function cleanString(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  if (findSecret(value)) throw new KiokukoError('SECURITY_REJECTION', 'Structured memory metadata resembles a secret and was not stored');
  return value.normalize('NFKC').trim();
}

function stringList(value: unknown, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return [...new Set(value.map((item) => cleanString(item)))].sort();
}

function optionalStringList(value: unknown): string[] | undefined {
  return value === undefined ? undefined : stringList(value);
}

function validateRelativePath(value: string): string {
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.split(/[\\/]/u).includes('..')) invalid();
  return value.replaceAll('\\', '/');
}

export function validateApplicability(value: unknown): Applicability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const allowed = new Set(['languages', 'frameworks', 'databases', 'runtimes', 'tools', 'platforms']);
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid();
  const frameworks = input.frameworks === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(input.frameworks) || input.frameworks.length > 50) invalid();
      const normalized = input.frameworks.map((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) invalid();
        const framework = item as Record<string, unknown>;
        if (Object.keys(framework).some((key) => key !== 'name' && key !== 'version')) invalid();
        return {
          name: cleanString(framework.name),
          ...(framework.version === undefined ? {} : { version: cleanString(framework.version, 100) }),
        };
      });
      return [...new Map(normalized.map((item) => [`${item.name}\u0000${item.version ?? ''}`, item])).values()]
        .sort((left, right) => compareCanonicalStrings(`${left.name}\u0000${left.version ?? ''}`, `${right.name}\u0000${right.version ?? ''}`));
    })();
  const result: Applicability = {};
  const languages = optionalStringList(input.languages);
  const databases = optionalStringList(input.databases);
  const runtimes = optionalStringList(input.runtimes);
  const tools = optionalStringList(input.tools);
  const platforms = optionalStringList(input.platforms);
  if (languages !== undefined) result.languages = languages;
  if (frameworks !== undefined) result.frameworks = frameworks;
  if (databases !== undefined) result.databases = databases;
  if (runtimes !== undefined) result.runtimes = runtimes;
  if (tools !== undefined) result.tools = tools;
  if (platforms !== undefined) result.platforms = platforms;
  return result;
}

export function validateSignals(value: unknown): MemorySignals {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const allowed = new Set(['symbols', 'paths', 'errors', 'packages', 'commands']);
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid();
  const paths = input.paths === undefined ? undefined : stringList(input.paths).map(validateRelativePath);
  return {
    ...(input.symbols === undefined ? {} : { symbols: stringList(input.symbols) }),
    ...(paths === undefined ? {} : { paths }),
    ...(input.errors === undefined ? {} : { errors: stringList(input.errors) }),
    ...(input.packages === undefined ? {} : { packages: stringList(input.packages) }),
    ...(input.commands === undefined ? {} : { commands: stringList(input.commands) }),
  };
}

export function buildStructuredScope(options: StructuredMemoryOptions): JsonObject {
  if (options.visibility !== 'project' && options.visibility !== 'global') invalid();
  if (options.retrievalScope !== undefined && !RETRIEVAL_SCOPES.includes(options.retrievalScope)) invalid();
  if (options.visibility === 'global' && options.retrievalScope !== undefined && options.retrievalScope !== 'global') invalid();
  if (options.visibility === 'project' && options.retrievalScope === 'global') invalid();
  const validatedApplicability = options.applicability === undefined ? undefined : validateApplicability(options.applicability);
  const hasApplicability = validatedApplicability !== undefined && Object.values(validatedApplicability).some((value) => Array.isArray(value) && value.length > 0);
  if (options.visibility === 'project' && options.retrievalScope === 'ecosystem' && !hasApplicability) invalid();
  if (options.visibility === 'global' && !hasApplicability && options.portableReason === undefined) invalid();
  if (options.visibility === 'global' && options.portableReason !== undefined) cleanString(options.portableReason, 2_000);
  if (options.memoryClass !== undefined && !MEMORY_CLASSES.includes(options.memoryClass)) invalid();
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    visibility: options.visibility,
  };
  if (options.retrievalScope !== undefined) result.retrievalScope = options.retrievalScope;
  if (options.repositoryId !== undefined) result.repositoryId = cleanString(options.repositoryId, 256);
  if (options.memoryClass !== undefined) result.memoryClass = options.memoryClass;
  if (validatedApplicability !== undefined) result.applicability = validatedApplicability;
  if (options.signals !== undefined) result.signals = validateSignals(options.signals);
  if (options.portableReason !== undefined) result.portableReason = cleanString(options.portableReason, 2_000);
  return result as JsonObject;
}

function collect(values: string[] | undefined, type: keyof typeof SIGNAL_TYPES, result: Array<{ type: string; value: string }>): void {
  for (const value of values ?? []) result.push({ type: SIGNAL_TYPES[type], value: normalizeSearchSignal(value) });
}

export function extractEntrySearchSignals(input: {
  entryId: string;
  title: string;
  body: string;
  summary: string | null;
  tags: string[];
  scope: JsonObject;
}): Array<{ type: string; value: string }> {
  const result: Array<{ type: string; value: string }> = [];
  const scope = input.scope as Record<string, unknown>;
  // Unversioned scope remains arbitrary user JSON. Only the current structured
  // contract contributes searchable metadata.
  const structuredScope = scope.schemaVersion === 1 ? scope : {};
  const applicability = (structuredScope.applicability ?? {}) as Record<string, unknown>;
  const signals = (structuredScope.signals ?? {}) as Record<string, unknown>;
  collect(input.tags, 'tag', result);
  collect(Array.isArray(applicability.languages) ? applicability.languages as string[] : undefined, 'language', result);
  collect(Array.isArray(applicability.databases) ? applicability.databases as string[] : undefined, 'database', result);
  collect(Array.isArray(applicability.runtimes) ? applicability.runtimes as string[] : undefined, 'runtime', result);
  collect(Array.isArray(applicability.tools) ? applicability.tools as string[] : undefined, 'tool', result);
  collect(Array.isArray(applicability.platforms) ? applicability.platforms as string[] : undefined, 'platform', result);
  if (Array.isArray(applicability.frameworks)) collect(applicability.frameworks.flatMap((item) => typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string' ? [(item as { name: string }).name] : []), 'framework', result);
  collect(Array.isArray(signals.symbols) ? signals.symbols as string[] : undefined, 'symbol', result);
  collect(Array.isArray(signals.paths) ? signals.paths as string[] : undefined, 'path', result);
  collect(Array.isArray(signals.errors) ? signals.errors as string[] : undefined, 'error', result);
  collect(Array.isArray(signals.packages) ? signals.packages as string[] : undefined, 'package', result);
  collect(Array.isArray(signals.commands) ? signals.commands as string[] : undefined, 'command', result);
  const text = [input.title, input.body, input.summary ?? ''].join('\n');
  const structured = text.match(/(?:SQLSTATE\[[^\]]+\]|@[A-Za-z][\w.-]*|\$[A-Za-z_][\w$]*|[A-Za-z_$][\w$]*(?:::|->)[\w$:.()\\-]+|\/[A-Za-z0-9_./-]{2,})/gu) ?? [];
  for (const value of structured) {
    const type = /^SQLSTATE\[/iu.test(value) ? 'error' : value.startsWith('/') ? 'path' : 'symbol';
    result.push({ type, value: normalizeSearchSignal(value) });
  }
  const dedupe = new Map<string, { type: string; value: string }>();
  for (const item of result) if (item.value.length > 0) dedupe.set(`${item.type}\u0000${item.value}`, item);
  return [...dedupe.values()].sort((left, right) => compareCanonicalStrings(`${left.type}:${left.value}`, `${right.type}:${right.value}`));
}

const REQUIRED_PROJECTION_COLUMNS = {
  entries_fts: ['title', 'body', 'summary', 'tags_text'],
  entries_trigram: ['title', 'body', 'summary', 'tags_text'],
  entry_search_documents: ['entry_rowid', 'entry_id', 'title', 'body', 'summary', 'tags_text'],
  entry_search_signals: ['entry_id', 'signal_type', 'normalized_value'],
} as const;

const REQUIRED_SEARCH_DOCUMENT_TRIGGERS = [
  'entry_search_documents_ai',
  'entry_search_documents_ad',
  'entry_search_documents_au',
] as const;

function projectionDefinition(database: SqliteDatabase, name: string): { type: string; sql: string | null } | undefined {
  return database.prepare('SELECT type, sql FROM sqlite_master WHERE name = ?')
    .get<{ type: string; sql: string | null }>(name);
}

function projectionColumns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>().map((column) => column.name));
}

/** Validate the single search projection used by the v0.1.0 schema. */
export function hybridSearchProjectionSchema(database: SqliteDatabase): 'unified' {
  requireHybridSearchProjectionSchema(database);
  return 'unified';
}

/** Assert the complete search schema consumed by hybridSearch before mutating a projection. */
export function requireHybridSearchProjectionSchema(database: SqliteDatabase): void {
  const missing: string[] = [];
  for (const [table, expectedColumns] of Object.entries(REQUIRED_PROJECTION_COLUMNS)) {
    const definition = projectionDefinition(database, table);
    if (definition?.type !== 'table') {
      missing.push(table);
      continue;
    }
    const columns = projectionColumns(database, table);
    for (const column of expectedColumns) if (!columns.has(column)) missing.push(`${table}.${column}`);
    if (table === 'entries_fts' || table === 'entries_trigram') {
      const sql = definition.sql ?? '';
      if (!/CREATE\s+VIRTUAL\s+TABLE[\s\S]+USING\s+fts5\s*\(/iu.test(sql)
        || !/content\s*=\s*'entry_search_documents'/iu.test(sql)
        || !/content_rowid\s*=\s*'entry_rowid'/iu.test(sql)
        || (table === 'entries_fts'
          ? !/tokenize\s*=\s*'unicode61 remove_diacritics 2'/iu.test(sql)
          : !/tokenize\s*=\s*'trigram'/iu.test(sql))) {
        missing.push(`${table}.fts5_external_${table === 'entries_fts' ? 'unicode61' : 'trigram'}`);
      }
    }
  }
  for (const trigger of REQUIRED_SEARCH_DOCUMENT_TRIGGERS) {
    const definition = projectionDefinition(database, trigger);
    if (definition?.type !== 'trigger'
      || !/entries_fts/iu.test(definition.sql ?? '')
      || !/entries_trigram/iu.test(definition.sql ?? '')) missing.push(trigger);
  }
  if (missing.length > 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Hybrid search projection schema is incomplete', { missing });
  }
}

export function syncEntrySearchSignals(database: SqliteDatabase, input: Parameters<typeof extractEntrySearchSignals>[0]): void {
  hybridSearchProjectionSchema(database);
  database.prepare('DELETE FROM entry_search_signals WHERE entry_id = ?').run(input.entryId);
  for (const signal of extractEntrySearchSignals(input)) {
    database.prepare('INSERT OR IGNORE INTO entry_search_signals (entry_id, signal_type, normalized_value) VALUES (?, ?, ?)').run(input.entryId, signal.type, signal.value);
  }
}

/** Refresh every search projection for the entry's current revision. */
export function syncEntrySearchProjection(database: SqliteDatabase, input: Parameters<typeof extractEntrySearchSignals>[0]): void {
  hybridSearchProjectionSchema(database);
  const row = database.prepare('SELECT rowid FROM entries WHERE id = ?').get<{ rowid: number }>(input.entryId);
  if (row === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Search projection entry is missing');
  const revision = database.prepare('SELECT current_revision FROM entries WHERE id = ?').get<{ current_revision: number }>(input.entryId);
  if (revision === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Search projection revision is missing');
  const revisionNumber = Number(revision.current_revision);
  const tags = canonicalTagOrder(input.tags);
  database.prepare('DELETE FROM entry_search_documents WHERE entry_id = ?').run(input.entryId);
  database.prepare(`
    INSERT INTO entry_search_documents(entry_rowid, entry_id, title, body, summary, tags_text)
    SELECT e.rowid, e.id, r.title, r.body, COALESCE(r.summary, ''), ?
      FROM entries AS e
      JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
     WHERE e.id = ? AND e.current_revision = ?
  `).run(tags.join(' '), input.entryId, revisionNumber);
  const stored = database.prepare('SELECT entry_id FROM entry_search_documents WHERE entry_rowid = ?')
    .get<{ entry_id: unknown }>(row.rowid);
  if (stored?.entry_id !== input.entryId) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Search projection refresh produced an incomplete result');
  }
  syncEntrySearchSignals(database, { ...input, tags });
}
