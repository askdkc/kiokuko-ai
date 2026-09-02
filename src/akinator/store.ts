import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError, type ErrorCode } from '../errors.js';
import { canonicalJson, requireWorkspace } from '../serialization/validate.js';
import { parseStrictJson } from '../setup/strict-json.js';
import { evaluateProfile } from './domain.js';
import { TASK_TYPES, type AkinatorSessionView, type TaskProfile, type TaskType } from './types.js';

export interface InsertAkinatorSessionInput {
  readonly id: string;
  readonly workspace: string;
  readonly task: string;
  readonly profile: TaskProfile;
  readonly status: AkinatorSessionView['status'];
  readonly questionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReadAkinatorSessionInput {
  readonly workspace: string;
  readonly sessionId: string;
}

export interface UpdateAkinatorSessionInput {
  readonly workspace: string;
  readonly sessionId: string;
  readonly expectedQuestionCount: number;
  readonly profile: TaskProfile;
  readonly status: AkinatorSessionView['status'];
  readonly questionCount: number;
  readonly updatedAt: string;
}

export interface ReadAkinatorAnswerInput {
  readonly workspace: string;
  readonly sessionId: string;
  readonly questionId: keyof TaskProfile;
}

export interface InsertAkinatorAnswerInput extends ReadAkinatorAnswerInput {
  readonly answer: unknown;
  readonly createdAt: string;
}

export interface AkinatorAnswerRecord {
  readonly sessionId: string;
  readonly questionId: keyof TaskProfile;
  readonly answer: unknown;
  readonly createdAt: string;
}

export type AkinatorProfileSource = 'inferred' | 'client_supplied' | 'user_answer';
export type AkinatorProfileSources = Partial<Record<keyof TaskProfile, AkinatorProfileSource>>;

export interface InsertRunIntakeLinkInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly policyVersion: string;
  readonly profileSchemaVersion: number;
  readonly profileSources: AkinatorProfileSources;
  readonly initialProfileHash: string | null;
  readonly recommendedTags: string[];
  readonly linkedAt: string;
  readonly finalizedAt: string | null;
}

export interface ReadRunIntakeLinkInput {
  readonly workspace: string;
  readonly runId: string;
}

export interface FinalizeRunIntakeLinkInput {
  readonly workspace: string;
  readonly runId: string;
  readonly profileHash: string;
  readonly recommendedTags: string[];
  readonly finalizedAt: string;
}

export interface MarkRunIntakeProfileSourceInput {
  readonly workspace: string;
  readonly runId: string;
  readonly field: keyof TaskProfile;
}

export interface RunIntakeLinkView {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly policyVersion: string;
  readonly profileSchemaVersion: number;
  readonly profileSources: AkinatorProfileSources;
  readonly initialProfileHash: string | null;
  readonly recommendedTags: string[];
  readonly linkedAt: string;
  readonly finalizedAt: string | null;
}

