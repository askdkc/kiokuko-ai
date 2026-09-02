import { TextDecoder } from 'node:util';
import { isProxy } from 'node:util/types';
import { getRuntimeDescriptorPath } from '../config/paths.js';
import { KiokukoError, type ErrorCode } from '../errors.js';
import {
  cloneBoundaryJson,
  stringifyBoundaryJson,
} from '../serialization/boundary-json.js';
import { isPidAlive, type PidLiveness } from '../server/instance-lock.js';
import { readRuntimeDescriptor, type RuntimeDescriptor } from '../server/runtime-descriptor.js';
import { MAX_STRICT_JSON_DEPTH, parseStrictJson } from '../setup/strict-json.js';

export type ServerMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ServerRequest {
  readonly method: ServerMethod;
  readonly path: string;
  readonly operation: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export interface ServerClient {
  request<T = unknown>(request: ServerRequest): Promise<T>;
}

export interface CreateServerClientOptions {
  readonly descriptorPath?: string;
  readonly isPidAlive?: PidLiveness;
  readonly fetchImplementation?: FetchImplementation;
  readonly fetch?: FetchImplementation;
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const MAX_OPERATION_BYTES = 256;
const MAX_JSON_NODES = 262_144;
const MAX_RESPONSE_CHUNKS = 8_192;
const RESPONSE_CLEANUP_TIMEOUT_MS = 250;
const HEALTH_READY_PATH = '/health/ready';
const WRITE_METHODS = new Set<ServerMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_METHODS = new Set<ServerMethod>(['GET']);
const SERVER_METHODS = new Set<ServerMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ERROR_CODES: readonly ErrorCode[] = [
  'USAGE_ERROR',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'DATABASE_ERROR',
  'BACKPRESSURE',
  'SERVICE_UNAVAILABLE',
  'SECURITY_REJECTION',
  'AUTHENTICATION_ERROR',
  'INTEGRITY_ERROR',
  'PARTIAL_FAILURE',
  'NOT_IMPLEMENTED',
  'UNSUPPORTED_CLIENT',
];
const ERROR_STATUS: Readonly<Record<ErrorCode, readonly number[]>> = {
  USAGE_ERROR: [400],
  VALIDATION_ERROR: [400],
  NOT_FOUND: [404],
  CONFLICT: [409],
  DATABASE_ERROR: [500, 503],
  BACKPRESSURE: [429],
  SERVICE_UNAVAILABLE: [503],
  SECURITY_REJECTION: [422],
  AUTHENTICATION_ERROR: [401],
  INTEGRITY_ERROR: [500],
  PARTIAL_FAILURE: [],
  NOT_IMPLEMENTED: [],
  UNSUPPORTED_CLIENT: [400],
};

function validationError(): KiokukoError {
  return new KiokukoError('VALIDATION_ERROR', 'Request is invalid');
}

function integrityError(): KiokukoError {
  return new KiokukoError('INTEGRITY_ERROR', 'Server response is invalid');
}

function unavailableError(): KiokukoError {
  return new KiokukoError('SERVICE_UNAVAILABLE', 'Kiokuko server is unavailable');
}

async function readLiveRuntimeDescriptor(options: {
  readonly descriptorPath?: string;
  readonly isPidAlive?: PidLiveness;
}): Promise<RuntimeDescriptor> {
  const descriptorPath = options.descriptorPath ?? getRuntimeDescriptorPath();
  const descriptor = await readRuntimeDescriptor(descriptorPath);
  if (!descriptor) throw unavailableError();
  const live = await (options.isPidAlive ?? isPidAlive)(descriptor.pid);
  if (!live) throw unavailableError();
  return descriptor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function directPrototype(value: unknown): object | null | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  if (isProxy(value)) return undefined;
  return Object.getPrototypeOf(value) as object | null;
}

const BUILTIN_ERROR_PROTOTYPES = new Set<object>([
  Error.prototype,
  EvalError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  TypeError.prototype,
  URIError.prototype,
]);

function isExactErrorObject(value: unknown): value is Error {
  const prototype = directPrototype(value);
  return prototype !== undefined && prototype !== null && BUILTIN_ERROR_PROTOTYPES.has(prototype);
}

function isExactKiokukoError(value: unknown): value is KiokukoError {
  return directPrototype(value) === KiokukoError.prototype;
}

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function isByteString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) return false;
  }
  return true;
}

