import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalJson, canonicalTagOrder, compareCanonicalStrings, requireWorkspace, type EntryKind, type JsonObject } from '../serialization/validate.js';
import { recordEntryInTransaction, readEntry, type EntryRecord } from './entries.js';
import {
  buildStructuredScope,
  MEMORY_CLASSES,
  validateApplicability,
  validateSignals,
  type Applicability,
  type MemoryClass,
  type MemorySignals,
} from './structured-memory.js';
import { ensureGlobalWorkspace, GLOBAL_WORKSPACE, resolveProjectWorkspace } from './workspaces.js';
import { readKnowledgeEvidence, type KnowledgeEvidence, type KnowledgeEvidenceTier } from '../akinator/knowledge-path.js';
import { analyzePortability, containsProjectSpecificData as containsPortableProjectSpecificData } from './portability.js';
import { isExternalSkillReference } from '../skills/store.js';
import { normalizeSearchSignal } from './retrieval-query.js';
import { recordAuditEvent } from './audit.js';
import {
  CURATOR_DRAFT_VERSION,
  CURATOR_MEMORY_ACTOR,
  isTrustedCuratorGlobalMemory,
} from './curator-trust.js';

export { CURATOR_DRAFT_VERSION } from './curator-trust.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_CURATOR_SCORE = 4;
const GENERIC_LANGUAGE = /(?:汎用|一般化|再利用|共通|手順|パターン|ベストプラクティス|トラブルシューティング|workflow|pattern|best practice|troubleshoot|how[- ]to|reusable|portable|avoid|when to)/iu;
const PROCEDURAL_LANGUAGE = /(?:する|して|確認|切り分け|手順|場合|必要|use|run|check|verify|configure|prefer|avoid|when|if|then|should)/iu;
const LOCAL_LANGUAGE = /(?:この(?:リポジトリ|プロジェクト)|this (?:repository|project)|project-specific|project:|repo_[a-z0-9_]+)/iu;
const ABSOLUTE_PATH = /(?:\/(?:Users|home|private)\/|[A-Za-z]:[\\/])/u;
const ABSOLUTE_PATH_GLOBAL = /(?:\/(?:Users|home|private)\/[^\s`"'<>()[\]{},;!?。！？、]+|[A-Za-z]:[\\/][^\s`"'<>()[\]{},;!?。！？、]+)/gu;
const PROJECT_RELATIVE_PATH = /\b(?:src|tests?|app|lib|packages?|config|resources|migrations)[\\/][A-Za-z0-9_.@/\\-]+\b/gu;
const PROJECT_RELATIVE_PATH_PRESENT = /\b(?:src|tests?|app|lib|packages?|config|resources|migrations)[\\/][A-Za-z0-9_.@/\\-]+\b/u;
const PROJECT_IDENTIFIER = /\b(?:project:[A-Za-z0-9._:-]+|repo_[A-Za-z0-9_-]+)\b/gu;
const PROJECT_PHRASE = /(?:この(?:リポジトリ|プロジェクト)|当(?:リポジトリ|プロジェクト)|本プロジェクト|this (?:repository|project)|the current repository|the current project|project-specific)/giu;
const JAPANESE_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export type CuratorDraftChange =
  | 'portable-sections-generated'
  | 'project-references-normalized'
  | 'paths-generalized'
  | 'applicability-retained';

export interface CuratorDraft {
  version: typeof CURATOR_DRAFT_VERSION;
  title: string;
  summary: string;
  body: string;
  changes: CuratorDraftChange[];
}

export interface CuratorCandidate {
  entryId: string;
  workspace: string;
  revision: number;
  updatedAt: string;
  kind: EntryKind;
  tags: string[];
  memoryClass?: MemoryClass;
  applicability?: Applicability;
  skillName: string;
  overview: [string, string, string];
  draft: CuratorDraft;
  score: number;
  reasons: string[];
  warnings: string[];
  knowledge: KnowledgeEvidence & {
    skillReady: boolean;
    readinessReasons: string[];
  };
}

export interface CuratorCandidatesInput {
  workspace?: string;
  cwd?: string;
  workspaces?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  frameworks?: string[];
  languages?: string[];
  memoryClasses?: MemoryClass[];
  tiers?: KnowledgeEvidenceTier[];
  search?: string;
  limit?: number;
  cursor?: string;
  skillReadyOnly?: boolean;
  allWorkspaces?: boolean;
  includeGlobalized?: boolean;
}

export interface CuratorCandidatesResult {
  workspace: string | null;
  candidates: CuratorCandidate[];
  count: number;
  truncated: boolean;
  nextCursor: string | null;
  totalApproximate: number;
  securityNotice: string;
}

export interface CuratorFacetResult {
  projects: Array<{ workspace: string; name: string; count: number }>;
  tags: Array<{ value: string; count: number }>;
  frameworks: Array<{ value: string; count: number }>;
  languages: Array<{ value: string; count: number }>;
  memoryClasses: Array<{ value: MemoryClass; count: number }>;
}

export interface GlobalizeCuratorInput {
  workspace: string;
  entryId: string;
  expectedRevision: number;
  actor?: string;
  now?: string;
}

export interface GlobalizeCuratorResult {
  candidate: CuratorCandidate;
  global: EntryRecord;
  idempotent: boolean;
}

interface StructuredMetadata {
  memoryClass?: MemoryClass;
  applicability?: Applicability;
  signals?: MemorySignals;
}

interface CuratorScore {
  score: number;
  reasons: string[];
  warnings: string[];
  metadata: StructuredMetadata;
}

interface CuratorRow extends SqliteRow {
  workspace: string;
  id: string;
  updatedAt: string;
}

type StructuredMetadataField = 'applicability' | 'signals';

function hasValues(value: object | undefined): boolean {
  return value !== undefined && Object.values(value).some((item) => Array.isArray(item) && item.length > 0);
}

function storedMetadataIntegrityError(error: unknown, entry: EntryRecord, field: StructuredMetadataField): never {
  if (!(error instanceof KiokukoError) || (error.code !== 'VALIDATION_ERROR' && error.code !== 'SECURITY_REJECTION')) throw error;
  throw new KiokukoError('INTEGRITY_ERROR', `Stored scope.${field} metadata is invalid`, {
    workspace: entry.workspace,
    entryId: entry.id,
    revision: entry.revision,
    field,
  });
}

function readStructuredMetadata(entry: EntryRecord): StructuredMetadata {
  const raw = entry.scope as Record<string, unknown>;
  // Only the current structured scope contract contributes curator metadata.
  if (raw.schemaVersion !== 1) return {};
  const metadata: StructuredMetadata = {};
  if (typeof raw.memoryClass === 'string' && MEMORY_CLASSES.includes(raw.memoryClass as MemoryClass)) {
    metadata.memoryClass = raw.memoryClass as MemoryClass;
  }
  if (raw.applicability !== undefined) {
    try {
      metadata.applicability = validateApplicability(raw.applicability);
    } catch (error) {
      storedMetadataIntegrityError(error, entry, 'applicability');
    }
  }
  if (raw.signals !== undefined) {
    try {
      metadata.signals = validateSignals(raw.signals);
    } catch (error) {
      storedMetadataIntegrityError(error, entry, 'signals');
    }
  }
  return metadata;
}

function sourceText(entry: EntryRecord): string {
  return [entry.title, entry.summary ?? '', entry.body].join('\n').trim();
}

function compactLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function applicabilityLine(applicability: Applicability | undefined, japanese = true): string {
  if (applicability === undefined || !hasValues(applicability)) {
    return japanese ? '明示的な適用条件なし（Global化前に確認）' : 'No explicit applicability metadata; review before globalization.';
  }
  const values: string[] = [];
  if (applicability.languages?.length) values.push(`${japanese ? '言語' : 'Languages'}: ${applicability.languages.join(', ')}`);
  if (applicability.frameworks?.length) values.push(`Framework: ${applicability.frameworks.map((item) => item.version ? `${item.name} ${item.version}` : item.name).join(', ')}`);
  if (applicability.databases?.length) values.push(`DB: ${applicability.databases.join(', ')}`);
  if (applicability.runtimes?.length) values.push(`Runtime: ${applicability.runtimes.join(', ')}`);
  if (applicability.tools?.length) values.push(`Tool: ${applicability.tools.join(', ')}`);
  if (applicability.platforms?.length) values.push(`Platform: ${applicability.platforms.join(', ')}`);
  return values.join(' / ');
}

function knownProjectValues(entry: EntryRecord): string[] {
  const rawScope = entry.scope as Record<string, unknown>;
  const rawProvenance = entry.provenance as Record<string, unknown>;
  const values = [entry.workspace, rawScope.repositoryId, rawProvenance.sourceWorkspace, rawProvenance.sourceRepositoryId];
  const sourcePaths = rawProvenance.sourcePaths;
  if (Array.isArray(sourcePaths)) values.push(...sourcePaths);
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length >= 3))]
    .sort((left, right) => right.length - left.length);
}