interface SessionRow extends SqliteRow {
  id: unknown;
  workspace: unknown;
  task_text: unknown;
  profile_json: unknown;
  status: unknown;
  question_count: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface AnswerRow extends SqliteRow {
  session_id: unknown;
  question_id: unknown;
  answer_json: unknown;
  created_at: unknown;
}

interface RunIntakeRow extends SqliteRow {
  run_id: unknown;
  session_id: unknown;
  session_id_join: unknown;
  session_workspace: unknown;
  workspace: unknown;
  policy_version: unknown;
  profile_schema_version: unknown;
  profile_sources_json: unknown;
  initial_profile_hash: unknown;
  recommended_tags_json: unknown;
  linked_at: unknown;
  finalized_at: unknown;
}

const SESSION_INPUT_FIELDS = new Set([
  'id', 'workspace', 'task', 'profile', 'status', 'questionCount', 'createdAt', 'updatedAt',
]);
const SESSION_READ_FIELDS = new Set(['workspace', 'sessionId']);
const SESSION_UPDATE_FIELDS = new Set([
  'workspace', 'sessionId', 'expectedQuestionCount', 'profile', 'status', 'questionCount', 'updatedAt',
]);
const ANSWER_FIELDS = new Set(['workspace', 'sessionId', 'questionId', 'answer', 'createdAt']);
const ANSWER_READ_FIELDS = new Set(['workspace', 'sessionId', 'questionId']);
const INTAKE_LINK_FIELDS = new Set([
  'runId', 'sessionId', 'workspace', 'policyVersion', 'profileSchemaVersion', 'profileSources',
  'initialProfileHash', 'recommendedTags', 'linkedAt', 'finalizedAt',
]);
const INTAKE_LINK_READ_FIELDS = new Set(['workspace', 'runId']);
const INTAKE_LINK_FINALIZE_FIELDS = new Set(['workspace', 'runId', 'profileHash', 'recommendedTags', 'finalizedAt']);
const INTAKE_LINK_SOURCE_FIELDS = new Set(['workspace', 'runId', 'field']);
const PROFILE_FIELDS = new Set(['taskType', 'target', 'expected', 'constraints']);
const PROFILE_SOURCE_VALUES = ['inferred', 'client_supplied', 'user_answer'] as const;
const SESSION_STATUSES = ['active', 'ready', 'exhausted'] as const;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type SessionStatus = (typeof SESSION_STATUSES)[number];

function fail(code: ErrorCode, message: string): never {
  throw new KiokukoError(code, message);
}

function validation(): never {
  return fail('VALIDATION_ERROR', 'Invalid Akinator store input');
}

function integrity(): never {
  return fail('INTEGRITY_ERROR', 'Akinator store data is invalid');
}

function notFoundSession(): never {
  return fail('NOT_FOUND', 'Akinator session not found');
}

function notFoundLink(): never {
  return fail('NOT_FOUND', 'Run intake link not found');
}

function conflict(): never {
  return fail('CONFLICT', 'Akinator store operation conflicts with existing data');
}

interface SqliteConstraintFailure {
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly message?: unknown;
}

const SQLITE_CONSTRAINT_PRIMARY_KEY = 1_555;
const SQLITE_CONSTRAINT_UNIQUE = 2_067;

function isExpectedUniquenessFailure(error: unknown, constraints: ReadonlySet<string>): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as SqliteConstraintFailure;
  if (failure.code !== 'ERR_SQLITE_ERROR' || !Number.isSafeInteger(failure.errcode)) return false;
  if (failure.errcode !== SQLITE_CONSTRAINT_PRIMARY_KEY && failure.errcode !== SQLITE_CONSTRAINT_UNIQUE) return false;
  return typeof failure.message === 'string' && constraints.has(failure.message);
}

function mapExpectedUniquenessFailure(error: unknown, constraints: ReadonlySet<string>): never {
  if (isExpectedUniquenessFailure(error, constraints)) return conflict();
  throw error;
}

const SESSION_UNIQUENESS_FAILURES = new Set([
  'UNIQUE constraint failed: akinator_sessions.id',
]);
const ANSWER_UNIQUENESS_FAILURES = new Set([
  'UNIQUE constraint failed: akinator_answers.session_id, akinator_answers.question_id',
]);
const INTAKE_LINK_UNIQUENESS_FAILURES = new Set([
  'UNIQUE constraint failed: run_intakes.run_id',
  'UNIQUE constraint failed: run_intakes.session_id',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectWithFields(value: unknown, fields: Set<string>): Record<string, unknown> {
  if (!isPlainObject(value)) return validation();
  if (Object.keys(value).some((field) => !fields.has(field))) return validation();
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return validation();
  return value;
}

function timestamp(value: unknown): string {
  return timestampFor(value, validation);
}

function storedTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return integrity();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) return integrity();
  return value;
}

function taskType(value: unknown, onInvalid: () => never): TaskType | null {
  if (value === null) return null;
  if (typeof value === 'string' && TASK_TYPES.includes(value as TaskType)) return value as TaskType;
  return onInvalid();
}

