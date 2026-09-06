import path from 'node:path';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { findSecretInValue } from '../memory/secrets.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import { findSkills } from '../skills/find.js';
import { enqueueOrchestrationJob } from '../orchestration/jobs.js';
import { readOrcaTraceRun, type OrcaTraceEvent, type OrcaTraceIntegrity } from './orca-trace.js';

export const ORCA_TRACE_CONTEXT_MAX_BYTES = 4096;
export const ORCA_TRACE_MAX_MEMORY_CANDIDATES = 8;
export const ORCA_TRACE_MAX_SKILL_QUERIES = 3;
export const ORCA_TRACE_MAX_SKILL_CANDIDATES = 2;
const MAX_LISTED_TOOL_CALLS = 8;
const MAX_LISTED_ERRORS = 4;
const MAX_LISTED_FS_CHANGES = 8;
const MAX_LISTED_NOTES = 4;

export interface TraceCursorRow {
  readonly lastSeq: number;
  readonly state: 'active' | 'unsupported';
  readonly updatedAt: string;
}

export interface TraceSkillSearch {
  readonly queries: readonly string[];
  readonly candidates: ReadonlyArray<{
    readonly skillId: string;
    readonly name: string;
    readonly source: string;
    readonly officialStatus: string;
  }>;
  readonly failures: ReadonlyArray<{ readonly query: string; readonly code: string }>;
}

export interface TraceIngestInput {
  readonly runsDirectory: string;
  readonly traceRunId: string;
  readonly fromSeq: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: string;
}

export interface TraceIngestOutcome {
  readonly ingested: boolean;
  readonly reason: 'unsupported_schema' | 'already_ingested' | undefined;
  readonly traceRunId: string;
  readonly throughSeq: number;
  readonly cursorSeq: number;
  readonly integrity: OrcaTraceIntegrity;
  readonly contextDigest: string | undefined;
  readonly memoryCandidates: number;
  readonly suppressedMemoryCandidates: number;
  readonly skillCandidates: number;
}

function requireRunsDirectory(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length === 0 || value.length > 4096) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Trace ingestion runs directory is invalid');
  }
  return value;
}

export function requireTraceRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^run_[0-9a-f]{6,32}$/u.test(value)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Trace ingestion run ID is invalid');
  }
  return value;
}

function requireFromSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Trace ingestion cursor origin is invalid');
  }
  return value;
}

export function readTraceCursor(
  database: SqliteDatabase,
  runsDirectory: string,
  traceRunId: string,
): TraceCursorRow | undefined {
  const row = database.prepare(`
    SELECT last_seq AS lastSeq, state AS state, updated_at AS updatedAt
    FROM orcareplay_trace_cursors
    WHERE directory = ? AND trace_run_id = ?
  `).get<{ lastSeq: unknown; state: unknown; updatedAt: unknown }>(runsDirectory, traceRunId);
  if (row === undefined) return undefined;
  if (typeof row.lastSeq !== 'number' || !Number.isSafeInteger(row.lastSeq) || row.lastSeq < 0
    || (row.state !== 'active' && row.state !== 'unsupported')
    || typeof row.updatedAt !== 'string') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored OrcaReplay trace cursor is invalid');
  }
  return { lastSeq: row.lastSeq, state: row.state, updatedAt: row.updatedAt };
}

export function upsertTraceCursor(
  database: SqliteDatabase,
  input: {
    readonly runsDirectory: string;
    readonly traceRunId: string;
    readonly lastSeq: number;
    readonly state: 'active' | 'unsupported';
    readonly now: string;
  },
): void {
  if (!Number.isSafeInteger(input.lastSeq) || input.lastSeq < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Trace cursor sequence is invalid');
  }
  database.prepare(`
    INSERT INTO orcareplay_trace_cursors (directory, trace_run_id, last_seq, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(directory, trace_run_id) DO UPDATE SET
      last_seq = excluded.last_seq,
      state = excluded.state,
      updated_at = excluded.updated_at
  `).run(input.runsDirectory, input.traceRunId, input.lastSeq, input.state, input.now, input.now);
}

