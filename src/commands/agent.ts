import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { isProxy } from 'node:util/types';
import { Command } from 'commander';
import { KiokukoError } from '../errors.js';
import {
  CAPABILITY_KINDS,
  MAX_CAPABILITY_NAME_CHARS,
  MEMORY_REASONING_SKILL_NAME,
} from '../akinator/capabilities.js';
import { TASK_TYPES } from '../akinator/types.js';
import {
  CONTEXT_RANKING_COMPONENTS,
  CONTEXT_SELECTION_REASON_ORDER,
} from '../context/ranking.js';
import { RECOMMENDATION_CODES } from '../context/recommendations.js';
import { NUDGE_CODES, NUDGE_MESSAGES, NUDGE_POLICY_VERSION, NUDGE_PRIORITY } from '../context/nudges.js';
import { findSecret } from '../memory/secrets.js';
import { successEnvelope } from '../serialization/envelope.js';
import {
  cloneBoundaryJson as cloneStrictBoundaryJson,
  stringifyBoundaryJson,
  type BoundaryJsonValue,
} from '../serialization/boundary-json.js';
import {
  AGENT_MUTATION_OPERATIONS,
  agentRequestBindingHash,
  type AgentMutationOperation,
} from '../server/routes/request-binding.js';
import { MAX_STRICT_JSON_DEPTH, parseStrictJson } from '../setup/strict-json.js';
import {
  createServerClient,
  type CreateServerClientOptions,
  type FetchImplementation,
  type ServerClient,
  type ServerRequest,
} from '../client/server-client.js';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_ID_BYTES = 256;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_INPUT_PATH_BYTES = 4 * 1024;
const MAX_JSON_NODES = 262_144;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const UNSAFE_CAPABILITY_LABEL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const CAPTURE_PROFILES = new Set(['minimal', 'standard', 'full']);

type AgentCaptureProfile = 'minimal' | 'standard' | 'full';
type JsonValue = BoundaryJsonValue;

export interface AgentCommandDependencies {
  readonly createClient?: (options?: CreateServerClientOptions) => Promise<ServerClient>;
  readonly fetchImplementation?: FetchImplementation;
  readonly idempotencyKeyFactory?: () => string;
  readonly readJsonInput?: (filePath: string) => Promise<unknown>;
  readonly closeInputFile?: (handle: FileHandle) => Promise<void>;
}

function validationError(): KiokukoError {
  return new KiokukoError('VALIDATION_ERROR', 'Agent input is invalid');
}

function boundedString(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes || CONTROL_CHARACTERS.test(value)) {
    throw validationError();
  }
  return value;
}

function boundedId(value: unknown): string {
  return boundedString(value, MAX_ID_BYTES);
}

function boundedIdempotencyKey(value: unknown): string {
  const key = boundedString(value, MAX_ID_BYTES);
  if (key.trim() !== key) throw validationError();
  return key;
}

function cloneBoundaryJson(
  value: unknown,
  failure: () => KiokukoError,
): JsonValue {
  return cloneStrictBoundaryJson(value, {
    failure,
    maximumDepth: MAX_STRICT_JSON_DEPTH,
    maximumNodes: MAX_JSON_NODES,
    maximumStringBytes: MAX_INPUT_BYTES,
  });
}

function inputJson(value: unknown): JsonValue {
  return cloneBoundaryJson(value, validationError);
}

function inputObject(value: unknown): Record<string, unknown> {
  const cloned = inputJson(value);
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) throw validationError();
  return cloned;
}

function validateInputPath(value: unknown): string {
  if (value === '-') return value;
  return boundedString(value, MAX_INPUT_PATH_BYTES);
}

async function readStdinBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
    size += bytes.byteLength;
    if (size > MAX_INPUT_BYTES) throw validationError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

const INPUT_FILESYSTEM_ERROR_CODES = new Set([
  'EACCES', 'EIO', 'EISDIR', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOTDIR', 'EPERM',
]);

function isInputFilesystemError(error: unknown): boolean {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null || isProxy(error)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor
    && typeof descriptor.value === 'string'
    && INPUT_FILESYSTEM_ERROR_CODES.has(descriptor.value);
}

function isExactAgentKiokukoError(error: unknown): error is KiokukoError {
  return typeof error === 'object' && error !== null && !isProxy(error)
    && Object.getPrototypeOf(error) === KiokukoError.prototype;
}

async function readBoundedRegularFile(
  filePath: string,
  closeHandle: (handle: FileHandle) => Promise<void>,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (isInputFilesystemError(error)) throw validationError();
    throw error;
  }
  let operationResult: Buffer | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 0
      || metadata.size > MAX_INPUT_BYTES) throw validationError();
    const bytes = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_INPUT_BYTES) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0) {
        operationResult = bytes.subarray(0, offset);
        break;
      }
      offset += result.bytesRead;
      if (offset > MAX_INPUT_BYTES) throw validationError();
    }
  } catch (error) {
    operationFailed = true;
    operationError = isExactAgentKiokukoError(error) && error.code === 'VALIDATION_ERROR'
      ? error
      : isInputFilesystemError(error)
        ? validationError()
        : error;
  }
  try {
    await closeHandle(handle);
  } catch (closeError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        'Agent input read failed and its file descriptor could not be closed',
      );
    }
    throw closeError;
  }
  if (operationFailed) throw operationError;
  if (operationResult === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Agent input read produced no result');
  }
  return operationResult;
}

async function readStrictJsonInput(
  filePath: string,
  closeHandle: (handle: FileHandle) => Promise<void>,
): Promise<unknown> {
  const safePath = validateInputPath(filePath);
  let bytes: Buffer;
  if (safePath === '-') {
    bytes = await readStdinBytes();
  } else {
    bytes = await readBoundedRegularFile(safePath, closeHandle);
  }
  if (bytes.byteLength > MAX_INPUT_BYTES) throw validationError();

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw validationError();
  }
  try {
    return parseStrictJson(
      text,
      { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
      'Agent input is not valid JSON with unique keys',
    );
  } catch (error) {
    if (isExactAgentKiokukoError(error) && error.code === 'VALIDATION_ERROR') throw validationError();
    throw error;
  }
}

function captureProfile(value: unknown): AgentCaptureProfile {
  if (typeof value !== 'string' || !CAPTURE_PROFILES.has(value)) throw validationError();
  return value as AgentCaptureProfile;
}

function transportCaptureProfile(value: AgentCaptureProfile): 'minimal' | 'standard' | 'diagnostic' {
  return value === 'full' ? 'diagnostic' : value;
}