function profile(value: unknown, onInvalid: () => never): TaskProfile {
  if (!isPlainObject(value) || Object.keys(value).some((field) => !PROFILE_FIELDS.has(field))) return onInvalid();
  if (!Object.hasOwn(value, 'taskType') || !Object.hasOwn(value, 'target') || !Object.hasOwn(value, 'expected') || !Object.hasOwn(value, 'constraints')) return onInvalid();
  const fields = ['target', 'expected', 'constraints'] as const;
  for (const field of fields) {
    if (value[field] !== null && typeof value[field] !== 'string') return onInvalid();
  }
  return {
    taskType: taskType(value.taskType, onInvalid),
    target: value.target as string | null,
    expected: value.expected as string | null,
    constraints: value.constraints as string | null,
  };
}

function sessionStatus(value: unknown, onInvalid: () => never): SessionStatus {
  if (typeof value === 'string' && SESSION_STATUSES.includes(value as SessionStatus)) return value as SessionStatus;
  return onInvalid();
}

function questionCount(value: unknown, onInvalid: () => never): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) return onInvalid();
  return value;
}

function assertSessionEvaluation(
  validatedProfile: TaskProfile,
  status: SessionStatus,
  count: number,
  onInvalid: () => never,
): void {
  let evaluated: ReturnType<typeof evaluateProfile>;
  try {
    evaluated = evaluateProfile(validatedProfile, count);
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') return onInvalid();
    throw error;
  }
  const expectedStatus: SessionStatus = evaluated.status === 'needs_answer' ? 'active' : evaluated.status;
  if (status !== expectedStatus) return onInvalid();
}

function sessionInput(value: unknown): InsertAkinatorSessionInput {
  const input = objectWithFields(value, SESSION_INPUT_FIELDS);
  const id = stringValue(input.id);
  const workspace = requireWorkspace(input.workspace);
  const task = stringValue(input.task);
  const validatedProfile = profile(input.profile, validation);
  const status = sessionStatus(input.status, validation);
  const count = questionCount(input.questionCount, validation);
  assertSessionEvaluation(validatedProfile, status, count, validation);
  const createdAt = timestamp(input.createdAt);
  const updatedAt = timestamp(input.updatedAt);
  return { id, workspace, task, profile: validatedProfile, status, questionCount: count, createdAt, updatedAt };
}

function sessionReadInput(value: unknown): ReadAkinatorSessionInput {
  const input = objectWithFields(value, SESSION_READ_FIELDS);
  return { workspace: requireWorkspace(input.workspace), sessionId: stringValue(input.sessionId) };
}

function answerQuestionId(value: unknown, onInvalid: () => never): keyof TaskProfile {
  if (typeof value === 'string' && PROFILE_FIELDS.has(value)) return value as keyof TaskProfile;
  return onInvalid();
}

function answerJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return validation();
  }
}

function answerInput(value: unknown): InsertAkinatorAnswerInput {
  const input = objectWithFields(value, ANSWER_FIELDS);
  return {
    workspace: requireWorkspace(input.workspace),
    sessionId: stringValue(input.sessionId),
    questionId: answerQuestionId(input.questionId, validation),
    answer: input.answer,
    createdAt: timestamp(input.createdAt),
  };
}

function answerReadInput(value: unknown): ReadAkinatorAnswerInput {
  const input = objectWithFields(value, ANSWER_READ_FIELDS);
  return {
    workspace: requireWorkspace(input.workspace),
    sessionId: stringValue(input.sessionId),
    questionId: answerQuestionId(input.questionId, validation),
  };
}

function profileSources(value: unknown, onInvalid: () => never): AkinatorProfileSources {
  if (!isPlainObject(value)) return onInvalid();
  const result: AkinatorProfileSources = {};
  for (const [field, source] of Object.entries(value)) {
    if (!PROFILE_FIELDS.has(field) || typeof source !== 'string' || !PROFILE_SOURCE_VALUES.includes(source as AkinatorProfileSource)) return onInvalid();
    result[field as keyof TaskProfile] = source as AkinatorProfileSource;
  }
  return result;
}

function profileHash(value: unknown, onInvalid: () => never): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value;
  return onInvalid();
}

