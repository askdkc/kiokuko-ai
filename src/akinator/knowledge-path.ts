import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import type { EntryRecord } from '../memory/entries.js';
import { readEntryRevision } from '../memory/revisions.js';
import { AKINATOR_POLICY_VERSION, profileHash } from './domain.js';
import { deriveAkinatorReasoning } from './reasoning.js';
import { readAkinatorSession, readRunIntakeLink, type AkinatorProfileSources } from './store.js';
import { TASK_TYPES, type AkinatorReasoning, type AkinatorSessionView, type TaskType } from './types.js';

export type KnowledgeEvidenceTier = 'unobserved' | 'observed' | 'repeated' | 'portable';

export interface KnowledgeEvidence {
  conceptKey: string;
  totalPaths: number;
  qualifiedHits: number;
  independentRuns: number;
  independentWorkspaces: number;
  averageCompleteness: number;
  tier: KnowledgeEvidenceTier;
}

export interface RecordKnowledgePathsInput {
  runId: string;
  workspace: string;
  entries: EntryRecord[];
  outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  verification: {
    fresh: boolean;
    passedTests: number;
    passedCommands: number;
    evidenceCount: number;
  };
  createdAt: string;
  idFactory?: () => string;
}

interface KnowledgePathRow extends SqliteRow {
  path_id: unknown;
  concept_key: unknown;
  entry_id: unknown;
  entry_revision: unknown;
  entry_workspace: unknown;
  run_id: unknown;
  run_workspace: unknown;
  run_status: unknown;
  run_ended_at: unknown;
  run_last_sequence: unknown;
  run_last_source_sequence: unknown;
  intake_session_id: unknown;
  workspace: unknown;
  policy_version: unknown;
  task_type: unknown;
  intent: unknown;
  hypotheses_json: unknown;
  question_path_json: unknown;
  selected_action: unknown;
  conditions_json: unknown;
  verification_json: unknown;
  stop_conditions_json: unknown;
  silo_completeness: unknown;
  outcome: unknown;
  qualified: unknown;
  disqualification_reasons_json: unknown;
  created_at: unknown;
}

interface KnowledgePathVerification {
  expected: string;
  fresh: boolean;
  passedTests: number;
  passedCommands: number;
  evidenceCount: number;
}

interface DecodedKnowledgePath {
  conceptKey: string;
  runId: string;
  workspace: string;
  qualified: boolean;
  siloCompleteness: number;
}

interface VerificationEvidenceRow extends SqliteRow {
  evidence_count: unknown;
  passed_tests: unknown;
  passed_commands: unknown;
  fresh_verifications: unknown;
}

interface LedgerCursorRow extends SqliteRow {
  event_count: unknown;
  max_source_sequence: unknown;
}

interface KnowledgePathCountRow extends SqliteRow {
  path_count: unknown;
}

interface PersistedKnowledgePathRow extends SqliteRow {
  path_id: unknown;
  concept_key: unknown;
  entry_id: unknown;
  entry_revision: unknown;
  run_id: unknown;
  intake_session_id: unknown;
  workspace: unknown;
  policy_version: unknown;
  task_type: unknown;
  intent: unknown;
  hypotheses_json: unknown;
  question_path_json: unknown;
  selected_action: unknown;
  conditions_json: unknown;
  verification_json: unknown;
  stop_conditions_json: unknown;
  silo_completeness: unknown;
  outcome: unknown;
  qualified: unknown;
  disqualification_reasons_json: unknown;
  created_at: unknown;
}

const OUTCOMES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function storedIntegrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Akinator reasoning path data is invalid');
}

function persistenceConflict(): never {
  throw new KiokukoError('CONFLICT', 'Akinator reasoning path already exists');
}

function storedNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return storedIntegrity();
  return value;
}

function storedPositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return storedIntegrity();
  return value;
}

function storedNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return storedIntegrity();
  return value;
}

function storedNullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null;
  return storedNonNegativeInteger(value);
}

function storedTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return storedIntegrity();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return storedIntegrity();
  return value;
}