function runPath(runId: unknown, suffix: string): string {
  const id = boundedId(runId);
  if (id === '.' || id === '..' || id.includes('/') || id.includes('\\')) throw validationError();
  const encoded = encodeURIComponent(id);
  const path = `/api/v1/agent/runs/${encoded}/${suffix}`;
  if (Buffer.byteLength(path, 'utf8') > MAX_INPUT_PATH_BYTES) throw validationError();
  return path;
}

function keyFromFactory(dependencies: AgentCommandDependencies): string {
  const factory = dependencies.idempotencyKeyFactory ?? randomUUID;
  return boundedIdempotencyKey(factory());
}

function requestIdempotencyKey(value: unknown, dependencies: AgentCommandDependencies): string {
  return value === undefined ? keyFromFactory(dependencies) : boundedIdempotencyKey(value);
}

function bodyAndKey(value: Record<string, unknown>, dependencies: AgentCommandDependencies): {
  body: Record<string, unknown>;
  idempotencyKey: string;
} {
  if (Object.prototype.hasOwnProperty.call(value, 'idempotencyKey')) {
    const idempotencyKey = boundedIdempotencyKey(value.idempotencyKey);
    const { idempotencyKey: _removed, ...body } = value;
    return { body, idempotencyKey };
  }
  return { body: value, idempotencyKey: keyFromFactory(dependencies) };
}

async function readInput(dependencies: AgentCommandDependencies, filePath: string): Promise<Record<string, unknown>> {
  return inputObject(await readUnknownInput(dependencies, filePath));
}

async function readUnknownInput(dependencies: AgentCommandDependencies, filePath: string): Promise<unknown> {
  return dependencies.readJsonInput === undefined
    ? readStrictJsonInput(filePath, dependencies.closeInputFile ?? ((handle) => handle.close()))
    : dependencies.readJsonInput(validateInputPath(filePath));
}

async function readCapabilityCatalog(dependencies: AgentCommandDependencies, filePath: string): Promise<unknown[]> {
  const value = inputJson(await readUnknownInput(dependencies, filePath));
  if (!Array.isArray(value)) throw validationError();
  return value;
}

async function getClient(dependencies: AgentCommandDependencies): Promise<ServerClient> {
  const factory = dependencies.createClient ?? createServerClient;
  const options: CreateServerClientOptions = dependencies.fetchImplementation === undefined
    ? {}
    : { fetchImplementation: dependencies.fetchImplementation };
  return factory(options);
}

function runIdFromRequestPath(path: string): string | undefined {
  const match = /^\/api\/v1\/agent\/runs\/([^/]+)\/(?:intake\/answers|events|checkpoints|close|feedback)$/u.exec(path);
  if (match?.[1] === undefined) return undefined;
  return decodeURIComponent(match[1]);
}

interface AgentResponseBinding {
  readonly operation: AgentMutationOperation;
  readonly expectedRunId: string | undefined;
  readonly requestBody: Record<string, JsonValue>;
  readonly idempotencyKey: string;
}

function responseBindingForRequest(request: ServerRequest): AgentResponseBinding {
  if (!AGENT_MUTATION_OPERATIONS.includes(request.operation as AgentMutationOperation)) {
    throw new TypeError('Agent request operation is invalid');
  }
  const requestBody = inputObject(request.body) as Record<string, JsonValue>;
  return {
    operation: request.operation as AgentMutationOperation,
    expectedRunId: runIdFromRequestPath(request.path),
    requestBody,
    idempotencyKey: boundedIdempotencyKey(request.idempotencyKey),
  };
}

async function sendRequest(dependencies: AgentCommandDependencies, request: ServerRequest): Promise<Record<string, unknown>> {
  const binding = responseBindingForRequest(request);
  if (request.operation !== 'agent.open' && binding.expectedRunId === undefined) {
    throw new TypeError('Agent request path is not bound to a run');
  }
  const response = await (await getClient(dependencies)).request(request);
  return validateAgentResponse(binding.operation, response, binding);
}

function responseIntegrityError(): KiokukoError {
  return new KiokukoError('INTEGRITY_ERROR', 'Agent server response is invalid');
}

function responseObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw responseIntegrityError();
  const object = value as Record<string, JsonValue>;
  const keys = Object.keys(object);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(object, key))) {
    throw responseIntegrityError();
  }
  return object;
}

function responseArray(value: unknown, maximum: number): JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) throw responseIntegrityError();
  return value;
}

function responseString(value: unknown, maximumBytes = MAX_INPUT_BYTES, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw responseIntegrityError();
  return value;
}

function responseIdentifier(value: unknown): string {
  const result = responseString(value, MAX_INPUT_BYTES);
  if (result.length > MAX_ID_BYTES || CONTROL_CHARACTERS.test(result)) throw responseIntegrityError();
  return result;
}

function responseEventId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0
    || value.length > MAX_ID_BYTES || value.includes('\u0000')) throw responseIntegrityError();
  return value;
}

function responseEnum(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw responseIntegrityError();
  return value;
}

function responseInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw responseIntegrityError();
  }
  return value;
}

function responseHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw responseIntegrityError();
  return value;
}

function validateRequestBindingHash(object: Record<string, JsonValue>, binding: AgentResponseBinding): void {
  const actual = responseHash(object.requestBindingHash);
  const expected = agentRequestBindingHash({
    operation: binding.operation,
    pathRunId: binding.expectedRunId ?? null,
    idempotencyKey: binding.idempotencyKey,
    requestBody: binding.requestBody,
  });
  if (actual !== expected) throw responseIntegrityError();
}

function responseTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw responseIntegrityError();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw responseIntegrityError();
  return value;
}

function responseStringArray(
  value: unknown,
  maximum: number,
  allowed?: readonly string[],
): string[] {
  const items = responseArray(value, maximum).map((item) => responseString(item, MAX_TEXT_BYTES));
  if (new Set(items).size !== items.length || (allowed !== undefined && items.some((item) => !allowed.includes(item)))) {
    throw responseIntegrityError();
  }
  return items;
}

function sameResponseValue(left: unknown, right: unknown): boolean {
  return stringifyBoundaryJson(cloneBoundaryJson(left, responseIntegrityError))
    === stringifyBoundaryJson(cloneBoundaryJson(right, responseIntegrityError));
}

const PROFILE_FIELDS = ['taskType', 'target', 'expected', 'constraints'] as const;
const INTAKE_STATUSES = ['needs_answer', 'ready', 'exhausted'] as const;
const ACTIVE_RUN_STATUSES = ['intake', 'active'] as const;
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;
const CAPABILITY_AVAILABILITIES = ['known-empty', 'known-nonempty', 'unknown'] as const;
const CAPABILITY_RECOMMENDATION_AVAILABILITIES = ['available', 'missing', 'unknown'] as const;
const COVERAGE_FIELDS = ['run', 'tool', 'command', 'file', 'approval'] as const;
const COVERAGE_LEVELS = ['complete', 'best_effort', 'declared', 'unavailable'] as const;
const CAPABILITY_WARNING_CODES = [
  'CAPABILITY_CATALOG_COMPACTED',
  'CAPABILITY_CATALOG_ITEMS_DROPPED',
  'CAPABILITY_CATALOG_BUDGET_EXCEEDED',
  'CAPABILITY_CATALOG_UNAVAILABLE',
] as const;