function containsProjectSpecificData(value: string, entry: EntryRecord): boolean {
  return containsPortableProjectSpecificData(value, entry);
}

function portableText(value: string, entry: EntryRecord, title = false): string {
  const japanese = JAPANESE_TEXT.test(value);
  const projectReplacement = japanese ? '対象プロジェクト' : 'the target project';
  const pathReplacement = japanese ? '対象ファイル' : 'the relevant project file';
  let result = value.normalize('NFKC');
  for (const known of knownProjectValues(entry)) result = result.replaceAll(known.normalize('NFKC'), known.includes('/') || known.includes('\\') ? pathReplacement : projectReplacement);
  result = result
    .replace(PROJECT_PHRASE, projectReplacement)
    .replace(ABSOLUTE_PATH_GLOBAL, pathReplacement)
    .replace(PROJECT_RELATIVE_PATH, pathReplacement)
    .replace(PROJECT_IDENTIFIER, projectReplacement)
    .replace(/(?:the target project)(?:\s+the target project)+/giu, 'the target project')
    .replace(/(?:対象プロジェクト)(?:\s*対象プロジェクト)+/gu, '対象プロジェクト')
    .replace(/(?:the relevant project file)(?:\s+the relevant project file)+/giu, 'the relevant project file')
    .replace(/(?:対象ファイル)(?:\s*対象ファイル)+/gu, '対象ファイル');
  result = result.split(/\r?\n/u).map((line) => line.replace(/[\t ]+/gu, ' ').trim()).filter(Boolean).join('\n');
  if (title) {
    result = result
      .replace(/^(?:the target project|対象プロジェクト)\s*(?:only\s*)?[-:：]?\s*/iu, '')
      .replace(/^(?:only\s+)?(?:decision|knowledge)\s*[-:：]\s*/iu, '');
  }
  return result.trim();
}

