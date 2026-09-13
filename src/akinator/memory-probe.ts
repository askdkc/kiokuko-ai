import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { SqliteDatabase } from '../db/adapter.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { KiokukoError } from '../errors.js';
import type { TaskProfile } from './types.js';
import { buildProfileHints, resolveProfileTarget } from './profile-memory-resolver.js';
import { currentProfileEvidence, profileCoverage, readMemoryResolution, readProfileDocument, type ProfileDocument } from './profile-memory-store.js';
import { PROFILE_CANDIDATE_LIMIT, PROFILE_MEMORY_POLICY, runtimeProbeConfig, type MemoryResolution, type ProbeMode, type ProfileMemoryHints } from './memory-probe-types.js';

export interface ProfileProbeContext {
  mode: ProbeMode;
  workspace: string;
  repositoryId: string;
  repositoryRoot: string;
  verifiedTargets: ReadonlySet<string>;
  unavailableReason?: 'path_permission_denied' | 'path_resources_exhausted';
}

function queryTokens(task: string): string[] {
  return [...new Set(task.match(/[\p{L}\p{N}_./-]+/gu) ?? [])];
}

/** A mention is not a target: accept only an unambiguous, single-path directive. */
function explicitDirectiveTarget(task: string): string | undefined {
  const value = task.trim();
  const english = /^(?:implement|fix|update|refactor|review|test|build)\s+(.+)$/iu.exec(value);
  const japanese = /^(.+?)\s*を\s*(?:修正|更新|実装|確認|テスト|リファクタリング)(?:する|して|してください)?$/u.exec(value);
  let target = (english ?? japanese)?.[1]?.trim();
  if (target?.startsWith('`') && target.endsWith('`')) target = target.slice(1, -1);
  if (!target || /[\s`]/u.test(target) || queryTokens(target)[0] !== target) return undefined;
  return target;
}

/** Only inspect paths explicitly present in this request, within the canonical repository. */
export function captureProfileProbeContext(project: { workspace: string; repositoryId: string; repositoryRoot: string }, task: string, mode = runtimeProbeConfig().mode): ProfileProbeContext {
  const verifiedTargets = new Set<string>();
  let unavailableReason: ProfileProbeContext['unavailableReason'];
  if (mode === 'resolve' || mode === 'shadow') {
    const explicit = task.length <= 4096 ? explicitDirectiveTarget(task) : undefined;
    for (const token of explicit ? [explicit] : []) {
      if (token.length > 512 || (!token.includes('/') && !token.includes('.')) || path.isAbsolute(token)
        || token.split('/').some(part => !part || part === '..' || part === '.') || path.posix.normalize(token) !== token) continue;
      try {
        const target = realpathSync(path.join(project.repositoryRoot, token));
        const relative = path.relative(project.repositoryRoot, target);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) continue;
        const status = statSync(target);
        if (status.isFile() || status.isDirectory()) verifiedTargets.add(token);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
          && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) continue;
        if (error && typeof error === 'object' && 'code' in error
          && ['EACCES', 'EPERM', 'EMFILE', 'ENFILE'].includes(String(error.code))) {
          unavailableReason = ['EACCES', 'EPERM'].includes(String(error.code)) ? 'path_permission_denied' : 'path_resources_exhausted';
          break;
        }
        throw error;
      }
    }
  }
  return { ...project, mode, verifiedTargets, ...(unavailableReason ? { unavailableReason } : {}) };
}

/** Bounded synchronous SQL, called only on the fresh side of request idempotency. */
export function probeProfileMemory(database: SqliteDatabase, context: ProfileProbeContext, task: string, profile: TaskProfile): { profile: TaskProfile; resolution: MemoryResolution } {
  const baseHash = canonicalContentHash(profile);
  const resolution: MemoryResolution = {
    policyVersion: PROFILE_MEMORY_POLICY, mode: context.mode, status: 'skipped', coverage: 'complete',
    baseProfileHash: baseHash, resultProfileHash: baseHash, candidates: [], adopted: null,
    scannedCandidates: 0, queryCount: 0, truncated: false,
  };
  if (context.mode === 'off' || (profile.taskType !== null && profile.target !== null && profile.expected !== null)) return { profile, resolution };
  const binding = database.prepare(`SELECT 1 AS valid FROM repositories AS r JOIN repository_locations AS l ON l.repository_id = r.repository_id
    WHERE r.repository_id = ? AND r.workspace = ? AND l.canonical_root = ?`).get(context.repositoryId, context.workspace, context.repositoryRoot);
  if (!binding) throw new KiokukoError('CONFLICT', 'Profile memory repository binding changed');
  if (context.unavailableReason) {
    resolution.status = 'unavailable';
    resolution.warning = context.unavailableReason;
    return { profile, resolution };
  }
  const allTokens = queryTokens(task.slice(0, 4096));
  const terms = allTokens.filter(value => value.length <= 512).slice(0, 12);
  resolution.coverage = profileCoverage(database, context.workspace, context.repositoryId);
  resolution.truncated = task.length > 4096 || allTokens.length > 12;
  const ids = new Map<string, number>();
  const add = (rows: Array<{ run_id: string }>, score: number) => {
    for (const row of rows) {
      if (!ids.has(row.run_id) && ids.size < PROFILE_CANDIDATE_LIMIT) ids.set(row.run_id, score);
    }
    if (rows.length >= PROFILE_CANDIDATE_LIMIT || ids.size >= PROFILE_CANDIDATE_LIMIT) resolution.truncated = true;
  };
  if (terms.length) {
    resolution.queryCount++;
    add(database.prepare(`SELECT DISTINCT d.run_id FROM akinator_profile_signals AS s
      JOIN akinator_profile_documents AS d ON d.id = s.document_id
      WHERE s.workspace = ? AND s.repository_id = ? AND s.value IN (${terms.map(() => '?').join(',')})
      ORDER BY d.run_id LIMIT ?`).all<{ run_id: string }>(context.workspace, context.repositoryId, ...terms, PROFILE_CANDIDATE_LIMIT), 100);
    for (const table of ['akinator_profile_fts', 'akinator_profile_trigram'] as const) {
      if (ids.size >= PROFILE_CANDIDATE_LIMIT) break;
      const laneTerms = table === 'akinator_profile_trigram' ? terms.filter(term => [...term].length >= 3) : terms;
      if (!laneTerms.length) continue;
      const query = laneTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      resolution.queryCount++;
      add(database.prepare(`SELECT d.run_id FROM ${table} AS f
        JOIN akinator_profile_documents AS d ON d.id = f.rowid
        WHERE ${table} MATCH ? AND d.workspace = ? AND d.repository_id = ?
        ORDER BY bm25(${table}), d.run_id LIMIT ?`)
        .all<{ run_id: string }>(query, context.workspace, context.repositoryId, PROFILE_CANDIDATE_LIMIT), table === 'akinator_profile_fts' ? 50 : 25);
    }
  }
  const documents: ProfileDocument[] = [];
  let stale = false;
  for (const [runId, score] of ids) {
    const document = readProfileDocument(database, context.workspace, context.repositoryId, runId);
    const indexed = database.prepare('SELECT profile_hash, sources_hash FROM akinator_profile_documents WHERE run_id = ?')
      .get<{ profile_hash: string; sources_hash: string }>(runId);
    if (!document || indexed?.profile_hash !== document.evidence.profileHash || indexed.sources_hash !== document.evidence.sourcesHash) {
      stale = true;
      continue;
    }
    document.evidence.score = score;
    documents.push(document);
  }
  resolution.scannedCandidates = ids.size;
  resolution.candidates = documents.map(document => document.evidence);
  resolution.status = stale || resolution.truncated || resolution.coverage === 'partial' ? 'incomplete' : 'complete';
  const adopted = (context.mode === 'resolve' || context.mode === 'shadow') ? resolveProfileTarget({ profile, candidates: documents,
    verifiedTargets: context.verifiedTargets, complete: resolution.status === 'complete' }) : undefined;
  if (context.mode === 'shadow') {
    resolution.shadowAdoption = adopted?.evidence ?? null;
    return { profile, resolution };
  }
  if (!adopted) return { profile, resolution };
  // Paths were checked before the write transaction. The binding and canonical
  // source hashes above are revalidated under the transaction; no filesystem I/O here.
  const enriched = { ...profile, target: adopted.session.profile.target };
  resolution.adopted = adopted.evidence;
  resolution.resultProfileHash = canonicalContentHash(enriched);
  return { profile: enriched, resolution };
}

export function profileHintsForRun(database: SqliteDatabase, runId: string, profile: TaskProfile, mode = runtimeProbeConfig().mode): ProfileMemoryHints | undefined {
  if (mode === 'off' || mode === 'shadow') return undefined;
  const resolution = readMemoryResolution(database, runId);
  if (!resolution || resolution.mode === 'off' || resolution.mode === 'shadow' || resolution.status === 'skipped') return undefined;
  const run = database.prepare('SELECT workspace FROM ledger_runs WHERE run_id = ?').get<{ workspace: string }>(runId);
  const documents: ProfileDocument[] = [];
  for (const ref of resolution.candidates) {
    if (ref.workspace !== run?.workspace) throw new KiokukoError('INTEGRITY_ERROR', 'Profile hint crosses the run workspace');
    const document = currentProfileEvidence(database, ref);
    if (document) { document.evidence.score = ref.score; documents.push(document); }
  }
  const currentResolution = documents.length === resolution.candidates.length ? resolution : { ...resolution, status: 'incomplete' as const };
  return buildProfileHints(profile, currentResolution, documents);
}