function validateTaskProfileSchema(value: unknown, withSource = false): Record<string, JsonValue> {
  const object = responseObject(value, withSource ? [...PROFILE_FIELDS, 'source'] : PROFILE_FIELDS);
  if (object.taskType !== null) responseEnum(object.taskType, TASK_TYPES);
  for (const field of ['target', 'expected', 'constraints'] as const) {
    if (object[field] !== null) responseString(object[field], MAX_INPUT_BYTES, true);
  }
  if (withSource && object.source !== 'akinator+ledger-revisions') throw responseIntegrityError();
  return object;
}

function validateQuestion(value: unknown): Record<string, JsonValue> | null {
  if (value === null) return null;
  const object = responseObject(value, ['id', 'prompt', 'options', 'required']);
  responseEnum(object.id, PROFILE_FIELDS);
  responseString(object.prompt, MAX_TEXT_BYTES);
  if (object.options !== null) responseStringArray(object.options, 100);
  if (typeof object.required !== 'boolean') throw responseIntegrityError();
  return object;
}

function validateCapabilityWarnings(value: unknown): JsonValue[] {
  const warnings = responseArray(value, CAPABILITY_WARNING_CODES.length);
  const seen = new Set<string>();
  for (const warning of warnings) {
    const object = responseObject(warning, ['code', 'message']);
    const code = responseEnum(object.code, CAPABILITY_WARNING_CODES);
    responseString(object.message, MAX_TEXT_BYTES);
    if (seen.has(code)) throw responseIntegrityError();
    seen.add(code);
  }
  return warnings;
}

function validateCapabilityRecommendations(value: unknown): JsonValue[] {
  const recommendations = responseArray(value, 205);
  for (const recommendation of recommendations) {
    const object = responseObject(
      recommendation,
      ['kind', 'name', 'availability', 'reason', 'source'],
      ['required'],
    );
    responseEnum(object.kind, CAPABILITY_KINDS);
    const name = responseString(object.name, MAX_INPUT_BYTES);
    if (Array.from(name).length > MAX_CAPABILITY_NAME_CHARS
      || name.trim() !== name || UNSAFE_CAPABILITY_LABEL_CHARACTERS.test(name)) throw responseIntegrityError();
    responseEnum(object.availability, CAPABILITY_RECOMMENDATION_AVAILABILITIES);
    responseString(object.reason, MAX_TEXT_BYTES);
    responseEnum(object.source, ['akinator_policy', 'catalog_similarity']);
    if (Object.hasOwn(object, 'required') && typeof object.required !== 'boolean') throw responseIntegrityError();
  }
  return recommendations;
}

function validateCapabilities(value: unknown): Record<string, JsonValue> {
  const object = responseObject(value, [
    'availability', 'catalogProvided', 'availableSkillCount', 'diagnostics', 'warnings', 'recommendations',
  ]);
  const availability = responseEnum(object.availability, CAPABILITY_AVAILABILITIES);
  if (typeof object.catalogProvided !== 'boolean' || object.catalogProvided !== (availability !== 'unknown')) {
    throw responseIntegrityError();
  }
  if (availability === 'unknown') {
    if (object.availableSkillCount !== null) throw responseIntegrityError();
  } else {
    responseInteger(object.availableSkillCount);
  }
  const diagnostics = responseObject(object.diagnostics, ['received', 'accepted', 'truncated', 'dropped']);
  for (const field of ['received', 'accepted', 'truncated', 'dropped']) responseInteger(diagnostics[field]);
  if ((diagnostics.accepted as number) > (diagnostics.received as number)
    || (diagnostics.truncated as number) > (diagnostics.accepted as number)) throw responseIntegrityError();
  validateCapabilityWarnings(object.warnings);
  validateCapabilityRecommendations(object.recommendations);
  return object;
}

function validateContextRecommendation(value: unknown): Record<string, JsonValue> {
  const object = responseObject(value, [
    'code', 'message', 'evidenceEventIds', 'priority', 'untrusted', 'actionable', 'metadata',
  ]);
  responseEnum(object.code, RECOMMENDATION_CODES);
  responseString(object.message, MAX_TEXT_BYTES);
  responseInteger(object.priority, 1, RECOMMENDATION_CODES.length);
  if (object.untrusted !== true
    || object.actionable !== false) throw responseIntegrityError();
  responseStringArray(object.evidenceEventIds, 16);
  const metadata = responseObject(object.metadata, ['truncated', 'referenceIds'], ['incompleteCoverageCategories']);
  if (typeof metadata.truncated !== 'boolean') throw responseIntegrityError();
  responseStringArray(metadata.referenceIds, 16);
  if (Object.hasOwn(metadata, 'incompleteCoverageCategories')) {
    responseStringArray(metadata.incompleteCoverageCategories, COVERAGE_FIELDS.length, COVERAGE_FIELDS);
  }
  return object;
}

function validateContextRecommendations(value: unknown): JsonValue[] {
  const recommendations = responseArray(value, RECOMMENDATION_CODES.length);
  const codes = new Set<string>();
  for (const recommendation of recommendations) {
    const object = validateContextRecommendation(recommendation);
    const code = object.code as string;
    if (codes.has(code)) throw responseIntegrityError();
    codes.add(code);
  }
  return recommendations;
}

function validateNudge(value: unknown): Record<string, JsonValue> | null {
  if (value === null) return null;
  const object = responseObject(value, [
    'occurrenceId', 'code', 'message', 'evidenceEventIds', 'referenceIds', 'priority', 'policyVersion',
  ]);
  const code = responseEnum(object.code, NUDGE_CODES) as typeof NUDGE_CODES[number];
  responseIdentifier(object.occurrenceId);
  responseStringArray(object.evidenceEventIds, 16);
  responseStringArray(object.referenceIds, 16);
  if (object.policyVersion !== NUDGE_POLICY_VERSION
    || object.message !== NUDGE_MESSAGES[code]
    || object.priority !== NUDGE_PRIORITY[code]) {
    throw responseIntegrityError();
  }
  return object;
}