function storedCanonicalJson(value: unknown): unknown {
  if (typeof value !== 'string') return storedIntegrity();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    if (canonicalJson(parsed) !== value) return storedIntegrity();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof KiokukoError) return storedIntegrity();
    throw error;
  }
  return parsed;
}

function storedCanonicalValue(value: unknown, expected: unknown): void {
  storedCanonicalJson(value);
  if (value !== canonicalJson(expected)) storedIntegrity();
}

function storedOutcome(value: unknown): (typeof OUTCOMES)[number] {
  if (typeof value !== 'string' || !OUTCOMES.includes(value as (typeof OUTCOMES)[number])) return storedIntegrity();
  return value as (typeof OUTCOMES)[number];
}

function storedTaskType(value: unknown): TaskType {
  if (typeof value !== 'string' || !TASK_TYPES.includes(value as TaskType)) return storedIntegrity();
  return value as TaskType;
}

function storedQualified(value: unknown): boolean {
  if (value !== 0 && value !== 1) return storedIntegrity();
  return value === 1;
}

function storedCompleteness(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return storedIntegrity();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeVerification(value: unknown, expected: string): KnowledgePathVerification {
  const decoded = storedCanonicalJson(value);
  if (!isPlainObject(decoded)) return storedIntegrity();
  const fields = ['expected', 'fresh', 'passedTests', 'passedCommands', 'evidenceCount'];
  if (Object.keys(decoded).length !== fields.length || Object.keys(decoded).some((field) => !fields.includes(field))) return storedIntegrity();
  if (decoded.expected !== expected || typeof decoded.fresh !== 'boolean') return storedIntegrity();
  const passedTests = storedNonNegativeInteger(decoded.passedTests);
  const passedCommands = storedNonNegativeInteger(decoded.passedCommands);
  const evidenceCount = storedNonNegativeInteger(decoded.evidenceCount);
  if (passedTests + passedCommands > evidenceCount || (decoded.fresh && evidenceCount === 0)) return storedIntegrity();
  return {
    expected,
    fresh: decoded.fresh,
    passedTests,
    passedCommands,
    evidenceCount,
  };
}

function expectedDisqualificationReasons(input: {
  outcome: (typeof OUTCOMES)[number];
  reasoning: AkinatorReasoning;
  verification: KnowledgePathVerification;
  profileSources: AkinatorProfileSources;
}): string[] {
  const reasons: string[] = [];
  if (input.outcome !== 'completed') reasons.push('run-not-completed');
  if (input.reasoning.stage !== 'actionable' || input.reasoning.silo.completeness < 1) reasons.push('reasoning-silo-incomplete');
  if (!input.verification.fresh && input.verification.passedTests === 0) reasons.push('no-fresh-verification-or-passing-test');
  for (const field of ['target', 'expected'] as const) {
    const source = input.profileSources[field];
    if (source !== 'client_supplied' && source !== 'user_answer') reasons.push(`${field}-not-grounded`);
  }
  return reasons;
}

function expectedQuestionPath(session: AkinatorSessionView, profileSources: AkinatorProfileSources): Array<{
  field: keyof AkinatorSessionView['profile'];
  source: 'inferred' | 'client_supplied' | 'user_answer';
}> {
  return (['taskType', 'target', 'expected', 'constraints'] as const)
    .filter((field) => session.profile[field] !== null)
    .map((field) => ({ field, source: profileSources[field] ?? 'inferred' }));
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|workspace|private|tmp|var|opt)\/)[^\s"'`]+/giu;
const PROJECT_PHRASE = /\b(?:this|current|our)\s+(?:project|repository|repo)\b|(?:この|現在の|対象の)(?:プロジェクト|リポジトリ)/giu;

function normalizedConceptTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(ABSOLUTE_PATH, '<path>')
    .replace(PROJECT_PHRASE, '<project>')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function knowledgeConceptKey(entry: Pick<EntryRecord, 'title' | 'kind' | 'scope'>): string {
  const scope = entry.scope as Record<string, unknown>;
  return canonicalContentHash({
    kind: entry.kind,
    memoryClass: typeof scope.memoryClass === 'string' ? scope.memoryClass : null,
    title: normalizedConceptTitle(entry.title),
  });
}

function knowledgePathCount(database: SqliteDatabase, runId: string): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS path_count
      FROM akinator_reasoning_paths
     WHERE run_id = ?
  `).get<KnowledgePathCountRow>(runId);
  if (row === undefined) return storedIntegrity();
  return storedNonNegativeInteger(row.path_count);
}

function assertPersistedKnowledgePath(
  database: SqliteDatabase,
  expected: Readonly<Record<string, string | number> & { path_id: string }>,
): void {
  const row = database.prepare(`
    SELECT path_id, concept_key, entry_id, entry_revision, run_id, intake_session_id,
           workspace, policy_version, task_type, intent, hypotheses_json,
           question_path_json, selected_action, conditions_json, verification_json,
           stop_conditions_json, silo_completeness, outcome, qualified,
           disqualification_reasons_json, created_at
      FROM akinator_reasoning_paths
     WHERE path_id = ?
  `).get<PersistedKnowledgePathRow>(expected.path_id);
  if (row === undefined) return storedIntegrity();
  for (const [field, value] of Object.entries(expected)) {
    if (row[field] !== value) return storedIntegrity();
  }
}

export function recordKnowledgePathsInTransaction(
  database: SqliteDatabase,
  input: RecordKnowledgePathsInput,
): { recorded: number; qualified: number } {
  if (input.entries.length === 0) return { recorded: 0, qualified: 0 };
  const intake = readRunIntakeLink(database, { workspace: input.workspace, runId: input.runId });
  const session = readAkinatorSession(database, { workspace: input.workspace, sessionId: intake.sessionId });
  const reasoning = deriveAkinatorReasoning(session.task, session.profile);
  if (reasoning.selectedAction === null || session.profile.taskType === null || session.profile.expected === null) return { recorded: 0, qualified: 0 };

  const questionPath = expectedQuestionPath(session, intake.profileSources);
  const hypotheses = reasoning.hypotheses.map(({ id, status }) => ({ id, status }));
  const verification: KnowledgePathVerification = {
    expected: session.profile.expected,
    fresh: input.verification.fresh,
    passedTests: input.verification.passedTests,
    passedCommands: input.verification.passedCommands,
    evidenceCount: input.verification.evidenceCount,
  };
  const disqualificationReasons = expectedDisqualificationReasons({
    outcome: input.outcome,
    reasoning,
    verification,
    profileSources: intake.profileSources,
  });
  const qualified = disqualificationReasons.length === 0;
  const idFactory = input.idFactory ?? randomUUID;
  const pending = input.entries.map((entry) => ({
    entry,
    pathId: idFactory(),
    conceptKey: knowledgeConceptKey(entry),
  }));
  const seenPathIds = new Set<string>();
  const seenLogicalPaths = new Map<string, Set<number>>();
  for (const { entry, pathId } of pending) {
    if (typeof pathId !== 'string' || pathId.length === 0 || seenPathIds.has(pathId)) return persistenceConflict();
    seenPathIds.add(pathId);
    const revisions = seenLogicalPaths.get(entry.id) ?? new Set<number>();
    if (revisions.has(entry.revision)) return persistenceConflict();
    revisions.add(entry.revision);
    seenLogicalPaths.set(entry.id, revisions);
  }

  const existingPathId = database.prepare('SELECT path_id FROM akinator_reasoning_paths WHERE path_id = ?');
  const existingLogicalPath = database.prepare(`
    SELECT path_id
      FROM akinator_reasoning_paths
     WHERE run_id = ? AND entry_id = ? AND entry_revision = ?
  `);
  for (const { entry, pathId } of pending) {
    if (existingPathId.get(pathId) !== undefined
      || existingLogicalPath.get(input.runId, entry.id, entry.revision) !== undefined) return persistenceConflict();
  }

  const beforeCount = knowledgePathCount(database, input.runId);
  for (const { entry, pathId, conceptKey } of pending) {
    const expected = {
      path_id: pathId,
      concept_key: conceptKey,
      entry_id: entry.id,
      entry_revision: entry.revision,
      run_id: input.runId,
      intake_session_id: intake.sessionId,
      workspace: input.workspace,
      policy_version: `${AKINATOR_POLICY_VERSION}+${reasoning.policyVersion}`,
      task_type: session.profile.taskType,
      intent: session.task,
      hypotheses_json: canonicalJson(hypotheses),
      question_path_json: canonicalJson(questionPath),
      selected_action: reasoning.selectedAction,
      conditions_json: canonicalJson(reasoning.conditions),
      verification_json: canonicalJson(verification),
      stop_conditions_json: canonicalJson(reasoning.stopConditions),
      silo_completeness: reasoning.silo.completeness,
      outcome: input.outcome,
      qualified: qualified ? 1 : 0,
      disqualification_reasons_json: canonicalJson(disqualificationReasons),
      created_at: input.createdAt,
    };
    database.prepare(`
      INSERT INTO akinator_reasoning_paths (
        path_id, concept_key, entry_id, entry_revision, run_id, intake_session_id,
        workspace, policy_version, task_type, intent, hypotheses_json,
        question_path_json, selected_action, conditions_json, verification_json,
        stop_conditions_json, silo_completeness, outcome, qualified,
        disqualification_reasons_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      expected.path_id,
      expected.concept_key,
      expected.entry_id,
      expected.entry_revision,
      expected.run_id,
      expected.intake_session_id,
      expected.workspace,
      expected.policy_version,
      expected.task_type,
      expected.intent,
      expected.hypotheses_json,
      expected.question_path_json,
      expected.selected_action,
      expected.conditions_json,
      expected.verification_json,
      expected.stop_conditions_json,
      expected.silo_completeness,
      expected.outcome,
      expected.qualified,
      expected.disqualification_reasons_json,
      expected.created_at,
    );
    const changes = database.prepare('SELECT changes() AS changes').get<{ changes: unknown }>()?.changes;
    if (changes !== 1) return storedIntegrity();
    assertPersistedKnowledgePath(database, expected);
  }
  if (knowledgePathCount(database, input.runId) !== beforeCount + pending.length) return storedIntegrity();
  return { recorded: input.entries.length, qualified: qualified ? input.entries.length : 0 };
}

