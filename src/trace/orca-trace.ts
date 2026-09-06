import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import type { JsonObject, JsonValue } from '../serialization/validate.js';

export const ORCA_TRACE_READER_POLICY_VERSION = 1 as const;
export const ORCA_TRACE_MAX_EVENTS_BYTES = 64 * 1024 * 1024;
export const ORCA_TRACE_INLINE_PAYLOAD_BYTES = 4096;
export const ORCA_TRACE_MAX_WARNINGS = 32;

export const ORCA_TRACE_EVENT_TYPES = [
  'run.start',
  'run.end',
  'model.request',
  'model.response',
  'tool.call',
  'tool.result',
  'mcp.request',
  'mcp.response',
  'shell.exec',
  'shell.result',
  'fs.snapshot',
  'fs.change',
  'net.request',
  'net.response',
  'session.snapshot',
  'error',
  'divergence',
  'checkpoint',
  'fork',
  'route.decision',
  'note',
] as const;

export type OrcaTraceEventType = (typeof ORCA_TRACE_EVENT_TYPES)[number];

const SUPPORTED_SCHEMA_PATTERN = /^0\.[0-9]+\.[0-9]+$/u;
export const ORCA_TRACE_RUN_ID_PATTERN = /^run_[0-9a-f]{6,32}$/u;
const BLOB_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export type OrcaTraceWarningCode =
  | 'truncated_final_line'
  | 'invalid_event'
  | 'unknown_event_type'
  | 'seq_gap'
  | 'blob_unresolved'
  | 'events_too_large';

export interface OrcaTraceWarning {
  readonly code: OrcaTraceWarningCode;
  readonly seq?: number;
  readonly detail?: string;
}

export interface OrcaTraceBlobDescriptor {
  readonly blobDigest: string;
  readonly bytes: number;
  readonly mediaType?: string;
}

export interface OrcaTraceEvent {
  readonly seq: number;
  readonly ts: string;
  readonly monoUs: number;
  readonly turn: number;
  readonly type: string;
  readonly actor: string;
  readonly causes?: readonly number[];
  readonly attrs?: JsonObject;
  readonly payload?: JsonValue | OrcaTraceBlobDescriptor;
  readonly redacted?: readonly string[];
  readonly unknownType: boolean;
}

export interface OrcaTraceManifestView {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly countsEvents?: number;
  readonly eventsSha256?: string;
}

export type OrcaTraceReadStatus =
  | 'ready'
  | 'unsupported_schema'
  | 'missing_manifest'
  | 'missing_events'
  | 'invalid_manifest'
  | 'missing_run_directory';

export type OrcaTraceIntegrity = 'verified' | 'mismatch' | 'unavailable';

export interface OrcaTraceRunRead {
  readonly status: OrcaTraceReadStatus;
  readonly integrity: OrcaTraceIntegrity;
  readonly manifest?: OrcaTraceManifestView;
  readonly events: readonly OrcaTraceEvent[];
  readonly maxSeq: number;
  readonly warnings: readonly OrcaTraceWarning[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function pushWarning(warnings: OrcaTraceWarning[], warning: OrcaTraceWarning): void {
  if (warnings.length < ORCA_TRACE_MAX_WARNINGS) warnings.push(warning);
}

export interface ParsedOrcaTraceManifest {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly countsEvents: number | undefined;
  readonly eventsSha256: string | undefined;
}

export type OrcaTraceManifestRead =
  | { readonly ok: true; readonly manifest: ParsedOrcaTraceManifest }
  | {
    readonly ok: false;
    readonly reason: 'missing_manifest' | 'invalid_manifest' | 'unsupported_schema';
    readonly schemaVersion?: string;
  };

function parseManifest(raw: string, traceRunId: string): ParsedOrcaTraceManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) return undefined;
  const schemaVersion = parsed.schema_version;
  const runId = parsed.run_id;
  if (typeof schemaVersion !== 'string' || schemaVersion.length === 0 || schemaVersion.length > 64) return undefined;
  if (typeof runId !== 'string' || !ORCA_TRACE_RUN_ID_PATTERN.test(runId) || runId !== traceRunId) return undefined;
  const counts = isPlainRecord(parsed.counts) ? parsed.counts : undefined;
  const countsEvents = counts !== undefined && isSafeInteger(counts.events) && counts.events >= 0
    ? counts.events
    : undefined;
  const integrity = isPlainRecord(parsed.integrity) ? parsed.integrity : undefined;
  const eventsSha256 = integrity !== undefined
    && typeof integrity.events_sha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(integrity.events_sha256)
    ? integrity.events_sha256
    : undefined;
  return { schemaVersion, runId, countsEvents, eventsSha256 };
}