function ownDataDescriptors(value: object): ReadonlyMap<string, PropertyDescriptor> {
  if (isProxy(value)) throw validationError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw validationError();
  const result = new Map<string, PropertyDescriptor>();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) throw validationError();
    result.set(key, descriptor);
  }
  return result;
}

function jsonSnapshot(value: unknown): string {
  const snapshot = stringifyBoundaryJson(cloneBoundaryJson(value, {
    failure: validationError,
    maximumDepth: MAX_STRICT_JSON_DEPTH,
    maximumNodes: MAX_JSON_NODES,
  }));
  if (Buffer.byteLength(snapshot, 'utf8') > MAX_JSON_BYTES) throw validationError();
  return snapshot;
}

function validateOperation(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_OPERATION_BYTES
    || hasControlCharacters(value)) throw validationError();
  return value;
}

function validatePath(value: unknown, method: ServerMethod, baseUrl: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
    || hasControlCharacters(value) || value.includes('\\') || value.includes('#')
    || value.startsWith('//') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) throw validationError();

  const queryIndex = value.indexOf('?');
  const rawPath = queryIndex < 0 ? value : value.slice(0, queryIndex);
  const query = queryIndex < 0 ? undefined : value.slice(queryIndex + 1);
  const healthPath = rawPath === HEALTH_READY_PATH;
  if (!rawPath.startsWith('/api/v1/') && !healthPath) throw validationError();
  if (healthPath && queryIndex >= 0) throw validationError();
  if (queryIndex >= 0 && !READ_METHODS.has(method)) throw validationError();
  if (query !== undefined && Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) throw validationError();

  for (const segment of rawPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw validationError();
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
      || hasControlCharacters(decoded)) throw validationError();
  }

  try {
    const base = new URL(baseUrl);
    const target = new URL(value, `${baseUrl}/`);
    if (target.origin !== base.origin || target.username !== '' || target.password !== '') throw validationError();
    if (Buffer.byteLength(`${target.pathname}${target.search}`, 'utf8') > MAX_PATH_BYTES
      || Buffer.byteLength(target.search.slice(1), 'utf8') > MAX_QUERY_BYTES) throw validationError();
    return target.toString();
  } catch (error) {
    if (isExactKiokukoError(error)) throw error;
    throw validationError();
  }
}

function validateIdempotencyKey(method: ServerMethod, value: unknown): string | undefined {
  if (!WRITE_METHODS.has(method)) {
    if (value !== undefined) throw validationError();
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES
    || value.trim() !== value || hasControlCharacters(value) || !isByteString(value)) throw validationError();
  return value;
}

interface NormalizedServerRequest {
  readonly method: ServerMethod;
  readonly path: string;
  readonly operation: string;
  readonly body: unknown;
  readonly idempotencyKey: unknown;
  readonly signal: AbortSignal | undefined;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function signalReason(signal: AbortSignal): unknown {
  return signal.reason;
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signalAborted(signal)) throw signalReason(signal as AbortSignal);
}

function awaitWithSignal<T>(operation: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  const guarded = Promise.resolve(operation);
  if (signal === undefined) return guarded;
  if (signalAborted(signal)) {
    guarded.then(() => undefined, () => undefined);
    return Promise.reject(signalReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signalReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    guarded.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signalAborted(signal)) reject(signalReason(signal));
        else resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signalAborted(signal)) reject(signalReason(signal));
        else reject(error);
      },
    );
  });
}