function readLinkedState<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof KiokukoError) return storedIntegrity();
    throw error;
  }
}

function verificationEvidence(
  database: SqliteDatabase,
  runId: string,
  createdAt: string,
): VerificationEvidenceRow {
  const row = database.prepare(`
    SELECT COUNT(*) AS evidence_count,
           COALESCE(SUM(CASE
             WHEN le.kind = 'test'
              AND ev.event_type = 'test.completed'
              AND ev.outcome = 'passed'
             THEN 1 ELSE 0 END), 0) AS passed_tests,
           COALESCE(SUM(CASE
             WHEN le.kind = 'command'
              AND ev.event_type = 'command.completed'
              AND ev.outcome = 'passed'
             THEN 1 ELSE 0 END), 0) AS passed_commands,
           COALESCE(SUM(CASE
             WHEN le.kind = 'artifact'
              AND le.locator = 'verification'
              AND ev.event_type = 'verification.recorded'
              AND ev.outcome = 'fresh'
             THEN 1 ELSE 0 END), 0) AS fresh_verifications
      FROM ledger_evidence AS le
      LEFT JOIN ledger_events AS ev
        ON ev.event_id = le.event_id
       AND ev.run_id = le.run_id
     WHERE le.run_id = ?
       AND le.created_at = ?
  `).get<VerificationEvidenceRow>(runId, createdAt);
  if (row === undefined) return storedIntegrity();
  return row;
}