export async function readOrcaTraceManifest(
  runsDirectory: string,
  traceRunId: string,
): Promise<OrcaTraceManifestRead> {
  if (typeof runsDirectory !== 'string' || !path.isAbsolute(runsDirectory) || runsDirectory.length > 4096) {
    throw new KiokukoError('VALIDATION_ERROR', 'OrcaReplay runs directory must be a bounded absolute path');
  }
  if (typeof traceRunId !== 'string' || !ORCA_TRACE_RUN_ID_PATTERN.test(traceRunId)) {
    throw new KiokukoError('VALIDATION_ERROR', 'OrcaReplay trace run ID is invalid');
  }
  const runDirectory = path.join(runsDirectory, traceRunId);
  let raw: string;
  try {
    raw = await readFile(path.join(runDirectory, 'manifest.json'), 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing_manifest' };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: 'invalid_manifest' };
    throw error;
  }
  const manifest = parseManifest(raw, traceRunId);
  if (manifest === undefined) return { ok: false, reason: 'invalid_manifest' };
  if (!SUPPORTED_SCHEMA_PATTERN.test(manifest.schemaVersion)) {
    return { ok: false, reason: 'unsupported_schema', schemaVersion: manifest.schemaVersion };
  }
  return { ok: true, manifest };
}

function descriptor(hex: string, bytes: number, mediaType: string | undefined): OrcaTraceBlobDescriptor {
  return mediaType === undefined
    ? { blobDigest: hex, bytes }
    : { blobDigest: hex, bytes, mediaType };
}

type BlobResolution =
  | { readonly ok: true; readonly value?: JsonValue | OrcaTraceBlobDescriptor }
  | { readonly ok: false; readonly detail: string };

async function resolveBlobPayload(
  runDirectory: string,
  reference: Record<string, unknown>,
): Promise<BlobResolution> {
  const digestValue = reference.$blob;
  if (typeof digestValue !== 'string') {
    return { ok: false, detail: 'blob reference is malformed' };
  }
  const hex = BLOB_DIGEST_PATTERN.exec(digestValue)?.[1];
  if (hex === undefined) {
    return { ok: false, detail: 'blob digest is malformed' };
  }
  const declaredBytes = reference.bytes;
  if (declaredBytes !== undefined && (!isSafeInteger(declaredBytes) || declaredBytes < 1)) {
    return { ok: false, detail: 'blob byte count is invalid' };
  }
  if (reference.media_type !== undefined && typeof reference.media_type !== 'string') {
    return { ok: false, detail: 'blob media type is invalid' };
  }
  const blobPath = path.join(runDirectory, 'blobs', hex.slice(0, 2), hex);
  let bytes: Buffer;
  try {
    bytes = await readFile(blobPath);
  } catch {
    return { ok: false, detail: `blob ${hex} is missing` };
  }
  if (createHash('sha256').update(bytes).digest('hex') !== hex) {
    return { ok: false, detail: `blob ${hex} does not match its digest` };
  }
  const mediaType = typeof reference.media_type === 'string' ? reference.media_type : undefined;
  if (bytes.byteLength <= ORCA_TRACE_INLINE_PAYLOAD_BYTES) {
    try {
      return { ok: true, value: JSON.parse(bytes.toString('utf8')) as JsonValue };
    } catch {
      return { ok: true, value: descriptor(hex, bytes.byteLength, mediaType) };
    }
  }
  return { ok: true, value: descriptor(hex, declaredBytes === undefined ? bytes.byteLength : declaredBytes, mediaType) };
}

function requiresString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

type TraceLineParse =
  | { readonly kind: 'event'; readonly event: OrcaTraceEvent; readonly seqGap: boolean }
  | { readonly kind: 'skip'; readonly warning: OrcaTraceWarning }
  | { readonly kind: 'skipAfterSeq'; readonly warning: OrcaTraceWarning; readonly seq: number };

function parseTraceLine(
  runDirectory: string,
  line: string,
  previousSeq: number,
): Promise<TraceLineParse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return Promise.resolve({
      kind: 'skip',
      warning: { code: 'invalid_event', detail: 'event line is not valid JSON' },
    });
  }
  if (!isPlainRecord(parsed)) {
    return Promise.resolve({
      kind: 'skip' as const,
      warning: { code: 'invalid_event' as const, detail: 'event envelope is not an object' },
    });
  }
  const seq = parsed.seq;
  const ts = parsed.ts;
  const monoUs = parsed.mono_us;
  const turn = parsed.turn;
  const type = parsed.type;
  const actor = parsed.actor;
  if (!isSafeInteger(seq) || seq < 0) {
    return Promise.resolve({
      kind: 'skip' as const,
      warning: { code: 'invalid_event' as const, detail: 'event seq is invalid' },
    });
  }
  if (seq <= previousSeq) {
    return Promise.resolve({
      kind: 'skip' as const,
      warning: { code: 'invalid_event' as const, seq, detail: 'event seq is not strictly increasing' },
    });
  }
  if (!requiresString(ts) || !RFC3339_PATTERN.test(ts)
    || !isSafeInteger(monoUs) || monoUs < 0
    || !isSafeInteger(turn) || turn < 0
    || !requiresString(type) || !requiresString(actor)) {
    return Promise.resolve({
      kind: 'skipAfterSeq' as const,
      seq,
      warning: { code: 'invalid_event' as const, seq, detail: 'event envelope fields are invalid' },
    });
  }
  const causes = parsed.causes;
  if (causes !== undefined
    && (!Array.isArray(causes) || causes.some((cause) => !isSafeInteger(cause) || cause < 0 || cause >= seq))) {
    return Promise.resolve({
      kind: 'skipAfterSeq' as const,
      seq,
      warning: { code: 'invalid_event' as const, seq, detail: 'event causes are invalid' },
    });
  }
  const attrs = parsed.attrs;
  if (attrs !== undefined && !isPlainRecord(attrs)) {
    return Promise.resolve({
      kind: 'skipAfterSeq' as const,
      seq,
      warning: { code: 'invalid_event' as const, seq, detail: 'event attrs are invalid' },
    });
  }
  const redacted = parsed.redacted;
  if (redacted !== undefined
    && (!Array.isArray(redacted) || redacted.some((item) => !requiresString(item)))) {
    return Promise.resolve({
      kind: 'skipAfterSeq' as const,
      seq,
      warning: { code: 'invalid_event' as const, seq, detail: 'event redaction list is invalid' },
    });
  }
  const rawPayload = parsed.payload;
  const payloadReference = rawPayload !== undefined && isPlainRecord(rawPayload) && Object.hasOwn(rawPayload, '$blob')
    ? rawPayload
    : undefined;
  const inlineResolution: BlobResolution = payloadReference === undefined
    ? rawPayload === undefined
      ? { ok: true }
      : { ok: true, value: rawPayload as JsonValue }
    : { ok: false, detail: 'unreachable' };
  return (payloadReference === undefined
    ? Promise.resolve<BlobResolution>(inlineResolution)
    : resolveBlobPayload(runDirectory, payloadReference)).then((resolution) => {
    if (!resolution.ok) {
      return {
        kind: 'skipAfterSeq' as const,
        seq,
        warning: { code: 'blob_unresolved' as const, seq, detail: resolution.detail },
      };
    }
    const event: {
      seq: number;
      ts: string;
      monoUs: number;
      turn: number;
      type: string;
      actor: string;
      unknownType: boolean;
      causes?: readonly number[];
      attrs?: JsonObject;
      payload?: JsonValue | OrcaTraceBlobDescriptor;
      redacted?: readonly string[];
    } = {
      seq,
      ts,
      monoUs,
      turn,
      type,
      actor,
      unknownType: !ORCA_TRACE_EVENT_TYPES.includes(type as OrcaTraceEventType),
    };
    if (causes !== undefined) event.causes = causes as number[];
    if (attrs !== undefined) event.attrs = attrs as JsonObject;
    if (resolution.value !== undefined) event.payload = resolution.value;
    if (redacted !== undefined) event.redacted = redacted as string[];
    return {
      kind: 'event' as const,
      event,
      seqGap: previousSeq >= 0 && seq > previousSeq + 1,
    };
  });
}