function normalizeRequestInput(input: ServerRequest): NormalizedServerRequest {
  if (!isPlainObject(input)) throw validationError();
  const descriptors = ownDataDescriptors(input);
  const allowed = new Set(['method', 'path', 'operation', 'body', 'idempotencyKey', 'signal']);
  if ([...descriptors.keys()].some((key) => !allowed.has(key))) throw validationError();
  for (const field of ['method', 'path', 'operation']) {
    const descriptor = descriptors.get(field);
    if (descriptor === undefined || descriptor.enumerable !== true) throw validationError();
  }
  for (const descriptor of descriptors.values()) {
    if (descriptor.enumerable !== true) throw validationError();
  }
  const signal = descriptors.get('signal')?.value;
  if (signal !== undefined && directPrototype(signal) !== AbortSignal.prototype) {
    throw validationError();
  }
  if (signal !== undefined) {
    try {
      void signal.aborted;
    } catch {
      throw validationError();
    }
  }
  return {
    method: descriptors.get('method')?.value as ServerMethod,
    path: descriptors.get('path')?.value as string,
    operation: descriptors.get('operation')?.value as string,
    body: descriptors.get('body')?.value,
    idempotencyKey: descriptors.get('idempotencyKey')?.value,
    signal,
  };
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw integrityError();
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.includes(value as ErrorCode);
}

const TRANSPORT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function ownErrorField(value: object, field: string): unknown {
  if (isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  return keys.length === allowed.size
    && keys.every((key) => typeof key === 'string' && allowed.has(key));
}

function isExactSystemTransportCause(cause: object, code: string): boolean {
  if (directPrototype(cause) !== Error.prototype
    || typeof ownErrorField(cause, 'message') !== 'string'
    || typeof ownErrorField(cause, 'errno') !== 'number'
    || ownErrorField(cause, 'code') !== code
    || typeof ownErrorField(cause, 'syscall') !== 'string') return false;
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
    return typeof ownErrorField(cause, 'hostname') === 'string'
      && hasExactOwnKeys(cause, ['stack', 'message', 'errno', 'code', 'syscall', 'hostname']);
  }
  return typeof ownErrorField(cause, 'address') === 'string'
    && typeof ownErrorField(cause, 'port') === 'number'
    && hasExactOwnKeys(cause, ['stack', 'message', 'errno', 'code', 'syscall', 'address', 'port']);
}

function isExactUndiciTransportCause(cause: object, code: string): boolean {
  const expectedName: Readonly<Record<string, string>> = {
    UND_ERR_BODY_TIMEOUT: 'BodyTimeoutError',
    UND_ERR_CONNECT_TIMEOUT: 'ConnectTimeoutError',
    UND_ERR_HEADERS_TIMEOUT: 'HeadersTimeoutError',
  };
  return cause instanceof Error
    && expectedName[code] !== undefined
    && ownErrorField(cause, 'name') === expectedName[code]
    && ownErrorField(cause, 'code') === code
    && typeof ownErrorField(cause, 'message') === 'string'
    && hasExactOwnKeys(cause, ['stack', 'message', 'name', 'code']);
}

function isExactTransportFailure(error: unknown): boolean {
  if (!isExactErrorObject(error)) return false;
  const cause = ownErrorField(error, 'cause');
  const message = ownErrorField(error, 'message');
  if (directPrototype(error) !== TypeError.prototype || (message !== 'fetch failed' && message !== 'terminated')
    || (typeof cause !== 'object' && typeof cause !== 'function') || cause === null
    || isProxy(cause) || cause === error
    || !hasExactOwnKeys(error, ['stack', 'message', 'cause'])) return false;
  const causeCode = ownErrorField(cause, 'code');
  if (message === 'fetch failed') {
    return typeof causeCode === 'string'
      && TRANSPORT_ERROR_CODES.has(causeCode)
      && (isExactSystemTransportCause(cause, causeCode) || isExactUndiciTransportCause(cause, causeCode));
  }
  return cause instanceof Error
    && causeCode === 'UND_ERR_SOCKET'
    && ownErrorField(cause, 'name') === 'SocketError'
    && typeof ownErrorField(cause, 'message') === 'string'
    && hasExactOwnKeys(cause, ['stack', 'message', 'name', 'code', 'socket']);
}

function throwTransportOrOriginal(error: unknown): never {
  throw normalizedTransportOrOriginal(error);
}

function normalizedTransportOrOriginal(error: unknown): unknown {
  return isExactTransportFailure(error) ? unavailableError() : error;
}

