import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { buildEmbeddingDocumentForProfile } from '../embedding/document.js';
import { readActiveEmbeddingProfile, readEntryEmbedding } from '../embedding/store.js';
import type { PreparedSemanticQuery, VectorSearchBackend } from '../embedding/types.js';
import { KiokukoError } from '../errors.js';
import { parseRetrievalQuery, normalizeSearchSignal, type ParsedRetrievalQuery } from './retrieval-query.js';
import { compareCanonicalStrings, ENTRY_KINDS, ENTRY_STATUSES, type EntryKind, type EntryStatus } from '../serialization/validate.js';
import { readEntry, type EntryRecord } from './entries.js';
import { isExternalSkillReference, readExternalSkill } from '../skills/store.js';

export type RetrievalLane = 'exact-signal' | 'word-fts' | 'trigram' | 'like' | 'tag' | 'semantic';

export interface HybridSearchRuntime {
  readonly semantic?: {
    readonly query: PreparedSemanticQuery;
    readonly backend: VectorSearchBackend;
  };
}

export interface HybridSearchInput {
  workspace: string;
  query: string;
  limit: number;
  kind?: EntryKind;
  status?: EntryStatus;
  tag?: string;
  includeSuperseded?: boolean;
}

export interface RetrievalCandidate {
  entryId: string;
  fusedScore: number;
  laneRanks: Partial<Record<RetrievalLane, number>>;
  matchedSignals: string[];
  reasons: string[];
}

interface SearchRow extends SqliteRow {
  id: string;
  score?: number;
  cjkWindow?: boolean;
}

const MAX_LANE_CANDIDATES = 120;
const MAX_MERGED_CANDIDATES = 1_000;
const RRF_K = 60;
const LANE_WEIGHTS: Record<RetrievalLane, number> = {
  'exact-signal': 5,
  'word-fts': 3,
  trigram: 1.5,
  like: 0.75,
  tag: 3,
  semantic: 2.5,
};

interface ExternalMappingRow extends SqliteRow {
  skill_id: unknown;
}

/** Decide eligibility only after the entry and the complete parent snapshot decode. */
export function isRetrievableEntry(database: SqliteDatabase, entry: EntryRecord): boolean {
  const mappingRows = database.prepare(`
    SELECT skill_id
      FROM external_skill_entries
     WHERE entry_id = ?
     ORDER BY skill_id, source_path, chunk_index
  `).all<ExternalMappingRow>(entry.id);
  const markedExternal = isExternalSkillReference(entry);
  if (!markedExternal && mappingRows.length === 0) return true;
  if (!markedExternal) {
    throw new KiokukoError('INTEGRITY_ERROR', 'A managed external skill mapping points to an ordinary entry');
  }
  if (mappingRows.length === 0) return false;

  const skillIds = new Set<string>();
  for (const mapping of mappingRows) {
    if (typeof mapping.skill_id !== 'string' || mapping.skill_id.length === 0) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Managed external skill mapping is invalid');
    }
    skillIds.add(mapping.skill_id);
  }
  if (skillIds.size !== 1) {
    throw new KiokukoError('INTEGRITY_ERROR', 'A managed external skill entry has multiple parent skills');
  }
  const skillId = [...skillIds][0]!;
  const detail = readExternalSkill(database, skillId);
  if (detail === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Managed external skill parent is missing');
  const active = detail.entries.filter((mapping) => mapping.entryId === entry.id && mapping.active);
  if (active.length > 1) throw new KiokukoError('INTEGRITY_ERROR', 'Managed external skill entry has multiple active mappings');
  return active.length === 1 && active[0]!.revision === entry.revision;
}