function validateScoreComponentsSchema(value: unknown): void {
  const score = responseObject(value, CONTEXT_RANKING_COMPONENTS);
  for (const field of CONTEXT_RANKING_COMPONENTS) {
    if (typeof score[field] !== 'number' || !Number.isSafeInteger(score[field])
      || (score[field] as number) < -1_000_000 || (score[field] as number) > 1_000_000) {
      throw responseIntegrityError();
    }
  }
}

function validateContextSchema(value: unknown): Record<string, JsonValue> | null {
  if (value === null) return null;
  const object = responseObject(value, [
    'deliveryId', 'runId', 'throughSequence', 'taskProfileHash', 'queryHash', 'policyVersion', 'items', 'untrusted',
  ]);
  if (object.deliveryId !== null) responseIdentifier(object.deliveryId);
  responseIdentifier(object.runId);
  responseInteger(object.throughSequence);
  responseHash(object.taskProfileHash);
  responseHash(object.queryHash);
  if (object.policyVersion !== 'context-ranking-v1+recommendations.v1' || object.untrusted !== true) {
    throw responseIntegrityError();
  }
  const items = responseArray(object.items, 100);
  const entryIds = new Set<string>();
  for (const value of items) {
    const item = responseObject(value, [
      'entryId', 'entryRevision', 'rank', 'scoreComponents', 'selectionReasons', 'content', 'untrusted',
    ], ['origin']);
    const entryId = responseIdentifier(item.entryId);
    if (entryIds.has(entryId)) throw responseIntegrityError();
    entryIds.add(entryId);
    responseInteger(item.entryRevision, 1);
    responseInteger(item.rank, 1);
    if (item.untrusted !== true) throw responseIntegrityError();
    validateScoreComponentsSchema(item.scoreComponents);
    const selectionReasons = responseStringArray(
      item.selectionReasons,
      CONTEXT_SELECTION_REASON_ORDER.length,
      CONTEXT_SELECTION_REASON_ORDER,
    );
    if (selectionReasons.length === 0) throw responseIntegrityError();
    const content = responseObject(item.content, ['title', 'summary', 'bodyPreview', 'characterCount', 'truncated']);
    responseString(content.title, MAX_INPUT_BYTES, true);
    if (content.summary !== null) responseString(content.summary, MAX_INPUT_BYTES, true);
    responseString(content.bodyPreview, MAX_INPUT_BYTES, true);
    responseInteger(content.characterCount);
    if (typeof content.truncated !== 'boolean') throw responseIntegrityError();
    if (Object.hasOwn(item, 'origin')) responseEnum(item.origin, ['project', 'ecosystem', 'global']);
  }
  return object;
}

interface ValidatedAck {
  readonly acceptedThrough: number;
  readonly localSequences: number[];
  readonly sourceSequences: Array<number | null>;
  readonly eventIds: string[];
}

interface ExpectedEventAck {
  readonly sourceSequences: Array<number | null>;
  readonly eventIds: Array<string | undefined>;
}

function preservedEventId(value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  responseIdentifier(value);
  return /^[A-Za-z0-9._:-]+$/u.test(value) && findSecret(value) === undefined ? value : undefined;
}

function validateAckFields(object: Record<string, JsonValue>): ValidatedAck {
  responseIdentifier(object.runId);
  const acceptedThrough = responseInteger(object.acceptedThrough, 1);
  const localSequences = responseArray(object.localSequences, 200).map((value) => responseInteger(value, 1));
  const sourceSequences = responseArray(object.sourceSequences, 200).map((value) => value === null ? null : responseInteger(value));
  const eventIds = responseArray(object.eventIds, 200).map(responseEventId);
  if (new Set(eventIds).size !== eventIds.length) throw responseIntegrityError();
  if (localSequences.length === 0 || localSequences.length !== sourceSequences.length || localSequences.length !== eventIds.length
    || new Set(localSequences).size !== localSequences.length
    || localSequences.some((sequence, index) => index > 0 && sequence <= (localSequences[index - 1] as number))
    || localSequences.at(-1) !== acceptedThrough) throw responseIntegrityError();
  return { acceptedThrough, localSequences, sourceSequences, eventIds };
}

function expectedEventAck(value: unknown): ExpectedEventAck {
  const events = responseArray(value, 200);
  if (events.length === 0) throw responseIntegrityError();
  const sourceSequences: Array<number | null> = [];
  const eventIds: Array<string | undefined> = [];
  for (const event of events) {
    const object = responseObject(event, ['eventType', 'actor', 'payload'], [
      'eventId', 'sourceEventId', 'sourceSequence', 'sourceType', 'outcome', 'occurredAt',
    ]);
    // The gateway sanitizes event identifiers before persistence, and the CLI
    // does not know the run workspace required to reproduce that transform.
    // Bind the count/order/source sequence here; the response schema still
    // requires unique, bounded event IDs.
    eventIds.push(preservedEventId(object.eventId));
    sourceSequences.push(Object.hasOwn(object, 'sourceSequence')
      ? responseInteger(object.sourceSequence)
      : null);
  }
  return { sourceSequences, eventIds };
}

function validateExpectedAck(ack: ValidatedAck, expected: ExpectedEventAck, exactCardinality = true): void {
  const orderedSources = (values: Array<number | null>): Array<number | null> => [...values]
    .sort((left, right) => left === null ? (right === null ? 0 : -1) : right === null ? 1 : left - right);
  const explicitIds = expected.eventIds.filter((value): value is string => value !== undefined);
  if (new Set(explicitIds).size !== explicitIds.length
    || (exactCardinality && ack.sourceSequences.length !== expected.sourceSequences.length)
    || (!exactCardinality && ack.sourceSequences.length < expected.sourceSequences.length)) {
    throw responseIntegrityError();
  }
  if (exactCardinality
    && !sameResponseValue(orderedSources(ack.sourceSequences), orderedSources(expected.sourceSequences))) {
    throw responseIntegrityError();
  }
  if (!exactCardinality) {
    const remaining = [...ack.sourceSequences];
    for (const source of expected.sourceSequences) {
      const index = remaining.indexOf(source);
      if (index < 0) throw responseIntegrityError();
      remaining.splice(index, 1);
    }
  }
  for (let expectedIndex = 0; expectedIndex < expected.eventIds.length; expectedIndex += 1) {
    const expectedId = expected.eventIds[expectedIndex];
    if (expectedId === undefined) continue;
    let actualIndex = -1;
    for (let index = 0; index < ack.eventIds.length; index += 1) {
      if (ack.eventIds[index] === expectedId) {
        actualIndex = index;
        break;
      }
    }
    if (actualIndex < 0 || ack.sourceSequences[actualIndex] !== expected.sourceSequences[expectedIndex]) {
      throw responseIntegrityError();
    }
  }
}