interface ValidatedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

function invalidFetchResponse(): never {
  throw new TypeError('Fetch implementation returned a non-Response value');
}

function validateFetchResponse(value: unknown): ValidatedResponse {
  if (directPrototype(value) !== Response.prototype || Reflect.ownKeys(value as object).length !== 0) {
    invalidFetchResponse();
  }
  let status: number;
  let headers: Headers;
  let body: ReadableStream<Uint8Array> | null;
  let bodyUsed: boolean;
  try {
    const response = value as Response;
    status = response.status;
    headers = response.headers;
    body = response.body;
    bodyUsed = response.bodyUsed;
    if (directPrototype(headers) !== Headers.prototype
      || Reflect.ownKeys(headers).some((key) => typeof key === 'string')
      || (body !== null && (directPrototype(body) !== ReadableStream.prototype
        || Reflect.ownKeys(body).some((key) => typeof key === 'string')))) invalidFetchResponse();
  } catch {
    invalidFetchResponse();
  }
  if (bodyUsed || body?.locked === true) {
    throw integrityError();
  }
  return { status, headers, body };
}

function header(response: ValidatedResponse, name: string): string | null {
  return response.headers.get(name);
}

function hasHeader(response: ValidatedResponse, name: string): boolean {
  return response.headers.has(name);
}

async function settleResponseCleanup(operation: PromiseLike<unknown>, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.resolve(operation).then(
    () => true,
    () => false,
  );
  const timed = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), RESPONSE_CLEANUP_TIMEOUT_MS);
  });
  let cleaned: boolean;
  try {
    cleaned = await awaitWithSignal(Promise.race([settled, timed]), signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!cleaned) throw integrityError();
}

async function discardResponseBody(response: ValidatedResponse, signal?: AbortSignal): Promise<void> {
  if (response.body === null) return;
  try {
    await settleResponseCleanup(
      response.body.cancel(),
      signal,
    );
  } catch (error) {
    throwIfSignalAborted(signal);
    if (isExactKiokukoError(error)) throw error;
    throw integrityError();
  }
}

function exactResponseChunk(value: unknown): { readonly value: Uint8Array; readonly byteLength: number } {
  if (directPrototype(value) !== Uint8Array.prototype) throw integrityError();
  try {
    const ownKeys = Reflect.ownKeys(value as object);
    if (ownKeys.some((key) => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key))) {
      throw integrityError();
    }
    const byteLength = (value as Uint8Array).byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0
      || ownKeys.some((key) => Number(key) >= byteLength)) throw integrityError();
    return { value: value as Uint8Array, byteLength };
  } catch (error) {
    if (isExactKiokukoError(error)) throw error;
    throw integrityError();
  }
}

function copyResponseChunk(value: Uint8Array, byteLength: number): Buffer {
  try {
    const copy = new Uint8Array(byteLength);
    copy.set(value);
    return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
  } catch {
    throw integrityError();
  }
}

async function readBoundedBody(response: ValidatedResponse, signal?: AbortSignal): Promise<string> {
  const contentLength = header(response, 'content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_JSON_BYTES) {
    await discardResponseBody(response, signal);
    throw integrityError();
  }
  if (response.body === null) {
    throwIfSignalAborted(signal);
    return '';
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw integrityError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let chunkCount = 0;
  let failed = false;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    while (true) {
      const item = await awaitWithSignal(
        reader.read(),
        signal,
      );
      throwIfSignalAborted(signal);
      if (item.done) break;
      chunkCount += 1;
      if (chunkCount > MAX_RESPONSE_CHUNKS) throw integrityError();
      const chunk = exactResponseChunk(item.value);
      size += chunk.byteLength;
      if (size > MAX_JSON_BYTES) throw integrityError();
      chunks.push(copyResponseChunk(chunk.value, chunk.byteLength));
    }
  } catch (error) {
    failed = true;
    primaryFailure = signal !== undefined && signalAborted(signal)
      ? signalReason(signal)
      : isExactKiokukoError(error)
        ? error
        : normalizedTransportOrOriginal(error);
    try {
      await settleResponseCleanup(reader.cancel());
    } catch {
      cleanupFailures.push(integrityError());
    }
  }
  try {
    reader.releaseLock();
  } catch {
    cleanupFailures.push(integrityError());
  }
  if (!failed && signal !== undefined && signalAborted(signal)) {
    failed = true;
    primaryFailure = signalReason(signal);
  }
  if (failed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        signal !== undefined && signalAborted(signal)
          ? 'Response cleanup failed after caller abort'
          : 'Response body read failed and cleanup also failed',
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, 'Response body cleanup failed');
  throwIfSignalAborted(signal);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw integrityError();
  }
}