function tagValues(value: unknown, onInvalid: () => never, rejectDuplicates: boolean): string[] {
  if (!Array.isArray(value)) return onInvalid();
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string' || tag.trim().length === 0) return onInvalid();
    if (seen.has(tag)) {
      if (rejectDuplicates) return onInvalid();
      continue;
    }
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function timestampFor(value: unknown, onInvalid: () => never): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return onInvalid();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) return onInvalid();
  return value;
}

function nullableTimestamp(value: unknown, onInvalid: () => never): string | null {
  if (value === null) return null;
  return timestampFor(value, onInvalid);
}

function intakeLinkInput(value: unknown): InsertRunIntakeLinkInput {
  const input = objectWithFields(value, INTAKE_LINK_FIELDS);
  const initialProfileHash = input.initialProfileHash === undefined ? null : profileHash(input.initialProfileHash, validation);
  const finalizedAt = input.finalizedAt === undefined ? null : nullableTimestamp(input.finalizedAt, validation);
  if (finalizedAt !== null) return validation();
  if (typeof input.profileSchemaVersion !== 'number' || !Number.isInteger(input.profileSchemaVersion) || input.profileSchemaVersion <= 0) return validation();
  return {
    runId: stringValue(input.runId),
    sessionId: stringValue(input.sessionId),
    workspace: requireWorkspace(input.workspace),
    policyVersion: stringValue(input.policyVersion),
    profileSchemaVersion: input.profileSchemaVersion,
    profileSources: profileSources(input.profileSources, validation),
    initialProfileHash,
    recommendedTags: tagValues(input.recommendedTags, validation, false),
    linkedAt: timestampFor(input.linkedAt, validation),
    finalizedAt,
  };
}

function intakeLinkReadInput(value: unknown): ReadRunIntakeLinkInput {
  const input = objectWithFields(value, INTAKE_LINK_READ_FIELDS);
  return { workspace: requireWorkspace(input.workspace), runId: stringValue(input.runId) };
}

function intakeLinkFinalizeInput(value: unknown): FinalizeRunIntakeLinkInput {
  const input = objectWithFields(value, INTAKE_LINK_FINALIZE_FIELDS);
  const hash = profileHash(input.profileHash, validation);
  if (hash === null) return validation();
  return {
    workspace: requireWorkspace(input.workspace),
    runId: stringValue(input.runId),
    profileHash: hash,
    recommendedTags: tagValues(input.recommendedTags, validation, false),
    finalizedAt: timestampFor(input.finalizedAt, validation),
  };
}

function intakeLinkSourceInput(value: unknown): MarkRunIntakeProfileSourceInput {
  const input = objectWithFields(value, INTAKE_LINK_SOURCE_FIELDS);
  return {
    workspace: requireWorkspace(input.workspace),
    runId: stringValue(input.runId),
    field: answerQuestionId(input.field, validation),
  };
}

function sessionUpdateInput(value: unknown): UpdateAkinatorSessionInput {
  const input = objectWithFields(value, SESSION_UPDATE_FIELDS);
  const expectedQuestionCount = questionCount(input.expectedQuestionCount, validation);
  const nextQuestionCount = questionCount(input.questionCount, validation);
  const validatedProfile = profile(input.profile, validation);
  const status = sessionStatus(input.status, validation);
  assertSessionEvaluation(validatedProfile, status, nextQuestionCount, validation);
  const updatedAt = timestamp(input.updatedAt);
  return {
    workspace: requireWorkspace(input.workspace),
    sessionId: stringValue(input.sessionId),
    expectedQuestionCount,
    profile: validatedProfile,
    status,
    questionCount: nextQuestionCount,
    updatedAt,
  };
}

function parseStoredProfile(value: unknown): TaskProfile {
  if (typeof value !== 'string') return integrity();
  let parsed: unknown;
  try {
    parsed = parseStrictJson(
      value,
      { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
      'Stored Akinator profile is invalid',
    );
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') return integrity();
    throw error;
  }
  if (canonicalStoredJson(parsed) !== value) return integrity();
  return profile(parsed, integrity);
}

function storedString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return integrity();
  return value;
}

function storedQuestionCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) return integrity();
  return value;
}

function parseStoredAnswer(value: unknown): unknown {
  if (typeof value !== 'string') return integrity();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return integrity();
    throw error;
  }
  if (canonicalStoredJson(parsed) !== value) return integrity();
  return parsed;
}

function canonicalStoredJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    if (error instanceof RangeError
      || (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR')) return integrity();
    throw error;
  }
}

function parseStoredCanonicalJson(value: unknown): unknown {
  if (typeof value !== 'string') return integrity();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return integrity();
    throw error;
  }
  if (canonicalStoredJson(parsed) !== value) return integrity();
  return parsed;
}

function storedProfileSources(value: unknown): AkinatorProfileSources {
  return profileSources(parseStoredCanonicalJson(value), integrity);
}

function storedTags(value: unknown): string[] {
  return tagValues(parseStoredCanonicalJson(value), integrity, true);
}

function storedHash(value: unknown): string | null {
  return profileHash(value, integrity);
}

function storedNullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return storedTimestamp(value);
}

function storedPositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return integrity();
  return value;
}

function mapAnswer(row: AnswerRow): AkinatorAnswerRecord {
  return {
    sessionId: storedString(row.session_id),
    questionId: answerQuestionId(row.question_id, integrity),
    answer: parseStoredAnswer(row.answer_json),
    createdAt: storedTimestamp(row.created_at),
  };
}

function mapIntakeLink(row: RunIntakeRow): RunIntakeLinkView {
  if (row.session_id_join !== row.session_id || row.session_workspace !== row.workspace) return integrity();
  const finalizedAt = storedNullableTimestamp(row.finalized_at);
  const initialProfileHash = storedHash(row.initial_profile_hash);
  if (finalizedAt !== null && initialProfileHash === null) return integrity();
  return {
    runId: storedString(row.run_id),
    sessionId: storedString(row.session_id),
    workspace: storedString(row.workspace),
    policyVersion: storedString(row.policy_version),
    profileSchemaVersion: storedPositiveInteger(row.profile_schema_version),
    profileSources: storedProfileSources(row.profile_sources_json),
    initialProfileHash,
    recommendedTags: storedTags(row.recommended_tags_json),
    linkedAt: storedTimestamp(row.linked_at),
    finalizedAt,
  };
}

function mapSession(row: SessionRow): AkinatorSessionView {
  const validatedProfile = parseStoredProfile(row.profile_json);
  const status = sessionStatus(row.status, integrity);
  const count = storedQuestionCount(row.question_count);
  assertSessionEvaluation(validatedProfile, status, count, integrity);
  return {
    id: storedString(row.id),
    workspace: storedString(row.workspace),
    task: storedString(row.task_text),
    profile: validatedProfile,
    status,
    questionCount: count,
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
  };
}

function selectSession(database: SqliteDatabase, workspace: string, sessionId: string): SessionRow | undefined {
  return database.prepare(`
    SELECT id, workspace, task_text, profile_json, status, question_count, created_at, updated_at
    FROM akinator_sessions
    WHERE id = ? AND workspace = ?
  `).get<SessionRow>(sessionId, workspace);
}

function selectAnswer(database: SqliteDatabase, sessionId: string, questionId: keyof TaskProfile): AnswerRow | undefined {
  return database.prepare(`
    SELECT session_id, question_id, answer_json, created_at
    FROM akinator_answers
    WHERE session_id = ? AND question_id = ?
  `).get<AnswerRow>(sessionId, questionId);
}

function selectIntakeLink(database: SqliteDatabase, workspace: string, runId: string): RunIntakeRow | undefined {
  return database.prepare(`
    SELECT
      ri.run_id, ri.session_id, s.id AS session_id_join, s.workspace AS session_workspace,
      lr.workspace, ri.policy_version, ri.profile_schema_version,
      ri.profile_sources_json, ri.initial_profile_hash, ri.recommended_tags_json,
      ri.linked_at, ri.finalized_at
    FROM run_intakes AS ri
    JOIN ledger_runs AS lr ON lr.run_id = ri.run_id
    LEFT JOIN akinator_sessions AS s ON s.id = ri.session_id
    WHERE ri.run_id = ? AND lr.workspace = ?
  `).get<RunIntakeRow>(runId, workspace);
}