function statements(value: string): string[] {
  return value
    .split(/\r?\n+/u)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/u))
    .map((line) => compactLine(line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '')))
    .filter(Boolean);
}

export function regenerateCuratorDraft(entry: EntryRecord, metadata = readStructuredMetadata(entry)): CuratorDraft {
  const source = sourceText(entry);
  const japanese = JAPANESE_TEXT.test(source);
  const portableTitle = portableText(entry.title, entry, true);
  const sourceSummary = entry.summary?.trim() || statements(entry.body)[0] || entry.title;
  const summary = compactLine(portableText(sourceSummary, entry)) || (japanese ? '再利用可能な知識' : 'Reusable knowledge');
  const procedure = [...new Set(statements(portableText(entry.body, entry)).filter((line) => line !== summary))].slice(0, 6);
  if (procedure.length === 0) procedure.push(summary);
  const applicability = applicabilityLine(metadata.applicability, japanese);
  const body = japanese
    ? [
        '目的', summary,
        '', '手順', ...procedure.map((line, index) => `${index + 1}. ${line}`),
        '', '適用条件', applicability,
        '', '検証', '対象プロジェクトの現在の状態で結果を確認してから、検証済みの知識として利用する。',
      ].join('\n')
    : [
        'Purpose', summary,
        '', 'Procedure', ...procedure.map((line, index) => `${index + 1}. ${line}`),
        '', 'Applicability', applicability,
        '', 'Verification', 'Confirm the result against the target project\'s current state before treating this knowledge as verified.',
      ].join('\n');
  const changes: CuratorDraftChange[] = ['portable-sections-generated'];
  const normalizedBody = portableText(entry.body, entry);
  if (portableTitle !== entry.title || normalizedBody !== entry.body.trim()) changes.push('project-references-normalized');
  const sourcePaths = (entry.provenance as Record<string, unknown>).sourcePaths;
  if (ABSOLUTE_PATH.test(source) || PROJECT_RELATIVE_PATH_PRESENT.test(source) || (Array.isArray(sourcePaths) && sourcePaths.length > 0)) changes.push('paths-generalized');
  if (hasValues(metadata.applicability)) changes.push('applicability-retained');
  return {
    version: CURATOR_DRAFT_VERSION,
    title: compactLine(portableTitle) || (japanese ? '再利用可能な知識' : 'Reusable knowledge'),
    summary,
    body,
    changes,
  };
}

function overviewLines(draft: CuratorDraft, metadata: StructuredMetadata): [string, string, string] {
  const procedure = draft.body.split(/\r?\n/u).map(compactLine).find((line) => /^1\.\s/u.test(line))?.replace(/^1\.\s*/u, '')
    ?? (JAPANESE_TEXT.test(draft.body) ? '再生成された本文を確認してください' : 'Review the regenerated body.');
  const japanese = JAPANESE_TEXT.test(draft.body);
  return [draft.summary, procedure, `${japanese ? '適用条件' : 'Applicability'}: ${applicabilityLine(metadata.applicability, japanese)}`];
}