function parseJson(text: string): unknown {
  try {
    return parseStrictJson(
      text,
      { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
      'Server response is not valid JSON with unique keys',
    );
  } catch (error) {
    if (isExactKiokukoError(error) && error.code === 'VALIDATION_ERROR') throw integrityError();
    throw error;
  }
}

function validateHealthResponse(value: unknown): { ok: true } {
  if (!isPlainObject(value)) throw integrityError();
  assertExactKeys(value, ['ok']);
  if (value.ok !== true) throw integrityError();
  return { ok: true };
}

function validateSuccessResponse(value: unknown, operation: string): unknown {
  if (!isPlainObject(value)) throw integrityError();
  assertExactKeys(value, ['apiVersion', 'ok', 'operation', 'data', 'meta']);
  if (value.apiVersion !== '1' || value.ok !== true || value.operation !== operation
    || !Object.prototype.hasOwnProperty.call(value, 'data')) throw integrityError();
  if (Object.prototype.hasOwnProperty.call(value, 'meta') && !isPlainObject(value.meta)) throw integrityError();
  return value.data;
}

function expectedErrorMessage(code: ErrorCode, status: number): string {
  switch (code) {
    case 'AUTHENTICATION_ERROR': return 'Authorization is invalid';
    case 'NOT_FOUND': return 'Endpoint not found';
    case 'USAGE_ERROR':
    case 'VALIDATION_ERROR': return 'Request is invalid';
    case 'CONFLICT': return 'Request conflicts with current state';
    case 'BACKPRESSURE': return 'Service is busy';
    case 'SERVICE_UNAVAILABLE': return 'Service unavailable';
    case 'DATABASE_ERROR': return status === 503 ? 'Database unavailable' : 'Unexpected server error';
    case 'SECURITY_REJECTION': return 'Request rejected';
    case 'INTEGRITY_ERROR': return 'Internal integrity error';
    case 'UNSUPPORTED_CLIENT': return 'Client is not supported';
    case 'PARTIAL_FAILURE':
    case 'NOT_IMPLEMENTED': throw integrityError();
  }
}

function validateErrorResponse(
  value: unknown,
  operation: string,
  status: number,
): { code: ErrorCode; message: string; details: Record<string, unknown> } {
  if (!isPlainObject(value)) throw integrityError();
  assertExactKeys(value, ['apiVersion', 'ok', 'operation', 'error']);
  if (value.apiVersion !== '1' || value.ok !== false || value.operation !== operation || !isPlainObject(value.error)) {
    throw integrityError();
  }
  assertExactKeys(value.error, ['code', 'message', 'details']);
  if (!isErrorCode(value.error.code)) throw integrityError();
  if (!ERROR_STATUS[value.error.code].includes(status) || !isPlainObject(value.error.details)) throw integrityError();
  const message = expectedErrorMessage(value.error.code, status);
  if (value.error.message !== message) throw integrityError();
  if (value.error.code === 'BACKPRESSURE') {
    assertExactKeys(value.error.details, ['retryAfterSeconds']);
    if (typeof value.error.details.retryAfterSeconds !== 'number'
      || !Number.isSafeInteger(value.error.details.retryAfterSeconds)
      || value.error.details.retryAfterSeconds < 1 || value.error.details.retryAfterSeconds > 60) throw integrityError();
  } else {
    assertExactKeys(value.error.details, []);
  }
  return {
    code: value.error.code,
    message,
    details: value.error.details,
  };
}

function safeRetryAfter(response: ValidatedResponse): number | undefined {
  const value = header(response, 'retry-after');
  if (value === null || !/^\d{1,2}$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : undefined;
}

async function parseResponse(
  response: ValidatedResponse,
  requestPath: string,
  operation: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (response.status >= 200 && response.status < 300 && response.status !== 200) {
    await discardResponseBody(response, signal);
    throw integrityError();
  }
  const contentType = header(response, 'content-type') ?? '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    await discardResponseBody(response, signal);
    throw integrityError();
  }
  const parsed = parseJson(await readBoundedBody(response, signal));
  const isSuccess = response.status === 200;
  if (requestPath === HEALTH_READY_PATH && response.status === 200) return validateHealthResponse(parsed);
  if (requestPath === HEALTH_READY_PATH && response.status === 503) {
    if (!isPlainObject(parsed)) throw integrityError();
    assertExactKeys(parsed, ['ok']);
    if (parsed.ok !== false || hasHeader(response, 'retry-after')) throw integrityError();
    throw new KiokukoError('SERVICE_UNAVAILABLE', 'Kiokuko server is unavailable');
  }
  if (!isSuccess) {
    const error = validateErrorResponse(parsed, operation, response.status);
    const retryAfterHeader = header(response, 'retry-after');
    if (error.code === 'BACKPRESSURE') {
      const retryAfter = safeRetryAfter(response);
      if (retryAfter === undefined || error.details.retryAfterSeconds !== retryAfter) {
        throw integrityError();
      }
    } else if (retryAfterHeader !== null) {
      throw integrityError();
    }
    throw new KiokukoError(error.code, error.message, error.details);
  }
  return validateSuccessResponse(parsed, operation);
}

export async function createServerClient(options: CreateServerClientOptions = {}): Promise<ServerClient> {
  const descriptor = await readLiveRuntimeDescriptor(options);
  const baseUrl = descriptor.baseUrl;
  const authorizationHeader = `Bearer ${descriptor.capabilityToken}`;
  const fetchImplementation = options.fetchImplementation ?? options.fetch ?? globalThis.fetch;
  const request = async <T = unknown>(input: ServerRequest): Promise<T> => {
    const normalized = normalizeRequestInput(input);
    const method = normalized.method;
    if (typeof method !== 'string' || !SERVER_METHODS.has(method as ServerMethod)) throw validationError();
    const typedMethod = method as ServerMethod;
    const operation = validateOperation(normalized.operation);
    const url = validatePath(normalized.path, typedMethod, baseUrl);
    const requestPath = normalized.path.split('?')[0] ?? normalized.path;
    if ((READ_METHODS.has(typedMethod) && normalized.body !== undefined)
      || (requestPath === HEALTH_READY_PATH && typedMethod !== 'GET')
      || ((requestPath === HEALTH_READY_PATH) !== (operation === 'health.ready'))) throw validationError();
    const idempotencyKey = validateIdempotencyKey(typedMethod, normalized.idempotencyKey);
    const bodySnapshot = normalized.body === undefined ? undefined : jsonSnapshot(normalized.body);
    if (typeof fetchImplementation !== 'function') throw unavailableError();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: authorizationHeader,
    };
    if (bodySnapshot !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    const init: RequestInit = {
      method: typedMethod,
      headers,
      ...(bodySnapshot === undefined ? {} : { body: bodySnapshot }),
      ...(normalized.signal === undefined ? {} : { signal: normalized.signal }),
    };

    throwIfSignalAborted(normalized.signal);
    let rawResponse: unknown;
    try {
      rawResponse = await awaitWithSignal(fetchImplementation(url, init), normalized.signal);
    } catch (error) {
      throwIfSignalAborted(normalized.signal);
      throwTransportOrOriginal(error);
    }
    throwIfSignalAborted(normalized.signal);
    const response = validateFetchResponse(rawResponse);
    const result = await parseResponse(
      response,
      requestPath,
      operation,
      normalized.signal,
    );
    throwIfSignalAborted(normalized.signal);
    return result as T;
  };
  return Object.freeze({ request });
}