/** Count current entries in one workspace that are eligible for ordinary retrieval. */
export function retrievableWorkspaceEntryCount(database: SqliteDatabase, workspace: string): number {
  const count = database.prepare(`
    WITH current_entries AS (
      SELECT e.id, e.current_revision,
             CASE WHEN e.created_by IN ('kiokuko-skill-discovery', 'kiokuko-source-sync')
                    OR CASE WHEN json_valid(r.provenance_json)
                         THEN json_extract(r.provenance_json, '$.type') END
                       IN ('external_skill', 'source_sync')
                  THEN 1 ELSE 0 END AS external_marker
        FROM entries AS e
        JOIN entry_revisions AS r
          ON r.entry_id = e.id AND r.revision = e.current_revision
       WHERE e.workspace = ? AND e.status <> 'superseded'
    )
    SELECT COUNT(*) AS count
      FROM current_entries AS e
     WHERE (
       e.external_marker = 0
       AND NOT EXISTS (
         SELECT 1 FROM external_skill_entries AS m WHERE m.entry_id = e.id
       )
     ) OR (
       e.external_marker = 1
       AND (SELECT COUNT(DISTINCT m.skill_id)
              FROM external_skill_entries AS m WHERE m.entry_id = e.id) = 1
       AND (SELECT COUNT(*)
              FROM external_skill_entries AS m
             WHERE m.entry_id = e.id AND m.active = 1) = 1
       AND EXISTS (
         SELECT 1
           FROM external_skill_entries AS m
           JOIN external_skills AS s ON s.skill_id = m.skill_id
          WHERE m.entry_id = e.id
            AND m.entry_revision = e.current_revision
            AND m.active = 1
       )
     )
  `).get<{ count: unknown }>(workspace)?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored entry count is invalid');
  }
  return count;
}

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Search query is invalid');
}

function quotedFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapedLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function wordTokens(value: string): string[] {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}_$@]+/gu) ?? [];
}

function containsTokenSequence(source: readonly string[], expected: readonly string[]): boolean {
  if (expected.length === 0 || expected.length > source.length) return false;
  for (let start = 0; start <= source.length - expected.length; start += 1) {
    if (expected.every((token, offset) => source[start + offset] === token)) return true;
  }
  return false;
}

function hasCanonicalWordMatch(database: SqliteDatabase, input: HybridSearchInput, row: SearchRow, value: string): boolean {
  const entry = readEntry(database, { workspace: input.workspace, entryId: row.id });
  const expected = wordTokens(value);
  const source = wordTokens([entry.title, entry.body, entry.summary ?? '', ...entry.tags].join('\n'));
  return containsTokenSequence(source, expected);
}

function filterSql(input: HybridSearchInput, parameters: Array<string | number>): string {
  const clauses = ['e.workspace = ?'];
  parameters.push(input.workspace);
  return clauses.join(' AND ');
}

function rankSql(): string {
  return `CASE e.status WHEN 'verified' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
    CASE e.trust_level WHEN 'system_verified' THEN 0 WHEN 'source_verified' THEN 1 WHEN 'user_asserted' THEN 2 ELSE 3 END,
    e.confidence DESC, e.updated_at DESC, e.id ASC`;
}

function exactSignalLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  const values = [...new Set([
    parsed.normalized.length <= 512 ? normalizeSearchSignal(parsed.normalized) : '',
    ...parsed.exactSignals.map((signal) => signal.normalizedValue),
  ])].filter(Boolean).slice(0, 32);
  if (values.length === 0) return [];
  const parameters: Array<string | number> = [input.workspace, ...values];
  const filters = filterSql(input, parameters);
  parameters.push(MAX_LANE_CANDIDATES);
  return database.prepare(`
    SELECT e.id, COUNT(*) AS score
    FROM entry_search_signals AS s
    JOIN entries AS e ON e.id = s.entry_id
    JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
    WHERE e.workspace = ? AND s.normalized_value IN (${values.map(() => '?').join(', ')}) AND ${filters}
    GROUP BY e.id
    ORDER BY score DESC, ${rankSql()}
    LIMIT ?
  `).all<SearchRow>(...parameters);
}

function tagLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  const values = [...new Set([
    ...parsed.lexicalTerms,
    ...parsed.exactSignals.map((signal) => signal.value),
  ].map(normalizeSearchSignal).filter((value) => value.length > 1))].slice(0, 32);
  if (values.length === 0) return [];
  const parameters: Array<string | number> = [];
  const filters = filterSql(input, parameters);
  const tagParameters = values.map(() => '?').join(', ');
  parameters.unshift(...values);
  parameters.push(MAX_LANE_CANDIDATES);
  return database.prepare(`
    SELECT e.id, COUNT(*) AS score
    FROM entry_revision_tags AS t
    JOIN entries AS e ON e.id = t.entry_id AND e.current_revision = t.revision
    JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
    WHERE lower(t.tag) IN (${tagParameters}) AND ${filters}
    GROUP BY e.id
    ORDER BY score DESC, ${rankSql()}
    LIMIT ?
  `).all<SearchRow>(...parameters);
}

function wordFtsLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  const values = [...new Set([...parsed.lexicalTerms, ...parsed.phraseTerms])]
    .filter((value) => value.length > 0)
    .slice(0, 24);
  const rows: SearchRow[] = [];
  for (const value of values) {
    let candidates: SearchRow[];
    if (Array.from(value).length >= 3) {
      const parameters: Array<string | number> = [quotedFts(value)];
      const filters = filterSql(input, parameters);
      parameters.push(MAX_LANE_CANDIDATES);
      candidates = database.prepare(`
        SELECT e.id, bm25(entries_fts) AS score
        FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
        JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
        WHERE entries_fts MATCH ? AND ${filters}
        ORDER BY score ASC, ${rankSql()}
        LIMIT ?
      `).all<SearchRow>(...parameters);
    } else {
      const pattern = `%${escapedLike(value)}%`;
      const parameters: Array<string | number> = [pattern, pattern, pattern, pattern];
      const filters = filterSql(input, parameters);
      parameters.push(MAX_LANE_CANDIDATES);
      candidates = database.prepare(`
        SELECT e.id, 0 AS score
        FROM entry_search_documents AS d
        JOIN entries AS e ON e.rowid = d.entry_rowid
        JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
        WHERE (d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\'
          OR d.summary LIKE ? ESCAPE '\\' OR d.tags_text LIKE ? ESCAPE '\\')
          AND ${filters}
        ORDER BY ${rankSql()}
        LIMIT ?
      `).all<SearchRow>(...parameters);
    }
    rows.push(...candidates.filter((row) => hasCanonicalWordMatch(database, input, row, value)));
  }
  return rows;
}

function trigramLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  const values = parsed.substringTerms.filter((value) => Array.from(value).length >= 3).slice(0, 24);
  const rows = new Map<string, SearchRow>();
  for (const value of values) {
    const parameters: Array<string | number> = [quotedFts(value)];
    const filters = filterSql(input, parameters);
    parameters.push(MAX_LANE_CANDIDATES);
    const matches = database.prepare(`
      SELECT e.id, bm25(entries_trigram) AS score
      FROM entries_trigram JOIN entries e ON e.rowid = entries_trigram.rowid
      JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
      WHERE entries_trigram MATCH ? AND ${filters}
      ORDER BY score ASC, ${rankSql()}
      LIMIT ?
    `).all<SearchRow>(...parameters);
    const cjkWindow = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
    for (const match of matches) {
      const existing = rows.get(match.id);
      if (existing !== undefined) {
        if (cjkWindow) existing.cjkWindow = true;
      } else {
        rows.set(match.id, { ...match, ...(cjkWindow ? { cjkWindow: true } : {}) });
      }
    }
  }
  return [...rows.values()];
}

function likeLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  const values = [...new Set([
    ...parsed.exactSignals.map((signal) => signal.value),
    ...parsed.substringTerms,
  ])].filter((value) => value.length > 1).slice(0, 12);
  if (values.length === 0) return [];
  const result = new Map<string, SearchRow>();
  for (const value of values) {
    const pattern = `%${escapedLike(value)}%`;
    const parameters: Array<string | number> = [pattern, pattern, pattern, pattern];
    const filters = filterSql(input, parameters);
    parameters.push(MAX_LANE_CANDIDATES);
    const rows = database.prepare(`
      SELECT e.id, 0 AS score FROM entries AS e
      JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
      WHERE (r.title LIKE ? ESCAPE '\\' OR r.body LIKE ? ESCAPE '\\' OR COALESCE(r.summary, '') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM entry_revision_tags t WHERE t.entry_id = e.id AND t.revision = e.current_revision AND t.tag LIKE ? ESCAPE '\\'))
        AND ${filters}
      ORDER BY ${rankSql()} LIMIT ?
    `).all<SearchRow>(...parameters);
    for (const row of rows) result.set(row.id, row);
  }
  return [...result.values()];
}

function semanticLane(database: SqliteDatabase, input: HybridSearchInput, runtime: HybridSearchRuntime): SearchRow[] {
  const semantic = runtime.semantic;
  if (semantic === undefined) return [];
  const { query, backend } = semantic;
  if (typeof query.profileId !== 'string' || query.profileId.length === 0
    || !Number.isSafeInteger(query.dimensions) || query.dimensions < 2 || query.dimensions > 8192
    || !(query.vector instanceof Float32Array) || query.vector.length !== query.dimensions
    || !Number.isFinite(query.distanceCeiling) || query.distanceCeiling < 0 || query.distanceCeiling >= 2
    || typeof query.backendId !== 'string' || query.backendId.length === 0
     || query.backendId !== backend.id) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Prepared semantic query is invalid');
  }
  const active = readActiveEmbeddingProfile(database);
  if (active === null || active.profile.profileId !== query.profileId) return [];
  if (active.profile.identity.dimensions !== query.dimensions) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Prepared semantic query dimensions do not match the active profile');
  }
  const hits = backend.search(database, {
    profileId: query.profileId,
    dimensions: query.dimensions,
    queryVector: query.vector,
    distanceCeiling: query.distanceCeiling,
    workspace: input.workspace,
    limit: MAX_LANE_CANDIDATES,
  });
  if (!Array.isArray(hits) || hits.length > MAX_LANE_CANDIDATES) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Semantic backend returned too many candidates');
  }
  const canonical = new Map<string, number>();
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null
      || typeof hit.entryId !== 'string' || hit.entryId.length === 0
      || !Number.isFinite(hit.distance) || hit.distance < 0) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Semantic backend returned an invalid candidate');
    }
    if (hit.distance > query.distanceCeiling) continue;
    const previous = canonical.get(hit.entryId);
    if (previous === undefined || hit.distance < previous) canonical.set(hit.entryId, hit.distance);
  }
  return [...canonical.entries()]
    .sort((left, right) => left[1] - right[1] || compareCanonicalStrings(left[0], right[0]))
    .filter(([id]) => {
      const entry = readEntry(database, { workspace: input.workspace, entryId: id });
      const embedding = readEntryEmbedding(database, { entryId: entry.id, profileId: active.profile.profileId });
      if (embedding === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Semantic backend returned an entry without its stored vector');
      if (embedding.revision !== entry.revision || embedding.contentHash !== entry.contentHash) return false;
      if (embedding.dimensions !== query.dimensions) throw new KiokukoError('INTEGRITY_ERROR', 'Stored vector dimensions do not match the active profile');
      const document = buildEmbeddingDocumentForProfile({
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        body: entry.body,
        tags: entry.tags,
        scope: entry.scope,
      }, active.profile.identity);
      if (embedding.documentHash !== document.documentHash) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Stored vector document hash does not match the canonical entry');
      }
      return true;
    })
    .map(([id]) => ({ id }));
}