function scoreEntry(entry: EntryRecord): CuratorScore {
  const metadata = readStructuredMetadata(entry);
  const text = sourceText(entry);
  let score = 0;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (entry.kind === 'lesson' || entry.kind === 'decision' || entry.kind === 'reference') {
    score += 2;
    reasons.push('再利用しやすい記憶タイプ');
  } else if (entry.kind === 'fact') {
    score += 1;
    reasons.push('事実として保存された候補');
  } else {
    score -= 1;
    warnings.push('preferenceはプロジェクト依存の可能性があります');
  }
  if (metadata.memoryClass !== undefined && metadata.memoryClass !== 'preference') {
    score += 2;
    reasons.push(`memoryClass=${metadata.memoryClass}`);
  }
  if (hasValues(metadata.applicability)) {
    score += 2;
    reasons.push('適用条件が構造化されています');
  }
  if (entry.tags.some((tag) => /^(?:skill:|bot:common$|workflow$|pattern$|reusable$|global$)/iu.test(tag))) {
    score += 2;
    reasons.push('汎用化を示すタグがあります');
  }
  if (GENERIC_LANGUAGE.test(text)) {
    score += 2;
    reasons.push('汎用的・再利用可能な表現があります');
  }
  if (PROCEDURAL_LANGUAGE.test(text)) {
    score += 1;
    reasons.push('手順・判断基準として読めます');
  }
  if (text.length >= 80) {
    score += 1;
    reasons.push('説明が十分な長さです');
  }
  if (LOCAL_LANGUAGE.test(text)) {
    score -= 3;
    warnings.push('プロジェクト固有の表現があります');
  }
  if (ABSOLUTE_PATH.test(text)) {
    score -= 3;
    warnings.push('絶対パスが含まれています');
  }
  const sourcePaths = (entry.provenance.sourcePaths as unknown);
  if (Array.isArray(sourcePaths) && sourcePaths.length > 0) {
    score -= 1;
    warnings.push('元プロジェクトのパス由来です');
  }
  const portability = analyzePortability(entry);
  if (portability.projectSpecific && !warnings.some((warning) => warning.includes('プロジェクト固有'))) {
    warnings.push('プロジェクト固有情報が含まれています');
  }
  return { score, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)], metadata };
}

function candidateFromEntry(database: SqliteDatabase, entry: EntryRecord): CuratorCandidate | null {
  if (entry.workspace === GLOBAL_WORKSPACE || entry.status !== 'candidate') return null;
  if (isExternalSkillReference(entry)) return null;
  const scored = scoreEntry(entry);
  const evidence = readKnowledgeEvidence(database, entry);
  const portableEvidence = evidence.independentWorkspaces >= 2 || hasValues(scored.metadata.applicability);
  const readinessReasons = [
    ...(evidence.independentRuns >= 2 ? ['独立したrunで2回以上成功'] : ['独立した成功runが2回未満']),
    ...(evidence.averageCompleteness >= 0.9 ? ['抽象→具体サイロが十分に充足'] : ['抽象→具体サイロの充足証拠が不足']),
    ...(portableEvidence ? ['複数workspaceまたは明示的な適用条件あり'] : ['プロジェクト外への適用根拠が不足']),
  ];
  const skillReady = evidence.qualifiedHits >= 2
    && evidence.independentRuns >= 2
    && evidence.averageCompleteness >= 0.9
    && portableEvidence;
  if (evidence.qualifiedHits > 0) {
    scored.score += Math.min(4, evidence.qualifiedHits * 2);
    scored.reasons.push(`検証済み推論経路 ${evidence.qualifiedHits}件`);
  } else {
    scored.warnings.push('検証済みのAkinator推論経路はまだありません');
  }
  if (scored.score < MIN_CURATOR_SCORE) return null;
  const draft = regenerateCuratorDraft(entry, scored.metadata);
  return {
    entryId: entry.id,
    workspace: entry.workspace,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    kind: entry.kind,
    tags: [...entry.tags],
    ...(scored.metadata.memoryClass === undefined ? {} : { memoryClass: scored.metadata.memoryClass }),
    ...(scored.metadata.applicability === undefined ? {} : { applicability: scored.metadata.applicability }),
    skillName: draft.title,
    overview: overviewLines(draft, scored.metadata),
    draft,
    score: scored.score,
    reasons: scored.reasons,
    warnings: scored.warnings,
    knowledge: { ...evidence, skillReady, readinessReasons },
  };
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new KiokukoError('VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  return limit;
}

function encodeCuratorCursor(candidate: CuratorCandidate): string {
  return Buffer.from(JSON.stringify({
    ready: candidate.knowledge.skillReady ? 1 : 0,
    score: candidate.score,
    updatedAt: candidate.updatedAt,
    workspace: candidate.workspace,
    entryId: candidate.entryId,
  }), 'utf8').toString('base64url');
}

function decodeCuratorCursor(value: string | undefined): { ready: number; score: number; updatedAt: string; workspace: string; entryId: string } | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('cursor');
    const cursor = parsed as Record<string, unknown>;
    if ((cursor.ready !== 0 && cursor.ready !== 1) || typeof cursor.score !== 'number' || !Number.isFinite(cursor.score)
      || typeof cursor.updatedAt !== 'string' || typeof cursor.workspace !== 'string' || typeof cursor.entryId !== 'string') throw new Error('cursor');
    return { ready: cursor.ready, score: cursor.score, updatedAt: cursor.updatedAt, workspace: cursor.workspace, entryId: cursor.entryId };
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'Curator cursor is invalid');
  }
}

