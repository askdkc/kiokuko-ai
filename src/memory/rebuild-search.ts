import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readEntry } from './entries.js';
import { decodeStoredStructuredScope } from './revisions.js';
import {
  extractEntrySearchSignals,
  hybridSearchProjectionSchema,
  requireHybridSearchProjectionSchema,
} from './structured-memory.js';

interface EntryOwnerRow extends SqliteRow {
  rowid: unknown;
  id: unknown;
  workspace: unknown;
}

interface PreparedEntryProjection {
  rowid: number;
  entryId: string;
  title: string;
  body: string;
  summary: string;
  tagsText: string;
  signals: Array<{ type: string; value: string }>;
}

function integrity(message = 'Stored search projection source is invalid'): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

const UNIFIED_FTS_TABLES = ['entries_fts', 'entries_trigram'] as const;

function assertUnifiedFtsIntegrity(database: SqliteDatabase): void {
  try {
    for (const table of UNIFIED_FTS_TABLES) {
      database.prepare(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`).run();
    }
  } catch {
    integrity('Hybrid search index is inconsistent with its content');
  }
}

function rebuildUnifiedFtsIndexes(database: SqliteDatabase): void {
  try {
    for (const table of UNIFIED_FTS_TABLES) {
      database.prepare(`INSERT INTO ${table}(${table}) VALUES ('rebuild')`).run();
    }
  } catch {
    integrity('Hybrid search index rebuild failed');
  }
  assertUnifiedFtsIntegrity(database);
}

function preparedProjections(database: SqliteDatabase): PreparedEntryProjection[] {
  const entryCount = database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: unknown }>()?.count;
  if (typeof entryCount !== 'number' || !Number.isSafeInteger(entryCount) || entryCount < 0) integrity();
  const rows = database.prepare('SELECT rowid, id, workspace FROM entries ORDER BY id').all<EntryOwnerRow>();
  if (rows.length !== entryCount) integrity('A current entry revision is missing');
  return rows.map((row) => {
    if (typeof row.rowid !== 'number' || !Number.isSafeInteger(row.rowid) || row.rowid < 1
      || typeof row.id !== 'string' || row.id.length === 0
      || typeof row.workspace !== 'string' || row.workspace.length === 0) integrity();
    let entry: ReturnType<typeof readEntry>;
    try {
      entry = readEntry(database, { workspace: row.workspace, entryId: row.id });
    } catch (error) {
      if (error instanceof KiokukoError
        && (error.code === 'VALIDATION_ERROR' || error.code === 'NOT_FOUND')) integrity();
      throw error;
    }
    const scope = decodeStoredStructuredScope(entry.scope).canonicalScope;
    return {
      rowid: row.rowid,
      entryId: row.id,
      title: entry.title,
      body: entry.body,
      summary: entry.summary ?? '',
      tagsText: entry.tags.join(' '),
      signals: extractEntrySearchSignals({
        entryId: row.id,
        title: entry.title,
        body: entry.body,
        summary: entry.summary,
        tags: entry.tags,
        scope,
      }),
    };
  });
}

/** Rebuild while participating in a transaction already owned by the caller. */
export function rebuildHybridSearchInTransaction(database: SqliteDatabase): { entries: number; signals: number } {
  requireHybridSearchProjectionSchema(database);
  const projections = preparedProjections(database);
  const expectedSignals = projections.reduce((count, projection) => count + projection.signals.length, 0);

  // Repair the external indexes before content-table deletes fire FTS delete
  // commands; an empty or inconsistent index cannot safely consume them.
  rebuildUnifiedFtsIndexes(database);
  database.exec('DELETE FROM entry_search_documents');
  database.exec('DELETE FROM entry_search_signals');

  const insertDocument = database.prepare('INSERT INTO entry_search_documents (entry_rowid, entry_id, title, body, summary, tags_text) VALUES (?, ?, ?, ?, ?, ?)');
  const insertSignal = database.prepare('INSERT INTO entry_search_signals (entry_id, signal_type, normalized_value) VALUES (?, ?, ?)');
  for (const projection of projections) {
    insertDocument.run(
      projection.rowid,
      projection.entryId,
      projection.title,
      projection.body,
      projection.summary,
      projection.tagsText,
    );
    for (const signal of projection.signals) insertSignal.run(projection.entryId, signal.type, signal.value);
  }

  rebuildUnifiedFtsIndexes(database);

  const documentCount = database.prepare('SELECT COUNT(*) AS count FROM entry_search_documents').get<{ count: unknown }>()?.count;
  const signalCount = database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals').get<{ count: unknown }>()?.count;
  if (documentCount !== projections.length || signalCount !== expectedSignals) {
    integrity('Hybrid search projection rebuild produced an incomplete result');
  }
  return { entries: projections.length, signals: expectedSignals };
}

export function rebuildHybridSearch(database: SqliteDatabase): { entries: number; signals: number } {
  return withImmediateTransaction(database, () => rebuildHybridSearchInTransaction(database));
}

export function hybridSearchProjectionStatus(database: SqliteDatabase): {
  trigram: number;
  signals: number;
  entries: number;
  missingSignals: number;
  extraSignals: number;
  staleTrigram: number;
} {
  hybridSearchProjectionSchema(database);
  assertUnifiedFtsIntegrity(database);
  const projections = preparedProjections(database);
  const storedCount = (table: 'entry_search_documents' | 'entries_trigram' | 'entry_search_signals'): number => {
    const count = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: unknown }>()?.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) integrity();
    return count;
  };
  const entries = projections.length;
  const trigram = storedCount('entry_search_documents');
  const signals = storedCount('entry_search_signals');
  let missingSignals = 0;
  let extraSignals = 0;
  let staleTrigram = Math.abs(trigram - entries);
  for (const projection of projections) {
    const expected = new Set(projection.signals.map((signal) => `${signal.type}\u0000${signal.value}`));
    const actual = new Set(database.prepare('SELECT signal_type, normalized_value FROM entry_search_signals WHERE entry_id = ?').all<{ signal_type: string; normalized_value: string }>(projection.entryId).map((signal) => `${signal.signal_type}\u0000${signal.normalized_value}`));
    for (const signal of expected) if (!actual.has(signal)) missingSignals += 1;
    for (const signal of actual) if (!expected.has(signal)) extraSignals += 1;
    const projected = database.prepare('SELECT entry_id, title, body, summary, tags_text FROM entry_search_documents WHERE entry_rowid = ?')
      .get<{ entry_id?: unknown; title: unknown; body: unknown; summary: unknown; tags_text: unknown }>(projection.rowid);
    if (!projected
      || projected.entry_id !== projection.entryId
      || projected.title !== projection.title
      || projected.body !== projection.body
      || projected.summary !== projection.summary
      || projected.tags_text !== projection.tagsText) staleTrigram += 1;
  }
  return { entries, trigram, signals, missingSignals, extraSignals, staleTrigram };
}