export function insertAkinatorSession(database: SqliteDatabase, value: unknown): AkinatorSessionView {
  const input = sessionInput(value);
  try {
    database.prepare(`
      INSERT INTO akinator_sessions (
        id, workspace, task_text, profile_json, status, question_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.workspace,
      input.task,
      canonicalJson(input.profile),
      input.status,
      input.questionCount,
      input.createdAt,
      input.updatedAt,
    );
  } catch (error) {
    return mapExpectedUniquenessFailure(error, SESSION_UNIQUENESS_FAILURES);
  }
  const row = selectSession(database, input.workspace, input.id);
  if (!row) return integrity();
  return mapSession(row);
}

export function readAkinatorSession(database: SqliteDatabase, value: unknown): AkinatorSessionView {
  const input = sessionReadInput(value);
  const row = selectSession(database, input.workspace, input.sessionId);
  if (!row) return notFoundSession();
  return mapSession(row);
}

export function updateAkinatorSession(database: SqliteDatabase, value: unknown): AkinatorSessionView {
  const input = sessionUpdateInput(value);
  const current = selectSession(database, input.workspace, input.sessionId);
  if (!current) return notFoundSession();
  const currentView = mapSession(current);
  if (currentView.status !== 'active' || currentView.questionCount !== input.expectedQuestionCount) return conflict();
  if (input.questionCount !== input.expectedQuestionCount + 1 || input.questionCount > 3) return conflict();

  database.prepare(`
    UPDATE akinator_sessions
    SET profile_json = ?, status = ?, question_count = ?, updated_at = ?
    WHERE id = ? AND workspace = ? AND status = 'active' AND question_count = ?
  `).run(
    canonicalJson(input.profile),
    input.status,
    input.questionCount,
    input.updatedAt,
    input.sessionId,
    input.workspace,
    input.expectedQuestionCount,
  );
  const changes = database.prepare('SELECT changes() AS changes').get<{ changes: unknown }>()?.changes;
  if (changes !== 1) return conflict();
  const updated = selectSession(database, input.workspace, input.sessionId);
  if (!updated) return integrity();
  return mapSession(updated);
}

export function readAkinatorAnswer(database: SqliteDatabase, value: unknown): AkinatorAnswerRecord | undefined {
  const input = answerReadInput(value);
  if (!selectSession(database, input.workspace, input.sessionId)) return notFoundSession();
  const row = selectAnswer(database, input.sessionId, input.questionId);
  return row ? mapAnswer(row) : undefined;
}

export function insertAkinatorAnswer(database: SqliteDatabase, value: unknown): { replayed: boolean; answer: AkinatorAnswerRecord } {
  const input = answerInput(value);
  if (!selectSession(database, input.workspace, input.sessionId)) return notFoundSession();
  const answerJsonValue = answerJson(input.answer);
  const existing = selectAnswer(database, input.sessionId, input.questionId);
  if (existing) {
    const answer = mapAnswer(existing);
    if (canonicalJson(answer.answer) !== answerJsonValue) return conflict();
    return { replayed: true, answer };
  }

  try {
    database.prepare(`
      INSERT INTO akinator_answers (session_id, question_id, answer_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.sessionId, input.questionId, answerJsonValue, input.createdAt);
  } catch (error) {
    return mapExpectedUniquenessFailure(error, ANSWER_UNIQUENESS_FAILURES);
  }
  const inserted = selectAnswer(database, input.sessionId, input.questionId);
  if (!inserted) return integrity();
  return { replayed: false, answer: mapAnswer(inserted) };
}

export function insertRunIntakeLink(database: SqliteDatabase, value: unknown): RunIntakeLinkView {
  const input = intakeLinkInput(value);
  const run = database.prepare('SELECT workspace FROM ledger_runs WHERE run_id = ?').get<{ workspace: unknown }>(input.runId);
  const session = database.prepare('SELECT workspace FROM akinator_sessions WHERE id = ?').get<{ workspace: unknown }>(input.sessionId);
  if (!run || !session || run.workspace !== input.workspace || session.workspace !== input.workspace) return notFoundLink();

  try {
    database.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.sessionId,
      input.policyVersion,
      input.profileSchemaVersion,
      canonicalJson(input.profileSources),
      input.initialProfileHash,
      canonicalJson(input.recommendedTags),
      input.linkedAt,
      input.finalizedAt,
    );
  } catch (error) {
    return mapExpectedUniquenessFailure(error, INTAKE_LINK_UNIQUENESS_FAILURES);
  }
  const inserted = selectIntakeLink(database, input.workspace, input.runId);
  if (!inserted) return integrity();
  return mapIntakeLink(inserted);
}