function validateAppendResponse(value: JsonValue, binding: AgentResponseBinding): Record<string, JsonValue> {
  const object = responseObject(value, [
    'runId', 'acceptedThrough', 'localSequences', 'sourceSequences', 'eventIds', 'runStatus', 'untrusted',
    'requestBindingHash',
  ]);
  validateRequestBindingHash(object, binding);
  const ack = validateAckFields(object);
  if (object.runId !== binding.expectedRunId) throw responseIntegrityError();
  const request = responseObject(binding.requestBody, ['apiVersion', 'events']);
  if (request.apiVersion !== '1') throw responseIntegrityError();
  responseEnum(object.runStatus, ACTIVE_RUN_STATUSES);
  const expected = expectedEventAck(request.events);
  validateExpectedAck(ack, expected);
  if (object.untrusted !== true) throw responseIntegrityError();
  return object;
}

function validateCloseResponse(value: JsonValue, binding: AgentResponseBinding): Record<string, JsonValue> {
  const object = responseObject(value, [
    'runId', 'acceptedThrough', 'localSequences', 'sourceSequences', 'eventIds',
    'status', 'runStatus', 'untrusted', 'requestBindingHash',
  ]);
  validateRequestBindingHash(object, binding);
  const ack = validateAckFields(object);
  if (object.runId !== binding.expectedRunId) throw responseIntegrityError();
  const request = responseObject(binding.requestBody, ['apiVersion', 'status'], ['events']);
  if (request.apiVersion !== '1') throw responseIntegrityError();
  if (Object.hasOwn(request, 'events')) {
    const expected = expectedEventAck(request.events);
    if (ack.eventIds.length !== expected.eventIds.length + 1) throw responseIntegrityError();
    validateExpectedAck(ack, expected, false);
  } else if (ack.eventIds.length !== 1) {
    throw responseIntegrityError();
  }
  const status = responseEnum(object.status, TERMINAL_RUN_STATUSES);
  if (status !== request.status || object.runStatus !== status || object.untrusted !== true) throw responseIntegrityError();
  return object;
}

function validateCoverage(value: unknown): Record<string, JsonValue> {
  const object = responseObject(value, COVERAGE_FIELDS);
  for (const field of COVERAGE_FIELDS) responseEnum(object[field], COVERAGE_LEVELS);
  return object;
}

function validateProjectionSchema(value: unknown): Record<string, JsonValue> {
  const object = responseObject(value, [
    'throughSequence', 'taskProfile', 'profileHash', 'evidenceState', 'unresolvedFailureEventIds',
    'unknownOutcomeEventIds', 'latestMutationSequence', 'latestPassingVerificationSequence', 'coverage',
    'declaredCoverage', 'intakeIncomplete', 'missingProfileFields',
  ], ['latestMutationEventIds', 'latestPassingVerificationEventIds']);
  responseInteger(object.throughSequence);
  validateTaskProfileSchema(object.taskProfile);
  responseHash(object.profileHash);
  responseEnum(object.evidenceState, ['none', 'failed', 'fresh', 'stale']);
  responseArray(object.unresolvedFailureEventIds, 4096).forEach(responseEventId);
  responseArray(object.unknownOutcomeEventIds, 4096).forEach(responseEventId);
  if (Object.hasOwn(object, 'latestMutationEventIds')) responseArray(object.latestMutationEventIds, 16).forEach(responseEventId);
  if (Object.hasOwn(object, 'latestPassingVerificationEventIds')) responseArray(object.latestPassingVerificationEventIds, 16).forEach(responseEventId);
  for (const field of ['latestMutationSequence', 'latestPassingVerificationSequence'] as const) {
    if (object[field] !== null) responseInteger(object[field], 1);
  }
  responseEnum(object.coverage, ['complete', 'partial']);
  validateCoverage(object.declaredCoverage);
  if (typeof object.intakeIncomplete !== 'boolean') throw responseIntegrityError();
  const projectionMissingFields = ['taskType', 'target', 'expected'] as const;
  responseStringArray(
    object.missingProfileFields,
    projectionMissingFields.length,
    projectionMissingFields,
  );
  return object;
}

interface ValidatedCapabilityGate {
  readonly nextAction: string;
  readonly memoryContextWithheld: boolean;
}

interface ValidatedMemoryPolicy {
  readonly memoryReasoningRequired: boolean;
  readonly contextWithheld: boolean;
  readonly withheldReason: 'memory_reasoning_missing' | 'memory_reasoning_unknown' | null;
  readonly deliveryEmpty?: true;
  readonly storedEntryCount?: number;
}

function validateCapabilityGate(
  object: Record<string, JsonValue>,
  intakeNeedsAnswer: boolean,
  memoryPolicy: ValidatedMemoryPolicy,
): ValidatedCapabilityGate {
  const capabilities = validateCapabilities(object.capabilities);
  const warnings = validateCapabilityWarnings(object.warnings);
  if (!sameResponseValue(warnings, capabilities.warnings)) throw responseIntegrityError();
  validateContextRecommendations(object.recommendations);
  const nextAction = responseEnum(object.nextAction, [
    'proceed', 'answer_from_evidence_or_ask_user', 'required_capability_unavailable',
  ]);
  const capabilityRecommendations = capabilities.recommendations as JsonValue[];
  const required = capabilityRecommendations.filter((recommendation) => (
    (recommendation as Record<string, JsonValue>).required === true
  )) as Array<Record<string, JsonValue>>;
  if (required.some((recommendation) => recommendation.source !== 'akinator_policy')) {
    throw responseIntegrityError();
  }
  const memoryRecommendations = capabilityRecommendations.filter((recommendation) => (
    (recommendation as Record<string, JsonValue>).name === MEMORY_REASONING_SKILL_NAME
  )) as Array<Record<string, JsonValue>>;
  let memoryAvailability: JsonValue | undefined;
  if (memoryPolicy.memoryReasoningRequired) {
    if (memoryRecommendations.length !== 1) throw responseIntegrityError();
    const memory = memoryRecommendations[0] as Record<string, JsonValue>;
    if (memory.kind !== 'skill' || memory.name !== MEMORY_REASONING_SKILL_NAME
      || memory.source !== 'akinator_policy' || memory.required !== true) throw responseIntegrityError();
    memoryAvailability = memory.availability;
  } else if (memoryRecommendations.length !== 0) {
    throw responseIntegrityError();
  }
  const expectedMemoryContextWithheld = memoryPolicy.memoryReasoningRequired
    && memoryAvailability !== 'available';
  const expectedWithheldReason = memoryAvailability === 'missing'
    ? 'memory_reasoning_missing'
    : memoryAvailability === 'unknown'
      ? 'memory_reasoning_unknown'
      : null;
  if (memoryPolicy.contextWithheld !== expectedMemoryContextWithheld
    || memoryPolicy.withheldReason !== (expectedMemoryContextWithheld ? expectedWithheldReason : null)) {
    throw responseIntegrityError();
  }
  const hasBlockingRequiredCapability = required.some((recommendation) => (
    recommendation.name !== MEMORY_REASONING_SKILL_NAME
      && recommendation.availability !== 'available'
  ));
  const expectedAction = intakeNeedsAnswer
    ? 'answer_from_evidence_or_ask_user'
    : hasBlockingRequiredCapability
      ? 'required_capability_unavailable'
      : 'proceed';
  if (nextAction !== expectedAction) throw responseIntegrityError();
  if (nextAction === 'required_capability_unavailable'
    && (object.context !== null || (object.recommendations as JsonValue[]).length !== 0)) throw responseIntegrityError();
  return {
    nextAction,
    memoryContextWithheld: memoryPolicy.contextWithheld,
  };
}