function compareCuratorCandidates(left: CuratorCandidate, right: CuratorCandidate): number {
  return Number(right.knowledge.skillReady) - Number(left.knowledge.skillReady)
    || right.score - left.score
    || compareCanonicalStrings(right.updatedAt, left.updatedAt)
    || compareCanonicalStrings(left.workspace, right.workspace)
    || compareCanonicalStrings(left.entryId, right.entryId);
}

function candidateAfterCursor(candidate: CuratorCandidate, cursor: ReturnType<typeof decodeCuratorCursor>): boolean {
  if (cursor === undefined) return true;
  return Number(candidate.knowledge.skillReady) < cursor.ready
    || (Number(candidate.knowledge.skillReady) === cursor.ready && (candidate.score < cursor.score
      || (candidate.score === cursor.score && (candidate.updatedAt < cursor.updatedAt
        || (candidate.updatedAt === cursor.updatedAt && (candidate.workspace > cursor.workspace
          || (candidate.workspace === cursor.workspace && candidate.entryId > cursor.entryId)))))));
}

function scanCuratorRows(
  database: SqliteDatabase,
  clauses: string[],
  parameters: Array<string | number>,
): CuratorRow[] {
  const maximumRows = 5_000;
  const rows: CuratorRow[] = [];
  let cursor: CuratorRow | undefined;
  const batchSize = 500;
  while (true) {
    const cursorClause = cursor === undefined
      ? ''
      : `AND (
          e.updated_at < ?
          OR (e.updated_at = ? AND e.workspace > ?)
          OR (e.updated_at = ? AND e.workspace = ? AND e.id > ?)
        )`;
    const cursorParameters = cursor === undefined
      ? []
      : [cursor.updatedAt, cursor.updatedAt, cursor.workspace, cursor.updatedAt, cursor.workspace, cursor.id];
    const remaining = maximumRows - rows.length;
    const batch = database.prepare(`
      SELECT e.workspace, e.id, e.updated_at AS updatedAt
        FROM entries AS e
       WHERE ${clauses.join(' AND ')}
         ${cursorClause}
       ORDER BY e.updated_at DESC, e.workspace ASC, e.id ASC
       LIMIT ?
    `).all<CuratorRow>(...parameters, ...cursorParameters, Math.min(batchSize, remaining + 1));
    if (batch.length > remaining) {
      throw new KiokukoError('VALIDATION_ERROR', 'Curator scan exceeds the bounded candidate limit; narrow the filters');
    }
    rows.push(...batch);
    if (batch.length < batchSize) break;
    cursor = batch.at(-1);
  }
  return rows;
}

function listCuratorCandidates(
  database: SqliteDatabase,
  workspace: string | null,
  input: CuratorCandidatesInput,
  limit: number,
): { candidates: CuratorCandidate[]; truncated: boolean; nextCursor: string | null; totalApproximate: number } {
  if (workspace === GLOBAL_WORKSPACE) return { candidates: [], truncated: false, nextCursor: null, totalApproximate: 0 };
  const workspaces = input.workspaces?.length ? [...new Set(input.workspaces)] : workspace === null ? undefined : [workspace];
  const parameters: Array<string | number> = [GLOBAL_WORKSPACE];
  const clauses = ['e.workspace <> ?', "e.status = 'candidate'"];
  if (workspaces !== undefined) {
    clauses.push(`e.workspace IN (${workspaces.map(() => '?').join(', ')})`);
    parameters.push(...workspaces);
  }
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  const rows = scanCuratorRows(database, clauses, parameters);
  const globalEntries = input.includeGlobalized === true ? [] : entriesInWorkspace(database, GLOBAL_WORKSPACE);
  const search = input.search?.trim().normalize('NFKC').toLowerCase();
  const frameworks = (input.frameworks ?? []).map(normalizeSearchSignal);
  const languages = (input.languages ?? []).map(normalizeSearchSignal);
  const candidates = rows
    .map((row) => {
      const entry = readEntry(database, { workspace: row.workspace, entryId: row.id });
      const metadata = readStructuredMetadata(entry);
      if (entry.status !== 'candidate' || isExternalSkillReference(entry)) return null;
      if (search !== undefined && search.length > 0 && ![
        entry.title, entry.summary ?? '', entry.body, ...entry.tags,
      ].some((value) => value.normalize('NFKC').toLowerCase().includes(search))) return null;
      if (tags.length > 0) {
        const matched = tags.map((tag) => entry.tags.includes(tag));
        if (input.tagMode === 'all' ? matched.some((value) => !value) : matched.every((value) => !value)) return null;
      }
      if (frameworks.length > 0 && !(metadata.applicability?.frameworks ?? []).some((item) => frameworks.includes(normalizeSearchSignal(item.name)))) return null;
      if (languages.length > 0 && !(metadata.applicability?.languages ?? []).some((language) => languages.includes(normalizeSearchSignal(language)))) return null;
      if (input.memoryClasses?.length && (metadata.memoryClass === undefined || !input.memoryClasses.includes(metadata.memoryClass))) return null;
      const candidate = candidateFromEntry(database, entry);
      if (candidate !== null && globalEntries.some((global) => globalizesSource(global, entry))) return null;
      return candidate;
    })
    .filter((candidate): candidate is CuratorCandidate => candidate !== null)
    .filter((candidate) => !input.skillReadyOnly || candidate.knowledge.skillReady)
    .filter((candidate) => input.tiers === undefined || input.tiers.includes(candidate.knowledge.tier))
    .sort(compareCuratorCandidates);
  const concepts = new Set<string>();
  const deduplicated = candidates.filter((candidate) => {
    if (concepts.has(candidate.knowledge.conceptKey)) return false;
    concepts.add(candidate.knowledge.conceptKey);
    return true;
  });
  const cursor = decodeCuratorCursor(input.cursor);
  const visible = deduplicated.filter((candidate) => candidateAfterCursor(candidate, cursor));
  const page = visible.slice(0, limit);
  return {
    candidates: page,
    truncated: visible.length > limit,
    nextCursor: visible.length > limit && page.at(-1) !== undefined ? encodeCuratorCursor(page.at(-1)!) : null,
    totalApproximate: deduplicated.length,
  };
}