function laneRows(
  database: SqliteDatabase,
  input: HybridSearchInput,
  parsed: ParsedRetrievalQuery,
  runtime: HybridSearchRuntime,
  lexicalAllowed: boolean,
): Array<[RetrievalLane, SearchRow[]]> {
  const rows: Array<[RetrievalLane, SearchRow[]]> = [['exact-signal', exactSignalLane(database, input, parsed)]];
  if (lexicalAllowed) {
    rows.push(
      ['word-fts', wordFtsLane(database, input, parsed)],
      ['trigram', trigramLane(database, input, parsed)],
      ['like', likeLane(database, input, parsed)],
      ['tag', tagLane(database, input, parsed)],
    );
  }
  if (runtime.semantic !== undefined) rows.push(['semantic', semanticLane(database, input, runtime)]);
  return rows;
}

export function hybridSearch(
  database: SqliteDatabase,
  input: HybridSearchInput,
  runtime: HybridSearchRuntime = {},
): RetrievalCandidate[] {
  if (typeof input.workspace !== 'string' || input.workspace.trim().length === 0) invalid();
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) invalid();
  if (input.kind !== undefined && !ENTRY_KINDS.includes(input.kind)) invalid();
  if (input.status !== undefined && !ENTRY_STATUSES.includes(input.status)) invalid();
  if (input.tag !== undefined && (typeof input.tag !== 'string' || input.tag.length === 0)) invalid();
  const parsed = parseRetrievalQuery(input.query);
  if (parsed.normalized.length === 0) return [];
  // Treat SQL/FTS-looking operator soup as data, not as a broad OR query. A
  // punctuation-heavy request must never turn into a full-table lexical scan.
  const lexicalAllowed = !/(?:--|\/\*|\*\/|["']\s*(?:OR|AND)\b|\b(?:OR|AND)\s+\d+\s*[=<>])/iu.test(parsed.normalized)
    || parsed.exactSignals.length > 0;
  const merged = new Map<string, RetrievalCandidate>();
  for (const [lane, rows] of laneRows(database, input, parsed, runtime, lexicalAllowed)) {
    const seen = new Set<string>();
    let rank = 0;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rank += 1;
      const existing = merged.get(row.id) ?? { entryId: row.id, fusedScore: 0, laneRanks: {}, matchedSignals: [], reasons: [] };
      existing.fusedScore += LANE_WEIGHTS[lane] / (RRF_K + rank);
      existing.laneRanks[lane] = Math.min(existing.laneRanks[lane] ?? rank, rank);
      if (lane === 'exact-signal') existing.reasons.push('exact_signal_match');
      if (lane === 'word-fts') existing.reasons.push('word_match');
      if (lane === 'trigram') {
        existing.reasons.push('substring_match');
        if (row.cjkWindow === true) existing.reasons.push('cjk_window_match');
      }
      if (lane === 'like') existing.reasons.push('literal_fallback_match');
      if (lane === 'tag') existing.reasons.push('tag_match');
      if (lane === 'semantic') existing.reasons.push('semantic_match');
      existing.matchedSignals.push(...parsed.exactSignals.map((signal) => signal.value));
      merged.set(row.id, existing);
      if (merged.size >= MAX_MERGED_CANDIDATES) break;
    }
  }
  const candidates = [...merged.values()]
    .map((candidate) => ({
      ...candidate,
      matchedSignals: [...new Set(candidate.matchedSignals)].sort(),
      reasons: [...new Set(candidate.reasons)].sort(),
    }))
    .sort((left, right) => right.fusedScore - left.fusedScore || compareCanonicalStrings(left.entryId, right.entryId));
  // Candidate generation may use projections, but every semantic predicate is
  // applied only to the canonical decoded record.
  return candidates.filter((candidate) => {
    const entry = readEntry(database, { workspace: input.workspace, entryId: candidate.entryId });
    if (!isRetrievableEntry(database, entry)) return false;
    if (!input.includeSuperseded && entry.status === 'superseded') return false;
    if (input.kind !== undefined && entry.kind !== input.kind) return false;
    if (input.status !== undefined && entry.status !== input.status) return false;
    if (input.tag !== undefined && !entry.tags.includes(input.tag)) return false;
    return true;
  });
}