function validateMemoryPolicy(value: unknown): ValidatedMemoryPolicy {
  const policy = responseObject(
    value,
    ['memoryReasoningRequired', 'contextWithheld', 'withheldReason'],
    ['deliveryEmpty', 'storedEntryCount'],
  );
  if (typeof policy.memoryReasoningRequired !== 'boolean') throw responseIntegrityError();
  if (typeof policy.contextWithheld !== 'boolean') throw responseIntegrityError();
  const withheldReason = policy.withheldReason === null
    ? null
    : responseEnum(policy.withheldReason, [
      'memory_reasoning_missing', 'memory_reasoning_unknown',
    ]) as ValidatedMemoryPolicy['withheldReason'];
  if (!policy.memoryReasoningRequired && (policy.contextWithheld || withheldReason !== null)) {
    throw responseIntegrityError();
  }
  if (policy.contextWithheld !== (withheldReason !== null)) throw responseIntegrityError();
  const hasDeliveryEmpty = Object.hasOwn(policy, 'deliveryEmpty');
  const hasStoredEntryCount = Object.hasOwn(policy, 'storedEntryCount');
  if (hasDeliveryEmpty !== hasStoredEntryCount || (hasDeliveryEmpty && policy.deliveryEmpty !== true)) {
    throw responseIntegrityError();
  }
  let storedEntryCount: number | undefined;
  if (hasStoredEntryCount) {
    storedEntryCount = responseInteger(policy.storedEntryCount, 1);
  }
  return {
    memoryReasoningRequired: policy.memoryReasoningRequired,
    contextWithheld: policy.contextWithheld,
    withheldReason,
    ...(storedEntryCount === undefined ? {} : { deliveryEmpty: true, storedEntryCount }),
  };
}

function validateMemoryDeliveryObservation(
  policy: ValidatedMemoryPolicy,
  context: Record<string, JsonValue> | null,
  intakeNeedsAnswer: boolean,
): void {
  if (policy.deliveryEmpty !== true) return;
  if (intakeNeedsAnswer) throw responseIntegrityError();
  if (context !== null && responseArray(context.items, 100).length > 0) throw responseIntegrityError();
}

function validateIntakeResponse(value: JsonValue, binding: AgentResponseBinding): Record<string, JsonValue> {
  const object = responseObject(value, [
    'runId', 'runStatus', 'intakeSessionId', 'intakeStatus', 'intake', 'question', 'currentQuestion',
    'missingFields', 'recommendedTags', 'taskProfile', 'profileHash', 'context', 'untrusted',
    'recommendations', 'capabilities', 'memoryPolicy', 'warnings', 'nextAction', 'requestBindingHash',
  ]);
  validateRequestBindingHash(object, binding);
  const runId = responseIdentifier(object.runId);
  if (binding.expectedRunId !== undefined && runId !== binding.expectedRunId) throw responseIntegrityError();
  const runStatus = responseEnum(object.runStatus, ACTIVE_RUN_STATUSES);
  const intakeSessionId = responseIdentifier(object.intakeSessionId);
  const intakeStatus = responseEnum(object.intakeStatus, INTAKE_STATUSES);
  const intake = responseObject(object.intake, ['status', 'sessionId', 'question']);
  const question = validateQuestion(object.question);
  const currentQuestion = validateQuestion(object.currentQuestion);
  if (intake.status !== intakeStatus || intake.sessionId !== intakeSessionId
    || !sameResponseValue(intake.question, question) || !sameResponseValue(currentQuestion, question)) {
    throw responseIntegrityError();
  }
  validateTaskProfileSchema(object.taskProfile);
  const requiredProfileFields = ['taskType', 'target', 'expected'] as const;
  responseStringArray(
    object.missingFields,
    requiredProfileFields.length,
    requiredProfileFields,
  );
  responseStringArray(object.recommendedTags, 10);
  const needsAnswer = intakeStatus === 'needs_answer';
  if (needsAnswer) {
    if (runStatus !== 'intake' || question === null || object.profileHash !== null || object.context !== null) {
      throw responseIntegrityError();
    }
    if ((object.recommendations as JsonValue[]).length !== 0) throw responseIntegrityError();
  } else {
    if (runStatus !== 'active' || question !== null) throw responseIntegrityError();
    responseHash(object.profileHash);
  }
  if (object.untrusted !== true) throw responseIntegrityError();
  const context = needsAnswer ? null : validateContextSchema(object.context);
  if (context !== null && (context.runId !== runId || context.taskProfileHash !== object.profileHash)) {
    throw responseIntegrityError();
  }
  const memoryPolicy = validateMemoryPolicy(object.memoryPolicy);
  validateMemoryDeliveryObservation(memoryPolicy, context, needsAnswer);
  const capabilityGate = validateCapabilityGate(object, needsAnswer, memoryPolicy);
  if (!needsAnswer) {
    if (capabilityGate.nextAction === 'proceed' && context === null && !capabilityGate.memoryContextWithheld) {
      throw responseIntegrityError();
    }
  }
  return object;
}

function checkpointExpectedAck(body: Record<string, JsonValue>): ExpectedEventAck | undefined {
  return Object.hasOwn(body, 'events') ? expectedEventAck(body.events) : undefined;
}