function assertLedgerRunIntegrity(
  database: SqliteDatabase,
  runId: string,
  lastSequenceValue: unknown,
  lastSourceSequenceValue: unknown,
  verifiedRuns: Set<string>,
): void {
  const lastSequence = storedNonNegativeInteger(lastSequenceValue);
  const lastSourceSequence = storedNullableNonNegativeInteger(lastSourceSequenceValue);
  if (verifiedRuns.has(runId)) return;
  let chainIsValid: boolean;
  try {
    chainIsValid = new LedgerStore(database).verifyChain(runId);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof KiokukoError) return storedIntegrity();
    throw error;
  }
  if (!chainIsValid) return storedIntegrity();
  const cursor = database.prepare(`
    SELECT COUNT(*) AS event_count,
           MAX(source_sequence) AS max_source_sequence
      FROM ledger_events
     WHERE run_id = ?
  `).get<LedgerCursorRow>(runId);
  if (cursor === undefined
    || storedNonNegativeInteger(cursor.event_count) !== lastSequence
    || storedNullableNonNegativeInteger(cursor.max_source_sequence) !== lastSourceSequence) return storedIntegrity();
  verifiedRuns.add(runId);
}

function decodeKnowledgePath(
  database: SqliteDatabase,
  row: KnowledgePathRow,
  verifiedRuns: Set<string>,
): DecodedKnowledgePath {
  storedNonEmptyString(row.path_id);
  const conceptKey = storedNonEmptyString(row.concept_key);
  if (!/^[0-9a-f]{64}$/u.test(conceptKey)) return storedIntegrity();
  const entryId = storedNonEmptyString(row.entry_id);
  const entryRevision = storedPositiveInteger(row.entry_revision);
  const workspace = storedNonEmptyString(row.workspace);
  const entryWorkspace = storedNonEmptyString(row.entry_workspace);
  if (entryWorkspace !== workspace && entryWorkspace !== 'global') return storedIntegrity();
  const revision = readLinkedState(() => readEntryRevision(database, {
    entryId,
    workspace: entryWorkspace,
    revision: entryRevision,
  }));
  if (knowledgeConceptKey(revision) !== conceptKey) return storedIntegrity();

  const runId = storedNonEmptyString(row.run_id);
  const runWorkspace = storedNonEmptyString(row.run_workspace);
  if (runWorkspace !== workspace) return storedIntegrity();
  assertLedgerRunIntegrity(
    database,
    runId,
    row.run_last_sequence,
    row.run_last_source_sequence,
    verifiedRuns,
  );
  const outcome = storedOutcome(row.outcome);
  if (storedOutcome(row.run_status) !== outcome) return storedIntegrity();
  const createdAt = storedTimestamp(row.created_at);
  if (storedTimestamp(row.run_ended_at) !== createdAt) return storedIntegrity();

  const intakeSessionId = storedNonEmptyString(row.intake_session_id);
  const intake = readLinkedState(() => readRunIntakeLink(database, { workspace, runId }));
  if (intake.sessionId !== intakeSessionId
    || intake.workspace !== workspace
    || intake.policyVersion !== AKINATOR_POLICY_VERSION
    || intake.profileSchemaVersion !== 1
    || intake.finalizedAt === null
    || intake.initialProfileHash === null) return storedIntegrity();
  const session = readLinkedState(() => readAkinatorSession(database, { workspace, sessionId: intakeSessionId }));
  if (session.id !== intakeSessionId
    || session.workspace !== workspace
    || session.status !== 'ready'
    || profileHash(session.profile) !== intake.initialProfileHash) return storedIntegrity();

  const reasoning = deriveAkinatorReasoning(session.task, session.profile);
  if (reasoning.stage !== 'actionable'
    || reasoning.selectedAction === null
    || session.profile.taskType === null
    || session.profile.expected === null) return storedIntegrity();
  if (storedNonEmptyString(row.policy_version) !== `${AKINATOR_POLICY_VERSION}+${reasoning.policyVersion}`
    || storedTaskType(row.task_type) !== session.profile.taskType
    || storedNonEmptyString(row.intent) !== session.task
    || storedNonEmptyString(row.selected_action) !== reasoning.selectedAction) return storedIntegrity();

  storedCanonicalValue(row.hypotheses_json, reasoning.hypotheses.map(({ id, status }) => ({ id, status })));
  storedCanonicalValue(row.question_path_json, expectedQuestionPath(session, intake.profileSources));
  storedCanonicalValue(row.conditions_json, reasoning.conditions);
  storedCanonicalValue(row.stop_conditions_json, reasoning.stopConditions);
  const siloCompleteness = storedCompleteness(row.silo_completeness);
  if (siloCompleteness !== reasoning.silo.completeness) return storedIntegrity();

  const verification = decodeVerification(row.verification_json, session.profile.expected);
  const evidence = verificationEvidence(database, runId, createdAt);
  if (storedNonNegativeInteger(evidence.evidence_count) !== verification.evidenceCount
    || storedNonNegativeInteger(evidence.passed_tests) !== verification.passedTests
    || storedNonNegativeInteger(evidence.passed_commands) !== verification.passedCommands
    || (storedNonNegativeInteger(evidence.fresh_verifications) === 1) !== verification.fresh
    || storedNonNegativeInteger(evidence.fresh_verifications) > 1) return storedIntegrity();

  const reasons = expectedDisqualificationReasons({
    outcome,
    reasoning,
    verification,
    profileSources: intake.profileSources,
  });
  storedCanonicalValue(row.disqualification_reasons_json, reasons);
  const qualified = storedQualified(row.qualified);
  if (qualified !== (reasons.length === 0)) return storedIntegrity();
  return { conceptKey, runId, workspace, qualified, siloCompleteness };
}