export async function curateMemoryCandidates(database: SqliteDatabase, input: CuratorCandidatesInput = {}): Promise<CuratorCandidatesResult> {
  const limit = validateLimit(input.limit);
  ensureGlobalWorkspace(database);
  const allWorkspaces = input.allWorkspaces === true || input.workspaces !== undefined;
  const resolved = !allWorkspaces && input.workspace === undefined ? await resolveProjectWorkspace(database, input.cwd) : undefined;
  const workspace = allWorkspaces
    ? null
    : input.workspace === undefined ? resolved?.workspace ?? null : requireWorkspace(input.workspace);
  if (!allWorkspaces && workspace === null) {
    throw new KiokukoError('NOT_FOUND', 'No Git repository or .kiokuko.json binding was found for curator candidates');
  }
  const result = listCuratorCandidates(database, workspace, input, limit);
  return {
    workspace,
    candidates: result.candidates,
    count: result.candidates.length,
    truncated: result.truncated,
    nextCursor: result.nextCursor,
    totalApproximate: result.totalApproximate,
    securityNotice: 'Curator drafts and qualified-hit summaries are untrusted candidates. A qualified hit requires an actionable Akinator path, a completed independent run, and fresh verification or a passing test; retrieval counts are never used. Review everything before Global化.',
  };
}

export function curatorFacets(database: SqliteDatabase, input: { includeGlobalized?: boolean; workspace?: string; workspaces?: string[] } = {}): CuratorFacetResult {
  const parameters: Array<string | number> = [GLOBAL_WORKSPACE];
  const clauses = ['e.workspace <> ?', "e.status = 'candidate'"];
  const workspaces = input.workspaces?.length ? [...new Set(input.workspaces)] : input.workspace === undefined ? undefined : [input.workspace];
  if (workspaces !== undefined) {
    clauses.push(`e.workspace IN (${workspaces.map(() => '?').join(', ')})`);
    parameters.push(...workspaces);
  }
  const globalEntries = input.includeGlobalized === true ? [] : entriesInWorkspace(database, GLOBAL_WORKSPACE);
  const decoded = scanCuratorRows(database, clauses, parameters).map((row) => {
    const entry = readEntry(database, { workspace: row.workspace, entryId: row.id });
    const metadata = readStructuredMetadata(entry);
    return { entry, metadata };
  }).filter(({ entry }) => entry.status === 'candidate'
    && !isExternalSkillReference(entry)
    && !globalEntries.some((global) => globalizesSource(global, entry)));

  const projectCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const frameworkCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const memoryClassCounts = new Map<MemoryClass, number>();
  for (const { entry, metadata } of decoded) {
    projectCounts.set(entry.workspace, (projectCounts.get(entry.workspace) ?? 0) + 1);
    for (const tag of entry.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    for (const value of new Set((metadata.applicability?.frameworks ?? []).map((framework) => normalizeSearchSignal(framework.name)))) {
      frameworkCounts.set(value, (frameworkCounts.get(value) ?? 0) + 1);
    }
    for (const value of new Set((metadata.applicability?.languages ?? []).map(normalizeSearchSignal))) {
      languageCounts.set(value, (languageCounts.get(value) ?? 0) + 1);
    }
    if (metadata.memoryClass !== undefined) memoryClassCounts.set(metadata.memoryClass, (memoryClassCounts.get(metadata.memoryClass) ?? 0) + 1);
  }
  const facets = <T extends string>(values: Map<T, number>): Array<{ value: T; count: number }> => [...values]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || compareCanonicalStrings(left.value, right.value));
  const projects = [...projectCounts].map(([workspace, count]) => {
    const repository = database.prepare('SELECT display_name FROM repositories WHERE workspace = ?').get<{ display_name: string }>(workspace);
    return { workspace, name: repository?.display_name ?? workspace, count };
  }).sort((left, right) => right.count - left.count || compareCanonicalStrings(left.workspace, right.workspace));
  return {
    projects,
    tags: facets(tagCounts),
    frameworks: facets(frameworkCounts),
    languages: facets(languageCounts),
    memoryClasses: facets(memoryClassCounts),
  };
}