function validateCheckpointResponse(value: JsonValue, binding: AgentResponseBinding): Record<string, JsonValue> {
  const object = responseObject(value, [
    'runId', 'acceptedThrough', 'localSequences', 'sourceSequences', 'eventIds', 'runStatus', 'intakeStatus',
    'taskProfile', 'profileHash', 'projection', 'recommendations', 'characterBudget', 'context', 'untrusted',
    'capabilities', 'memoryPolicy', 'warnings', 'nextAction', 'requestBindingHash',
  ], ['nudge']);
  validateRequestBindingHash(object, binding);
  const ack = validateAckFields(object);
  const expectedAck = checkpointExpectedAck(binding.requestBody);
  const runId = responseIdentifier(object.runId);
  if (runId !== binding.expectedRunId) throw responseIntegrityError();
  if (expectedAck !== undefined) validateExpectedAck(ack, expectedAck, false);
  if (object.runStatus !== 'active') throw responseIntegrityError();
  responseEnum(object.intakeStatus, ['ready', 'exhausted']);
  validateTaskProfileSchema(object.taskProfile, true);
  responseHash(object.profileHash);
  validateProjectionSchema(object.projection);
  if (Object.hasOwn(object, 'nudge')) validateNudge(object.nudge);
  responseInteger(object.characterBudget, 1, 100_000);
  if (object.untrusted !== true) throw responseIntegrityError();
  const context = validateContextSchema(object.context);
  if (context !== null && (context.runId !== runId || context.taskProfileHash !== object.profileHash)) {
    throw responseIntegrityError();
  }
  const memoryPolicy = validateMemoryPolicy(object.memoryPolicy);
  validateMemoryDeliveryObservation(memoryPolicy, context, false);
  const capabilityGate = validateCapabilityGate(object, false, memoryPolicy);
  if (capabilityGate.nextAction === 'proceed') {
    if (context === null && !capabilityGate.memoryContextWithheld) throw responseIntegrityError();
  }
  return object;
}

function validateFeedbackRecord(category: string, value: unknown): Record<string, JsonValue> {
  const common = ['feedbackId', 'workspace', 'runId', 'actor', 'idempotencyKeyHash', 'createdAt'];
  const nullableText = (candidate: unknown, maximumBytes = 4 * 1024): void => {
    if (candidate !== null) responseString(candidate, maximumBytes);
  };
  if (category === 'context') {
    const object = responseObject(value, [...common, 'deliveryId', 'entryId', 'verdict', 'comment']);
    for (const field of ['feedbackId', 'workspace', 'runId', 'actor', 'deliveryId', 'entryId']) responseIdentifier(object[field]);
    responseEnum(object.verdict, ['helpful', 'irrelevant', 'stale', 'conflicting']);
    nullableText(object.comment);
    responseHash(object.idempotencyKeyHash);
    responseTimestamp(object.createdAt);
    return object;
  }
  if (category === 'intake') {
    const object = responseObject(value, [...common, 'sessionId', 'questionId', 'profileField', 'verdict', 'comment']);
    for (const field of ['feedbackId', 'workspace', 'runId', 'actor', 'sessionId']) responseIdentifier(object[field]);
    for (const field of ['questionId', 'profileField'] as const) {
      if (object[field] !== null) responseEnum(object[field], PROFILE_FIELDS);
    }
    if ((object.questionId === null) === (object.profileField === null)) throw responseIntegrityError();
    responseEnum(object.verdict, ['helpful', 'unnecessary', 'corrected']);
    nullableText(object.comment);
    responseHash(object.idempotencyKeyHash);
    responseTimestamp(object.createdAt);
    return object;
  }
  const object = responseObject(value, [
    ...common, 'outcome', 'recommendationCode', 'recommendationVerdict', 'rating', 'comment',
  ]);
  for (const field of ['feedbackId', 'workspace', 'runId', 'actor']) responseIdentifier(object[field]);
  nullableText(object.outcome);
  if (object.recommendationCode !== null) {
    const recommendationCode = responseString(object.recommendationCode, MAX_INPUT_BYTES);
    if (recommendationCode.length > MAX_ID_BYTES) throw responseIntegrityError();
  }
  nullableText(object.comment);
  if (object.recommendationVerdict !== null) responseEnum(object.recommendationVerdict, ['accepted', 'dismissed', 'resolved']);
  if ((object.recommendationCode === null) !== (object.recommendationVerdict === null)) throw responseIntegrityError();
  if (object.rating !== null) responseInteger(object.rating, 1, 5);
  if (object.outcome === null && object.recommendationCode === null && object.rating === null) throw responseIntegrityError();
  responseHash(object.idempotencyKeyHash);
  responseTimestamp(object.createdAt);
  return object;
}

function validateFeedbackBinding(
  category: string,
  record: Record<string, JsonValue>,
  binding: AgentResponseBinding,
): void {
  if (binding.requestBody.category !== category
    || binding.requestBody.feedbackId !== record.feedbackId
    || record.runId !== binding.expectedRunId
    || record.idempotencyKeyHash !== createHash('sha256').update(binding.idempotencyKey, 'utf8').digest('hex')) {
    throw responseIntegrityError();
  }
}

function validateFeedbackResponse(value: JsonValue, binding: AgentResponseBinding): Record<string, JsonValue> {
  const object = responseObject(value, ['category', 'record', 'untrusted', 'requestBindingHash']);
  validateRequestBindingHash(object, binding);
  const category = responseEnum(object.category, ['context', 'recommendation', 'intake', 'run']);
  const record = validateFeedbackRecord(category, object.record);
  validateFeedbackBinding(category, record, binding);
  if (object.untrusted !== true) throw responseIntegrityError();
  return object;
}

function validateAgentResponse(
  operation: AgentMutationOperation,
  value: unknown,
  binding: AgentResponseBinding,
): Record<string, unknown> {
  const cloned = cloneBoundaryJson(value, responseIntegrityError);
  if (Buffer.byteLength(stringifyBoundaryJson(cloned), 'utf8') > MAX_INPUT_BYTES) throw responseIntegrityError();
  switch (operation) {
    case 'agent.open': return validateIntakeResponse(cloned, binding);
    case 'agent.answer': return validateIntakeResponse(cloned, binding);
    case 'agent.events': return validateAppendResponse(cloned, binding);
    case 'agent.checkpoint': return validateCheckpointResponse(cloned, binding);
    case 'agent.close': return validateCloseResponse(cloned, binding);
    case 'agent.feedback': return validateFeedbackResponse(cloned, binding);
    default: throw responseIntegrityError();
  }
}

function responseStatus(operation: string, data: Record<string, unknown>): string {
  if (data.nextAction === 'required_capability_unavailable') return data.nextAction;
  switch (operation) {
    case 'agent.open':
    case 'agent.answer':
    case 'agent.checkpoint': return data.intakeStatus as string;
    case 'agent.events': return data.runStatus as string;
    case 'agent.close': return data.status as string;
    case 'agent.feedback': return 'recorded';
    default: throw responseIntegrityError();
  }
}

function responseQuestion(operation: string, data: Record<string, unknown>): string | undefined {
  if (operation !== 'agent.open' && operation !== 'agent.answer') return undefined;
  const question = data.currentQuestion;
  return question === null ? undefined : (question as Record<string, unknown>).id as string;
}