export function readKnowledgeEvidence(
  database: SqliteDatabase,
  entry: Pick<EntryRecord, 'title' | 'kind' | 'scope'>,
): KnowledgeEvidence {
  const conceptKey = knowledgeConceptKey(entry);
  const rows = database.prepare(`
    SELECT arp.path_id, arp.concept_key, arp.entry_id, arp.entry_revision,
           er.workspace AS entry_workspace,
           arp.run_id, lr.workspace AS run_workspace, lr.status AS run_status,
           lr.ended_at AS run_ended_at, lr.last_sequence AS run_last_sequence,
           lr.last_source_sequence AS run_last_source_sequence,
           arp.intake_session_id, arp.workspace,
           arp.policy_version, arp.task_type, arp.intent, arp.hypotheses_json,
           arp.question_path_json, arp.selected_action, arp.conditions_json,
           arp.verification_json, arp.stop_conditions_json, arp.silo_completeness,
           arp.outcome, arp.qualified, arp.disqualification_reasons_json, arp.created_at
      FROM akinator_reasoning_paths AS arp
      LEFT JOIN entry_revisions AS er
        ON er.entry_id = arp.entry_id
       AND er.revision = arp.entry_revision
      LEFT JOIN ledger_runs AS lr ON lr.run_id = arp.run_id
     ORDER BY arp.path_id ASC
  `).all<KnowledgePathRow>();
  const verifiedRuns = new Set<string>();
  const paths = rows.map((row) => decodeKnowledgePath(database, row, verifiedRuns));
  const matchingPaths = paths.filter((path) => path.conceptKey === conceptKey);
  const qualifiedPaths = matchingPaths.filter((path) => path.qualified);
  const qualifiedRuns = new Set(qualifiedPaths.map((path) => path.runId));
  const independentWorkspaces = new Set(qualifiedPaths.map((path) => path.workspace)).size;
  const totalPaths = matchingPaths.length;
  const qualifiedHits = qualifiedRuns.size;
  const independentRuns = qualifiedRuns.size;
  const averageCompleteness = qualifiedPaths.length === 0
    ? 0
    : Number((qualifiedPaths.reduce((total, path) => total + path.siloCompleteness, 0) / qualifiedPaths.length).toFixed(3));
  const tier: KnowledgeEvidenceTier = qualifiedHits === 0
    ? totalPaths === 0 ? 'unobserved' : 'observed'
    : independentWorkspaces >= 2 ? 'portable'
      : independentRuns >= 2 ? 'repeated'
        : 'observed';
  return {
    conceptKey,
    totalPaths,
    qualifiedHits,
    independentRuns,
    independentWorkspaces,
    averageCompleteness,
    tier,
  };
}