function safeGlobalScope(entry: EntryRecord, metadata: StructuredMetadata): JsonObject {
  const signals = metadata.signals === undefined ? undefined : Object.fromEntries(
    Object.entries(metadata.signals)
      .filter(([key, value]) => key !== 'paths' && Array.isArray(value) && value.length > 0)
      .map(([key, value]) => [key, [...new Set((value as string[]).filter((item) => !containsProjectSpecificData(item, entry)))]] as const)
      .filter(([, value]) => value.length > 0),
  ) as MemorySignals;
  const applicability = hasValues(metadata.applicability) ? metadata.applicability : undefined;
  const memoryClass = metadata.memoryClass ?? (entry.kind === 'lesson' ? 'troubleshooting' : 'workflow');
  return buildStructuredScope({
    visibility: 'global',
    retrievalScope: 'global',
    memoryClass,
    ...(applicability === undefined ? {} : { applicability }),
    ...(signals === undefined || Object.keys(signals).length === 0 ? {} : { signals }),
    ...(applicability === undefined ? { portableReason: 'User-confirmed reusable knowledge through kiokuko curator' } : {}),
  });
}

function safeGlobalTags(entry: EntryRecord): string[] {
  return canonicalTagOrder([
    ...entry.tags.filter((tag) => !containsProjectSpecificData(tag, entry)),
    'global',
    'skill:curated',
    `curator:${CURATOR_DRAFT_VERSION}`,
  ]);
}

function curatedReference(entry: EntryRecord): string {
  return `${entry.id}@${entry.revision}#${CURATOR_DRAFT_VERSION}`;
}

function entriesInWorkspace(database: SqliteDatabase, workspace: string): EntryRecord[] {
  const maximumRows = 5_000;
  const rows = database.prepare(`
    SELECT id
      FROM entries
     WHERE workspace = ? AND status <> 'superseded'
     ORDER BY id
     LIMIT ?
  `).all<{ id: string }>(workspace, maximumRows + 1);
  if (rows.length > maximumRows) {
    throw new KiokukoError('VALIDATION_ERROR', 'Curator global-entry scan exceeds the bounded limit');
  }
  return rows.map(({ id }) => readEntry(database, { workspace, entryId: id }));
}

function claimsGlobalization(global: EntryRecord, source: EntryRecord): boolean {
  const provenance = global.provenance as Record<string, unknown>;
  return provenance.type === 'curator_globalize'
    && provenance.reference === curatedReference(source)
    && provenance.sourceWorkspace === source.workspace;
}

function globalizesSource(global: EntryRecord, source: EntryRecord): boolean {
  return global.status !== 'superseded' && claimsGlobalization(global, source);
}

function expectedGlobalProvenance(source: EntryRecord, timestamp: string): JsonObject {
  const sourceProvenance = source.provenance as Record<string, unknown>;
  return {
    type: 'curator_globalize',
    reference: curatedReference(source),
    sourceWorkspace: source.workspace,
    ...(typeof sourceProvenance.sourceRepositoryId === 'string' ? { sourceRepositoryId: sourceProvenance.sourceRepositoryId } : {}),
    ...(typeof sourceProvenance.sourceCommit === 'string' ? { sourceCommit: sourceProvenance.sourceCommit } : {}),
    clientKind: CURATOR_MEMORY_ACTOR,
    timestamp,
  };
}

function assertGlobalProjection(
  global: EntryRecord,
  source: EntryRecord,
  candidate: CuratorCandidate,
  metadata: StructuredMetadata,
): void {
  const expectedProvenance = expectedGlobalProvenance(source, global.createdAt);
  if (global.workspace !== GLOBAL_WORKSPACE
    || global.kind !== source.kind
    || global.title !== candidate.draft.title
    || global.body !== candidate.draft.body
    || global.summary !== candidate.draft.summary
    || canonicalJson(global.scope) !== canonicalJson(safeGlobalScope(source, metadata))
    || canonicalJson(global.provenance) !== canonicalJson(expectedProvenance)
    || global.confidence !== Math.min(source.confidence, 0.8)
    || canonicalJson(global.tags) !== canonicalJson(safeGlobalTags(source))
    || global.revision !== 1
    || global.supersededBy !== null
    || !isTrustedCuratorGlobalMemory(global)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored curator globalization does not match its deterministic source projection');
  }
}