interface TraceProjection {
  readonly events: number;
  readonly turns: number;
  readonly errorCount: number;
  readonly shellFailures: number;
  readonly runEnded: boolean;
  readonly exitCode: number | undefined;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  readonly errors: ReadonlyArray<{ readonly kind: string; readonly suite?: string; readonly seq: number }>;
  readonly fsChanges: ReadonlyArray<{ readonly path: string; readonly status: string }>;
  readonly notes: ReadonlyArray<{ readonly rule: string; readonly detail?: string }>;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function buildTraceProjection(events: readonly OrcaTraceEvent[]): TraceProjection {
  const toolCounts = new Map<string, number>();
  const errors: Array<{ kind: string; suite?: string; seq: number }> = [];
  const fsChanges: Array<{ path: string; status: string }> = [];
  const notes: Array<{ rule: string; detail?: string }> = [];
  let errorCount = 0;
  let shellFailures = 0;
  let turns = 0;
  let runEnded = false;
  let exitCode: number | undefined;
  for (const event of events) {
    const attrs = (event.attrs ?? {}) as Record<string, unknown>;
    if (event.turn + 1 > turns) turns = event.turn + 1;
    if (event.type === 'run.end') {
      runEnded = true;
      if (typeof attrs.exit_code === 'number' && Number.isSafeInteger(attrs.exit_code)) exitCode = attrs.exit_code;
      continue;
    }
    if (event.type === 'error') {
      errorCount += 1;
      const kind = boundedText(attrs.kind, 200) ?? 'unknown';
      if (errors.length < MAX_LISTED_ERRORS) {
        const suite = boundedText(attrs.suite, 200);
        errors.push(suite === undefined ? { kind, seq: event.seq } : { kind, suite, seq: event.seq });
      }
      continue;
    }
    if (event.type === 'tool.call') {
      const name = boundedText(attrs.name, 200);
      if (name !== undefined) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      continue;
    }
    if (event.type === 'fs.change') {
      const itemPath = boundedText(attrs.path, 512);
      const status = boundedText(attrs.status, 40);
      if (itemPath !== undefined && status !== undefined && fsChanges.length < MAX_LISTED_FS_CHANGES) {
        fsChanges.push({ path: itemPath, status });
      }
      continue;
    }
    if (event.type === 'note') {
      const rule = boundedText(attrs.rule, 120) ?? 'unspecified';
      if (notes.length < MAX_LISTED_NOTES) {
        const detail = boundedText(attrs.detail, 200);
        notes.push(detail === undefined ? { rule } : { rule, detail });
      }
      continue;
    }
    if (event.type === 'shell.result'
      && typeof attrs.exit_code === 'number'
      && Number.isSafeInteger(attrs.exit_code)
      && attrs.exit_code !== 0) {
      shellFailures += 1;
    }
  }
  return {
    events: events.length,
    turns,
    errorCount,
    shellFailures,
    runEnded,
    exitCode,
    toolCalls: [...toolCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_LISTED_TOOL_CALLS)
      .map(([name, count]) => ({ name, count })),
    errors,
    fsChanges,
    notes,
  };
}

function projectionQueries(projection: TraceProjection): string[] {
  const topics = new Set<string>();
  for (const tool of projection.toolCalls) topics.add(tool.name);
  for (const error of projection.errors) if (error.kind !== 'unknown') topics.add(error.kind);
  return [...topics]
    .map((topic) => topic.replace(/[^a-zA-Z0-9 ._-]/gu, '').trim())
    .filter((topic) => topic.length >= 2)
    .slice(0, ORCA_TRACE_MAX_SKILL_QUERIES);
}

async function searchSkillsForTrace(
  projection: TraceProjection,
  fetchImpl: typeof fetch | undefined,
): Promise<TraceSkillSearch | undefined> {
  if (!projection.runEnded) return undefined;
  const queries = projectionQueries(projection);
  const candidates: Array<{ skillId: string; name: string; source: string; officialStatus: string }> = [];
  const failures: Array<{ query: string; code: string }> = [];
  for (const query of queries) {
    try {
      const found = await findSkills(
        { query, officialOnly: true, limit: 10 },
        ...(fetchImpl === undefined ? [] : [{ fetchImpl }]),
      );
      for (const candidate of found.candidates) {
        if (candidates.some((existing) => existing.skillId === candidate.id)) continue;
        candidates.push({
          skillId: candidate.id,
          name: candidate.name,
          source: candidate.source,
          officialStatus: candidate.officialStatus,
        });
        if (candidates.length >= ORCA_TRACE_MAX_SKILL_CANDIDATES) break;
      }
    } catch (error) {
      failures.push({
        query,
        code: error instanceof KiokukoError ? error.code : 'SKILL_SEARCH_FAILED',
      });
    }
    if (candidates.length >= ORCA_TRACE_MAX_SKILL_CANDIDATES) break;
  }
  return { queries, candidates, failures };
}

interface TraceMemoryCandidateSet {
  readonly candidates: ReadonlyArray<{ readonly kind: string; readonly summary: string }>;
  readonly suppressed: number;
}

function buildTraceMemoryCandidates(projection: TraceProjection): TraceMemoryCandidateSet {
  const candidates: Array<{ kind: string; summary: string }> = [];
  let suppressed = 0;
  const consider = (kind: 'error' | 'shell_failure' | 'note', summary: string): void => {
    if (candidates.length >= ORCA_TRACE_MAX_MEMORY_CANDIDATES) return;
    if (findSecretInValue({ kind, summary }) !== undefined) {
      suppressed += 1;
      return;
    }
    candidates.push({ kind, summary });
  };
  for (const error of projection.errors) {
    consider('error', `Trace error kind ${error.kind}${error.suite === undefined ? '' : ` in ${error.suite}`}`);
  }
  if (projection.shellFailures > 0) {
    consider('shell_failure', `${projection.shellFailures} shell command(s) exited nonzero during the recorded run`);
  }
  for (const note of projection.notes) {
    consider('note', `Analyzer note rule ${note.rule}${note.detail === undefined ? '' : `: ${note.detail}`}`);
  }
  return { candidates, suppressed };
}

interface TraceContextBuild {
  readonly context: JsonObject;
  readonly bounded: boolean;
}

function buildTraceContext(
  traceRunId: string,
  schemaVersion: string,
  throughSeq: number,
  integrity: OrcaTraceIntegrity,
  projection: TraceProjection,
  skills: TraceSkillSearch | undefined,
): TraceContextBuild {
  let toolCalls = projection.toolCalls;
  let errors = projection.errors;
  let fsChanges = projection.fsChanges;
  let notes = projection.notes;
  let skillsValue = skills;
  const build = (): JsonObject => ({
    source: 'orcareplay',
    traceRunId,
    schemaVersion,
    throughSeq,
    integrity,
    summary: {
      events: projection.events,
      turns: projection.turns,
      errorCount: projection.errorCount,
      shellFailures: projection.shellFailures,
      runEnded: projection.runEnded,
      ...(projection.exitCode === undefined ? {} : { exitCode: projection.exitCode }),
      toolCalls: [...toolCalls],
      errors: [...errors],
      fsChanges: [...fsChanges],
      notes: [...notes],
    },
    ...(skillsValue === undefined ? {} : {
      skills: {
        mode: 'official',
        referenceOnly: true,
        autoInstall: false,
        autoExecute: false,
        queries: [...skillsValue.queries],
        candidates: [...skillsValue.candidates],
        failures: [...skillsValue.failures],
      },
    }),
  });
  const byteLength = (value: JsonObject): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
  let candidate = build();
  while (byteLength(candidate) > ORCA_TRACE_CONTEXT_MAX_BYTES) {
    const halve = <T>(value: readonly T[]): readonly T[] => value.slice(0, Math.max(1, Math.floor(value.length / 2)));
    if (fsChanges.length > 1) fsChanges = fsChanges.slice(0, Math.max(1, Math.floor(fsChanges.length / 2)));
    else if (toolCalls.length > 1) toolCalls = toolCalls.slice(0, Math.max(1, Math.floor(toolCalls.length / 2)));
    else if (errors.length > 1) errors = errors.slice(0, Math.max(1, Math.floor(errors.length / 2)));
    else if (notes.length > 1) notes = notes.slice(0, Math.max(1, Math.floor(notes.length / 2)));
    else if (skillsValue !== undefined) skillsValue = undefined;
    else {
      fsChanges = [];
      toolCalls = [];
      errors = [];
      notes = [];
    }
    candidate = build();
    if (fsChanges.length === 0 && toolCalls.length === 0 && errors.length === 0 && notes.length === 0
      && skillsValue === undefined
      && byteLength(candidate) <= ORCA_TRACE_CONTEXT_MAX_BYTES) break;
    if (fsChanges.length === 0 && toolCalls.length === 0 && errors.length === 0 && notes.length === 0
      && skillsValue === undefined
      && byteLength(candidate) > ORCA_TRACE_CONTEXT_MAX_BYTES) {
      return { context: candidate, bounded: false };
    }
  }
  return { context: candidate, bounded: true };
}

export function readStoredTraceContext(
  database: SqliteDatabase,
  runsDirectory: string,
  traceRunId: string,
): { digest: string; context: JsonObject } | undefined {
  const row = database.prepare(`
    SELECT digest AS digest, context_json AS contextJson
    FROM orcareplay_trace_context
    WHERE directory = ? AND trace_run_id = ?
  `).get<{ digest: unknown; contextJson: unknown }>(runsDirectory, traceRunId);
  if (row === undefined) return undefined;
  if (typeof row.digest !== 'string' || typeof row.contextJson !== 'string') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored OrcaReplay trace context is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.contextJson);
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored OrcaReplay trace context is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored OrcaReplay trace context is invalid');
  }
  return { digest: row.digest, context: parsed as JsonObject };
}

