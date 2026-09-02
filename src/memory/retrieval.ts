import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEntry, type EntryRecord } from './entries.js';
import { requireWorkspace, type EntryKind, type EntryStatus } from '../serialization/validate.js';
import { hybridSearch, type HybridSearchRuntime } from './hybrid-retrieval.js';

export interface SearchEntriesInput {
  workspace: string;
  query: string;
  limit?: number;
  kind?: EntryKind;
  status?: EntryStatus;
  tag?: string;
  includeSuperseded?: boolean;
}

export interface SearchResult {
  items: EntryRecord[];
  count: number;
  truncated: boolean;
}

export interface RecallEntriesInput extends SearchEntriesInput {
  maxChars?: number;
}

export interface RecallItem {
  id: string;
  workspace: string;
  kind: EntryKind;
  status: EntryStatus;
  title: string;
  summary: string | null;
  snippet: string;
  tags: string[];
  metadata: {
    storedData: true;
    untrusted: true;
    instructions: false;
  };
}

export interface RecallResult {
  items: RecallItem[];
  count: number;
  characterCount: number;
  truncated: boolean;
}

export interface RankedRecallHit {
  entryId: string;
  retrievalScore: number;
  rank: number;
  reasons: string[];
}

export interface RankedRecallResult {
  hits: RankedRecallHit[];
  truncated: boolean;
}

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_RECALL_MAX_CHARS = 8000;
const MAX_LIMIT = 1000;
const MAX_RECALL_CHARS = 100_000;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function takeCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join('');
}

function normalizedLimit(value: number | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new KiokukoError('VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function normalizedMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECALL_MAX_CHARS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RECALL_CHARS) {
    throw new KiokukoError('VALIDATION_ERROR', `maxChars must be an integer between 1 and ${MAX_RECALL_CHARS}`);
  }
  return value;
}

export function rankedEntryHits(
  database: SqliteDatabase,
  input: SearchEntriesInput,
  runtime: HybridSearchRuntime = {},
): RankedRecallResult {
  const limit = normalizedLimit(input.limit, DEFAULT_SEARCH_LIMIT);
  const workspace = requireWorkspace(input.workspace);
  const normalizedInput = { ...input, workspace };
  if (normalizedInput.query.trim().length === 0) return { hits: [], truncated: false };

  const candidates = hybridSearch(database, { ...normalizedInput, limit }, runtime);
  return {
    hits: candidates.slice(0, limit).map((candidate, index) => ({
      entryId: candidate.entryId,
      retrievalScore: Number((candidate.fusedScore * 100).toFixed(6)),
      rank: index + 1,
      reasons: [...candidate.reasons],
    })),
    truncated: candidates.length > limit,
  };
}

export function searchEntries(
  database: SqliteDatabase,
  input: SearchEntriesInput,
  runtime: HybridSearchRuntime = {},
): SearchResult {
  const limit = normalizedLimit(input.limit, DEFAULT_SEARCH_LIMIT);
  const selected = rankedEntryHits(database, { ...input, limit }, runtime);
  const items = selected.hits.map((hit) => readEntry(database, { workspace: input.workspace, entryId: hit.entryId }));
  return { items, count: items.length, truncated: selected.truncated };
}

function recallSnippet(entry: EntryRecord, remaining: number): string {
  const source = entry.summary ?? entry.body;
  if (remaining <= 0) return '';
  return takeCharacters(source, remaining);
}

export function recallEntries(
  database: SqliteDatabase,
  input: RecallEntriesInput,
  runtime: HybridSearchRuntime = {},
): RecallResult {
  const limit = normalizedLimit(input.limit, DEFAULT_RECALL_LIMIT);
  const maxChars = normalizedMaxChars(input.maxChars);
  const selected = rankedEntryHits(database, { ...input, limit }, runtime);
  const rows = selected.hits;
  const items: RecallItem[] = [];
  let characters = 0;
  let truncated = false;

  for (const row of rows) {
    const entry = readEntry(database, { workspace: input.workspace, entryId: row.entryId });
    const fullSource = entry.summary ?? entry.body;
    const titleCost = characterCount(entry.title) + 1;
    const remaining = maxChars - characters - titleCost;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const snippet = recallSnippet(entry, remaining);
    if (characterCount(snippet) < characterCount(fullSource)
      || characterCount(entry.body) > characterCount(snippet)) truncated = true;
    items.push({
      id: entry.id,
      workspace: entry.workspace,
      kind: entry.kind,
      status: entry.status,
      title: entry.title,
      summary: entry.summary,
      snippet,
      tags: entry.tags,
      metadata: { storedData: true, untrusted: true, instructions: false },
    });
    characters += titleCost + characterCount(snippet);
    if (characters >= maxChars) break;
  }

  if (items.length < rows.length || selected.truncated) truncated = true;
  return { items, count: items.length, characterCount: characters, truncated };
}