function requiredCapabilitySummary(data: Record<string, unknown>): string {
  const capabilities = data.capabilities as Record<string, unknown>;
  const recommendations = capabilities.recommendations as Array<Record<string, unknown>>;
  const labels = recommendations
    .filter((recommendation) => recommendation.required === true && recommendation.availability !== 'available')
    .map((recommendation) => `${recommendation.name as string} (${recommendation.availability as string})`);
  if (labels.length === 0) throw responseIntegrityError();
  return `; required capabilities unavailable: ${labels.join(', ')}`;
}

function humanSummary(operation: string, data: Record<string, unknown>): string {
  const question = responseQuestion(operation, data);
  const status = responseStatus(operation, data);
  const context = data.context !== null && data.context !== undefined ? '; initial context available' : '';
  const required = status === 'required_capability_unavailable' ? requiredCapabilitySummary(data) : '';
  return question === undefined
    ? `Kiokuko ${operation}: ${status}${required}${context}`
    : `Kiokuko ${operation}: ${status} (current question ${question})${required}${context}`;
}

function emitResult(json: boolean | undefined, operation: string, data: Record<string, unknown>): void {
  if (json) {
    const envelope = cloneBoundaryJson(successEnvelope(operation, data), responseIntegrityError);
    process.stdout.write(`${stringifyBoundaryJson(envelope)}\n`);
  }
  else process.stdout.write(`${humanSummary(operation, data)}\n`);
}

export function registerAgentCommand(cli: Command, dependencies: AgentCommandDependencies = {}): Command {
  const agent = cli.command('agent').description('Send generic agent lifecycle requests through the Kiokuko server');

  agent.command('open')
    .description('Open an authenticated generic agent run')
    .requiredOption('--workspace <workspace>')
    .requiredOption('--client <kind>')
    .requiredOption('--task <task>')
    .option('--client-version <version>')
    .option('--session-id <id>')
    .option('--capture-profile <profile>', 'Capture profile: minimal, standard, or full', 'standard')
    .option('--capabilities-json <file|->', 'Complete local capability catalog as a JSON array')
    .option('--idempotency-key <key>', 'Reuse the same key only to retry this exact request')
    .option('--json')
    .action(async (options: {
      workspace: string;
      client: string;
      task: string;
      clientVersion?: string;
      sessionId?: string;
      captureProfile: string;
      capabilitiesJson?: string;
      idempotencyKey?: string;
      json?: boolean;
    }) => {
      const workspace = boundedString(options.workspace, MAX_TEXT_BYTES);
      const clientKind = boundedId(options.client);
      const task = boundedString(options.task, MAX_TEXT_BYTES);
      const profile = captureProfile(options.captureProfile);
      const capabilities = options.capabilitiesJson === undefined
        ? undefined
        : await readCapabilityCatalog(dependencies, options.capabilitiesJson);
      const client = {
        kind: clientKind,
        ...(options.clientVersion === undefined ? {} : { version: boundedId(options.clientVersion) }),
        ...(options.sessionId === undefined ? {} : { sessionId: boundedId(options.sessionId) }),
      };
      const body = {
        apiVersion: '1' as const,
        workspace,
        client,
        task: {
          title: task,
          query: task,
          profileHints: { taskType: null, target: null, expected: null, constraints: null },
        },
        captureProfile: transportCaptureProfile(profile),
        coverage: {
          run: 'declared' as const,
          tool: 'declared' as const,
          command: 'declared' as const,
          file: 'declared' as const,
          approval: 'unavailable' as const,
        },
        metadata: {},
        ...(capabilities === undefined ? {} : { capabilities }),
      };
      const data = await sendRequest(dependencies, {
        method: 'POST',
        path: '/api/v1/agent/runs',
        operation: 'agent.open',
        body,
        idempotencyKey: requestIdempotencyKey(options.idempotencyKey, dependencies),
      });
      emitResult(options.json, 'agent.open', data);
    });

  agent.command('answer')
    .description('Answer the current agent intake question without inference')
    .argument('<run-id>')
    .requiredOption('--question-id <id>')
    .requiredOption('--value <answer>')
    .option('--capabilities-json <file|->', 'Same complete local capability catalog supplied to agent open')
    .option('--idempotency-key <key>', 'Reuse the same key only to retry this exact request')
    .option('--json')
    .action(async (runId: string, options: { questionId: string; value: string; capabilitiesJson?: string; idempotencyKey?: string; json?: boolean }) => {
      const questionId = boundedId(options.questionId);
      const value = boundedString(options.value, MAX_TEXT_BYTES);
      const capabilities = options.capabilitiesJson === undefined
        ? undefined
        : await readCapabilityCatalog(dependencies, options.capabilitiesJson);
      const data = await sendRequest(dependencies, {
        method: 'POST',
        path: runPath(runId, 'intake/answers'),
        operation: 'agent.answer',
        body: {
          apiVersion: '1' as const,
          questionId,
          value,
          ...(capabilities === undefined ? {} : { capabilities }),
        },
        idempotencyKey: requestIdempotencyKey(options.idempotencyKey, dependencies),
      });
      emitResult(options.json, 'agent.answer', data);
    });

  for (const [name, operation, suffix] of [
    ['events', 'agent.events', 'events'],
    ['checkpoint', 'agent.checkpoint', 'checkpoints'],
    ['close', 'agent.close', 'close'],
    ['feedback', 'agent.feedback', 'feedback'],
  ] as const) {
    const command = agent.command(name)
      .description(`Send an ${name} request for an agent run`)
      .argument('<run-id>')
      .requiredOption('--input-json <file|->')
      .option('--json');
    if (name === 'checkpoint') {
      command.option('--capabilities-json <file|->', 'Same complete local capability catalog supplied to agent open');
    }
    command.action(async (runId: string, options: { inputJson: string; capabilitiesJson?: string; json?: boolean }) => {
        const input = await readInput(dependencies, options.inputJson);
        const request = bodyAndKey(input, dependencies);
        const capabilities = name === 'checkpoint' && options.capabilitiesJson !== undefined
          ? await readCapabilityCatalog(dependencies, options.capabilitiesJson)
          : undefined;
        if (capabilities !== undefined && Object.prototype.hasOwnProperty.call(request.body, 'capabilities')) {
          throw validationError();
        }
        const data = await sendRequest(dependencies, {
          method: 'POST',
          path: runPath(runId, suffix),
          operation,
          body: capabilities === undefined ? request.body : { ...request.body, capabilities },
          idempotencyKey: request.idempotencyKey,
        });
        emitResult(options.json, operation, data);
      });
  }

  return agent;
}