async function readFirstBytes(filePath: string, maximum: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function appendParsedLine(
  runDirectory: string,
  line: string,
  previousSeq: number,
  events: OrcaTraceEvent[],
  warnings: OrcaTraceWarning[],
): Promise<number> {
  const parsed = await parseTraceLine(runDirectory, line, previousSeq);
  if (parsed.kind === 'skip') {
    pushWarning(warnings, parsed.warning);
    return previousSeq;
  }
  if (parsed.kind === 'skipAfterSeq') {
    pushWarning(warnings, parsed.warning);
    return parsed.seq;
  }
  if (parsed.event.unknownType) {
    pushWarning(warnings, { code: 'unknown_event_type', seq: parsed.event.seq, detail: parsed.event.type });
  }
  if (parsed.seqGap) {
    pushWarning(warnings, { code: 'seq_gap', seq: parsed.event.seq, detail: `seq jumped from ${previousSeq}` });
  }
  events.push(parsed.event);
  return parsed.event.seq;
}

export async function readOrcaTraceRun(
  runsDirectory: string,
  traceRunId: string,
): Promise<OrcaTraceRunRead> {
  const warnings: OrcaTraceWarning[] = [];
  const manifestRead = await readOrcaTraceManifest(runsDirectory, traceRunId);
  if (!manifestRead.ok) {
    return {
      status: manifestRead.reason,
      integrity: 'unavailable',
      events: [],
      maxSeq: -1,
      warnings: [],
    };
  }
  const manifest = manifestRead.manifest;
  const runDirectory = path.join(runsDirectory, traceRunId);
  const eventsPath = path.join(runDirectory, 'events.jsonl');
  let size: number;
  try {
    size = (await stat(eventsPath)).size;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'missing_events', integrity: 'unavailable', manifest: manifestView(manifest), events: [], maxSeq: -1, warnings: [] };
    }
    throw error;
  }
  let raw: Buffer;
  let partial = false;
  if (size > ORCA_TRACE_MAX_EVENTS_BYTES) {
    partial = true;
    raw = await readFirstBytes(eventsPath, ORCA_TRACE_MAX_EVENTS_BYTES);
  } else {
    raw = await readFile(eventsPath);
  }
  const integrity: OrcaTraceIntegrity = partial || manifest.eventsSha256 === undefined
    ? 'unavailable'
    : createHash('sha256').update(raw).digest('hex') === manifest.eventsSha256
      ? 'verified'
      : 'mismatch';
  if (integrity === 'mismatch') {
    pushWarning(warnings, { code: 'invalid_event', detail: 'integrity digest mismatch reported, not repaired' });
  }
  if (partial) {
    pushWarning(warnings, {
      code: 'events_too_large',
      detail: `events.jsonl exceeds ${ORCA_TRACE_MAX_EVENTS_BYTES} bytes; only the bounded prefix was read`,
    });
  }
  const events: OrcaTraceEvent[] = [];
  const text = raw.toString('utf8');
  const lines = text.split('\n');
  const trailingNoNewline = !text.endsWith('\n');
  const bodyLines = trailingNoNewline ? lines.slice(0, -1) : lines.slice(0, -1);
  const tailLine = trailingNoNewline ? lines[lines.length - 1] : undefined;
  let previousSeq = -1;
  for (const line of bodyLines) {
    if (line.trim().length === 0) {
      pushWarning(warnings, { code: 'invalid_event', detail: 'blank event line skipped' });
      continue;
    }
    previousSeq = await appendParsedLine(runDirectory, line, previousSeq, events, warnings);
  }
  if (tailLine !== undefined && tailLine.trim().length > 0) {
    const parsed = await parseTraceLine(runDirectory, tailLine, previousSeq);
    if (parsed.kind === 'skip') {
      pushWarning(warnings, {
        code: 'truncated_final_line',
        detail: 'the final line was truncated during a write and was skipped',
      });
    } else if (parsed.kind === 'skipAfterSeq') {
      pushWarning(warnings, parsed.warning);
      previousSeq = parsed.seq;
    } else {
      if (parsed.event.unknownType) {
        pushWarning(warnings, { code: 'unknown_event_type', seq: parsed.event.seq, detail: parsed.event.type });
      }
      if (parsed.seqGap) {
        pushWarning(warnings, { code: 'seq_gap', seq: parsed.event.seq, detail: `seq jumped from ${previousSeq}` });
      }
      events.push(parsed.event);
      previousSeq = parsed.event.seq;
    }
  }
  return {
    status: 'ready',
    integrity,
    manifest: manifestView(manifest),
    events,
    maxSeq: previousSeq,
    warnings,
  };
}

function manifestView(manifest: ParsedOrcaTraceManifest): OrcaTraceManifestView {
  return {
    schemaVersion: manifest.schemaVersion,
    runId: manifest.runId,
    ...(manifest.countsEvents === undefined ? {} : { countsEvents: manifest.countsEvents }),
    ...(manifest.eventsSha256 === undefined ? {} : { eventsSha256: manifest.eventsSha256 }),
  };
}