export function readRunIntakeLink(database: SqliteDatabase, value: unknown): RunIntakeLinkView {
  const input = intakeLinkReadInput(value);
  const row = selectIntakeLink(database, input.workspace, input.runId);
  if (!row) return notFoundLink();
  return mapIntakeLink(row);
}

export function finalizeRunIntakeLink(database: SqliteDatabase, value: unknown): RunIntakeLinkView {
  const input = intakeLinkFinalizeInput(value);
  const currentRow = selectIntakeLink(database, input.workspace, input.runId);
  if (!currentRow) return notFoundLink();
  const current = mapIntakeLink(currentRow);
  if (current.finalizedAt !== null) {
    if (
      current.initialProfileHash === input.profileHash
      && current.finalizedAt === input.finalizedAt
      && current.recommendedTags.length === input.recommendedTags.length
      && current.recommendedTags.every((tag, index) => tag === input.recommendedTags[index])
    ) return current;
    return conflict();
  }

  database.prepare(`
    UPDATE run_intakes
    SET initial_profile_hash = ?, recommended_tags_json = ?, finalized_at = ?
    WHERE run_id = ? AND finalized_at IS NULL
  `).run(
    input.profileHash,
    canonicalJson(input.recommendedTags),
    input.finalizedAt,
    input.runId,
  );
  const changes = database.prepare('SELECT changes() AS changes').get<{ changes: unknown }>()?.changes;
  if (changes !== 1) {
    const racedRow = selectIntakeLink(database, input.workspace, input.runId);
    if (!racedRow) return notFoundLink();
    const raced = mapIntakeLink(racedRow);
    if (
      raced.finalizedAt === input.finalizedAt
      && raced.initialProfileHash === input.profileHash
      && raced.recommendedTags.length === input.recommendedTags.length
      && raced.recommendedTags.every((tag, index) => tag === input.recommendedTags[index])
    ) return raced;
    return conflict();
  }
  const finalized = selectIntakeLink(database, input.workspace, input.runId);
  if (!finalized) return integrity();
  return mapIntakeLink(finalized);
}

/** Caller-owned primitive: mark one still-pending profile field as answered by the user. */
export function markRunIntakeProfileSource(database: SqliteDatabase, value: unknown): RunIntakeLinkView {
  const input = intakeLinkSourceInput(value);
  const currentRow = selectIntakeLink(database, input.workspace, input.runId);
  if (!currentRow) return notFoundLink();
  const current = mapIntakeLink(currentRow);
  if (current.finalizedAt !== null) return conflict();
  if (current.profileSources[input.field] === 'user_answer') return current;

  const nextSources: AkinatorProfileSources = {
    ...current.profileSources,
    [input.field]: 'user_answer',
  };
  database.prepare(`
    UPDATE run_intakes
    SET profile_sources_json = ?
    WHERE run_id = ? AND finalized_at IS NULL
  `).run(canonicalJson(nextSources), input.runId);
  const changes = database.prepare('SELECT changes() AS changes').get<{ changes: unknown }>()?.changes;
  if (changes !== 1) return conflict();
  const updated = selectIntakeLink(database, input.workspace, input.runId);
  if (!updated) return integrity();
  return mapIntakeLink(updated);
}