function writeTraceContext(
  database: SqliteDatabase,
  input: {
    readonly runsDirectory: string;
    readonly traceRunId: string;
    readonly digest: string;
    readonly contextJson: string;
    readonly now: string;
  },
): 'inserted' | 'unchanged' | 'updated' {
  const existing = readStoredTraceContext(database, input.runsDirectory, input.traceRunId);
  if (existing !== undefined && existing.digest === input.digest) return 'unchanged';
  database.prepare(`
    INSERT INTO orcareplay_trace_context (directory, trace_run_id, digest, context_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'orcareplay', ?, ?)
    ON CONFLICT(directory, trace_run_id) DO UPDATE SET
      digest = excluded.digest,
      context_json = excluded.context_json,
      source = excluded.source,
      updated_at = excluded.updated_at
    WHERE orcareplay_trace_context.digest <> excluded.digest
  `).run(input.runsDirectory, input.traceRunId, input.digest, input.contextJson, input.now, input.now);
  return existing === undefined ? 'inserted' : 'updated';
}

export async function ingestTraceRun(database: SqliteDatabase, input: TraceIngestInput): Promise<TraceIngestOutcome> {
  const runsDirectory = requireRunsDirectory(input.runsDirectory);
  const traceRunId = requireTraceRunId(input.traceRunId);
  const fromSeq = requireFromSeq(input.fromSeq);
  const now = input.now ?? new Date().toISOString();
  const read = await readOrcaTraceRun(runsDirectory, traceRunId);
  if (read.status === 'unsupported_schema') {
    return withImmediateTransaction(database, () => {
      upsertTraceCursor(database, { runsDirectory, traceRunId, lastSeq: 0, state: 'unsupported', now });
      return {
        ingested: false,
        reason: 'unsupported_schema' as const,
        traceRunId,
        throughSeq: read.maxSeq,
        cursorSeq: 0,
        integrity: read.integrity,
        contextDigest: undefined,
        memoryCandidates: 0,
        suppressedMemoryCandidates: 0,
        skillCandidates: 0,
      };
    });
  }
  if (read.status !== 'ready') {
    throw new KiokukoError('INTEGRITY_ERROR', `OrcaReplay trace run is not ingestable (${read.status})`);
  }
  const manifest = read.manifest;
  if (manifest === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'OrcaReplay trace manifest is missing for a ready run');
  }
  if (read.maxSeq < fromSeq) {
    return withImmediateTransaction(database, () => ({
      ingested: false,
      reason: 'already_ingested' as const,
      traceRunId,
      throughSeq: read.maxSeq,
      cursorSeq: read.maxSeq,
      integrity: read.integrity,
      contextDigest: undefined,
      memoryCandidates: 0,
      suppressedMemoryCandidates: 0,
      skillCandidates: 0,
    }));
  }
  const relevantEvents = read.events.filter((event) => event.seq >= fromSeq);
  const projection = buildTraceProjection(relevantEvents.length > 0 ? relevantEvents : read.events);
  const skills = await searchSkillsForTrace(projection, input.fetchImpl);
  const memoryCandidateSet = buildTraceMemoryCandidates(projection);
  const built = buildTraceContext(
    traceRunId,
    manifest.schemaVersion,
    read.maxSeq,
    read.integrity,
    projection,
    skills,
  );
  if (!built.bounded) {
    throw new KiokukoError('INTEGRITY_ERROR', 'OrcaReplay trace context projection exceeds its bound');
  }
  if (findSecretInValue(built.context) !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'OrcaReplay trace context contains secret-shaped material and was rejected');
  }
  const contextDigest = canonicalContentHash(built.context);
  const contextJson = JSON.stringify(built.context);
  if (Buffer.byteLength(contextJson, 'utf8') > ORCA_TRACE_CONTEXT_MAX_BYTES) {
    throw new KiokukoError('INTEGRITY_ERROR', 'OrcaReplay trace context exceeds the bounded size');
  }
  return withImmediateTransaction(database, () => {
    const cursor = readTraceCursor(database, runsDirectory, traceRunId);
    if (cursor !== undefined && cursor.state === 'active' && cursor.lastSeq >= read.maxSeq) {
      return {
        ingested: false,
        reason: 'already_ingested' as const,
        traceRunId,
        throughSeq: read.maxSeq,
        cursorSeq: cursor.lastSeq,
        integrity: read.integrity,
        contextDigest: undefined,
        memoryCandidates: 0,
        suppressedMemoryCandidates: 0,
        skillCandidates: 0,
      };
    }
    const contextState = writeTraceContext(database, {
      runsDirectory,
      traceRunId,
      digest: contextDigest,
      contextJson,
      now,
    });
    let promotedCandidates = 0;
    if (projection.runEnded && memoryCandidateSet.candidates.length > 0) {
      enqueueOrchestrationJob(database, {
        kind: 'memory_promotion',
        runId: null,
        payload: {
          source: 'orcareplay',
          runsDirectory,
          traceRunId,
          candidates: [...memoryCandidateSet.candidates],
          digest: contextDigest,
        },
        now,
      });
      promotedCandidates = memoryCandidateSet.candidates.length;
    }
    upsertTraceCursor(database, { runsDirectory, traceRunId, lastSeq: read.maxSeq, state: 'active', now });
    return {
      ingested: true,
      reason: undefined,
      traceRunId,
      throughSeq: read.maxSeq,
      cursorSeq: read.maxSeq,
      integrity: read.integrity,
      contextDigest,
      memoryCandidates: promotedCandidates,
      suppressedMemoryCandidates: memoryCandidateSet.suppressed,
      skillCandidates: skills?.candidates.length ?? 0,
    };
  });
}