function existingGlobalEntry(
  database: SqliteDatabase,
  source: EntryRecord,
  candidate: CuratorCandidate,
  metadata: StructuredMetadata,
): EntryRecord | undefined {
  const matches = entriesInWorkspace(database, GLOBAL_WORKSPACE).filter((entry) => claimsGlobalization(entry, source));
  if (matches.length > 1) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored curator globalization is ambiguous');
  }
  const existing = matches[0];
  if (existing !== undefined) assertGlobalProjection(existing, source, candidate, metadata);
  return existing;
}

export function globalizeCuratorCandidate(database: SqliteDatabase, input: GlobalizeCuratorInput): GlobalizeCuratorResult {
  const workspace = requireWorkspace(input.workspace);
  if (workspace === GLOBAL_WORKSPACE) throw new KiokukoError('VALIDATION_ERROR', 'Curator source workspace must be a project workspace');
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'entryId must be a non-empty string');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new KiokukoError('VALIDATION_ERROR', 'expectedRevision must be a positive integer');
  const actor = input.actor ?? CURATOR_MEMORY_ACTOR;
  if (typeof actor !== 'string' || actor.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'actor must be a non-empty string');
  const now = input.now ?? new Date().toISOString();

  return withImmediateTransaction(database, () => {
    const source = readEntry(database, { workspace, entryId: input.entryId });
    if (source.status !== 'candidate') throw new KiokukoError('CONFLICT', 'Only candidate entries can be Global化候補になります');
    if (isExternalSkillReference(source)) throw new KiokukoError('CONFLICT', 'External skill references cannot be Global化候補になります');
    if (source.revision !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Entry revision is stale');
    const candidate = candidateFromEntry(database, source);
    if (candidate === null) throw new KiokukoError('CONFLICT', 'This entry is not recommended for Global化 by curator');
    const metadata = scoreEntry(source).metadata;
    const existing = existingGlobalEntry(database, source, candidate, metadata);
    if (existing) {
      return { candidate, global: existing, idempotent: true };
    }
    const provenance = expectedGlobalProvenance(source, now);
    const global = recordEntryInTransaction(database, {
      workspace: GLOBAL_WORKSPACE,
      kind: source.kind,
      status: 'verified',
      title: candidate.draft.title,
      body: candidate.draft.body,
      summary: candidate.draft.summary,
      scope: safeGlobalScope(source, metadata),
      provenance,
      trustLevel: 'system_verified',
      confidence: Math.min(source.confidence, 0.8),
      tags: safeGlobalTags(source),
      createdBy: CURATOR_MEMORY_ACTOR,
      actor,
    }, { now });
    assertGlobalProjection(global, source, candidate, metadata);
    const persisted = existingGlobalEntry(database, source, candidate, metadata);
    if (persisted?.id !== global.id) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Curator globalization was not persisted exactly once');
    }
    return { candidate, global, idempotent: false };
  });
}

export function formatCuratorCandidate(candidate: CuratorCandidate): string {
  return [
    `スキル名: ${candidate.skillName}`,
    `エントリ: ${candidate.entryId} / revision ${candidate.revision}`,
    '概要:',
    ...candidate.overview.map((line) => `  ${line}`),
    '再生成ドラフト:',
    `  タイトル: ${candidate.draft.title}`,
    `  要約: ${candidate.draft.summary}`,
    '  本文:',
    ...candidate.draft.body.split('\n').map((line) => `    ${line}`),
    `  生成方式: ${candidate.draft.version}`,
    `  変更: ${candidate.draft.changes.join(', ')}`,
    `判定スコア: ${candidate.score}`,
    `永続知識判定: ${candidate.knowledge.skillReady ? 'skill-ready' : candidate.knowledge.tier}`,
    `qualified hit: ${candidate.knowledge.qualifiedHits} / 独立run: ${candidate.knowledge.independentRuns} / workspace: ${candidate.knowledge.independentWorkspaces}`,
    `サイロ充足度: ${candidate.knowledge.averageCompleteness}`,
    `判定根拠: ${candidate.knowledge.readinessReasons.join('、')}`,
    ...(candidate.reasons.length === 0 ? [] : [`理由: ${candidate.reasons.join('、')}`]),
    ...(candidate.warnings.length === 0 ? [] : [`注意: ${candidate.warnings.join('、')}`]),
  ].join('\n');
}

export function curatorCandidateForEntry(database: SqliteDatabase, input: { workspace: string; entryId: string }): CuratorCandidate {
  const entry = readEntry(database, { workspace: input.workspace, entryId: input.entryId });
  const candidate = candidateFromEntry(database, entry);
  if (candidate === null) throw new KiokukoError('CONFLICT', 'Entry is not a curator candidate');
  return candidate;
}
